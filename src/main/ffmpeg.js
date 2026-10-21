// Locates ffmpeg/ffprobe, probes which encoders actually work on this PC, and wraps common one-shot jobs.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { VIDEO_CODECS } = require('./codecs');
const platform = require('./platform');

let ffmpegPath = null;
let ffprobePath = null;

function locate(resourcesDir) {
  const candidates = [];
  if (resourcesDir) candidates.push(path.join(resourcesDir, 'ffmpeg', platform.ffmpegExe));
  try {
    const finder = platform.isWin ? 'where' : 'which';
    candidates.push(...execFileSync(finder, ['ffmpeg'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).filter(Boolean));
  } catch { /* not on PATH */ }
  candidates.push(...platform.ffmpegCandidates());
  ffmpegPath = candidates.find((p) => fs.existsSync(p)) || null;
  if (ffmpegPath) {
    const probe = path.join(path.dirname(ffmpegPath), platform.ffprobeExe);
    ffprobePath = fs.existsSync(probe) ? probe : null;
  }
  return ffmpegPath;
}

// Optional filters this ffmpeg build provides (e.g. zmq for around-mouse following).
function detectFilters(names) {
  try {
    const out = execFileSync(ffmpegPath, ['-hide_banner', '-filters'], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 << 20 });
    return new Set(names.filter((n) => new RegExp(`\\s${n}\\s`).test(out)));
  } catch { return new Set(); }
}

const getPath = () => ffmpegPath;

function run(args, { timeoutMs = 0, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('FFmpeg was not found. Install FFmpeg or place it in resources/ffmpeg.'));
    const p = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-y', ...args], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; if (err.length > 64000) err = err.slice(-32000); onStderr?.(String(d)); });
    const timer = timeoutMs ? setTimeout(() => p.kill(), timeoutMs) : null;
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(err) : reject(new Error(lastError(err) || `ffmpeg exited with code ${code}`));
    });
  });
}

function lastError(stderr) {
  const lines = String(stderr).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.reverse().find((l) => /error|failed|invalid|cannot|not found|unable/i.test(l)) || lines[0] || '';
}

// Tries a tiny encode with every candidate encoder; results are cached per ffmpeg build + GPU set.
async function detectEncoders(cacheFile) {
  const stat = fs.statSync(ffmpegPath);
  const key = `${ffmpegPath}|${stat.size}|${stat.mtimeMs}`;
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cached.key === key) return new Set(cached.available);
  } catch { /* no cache */ }

  const names = new Set();
  for (const fam of Object.values(VIDEO_CODECS)) for (const n of Object.values(fam.encoders)) names.add(n);
  const results = await Promise.all([...names].map(async (name) => {
    const pix = /_(qsv|nvenc|amf|videotoolbox)$/.test(name) ? 'nv12' : name === 'mjpeg' ? 'yuvj420p' : 'yuv420p';
    try {
      await run(['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30', '-frames:v', '3',
        '-pix_fmt', pix, '-c:v', name, '-f', 'null', '-'], { timeoutMs: 20000 });
      return name;
    } catch { return null; }
  }));
  const available = results.filter(Boolean);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ key, available }));
  return new Set(available);
}

function probe(file) {
  return new Promise((resolve) => {
    if (!ffprobePath) return resolve(null);
    const p = spawn(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels', '-of', 'json', file], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => { try { resolve(JSON.parse(out)); } catch { resolve(null); } });
    p.on('error', () => resolve(null));
  });
}

async function thumbnail(file, out, atSec = 1) {
  await run(['-loglevel', 'error', '-ss', String(atSec), '-i', file, '-frames:v', '1', '-vf', 'scale=320:-2', out], { timeoutMs: 15000 })
    .catch(() => run(['-loglevel', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=320:-2', out], { timeoutMs: 15000 }));
  return out;
}

module.exports = { locate, getPath, run, detectEncoders, detectFilters, probe, thumbnail, lastError };
