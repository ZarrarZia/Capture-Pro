// Device recording mode (webcams, HDMI capture cards, consoles): a preview window recorded with
// MediaRecorder, then transcoded by ffmpeg into the user's chosen format.
const { BrowserWindow, screen } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { videoEncoderArgs, audioEncoderArgs, pixelFormat, scaleFilter } = require('./codecs');

const DEINTERLACE = { odd: 'yadif=mode=0:parity=tff', even: 'yadif=mode=0:parity=bff', blend: 'bwdif' };
const ROTATE = { 90: 'transpose=1', 180: 'hflip,vflip', 270: 'transpose=2' };

// ffmpeg arguments that turn the browser recording into the final file (pure; unit-tested).
function deviceTranscodeArgs(input, output, { video, audio, ffEncoder, container, device }) {
  const f = [];
  if (DEINTERLACE[device.deinterlace]) f.push(DEINTERLACE[device.deinterlace]);
  if (ROTATE[device.rotate]) f.push(ROTATE[device.rotate]);
  if (device.flipH) f.push('hflip');
  if (device.flipV) f.push('vflip');
  if (video.fpsMode === 'cfr') f.push(`fps=${video.fps || 30}`);
  f.push(scaleFilter(video), `format=${pixelFormat(ffEncoder)}`);
  const args = ['-loglevel', 'error', '-i', input, '-map', '0:v:0', '-map', '0:a?', '-vf', f.join(','), ...videoEncoderArgs(ffEncoder, video)];
  if (video.fpsMode !== 'cfr') args.push('-fps_mode', 'vfr');
  args.push(...audioEncoderArgs(audio, container));
  if (container === 'mp4') args.push('-movflags', '+faststart');
  args.push(output);
  return args;
}

class Device {
  constructor({ preload, rendererDir, settings }) {
    this.preload = preload;
    this.file = path.join(rendererDir, 'device', 'device.html');
    this.settings = settings;
    this.win = null;
    this.waiters = new Map();
  }

  sync() {
    if (this.settings.get().mode !== 'device') { this.win?.hide(); this.win?.webContents.send('device:config', null); return; }
    if (!this.win || this.win.isDestroyed()) this._create();
    else { this.win.show(); this._sendConfig(); }
  }

  close() { if (this.win && !this.win.isDestroyed()) this.win.destroy(); this.win = null; }

  _create() {
    const wa = screen.getPrimaryDisplay().workArea;
    const b = this.settings.get().target.deviceBounds || { width: 800, height: 494, x: Math.round(wa.x + (wa.width - 800) / 2), y: Math.round(wa.y + (wa.height - 494) / 2) };
    const win = this.win = new BrowserWindow({
      ...b, minWidth: 360, minHeight: 240, frame: false, show: false, backgroundColor: '#0a0c11', title: 'CapturePro – Device',
      icon: path.join(__dirname, '..', '..', 'assets', 'icon.png').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep),
      webPreferences: { preload: this.preload, backgroundThrottling: false },
    });
    win.loadFile(this.file);
    win.webContents.on('render-process-gone', (_e, info) => { if (info.reason !== 'clean-exit' && !win.isDestroyed()) win.webContents.reload(); });
    // Also runs after a crash-reload, so the device page always gets its configuration back.
    let first = true;
    win.webContents.on('did-finish-load', () => { win.ready = true; this._sendConfig(); if (first) win.show(); first = false; });
    const save = () => { if (!win.isDestroyed() && !win.isFullScreen()) this.settings.update({ target: { deviceBounds: win.getBounds() } }); };
    win.on('moved', save);
    win.on('resized', save);
    win.on('close', (e) => { e.preventDefault(); win.hide(); });
  }

  _sendConfig() { if (this.win?.ready) this.win.webContents.send('device:config', this.settings.get().target.device); }

  // Renderer round-trips ("recording", "recordDone", "snapshot") resolve the matching waiter.
  _wait(name, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiters.delete(name); reject(new Error(`Capture device did not respond (${name}).`)); }, ms);
      this.waiters.set(name, (v) => { clearTimeout(t); this.waiters.delete(name); v?.error ? reject(new Error(v.error)) : resolve(v); });
    });
  }
  resolve(name, value) { this.waiters.get(name)?.(value); }

  // External source for Recorder (see recorder.js).
  external(transcode) {
    let tmp = null, out = null, written = 0;
    return {
      start: async () => {
        if (!this.win?.ready) throw new Error('Please select a video capture device.');
        tmp = path.join(os.tmpdir(), `capturepro-device-${process.pid}-${Date.now()}.webm`);
        out = fs.createWriteStream(tmp);
        written = 0;
        this.onChunk = (buf) => { written += buf.byteLength; out.write(Buffer.from(buf)); };
        const ack = this._wait('recording', 6000);
        this.win.webContents.send('device:record', { on: true });
        try {
          await ack;
        } catch (e) {
          // Don't leave a recorder running in the page, an open file or a stray temp file behind.
          this.win?.webContents.send('device:record', { on: false });
          this.onChunk = null;
          await new Promise((r) => out.end(r));
          fs.rm(tmp, () => {});
          throw e;
        }
      },
      pause: async () => this.win?.webContents.send('device:record', { on: 'pause' }),
      resume: async () => this.win?.webContents.send('device:record', { on: 'resume' }),
      stop: async () => {
        const done = this._wait('recordDone', 6000).catch(() => null);
        this.win?.webContents.send('device:record', { on: false });
        await done;
        this.onChunk = null;
        await new Promise((r) => out.end(r));
        return tmp;
      },
      bytes: () => written,
      transcodeArgs: (input, output) => deviceTranscodeArgs(input, output, transcode),
    };
  }

  chunk(buf) { this.onChunk?.(buf); }

  async snapshot() {
    if (!this.win?.ready) throw new Error('Please select a video capture device.');
    const p = this._wait('snapshot', 5000);
    this.win.webContents.send('device:snapshot');
    return Buffer.from(await p);
  }
}

module.exports = { Device, deviceTranscodeArgs };
