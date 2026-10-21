// End-to-end test for phase 3: device recording (fake camera/mic) with pause, around-mouse following,
// and a scheduled recording that starts and stops by itself.
// Usage: node test/e2e/automation.js [screenshotDir]
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
const hms = (d) => d.toTimeString().slice(0, 8);

function moveCursor(points) {
  const steps = points.map(([x, y]) => `[W.U]::SetCursorPos(${x},${y}); Start-Sleep -Milliseconds 250`).join('; ');
  const ps = `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);'; ${steps}`;
  return new Promise((resolve) => execFile('powershell', ['-NoProfile', '-Command', ps], () => resolve()));
}

(async () => {
  ffmpeg.locate();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'capturepro-profile-'));
  const outDir = path.join(profile, 'out');
  const start = new Date(Date.now() + 75000); // scheduled run, well after the other scenarios
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
    mode: 'device', general: { outputDir: outDir, trayNotifications: false, subfolder: 'none' },
    video: { soundEffects: false, fps: 30 }, target: { mouseSize: { w: 640, h: 360 } },
    schedules: [{ id: 'e2e', name: 'E2E', active: true, type: 'daily', start: hms(start), end: hms(new Date(start.getTime() + 4000)), target: 'full', display: 0, after: 'nothing' }],
  }));
  const env = { ...process.env, CAPTUREPRO_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ROOT], env, cwd: ROOT });
  const byUrl = async (part) => {
    for (let t = 0; t < 15000; t += 200) { const w = app.windows().find((x) => x.url().includes(part)); if (w) return w; await sleep(200); }
    throw new Error(`window ${part} not found`);
  };
  const newFile = async (before, timeout = 30000) => {
    for (let t = 0; t < timeout; t += 500) {
      const f = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((x) => !before.includes(x) && /\.(mp4|avi|mkv)$/.test(x) && !x.startsWith('.')) : [];
      if (f.length) return f[0];
      await sleep(500);
    }
    throw new Error('no new recording appeared');
  };
  const probe = async (f) => { const i = await ffmpeg.probe(path.join(outDir, f)); return { dur: Number(i.format.duration), streams: i.streams.map((s) => `${s.codec_type}:${s.codec_name}${s.width ? ` ${s.width}x${s.height}` : ''}`) }; };

  try {
    const main = await byUrl('main/index.html');
    const errors = [];
    main.on('pageerror', (e) => errors.push(e.message));
    await main.waitForSelector('.card');

    // 1. Device mode: fake camera + fake mic, record 3 s, pause 1 s, resume 2 s.
    const dev = await byUrl('device.html');
    dev.on('pageerror', (e) => errors.push(`device: ${e.message}`));
    await sleep(2500);
    await dev.screenshot({ path: path.join(shotDir, 'device-window.png') });
    let before = [];
    await main.click('#btn-rec');
    await main.waitForSelector('body.recording', { timeout: 15000 });
    await sleep(3000);
    await main.click('#btn-pause'); await sleep(1000); await main.click('#btn-pause');
    await sleep(2000);
    await main.click('#btn-rec');
    await main.waitForSelector('body:not(.recording)', { timeout: 60000 });
    const devFile = await newFile(before);
    const d = await probe(devFile);
    console.log('device recording:', devFile, d.dur.toFixed(2), 's', d.streams.join(', '));
    assert(d.streams.some((s) => s.startsWith('video:h264')) && d.streams.some((s) => s.startsWith('audio:')), 'device file has video + audio');
    assert(d.dur > 3.8 && d.dur < 6.5, `device duration ${d.dur} (pause excluded)`);

    // 2. Around mouse: 640x360 window that follows the cursor.
    before = fs.readdirSync(outDir);
    await main.click('#modes .mode[data-mode="mouse"]');
    await sleep(500);
    await main.click('#btn-rec');
    await main.waitForSelector('body.recording', { timeout: 15000 });
    await moveCursor([[300, 300], [600, 400], [900, 500], [1200, 600], [1500, 700], [1700, 800], [1500, 300], [900, 200]]);
    await main.click('#btn-rec');
    await main.waitForSelector('body:not(.recording)', { timeout: 30000 });
    const mouseFile = await newFile(before);
    const m = await probe(mouseFile);
    console.log('around-mouse recording:', mouseFile, m.dur.toFixed(2), 's', m.streams.join(', '));
    assert(m.streams.some((s) => s.includes('640x360')), 'around-mouse output is 640x360');
    await ffmpeg.run(['-loglevel', 'error', '-i', path.join(outDir, mouseFile), '-vf', 'fps=3,scale=320:-2,tile=4x2', '-frames:v', '1', path.join(shotDir, 'around-mouse-tiles.png')]);

    // 3. Scheduled recording starts and stops by itself (fullscreen, 4 s).
    before = fs.readdirSync(outDir);
    await main.click('#nav button[data-page="general"]');
    await main.click('#sched-open');
    await sleep(500);
    await main.screenshot({ path: path.join(shotDir, 'schedules.png') });
    await main.click('#modal-x');
    const wait = start.getTime() - Date.now();
    console.log(`waiting ${Math.round(wait / 1000)} s for the scheduled recording…`);
    await main.waitForSelector('body.recording', { timeout: wait + 15000 });
    console.log('scheduled recording started');
    await main.waitForSelector('body:not(.recording)', { timeout: 30000 });
    const schedFile = await newFile(before);
    const sres = await probe(schedFile);
    console.log('scheduled recording:', schedFile, sres.dur.toFixed(2), 's');
    assert(sres.dur > 2.5 && sres.dur < 6, `scheduled duration ${sres.dur}`);

    assert(!errors.length, `renderer errors:\n${errors.join('\n')}`);
    const mainLog = path.join(profile, 'logs', 'main.log');
    assert(!fs.existsSync(mainLog), `main-process errors:
${fs.existsSync(mainLog) && fs.readFileSync(mainLog, 'utf8')}`);
    console.log('AUTOMATION E2E OK — screenshots in', shotDir);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((e) => { console.error('AUTOMATION E2E FAILED:', e.message); process.exit(1); });
