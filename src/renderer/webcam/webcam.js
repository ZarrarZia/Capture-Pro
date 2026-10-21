// Webcam overlay: camera → canvas (shape clip, flip/rotate, chroma key, border). Recorded by the screen capture.
const api = window.capturepro.webcam;
const { SHAPES } = window.WebcamShapes;
const video = document.getElementById('cam');
const out = document.getElementById('out');
const ctx = out.getContext('2d');
const msg = document.getElementById('msg');
const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });

let cfg = null;
let stream = null;
let recorder = null;

function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

async function openCamera(c) {
  stream?.getTracks().forEach((t) => t.stop());
  const [w, h] = (c.format || '1280x720').split('x').map(Number);
  stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: c.deviceId && c.deviceId !== 'default' ? { exact: c.deviceId } : undefined, width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  api.cameraAspect(video.videoWidth / video.videoHeight);
}

function frame() {
  requestAnimationFrame(frame);
  if (!cfg || video.readyState < 2) return;
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(innerWidth * dpr), H = Math.round(innerHeight * dpr);
  if (out.width !== W || out.height !== H) { out.width = W; out.height = H; }
  const shape = SHAPES[cfg.shape] || SHAPES.original;
  const bw = cfg.border?.style === 'none' ? 0 : (cfg.border?.width || 0) * dpr;
  const path = shape.path(W - bw * 2, H - bw * 2);

  // Source frame with rotation/flip, cropped to fill the shape box ("cover").
  const rot = ((cfg.rotate || 0) % 360 + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const vw = video.videoWidth, vh = video.videoHeight;
  const srcW = swap ? vh : vw, srcH = swap ? vw : vh;
  const boxW = W - bw * 2, boxH = H - bw * 2;
  const scale = Math.max(boxW / srcW, boxH / srcH);
  if (work.width !== Math.round(boxW) || work.height !== Math.round(boxH)) { work.width = Math.round(boxW); work.height = Math.round(boxH); }
  wctx.save();
  wctx.clearRect(0, 0, work.width, work.height);
  wctx.translate(work.width / 2, work.height / 2);
  wctx.rotate((rot * Math.PI) / 180);
  wctx.scale(cfg.flip === 'horizontal' ? -1 : 1, cfg.flip === 'vertical' ? -1 : 1);
  wctx.drawImage(video, (-vw * scale) / 2, (-vh * scale) / 2, vw * scale, vh * scale);
  wctx.restore();

  if (cfg.background?.mode === 'chroma') chromaKey();

  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.translate(bw, bw);
  if (bw && cfg.border.style === 'faded') { ctx.shadowColor = cfg.border.color || '#fff'; ctx.shadowBlur = bw * 2; }
  if (bw && cfg.border.style === 'solid') { ctx.lineWidth = bw * 2; ctx.strokeStyle = cfg.border.color || '#fff'; ctx.lineJoin = 'round'; ctx.stroke(path); }
  ctx.fillStyle = 'rgba(0,0,0,0.01)';
  ctx.fill(path);
  ctx.shadowBlur = 0;
  ctx.clip(path);
  ctx.drawImage(work, 0, 0);
  ctx.restore();
}

// Removes pixels close to the key colour (similarity) with a soft edge (blend).
function chromaKey() {
  const ck = cfg.background.chroma || {};
  const [kr, kg, kb] = hexToRgb(ck.color || '#00ff00');
  const sim = ((ck.similarity ?? 40) / 100) * 255 * 1.2;
  const blend = Math.max(1, ((ck.blend ?? 10) / 100) * 255);
  const img = wctx.getImageData(0, 0, work.width, work.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const dist = Math.hypot(d[i] - kr, d[i + 1] - kg, d[i + 2] - kb);
    if (dist < sim) d[i + 3] = 0;
    else if (dist < sim + blend) d[i + 3] = Math.round(255 * ((dist - sim) / blend));
  }
  wctx.putImageData(img, 0, 0);
}

// Drag moves the overlay (pointer-driven so the wheel still reaches us); wheel resizes it.
let drag = null;
window.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  drag = { sx: e.screenX, sy: e.screenY };
  document.body.setPointerCapture(e.pointerId);
  api.dragStart();
});
window.addEventListener('pointermove', (e) => { if (drag) api.dragMove(e.screenX - drag.sx, e.screenY - drag.sy); });
window.addEventListener('pointerup', () => { if (drag) { drag = null; api.dragEnd(); } });
window.addEventListener('wheel', (e) => api.resize(e.deltaY < 0 ? 1 : -1), { passive: true });

api.onConfig(async (c) => {
  const camChanged = !cfg || cfg.deviceId !== c.deviceId || cfg.format !== c.format;
  cfg = c;
  if (camChanged) {
    try { msg.hidden = true; await openCamera(c); } catch (e) {
      msg.textContent = `Webcam unavailable\n${e.message}`;
      msg.hidden = false;
    }
  }
});

// Separate webcam recording ("Save webcam recording as MP4").
api.onRecord(({ on }) => {
  if (on === true && stream && !recorder) {
    const mime = ['video/webm;codecs=h264', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
    recorder.ondataavailable = async (e) => { if (e.data.size) api.chunk(await e.data.arrayBuffer()); };
    recorder.onstop = () => { api.recordDone(); recorder = null; };
    recorder.start(1000);
  } else if (on === false && recorder) {
    recorder.stop();
  } else if (on === 'pause') recorder?.pause();
  else if (on === 'resume') recorder?.resume();
});

requestAnimationFrame(frame);
