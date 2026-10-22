// Turns the selected recording mode into an ffmpeg capture source in physical pixels.
//
// macOS: the helper reports monitors/windows in points (= Electron DIP) with a per-monitor
// `scale`; AVFoundation captures each screen in pixels, so crops are scaled per display.
const platform = require('./platform');

// Physical rect of a DIP rect (Windows: accounts for per-monitor scaling; macOS: points).
const toPhysical = (rect) => platform.dipToPhysRect(rect);
const toDip = (r) => platform.physToDipRect(r);

function monitorFor(monitors, r) {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  return monitors.find((m) => cx >= m.x && cx < m.x + m.w && cy >= m.y && cy < m.y + m.h) || monitors.find((m) => m.primary) || monitors[0];
}

const contains = (m, r) => r.x >= m.x && r.y >= m.y && r.x + r.w <= m.x + m.w && r.y + r.h <= m.y + m.h;
const even = (n) => n - (n % 2);

// macOS: a points rect → AVFoundation source with a pixel crop inside its screen (clamped to it).
function avfRegion(monitors, r) {
  const m = monitorFor(monitors, r);
  const s = m.scale || 1;
  const x0 = Math.max(r.x, m.x), y0 = Math.max(r.y, m.y);
  const x1 = Math.min(r.x + r.w, m.x + m.w), y1 = Math.min(r.y + r.h, m.y + m.h);
  const region = {
    x: Math.round((x0 - m.x) * s), y: Math.round((y0 - m.y) * s),
    w: Math.max(2, even(Math.round((x1 - x0) * s))), h: Math.max(2, even(Math.round((y1 - y0) * s))),
  };
  return { kind: 'avf', screen: m.index, scale: s, region };
}

function intersect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
}

function desktopBounds(monitors) {
  const x = Math.min(...monitors.map((m) => m.x)), y = Math.min(...monitors.map((m) => m.y));
  return { x, y, w: Math.max(...monitors.map((m) => m.x + m.w)) - x, h: Math.max(...monitors.map((m) => m.y + m.h)) - y };
}

// Region (physical) → source. The region is first clipped to what is actually on screen: a frame
// dragged a few pixels past the edge (or DIP→pixel rounding at 125%/150%) must not make the capture
// fail. A region that mostly lies on one monitor uses that monitor's capture with a crop; one that
// really spans monitors uses GDI over the virtual desktop.
function regionSource(monitors, r, method) {
  if (platform.isMac) return avfRegion(monitors, r);
  if (!monitors.length) return { kind: 'gdi', region: { ...r, w: Math.max(2, even(r.w)), h: Math.max(2, even(r.h)) } };
  const m = monitorFor(monitors, r);
  const onMonitor = m ? intersect(r, m) : r;
  const area = (q) => q.w * q.h;
  r = m && area(onMonitor) >= 0.9 * area(r) ? onMonitor : intersect(r, desktopBounds(monitors));
  r = { ...r, w: Math.max(2, even(r.w)), h: Math.max(2, even(r.h)) };
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
  if (platform.isMac) {
    // AVFoundation records one screen; "All displays" records the main display.
    const m = monitors[index] || monitors.find((mm) => mm.primary) || monitors[0];
    return { kind: 'avf', screen: m.index, scale: m.scale || 1 };
  }
  if (index === -1 || method === 'gdi') {
    const x = Math.min(...monitors.map((m) => m.x)), y = Math.min(...monitors.map((m) => m.y));
    const w = Math.max(...monitors.map((m) => m.x + m.w)) - x, h = Math.max(...monitors.map((m) => m.y + m.h)) - y;
    return { kind: 'gdi', region: { x, y, w: even(w), h: even(h) } };
  }
  const m = monitors[index] || monitors.find((mm) => mm.primary) || monitors[0];
  return method === 'dda' ? { kind: 'dda', outputIdx: m.index } : { kind: 'wgc-monitor', hmonitor: m.hmonitor };
}

// Physical rect actually covered by a source (for positioning overlays).
function sourceRect(monitors, src) {
  if (src.kind === 'gdi') return src.region;
  if (src.kind === 'avf') {
    const m = monitors[src.screen] || monitors[0];
    const s = m.scale || 1, r = src.region;
    return r ? { x: m.x + r.x / s, y: m.y + r.y / s, w: r.w / s, h: r.h / s } : { x: m.x, y: m.y, w: m.w, h: m.h };
  }
  if (src.kind === 'dda') {
    const m = monitors[src.outputIdx] || monitors[0];
    return src.region ? { x: m.x + src.region.x, y: m.y + src.region.y, w: src.region.w, h: src.region.h } : { x: m.x, y: m.y, w: m.w, h: m.h };
  }
  if (src.kind === 'wgc-monitor') {
    const m = monitors.find((mm) => mm.hmonitor === src.hmonitor) || monitors[0];
    const c = src.crop || { left: 0, top: 0, right: 0, bottom: 0 };
    return { x: m.x + c.left, y: m.y + c.top, w: m.w - c.left - c.right, h: m.h - c.top - c.bottom };
  }
  return null;
}

module.exports = { toPhysical, toDip, regionSource, displaySource, monitorFor, sourceRect, avfRegion };
