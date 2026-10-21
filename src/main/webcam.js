// Webcam overlay window manager: placement relative to the capture region, drag/resize persistence,
// and the optional separate "<name>.webcam.mp4" recording.
const { BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpeg = require('./ffmpeg');
const { SHAPES } = require('../renderer/webcam/shapes');

const MARGIN = 16;

class Webcam {
  constructor({ preload, rendererDir, settings, getRegion }) {
    this.preload = preload;
    this.file = path.join(rendererDir, 'webcam', 'webcam.html');
    this.settings = settings;
    this.getRegion = getRegion; // () => DIP rect of the current capture area
    this.win = null;
    this.cameraAspect = 16 / 9;
    this.recFile = null;
    this.recStream = null;
  }

  wanted() {
    const s = this.settings.get();
    return s.overlays.webcam.enabled && ['rect', 'full', 'window', 'mouse', 'game'].includes(s.mode);
  }

  sync() {
    if (!this.wanted()) { this.close(); return; }
    if (!this.win) this._create();
    this.win.setBounds(this.bounds());
    this._sendConfig();
  }

  close() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  aspect() {
    const c = this.settings.get().overlays.webcam;
    let a = SHAPES[c.shape]?.aspect ?? this.cameraAspect;
    if ((c.rotate === 90 || c.rotate === 270) && SHAPES[c.shape]?.aspect == null) a = 1 / a;
    return a;
  }

  bounds() {
    const c = this.settings.get().overlays.webcam;
    const r = this.getRegion();
    const w = Math.max(80, Math.round((r.w * c.size) / 100));
    const h = Math.round(w / this.aspect());
    let x, y;
    if (c.position === 'custom' && c.x != null) {
      x = r.x + Math.round(c.x * r.w);
      y = r.y + Math.round(c.y * r.h);
    } else {
      const [v, hz] = (c.position || 'bottom-right').split('-');
      x = hz === 'left' ? r.x + MARGIN : hz === 'center' ? r.x + (r.w - w) / 2 : r.x + r.w - w - MARGIN;
      y = v === 'top' ? r.y + MARGIN : v === 'middle' ? r.y + (r.h - h) / 2 : r.y + r.h - h - MARGIN;
    }
    return { x: Math.round(x), y: Math.round(y), width: w, height: h };
  }

  _create() {
    this.win = new BrowserWindow({
      ...this.bounds(), frame: false, transparent: true, resizable: false, hasShadow: false, skipTaskbar: true,
      focusable: false, show: false, alwaysOnTop: true, fullscreenable: false,
      webPreferences: { preload: this.preload, backgroundThrottling: false },
    });
    this.win.setAlwaysOnTop(true, 'screen-saver');
    const win = this.win;
    win.loadFile(this.file);
    win.webContents.once('did-finish-load', () => { win.ready = true; this._sendConfig(); win.showInactive(); });
  }

  _sendConfig() {
    if (this.win?.ready && !this.win.isDestroyed()) this.win.webContents.send('webcam:config', this.settings.get().overlays.webcam);
  }

  // ---- interaction from the webcam renderer
  setCameraAspect(a) {
    if (!a || Math.abs(a - this.cameraAspect) < 0.01) return;
    this.cameraAspect = a;
    if (this.win) this.win.setBounds(this.bounds());
  }

  dragStart() { this.dragOrigin = this.win?.getBounds(); }
  dragMove(dx, dy) {
    if (!this.dragOrigin || !this.win) return;
    this.win.setBounds({ ...this.dragOrigin, x: this.dragOrigin.x + dx, y: this.dragOrigin.y + dy });
  }
  dragEnd() {
    if (!this.win) return;
    const b = this.win.getBounds(), r = this.getRegion();
    this.dragOrigin = null;
    this.settings.update({ overlays: { webcam: { position: 'custom', x: (b.x - r.x) / r.w, y: (b.y - r.y) / r.h } } });
  }
  resize(dir) {
    const c = this.settings.get().overlays.webcam;
    this.settings.update({ overlays: { webcam: { size: Math.max(5, Math.min(100, c.size + dir * 2)) } } });
  }

  // ---- separate webcam file
  startRecording(finalPath) {
    if (!this.win || !this.settings.get().overlays.webcam.saveSeparate) return;
    this.target = finalPath.replace(/\.[^.]+$/, '') + '.webcam.mp4';
    this.recFile = path.join(os.tmpdir(), `capturepro-webcam-${process.pid}-${Date.now()}.webm`);
    this.recStream = fs.createWriteStream(this.recFile);
    this.win.webContents.send('webcam:record', { on: true });
  }
  pause(paused) { this.win?.webContents.send('webcam:record', { on: paused ? 'pause' : 'resume' }); }
  chunk(buf) { this.recStream?.write(Buffer.from(buf)); }

  // Resolves with the .webcam.mp4 path (or null) after the renderer flushes its last chunk.
  stopRecording() {
    if (!this.recStream) return Promise.resolve(null);
    return new Promise((resolve) => {
      const finish = async () => {
        clearTimeout(t);
        const stream = this.recStream, part = this.recFile, target = this.target;
        this.recStream = null;
        await new Promise((r) => stream.end(r));
        try {
          await ffmpeg.run(['-loglevel', 'error', '-i', part, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', target]);
          resolve(target);
        } catch { resolve(null); } finally { fs.rm(part, () => {}); }
      };
      const t = setTimeout(finish, 4000);
      this.onRecordDone = finish;
      this.win?.webContents.send('webcam:record', { on: false });
      if (!this.win) finish();
    });
  }
  recordDone() { const f = this.onRecordDone; this.onRecordDone = null; f?.(); }
}

module.exports = { Webcam };
