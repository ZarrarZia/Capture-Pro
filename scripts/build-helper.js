// Builds the native helper for the current OS:
//   Windows: native/CaptureProHelper.cs with the .NET Framework C# compiler that ships with Windows.
//   macOS:   native/mac/CaptureProHelper.swift with swiftc, as a universal (arm64 + x86_64) binary.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'native', 'bin');
fs.mkdirSync(outDir, { recursive: true });
const fresh = (out, src) => fs.existsSync(out) && fs.statSync(out).mtimeMs > fs.statSync(src).mtimeMs;

if (process.platform === 'darwin') {
  const src = path.join(root, 'native', 'mac', 'CaptureProHelper.swift');
  const out = path.join(outDir, 'CaptureProHelper');
  if (fresh(out, src)) process.exit(0);
  const parts = ['arm64', 'x86_64'].map((arch) => {
    const o = `${out}-${arch}`;
    execFileSync('swiftc', ['-O', '-target', `${arch}-apple-macos11`, src, '-o', o, '-framework', 'AppKit'], { stdio: 'inherit' });
    return o;
  });
  execFileSync('lipo', ['-create', ...parts, '-output', out], { stdio: 'inherit' });
  for (const p of parts) fs.rmSync(p);
  console.log('built', path.relative(root, out));
} else {
  const src = path.join(root, 'native', 'CaptureProHelper.cs');
  const out = path.join(outDir, 'CaptureProHelper.exe');
  const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (fresh(out, src)) process.exit(0);
  execFileSync(csc, ['/nologo', '/optimize+', '/target:exe', '/platform:x64', `/out:${out}`, src], { stdio: 'inherit' });
  console.log('built', path.relative(root, out));
}
