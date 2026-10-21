// Recording session: crash-safe MKV segments (one per pause/resume), audio over named pipes,
// lossless concat + remux into the final container on stop.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const net = require('net');
const path = require('path');
const ffmpeg = require('./ffmpeg');

const PIPE_PREFIX = String.raw`\\.\pipe\capturepro-`;

class Recorder extends EventEmitter {
  constructor() {
    super();
    this.state = 'idle';
    this.plan = null;
    this.queue = Promise.resolve();
    this.busy = false; // an operation is in flight (start/pause/resume/stop/cancel)
  }

  // All public operations run one at a time, in call order, and re-check the state when their turn
  // comes. Rapid key presses (double REC, pause spam, cancel while saving) can therefore never
  // overlap and orphan an ffmpeg process or tear down the wrong segment.
  _serial(fn) {
    const run = this.queue.then(async () => { this.busy = true; try { return await fn(); } finally { this.busy = false; } });
    this.queue = run.catch(() => {});
    return run;
  }

  // plan = {
  //   finalPath, container ('mp4'|'avi'|'mkv'|'mp3'|'wav'), audioTracks (0..2),
  //   buildArgs(segmentPath, pipePaths) -> ffmpeg args, priority, splitTracks
  // }
  //   plan.external (device recording) = { start(), pause(), resume(), stop() -> tempFile, bytes(), transcodeArgs(input, output) }
  start(plan) {
    return this._serial(async () => {
      if (this.state !== 'idle') throw new Error('Already recording');
      this.plan = plan;
      this.id = `${process.pid}-${Date.now().toString(36)}`;
      this.tmpDir = path.join(path.dirname(plan.finalPath), '.capturepro-tmp', this.id);
      this.segments = [];
      this.doneBytes = 0;
      this.activeMs = 0;
      this.segStart = 0;
      this.lastError = null;
      try {
        fs.mkdirSync(this.tmpDir, { recursive: true });
        if (plan.external) { await plan.external.start(); this.segStart = Date.now(); }
        else await this._startSegment();
      } catch (e) {
        await this._endSegment().catch(() => {});
        this._cleanup();
        throw e;
      }
      this._setState('recording');
    });
  }

  pause() {
    return this._serial(async () => {
      if (this.state !== 'recording') return;
      this._setState('paused');
      if (this.plan.external) { this.activeMs += Date.now() - this.segStart; return this.plan.external.pause(); }
      await this._endSegment();
    });
  }

  resume() {
    return this._serial(async () => {
      if (this.state !== 'paused') return;
      if (this.plan.external) await this.plan.external.resume();
      else await this._startSegment();
      if (this.plan.external) this.segStart = Date.now();
      this._setState('recording');
    });
  }

  // Returns { file, extra } on success, null when there was nothing to stop. Keeps the raw MKV if the final remux fails.
  stop() {
    return this._serial(async () => {
      if (this.state === 'idle') return null;
      const wasRecording = this.state === 'recording';
      this._setState('stopping');
      try {
        if (this.plan.external) {
          if (wasRecording) this.activeMs += Date.now() - this.segStart;
          return await this._finalizeExternal(await this.plan.external.stop());
        }
        await this._endSegment();
        return await this._finalize();
      } finally {
        this._cleanup();
        this._setState('idle');
      }
    });
  }

  cancel() {
    return this._serial(async () => {
      if (this.state === 'idle') return;
      this._setState('stopping');
      try {
        if (this.plan.external) {
          const tmp = await this.plan.external.stop().catch(() => null);
          if (tmp) fs.rm(tmp, () => {});
        } else {
          await this._endSegment();
        }
      } finally {
        this._cleanup();
        this._setState('idle');
      }
    });
  }

  writeAudio(track, buf) {
    const sock = this.sockets?.[track];
    if (sock && !sock.destroyed && sock.writable) sock.write(buf);
  }

  stats() {
    const running = this.state === 'recording' ? Date.now() - this.segStart : 0;
    let curBytes = 0;
    if (this.plan?.external) curBytes = this.plan.external.bytes();
    else if (this.curSegment) try { curBytes = fs.statSync(this.curSegment).size; } catch { /* not created yet */ }
    return { state: this.state, elapsedMs: this.activeMs + running, bytes: this.doneBytes + curBytes };
  }

  // ---- internals ----------------------------------------------------------
  _setState(s) { this.state = s; this.emit('state', s); }

  async _startSegment() {
    const n = this.segments.length;
    const seg = path.join(this.tmpDir, `seg-${String(n).padStart(3, '0')}.mkv`);
    if (this.plan.beforeSegment) await this.plan.beforeSegment(n);
    const pipes = [];
    this.sockets = [];
    this.servers = [];
    for (let t = 0; t < (this.plan.audioTracks || 0); t++) {
      const name = `${PIPE_PREFIX}${this.id}-${n}-a${t}`;
      const server = net.createServer((sock) => {
        sock.on('error', () => {});
        this.sockets[t] = sock;
      });
      await new Promise((res, rej) => { server.once('error', rej); server.listen(name, res); });
      this.servers.push(server);
      pipes.push(name);
    }

    const args = this.plan.buildArgs(seg, pipes);
    this.emit('log', `ffmpeg ${args.join(' ')}`);
    const proc = spawn(ffmpeg.getPath(), args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    this.proc = proc;
    this.curSegment = seg;
    this.segStart = Date.now();
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-16000);
      const s = String(d);
      if (/error|failed|invalid/i.test(s) && !/^frame=/.test(s.trim())) this.emit('log', s.trim());
    });
    proc.stdin.on('error', () => {});
    proc.on('error', (e) => { this.lastError = e.message; });
    proc.once('exit', (code) => {
      proc.exited = true;
      if (code !== 0 && !proc.stopRequested) {
        this.lastError = ffmpeg.lastError(stderr) || `ffmpeg exited with code ${code}`;
        // During start-up the failure is reported by start()/resume() throwing instead.
        if (proc.started) this.emit('failed', this.lastError);
      }
    });
    if (this.plan.priority && this.plan.priority !== 'normal') {
      try { require('os').setPriority(proc.pid, this.plan.priority === 'highest' ? -14 : -7); } catch { /* needs rights */ }
    }
    this.segments.push(seg);
    // Fail fast if ffmpeg can't even start (bad device, unsupported encoder...).
    await new Promise((r) => setTimeout(r, 400));
    if (proc.exited && !proc.stopRequested) throw new Error(this.lastError || 'Failed to start video capture.');
    proc.started = true;
    this.emit('segment', n);
  }

  async _endSegment() {
    const proc = this.proc;
    const sockets = this.sockets || [], servers = this.servers || [], seg = this.curSegment;
    // Pipe servers may exist even when ffmpeg never spawned (start failed early).
    if (!proc) { for (const s of servers) s.close(); this.servers = []; this.sockets = []; return; }
    this.proc = null;
    this.emit('segment-end');
    if (proc.started) this.activeMs += Date.now() - this.segStart;
    proc.stopRequested = true;
    if (!proc.exited) {
      try { proc.stdin.write('q'); } catch { /* already closing */ }
      await new Promise((resolve) => {
        const t = setTimeout(() => { try { proc.kill(); } catch { } resolve(); }, 8000);
        proc.once('exit', () => { clearTimeout(t); resolve(); });
        if (proc.exited) { clearTimeout(t); resolve(); }
      });
    }
    for (const s of sockets) s?.destroy();
    for (const s of servers) s.close();
    if (this.sockets === sockets) this.sockets = [];
    if (this.servers === servers) this.servers = [];
    try { this.doneBytes += fs.statSync(seg).size; } catch { /* empty */ }
    if (this.curSegment === seg) this.curSegment = null;
  }

  async _finalize() {
    const segs = this.segments.filter((s) => { try { return fs.statSync(s).size > 1024; } catch { return false; } });
    if (!segs.length) throw new Error(this.lastError || 'Nothing was recorded.');
    const { finalPath, container } = this.plan;
    const inputArgs = segs.length === 1 ? ['-i', segs[0]] : (() => {
      const list = path.join(this.tmpDir, 'concat.txt');
      fs.writeFileSync(list, segs.map((s) => `file '${s.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`).join('\n'));
      return ['-f', 'concat', '-safe', '0', '-i', list];
    })();
    const fmt = { mp4: ['-movflags', '+faststart'], avi: [], mkv: [], mp3: [], wav: [] }[container] || [];
    try {
      await ffmpeg.run(['-loglevel', 'error', ...inputArgs, '-map', '0', '-c', 'copy', ...fmt, finalPath]);
    } catch (e) {
      // Keep the recording no matter what: fall back to the (always playable) MKV.
      const rescue = finalPath.replace(/\.[^.]+$/, '') + '.mkv';
      await ffmpeg.run(['-loglevel', 'error', ...inputArgs, '-map', '0', '-c', 'copy', rescue]).catch(() => fs.copyFileSync(segs[0], rescue));
      this.emit('log', `Remux to ${container} failed (${e.message}); saved as MKV.`);
      return { file: rescue, rescued: true };
    }
    const extra = [];
    if (this.plan.splitTracks && this.plan.audioTracks) {
      for (let t = 0; t < this.plan.audioTracks; t++) {
        const out = finalPath.replace(/\.[^.]+$/, '') + `.${t + 1}.wav`;
        await ffmpeg.run(['-loglevel', 'error', '-i', finalPath, '-map', `0:a:${t}`, '-c:a', 'pcm_s16le', out]).then(() => extra.push(out)).catch(() => {});
      }
    }
    return { file: finalPath, extra };
  }

  // Device recordings arrive as one browser-encoded file; transcode it to the requested format.
  async _finalizeExternal(tmp) {
    if (!tmp || !fs.existsSync(tmp) || fs.statSync(tmp).size < 1024) throw new Error('Nothing was recorded.');
    const { finalPath } = this.plan;
    try {
      await ffmpeg.run(this.plan.external.transcodeArgs(tmp, finalPath));
      fs.rm(tmp, () => {});
      return { file: finalPath };
    } catch (e) {
      const rescue = finalPath.replace(/\.[^.]+$/, '') + '.webm';
      fs.renameSync(tmp, rescue);
      this.emit('log', `Transcode failed (${e.message}); kept the original as WebM.`);
      return { file: rescue, rescued: true };
    }
  }

  _cleanup() {
    try { fs.rmSync(this.tmpDir, { recursive: true, force: true }); } catch { /* in use */ }
    try { fs.rmdirSync(path.dirname(this.tmpDir)); } catch { /* not empty */ }
    this.segments = [];
    this.plan = null;
  }
}

module.exports = { Recorder };
