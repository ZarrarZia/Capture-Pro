// Output file naming: "<prefix> <suffix>.<ext>" inside an optional subfolder (pure; unit-tested).
const fs = require('fs');
const path = require('path');

const pad = (n, w = 2) => String(n).padStart(w, '0');

function timestamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
}

const sanitize = (s) => String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60);

// kind: 'video' | 'image' | 'audio'; targetName: e.g. "Screen", "chrome", "Audio"
function outputPath(general, { kind, targetName, ext, now = new Date(), exists = fs.existsSync }) {
  let dir = general.outputDir;
  if (general.subfolder === 'target') dir = path.join(dir, sanitize(targetName) || 'Screen');
  else if (general.subfolder === 'type') dir = path.join(dir, { video: 'Videos', image: 'Images', audio: 'Audios' }[kind]);
  else if (general.subfolder === 'date') dir = path.join(dir, `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);

  const prefix = general.namePrefix === 'target' ? sanitize(targetName)
    : general.namePrefix === 'custom' ? sanitize(general.customPrefix) : '';

  if (general.nameSuffix === 'sequence') {
    for (let n = 1; ; n++) {
      const p = path.join(dir, `${prefix ? prefix + ' ' : ''}${pad(n, 4)}.${ext}`);
      if (!exists(p)) return p;
    }
  }
  return path.join(dir, `${prefix ? prefix + ' ' : ''}${timestamp(now)}.${ext}`);
}

module.exports = { outputPath, timestamp, sanitize };
