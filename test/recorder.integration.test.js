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
const hasFfmpeg = !!ffmpeg.locate();

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
