// End-to-end smoke test: launches CapturePro with an isolated profile, walks every page,
// records fullscreen with pause/resume, captures a screenshot, and verifies the outputs.
// Usage: node test/e2e/smoke.js [screenshotDir]
const { _electron: electron } = require('playwright-core');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpeg = require('../../src/main/ffmpeg');

const ROOT = path.join(__dirname, '..', '..');
const shotDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'capturepro-shots-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'capturepro-profile-'));
  const outDir = path.join(profile, 'out');
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
    mode: 'full', general: { outputDir: outDir, trayNotifications: false },
    video: { encoder: 'auto', fps: 30, soundEffects: false }, ui: { lastPage: 'home' },
  }));
  const env = { ...process.env, CAPTUREPRO_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({ args: [ROOT], env, cwd: ROOT });
  const errors = [];
  try {
    const win = await app.firstWindow();
    // firstWindow may be the hidden audio engine; find the main UI.
    let main = null;
    for (let i = 0; i < 40 && !main; i++) {
      for (const w of app.windows()) if ((await w.title()) === 'CapturePro') main = w;
      if (!main) await sleep(250);
    }
    assert(main, 'main window not found');
    main.on('pageerror', (e) => errors.push(e.message));
    main.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await main.waitForSelector('.card');
    await main.setViewportSize({ width: 1040, height: 646 }).catch(() => {});

    for (const p of ['home', 'general', 'video', 'image', 'audio', 'about']) {
      await main.click(`#nav button[data-page="${p}"]`);
      await sleep(250);
      await main.screenshot({ path: path.join(shotDir, `page-${p}.png`) });
    }

    // Window picker lists real windows with thumbnails.
    await main.click('#nav button[data-page="home"]');
    await main.click('.card[data-mode="window"]');
    await main.click('#pick-window');
    await main.waitForSelector('.win-pick', { timeout: 10000 });
    await main.screenshot({ path: path.join(shotDir, 'window-picker.png') });
    await main.click('#modal-x');

    // Rectangle mode shows the capture frame window.
    await main.click('.card[data-mode="rect"]');
    await sleep(600);
    const rect = app.windows().find((w) => w.url().includes('rect.html'));
    assert(rect, 'capture frame window missing');
    await rect.screenshot({ path: path.join(shotDir, 'rect-frame.png') });
    const sizeLabel = await rect.textContent('#size');
    console.log('capture frame size label:', sizeLabel);
    assert(/^\d+ × \d+$/.test(sizeLabel) && sizeLabel !== '1280 × 720', `size label not populated: ${sizeLabel}`);

    // Record fullscreen: 2 s, pause 1 s, resume 2 s, stop.
    await main.click('.card[data-mode="full"]');
    await main.click('#btn-rec');
    await main.waitForSelector('body.recording', { timeout: 15000 });
    await sleep(2000);
    await main.click('#btn-pause');
    await sleep(1000);
    await main.screenshot({ path: path.join(shotDir, 'recording-paused.png') });
    await main.click('#btn-pause');
    await sleep(2000);
    await main.click('#btn-rec');
    await main.waitForSelector('body:not(.recording)', { timeout: 30000 });

    await main.click('#btn-shot');
    await sleep(2500);

    await main.click('#nav button[data-page="videos"]');
    await main.waitForSelector('.out-item', { timeout: 10000 });
    await sleep(1500);
    await main.screenshot({ path: path.join(shotDir, 'videos.png') });

    const files = fs.readdirSync(outDir);
    for (const f of files) fs.copyFileSync(path.join(outDir, f), path.join(shotDir, f));
    const mp4 = files.find((f) => f.endsWith('.mp4'));
    const png = files.find((f) => f.endsWith('.png'));
    assert(mp4, `no mp4 in ${files}`);
    assert(png, `no png in ${files}`);
    ffmpeg.locate();
    const info = await ffmpeg.probe(path.join(outDir, mp4));
    const dur = Number(info.format.duration);
    console.log('recorded', mp4, `${dur.toFixed(2)}s`, info.streams.map((s) => `${s.codec_type}:${s.codec_name}${s.width ? ` ${s.width}x${s.height}` : ''}`).join(', '));
    assert(dur > 3 && dur < 6, `duration ${dur} should be ~4 s (pause excluded)`);
    assert(!errors.length, `renderer errors:\n${errors.join('\n')}`);
    console.log('E2E OK — screenshots in', shotDir);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((e) => { console.error('E2E FAILED:', e.message); process.exit(1); });
