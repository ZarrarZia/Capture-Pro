// Drawing toolbar (excluded from capture). Tool state is pushed to the overlays through the main process.
const api = window.capturepro.overlay;
const TOOLS = [
  ['cursor', 'Cursor – no drawing (C)', 'c', '<path d="M5 3l10 6-4.5 1.2L9 15z"/>'],
  ['pen', 'Pen (P)', 'p', '<path d="M4 16l1-4 8-8 3 3-8 8z"/><path d="M11 6l3 3"/>'],
  ['highlighter', 'Highlighter (H)', 'h', '<path d="M6 13l6-9 4 3-6 9H6z"/><path d="M4 17h8"/>'],
  ['line', 'Line (L)', 'l', '<path d="M4 16L16 4"/>'],
  ['arrow', 'Arrow (A)', 'a', '<path d="M4 16L16 4M9 4h7v7"/>'],
  ['box', 'Box (B)', 'b', '<rect x="4" y="5" width="12" height="10" rx="1"/>'],
  ['ellipse', 'Ellipse (E)', 'e', '<ellipse cx="10" cy="10" rx="7" ry="5"/>'],
  ['number', 'Numbering (N)', 'n', '<circle cx="10" cy="10" r="7"/><path d="M9 7.5l1.5-1v7"/>'],
  ['text', 'Text (T)', 't', '<path d="M4 5h12M10 5v11"/>'],
  ['eraser', 'Eraser (X)', 'x', '<path d="M8 16l-4-4 7-7 5 5-6 6zM8 16h8"/>'],
];
const COLORS = ['#ff3b48', '#ffd400', '#2ecc8f', '#3d8bff', '#ffffff', '#11141b'];
const state = { tool: 'pen', color: COLORS[0], width: 4, whiteboard: false };

const tools = document.getElementById('tools');
tools.innerHTML = TOOLS.map(([id, title, , svg]) => `<button data-tool="${id}" title="${title}"><svg viewBox="0 0 20 20">${svg}</svg></button>`).join('');
const colors = document.getElementById('colors');
colors.innerHTML = COLORS.map((c) => `<button class="swatch" data-color="${c}" title="${c}"></button>`).join('');
for (const b of colors.children) b.style.background = b.dataset.color;

function push() {
  for (const b of tools.children) b.classList.toggle('on', b.dataset.tool === state.tool);
  for (const b of colors.children) b.classList.toggle('on', b.dataset.color === state.color);
  document.getElementById('whiteboard').classList.toggle('on', state.whiteboard);
  api.setDraw({ ...state });
}

tools.addEventListener('click', (e) => { const b = e.target.closest('[data-tool]'); if (b) { state.tool = b.dataset.tool; push(); } });
colors.addEventListener('click', (e) => { const b = e.target.closest('[data-color]'); if (b) { state.color = b.dataset.color; push(); } });
document.getElementById('width').addEventListener('input', (e) => { state.width = Number(e.target.value); push(); });
document.getElementById('whiteboard').onclick = () => { state.whiteboard = !state.whiteboard; push(); };
document.getElementById('undo').onclick = () => api.drawCmd('undo');
document.getElementById('redo').onclick = () => api.drawCmd('redo');
document.getElementById('clear').onclick = () => api.drawCmd('clear');
document.getElementById('close').onclick = () => api.drawCmd('exit');

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') return api.drawCmd('exit');
  if (e.ctrlKey && e.key.toLowerCase() === 'z') return api.drawCmd('undo');
  if (e.ctrlKey && e.key.toLowerCase() === 'y') return api.drawCmd('redo');
  if (e.key === 'Delete') return api.drawCmd('clear');
  if (e.ctrlKey || e.altKey || e.metaKey) return; // single-letter shortcuts only
  if (e.key.toLowerCase() === 'w') { state.whiteboard = !state.whiteboard; return push(); }
  const t = TOOLS.find(([, , key]) => key === e.key || key === e.key.toLowerCase());
  if (t) { state.tool = t[0]; push(); }
});

// Native tooltips would leak into recordings: show the hovered control's name in the bar instead.
const hint = document.getElementById('hint');
for (const el of document.querySelectorAll('[title]')) { el.dataset.tip = el.title; el.setAttribute('aria-label', el.title); el.removeAttribute('title'); }
document.addEventListener('mouseover', (e) => { hint.textContent = e.target.closest('[data-tip]')?.dataset.tip || ''; });
document.addEventListener('mouseleave', () => { hint.textContent = ''; });

push();
