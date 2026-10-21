// Stress test for the recording lifecycle through the real UI and hotkeys: double REC clicks,
// pause spam, cancel while saving, stop→record immediately, countdown abort, screenshot spam,
// overlapping hotkey captures. Verifies files, no orphaned ffmpeg processes, and no errors.
// Usage: node test/e2e/stress.js
const { _electron: electron } = require('playwright-core');
const assert = require('assert');
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpeg = require('../../src/main/ffmpeg');

const ROOT = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ffmpegCount = () => (execFileSync('tasklist', ['/FI', 'IMAGENAME eq ffmpeg.exe', '/NH'], { encoding: 'utf8' }).match(/ffmpeg\.exe/gi) || []).length;
function pressKey(vk) {
  const ps = `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte k,byte s,int f,int e);'; [W.U]::keybd_event(${vk},0,0,0); [W.U]::keybd_event(${vk},0,2,0)`;
  return new Promise((resolve) => execFile('powershell', ['-NoProfile', '-Command', ps], () => resolve()));
}

(async () => {
  ffmpeg.locate();
  const baseline = ffmpegCount();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'capturepro-profile-'));
  const outDir = path.join(profile, 'out');
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
    mode: 'full', general: { outputDir: outDir, trayNotifications: false },
    video: { soundEffects: false, fps: 15 }, hotkeys: { cancel: 'F14' },
  }));
  const env = { ...process.env, CAPTUREPRO_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ROOT], env, cwd: ROOT });
  const videos = () => (fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.endsWith('.mp4')) : []);
  const errors = [];
  try {
    await app.evaluate(() => { global.__errs = []; process.prependListener('uncaughtException', (e) => global.__errs.push(String(e.stack))); process.prependListener('unhandledRejection', (e) => global.__errs.push(String(e?.stack || e))); });
    let main;
    for (let i = 0; i < 50 && !main; i++) { main = app.windows().find((w) => w.url().includes('main/index.html')); if (!main) await sleep(200); }
    main.on('pageerror', (e) => errors.push(e.message));
    await main.waitForSelector('.card');
    const idle = () => main.waitForSelector('body:not(.recording)', { timeout: 30000 });
    const recording = () => main.waitForSelector('body.recording', { timeout: 15000 });

    // 1. Double-click REC: exactly one recording.
    console.log('1 double REC');
    await Promise.all([main.click('#btn-rec'), main.click('#btn-rec', { delay: 60 })]);
    await recording(); await sleep(1500);
    assert.equal(ffmpegCount() - baseline, 1, 'one ffmpeg while recording');
    await main.click('#btn-rec'); await idle(); await sleep(500);
    assert.equal(videos().length, 1, `one file after double REC (${videos()})`);

    // 2. Pause spam.
    console.log('2 pause spam');
    await main.click('#btn-rec'); await recording(); await sleep(800);
    for (let i = 0; i < 7; i++) await main.click('#btn-pause', { delay: 0 });
    await sleep(2500);
    await main.click('#btn-rec'); await idle(); await sleep(500);
    assert.equal(videos().length, 2);

    // 3. Cancel hotkey right after Stop must not delete the recording.
    console.log('3 cancel while saving');
    await main.click('#btn-rec'); await recording(); await sleep(1500);
    await main.click('#btn-rec');
    await pressKey(0x7d); // F14 = cancel hotkey
    await idle(); await sleep(800);
    assert.equal(videos().length, 3, 'recording kept despite cancel during save');

    // 4. Stop then immediately record again.
    console.log('4 stop → record');
    await main.click('#btn-rec'); await recording(); await sleep(1200);
    await main.click('#btn-rec');
    await main.click('#btn-rec');
    await sleep(4000);
    if (await main.$('body.recording')) { await main.click('#btn-rec'); await idle(); }
    await sleep(800);
    assert.ok(videos().length >= 4, 'stop/record sequence saved its recordings');

    // 5. Countdown aborted by pressing REC again: nothing recorded.
    console.log('5 countdown abort');
    const before = videos().length;
    await main.click('#nav button[data-page="video"]');
    await main.selectOption('select[data-k="video.countdown"]', '3');
    await main.click('#btn-rec'); await sleep(1000);
    await main.click('#btn-rec'); await sleep(3500);
    assert.equal(await main.$('body.recording'), null, 'countdown aborted');
    assert.equal(videos().length, before);
    await main.selectOption('select[data-k="video.countdown"]', '0');

    // 6. Screenshot spam.
    console.log('6 screenshot spam');
    for (let i = 0; i < 6; i++) await main.click('#btn-shot', { delay: 0 });
    await sleep(4000);
    assert.ok(fs.readdirSync(outDir).some((f) => f.endsWith('.png')), 'screenshots saved');

    // 7. Two hotkey fields listening at once, then Esc: neither stays stuck.
    console.log('7 hotkey capture overlap');
    await main.click('.hotkey[data-hk="hotkeys.record"]');
    await main.click('.hotkey[data-hk="hotkeys.pause"]');
    await pressKey(0x1b);
    await sleep(800);
    const labels = await main.$$eval('.hotkey[data-hk]', (els) => els.map((e) => e.textContent));
    assert.ok(labels.every((l) => !/Press a key/.test(l)), `hotkey buttons released: ${labels}`);

    await sleep(1500);
    assert.equal(ffmpegCount(), baseline, 'no orphaned ffmpeg processes');
    for (const f of videos()) {
      const info = await ffmpeg.probe(path.join(outDir, f));
      assert.ok(info && Number(info.format.duration) > 0.5, `${f} is a valid video`);
    }
    assert.deepEqual(await app.evaluate(() => global.__errs), [], 'no main-process exceptions');
    const log = path.join(profile, 'logs', 'main.log');
    assert(!fs.existsSync(log), `main.log:\n${fs.existsSync(log) && fs.readFileSync(log, 'utf8')}`);
    assert.deepEqual(errors, [], 'no renderer errors');
    console.log(`STRESS E2E OK — ${videos().length} valid recordings`);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((e) => { console.error('STRESS E2E FAILED:', e.message); process.exit(1); });
