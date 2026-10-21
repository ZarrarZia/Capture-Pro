// Builds the ffmpeg command line for one recording segment (pure; unit-tested).
//
// job = {
//   source: { kind: 'wgc-monitor', hmonitor, crop? {left,top,right,bottom} }
//         | { kind: 'wgc-window', hwnd }
//         | { kind: 'dda', outputIdx, region? {x,y,w,h} }       // region relative to that monitor
//         | { kind: 'gdi', region {x,y,w,h} }                    // virtual-desktop coordinates
//         | null                                                 // audio only
//   showCursor, video (settings.video), audio (settings.audio), ffEncoder,
//   audioPipes: [path, path?], container (final container), logo?, texts?, output
// }
const { pixelFormat, videoEncoderArgs, audioEncoderArgs, scaleFilter } = require('./codecs');

const FONT_FILES = {
  'Arial': 'arial.ttf', 'Arial Black': 'ariblk.ttf', 'Calibri': 'calibri.ttf', 'Cambria': 'cambria.ttc',
  'Comic Sans MS': 'comic.ttf', 'Consolas': 'consola.ttf', 'Courier New': 'cour.ttf', 'Georgia': 'georgia.ttf',
  'Impact': 'impact.ttf', 'Segoe UI': 'segoeui.ttf', 'Tahoma': 'tahoma.ttf', 'Times New Roman': 'times.ttf',
  'Trebuchet MS': 'trebuc.ttf', 'Verdana': 'verdana.ttf',
};

// Quote a value for an ffmpeg filter argument (single quotes; embedded quotes closed/escaped/reopened).
const q = (s) => `'${String(s).replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;

function positionExpr(pos, mx, my, w, h, W = 'W', H = 'H') {
  const [v, hz] = (pos || 'top-right').split('-');
  const x = hz === 'left' ? `${mx}` : hz === 'center' ? `(${W}-${w})/2` : `${W}-${w}-${mx}`;
  const y = v === 'top' ? `${my}` : v === 'middle' ? `(${H}-${h})/2` : `${H}-${h}-${my}`;
  return { x, y };
}

function sourceFilter(src, fps, showCursor, vfr) {
  const cursor = showCursor ? 1 : 0;
  switch (src.kind) {
    case 'wgc-monitor': {
      const c = src.crop || {};
      const crop = ['left', 'top', 'right', 'bottom'].filter((k) => c[k] > 0).map((k) => `:crop_${k}=${Math.round(c[k])}`).join('');
      return `gfxcapture=hmonitor=${src.hmonitor}:max_framerate=${fps}:capture_cursor=${cursor}${crop},hwdownload,format=bgra`;
    }
    case 'wgc-window':
      return `gfxcapture=hwnd=${src.hwnd}:max_framerate=${fps}:capture_cursor=${cursor}:capture_border=0,hwdownload,format=bgra`;
    case 'dda': {
      const r = src.region;
      const reg = r ? `:offset_x=${r.x}:offset_y=${r.y}:video_size=${r.w}x${r.h}` : '';
      return `ddagrab=output_idx=${src.outputIdx}:framerate=${fps}:draw_mouse=${cursor}:dup_frames=${vfr ? 0 : 1}${reg},hwdownload,format=bgra`;
    }
    default:
      return null;
  }
}

function buildRecordArgs(job) {
  const { video: v = {}, audio: a = {}, source } = job;
  const fps = v.fps || 30;
  const vfr = v.fpsMode !== 'cfr';
  const inputs = [];
  const chains = [];
  let vIn = null;

  // Video source: filter sources live in the filter graph; gdigrab is a regular input.
  if (source) {
    let sf = sourceFilter(source, fps, job.showCursor, vfr);
    // "Around mouse": a crop window moved at runtime through ffmpeg's zmq filter.
    if (sf && job.follow) {
      const f = job.follow;
      sf += `,zmq=b=tcp\\\\://127.0.0.1\\\\:${f.port},crop@follow=w=${f.w}:h=${f.h}:x=${f.x}:y=${f.y}`;
    }
    if (sf) {
      chains.push(`${sf}[src]`);
      vIn = '[src]';
    } else if (source.kind === 'gdi') {
      const r = source.region;
      inputs.push(['-thread_queue_size', '512', '-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', job.showCursor ? '1' : '0',
        '-offset_x', String(r.x), '-offset_y', String(r.y), '-video_size', `${r.w}x${r.h}`, '-i', 'desktop']);
      vIn = '[0:v]';
    } else {
      throw new Error(`Unknown capture source: ${source.kind}`);
    }
  }

  const audioIdx = [];
  for (const pipe of job.audioPipes || []) {
    audioIdx.push(inputs.length);
    inputs.push(['-thread_queue_size', '1024', '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', pipe]);
  }

  if (vIn) {
    let cur = vIn;
    const steps = [];
    if (!vfr) steps.push(`fps=${fps}`);
    steps.push(scaleFilter(v));
    chains.push(`${cur}${steps.join(',')}[scaled]`);
    cur = '[scaled]';

    const logo = job.logo;
    if (logo && logo.image) {
      const li = inputs.length;
      inputs.push(['-loop', '1', '-i', logo.image]);
      const alpha = Math.max(0, Math.min(100, logo.opacity ?? 100)) / 100;
      const { x, y } = positionExpr(logo.position, logo.marginX ?? 16, logo.marginY ?? 16, 'w', 'h');
      chains.push(`[${li}:v]format=rgba,colorchannelmixer=aa=${alpha}[logo]`);
      chains.push(`${cur}[logo]overlay=x=${x}:y=${y}:shortest=1:format=auto[logoed]`);
      cur = '[logoed]';
    }

    const texts = (job.texts || []).filter((t) => t.textFile);
    if (texts.length) {
      const dt = texts.map((t) => {
        const font = `C:/Windows/Fonts/${FONT_FILES[t.font] || 'arial.ttf'}`;
        const m = t.margin ?? 16;
        const { x, y } = positionExpr(t.position || 'top-left', m, m, 'text_w', 'text_h', 'w', 'h');
        const alpha = Math.max(0, Math.min(100, t.alpha ?? 100)) / 100;
        let f = `drawtext=fontfile=${q(font)}:textfile=${q(t.textFile)}:expansion=normal:fontsize=${t.size || 32}` +
          `:fontcolor=${(t.color || '#ffffff').replace('#', '0x')}@${alpha}:x=${x}:y=${y}`;
        if (t.shadow) f += `:shadowcolor=${(t.shadowColor || '#000000').replace('#', '0x')}@${alpha}:shadowx=2:shadowy=2`;
        if (t.outline) f += `:borderw=2:bordercolor=${(t.outlineColor || '#000000').replace('#', '0x')}@${alpha}`;
        return f;
      });
      chains.push(`${cur}${dt.join(',')}[texted]`);
      cur = '[texted]';
    }

    chains.push(`${cur}format=${pixelFormat(job.ffEncoder)}[vout]`);
  }

  const args = ['-hide_banner', '-loglevel', 'error', '-stats', '-stats_period', '1', '-y'];
  for (const i of inputs) args.push(...i);
  if (chains.length) args.push('-filter_complex', chains.join(';'));
  if (vIn) {
    args.push('-map', '[vout]', ...videoEncoderArgs(job.ffEncoder, v));
    if (vfr) args.push('-fps_mode', 'vfr');
  }
  for (const i of audioIdx) args.push('-map', `${i}:a`);
  if (audioIdx.length) args.push(...audioEncoderArgs(a, job.container || 'mkv'));
  args.push('-f', job.format || 'matroska', job.output);
  return args;
}

// Single-frame screenshot: job = { source, showCursor, format ('png'|'jpg'|'bmp'), jpgQuality, logo?, output }
function buildImageArgs(job) {
  const inputs = [];
  const chains = [];
  let cur;
  const sf = sourceFilter(job.source, 30, job.showCursor, false);
  if (sf) { chains.push(`${sf}[src]`); cur = '[src]'; } else {
    const r = job.source.region;
    inputs.push(['-f', 'gdigrab', '-draw_mouse', job.showCursor ? '1' : '0', '-offset_x', String(r.x), '-offset_y', String(r.y), '-video_size', `${r.w}x${r.h}`, '-i', 'desktop']);
    cur = '[0:v]';
  }
  const logo = job.logo;
  if (logo && logo.image) {
    const li = inputs.length;
    inputs.push(['-i', logo.image]);
    const { x, y } = positionExpr(logo.position, logo.marginX ?? 16, logo.marginY ?? 16, 'w', 'h');
    chains.push(`[${li}:v]format=rgba,colorchannelmixer=aa=${Math.max(0, Math.min(100, logo.opacity ?? 100)) / 100}[logo]`);
    chains.push(`${cur}[logo]overlay=x=${x}:y=${y}[ov]`);
    cur = '[ov]';
  }
  const pix = { jpg: 'yuvj444p', bmp: 'bgr24', png: 'rgb24' }[job.format] || 'rgb24';
  chains.push(`${cur}format=${pix}[img]`);
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const i of inputs) args.push(...i);
  args.push('-filter_complex', chains.join(';'), '-map', '[img]', '-frames:v', '1');
  if (job.format === 'jpg') args.push('-q:v', String(Math.round(31 - 29 * Math.max(20, Math.min(100, job.jpgQuality || 90)) / 100)));
  args.push('-update', '1', job.output);
  return args;
}

// Writes drawtext's textfile content, translating {date}/{time}/{datetime} macros.
function textFileContent(text) {
  return String(text)
    .replace(/\\/g, '\\\\').replace(/%/g, '\\%')
    .replace(/\{datetime\}/g, '%{localtime:%Y-%m-%d %H\\:%M\\:%S}')
    .replace(/\{date\}/g, '%{localtime:%Y-%m-%d}')
    .replace(/\{time\}/g, '%{localtime:%H\\:%M\\:%S}');
}

module.exports = { buildRecordArgs, buildImageArgs, textFileContent, positionExpr, FONT_FILES };
