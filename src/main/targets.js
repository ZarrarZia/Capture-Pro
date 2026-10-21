// Turns the selected recording mode into an ffmpeg capture source in physical pixels.
const { screen } = require('electron');

// Physical rect of a DIP rect (Windows: accounts for per-monitor scaling).
function toPhysical(rect) {
  const r = screen.dipToScreenRect(null, { x: rect.x, y: rect.y, width: rect.w, height: rect.h });
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
}

function monitorFor(monitors, r) {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  return monitors.find((m) => cx >= m.x && cx < m.x + m.w && cy >= m.y && cy < m.y + m.h) || monitors.find((m) => m.primary) || monitors[0];
}

const contains = (m, r) => r.x >= m.x && r.y >= m.y && r.x + r.w <= m.x + m.w && r.y + r.h <= m.y + m.h;
const even = (n) => n - (n % 2);

// Region (physical) → source. Uses the monitor's capture with crop when the region fits one monitor,
// otherwise GDI over the virtual desktop.
function regionSource(monitors, r, method) {
  r = { ...r, w: Math.max(2, even(r.w)), h: Math.max(2, even(r.h)) };
  const m = monitorFor(monitors, r);
  if (method !== 'gdi' && m && contains(m, r)) {
    if (method === 'dda') return { kind: 'dda', outputIdx: m.index, region: { x: r.x - m.x, y: r.y - m.y, w: r.w, h: r.h } };
    return {
      kind: 'wgc-monitor', hmonitor: m.hmonitor,
      crop: { left: r.x - m.x, top: r.y - m.y, right: m.x + m.w - (r.x + r.w), bottom: m.y + m.h - (r.y + r.h) },
    };
  }
  return { kind: 'gdi', region: r };
}

function displaySource(monitors, index, method) {
  if (index === -1 || method === 'gdi') {
    const x = Math.min(...monitors.map((m) => m.x)), y = Math.min(...monitors.map((m) => m.y));
    const w = Math.max(...monitors.map((m) => m.x + m.w)) - x, h = Math.max(...monitors.map((m) => m.y + m.h)) - y;
    return { kind: 'gdi', region: { x, y, w: even(w), h: even(h) } };
  }
  const m = monitors[index] || monitors.find((mm) => mm.primary) || monitors[0];
  return method === 'dda' ? { kind: 'dda', outputIdx: m.index } : { kind: 'wgc-monitor', hmonitor: m.hmonitor };
}

module.exports = { toPhysical, regionSource, displaySource, monitorFor };
