// electron-builder afterPack hook. macOS: ad-hoc sign the bundled helper, ffmpeg and the app so it
// runs on Apple-silicon Macs without a paid Developer ID (users approve it once in Privacy & Security).
// With a real Developer ID certificate configured, electron-builder's own signing replaces this.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const res = path.join(app, 'Contents', 'Resources');
  for (const bin of [path.join(res, 'native', 'CaptureProHelper'), path.join(res, 'ffmpeg', 'ffmpeg')]) {
    execFileSync('codesign', ['--force', '--sign', '-', bin], { stdio: 'inherit' });
  }
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
