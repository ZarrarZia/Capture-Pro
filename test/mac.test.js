// macOS capture logic (pure functions, so these run on any OS).
const test = require('node:test');
const assert = require('node:assert');
const { videoEncoderArgs, pixelFormat } = require('../src/main/codecs');
const { buildRecordArgs, buildImageArgs } = require('../src/main/capture-args');
const { avfRegion } = require('../src/main/targets');

const monitors = [
  { index: 0, hmonitor: 1, x: 0, y: 0, w: 1512, h: 982, primary: true, scale: 2 },
  { index: 1, hmonitor: 2, x: 1512, y: 0, w: 1920, h: 1080, primary: false, scale: 1 },
];

test('avfRegion crops in the screen pixel space (Retina 2x) and clamps to the screen', () => {
  assert.deepEqual(avfRegion(monitors, { x: 100, y: 50, w: 640, h: 360 }), { kind: 'avf', screen: 0, scale: 2, region: { x: 200, y: 100, w: 1280, h: 720 } });
  assert.deepEqual(avfRegion(monitors, { x: 1612, y: 10, w: 801, h: 451 }).region, { x: 100, y: 10, w: 800, h: 450 }, 'second display, 1x, even sizes');
  assert.deepEqual(avfRegion(monitors, { x: 1400, y: 900, w: 200, h: 200 }).region, { x: 2800, y: 1800, w: 224, h: 164 }, 'clamped to the first screen');
});

test('AVFoundation screen input with crop, follow and screenshot', () => {
  const rec = buildRecordArgs({ source: { kind: 'avf', screen: 1, region: { x: 10, y: 20, w: 640, h: 360 } }, showCursor: true, ffEncoder: 'h264_videotoolbox', video: { fps: 60 }, output: 'o.mkv' });
  assert.deepEqual(rec.slice(rec.indexOf('-f'), rec.indexOf('-f') + 8), ['-f', 'avfoundation', '-capture_cursor', '1', '-framerate', '60', '-i', 'Capture screen 1:none']);
  assert.match(rec[rec.indexOf('-filter_complex') + 1], /^\[0:v\]crop=640:360:10:20\[src\];.*format=nv12\[vout\]$/);
  const follow = buildRecordArgs({ source: { kind: 'avf', screen: 0 }, follow: { port: 5800, w: 1280, h: 720, x: 4, y: 6 }, ffEncoder: 'libx264', video: {}, output: 'o.mkv' });
  assert.ok(follow.join(' ').includes(String.raw`[0:v]zmq=b=tcp\\://127.0.0.1\\:5800,crop@follow=w=1280:h=720:x=4:y=6[src]`));
  const shot = buildImageArgs({ source: { kind: 'avf', screen: 0, region: { x: 0, y: 0, w: 100, h: 50 } }, format: 'png', output: 'a.png' });
  assert.ok(shot.includes('Capture screen 0:none') && shot.join(' ').includes('[0:v]crop=100:50:0:0[src]'));
});

test('VideoToolbox encoder settings', () => {
  const v = videoEncoderArgs('hevc_videotoolbox', { quality: 80, fps: 30 });
  assert.equal(v[v.indexOf('-b:v') + 1], '19600k');
  assert.ok(v.includes('-allow_sw') && v.includes('hvc1'));
  const c = videoEncoderArgs('h264_videotoolbox', { rateControl: 'cbr', bitrate: 6000, fps: 30 });
  assert.deepEqual(c.slice(c.indexOf('-maxrate'), c.indexOf('-maxrate') + 2), ['-maxrate', '6000k']);
  assert.equal(pixelFormat('h264_videotoolbox'), 'nv12');
});
