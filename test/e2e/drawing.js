// End-to-end test for drawing mode, including the crash reported by the user
// ("Object has been destroyed" in Overlays.setInteractive after closing an overlay and picking a tool).
// Usage: node test/e2e/drawing.js [screenshotDir]
const { _electron: electron } = require('playwright-core');
const assert = require('assert');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const shotDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'capturepro-shots-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pressCtrlAltD() {
  const ps = `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte k,byte s,int f,int e);';
    [W.U]::keybd_event(0x11,0,0,0); [W.U]::keybd_event(0x12,0,0,0); [W.U]::keybd_event(0x44,0,0,0);
    [W.U]::keybd_event(0x44,0,2,0); [W.U]::keybd_event(0x12,0,2,0); [W.U]::keybd_event(0x11,0,2,0)`;
  return new Promise((resolve) => execFile('powershell', ['-NoProfile', '-Command', ps], () => resolve()));
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'capturepro-profile-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
    mode: 'full', general: { outputDir: path.join(profile, 'out'), trayNotifications: false },
    video: { soundEffects: false }, audio: { mic: { enabled: false } }, overlays: { mouse: { clickEffect: true } },
  }));
  const env = { ...process.env, CAPTUREPRO_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['--use-fake-device-for-media-stream', ROOT], env, cwd: ROOT });
  const rendererErrors = [];
  const watch = (page, name) => page.on('pageerror', (e) => rendererErrors.push(`${name}: ${e.message}`));
  // Newest page for a window that is really alive (Playwright can keep stale handles briefly).
  const find = async (part) => {
    for (let t = 0; t < 5000; t += 100) {
      for (const w of app.windows().filter((x) => x.url().includes(part)).reverse()) {
        if (await w.evaluate(() => 1).then(() => true, () => false)) return w;
      }
      await sleep(100);
    }
    return null;
  };
  const waitFor = async (part, present = true, timeout = 8000) => {
    for (let t = 0; t < timeout; t += 100) {
      const visible = await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.webContents.getURL().includes(p) && w.isVisible()), part);
      if (visible === present) return;
      await sleep(100);
    }
    throw new Error(`${part} expected ${present ? 'visible' : 'gone'}`);
  };
  const drawing = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.webContents.getURL().includes('overlay.html')));
  const mainErrors = () => app.evaluate(() => global.__errs);

  try {
    await app.evaluate(() => { global.__errs = []; process.prependListener('uncaughtException', (e) => global.__errs.push(String(e.stack))); process.prependListener('unhandledRejection', (e) => global.__errs.push(String(e?.stack || e))); });
    let main;
    for (let i = 0; i < 50 && !main; i++) { main = await find('main/index.html'); if (!main) await sleep(200); }
    watch(main, 'main');
    await main.waitForSelector('.card');

    // 1. Every tool, colours, width, whiteboard, undo/redo/clear.
    console.log("step 1");
    await main.click('#btn-draw');
    await waitFor('drawbar.html');
    await waitFor('overlay.html');
    const bar = await find('drawbar.html'); watch(bar, 'drawbar');
    const ov = await find('overlay.html'); watch(ov, 'overlay');
    await sleep(400);
    let x = 120;
    for (const tool of ['pen', 'highlighter', 'line', 'arrow', 'box', 'ellipse', 'eraser']) {
      await bar.click(`[data-tool="${tool}"]`);
      await bar.click(`.swatch:nth-child(${(x / 120) % 6 + 1})`);
      await ov.mouse.move(x, 150); await ov.mouse.down();
      for (let i = 1; i <= 8; i++) await ov.mouse.move(x + i * 10, 150 + i * 12);
      await ov.mouse.up();
      x += 120;
    }
    await bar.click('[data-tool="number"]');
    for (const px of [150, 220, 290]) await ov.mouse.click(px, 400);
    await bar.click('[data-tool="text"]');
    await ov.mouse.click(400, 450);
    await ov.keyboard.type('Hello CapturePro');
    await ov.keyboard.press('Enter');
    await bar.locator('#width').fill('9');
    await sleep(300);
    await ov.screenshot({ path: path.join(shotDir, 'drawing-all-tools.png') });
    const shapes = await ov.evaluate(() => drawing.shapes.length);
    assert.equal(shapes, 11, `7 strokes + 3 numbers + 1 text drawn (got ${shapes})`);
    await bar.click('#undo'); await bar.click('#undo'); await bar.click('#redo');
    await sleep(200);
    assert.equal(await ov.evaluate(() => drawing.shapes.length), 10, 'undo twice, redo once');
    await bar.click('#whiteboard'); await sleep(200);
    await ov.screenshot({ path: path.join(shotDir, 'drawing-whiteboard.png') });
    await bar.click('#whiteboard');
    await bar.click('#clear'); await sleep(200);
    assert.equal(await ov.evaluate(() => drawing.shapes.length), 0, 'clear all');

    // 2. Exit with the toolbar's close button.
    console.log("step 2");
    await bar.click('#close');
    await waitFor('drawbar.html', false);
    assert.equal(await drawing(), false, 'overlays closed after exit');

    // 3. Re-enter with the real Ctrl+Alt+D hotkey, exit with Esc on the overlay.
    console.log("step 3");
    await pressCtrlAltD();
    await waitFor('drawbar.html');
    await waitFor('overlay.html');
    const ov2 = await find('overlay.html'); watch(ov2, 'overlay');
    await ov2.keyboard.down('Escape').catch(() => {}); // the overlay closes on key-down
    await waitFor('drawbar.html', false);

    // 4. The reported crash: Alt+F4 on the overlay, then pick a tool.
    console.log("step 4");
    await main.click('#btn-draw');
    await waitFor('overlay.html');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('overlay.html')).close());
    await sleep(500);
    const bar2 = await find('drawbar.html');
    if (bar2) await bar2.evaluate(() => window.capturepro.overlay.setDraw({ tool: 'arrow', color: '#ff3b48', width: 4, whiteboard: false }));
    await sleep(300);
    assert.deepEqual(await mainErrors(), [], 'no main-process errors after closing an overlay and picking a tool');
    assert.equal(await drawing(), false, 'Alt+F4 on the overlay exits drawing mode');

    // 5. Alt+F4 on the toolbar exits drawing mode instead of leaving a full-screen overlay behind.
    console.log("step 5");
    await main.click('#btn-draw');
    await waitFor('drawbar.html');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('drawbar.html')).close());
    await waitFor('overlay.html', false);

    // 6. Rapid toggling.
    console.log("step 6");
    for (let i = 0; i < 10; i++) await main.click('#btn-draw');
    await sleep(1500);
    if (await drawing()) await main.click('#btn-draw');
    await waitFor('overlay.html', false);

    // 7. Draw during a recording, exit drawing, click effects keep working.
    console.log("step 7");
    await main.click('#btn-rec');
    await main.waitForSelector('body.recording', { timeout: 15000 });
    await main.click('#btn-draw');
    await waitFor('overlay.html');
    const ov3 = await find('overlay.html'); watch(ov3, 'overlay');
    await sleep(400);
    await ov3.mouse.move(300, 300); await ov3.mouse.down(); await ov3.mouse.move(500, 350); await ov3.mouse.up();
    await main.click('#btn-draw');
    await sleep(600);
    assert.equal(await ov3.evaluate(() => drawing.enabled), false, 'overlay knows drawing ended while recording');
    await main.click('#btn-rec');
    await main.waitForSelector('body:not(.recording)', { timeout: 30000 });

    await sleep(500);
    assert.deepEqual(await mainErrors(), [], 'no main-process errors');
    const log = path.join(profile, 'logs', 'main.log');
    assert(!fs.existsSync(log), `main.log has errors:\n${fs.existsSync(log) && fs.readFileSync(log, 'utf8')}`);
    assert.deepEqual(rendererErrors, [], 'no renderer errors');
    console.log('DRAWING E2E OK — screenshots in', shotDir);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((e) => { console.error('DRAWING E2E FAILED:', e.message); process.exit(1); });
