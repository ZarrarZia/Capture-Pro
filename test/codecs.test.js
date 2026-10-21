const test = require('node:test');
const assert = require('node:assert');
const { resolveEncoder, videoEncoderArgs, audioEncoderArgs, scaleFilter, pixelFormat } = require('../src/main/codecs');
const { buildRecordArgs, textFileContent, positionExpr } = require('../src/main/capture-args');

test('resolveEncoder on macOS prefers VideoToolbox, then CPU', { skip: process.platform !== 'darwin' }, () => {
  assert.equal(resolveEncoder('h264', 'auto', new Set(['h264_videotoolbox', 'libx264'])), 'vt');
  assert.equal(resolveEncoder('hevc', 'auto', new Set(['libx265'])), 'cpu');
});

test('resolveEncoder prefers requested, then hardware, then CPU', { skip: process.platform === 'darwin' }, () => {
  const avail = new Set(['h264_qsv', 'libx264', 'h264_nvenc']);
  assert.equal(resolveEncoder('h264', 'qsv', avail), 'qsv');
  assert.equal(resolveEncoder('h264', 'auto', avail), 'nvenc');
  assert.equal(resolveEncoder('h264', 'amf', avail), 'nvenc'); // unavailable request falls back
  assert.equal(resolveEncoder('h264', 'cpu', new Set(['libx264'])), 'cpu');
  assert.throws(() => resolveEncoder('hevc', 'auto', new Set()), /No available encoder/);
});

test('quality maps to sensible CRF / CQ ranges', () => {
  const crf = (q) => videoEncoderArgs('libx264', { quality: q, fps: 30 }).at(videoEncoderArgs('libx264', { quality: q, fps: 30 }).indexOf('-crf') + 1);
  assert.equal(crf(100), '14');
  assert.equal(crf(0), '38');
  assert.ok(Number(crf(80)) > 14 && Number(crf(80)) < 25);
  const nv = videoEncoderArgs('h264_nvenc', { rateControl: 'cbr', bitrate: 6000, fps: 60, keyframeSec: 2 });
  assert.deepEqual(nv.slice(nv.indexOf('-rc'), nv.indexOf('-rc') + 4), ['-rc', 'cbr', '-b:v', '6000k']);
  assert.equal(nv[nv.indexOf('-g') + 1], '120');
  assert.ok(videoEncoderArgs('mpeg4', { quality: 80 }).includes('XVID'));
});

test('pixel formats and scaling keep encoder constraints', () => {
  assert.equal(pixelFormat('h264_qsv'), 'nv12');
  assert.equal(pixelFormat('mjpeg'), 'yuvj420p');
  assert.equal(scaleFilter({ size: 'custom', width: 1281, height: 721 }), 'scale=1282:722');
  assert.equal(scaleFilter({ size: 'fitHeight', height: 720 }), 'scale=-2:720');
});

test('audio codec falls back to one the container supports', () => {
  assert.deepEqual(audioEncoderArgs({ codec: 'pcm' }, 'mp4').slice(0, 2), ['-c:a', 'aac']);
  assert.deepEqual(audioEncoderArgs({ codec: 'aac' }, 'avi').slice(0, 2), ['-c:a', 'libmp3lame']);
  assert.deepEqual(audioEncoderArgs({ codec: 'pcm' }, 'wav').slice(0, 2), ['-c:a', 'pcm_s16le']);
});

test('buildRecordArgs: WGC monitor with crop, logo, text and two audio tracks', () => {
  const args = buildRecordArgs({
    source: { kind: 'wgc-monitor', hmonitor: 65537, crop: { left: 10, top: 20, right: 0, bottom: 30 } },
    showCursor: true, ffEncoder: 'h264_qsv', container: 'mp4',
    video: { fps: 60, fpsMode: 'cfr', quality: 80, size: 'full' }, audio: { codec: 'aac', bitrate: 160 },
    audioPipes: ['P1', 'P2'], logo: { image: 'C:/l.png', opacity: 50, position: 'bottom-left', marginX: 8, marginY: 9 },
    texts: [{ textFile: 'C:/t.txt', position: 'top-center', shadow: true }], output: 'out.mkv',
  });
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.match(fc, /gfxcapture=hmonitor=65537:max_framerate=60:capture_cursor=1:crop_left=10:crop_top=20:crop_bottom=30/);
  assert.match(fc, /fps=60,scale=/);
  assert.match(fc, /\[2:v\]format=rgba,colorchannelmixer=aa=0.5\[logo\]/);
  assert.match(fc, /overlay=x=8:y=H-h-9/);
  const font = process.platform === 'darwin' ? '/System/Library/Fonts/Supplemental/Arial.ttf' : 'C:/Windows/Fonts/arial.ttf';
  assert.ok(fc.includes(`drawtext=fontfile='${font}':textfile='C:/t.txt'`), fc);
  assert.match(fc, /format=nv12\[vout\]$/);
  assert.deepEqual(args.filter((a, i) => args[i - 1] === '-map'), ['[vout]', '0:a', '1:a']);
  assert.ok(!args.includes('-fps_mode'), 'CFR must not force VFR');
  assert.equal(args.at(-1), 'out.mkv');
});

test('buildRecordArgs: gdigrab input, VFR and audio-only', () => {
  const g = buildRecordArgs({ source: { kind: 'gdi', region: { x: -1920, y: 0, w: 3840, h: 1080 } }, ffEncoder: 'libx264', video: {}, output: 'o.mkv' });
  assert.deepEqual(g.slice(g.indexOf('-offset_x'), g.indexOf('-offset_x') + 2), ['-offset_x', '-1920']);
  assert.ok(g.includes('[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2[scaled]') || g.join(' ').includes('[0:v]scale='));
  assert.equal(g[g.indexOf('-fps_mode') + 1], 'vfr');
  const a = buildRecordArgs({ source: null, audio: { codec: 'mp3' }, container: 'mp3', audioPipes: ['P'], output: 'a.mkv' });
  assert.ok(!a.includes('-filter_complex'));
  assert.deepEqual(a.filter((x, i) => a[i - 1] === '-map'), ['0:a']);
  assert.equal(a[a.indexOf('-c:a') + 1], 'libmp3lame');
});

test('buildRecordArgs: around-mouse follow crop is controllable over zmq', () => {
  const a = buildRecordArgs({
    source: { kind: 'wgc-monitor', hmonitor: 1 }, follow: { port: 5700, w: 1280, h: 720, x: 10, y: 20 },
    ffEncoder: 'libx264', video: {}, output: 'o.mkv',
  });
  const fc = a[a.indexOf('-filter_complex') + 1];
  assert.ok(fc.includes(String.raw`zmq=b=tcp\\://127.0.0.1\\:5700,crop@follow=w=1280:h=720:x=10:y=20[src]`), fc);
});

test('text macros and positions', () => {
  assert.equal(textFileContent('Rec {time} 100%'), 'Rec %{localtime:%H\\:%M\\:%S} 100\\%');
  assert.deepEqual(positionExpr('middle-center', 5, 5, 'w', 'h'), { x: '(W-w)/2', y: '(H-h)/2' });
});
