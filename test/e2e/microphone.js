// Regression test for "my own voice is not recorded": starts from settings saved by v1 (microphone off,
// stale mic device id), mutes computer sound so only the microphone can be heard, records, and checks
// that the file actually contains microphone audio. Uses Chromium's fake microphone (a periodic beep).
// Usage: node test/e2e/microphone.js
const { _electron: electron } = require('playwright-core');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpeg = require('../../src/main/ffmpeg');

const ROOT = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function maxVolumeDb(file) {
  const err = await ffmpeg.run(['-i', file, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-']);
  return Number(/max_volume:\s*(-?[\d.]+|-inf) dB/.exec(err)?.[1] ?? -Infinity);
}

(async () => {
  ffmpeg.locate();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'capturepro-profile-'));
  const outDir = path.join(profile, 'out');
  // Exactly what v1 saved: no version, microphone disabled, plus a device id that no longer exists.
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
    mode: 'full', general: { outputDir: outDir, trayNotifications: false },
    video: { soundEffects: false },
    audio: { enabled: true, speaker: { enabled: true }, mic: { enabled: false, deviceId: 'device-that-was-unplugged' }, mix: true },
  }));
  const env = { ...process.env, CAPTUREPRO_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ROOT], env, cwd: ROOT });
  try {
    let main;
    for (let i = 0; i < 50 && !main; i++) { main = app.windows().find((w) => w.url().includes('main/index.html')); if (!main) await sleep(200); }
    await main.waitForSelector('.card');

    const saved = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
    assert.equal(saved.audio.mic.enabled, true, 'v1 settings were migrated to record the microphone');
    assert.equal(await main.getAttribute('#btn-mute-mic', 'class').then((c) => c.includes('disabled-src')), false, 'toolbar shows the mic as recorded');

    // "Off" source button: switching the mic off in settings, then clicking the toolbar button turns it back on.
    await main.click('#nav button[data-page="audio"]');
    await main.uncheck('input[data-k="audio.mic.enabled"]');
    await sleep(300);
    assert.ok((await main.getAttribute('#btn-mute-mic', 'class')).includes('disabled-src'), 'toolbar shows the mic as OFF');
    await main.click('#btn-mute-mic');
    await sleep(300);
    assert.ok(await main.isChecked('input[data-k="audio.mic.enabled"]'), 'clicking the OFF mic button enables it');

    // Mute computer sound so anything audible in the file must come from the microphone.
    await main.click('#btn-mute-spk');
    await main.click('#btn-rec');
    await main.waitForSelector('body.recording', { timeout: 15000 });
    await sleep(1000);
    const toasts = await main.textContent('#toasts');
    await sleep(3000);
    await main.click('#btn-rec');
    await main.waitForSelector('body:not(.recording)', { timeout: 30000 });
    await sleep(500);

    const file = fs.readdirSync(outDir).find((f) => f.endsWith('.mp4'));
    assert(file, 'recording saved');
    const db = await maxVolumeDb(path.join(outDir, file));
    console.log(`microphone-only recording peak: ${db} dB`);
    assert.ok(db > -30, `microphone audio is present in the recording (peak ${db} dB)`);
    assert.match(toasts, /selected microphone was not found/, 'stale mic id falls back to the default microphone with a warning');
    console.log('MICROPHONE E2E OK');
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((e) => { console.error('MICROPHONE E2E FAILED:', e.message); process.exit(1); });
