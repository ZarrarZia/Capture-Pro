// Hidden audio engine: system loopback + microphone → WebAudio graph → PCM over IPC.
const api = window.capturepro;
const GATE_DB = { off: 0, low: -60, medium: -50, high: -42 };

let ctx = null;
let streams = [];
let nodes = {};
let state = { mute: { speaker: false, mic: false }, micOpen: true, cfg: null };

function dbToLin(db) { return db === 0 ? 0 : Math.pow(10, db / 20); }

async function stop() {
  for (const s of streams) for (const t of s.getTracks()) t.stop();
  streams = [];
  nodes = {};
  if (ctx) { await ctx.close().catch(() => {}); ctx = null; }
}

function applyGains() {
  const { cfg, mute, micOpen } = state;
  if (!cfg || !ctx) return;
  const t = ctx.currentTime;
  if (nodes.speakerGain) nodes.speakerGain.gain.setTargetAtTime(mute.speaker ? 0 : cfg.speaker.volume / 100, t, 0.01);
  if (nodes.micGain) nodes.micGain.gain.setTargetAtTime(mute.mic || !micOpen ? 0 : cfg.mic.volume / 100, t, 0.01);
}

// Source → gain → (mono) chain; returns the last node.
function chain(source, gainNode, mono) {
  source.connect(gainNode);
  if (!mono) return gainNode;
  const down = new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
  gainNode.connect(down);
  return down;
}

function tap(track) {
  const node = new AudioWorkletNode(ctx, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
  node.port.onmessage = ({ data }) => api.audio.pcm(track, data.pcm);
  // Keep the node pulled by the graph without making any sound.
  const sink = new GainNode(ctx, { gain: 0 });
  node.connect(sink).connect(ctx.destination);
  return node;
}

function analyser(node) {
  const a = new AnalyserNode(ctx, { fftSize: 1024 });
  node.connect(a);
  return a;
}

function peakOf(a) {
  if (!a) return 0;
  const buf = new Float32Array(a.fftSize);
  a.getFloatTimeDomainData(buf);
  let m = 0;
  for (const v of buf) m = Math.max(m, Math.abs(v));
  return m;
}

async function start(cfg) {
  await stop();
  state = { ...state, cfg, mute: cfg.mute || state.mute, micOpen: cfg.micOpen !== false };
  ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('pcm-worklet.js');
  nodes = {};

  // Each source is optional: if one fails (mic busy, unplugged, blocked by Windows privacy settings)
  // the other is still recorded and the failure is reported as a warning.
  const warnings = [];
  let speakerOut = null, micOut = null;
  if (cfg.speaker) {
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      s.getVideoTracks().forEach((t) => t.stop());
      if (!s.getAudioTracks().length) throw new Error('system sound capture is not available');
      streams.push(s);
      nodes.speakerGain = new GainNode(ctx);
      speakerOut = chain(new MediaStreamAudioSourceNode(ctx, { mediaStream: s }), nodes.speakerGain, cfg.speaker.mono);
      nodes.speakerMeter = analyser(nodes.speakerGain);
    } catch (e) { warnings.push(`Computer sound is not being recorded (${e.message || e.name}).`); }
  }
  if (cfg.mic) {
    try {
      micOut = await openMic(cfg.mic);
    } catch (e) {
      // A saved device that no longer exists: fall back to the default microphone.
      if (cfg.mic.deviceId && cfg.mic.deviceId !== 'default') {
        try { micOut = await openMic({ ...cfg.mic, deviceId: 'default' }); warnings.push('The selected microphone was not found; using the default microphone.'); } catch { /* reported below */ }
      }
      if (!micOut) warnings.push(`Your microphone is not being recorded (${e.message || e.name}). Check Windows Settings → Privacy & security → Microphone.`);
    }
  }
  if (!speakerOut && !micOut) throw new Error(warnings.join(' ') || 'No sound device could be opened.');

  if (cfg.tracks === 2) {
    // Keep both tracks fed even if one source failed, so the file layout stays as configured.
    (speakerOut || silence()).connect(tap(0));
    (micOut || silence()).connect(tap(1));
  } else {
    const mix = tap(0);
    for (const o of [speakerOut, micOut]) if (o) o.connect(mix);
  }
  applyGains();
  await ctx.resume();
  return warnings;
}

function silence() { const s = new ConstantSourceNode(ctx, { offset: 0 }); s.start(); return s; }

async function openMic(mic) {
  const ns = mic.noiseSuppression && mic.noiseSuppression !== 'off';
  {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: mic.deviceId && mic.deviceId !== 'default' ? { exact: mic.deviceId } : undefined,
        noiseSuppression: ns, echoCancellation: false, autoGainControl: false, channelCount: 2,
      },
    });
    if (!s.getAudioTracks().length) throw new Error('no audio track');
    streams.push(s);
    let src = new MediaStreamAudioSourceNode(ctx, { mediaStream: s });
    if (ns) {
      const gate = new AudioWorkletNode(ctx, 'noise-gate');
      gate.parameters.get('threshold').value = dbToLin(GATE_DB[mic.noiseSuppression] || 0);
      src.connect(gate);
      src = gate;
    }
    nodes.micGain = new GainNode(ctx);
    const out = chain(src, nodes.micGain, mic.mono);
    nodes.micMeter = analyser(nodes.micGain);
    return out;
  }
}

api.audio.onStart(async (cfg) => {
  try {
    const warnings = await start(cfg);
    api.audio.started({ ok: true, warnings });
  } catch (e) {
    await stop();
    api.audio.started({ ok: false, error: e.message || String(e) });
  }
});
api.audio.onStop(() => stop());
api.audio.onSet((patch) => {
  if (patch.mute) state.mute = patch.mute;
  if (patch.micOpen !== undefined) state.micOpen = patch.micOpen;
  applyGains();
});

setInterval(() => {
  if (!ctx) return;
  api.audio.level({ speaker: peakOf(nodes.speakerMeter), mic: peakOf(nodes.micMeter) });
}, 100);
