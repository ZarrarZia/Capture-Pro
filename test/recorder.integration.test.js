// Real capture: records the primary monitor with piped audio, pauses, resumes, stops,
// and checks the final MP4 with ffprobe. Skipped when ffmpeg is unavailable.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpeg = require('../src/main/ffmpeg');
const { Recorder } = require('../src/main/recorder');
const { buildRecordArgs } = require('../src/main/capture-args');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// These tests capture through Desktop Duplication, so they run on Windows only.
const hasFfmpeg = process.platform === 'win32' && !!ffmpeg.locate();

function plan(dir, opts = {}) {
  return {
    finalPath: path.join(dir, 'out.mp4'), container: 'mp4', audioTracks: 0,
    buildArgs: (seg) => buildRecordArgs({
      source: { kind: 'dda', outputIdx: 0, region: { x: 0, y: 0, w: 320, h: 240 } }, showCursor: false,
      ffEncoder: opts.encoder || 'libx264', container: 'mp4', video: { fps: 15, fpsMode: 'cfr', optimize: 'speed' }, output: seg,
    }),
  };
}
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'capturepro-test-'));

test('double start: second call is rejected and only one recording exists', { skip: !hasFfmpeg, timeout: 60000 }, async () => {
  const dir = tmpDir();
  const rec = new Recorder();
  try {
    const [a, b] = await Promise.allSettled([rec.start(plan(dir)), rec.start(plan(dir))]);
    assert.equal(a.status, 'fulfilled');
    assert.equal(b.status, 'rejected');
    assert.match(b.reason.message, /Already recording/);
    await sleep(1000);
    const res = await rec.stop();
    assert.ok(fs.existsSync(res.file));
    assert.equal(rec.state, 'idle');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pause/resume spam without awaiting still produces one valid file', { skip: !hasFfmpeg, timeout: 90000 }, async () => {
  const dir = tmpDir();
  const rec = new Recorder();
  try {
    await rec.start(plan(dir));
    await sleep(800);
    const ops = [];
    for (let i = 0; i < 4; i++) { ops.push(rec.pause()); ops.push(rec.resume()); }
    await Promise.all(ops);
    assert.equal(rec.state, 'recording');
    await sleep(800);
    const res = await rec.stop();
    const info = await ffmpeg.probe(res.file);
    assert.ok(Number(info.format.duration) > 1, 'file is playable');
    assert.ok(!fs.existsSync(path.join(dir, '.capturepro-tmp')), 'no leftover segments');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cancel pressed while saving does not delete the saved recording', { skip: !hasFfmpeg, timeout: 60000 }, async () => {
  const dir = tmpDir();
  const rec = new Recorder();
  try {
    await rec.start(plan(dir));
    await sleep(1200);
    const stopping = rec.stop();
    const canceling = rec.cancel();
    const res = await stopping;
    await canceling;
    assert.ok(fs.existsSync(res.file), 'the recording was kept');
    assert.equal(rec.state, 'idle');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a start that fails cleans up and leaves the recorder usable', { skip: !hasFfmpeg, timeout: 60000 }, async () => {
  const dir = tmpDir();
  const rec = new Recorder();
  const failed = [];
  rec.on('failed', (m) => failed.push(m));
  try {
    await assert.rejects(rec.start(plan(dir, { encoder: 'no_such_encoder_xyz' })));
    assert.equal(rec.state, 'idle');
    assert.ok(!fs.existsSync(path.join(dir, '.capturepro-tmp')), 'temp folder removed');
    assert.deepEqual(failed, [], "start-up failures are reported by start(), not as a 'failed' event");
    await rec.start(plan(dir));
    await sleep(800);
    assert.ok(fs.existsSync((await rec.stop()).file), 'next recording works');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('record → pause → resume → stop produces one MP4 with video and audio', { skip: !hasFfmpeg, timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capturepro-test-'));
  const finalPath = path.join(dir, 'out.mp4');
  const rec = new Recorder();
  const states = [];
  rec.on('state', (s) => states.push(s));

  // 440 Hz tone, fed in 10 ms chunks like the audio engine does.
  let t = 0;
  const tone = setInterval(() => {
    const b = Buffer.alloc(480 * 8);
    for (let i = 0; i < 480; i++, t++) { const v = 0.2 * Math.sin(2 * Math.PI * 440 * t / 48000); b.writeFloatLE(v, i * 8); b.writeFloatLE(v, i * 8 + 4); }
    rec.writeAudio(0, b);
  }, 10);

  try {
    await rec.start({
      finalPath, container: 'mp4', audioTracks: 1,
      buildArgs: (seg, pipes) => buildRecordArgs({
        source: { kind: 'dda', outputIdx: 0, region: { x: 0, y: 0, w: 640, h: 360 } }, showCursor: true,
        ffEncoder: 'libx264', container: 'mp4', video: { fps: 30, fpsMode: 'cfr', quality: 60, optimize: 'speed' },
        audio: { codec: 'aac' }, audioPipes: pipes, output: seg,
      }),
    });
    await sleep(1500);
    await rec.pause();
    assert.equal(rec.state, 'paused');
    await sleep(800);
    await rec.resume();
    await sleep(1500);
    const result = await rec.stop();

    assert.equal(result.file, finalPath);
    assert.deepEqual(states, ['recording', 'paused', 'recording', 'stopping', 'idle']);
    const info = await ffmpeg.probe(finalPath);
    const types = info.streams.map((s) => s.codec_type).sort();
    assert.deepEqual(types, ['audio', 'video']);
    const dur = Number(info.format.duration);
    assert.ok(dur > 2.2 && dur < 4.5, `duration ${dur} should exclude the paused time`);
    assert.ok(!fs.existsSync(path.join(dir, '.capturepro-tmp')), 'temp segments cleaned up');
  } finally {
    clearInterval(tone);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
