const express = require('express');
const cors = require('cors');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Detect python path at startup
function detectPython() {
  for (const cmd of ['python', 'python3', 'py']) {
    try {
      const out = execSync(`${cmd} -m yt_dlp --version`, { timeout: 8000, stdio: 'pipe' });
      console.log(`Found yt-dlp via: ${cmd} (${out.toString().trim()})`);
      return cmd;
    } catch {}
  }
  throw new Error('yt-dlp not found. Run: pip install yt-dlp');
}

const PYTHON = detectPython();
const SPAWN_OPTS = { windowsHide: true };

// Detect ffmpeg location — returns directory path or null if in system PATH
function detectFfmpeg() {
  // Check system PATH first (Docker/Linux/Mac)
  try {
    execSync('ffmpeg -version', { stdio: 'pipe' });
    console.log('Using system ffmpeg');
    return null; // already in PATH
  } catch {}
  // Windows: get path from ffmpeg_downloader (spawn handles apostrophes fine without shell:true)
  try {
    const p = execSync('python -c "import ffmpeg_downloader as f; print(f.ffmpeg_path)"', { stdio: 'pipe' }).toString().trim();
    if (p) {
      const dir = path.dirname(p);
      console.log(`Found ffmpeg at: ${dir}`);
      return dir;
    }
  } catch {}
  console.warn('ffmpeg not found — audio conversion may not work');
  return null;
}

const FFMPEG_DIR = detectFfmpeg();

// Build base yt-dlp args including ffmpeg location if known
function ytdlpBase() {
  const args = [];
  if (FFMPEG_DIR) args.push('--ffmpeg-location', FFMPEG_DIR);
  // Use Node.js as JS runtime for YouTube extraction (available in Docker)
  args.push('--js-runtimes', 'node');
  return args;
}

// Run yt-dlp and return stdout as string
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, ['-m', 'yt_dlp', ...ytdlpBase(), ...args], SPAWN_OPTS);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => (stdout += d.toString()));
    proc.stderr.on('data', d => (stderr += d.toString()));
    proc.on('error', err => reject(new Error(`Spawn error: ${err.message}`)));
    proc.on('close', code => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        // Extract first meaningful line from stderr
        const msg = stderr.split('\n').find(l => l.includes('ERROR') || l.trim()) || stderr;
        reject(new Error(msg.replace(/^\s*ERROR:\s*/i, '').trim()));
      }
    });
  });
}

// GET /api/info?url=...
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    const json = await runYtDlp([
      '--dump-json',
      '--no-playlist',
      '--no-warnings',
      url,
    ]);

    const info = JSON.parse(json);
    const allFormats = info.formats || [];

    // Collect unique heights from all video formats
    const seenHeights = new Set();
    const formats = [];

    // Prefer combined (video+audio) mp4 first, then video-only
    const combined = allFormats.filter(f => f.vcodec !== 'none' && f.acodec !== 'none');
    const videoOnly = allFormats.filter(f => f.vcodec !== 'none' && f.acodec === 'none');

    for (const f of [...combined, ...videoOnly]) {
      const height = f.height || 0;
      if (!height || seenHeights.has(height)) continue;
      seenHeights.add(height);
      formats.push({
        format_id: f.format_id,
        label: `${height}p`,
        ext: 'mp4',
        filesize: f.filesize || f.filesize_approx || null,
        height,
      });
    }

    // Sort best quality first
    formats.sort((a, b) => b.height - a.height);

    // Add best overall fallback if no formats found
    if (formats.length === 0) {
      formats.push({ format_id: 'best', label: 'Best quality', ext: 'mp4', filesize: null, height: 9999 });
    }

    // Audio only
    formats.push({ format_id: 'bestaudio', label: 'Audio only (MP3)', ext: 'mp3', filesize: null, height: -1 });

    res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      uploader: info.uploader,
      platform: info.extractor_key,
      formats,
    });
  } catch (err) {
    console.error('[/api/info error]', err.message);
    res.status(400).json({ error: err.message });
  }
});

// GET /api/download?url=...&format_id=...&title=...
app.get('/api/download', async (req, res) => {
  const { url, format_id, title } = req.query;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const isAudio = format_id === 'bestaudio';
  const ext = isAudio ? 'mp3' : 'mp4';
  // Remove non-ASCII and invalid header characters, fallback to 'video'
  const safeTitle = (title || 'video')
    .replace(/[^\x20-\x7E]/g, '')   // strip non-ASCII (Myanmar, Arabic, CJK, etc.)
    .replace(/[<>:"/\\|?*]/g, '')   // strip invalid filename chars
    .trim()
    .slice(0, 100) || 'video';
  const filename = `${safeTitle}.${ext}`;

  const tmpDir = os.tmpdir();
  const tmpBase = path.join(tmpDir, `vdl_${Date.now()}`);

  // For audio: must use temp file (ffmpeg conversion)
  // For video: try to stream directly (single pre-merged format, no disk needed)
  //            fall back to temp file only if merging is required
  const needsMerge = !isAudio; // we'll try direct stream for video first

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');

  console.log(`[download] Starting: ${filename}`);

  if (isAudio) {
    // Audio: download + convert to mp3 via temp file
    const args = [
      '-m', 'yt_dlp',
      ...ytdlpBase(),
      '--no-playlist',
      '-f', 'bestaudio/best',
      '-x', '--audio-format', 'mp3',
      '--audio-quality', '0',
      '-o', `${tmpBase}.%(ext)s`,   // yt-dlp fills this in (e.g. .webm), then converts to .mp3
      url,
    ];

    try {
      await new Promise((resolve, reject) => {
        const proc = spawn(PYTHON, args, SPAWN_OPTS);
        let stderr = '';
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('error', err => reject(new Error(`Spawn error: ${err.message}`)));
        proc.on('close', code => {
          if (code === 0) resolve();
          else {
            const msg = stderr.split('\n').find(l => l.includes('ERROR') || l.trim()) || stderr;
            reject(new Error(msg.replace(/^\s*ERROR:\s*/i, '').trim()));
          }
        });
        req.on('close', () => { try { proc.kill(); } catch {} });
      });

      // Look specifically for the .mp3 file (not the intermediate .webm)
      const tmpOut = `${tmpBase}.mp3`;
      if (!fs.existsSync(tmpOut)) throw new Error('MP3 file not found after conversion');
      const stat = fs.statSync(tmpOut);
      res.setHeader('Content-Length', stat.size);
      const stream = fs.createReadStream(tmpOut);
      stream.pipe(res);
      stream.on('close', () => { fs.unlink(tmpOut, () => {}); console.log(`[download] Done: ${filename}`); });
    } catch (err) {
      console.error('[download error]', err.message);
      try { ['mp3','webm','m4a','opus'].forEach(e => fs.unlink(`${tmpBase}.${e}`, () => {})); } catch {}
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else res.end();
    }
    return;
  }

  // Video: stream directly — NO ffmpeg merging (saves memory, supports large files)
  // Only download pre-merged single-file formats to avoid OOM on free hosting
  const fmtSelector = [
    'best[ext=mp4][height<=720]',  // best pre-merged mp4 up to 720p
    'best[ext=mp4]',               // any pre-merged mp4
    'best',                        // any pre-merged format
  ].join('/');

  const args = [
    '-m', 'yt_dlp',
    ...ytdlpBase(),
    '--no-playlist',
    '-f', fmtSelector,
    '-o', '-',   // stream to stdout directly, no ffmpeg
    url,
  ];

  const proc = spawn(PYTHON, args, SPAWN_OPTS);
  proc.stdout.pipe(res);
  proc.stderr.on('data', chunk => {
    const line = chunk.toString();
    if (line.includes('ERROR')) console.error('[video error]', line.trim());
  });
  proc.on('error', err => {
    console.error('[spawn error]', err.message);
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
  proc.on('close', code => {
    console.log(`[download] Done (code ${code}): ${filename}`);
    res.end();
  });
  req.on('close', () => { try { proc.kill(); } catch {} });

});

app.listen(PORT, () => {
  console.log(`\nVideo Downloader ready! Open: http://localhost:${PORT}\n`);
});
