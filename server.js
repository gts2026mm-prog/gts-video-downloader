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

// Detect ffmpeg location
function detectFfmpeg() {
  // Check system PATH first (Docker/Linux/Mac)
  try {
    execSync('ffmpeg -version', { stdio: 'pipe' });
    console.log('Using system ffmpeg');
    return null; // already in PATH
  } catch {}
  // Windows: check ffmpeg_downloader
  try {
    const p = execSync('python -c "import ffmpeg_downloader as f; print(f.ffmpeg_path)"', { stdio: 'pipe' }).toString().trim();
    if (p) {
      const dir = path.dirname(p);
      console.log(`Found ffmpeg at: ${dir}`);
      return dir;
    }
  } catch {}
  console.warn('ffmpeg not found — high quality downloads may not work');
  return null;
}

const FFMPEG_DIR = detectFfmpeg();

// Build base yt-dlp args including ffmpeg location if known
function ytdlpBase() {
  const args = [];
  if (FFMPEG_DIR) args.push('--ffmpeg-location', FFMPEG_DIR);
  // Use Node.js as JS runtime for YouTube extraction (available in Docker)
  args.push('--js-runtimes', 'nodejs');
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
  const safeTitle = (title || 'video').replace(/[<>:"/\\|?*]/g, '').trim().slice(0, 100);
  const filename = `${safeTitle}.${ext}`;

  // Use a temp file so ffmpeg can merge properly (streaming to stdout breaks merging)
  const tmpDir = os.tmpdir();
  const tmpBase = path.join(tmpDir, `vdl_${Date.now()}`);
  const tmpOut = `${tmpBase}.${ext}`;

  let args;
  if (isAudio) {
    args = [
      '-m', 'yt_dlp',
      ...ytdlpBase(),
      '--no-playlist',
      '-f', 'bestaudio',
      '-x', '--audio-format', 'mp3',
      '-o', tmpOut,
      url,
    ];
  } else {
    const fmtSelector = format_id && format_id !== 'best'
      ? `${format_id}+bestaudio/bestvideo+bestaudio/best`
      : 'bestvideo+bestaudio/best';
    args = [
      '-m', 'yt_dlp',
      ...ytdlpBase(),
      '--no-playlist',
      '-f', fmtSelector,
      '--merge-output-format', 'mp4',
      '-o', tmpOut,
      url,
    ];
  }

  console.log(`[download] Starting: ${filename}`);

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

    // Stream the finished file to the browser
    const stat = fs.statSync(tmpOut);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
    res.setHeader('Content-Length', stat.size);

    const stream = fs.createReadStream(tmpOut);
    stream.pipe(res);
    stream.on('close', () => {
      fs.unlink(tmpOut, () => {});
      console.log(`[download] Done: ${filename}`);
    });

  } catch (err) {
    console.error('[download error]', err.message);
    fs.unlink(tmpOut, () => {});
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

app.listen(PORT, () => {
  console.log(`\nVideo Downloader ready! Open: http://localhost:${PORT}\n`);
});
