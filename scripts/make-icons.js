// Generates CapturePro's own icons (no external artwork): assets/icon.png, tray.png, tray-rec.png.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      // 4x4 supersampling for smooth edges
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const p = pixel((x + (sx + 0.5) / 4) / size, (y + (sy + 0.5) / 4) / size);
        r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3];
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? r / a : 0; raw[o + 1] = a ? g / a : 0; raw[o + 2] = a ? b / a : 0; raw[o + 3] = (a / 16) * 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Rounded-square tile, white ring, coloured record dot.
const icon = (dot, tile) => (u, v) => {
  const dx = u - 0.5, dy = v - 0.5, d = Math.hypot(dx, dy);
  if (d < 0.17) return [...dot, 1];
  if (d > 0.27 && d < 0.34) return [255, 255, 255, 1];
  const q = Math.max(Math.abs(dx) - 0.34, 0) ** 2 + Math.max(Math.abs(dy) - 0.34, 0) ** 2;
  if (tile && q < 0.14 ** 2) return [...tile, 1];
  return [0, 0, 0, 0];
};

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.png'), png(256, icon([255, 59, 72], [24, 28, 38])));
fs.writeFileSync(path.join(out, 'tray.png'), png(32, icon([255, 255, 255], [24, 28, 38])));
fs.writeFileSync(path.join(out, 'tray-rec.png'), png(32, icon([255, 59, 72], [24, 28, 38])));
console.log('icons written to', out);
