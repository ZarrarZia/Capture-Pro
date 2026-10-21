// Capture-visible overlay: click effects, cursor highlight, keystrokes, countdown and drawing.
const api = window.capturepro.overlay;
const fx = document.getElementById('fx');
const draw = document.getElementById('draw');
const fctx = fx.getContext('2d');
const dctx = draw.getContext('2d');
const keysEl = document.getElementById('keys');
const countdownEl = document.getElementById('countdown');
const textInput = document.getElementById('text-input');

let cfg = { mouse: {}, keystroke: {}, region: null, display: { bounds: { x: 0, y: 0 } } };
let ripples = [];
let cursor = null;
let rafOn = false;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  for (const c of [fx, draw]) { c.width = innerWidth * dpr; c.height = innerHeight * dpr; c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0); }
  redraw();
}
window.addEventListener('resize', resize);

// Capture region in this display's local DIP coordinates (whole display when none).
function localRegion() {
  const b = cfg.display.bounds;
  const r = cfg.region;
  return r ? { x: r.x - b.x, y: r.y - b.y, w: r.w, h: r.h } : { x: 0, y: 0, w: innerWidth, h: innerHeight };
}

// ------------------------------------------------------------ effects loop
function loop() {
  const now = performance.now();
  fctx.clearRect(0, 0, innerWidth, innerHeight);
  const m = cfg.mouse || {};
  if (m.highlight && cursor) {
    fctx.globalAlpha = (m.highlightOpacity ?? 35) / 100;
    fctx.fillStyle = m.highlightColor || '#ffff00';
    fctx.beginPath(); fctx.arc(cursor.x, cursor.y, (m.highlightSize || 60) / 2, 0, Math.PI * 2); fctx.fill();
    fctx.globalAlpha = 1;
  }
  ripples = ripples.filter((r) => now - r.t < 450);
  for (const r of ripples) {
    const p = (now - r.t) / 450;
    const rad = (r.size / 2) * (0.35 + 0.65 * p);
    fctx.globalAlpha = 1 - p;
    fctx.strokeStyle = r.color; fctx.lineWidth = 3 + 3 * (1 - p);
    fctx.beginPath(); fctx.arc(r.x, r.y, rad, 0, Math.PI * 2); fctx.stroke();
    fctx.fillStyle = r.color; fctx.globalAlpha = 0.25 * (1 - p);
    fctx.beginPath(); fctx.arc(r.x, r.y, rad * 0.6, 0, Math.PI * 2); fctx.fill();
  }
  fctx.globalAlpha = 1;
  if (ripples.length || (m.highlight && cursor)) requestAnimationFrame(loop); else { rafOn = false; fctx.clearRect(0, 0, innerWidth, innerHeight); }
}
function kick() { if (!rafOn) { rafOn = true; requestAnimationFrame(loop); } }

api.onMouse((e) => {
  const m = cfg.mouse || {};
  if (e.type !== 'down' || !m.clickEffect || drawing.enabled) return;
  ripples.push({ x: e.x, y: e.y, t: performance.now(), size: m.clickSize || 40, color: e.btn === 'right' ? m.rightColor : m.leftColor });
  kick();
});
api.onCursor((p) => { cursor = p; if (p) kick(); });

// ------------------------------------------------------------ keystrokes
const KEY_FONT = { small: 16, medium: 22, large: 32 };
function placeKeys() {
  const r = localRegion();
  const pos = cfg.keystroke?.position || 'bottom-center';
  const [v, h] = pos.split('-');
  keysEl.style.fontSize = `${KEY_FONT[cfg.keystroke?.size] || 22}px`;
  keysEl.style.left = h === 'left' ? `${r.x + 24}px` : h === 'right' ? '' : `${r.x + r.w / 2}px`;
  keysEl.style.right = h === 'right' ? `${innerWidth - (r.x + r.w) + 24}px` : '';
  keysEl.style.transform = h === 'center' ? 'translateX(-50%)' : '';
  keysEl.style.top = v === 'top' ? `${r.y + 24}px` : '';
  keysEl.style.bottom = v === 'bottom' ? `${innerHeight - (r.y + r.h) + 32}px` : '';
  keysEl.style.alignItems = h === 'left' ? 'flex-start' : h === 'right' ? 'flex-end' : 'center';
}
api.onKey(({ text }) => {
  if (!cfg.keystroke?.enabled || !text) return;
  const el = document.createElement('div');
  el.className = 'key';
  el.textContent = text;
  keysEl.append(el);
  while (keysEl.children.length > 3) keysEl.firstChild.remove();
  setTimeout(() => el.classList.add('fade'), 1400);
  setTimeout(() => el.remove(), 1850);
});

// ------------------------------------------------------------ countdown
api.onCountdown(({ n }) => {
  if (!n) { countdownEl.hidden = true; return; }
  const r = localRegion();
  countdownEl.style.left = `${r.x + r.w / 2}px`;
  countdownEl.style.top = `${r.y + r.h / 2}px`;
  countdownEl.textContent = n;
  countdownEl.hidden = !(cfg.region === null || (r.x + r.w > 0 && r.x < innerWidth && r.y + r.h > 0 && r.y < innerHeight));
});

// ------------------------------------------------------------ drawing
const drawing = { enabled: false, tool: 'pen', color: '#ff3b48', width: 4, whiteboard: false, shapes: [], redo: [], number: 1, cur: null };

function redraw() {
  dctx.clearRect(0, 0, innerWidth, innerHeight);
  if (drawing.whiteboard) { dctx.fillStyle = '#ffffff'; dctx.fillRect(0, 0, innerWidth, innerHeight); }
  for (const s of drawing.shapes) paint(s);
  if (drawing.cur) paint(drawing.cur);
}

function paint(s) {
  dctx.save();
  dctx.lineCap = 'round'; dctx.lineJoin = 'round';
  dctx.strokeStyle = s.color; dctx.fillStyle = s.color; dctx.lineWidth = s.width;
  if (s.tool === 'highlighter') { dctx.globalAlpha = 0.35; dctx.lineWidth = s.width * 4; }
  if (s.tool === 'eraser') { dctx.globalCompositeOperation = 'destination-out'; dctx.lineWidth = s.width * 5; }
  const [a, b] = [s.pts[0], s.pts[s.pts.length - 1]];
  switch (s.tool) {
    case 'pen': case 'highlighter': case 'eraser':
      dctx.beginPath(); s.pts.forEach((p, i) => (i ? dctx.lineTo(p.x, p.y) : dctx.moveTo(p.x, p.y))); dctx.stroke();
      if (s.tool === 'eraser' && drawing.whiteboard) { dctx.globalCompositeOperation = 'source-over'; dctx.strokeStyle = '#fff'; dctx.stroke(); }
      break;
    case 'line': dctx.beginPath(); dctx.moveTo(a.x, a.y); dctx.lineTo(b.x, b.y); dctx.stroke(); break;
    case 'arrow': {
      const ang = Math.atan2(b.y - a.y, b.x - a.x), head = 10 + s.width * 3;
      dctx.beginPath(); dctx.moveTo(a.x, a.y); dctx.lineTo(b.x, b.y); dctx.stroke();
      dctx.beginPath(); dctx.moveTo(b.x, b.y);
      dctx.lineTo(b.x - head * Math.cos(ang - 0.45), b.y - head * Math.sin(ang - 0.45));
      dctx.lineTo(b.x - head * Math.cos(ang + 0.45), b.y - head * Math.sin(ang + 0.45));
      dctx.closePath(); dctx.fill();
      break;
    }
    case 'box': dctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)); break;
    case 'ellipse':
      dctx.beginPath(); dctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2); dctx.stroke();
      break;
    case 'number': {
      const r = 12 + s.width * 2;
      dctx.beginPath(); dctx.arc(a.x, a.y, r, 0, Math.PI * 2); dctx.fill();
      dctx.fillStyle = '#fff'; dctx.font = `700 ${Math.round(r * 1.1)}px Segoe UI`; dctx.textAlign = 'center'; dctx.textBaseline = 'middle';
      dctx.fillText(String(s.n), a.x, a.y + 1);
      break;
    }
    case 'text':
      dctx.font = `600 ${12 + s.width * 4}px Segoe UI`; dctx.textBaseline = 'top'; dctx.fillText(s.text, a.x, a.y);
      break;
  }
  dctx.restore();
}

function commit(shape) { drawing.shapes.push(shape); drawing.redo = []; drawing.cur = null; redraw(); }

draw.style.pointerEvents = 'none';
window.addEventListener('pointerdown', (e) => {
  if (!drawing.enabled || drawing.tool === 'cursor' || e.button !== 0) return;
  const p = { x: e.clientX, y: e.clientY };
  const base = { tool: drawing.tool, color: drawing.color, width: drawing.width, pts: [p] };
  if (drawing.tool === 'number') { commit({ ...base, n: drawing.number++ }); return; }
  if (drawing.tool === 'text') { startText(p); return; }
  drawing.cur = base;
  e.target.setPointerCapture?.(e.pointerId);
});
window.addEventListener('pointermove', (e) => {
  if (!drawing.cur) return;
  const p = { x: e.clientX, y: e.clientY };
  if (['pen', 'highlighter', 'eraser'].includes(drawing.cur.tool)) drawing.cur.pts.push(p); else drawing.cur.pts[1] = p;
  redraw();
});
window.addEventListener('pointerup', () => { if (drawing.cur) commit(drawing.cur); });

function startText(p) {
  textInput.hidden = false;
  textInput.value = '';
  textInput.style.left = `${p.x}px`; textInput.style.top = `${p.y}px`;
  textInput.style.color = drawing.color; textInput.style.font = `600 ${12 + drawing.width * 4}px Segoe UI`;
  setTimeout(() => textInput.focus(), 0);
  const done = (keep) => {
    textInput.onkeydown = textInput.onblur = null;
    textInput.hidden = true;
    if (keep && textInput.value.trim()) commit({ tool: 'text', color: drawing.color, width: drawing.width, pts: [p], text: textInput.value });
  };
  textInput.onkeydown = (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
  textInput.onblur = () => done(true);
}

api.onDraw((d) => {
  Object.assign(drawing, d);
  document.body.classList.toggle('drawing', drawing.enabled && drawing.tool !== 'cursor');
  redraw();
});
api.onDrawCmd((cmd) => {
  if (cmd === 'undo' && drawing.shapes.length) drawing.redo.push(drawing.shapes.pop());
  if (cmd === 'redo' && drawing.redo.length) drawing.shapes.push(drawing.redo.pop());
  if (cmd === 'clear') { drawing.shapes = []; drawing.redo = []; drawing.number = 1; }
  redraw();
});
window.addEventListener('keydown', (e) => {
  if (!drawing.enabled || !textInput.hidden) return;
  if (e.key === 'Escape') { api.drawCmd('exit'); return; } // never trap the user in drawing mode
  if (e.ctrlKey && e.key.toLowerCase() === 'z') api.drawCmd('undo');
  if (e.ctrlKey && e.key.toLowerCase() === 'y') api.drawCmd('redo');
});

api.onConfig((c) => { cfg = { ...cfg, ...c }; placeKeys(); kick(); });
resize();
