// End-to-end test for phase-2 overlays: countdown, click effect + highlight, keystrokes, drawing mode,
// webcam overlay (fake camera) and the separate webcam MP4.
// Usage: node test/e2e/overlays.js [screenshotDir]
const { _electron: electron } = require('playwright-core');
const assert = require('assert');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpeg = require('../../src/main/ffmpeg');

const ROOT = path.join(__dirname, '..', '..');
const shotDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'capturepro-shots-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Real OS input through SendInput-compatible APIs, so the global hooks see it.
function osInput(script) {
  const ps = `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int e); [DllImport("user32.dll")] public static extern void keybd_event(byte k,byte s,int f,int e);'; ${script}`;
  return new Promise((resolve, reject) => execFile('powershell', ['-NoProfile', '-Command', ps], (e) => (e ? reject(e) : resolve())));
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'capturepro-profile-'));
  const outDir = path.join(profile, 'out');
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
    mode: 'full', general: { outputDir: outDir, trayNotifications: false },
    video: { countdown: 2, soundEffects: false, fps: 30, fpsMode: 'cfr' },
    audio: { mic: { enabled: true } },
    overlays: {
      mouse: { clickEffect: true, clickSize: 90, highlight: true, highlightSize: 80 },
      keystroke: { enabled: true, size: 'large', position: 'bottom-center' },
      webcam: { enabled: true, shape: 'heart', size: 22, border: { style: 'solid', width: 5, color: '#ffffff' }, saveSeparate: true },
    },
  }));
  const env = { ...process.env, CAPTUREPRO_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ROOT], env, cwd: ROOT });
  const byUrl = async (part, timeout = 10000) => {
    for (let t = 0; t < timeout; t += 200) {
      const w = app.windows().find((x) => x.url().includes(part));
      if (w) return w;
      await sleep(200);
    }
    throw new Error(`window ${part} not found`);
  };

  try {
    const main = await byUrl('main/index.html');
    const errors = [];
    main.on('pageerror', (e) => errors.push(e.message));
    await main.waitForSelector('.card');

    const cam = await byUrl('webcam.html');
    cam.on('console', (m) => console.log('[webcam]', m.type(), m.text()));
    cam.on('pageerror', (e) => errors.push(`webcam: ${e.message}`));
    await sleep(2500);
    await cam.screenshot({ path: path.join(shotDir, 'webcam-overlay.png') });

    console.log("step: countdown");
    // Countdown overlay shows before capture begins.
    await main.click('#btn-rec');
    const overlay = await byUrl('overlay.html');
    await sleep(500);
    await overlay.screenshot({ path: path.join(shotDir, 'countdown.png') });
    const countdown = await overlay.textContent('#countdown');
    assert(['1', '2'].includes(countdown.trim()), `countdown shows ${countdown}`);
    await main.waitForSelector('body.recording', { timeout: 15000 });
    const recStart = Date.now();

    console.log("step: click+key");
    // Click on CapturePro own title bar (harmless) and press F13.
    const { bounds, scale } = await app.evaluate(({ BrowserWindow, screen }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'CapturePro');
      return { bounds: w.getBounds(), scale: screen.getPrimaryDisplay().scaleFactor };
    });
    const cx = Math.round((bounds.x + bounds.width / 2) * scale), cy = Math.round((bounds.y + 16) * scale);
    await sleep(800);
    const input = osInput(`[W.U]::SetCursorPos(${cx},${cy}); [W.U]::mouse_event(2,0,0,0,0); Start-Sleep -Milliseconds 60; [W.U]::mouse_event(4,0,0,0,0); [W.U]::keybd_event(0x7C,0,0,0); [W.U]::keybd_event(0x7C,0,2,0)`);
    let clickAt = null;
    for (let i = 0; i < 100 && clickAt === null; i++) {
      if (await overlay.evaluate(() => ripples.length)) clickAt = (Date.now() - recStart) / 1000;
      else await sleep(40);
    }
    assert(clickAt !== null, 'click effect never appeared');
    await overlay.screenshot({ path: path.join(shotDir, 'effects-overlay.png') });
    await input;
    await sleep(300);
    const keyText = await overlay.textContent('#keys');
    assert(/F13/.test(keyText), `keystroke overlay shows "${keyText}"`);

    console.log("step: drawing");
    // Drawing mode: draw a box and a pen stroke on the overlay.
    await main.click('#btn-draw');
    await byUrl('drawbar.html');
    await sleep(500);
    const drawAt = (Date.now() - recStart) / 1000;
    await overlay.mouse.move(200, 200); await overlay.mouse.down();
    for (let i = 0; i <= 20; i++) await overlay.mouse.move(200 + i * 15, 200 + Math.sin(i / 3) * 40);
    await overlay.mouse.up();
    await sleep(1200);
    await overlay.screenshot({ path: path.join(shotDir, 'drawing-overlay.png') });
    await main.click('#btn-draw');
    await sleep(600);

    await main.click('#btn-rec');
    await main.waitForSelector('body:not(.recording)', { timeout: 30000 });
    await sleep(3000);

    const files = fs.readdirSync(outDir);
    for (const f of files) fs.copyFileSync(path.join(outDir, f), path.join(shotDir, f));
    const mp4 = files.find((f) => f.endsWith('.mp4') && !f.endsWith('.webcam.mp4'));
    const webcamMp4 = files.find((f) => f.endsWith('.webcam.mp4'));
    assert(mp4, `no recording in ${files}`);
    assert(webcamMp4, `no separate webcam recording in ${files}`);
    ffmpeg.locate();
    for (const [name, at] of [['frame-click', clickAt + 0.05], ['frame-drawing', drawAt + 1.0]]) {
      await ffmpeg.run(['-loglevel', 'error', '-ss', String(at), '-i', path.join(outDir, mp4), '-frames:v', '1', '-vf', 'scale=960:-2', path.join(shotDir, `${name}.png`)]);
    }
    const info = await ffmpeg.probe(path.join(outDir, webcamMp4));
    console.log('recording:', mp4, '| webcam file:', webcamMp4, `${Number(info.format.duration).toFixed(1)}s`);
    assert(!errors.length, `renderer errors: ${errors.join('\n')}`);
    const mainLog = path.join(profile, 'logs', 'main.log');
    assert(!fs.existsSync(mainLog), `main-process errors:
${fs.existsSync(mainLog) && fs.readFileSync(mainLog, 'utf8')}`);
    console.log('OVERLAYS E2E OK — screenshots in', shotDir);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((e) => { console.error('OVERLAYS E2E FAILED:', e.message); process.exit(1); });
