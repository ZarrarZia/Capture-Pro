// macOS: downloads static FFmpeg builds (arm64 and x64) into vendor/ffmpeg-mac-<arch> for bundling.
// Static macOS builds with AVFoundation and VideoToolbox; several sources so one site being down
// doesn't break the build.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const BUILDS = {
  arm64: ['https://www.osxexperts.net/ffmpeg9arm.zip', 'https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip'],
  x64: ['https://www.osxexperts.net/ffmpeg80intel.zip', 'https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release/ffmpeg.zip'],
};

for (const [arch, urls] of Object.entries(BUILDS)) {
  const dir = path.join(root, 'vendor', `ffmpeg-mac-${arch}`);
  const exe = path.join(dir, 'ffmpeg');
  if (fs.existsSync(exe)) { console.log('present', exe); continue; }
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, 'ffmpeg.zip');
  const url = urls.find((u) => {
    try { execFileSync('curl', ['-fsSL', '--retry', '3', '--retry-delay', '5', '-o', zip, u], { stdio: 'inherit' }); return true; }
    catch { console.warn(`download failed: ${u}`); return false; }
  });
  if (!url) throw new Error(`could not download FFmpeg for macOS ${arch}`);
  execFileSync('unzip', ['-o', '-q', zip, 'ffmpeg', '-d', dir], { stdio: 'inherit' }); // skip __MACOSX metadata
  fs.rmSync(zip);
  fs.chmodSync(exe, 0o755);
  fs.writeFileSync(path.join(dir, 'README.txt'), `FFmpeg bundled with CapturePro (macOS ${arch}).\nSource: ${url}\nFFmpeg is licensed under the GPL; see https://ffmpeg.org/legal.html\n`);
  // Sanity check the binary for this machine's architecture.
  if ((process.arch === 'arm64') === (arch === 'arm64')) {
    const devices = execFileSync(exe, ['-hide_banner', '-devices'], { encoding: 'utf8' });
    if (!/avfoundation/.test(devices)) throw new Error(`${exe} lacks AVFoundation capture`);
    const filters = execFileSync(exe, ['-hide_banner', '-filters'], { encoding: 'utf8' });
    console.log(`ffmpeg ${arch}: avfoundation ok, zmq ${/\szmq\s/.test(filters) ? 'ok' : 'missing (around-mouse uses a fixed area)'}`);
  }
  console.log('bundled', exe);
}
