// Copies ffmpeg.exe (and its license) from the local FFmpeg install into vendor/ffmpeg for bundling.
// Capture needs FFmpeg 8+ with the gfxcapture, ddagrab and zmq filters (e.g. "winget install Gyan.FFmpeg").
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', 'vendor', 'ffmpeg');
const exe = execFileSync('where', ['ffmpeg'], { encoding: 'utf8' }).split(/\r?\n/).find(Boolean);
if (!exe) throw new Error('ffmpeg not found on PATH');
const filters = execFileSync(exe, ['-hide_banner', '-filters'], { encoding: 'utf8' });
for (const f of ['gfxcapture', 'ddagrab', 'zmq']) if (!new RegExp(`\\s${f}\\s`).test(filters)) throw new Error(`${exe} lacks the ${f} filter`);

fs.mkdirSync(out, { recursive: true });
const dst = path.join(out, 'ffmpeg.exe');
if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(exe).size) fs.copyFileSync(exe, dst);
const license = path.join(path.dirname(exe), '..', 'LICENSE');
if (fs.existsSync(license)) fs.copyFileSync(license, path.join(out, 'LICENSE.txt'));
fs.writeFileSync(path.join(out, 'README.txt'), `FFmpeg bundled with CapturePro.\nSource: ${exe}\n${execFileSync(exe, ['-version'], { encoding: 'utf8' }).split('\n')[0]}\nFFmpeg is licensed under the GPL; see LICENSE.txt and https://ffmpeg.org/legal.html\n`);
console.log('bundled', dst);
