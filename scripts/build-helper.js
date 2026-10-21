// Compiles native/CaptureProHelper.cs with the .NET Framework C# compiler that ships with Windows.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'native', 'CaptureProHelper.cs');
const outDir = path.join(root, 'native', 'bin');
const out = path.join(outDir, 'CaptureProHelper.exe');
const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

if (fs.existsSync(out) && fs.statSync(out).mtimeMs > fs.statSync(src).mtimeMs) process.exit(0);
fs.mkdirSync(outDir, { recursive: true });
execFileSync(csc, ['/nologo', '/optimize+', '/target:exe', '/platform:x64', `/out:${out}`, src], { stdio: 'inherit' });
console.log('built', path.relative(root, out));
