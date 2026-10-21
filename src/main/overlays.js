// Per-display transparent overlay windows that are *included* in the capture:
// click effects, cursor highlight, keystrokes, countdown and the drawing canvas.
//
// Overlays can disappear underneath us (Alt+F4 while drawing, a crashed renderer, a display being
// unplugged), so every access goes through _live() and lost windows are recreated on demand.
// Events: 'close-request' — the user tried to close an overlay (treated as "exit drawing mode");
//         'shown' — an overlay appeared (it may now cover the drawing toolbar, which must be raised).
//
// Overlays never activate (WS_EX_NOACTIVATE): clicking one to draw must not raise it above the
// drawing toolbar or take keyboard focus from it. Only the text tool focuses an overlay, briefly.
const { BrowserWindow, screen } = require('electron');
const { EventEmitter } = require('events');
const path = require('path');
const platform = require('./platform');

// Channels whose latest value must be replayed to overlays created later.
const STICKY = new Set(['overlay:draw', 'overlay:interactive']);

class Overlays extends EventEmitter {
  constructor({ preload, rendererDir }) {
    super();
    this.preload = preload;
    this.file = path.join(rendererDir, 'overlay', 'overlay.html');
    this.wins = new Map(); // display.id -> BrowserWindow
    this.interactive = false;
    this.cursorTimer = null;
    this.sticky = new Map();
    const resync = () => this.sync();
    screen.on('display-added', resync);
    screen.on('display-removed', resync);
    screen.on('display-metrics-changed', resync);
  }

  get active() { return this._live().length > 0; }

  // [displayId, window] pairs whose windows are still alive; prunes dead ones.
  _live() {
    const out = [];
    for (const [id, w] of this.wins) {
      if (w.isDestroyed()) this.wins.delete(id); else out.push([id, w]);
    }
    return out;
  }

  // Creates (or re-fits) one overlay per display.
  sync() {
    if (!this.wanted) return;
    const displays = screen.getAllDisplays();
    for (const [id, w] of this._live()) if (!displays.some((d) => d.id === id)) this._destroy(id, w);
    for (const d of displays) {
      const w = this.wins.get(d.id);
      if (w && !w.isDestroyed()) w.setBounds(d.bounds);
      else this._create(d);
    }
  }

  _create(d) {
    const w = new BrowserWindow({
      ...d.bounds, frame: false, transparent: true, resizable: false, movable: false, hasShadow: false,
      skipTaskbar: true, focusable: false, show: false, alwaysOnTop: true, fullscreenable: false,
      minimizable: false, maximizable: false,
      webPreferences: { preload: this.preload, backgroundThrottling: false },
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setIgnoreMouseEvents(!this.interactive);
    w.queue = [];
    w.on('close', (e) => {
      if (w.allowClose) return;
      e.preventDefault(); // Alt+F4 on an interactive overlay: let the app decide (exit drawing mode)
      this.emit('close-request');
    });
    w.on('closed', () => { if (this.wins.get(d.id) === w) this.wins.delete(d.id); });
    w.webContents.on('render-process-gone', () => {
      this._destroy(d.id, w);
      setTimeout(() => this.sync(), 200); // recreate it
    });
    w.webContents.once('did-finish-load', () => {
      if (w.isDestroyed()) return;
      w.ready = true;
      w.webContents.send('overlay:config', { ...this.config, display: { id: d.id, bounds: d.bounds } });
      for (const [ch, p] of this.sticky) w.webContents.send(ch, p);
      for (const [ch, p] of w.queue) if (!STICKY.has(ch)) w.webContents.send(ch, p);
      w.queue = null;
      w.showInactive();
      this.emit('shown', w);
    });
    w.loadFile(this.file);
    this.wins.set(d.id, w);
  }

  _destroy(id, w) {
    if (this.wins.get(id) === w) this.wins.delete(id);
    if (!w.isDestroyed()) { w.allowClose = true; w.destroy(); }
  }

  open(config) {
    this.wanted = true;
    this.config = config;
    this.sync();
    for (const [id, w] of this._live()) {
      const d = screen.getAllDisplays().find((x) => x.id === id);
      if (w.ready) w.webContents.send('overlay:config', { ...config, display: { id, bounds: d?.bounds } });
    }
    clearInterval(this.cursorTimer);
    this.cursorTimer = config.mouse?.highlight ? setInterval(() => this._cursor(), 16) : null;
  }

  close() {
    this.wanted = false;
    clearInterval(this.cursorTimer);
    this.cursorTimer = null;
    for (const [id, w] of this._live()) this._destroy(id, w);
    this.wins.clear();
    this.sticky.clear();
    this.interactive = false;
  }

  // Sends to the overlay of the display containing the DIP point, with display-local coordinates.
  sendAt(channel, dipPoint, payload = {}) {
    const d = screen.getDisplayNearestPoint(dipPoint);
    const w = this.wins.get(d.id);
    if (w) this._send(w, channel, { ...payload, x: dipPoint.x - d.bounds.x, y: dipPoint.y - d.bounds.y });
  }

  broadcast(channel, payload) {
    if (STICKY.has(channel)) this.sticky.set(channel, payload);
    for (const [, w] of this._live()) this._send(w, channel, payload);
  }

  // Messages sent while an overlay is still loading are delivered once it is ready.
  _send(w, channel, payload) {
    if (w.isDestroyed()) return;
    if (w.ready) w.webContents.send(channel, payload);
    else w.queue?.push([channel, payload]);
  }

  // Physical (hook) coordinates → DIP.
  mouse(ev) {
    if (!this.active) return;
    const p = platform.physToDipPoint({ x: ev.x, y: ev.y });
    this.sendAt('overlay:mouse', p, { type: ev.type, btn: ev.btn });
  }

  setInteractive(on) {
    this.interactive = on;
    for (const [, w] of this._live()) {
      w.setIgnoreMouseEvents(!on);
      if (!on && w.textFocus) { w.textFocus = false; w.setFocusable(false); }
    }
    this.broadcast('overlay:interactive', on);
  }

  typing() { return this._live().some(([, w]) => w.textFocus); }

  // Text tool: the overlay needs the keyboard while the user types, then gives it back.
  setKeyboard(w, on) {
    if (!w || w.isDestroyed() || ![...this.wins.values()].includes(w)) return;
    w.textFocus = on;
    w.setFocusable(on);
    if (on) w.focus();
  }

  _cursor() {
    const p = screen.getCursorScreenPoint();
    const d = screen.getDisplayNearestPoint(p);
    for (const [id, w] of this._live()) {
      if (w.ready) w.webContents.send('overlay:cursor', id === d.id ? { x: p.x - d.bounds.x, y: p.y - d.bounds.y } : null);
    }
  }
}

module.exports = { Overlays };
