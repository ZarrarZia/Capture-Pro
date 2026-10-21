// Capture frame for Rectangle mode: move (bar drag), resize (handles), size presets, record controls.
const api = window.capturepro;
const $ = (id) => document.getElementById(id);
const frame = $('frame');
const BAR = 34, BORDER = 3;
const SIZES = [[640, 360], [854, 480], [1280, 720], [1600, 900], [1920, 1080], [2560, 1440], null, [640, 480], [800, 600], [1024, 768], [1280, 960]];

let physical = { w: 0, h: 0 };
let scale = 1;
let state = 'idle';

// Click-through everywhere except the bar, handles and menu.
let ignoring = null;
window.addEventListener('mousemove', (e) => {
  const passThrough = e.target === document.body || e.target.id === 'hole' || e.target.id === 'frame';
  if (passThrough !== ignoring && !dragging) { ignoring = passThrough; api.rect.ignoreMouse(passThrough); }
});

api.rect.onInfo(({ dip, physical: p }) => {
  physical = p;
  scale = p.w / Math.max(1, dip.w);
  $('size').textContent = `${p.w} × ${p.h}`;
});

// ---- resize
let dragging = null;
for (const h of document.querySelectorAll('.h')) {
  h.addEventListener('pointerdown', async (e) => {
    h.setPointerCapture(e.pointerId);
    const b = await api.rect.getBounds();
    dragging = { edge: h.dataset.e, sx: e.screenX, sy: e.screenY, r: { x: b.x + BORDER, y: b.y + BORDER + BAR, w: b.width - BORDER * 2, h: b.height - BORDER * 2 - BAR } };
  });
  h.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const { edge, sx, sy, r } = dragging;
    const dx = e.screenX - sx, dy = e.screenY - sy;
    const n = { ...r };
    if (edge.includes('e')) n.w = r.w + dx;
    if (edge.includes('s')) n.h = r.h + dy;
    if (edge.includes('w')) { n.x = r.x + dx; n.w = r.w - dx; }
    if (edge.includes('n')) { n.y = r.y + dy; n.h = r.h - dy; }
    if (n.w < 64 || n.h < 48) return;
    schedule(n);
  });
  h.addEventListener('pointerup', () => { dragging = null; });
}

let pending = null;
function schedule(r) {
  const first = !pending;
  pending = r;
  if (first) requestAnimationFrame(() => { api.rect.setInterior(pending); pending = null; });
}

// ---- size menu
const menu = $('menu');
$('size').addEventListener('click', () => {
  if (state !== 'idle') return;
  menu.replaceChildren(...SIZES.map((s) => {
    if (!s) return document.createElement('hr');
    const b = document.createElement('button');
    b.textContent = `${s[0]} × ${s[1]}`;
    b.onclick = () => { api.rect.setSize(s[0], s[1]); menu.hidden = true; };
    return b;
  }));
  menu.hidden = !menu.hidden;
});
window.addEventListener('blur', () => { menu.hidden = true; });

function fitRatio(rw, rh) {
  const w = physical.w, h = Math.round(w * rh / rw);
  api.rect.setSize(w, h);
}
$('fit169').onclick = () => fitRatio(16, 9);
$('fit43').onclick = () => fitRatio(4, 3);
$('full').onclick = () => api.rect.fullscreen();
$('shot').onclick = () => api.image.capture();
$('rec').onclick = () => api.rec.toggle();
$('pause').onclick = () => api.rec.pause();
$('hide').onclick = () => api.rect.hide();

// ---- keyboard nudging (arrows move, Shift+arrows resize)
window.addEventListener('keydown', async (e) => {
  if (state !== 'idle' || !e.key.startsWith('Arrow')) return;
  const b = await api.rect.getBounds();
  const r = { x: b.x + BORDER, y: b.y + BORDER + BAR, w: b.width - BORDER * 2, h: b.height - BORDER * 2 - BAR };
  const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (e.shiftKey) { r.w += d[0]; r.h += d[1]; } else { r.x += d[0]; r.y += d[1]; }
  api.rect.setInterior(r);
});

// ---- status
const fmt = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
api.rec.onStatus((st) => {
  state = st.state;
  const active = state !== 'idle';
  frame.classList.toggle('recording', active);
  frame.classList.toggle('paused', state === 'paused');
  document.body.classList.toggle('locked', active);
  frame.classList.toggle('locked', active);
  $('pause').disabled = !active;
  $('rec').querySelector('.label').textContent = active ? 'STOP' : 'REC';
  $('time').textContent = active ? fmt(st.elapsedMs) : '';
});
