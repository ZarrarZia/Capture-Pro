// Device recording window: live preview of a capture device and MediaRecorder-based recording.
const cp = window.capturepro;
const api = cp.device;
const $ = (id) => document.getElementById(id);
const video = $('video');
const FORMATS = [['', '(Auto-detect format)'], ['640x480@30', '640 × 480 · 30 fps'], ['1280x720@30', '1280 × 720 · 30 fps'], ['1280x720@60', '1280 × 720 · 60 fps'], ['1920x1080@30', '1920 × 1080 · 30 fps'], ['1920x1080@60', '1920 × 1080 · 60 fps'], ['3840x2160@30', '3840 × 2160 · 30 fps']];

let cfg = null;
let stream = null;
let recorder = null;

async function listDevices() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  const vids = devs.filter((d) => d.kind === 'videoinput');
  const auds = devs.filter((d) => d.kind === 'audioinput' && !['default', 'communications'].includes(d.deviceId));
  const fill = (sel, items, cur) => {
    sel.replaceChildren(...items.map(([v, l]) => Object.assign(document.createElement('option'), { value: v, textContent: l })));
    // Keep the saved choice when it still exists, otherwise fall back to the first entry.
    sel.value = items.some(([v]) => v === cur) ? cur : (items[0]?.[0] ?? '');
  };
  fill($('dev'), vids.length ? vids.map((d, i) => [d.deviceId, d.label || `Video device ${i + 1}`]) : [['', 'No video capture devices']], cfg.videoId);
  fill($('fmt'), FORMATS, cfg.format || '');
  fill($('aud'), [['none', '(No audio)'], ['default', '(Default input device)'], ...auds.map((d, i) => [d.deviceId, d.label || `Audio input ${i + 1}`])], cfg.audioId || 'none');
}

function previewTransform() {
  const rot = Number(cfg.rotate || 0);
  video.style.transform = `rotate(${rot}deg) scale(${cfg.flipH ? -1 : 1}, ${cfg.flipV ? -1 : 1})`;
}

async function open() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  const vid = $('dev').value;
  if (!vid) { $('msg').hidden = false; return; }
  const [res, fps] = ($('fmt').value || '').split('@');
  const [w, h] = (res || '').split('x').map(Number);
  const aud = $('aud').value;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: vid }, ...(w ? { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: Number(fps) } } : {}) },
      audio: aud === 'none' ? false : { deviceId: aud === 'default' ? undefined : { exact: aud }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    video.srcObject = stream;
    await video.play();
    $('msg').hidden = true;
  } catch (e) {
    $('msg').textContent = `Failed to initialize the video capture device.\n${e.message}`;
    $('msg').hidden = false;
  }
}

async function saveCfg(patch) {
  cfg = { ...cfg, ...patch };
  await cp.settings.update({ target: { device: patch } });
}

for (const [id, key] of [['dev', 'videoId'], ['fmt', 'format'], ['aud', 'audioId']]) {
  $(id).addEventListener('change', async (e) => {
    if (recorder) { e.target.value = cfg[key] ?? ''; return; }
    await saveCfg({ [key]: e.target.value });
    open();
  });
}
$('settings').onclick = () => { $('opts').hidden = !$('opts').hidden; };
$('o-deint').onchange = (e) => saveCfg({ deinterlace: e.target.value });
$('o-rot').onchange = (e) => { saveCfg({ rotate: Number(e.target.value) }); previewTransform(); };
$('o-fh').onchange = (e) => { saveCfg({ flipH: e.target.checked }); previewTransform(); };
$('o-fv').onchange = (e) => { saveCfg({ flipV: e.target.checked }); previewTransform(); };
$('zoom').onclick = () => api.zoom(video.videoWidth, video.videoHeight);
$('full').onclick = () => api.fullscreen();
$('shot').onclick = () => cp.image.capture();
$('rec').onclick = () => cp.rec.toggle();
$('pause').onclick = () => cp.rec.pause();
$('hide').onclick = () => api.hide();
video.addEventListener('dblclick', () => api.fullscreen());

api.onConfig(async (c) => {
  if (!c) { stream?.getTracks().forEach((t) => t.stop()); stream = null; return; }
  cfg = { ...c };
  $('o-deint').value = cfg.deinterlace || 'none';
  $('o-rot').value = String(cfg.rotate || 0);
  $('o-fh').checked = !!cfg.flipH;
  $('o-fv').checked = !!cfg.flipV;
  previewTransform();
  await refreshDevices();
});

// The capture service may not report devices immediately at startup: retry briefly, and refresh on changes.
async function refreshDevices(retries = 10) {
  if (!cfg || recorder) return;
  await listDevices();
  if (!$('dev').value && retries > 0) { setTimeout(() => refreshDevices(retries - 1), 700); return; }
  // Remember the device we fell back to (first available) so recording can start right away.
  if ($('dev').value && $('dev').value !== cfg.videoId) await saveCfg({ videoId: $('dev').value });
  if (!stream) open();
}
navigator.mediaDevices.addEventListener('devicechange', () => refreshDevices(3));
$('dev').addEventListener('focus', () => { if (!recorder) listDevices(); });

api.onRecord(({ on }) => {
  if (on === true) {
    if (!stream) return api.ack('recording', { error: 'Please select a video capture device.' });
    const mime = ['video/x-matroska;codecs=avc1,opus', 'video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 25_000_000, audioBitsPerSecond: 192_000 });
    // Chunks are forwarded strictly in order, and 'done' only after the last one has been sent.
    let flushed = Promise.resolve();
    recorder.ondataavailable = (e) => { if (e.data.size) flushed = flushed.then(async () => api.chunk(await e.data.arrayBuffer())); };
    recorder.onstop = () => { recorder = null; flushed.then(() => api.ack('recordDone', true)); };
    recorder.start(1000);
    api.ack('recording', true);
  } else if (on === false) recorder?.stop();
  else if (on === 'pause') recorder?.pause();
  else if (on === 'resume') recorder?.resume();
});

api.onSnapshot(() => {
  const c = document.createElement('canvas');
  const rot = Number(cfg?.rotate || 0), swap = rot === 90 || rot === 270;
  c.width = swap ? video.videoHeight : video.videoWidth;
  c.height = swap ? video.videoWidth : video.videoHeight;
  const g = c.getContext('2d');
  g.translate(c.width / 2, c.height / 2);
  g.rotate((rot * Math.PI) / 180);
  g.scale(cfg?.flipH ? -1 : 1, cfg?.flipV ? -1 : 1);
  g.drawImage(video, -video.videoWidth / 2, -video.videoHeight / 2);
  c.toBlob(async (b) => api.ack('snapshot', b ? await b.arrayBuffer() : { error: 'No video frame available.' }), 'image/png');
});

const fmt = (ms) => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
cp.rec.onStatus((st) => {
  const active = st.state !== 'idle';
  document.body.classList.toggle('recording', active);
  $('rec-label').textContent = active ? 'STOP' : 'REC';
  $('pause').disabled = !active;
  $('time').textContent = active ? fmt(st.elapsedMs) : '';
  for (const id of ['dev', 'fmt', 'aud']) $(id).disabled = active;
});
