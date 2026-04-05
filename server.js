const express = require('express');
const cors = require('cors');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Config ────────────────────────────────────────────────────────────────
const MAX_CONCURRENT = 3;       // max simultaneous downloads
const DOWNLOAD_TIMEOUT = 5 * 60 * 1000; // 5 min timeout per download
const INFO_CACHE_TTL = 5 * 60 * 1000;   // cache video info for 5 min
const RATE_LIMIT_WINDOW = 60 * 1000;    // 1 min window
const RATE_LIMIT_MAX = 20;              // max 20 requests per IP per minute

// ─── Middleware ─────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Rate limiter (in-memory) ───────────────────────────────────────────────
const rateLimitMap = new Map();
function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > RATE_LIMIT_WINDOW) {
    entry.count = 1; entry.start = now;
  } else {
    entry.count++;
  }
  rateLimitMap.set(ip, entry);
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  }
  next();
}

// ─── Video info cache ───────────────────────────────────────────────────────
const infoCache = new Map();
function getCached(url) {
  const entry = infoCache.get(url);
  if (entry && Date.now() - entry.time < INFO_CACHE_TTL) return entry.data;
  return null;
}
function setCache(url, data) {
  infoCache.set(url, { data, time: Date.now() });
  // Keep cache size reasonable
  if (infoCache.size > 100) {
    const oldest = [...infoCache.entries()].sort((a, b) => a[1].time - b[1].time)[0];
    infoCache.delete(oldest[0]);
  }
}

// ─── Concurrent download limiter & stats ────────────────────────────────────
let activeDownloads = 0;
let totalDownloads = 0;
const recentLogs = [];

function addLog(msg, type = 'info') {
  const time = new Date().toLocaleTimeString();
  recentLogs.push({ time, msg, type });
  if (recentLogs.length > 50) recentLogs.shift();
}

function formatUptime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ─── URL validation ─────────────────────────────────────────────────────────
function isValidUrl(url) {
  try {
    const u = new URL(url);
    return ['http:', 'https:'].includes(u.protocol);
  } catch {
    return false;
  }
}

// ─── Detect tools ───────────────────────────────────────────────────────────
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

function detectFfmpeg() {
  try {
    execSync('ffmpeg -version', { stdio: 'pipe' });
    console.log('Using system ffmpeg');
    return null;
  } catch {}
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

const PYTHON = detectPython();
const FFMPEG_DIR = detectFfmpeg();
const SPAWN_OPTS = { windowsHide: true };

function ytdlpBase() {
  const args = [];
  if (FFMPEG_DIR) args.push('--ffmpeg-location', FFMPEG_DIR);
  args.push('--js-runtimes', 'node');
  args.push('--socket-timeout', '30');
  args.push('--retries', '3');
  return args;
}

// ─── Run yt-dlp (info fetch) ────────────────────────────────────────────────
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, ['-m', 'yt_dlp', ...ytdlpBase(), ...args], SPAWN_OPTS);
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => (stdout += d.toString()));
    proc.stderr.on('data', d => (stderr += d.toString()));
    proc.on('error', err => reject(new Error(`Spawn error: ${err.message}`)));
    proc.on('close', code => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        const msg = stderr.split('\n').find(l => l.includes('ERROR') || l.trim()) || stderr;
        reject(new Error(msg.replace(/^\s*ERROR:\s*/i, '').trim()));
      }
    });
  });
}

// ─── Health check ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    activeDownloads,
    maxConcurrent: MAX_CONCURRENT,
    totalDownloads,
    cacheSize: infoCache.size,
    uptime: formatUptime(process.uptime()),
    memory: Math.round(mem.rss / 1024 / 1024) + ' MB',
    recentLogs,
  });
});

// ─── GET /api/info ──────────────────────────────────────────────────────────
app.get('/api/info', rateLimit, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  if (!isValidUrl(url)) return res.status(400).json({ error: 'Invalid URL' });

  // Return cached result if available
  const cached = getCached(url);
  if (cached) return res.json(cached);

  try {
    const json = await runYtDlp([
      '--dump-json', '--no-playlist', '--no-warnings', url,
    ]);

    const info = JSON.parse(json);
    const allFormats = info.formats || [];

    const seenHeights = new Set();
    const formats = [];

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

    formats.sort((a, b) => b.height - a.height);

    if (formats.length === 0) {
      formats.push({ format_id: 'best', label: 'Best quality', ext: 'mp4', filesize: null, height: 9999 });
    }

    formats.push({ format_id: 'bestaudio', label: 'Audio only (MP3)', ext: 'mp3', filesize: null, height: -1 });

    const result = {
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      uploader: info.uploader,
      platform: info.extractor_key,
      formats,
    };

    setCache(url, result);
    res.json(result);
  } catch (err) {
    console.error('[/api/info error]', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─── GET /api/download ──────────────────────────────────────────────────────
app.get('/api/download', rateLimit, async (req, res) => {
  const { url, format_id, title } = req.query;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  if (!isValidUrl(url)) return res.status(400).json({ error: 'Invalid URL' });

  if (activeDownloads >= MAX_CONCURRENT) {
    return res.status(503).json({ error: 'Server busy. Please try again in a moment.' });
  }

  const isAudio = format_id === 'bestaudio';
  const ext = isAudio ? 'mp3' : 'mp4';
  const safeTitle = (title || 'video')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[<>:"/\\|?*]/g, '')
    .trim().slice(0, 100) || 'video';
  const filename = `${safeTitle}.${ext}`;

  const tmpDir = os.tmpdir();
  const tmpBase = path.join(tmpDir, `vdl_${Date.now()}_${Math.random().toString(36).slice(2)}`);

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  activeDownloads++;
  totalDownloads++;
  addLog(`Started: ${filename}`, 'info');
  console.log(`[download] Start (${activeDownloads}/${MAX_CONCURRENT}): ${filename}`);

  // Timeout: kill download if it takes too long
  const timeout = setTimeout(() => {
    console.error(`[download] Timeout: ${filename}`);
    cleanup();
    if (!res.headersSent) res.status(504).json({ error: 'Download timed out' });
    else res.end();
  }, DOWNLOAD_TIMEOUT);

  let proc = null;
  function cleanup() {
    clearTimeout(timeout);
    activeDownloads = Math.max(0, activeDownloads - 1);
    try { if (proc) proc.kill(); } catch {}
    ['mp3', 'webm', 'm4a', 'opus', 'mp4'].forEach(e =>
      fs.unlink(`${tmpBase}.${e}`, () => {})
    );
  }

  req.on('close', cleanup);

  if (isAudio) {
    const args = [
      '-m', 'yt_dlp', ...ytdlpBase(),
      '--no-playlist',
      '-f', 'bestaudio/best',
      '-x', '--audio-format', 'mp3', '--audio-quality', '0',
      '-o', `${tmpBase}.%(ext)s`,
      url,
    ];
    try {
      await new Promise((resolve, reject) => {
        proc = spawn(PYTHON, args, SPAWN_OPTS);
        let stderr = '';
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('error', err => reject(new Error(err.message)));
        proc.on('close', code => {
          if (code === 0) resolve();
          else {
            const msg = stderr.split('\n').find(l => l.includes('ERROR') || l.trim()) || stderr;
            reject(new Error(msg.replace(/^\s*ERROR:\s*/i, '').trim()));
          }
        });
      });

      const tmpOut = `${tmpBase}.mp3`;
      if (!fs.existsSync(tmpOut)) throw new Error('MP3 conversion failed');
      const stat = fs.statSync(tmpOut);
      res.setHeader('Content-Length', stat.size);
      const stream = fs.createReadStream(tmpOut);
      stream.pipe(res);
      stream.on('close', () => {
        fs.unlink(tmpOut, () => {});
        cleanup();
        addLog(`Done: ${filename}`, 'success');
        console.log(`[download] Done: ${filename}`);
      });
    } catch (err) {
      cleanup();
      addLog(`Error: ${err.message}`, 'error');
      console.error('[audio error]', err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else res.end();
    }
    return;
  }

  // Video: stream directly, no ffmpeg merge
  const fmtSelector = [
    'best[ext=mp4][height<=720]',
    'best[ext=mp4]',
    'best',
  ].join('/');

  const args = [
    '-m', 'yt_dlp', ...ytdlpBase(),
    '--no-playlist',
    '-f', fmtSelector,
    '-o', '-',
    url,
  ];

  proc = spawn(PYTHON, args, SPAWN_OPTS);
  proc.stdout.pipe(res);
  proc.stderr.on('data', chunk => {
    const line = chunk.toString();
    if (line.includes('ERROR')) console.error('[video error]', line.trim());
  });
  proc.on('error', err => {
    cleanup();
    console.error('[spawn error]', err.message);
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
  proc.on('close', code => {
    cleanup();
    addLog(code === 0 ? `Done: ${filename}` : `Failed (code ${code}): ${filename}`, code === 0 ? 'success' : 'error');
    console.log(`[download] Done (code ${code}): ${filename}`);
    res.end();
  });
});

// ─── 404 handler ────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ─── Global error handler ────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[unhandled error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  process.exit(0);
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nGTS Downloader ready! http://localhost:${PORT}\n`);
});
