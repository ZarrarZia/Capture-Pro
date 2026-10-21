// Output file library: lists recordings/screenshots/audio under the output folder, with cached thumbnails.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ffmpeg = require('./ffmpeg');

const EXT = {
  video: ['.mp4', '.avi', '.mkv', '.mov', '.webm'],
  image: ['.png', '.jpg', '.jpeg', '.bmp', '.gif'],
  audio: ['.mp3', '.wav', '.m4a', '.aac'],
};

function kindOf(file) {
  const e = path.extname(file).toLowerCase();
  return Object.keys(EXT).find((k) => EXT[k].includes(e)) || null;
}

function list(root, kind, sort = 'date') {
  const out = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 2 && !e.name.startsWith('.')) walk(p, depth + 1); continue; }
      if (kindOf(e.name) !== kind || /\.\d\.wav$/i.test(e.name)) continue;
      try {
        const st = fs.statSync(p);
        out.push({ path: p, name: e.name, size: st.size, mtime: st.mtimeMs });
      } catch { /* vanished */ }
    }
  };
  walk(root, 0);
  const cmp = { date: (a, b) => b.mtime - a.mtime, name: (a, b) => a.name.localeCompare(b.name), size: (a, b) => b.size - a.size }[sort];
  return out.sort(cmp);
}

// Returns a path to a small JPEG thumbnail for a video (images are their own thumbnail).
async function thumbnailFor(file, cacheDir) {
  const kind = kindOf(file);
  if (kind === 'image') return file;
  if (kind !== 'video') return null;
  const st = fs.statSync(file);
  const key = crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
  const out = path.join(cacheDir, `${key}.jpg`);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(cacheDir, { recursive: true });
  try { await ffmpeg.thumbnail(file, out, 1); return out; } catch { return null; }
}

function rename(file, newName) {
  const clean = newName.replace(/[<>:"/\\|?*]/g, '_').trim();
  if (!clean) throw new Error('Invalid name');
  const target = path.join(path.dirname(file), path.extname(clean) ? clean : clean + path.extname(file));
  if (fs.existsSync(target)) throw new Error('A file with that name already exists.');
  fs.renameSync(file, target);
  return target;
}

module.exports = { list, thumbnailFor, rename, kindOf, EXT };
