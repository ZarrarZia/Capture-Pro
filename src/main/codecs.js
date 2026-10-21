// Codec catalogue and FFmpeg argument mapping (pure functions, unit-tested).

// Video codec families and the FFmpeg encoders that implement them, in auto-selection preference order.
const VIDEO_CODECS = {
  h264: { label: 'H.264', containers: ['mp4', 'avi', 'mkv'], encoders: { nvenc: 'h264_nvenc', qsv: 'h264_qsv', amf: 'h264_amf', cpu: 'libx264' } },
  hevc: { label: 'HEVC (H.265)', containers: ['mp4', 'mkv'], encoders: { nvenc: 'hevc_nvenc', qsv: 'hevc_qsv', amf: 'hevc_amf', cpu: 'libx265' } },
  av1: { label: 'AV1', containers: ['mp4', 'mkv'], encoders: { nvenc: 'av1_nvenc', qsv: 'av1_qsv', amf: 'av1_amf', cpu: 'libsvtav1' } },
  mpeg1: { label: 'MPEG-1', containers: ['avi', 'mkv'], encoders: { cpu: 'mpeg1video' } },
  xvid: { label: 'Xvid (MPEG-4 ASP)', containers: ['avi', 'mkv'], encoders: { cpu: 'mpeg4' } },
  mjpeg: { label: 'Motion JPEG', containers: ['avi', 'mkv'], encoders: { cpu: 'mjpeg' } },
};

// macOS: Apple's VideoToolbox hardware encoder (added only there, so Windows is unchanged).
if (process.platform === 'darwin') {
  VIDEO_CODECS.h264.encoders = { vt: 'h264_videotoolbox', ...VIDEO_CODECS.h264.encoders };
  VIDEO_CODECS.hevc.encoders = { vt: 'hevc_videotoolbox', ...VIDEO_CODECS.hevc.encoders };
}

const ENCODER_LABELS = { nvenc: 'NVIDIA NVENC', qsv: 'Intel Quick Sync', amf: 'AMD VCE/VCN', vt: 'Apple VideoToolbox', cpu: 'CPU' };
const HW_ORDER = process.platform === 'darwin' ? ['vt'] : ['nvenc', 'qsv', 'amf'];

const AUDIO_CODECS = {
  aac: { label: 'AAC', ff: 'aac', containers: ['mp4', 'mkv'] },
  mp3: { label: 'MP3', ff: 'libmp3lame', containers: ['mp4', 'avi', 'mkv', 'mp3'] },
  mp2: { label: 'MP2', ff: 'mp2', containers: ['avi', 'mkv'] },
  pcm: { label: 'PCM (uncompressed)', ff: 'pcm_s16le', containers: ['avi', 'mkv', 'wav'] },
};

// Built-in format presets (names and intents mirror the reference product; values are our own).
const BUILTIN_PRESETS = [
  { id: 'default', name: 'Default', video: { codec: 'h264', encoder: 'auto', fps: 30, size: 'full', rateControl: 'vbr', quality: 80 }, audio: { codec: 'aac', bitrate: 192 } },
  { id: 'half', name: 'Half Size', video: { size: 'half' } },
  { id: 'hevc60', name: 'HEVC, 60 FPS (hardware)', video: { codec: 'hevc', encoder: 'auto', fps: 60, quality: 80 } },
  { id: 'h264-60', name: 'H.264, 60 FPS (hardware)', video: { codec: 'h264', encoder: 'auto', fps: 60, quality: 80 } },
  { id: 'ultrafast60', name: 'Ultrafast setting for 60 FPS', video: { codec: 'h264', encoder: 'auto', fps: 60, quality: 70, optimize: 'speed' } },
  { id: 'lowend', name: 'Low-end PC', video: { codec: 'h264', encoder: 'auto', fps: 24, size: 'half', quality: 70, optimize: 'speed' } },
  { id: 'yt360', name: 'YouTube / X (360p)', video: { codec: 'h264', size: 'fitHeight', height: 360, fps: 30 } },
  { id: 'yt480', name: 'YouTube / X (480p)', video: { codec: 'h264', size: 'fitHeight', height: 480, fps: 30 } },
  { id: 'yt720', name: 'YouTube / X (720p)', video: { codec: 'h264', size: 'fitHeight', height: 720, fps: 30 } },
  { id: 'yt1080', name: 'YouTube / X (1080p)', video: { codec: 'h264', size: 'fitHeight', height: 1080, fps: 30 } },
  { id: 'edit', name: 'Editing (Premiere / Vegas / Resolve)', video: { container: 'avi', codec: 'mjpeg', quality: 90 }, audio: { codec: 'pcm' } },
  { id: 'ppt', name: 'PowerPoint', video: { container: 'mp4', codec: 'h264', fps: 30, quality: 75 } },
  { id: 'fw640', name: 'Fit Width, 640x0', video: { size: 'fitWidth', width: 640 } },
  { id: 'fw1280', name: 'Fit Width, 1280x0', video: { size: 'fitWidth', width: 1280 } },
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (lo, hi, q) => Math.round(lo + (hi - lo) * clamp(q, 0, 100) / 100);

// Picks the concrete encoder kind for a codec given detected availability.
function resolveEncoder(codec, wanted, available) {
  const fam = VIDEO_CODECS[codec];
  if (!fam) throw new Error(`Unknown video codec: ${codec}`);
  const ok = (kind) => fam.encoders[kind] && available.has(fam.encoders[kind]);
  if (wanted && wanted !== 'auto' && ok(wanted)) return wanted;
  for (const kind of HW_ORDER) if (ok(kind)) return kind;
  if (ok('cpu')) return 'cpu';
  throw new Error(`No available encoder for ${fam.label}`);
}

// Pixel format each encoder family expects from the filter graph.
function pixelFormat(ffEncoder) {
  if (/_(qsv|nvenc|amf|videotoolbox)$/.test(ffEncoder)) return 'nv12';
  if (ffEncoder === 'mjpeg') return 'yuvj420p';
  return 'yuv420p';
}

// Rate-control / quality / speed arguments for one encoder.
function videoEncoderArgs(ffEncoder, v) {
  const q = v.quality ?? 80;
  const fps = v.fps || 30;
  const gop = Math.max(1, Math.round(fps * (v.keyframeSec || 2)));
  const br = `${v.bitrate || 8000}k`;
  const cbr = v.rateControl === 'cbr';
  const opt = v.optimize || 'balanced';
  const args = ['-c:v', ffEncoder];

  switch (ffEncoder) {
    case 'libx264':
    case 'libx265': {
      const presets = { speed: 'ultrafast', balanced: 'veryfast', size: 'medium' };
      args.push('-preset', presets[opt]);
      if (cbr) args.push('-b:v', br, '-maxrate', br, '-bufsize', `${(v.bitrate || 8000) * 2}k`);
      else args.push('-crf', String(lerp(38, 14, q)));
      if (ffEncoder === 'libx265') args.push('-tag:v', 'hvc1');
      break;
    }
    case 'libsvtav1': {
      const presets = { speed: '12', balanced: '10', size: '7' };
      args.push('-preset', presets[opt]);
      if (cbr) args.push('-b:v', br); else args.push('-crf', String(lerp(55, 22, q)));
      break;
    }
    case 'h264_nvenc':
    case 'hevc_nvenc':
    case 'av1_nvenc': {
      const presets = { speed: 'p1', balanced: 'p4', size: 'p7' };
      args.push('-preset', presets[opt], '-tune', 'll');
      if (cbr) args.push('-rc', 'cbr', '-b:v', br);
      else args.push('-rc', 'vbr', '-cq', String(lerp(40, 16, q)), '-b:v', '0');
      if (ffEncoder === 'hevc_nvenc') args.push('-tag:v', 'hvc1');
      break;
    }
    case 'h264_qsv':
    case 'hevc_qsv':
    case 'av1_qsv': {
      const presets = { speed: 'veryfast', balanced: 'medium', size: 'veryslow' };
      args.push('-preset', presets[opt]);
      if (cbr) args.push('-b:v', br, '-maxrate', br);
      else args.push('-global_quality', String(lerp(40, 16, q)));
      if (ffEncoder === 'hevc_qsv') args.push('-tag:v', 'hvc1');
      break;
    }
    case 'h264_amf':
    case 'hevc_amf':
    case 'av1_amf': {
      const usage = { speed: 'ultralowlatency', balanced: 'lowlatency', size: 'transcoding' };
      args.push('-usage', usage[opt]);
      if (cbr) args.push('-rc', 'cbr', '-b:v', br);
      else { const qp = String(lerp(40, 16, q)); args.push('-rc', 'cqp', '-qp_i', qp, '-qp_p', qp); }
      if (ffEncoder === 'hevc_amf') args.push('-tag:v', 'hvc1');
      break;
    }
    case 'h264_videotoolbox':
    case 'hevc_videotoolbox': {
      // Bitrate-based: constant-quality mode only exists on Apple-silicon Macs.
      const kbps = cbr ? (v.bitrate || 8000) : lerp(2000, 24000, q);
      args.push('-b:v', `${kbps}k`, '-realtime', '1', '-allow_sw', '1');
      if (cbr) args.push('-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`);
      if (ffEncoder === 'hevc_videotoolbox') args.push('-tag:v', 'hvc1');
      break;
    }
    case 'mpeg1video':
    case 'mpeg4':
    case 'mjpeg':
      if (cbr) args.push('-b:v', br); else args.push('-q:v', String(lerp(31, 2, q)));
      if (ffEncoder === 'mpeg4') args.push('-vtag', 'XVID');
      break;
    default:
      throw new Error(`Unsupported encoder: ${ffEncoder}`);
  }
  if (ffEncoder !== 'mjpeg') args.push('-g', String(gop));
  return args;
}

// Output size filter: keeps dimensions even (required by 4:2:0 encoders).
function scaleFilter(v) {
  switch (v.size) {
    case 'half': return 'scale=trunc(iw/4)*2:trunc(ih/4)*2';
    case 'fitWidth': return `scale=${even(v.width || 1280)}:-2`;
    case 'fitHeight': return `scale=-2:${even(v.height || 720)}`;
    case 'custom': return `scale=${even(v.width || 1280)}:${even(v.height || 720)}`;
    default: return 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  }
}
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

function audioEncoderArgs(a, container) {
  let codec = a.codec || 'aac';
  if (!AUDIO_CODECS[codec].containers.includes(container)) codec = container === 'avi' ? 'mp3' : 'aac';
  const args = ['-c:a', AUDIO_CODECS[codec].ff];
  if (codec !== 'pcm') args.push('-b:a', `${a.bitrate || 192}k`);
  args.push('-ar', String(a.sampleRate || 48000), '-ac', String(a.channels || 2));
  return args;
}

module.exports = {
  VIDEO_CODECS, AUDIO_CODECS, ENCODER_LABELS, BUILTIN_PRESETS,
  resolveEncoder, pixelFormat, videoEncoderArgs, audioEncoderArgs, scaleFilter,
};
