// "Around mouse" recording: steers ffmpeg's crop@follow window towards the cursor over ZeroMQ.
const net = require('net');
const { screen } = require('electron');
const { ZmqReq } = require('./zmq');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

class MouseFollower {
  // follow = { w, h, x, y, monitor: { x, y, w, h } } in physical pixels
  constructor(follow) {
    this.f = follow;
    this.zmq = null;
    this.timer = null;
  }

  static freePort() {
    return new Promise((resolve, reject) => {
      const s = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
        const { port } = s.address();
        s.close(() => resolve(port));
      });
    });
  }

  async attach(port) {
    this.detach();
    let z = null;
    for (let i = 0; i < 20 && !z; i++) {
      const c = new ZmqReq(port);
      try { await c.connect(1000); z = c; } catch { c.close(); await new Promise((r) => setTimeout(r, 150)); }
    }
    if (!z) return;
    this.zmq = z;
    this.busy = false;
    this.sent = { x: this.f.x, y: this.f.y };
    this.timer = setInterval(() => this._tick(), 33);
  }

  detach() {
    clearInterval(this.timer);
    this.timer = null;
    this.zmq?.close();
    this.zmq = null;
  }

  async _tick() {
    if (this.busy || !this.zmq) return;
    const { w, h, monitor: m } = this.f;
    const c = screen.dipToScreenPoint(screen.getCursorScreenPoint());
    const tx = clamp(c.x - m.x - w / 2, 0, m.w - w);
    const ty = clamp(c.y - m.y - h / 2, 0, m.h - h);
    // Ease towards the target so the view pans smoothly instead of jumping.
    this.f.x += (tx - this.f.x) * 0.35;
    this.f.y += (ty - this.f.y) * 0.35;
    const x = Math.round(this.f.x), y = Math.round(this.f.y);
    if (x === this.sent.x && y === this.sent.y) return;
    this.busy = true;
    try {
      if (x !== this.sent.x) await this.zmq.send(`crop@follow x ${x}`);
      if (y !== this.sent.y) await this.zmq.send(`crop@follow y ${y}`);
      this.sent = { x, y };
    } catch { this.detach(); } finally { this.busy = false; }
  }
}

module.exports = { MouseFollower };
