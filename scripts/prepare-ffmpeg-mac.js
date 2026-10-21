// macOS: downloads static FFmpeg builds (arm64 and x64) into vendor/ffmpeg-mac-<arch> for bundling.
// Source: https://ffmpeg.martin-riedl.de (static macOS builds with AVFoundation and VideoToolbox).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const BUILDS = {
  arm64: 'https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip',
  x64: 'https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release/ffmpeg.zip',
};

for (const [arch, url] of Object.entries(BUILDS)) {
  const dir = path.join(root, 'vendor', `ffmpeg-mac-${arch}`);
  const exe = path.join(dir, 'ffmpeg');
  if (fs.existsSync(exe)) { console.log('present', exe); continue; }
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, 'ffmpeg.zip');
  execFileSync('curl', ['-fsSL', '-o', zip, url], { stdio: 'inherit' });
  execFileSync('unzip', ['-o', '-q', zip, '-d', dir], { stdio: 'inherit' });
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
