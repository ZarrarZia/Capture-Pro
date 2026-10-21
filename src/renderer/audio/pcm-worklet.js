// Audio worklets for the capture engine.

// Collects interleaved stereo float32 PCM in 20 ms chunks and posts them (with the chunk's peak) to the main thread.
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = 960; // 20 ms @ 48 kHz
    this.buf = new Float32Array(this.frames * 2);
    this.pos = 0;
    this.peak = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const l = input[0], r = input[1] || input[0];
    const n = l ? l.length : 128;
    for (let i = 0; i < n; i++) {
      const a = l ? l[i] : 0, b = r ? r[i] : 0;
      this.buf[this.pos * 2] = a;
      this.buf[this.pos * 2 + 1] = b;
      const m = Math.max(Math.abs(a), Math.abs(b));
      if (m > this.peak) this.peak = m;
      if (++this.pos === this.frames) {
        this.port.postMessage({ pcm: this.buf.buffer, peak: this.peak }, [this.buf.buffer]);
        this.buf = new Float32Array(this.frames * 2);
        this.pos = 0;
        this.peak = 0;
      }
    }
    return true;
  }
}

// Simple noise gate: closes (with release smoothing) when the signal stays below the threshold.
class NoiseGate extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'threshold', defaultValue: 0 }]; }
  constructor() { super(); this.env = 0; this.gain = 1; }

  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    const th = params.threshold[0];
    const n = output[0].length;
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let c = 0; c < input.length; c++) m = Math.max(m, Math.abs(input[c][i]));
      this.env = Math.max(m, this.env * 0.9995);
      const target = th <= 0 || this.env >= th ? 1 : 0;
      this.gain += (target - this.gain) * (target ? 0.01 : 0.0005);
      for (let c = 0; c < output.length; c++) output[c][i] = (input[c] ? input[c][i] : 0) * this.gain;
    }
    return true;
  }
}

registerProcessor('pcm-tap', PcmTap);
registerProcessor('noise-gate', NoiseGate);
