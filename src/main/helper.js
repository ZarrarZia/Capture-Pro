// Bridge to native/bin/CaptureProHelper.exe (window queries, monitors, global input hooks).
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const readline = require('readline');

class Helper extends EventEmitter {
  constructor(exePath) {
    super();
    this.exePath = exePath;
    this.seq = 0;
    this.pending = new Map();
    this.down = new Set();
  }

  start() {
    this.restarts = this.restarts || 0;
    const proc = this.proc = spawn(this.exePath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.startedAt = Date.now();
    // 'error' is re-emitted only when someone listens, so a missing/blocked exe can't crash the app.
    proc.on('error', (e) => { if (this.listenerCount('error')) this.emit('error', e); });
    proc.stdin.on('error', () => {}); // writes racing a crash (EPIPE) are handled by 'exit'
    proc.on('exit', () => {
      for (const { reject } of this.pending.values()) reject(new Error('helper exited'));
      this.pending.clear();
      if (this.stopping) return;
      // Self-heal with back-off: 1 s, 2 s, 4 s … up to 30 s; reset after a minute of healthy running.
      if (Date.now() - this.startedAt > 60000) this.restarts = 0;
      const delay = Math.min(30000, 1000 * 2 ** this.restarts++);
      setTimeout(() => this.start(), delay);
    });
    readline.createInterface({ input: proc.stdout }).on('line', (line) => this._onLine(line));
    this.down.clear();
    this.request('hook on').catch(() => {});
  }

  stop() {
    this.stopping = true;
    try { this.proc?.kill(); } catch { /* gone */ }
  }

  request(cmd, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.exitCode !== null || !this.proc.stdin.writable) return reject(new Error('helper not running'));
      const id = String(++this.seq);
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`helper timeout: ${cmd}`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.proc.stdin.write(`${id} ${cmd}\n`);
    });
  }

  foreground() { return this.request('foreground'); }
  async windows() { return (await this.request('windows')).windows; }
  async monitors() { return (await this.request('monitors')).monitors; }
  async idleMs() { return (await this.request('idle')).ms; }
  mouseEvents(on) { return this.request(`mouse ${on ? 'on' : 'off'}`).catch(() => {}); }

  _onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg);
    } else if (msg.ev === 'key') {
      // Suppress auto-repeat: a key fires 'press' once per physical press.
      const fresh = msg.type === 'down' && !this.down.has(msg.vk);
      if (msg.type === 'down') this.down.add(msg.vk); else this.down.delete(msg.vk);
      this.emit('key', msg);
      if (fresh) this.emit('press', { ...msg, accel: accelerator(msg) });
    } else if (msg.ev) {
      this.emit(msg.ev, msg);
    }
  }
}

const MODIFIER_NAMES = new Set(['Ctrl', 'Alt', 'Shift', 'Win']);

// "Ctrl+Shift+F9"; modifier-only presses produce null.
function accelerator(k) {
  if (MODIFIER_NAMES.has(k.name)) return null;
  const order = ['Ctrl', 'Alt', 'Shift', 'Win'];
  return [...order.filter((m) => k.mods.includes(m)), k.name].join('+');
}

module.exports = { Helper, accelerator };
