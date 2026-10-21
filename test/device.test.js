const test = require('node:test');
const assert = require('node:assert');
const { deviceTranscodeArgs } = require('../src/main/device');

test('device transcode applies deinterlace, rotation, flip, scale and encoder', () => {
  const a = deviceTranscodeArgs('in.webm', 'out.mp4', {
    video: { fps: 30, fpsMode: 'cfr', quality: 80, size: 'half' }, audio: { codec: 'aac', bitrate: 160 },
    ffEncoder: 'h264_qsv', container: 'mp4', device: { deinterlace: 'odd', rotate: 90, flipH: true, flipV: false },
  });
  const vf = a[a.indexOf('-vf') + 1];
  assert.equal(vf, 'yadif=mode=0:parity=tff,transpose=1,hflip,fps=30,scale=trunc(iw/4)*2:trunc(ih/4)*2,format=nv12');
  assert.deepEqual(a.slice(a.indexOf('-map'), a.indexOf('-map') + 4), ['-map', '0:v:0', '-map', '0:a?']);
  assert.ok(a.includes('+faststart'));
  assert.ok(!a.includes('-fps_mode'), 'CFR output');
  assert.equal(a.at(-1), 'out.mp4');
});

test('device transcode without options keeps VFR', () => {
  const a = deviceTranscodeArgs('in.webm', 'out.avi', { video: {}, audio: { codec: 'mp3' }, ffEncoder: 'mjpeg', container: 'avi', device: {} });
  assert.equal(a[a.indexOf('-vf') + 1], 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuvj420p');
  assert.equal(a[a.indexOf('-fps_mode') + 1], 'vfr');
  assert.equal(a[a.indexOf('-c:a') + 1], 'libmp3lame');
});
