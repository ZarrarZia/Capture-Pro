// Per-display transparent overlay windows that are *included* in the capture:
// click effects, cursor highlight, keystrokes, countdown and the drawing canvas.
const { BrowserWindow, screen } = require('electron');
const path = require('path');

class Overlays {
  constructor({ preload, rendererDir }) {
    this.preload = preload;
    this.file = path.join(rendererDir, 'overlay', 'overlay.html');
    this.wins = new Map(); // display.id -> BrowserWindow
    this.interactive = false;
    this.cursorTimer = null;
    screen.on('display-added', () => this.sync());
    screen.on('display-removed', () => this.sync());
    screen.on('display-metrics-changed', () => this.sync());
  }

  get active() { return this.wins.size > 0; }

  // Creates (or re-fits) one overlay per display.
  sync() {
    if (!this.wanted) return;
    const displays = screen.getAllDisplays();
    for (const [id, w] of this.wins) if (!displays.some((d) => d.id === id)) { w.destroy(); this.wins.delete(id); }
    for (const d of displays) {
      let w = this.wins.get(d.id);
      if (!w) {
        w = new BrowserWindow({
          ...d.bounds, frame: false, transparent: true, resizable: false, movable: false, hasShadow: false,
          skipTaskbar: true, focusable: false, show: false, alwaysOnTop: true, fullscreenable: false,
          webPreferences: { preload: this.preload, backgroundThrottling: false },
        });
        w.setAlwaysOnTop(true, 'screen-saver');
        w.setIgnoreMouseEvents(!this.interactive);
        w.queue = [];
        w.loadFile(this.file);
        w.webContents.once('did-finish-load', () => {
          w.ready = true;
          w.webContents.send('overlay:config', { ...this.config, display: { id: d.id, bounds: d.bounds } });
          for (const [ch, p] of w.queue) w.webContents.send(ch, p);
          w.queue = null;
          w.showInactive();
        });
        this.wins.set(d.id, w);
      } else {
        w.setBounds(d.bounds);
      }
    }
  }

  open(config) {
    this.wanted = true;
    this.config = config;
    this.sync();
    for (const [id, w] of this.wins) {
      const d = screen.getAllDisplays().find((x) => x.id === id);
      if (w.ready) w.webContents.send('overlay:config', { ...config, display: { id, bounds: d?.bounds } });
    }
    clearInterval(this.cursorTimer);
    if (config.mouse?.highlight) this.cursorTimer = setInterval(() => this._cursor(), 16);
  }

  close() {
    this.wanted = false;
    clearInterval(this.cursorTimer);
    this.cursorTimer = null;
    for (const w of this.wins.values()) w.destroy();
    this.wins.clear();
    this.interactive = false;
  }

  // Sends to the overlay of the display containing the DIP point, with display-local coordinates.
  sendAt(channel, dipPoint, payload = {}) {
    const d = screen.getDisplayNearestPoint(dipPoint);
    const w = this.wins.get(d.id);
    if (w) this._send(w, channel, { ...payload, x: dipPoint.x - d.bounds.x, y: dipPoint.y - d.bounds.y });
  }

  broadcast(channel, payload) {
    for (const w of this.wins.values()) this._send(w, channel, payload);
  }

  // Messages sent while an overlay is still loading are delivered once it is ready.
  _send(w, channel, payload) {
    if (w.isDestroyed()) return;
    if (w.ready) w.webContents.send(channel, payload); else w.queue.push([channel, payload]);
  }

  // Physical (hook) coordinates → DIP.
  mouse(ev) {
    if (!this.active) return;
    const p = screen.screenToDipPoint({ x: ev.x, y: ev.y });
    this.sendAt('overlay:mouse', p, { type: ev.type, btn: ev.btn });
  }

  setInteractive(on) {
    this.interactive = on;
    for (const w of this.wins.values()) {
      w.setIgnoreMouseEvents(!on);
      w.setFocusable(on);
      if (on) w.focus();
    }
    this.broadcast('overlay:interactive', on);
  }

  _cursor() {
    const p = screen.getCursorScreenPoint();
    const d = screen.getDisplayNearestPoint(p);
    for (const [id, w] of this.wins) {
      if (w.isDestroyed()) continue;
      w.webContents.send('overlay:cursor', id === d.id ? { x: p.x - d.bounds.x, y: p.y - d.bounds.y } : null);
    }
  }
}

module.exports = { Overlays };
