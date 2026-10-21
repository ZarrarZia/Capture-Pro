// Platform differences in one place. Windows behaviour is exactly what the app always did;
// macOS gets its own branches.
//
// Coordinates: the capture code works in "physical" pixels. On Windows Electron converts DIP <->
// physical with dipToScreenRect/screenToDipPoint. On macOS the window system works in points
// (= Electron DIP); per-display pixel scaling is applied where ffmpeg crops (see targets.js).
const { execFile } = require('child_process');
const path = require('path');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

function electronScreen() { return require('electron').screen; }

function dipToPhysRect(r) {
  if (isMac) return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
  const s = electronScreen().dipToScreenRect(null, { x: r.x, y: r.y, width: r.w, height: r.h });
  return { x: Math.round(s.x), y: Math.round(s.y), w: Math.round(s.width), h: Math.round(s.height) };
}

function physToDipRect(r) {
  if (isMac) return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
  const d = electronScreen().screenToDipRect(null, { x: r.x, y: r.y, width: r.w, height: r.h });
  return { x: Math.round(d.x), y: Math.round(d.y), w: Math.round(d.width), h: Math.round(d.height) };
}

function physToDipPoint(p) { return isMac ? { x: p.x, y: p.y } : electronScreen().screenToDipPoint(p); }
function dipToPhysPoint(p) { return isMac ? { x: p.x, y: p.y } : electronScreen().dipToScreenPoint(p); }

// Where to look for ffmpeg besides the bundled copy. Apps started from Finder don't inherit the
// shell PATH, so Homebrew's locations are listed explicitly.
function ffmpegCandidates() {
  if (isMac) return ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/local/bin/ffmpeg'];
  return [];
}
const ffmpegExe = isWin ? 'ffmpeg.exe' : 'ffmpeg';
const ffprobeExe = isWin ? 'ffprobe.exe' : 'ffprobe';

// "After recording" power actions.
function powerAction(kind) {
  if (isMac) {
    if (kind === 'shutdown') execFile('osascript', ['-e', 'tell application "System Events" to shut down']);
    if (kind === 'hibernate') execFile('pmset', ['sleepnow']);
    return;
  }
  if (kind === 'shutdown') execFile('shutdown', ['/s', '/t', '60', '/c', 'CapturePro: recording finished. Run "shutdown /a" to cancel.']);
  if (kind === 'hibernate') execFile('shutdown', ['/h']);
}

// Font files for the text overlay (ffmpeg drawtext needs a file path).
const MAC_FONT_DIR = '/System/Library/Fonts/Supplemental';
const MAC_FONTS = {
  'Arial': 'Arial.ttf', 'Arial Black': 'Arial Black.ttf', 'Comic Sans MS': 'Comic Sans MS.ttf', 'Courier New': 'Courier New.ttf',
  'Georgia': 'Georgia.ttf', 'Impact': 'Impact.ttf', 'Tahoma': 'Tahoma.ttf', 'Times New Roman': 'Times New Roman.ttf',
  'Trebuchet MS': 'Trebuchet MS.ttf', 'Verdana': 'Verdana.ttf',
};
function macFontFile(name) { return path.posix.join(MAC_FONT_DIR, MAC_FONTS[name] || 'Arial.ttf'); }

module.exports = {
  isMac, isWin, dipToPhysRect, physToDipRect, physToDipPoint, dipToPhysPoint,
  ffmpegCandidates, ffmpegExe, ffprobeExe, powerAction, macFontFile,
};
