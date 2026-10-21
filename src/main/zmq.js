// Minimal ZeroMQ (ZMTP 3.0, NULL mechanism) REQ client — just enough to send commands to
// ffmpeg's `zmq` filter (a REP socket) without a native ZeroMQ dependency.
const net = require('net');

const GREETING = Buffer.concat([
  Buffer.from([0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0x7f, 3, 0]),
  Buffer.from('NULL'.padEnd(20, '\0')),
  Buffer.from([0]), Buffer.alloc(31),
]);

function frame(body, { more = false, command = false } = {}) {
  const flags = (more ? 1 : 0) | (command ? 4 : 0);
  if (body.length < 256) return Buffer.concat([Buffer.from([flags, body.length]), body]);
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(body.length));
  return Buffer.concat([Buffer.from([flags | 2]), size, body]);
}

function readyCommand() {
  const name = Buffer.from('Socket-Type'), value = Buffer.from('REQ');
  const vlen = Buffer.alloc(4); vlen.writeUInt32BE(value.length);
  return frame(Buffer.concat([Buffer.from([5]), Buffer.from('READY'), Buffer.from([name.length]), name, vlen, value]), { command: true });
}

class ZmqReq {
  constructor(port, host = '127.0.0.1') {
    this.port = port;
    this.host = host;
    this.buf = Buffer.alloc(0);
    this.greeted = false;
    this.ready = false;
    this.queue = [];      // pending { msg, resolve }
    this.inflight = null; // request awaiting a reply
    this.parts = [];
  }

  connect(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.sock?.destroy(); reject(new Error('zmq connect timeout')); }, timeoutMs);
      this.onReady = () => { clearTimeout(t); resolve(); };
      this.sock = net.connect(this.port, this.host, () => this.sock.write(GREETING));
      this.sock.on('data', (d) => this._data(d));
      this.sock.on('error', (e) => { clearTimeout(t); reject(e); this._failAll(e); });
      this.sock.on('close', () => this._failAll(new Error('zmq socket closed')));
    });
  }

  // Sends one command string; resolves with ffmpeg's reply ("0 Success" etc).
  send(msg) {
    return new Promise((resolve, reject) => {
      this.queue.push({ msg, resolve, reject });
      this._pump();
    });
  }

  close() { this.sock?.destroy(); }

  _pump() {
    if (!this.ready || this.inflight || !this.queue.length) return;
    this.inflight = this.queue.shift();
    this.sock.write(Buffer.concat([frame(Buffer.alloc(0), { more: true }), frame(Buffer.from(this.inflight.msg))]));
  }

  _failAll(e) {
    for (const r of [this.inflight, ...this.queue]) r?.reject(e);
    this.inflight = null;
    this.queue = [];
  }

  _data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    if (!this.greeted) {
      if (this.buf.length < 64) return;
      this.buf = this.buf.subarray(64);
      this.greeted = true;
      this.sock.write(readyCommand());
    }
    for (;;) {
      if (this.buf.length < 2) return;
      const flags = this.buf[0];
      const long = flags & 2;
      const hdr = long ? 9 : 2;
      if (this.buf.length < hdr) return;
      const len = long ? Number(this.buf.readBigUInt64BE(1)) : this.buf[1];
      if (this.buf.length < hdr + len) return;
      const body = this.buf.subarray(hdr, hdr + len);
      this.buf = this.buf.subarray(hdr + len);
      if (flags & 4) { // command (READY from the peer)
        if (!this.ready) { this.ready = true; this.onReady?.(); this._pump(); }
        continue;
      }
      this.parts.push(body);
      if (flags & 1) continue; // more frames follow
      const reply = this.parts.filter((p) => p.length).map(String).join('');
      this.parts = [];
      const r = this.inflight;
      this.inflight = null;
      r?.resolve(reply);
      this._pump();
    }
  }
}

module.exports = { ZmqReq };
