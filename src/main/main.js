// CapturePro main process: windows, tray, hotkeys, IPC and recording orchestration.
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, shell, dialog, desktopCapturer,
  session, Notification, clipboard } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const { Settings } = require('./settings');
const ffmpeg = require('./ffmpeg');
const codecs = require('./codecs');
const { Recorder } = require('./recorder');
const { buildRecordArgs, buildImageArgs, textFileContent } = require('./capture-args');
const { Helper } = require('./helper');
const { outputPath } = require('./naming');
const { toPhysical, toDip, regionSource, displaySource, sourceRect, monitorFor } = require('./targets');
const { MouseFollower } = require('./follower');
const platform = require('./platform');
const scheduler = require('./scheduler');
const outputs = require('./outputs');
const { Overlays } = require('./overlays');
const { Webcam } = require('./webcam');
const { Device } = require('./device');

const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const PRELOAD = path.join(ROOT, 'src', 'preload', 'preload.js');
// Packaged builds: assets are unpacked next to app.asar (Windows needs real files for tray and
// notification icons) and the native helper ships in resources/, since an .exe can't run from an asar.
const ASSETS = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets') : path.join(ROOT, 'assets');
const HELPER_NAME = platform.isMac ? 'CaptureProHelper' : 'CaptureProHelper.exe';
const HELPER_EXE = app.isPackaged ? path.join(process.resourcesPath, 'native', HELPER_NAME) : path.join(ROOT, 'native', 'bin', HELPER_NAME);
const ICON = path.join(ASSETS, 'icon.png');
const RECT_BAR = 34; // DIP height of the capture frame's control bar
const RECT_BORDER = 3;

if (process.env.CAPTUREPRO_USER_DATA) app.setPath('userData', process.env.CAPTUREPRO_USER_DATA); // isolated profiles for tests
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// Unexpected errors are logged (userData/logs/main.log) and reported as a toast instead of a modal
// crash dialog; the E2E tests fail if this log has any entries.
const LOG_FILE = path.join(app.getPath('userData'), 'logs', 'main.log');
function logError(kind, err) {
  const line = `[${new Date().toISOString()}] ${kind}: ${err?.stack || err}\n`;
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, line); } catch { /* disk full */ }
  console.error(line);
}
process.on('uncaughtException', (e) => {
  logError('uncaughtException', e);
  try { toast('error', `Something went wrong: ${e.message}\nDetails were saved to ${LOG_FILE}`); } catch { /* UI not ready */ }
});
process.on('unhandledRejection', (e) => logError('unhandledRejection', e));
app.setAppUserModelId('com.capturepro.app');

let settings, helper, tray;
let mainWin, audioWin, rectWin;
let available = new Set();
const recorder = new Recorder();
const rec = { mode: null, targetName: '', file: null, startedAt: 0, lastSoundAt: 0, levels: { speaker: 0, mic: 0 }, mute: { speaker: false, mic: false }, tmpFiles: [] };
let lastGameTarget = null;
let hotkeyCapture = null;
let imageRepeatTimer = null;
let overlays, webcam, device, drawbarWin;
let monitorsCache = [];
let filterCaps = new Set(['zmq']); // replaced by real detection at startup
const drawState = { enabled: false, tool: 'pen', color: '#ff3b48', width: 4, whiteboard: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCREEN_MODES = ['rect', 'full', 'window', 'mouse', 'game'];

// ---------------------------------------------------------------------------- windows
// WDA_EXCLUDEFROMCAPTURE set on a hidden window is lost when it is shown, so re-apply on every show.
// A crashed renderer is reloaded instead of leaving a dead window (no controls, no audio engine).
function recoverRenderer(win, name, onReload) {
  win.webContents.on('render-process-gone', (_e, d) => {
    if (app.isQuitting || d.reason === 'clean-exit') return;
    logError('render-process-gone', `${name}: ${d.reason}`);
    if (!win.isDestroyed()) { win.webContents.reload(); onReload?.(); }
  });
}

function protectFromCapture(win, getEnabled) {
  const apply = () => { if (!win.isDestroyed()) win.setContentProtection(!!getEnabled()); };
  apply();
  win.on('show', apply);
  win.once('ready-to-show', apply);
  return apply;
}
let applyMainProtection = () => {};

function createMainWindow() {
  const s = settings.get();
  mainWin = new BrowserWindow({
    width: 1040, height: 680, minWidth: 900, minHeight: 600, frame: false, show: false,
    backgroundColor: '#11141b', icon: ICON, title: 'CapturePro',
    alwaysOnTop: s.general.alwaysOnTop,
    webPreferences: { preload: PRELOAD, backgroundThrottling: false },
  });
  applyMainProtection = protectFromCapture(mainWin, () => settings.get().video.excludeOwnWindows);
  mainWin.loadFile(path.join(RENDERER, 'main', 'index.html'));
  recoverRenderer(mainWin, 'main');
  mainWin.once('ready-to-show', () => {
    const minimized = process.argv.includes('--minimized') || s.general.startMinimized;
    if (!minimized) mainWin.show();
    applyMainProtection();
  });
  mainWin.on('close', async (e) => {
    if (app.isQuitting) return;
    if (recorder.state !== 'idle') {
      e.preventDefault();
      const { response } = await dialog.showMessageBox(mainWin, {
        type: 'warning', buttons: ['Stop and exit', 'Cancel'], defaultId: 1, cancelId: 1,
        message: 'If you close CapturePro, the recording will be stopped. Are you sure you want to exit?',
      });
      if (response === 0) { await stopRecording(); quit(); }
    } else {
      quit();
    }
  });
}

function createAudioWindow() {
  audioWin = new BrowserWindow({ show: false, webPreferences: { preload: PRELOAD, backgroundThrottling: false } });
  audioWin.loadFile(path.join(RENDERER, 'audio', 'audio.html'));
  recoverRenderer(audioWin, 'audio', () => {
    if (recorder.state !== 'idle') toast('warn', 'The audio engine restarted; sound may be missing from this recording. It will work again from the next recording.');
  });
}

function rectWindowBounds(r) {
  return { x: r.x - RECT_BORDER, y: r.y - RECT_BORDER - RECT_BAR, width: r.w + RECT_BORDER * 2, height: r.h + RECT_BORDER * 2 + RECT_BAR };
}

function interiorFromWindow(b) {
  return { x: b.x + RECT_BORDER, y: b.y + RECT_BORDER + RECT_BAR, w: b.width - RECT_BORDER * 2, h: b.height - RECT_BORDER * 2 - RECT_BAR };
}

function createRectWindow() {
  const r = clampRect(settings.get().target.rect);
  rectWin = new BrowserWindow({
    ...rectWindowBounds(r), frame: false, transparent: true, resizable: false, hasShadow: false,
    skipTaskbar: true, show: false, alwaysOnTop: true, minimizable: false, maximizable: false, fullscreenable: false,
    webPreferences: { preload: PRELOAD, backgroundThrottling: false },
  });
  rectWin.setAlwaysOnTop(true, 'screen-saver');
  protectFromCapture(rectWin, () => true); // the frame itself is never recorded
  rectWin.loadFile(path.join(RENDERER, 'rect', 'rect.html'));
  recoverRenderer(rectWin, 'capture frame');
  rectWin.on('moved', () => saveRectFromWindow());
  // Alt+F4 on the capture frame hides it (it is reopened from the mode button or Ctrl+Alt+H).
  rectWin.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); rectWin.userHidden = true; updateRectVisibility(); } });
  rectWin.webContents.on('did-finish-load', () => sendRectInfo());
}

function clampRect(r) {
  const d = screen.getDisplayMatching({ x: r.x, y: r.y, width: r.w, height: r.h }).workArea;
  const w = Math.max(64, Math.min(r.w, d.width)), h = Math.max(48, Math.min(r.h, d.height - RECT_BAR));
  const x = Math.min(Math.max(r.x, d.x), d.x + d.width - w);
  const y = Math.min(Math.max(r.y, d.y + RECT_BAR), d.y + d.height - h);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

function saveRectFromWindow() {
  if (!rectWin) return;
  settings.update({ target: { rect: interiorFromWindow(rectWin.getBounds()) } });
  sendRectInfo();
}

function sendRectInfo() {
  if (!rectWin) return;
  const r = interiorFromWindow(rectWin.getBounds());
  let p = toPhysical(r);
  if (platform.isMac) { // points → recorded pixels (Retina)
    const k = screen.getDisplayMatching(rectWin.getBounds()).scaleFactor;
    p = { w: Math.round(p.w * k), h: Math.round(p.h * k) };
  }
  rectWin.webContents.send('rect:info', { dip: r, physical: { w: p.w - (p.w % 2), h: p.h - (p.h % 2) } });
}

function updateRectVisibility() {
  if (!rectWin) return;
  const show = settings.get().mode === 'rect' && !rectWin.userHidden;
  if (show && !rectWin.isVisible()) rectWin.showInactive();
  if (!show && rectWin.isVisible()) rectWin.hide();
}

function broadcast(channel, payload) {
  for (const w of [mainWin, rectWin]) if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

// In-app toast; when the window is hidden, errors also raise a (non-blocking, rate-limited) Windows
// notification. Never a modal dialog: that would block the main process and stall audio delivery.
const recentErrors = new Map();
function toast(type, message) {
  broadcast('toast', { type, message });
  if (type !== 'error' || (mainWin && !mainWin.isDestroyed() && mainWin.isVisible() && !mainWin.isMinimized())) return;
  const now = Date.now();
  if (now - (recentErrors.get(message) || 0) < 30000) return;
  recentErrors.set(message, now);
  if (Notification.isSupported()) new Notification({ title: 'CapturePro', body: message, icon: ICON }).show();
}

function notify(title, body, onClick) {
  if (!settings.get().general.trayNotifications || !Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON, silent: true });
  if (onClick) n.on('click', onClick);
  n.show();
}

function playSound(name) { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('sound', name); }

// ---------------------------------------------------------------------------- tray
// macOS menu-bar icons are 18 pt; Windows uses the 32 px images as they are.
function trayImage(name) {
  const img = nativeImage.createFromPath(path.join(ASSETS, name));
  return platform.isMac ? img.resize({ width: 18, height: 18 }) : img;
}

function createTray() {
  tray = new Tray(trayImage('tray.png'));
  tray.setToolTip('CapturePro');
  tray.on('click', () => showMain());
  refreshTray();
}

function refreshTray() {
  if (!tray) return;
  const active = recorder.state !== 'idle';
  tray.setImage(trayImage(active ? 'tray-rec.png' : 'tray.png'));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: active ? 'Stop recording' : 'Start recording', click: () => toggleRecording() },
    { label: recorder.state === 'paused' ? 'Resume' : 'Pause', enabled: active, click: () => togglePause() },
    { label: 'Capture image', click: () => captureImage() },
    { type: 'separator' },
    { label: 'Show CapturePro', click: () => showMain() },
    { label: 'Open output folder', click: () => openOutputFolder() },
    { type: 'separator' },
    { label: 'Exit', click: async () => { if (recorder.state !== 'idle') await stopRecording(); quit(); } },
  ]));
}

function showMain() { mainWin.show(); if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); }
function quit() { app.isQuitting = true; helper?.stop(); device?.close(); overlays?.close(); webcam?.close(); app.quit(); }
function openOutputFolder() {
  const dir = settings.get().general.outputDir;
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
}

// ---------------------------------------------------------------------------- hotkeys
function onHotkey({ accel }) {
  if (!accel) return;
  if (hotkeyCapture) {
    const resolve = hotkeyCapture;
    hotkeyCapture = null;
    resolve(accel === 'Esc' ? null : accel === 'Backspace' || accel === 'Delete' ? '' : accel);
    return;
  }
  const hk = settings.get().hotkeys;
  const is = (k) => hk[k] && hk[k] === accel;
  if (is('record')) toggleRecording();
  else if (is('pause')) togglePause();
  else if (is('cancel')) cancelRecording();
  else if (is('image')) captureImage();
  else if (is('muteSpeaker')) setMute('speaker', !rec.mute.speaker);
  else if (is('muteMic')) setMute('mic', !rec.mute.mic);
  else if (is('toggleDraw')) toggleDrawing();
  else if (is('toggleRect') && settings.get().mode === 'rect' && rectWin) {
    rectWin.userHidden = rectWin.isVisible();
    updateRectVisibility();
  }
}

function onPushToTalk(k) {
  const pt = settings.get().audio.pushTo;
  if (!pt.enabled || k.name !== pt.key) return;
  const pressed = k.type === 'down';
  const open = pt.mode === 'talk' ? pressed : !pressed;
  audioWin?.webContents.send('audio:set', { micOpen: open });
}

function setMute(which, value) {
  rec.mute[which] = value;
  audioWin?.webContents.send('audio:set', { mute: rec.mute });
  broadcast('rec:mute', rec.mute);
}

// ---------------------------------------------------------------------------- recording
function audioPlan(s, audioOnly) {
  const a = s.audio;
  if (!audioOnly && !a.enabled) return { tracks: 0 };
  const speaker = a.speaker.enabled, mic = a.mic.enabled;
  if (!speaker && !mic) return { tracks: 0 };
  return { tracks: speaker && mic && !a.mix ? 2 : 1, speaker, mic };
}

async function startAudioEngine(plan) {
  if (!plan.tracks) return true;
  const s = settings.get();
  return new Promise((resolve) => {
    const t = setTimeout(() => { ipcMain.removeAllListeners('audio:started'); resolve('Audio engine did not respond.'); }, 6000);
    ipcMain.once('audio:started', (_e, res) => {
      clearTimeout(t);
      for (const w of res.warnings || []) toast('warn', w);
      resolve(res.ok ? true : res.error);
    });
    audioWin.webContents.send('audio:start', {
      speaker: plan.speaker ? s.audio.speaker : null, mic: plan.mic ? s.audio.mic : null,
      tracks: plan.tracks, mute: rec.mute,
      micOpen: !(s.audio.pushTo.enabled && s.audio.pushTo.mode === 'talk'),
    });
  });
}

// Around mouse without the Windows capture path: macOS follows the cursor in the screen's pixel space;
// an ffmpeg without the zmq filter records a fixed area centred on the cursor at start.
function mouseTargetFallback(monitors, c, s, method, even) {
  const m = monitorFor(monitors, { x: c.x, y: c.y, w: 1, h: 1 });
  if (platform.isMac && filterCaps.has('zmq')) {
    const k = m.scale || 1;
    const pw = Math.round(m.w * k), ph = Math.round(m.h * k);
    const w = even(Math.min(s.target.mouseSize.w, pw)), h = even(Math.min(s.target.mouseSize.h, ph));
    const x = Math.max(0, Math.min(pw - w, Math.round((c.x - m.x) * k - w / 2)));
    const y = Math.max(0, Math.min(ph - h, Math.round((c.y - m.y) * k - h / 2)));
    // The follower works in this screen's pixel space.
    const follow = { w, h, x, y, monitor: { x: m.x * k, y: m.y * k, w: pw, h: ph }, toPhys: (p) => ({ x: p.x * k, y: p.y * k }) };
    return { source: { kind: 'avf', screen: m.index, scale: k }, follow, name: 'Screen', regionPhys: { x: m.x + x / k, y: m.y + y / k, w: w / k, h: h / k } };
  }
  const sz = s.target.mouseSize;
  const r = { x: Math.round(c.x - sz.w / 2), y: Math.round(c.y - sz.h / 2), w: sz.w, h: sz.h };
  return { source: regionSource(monitors, r, method), name: 'Screen', regionPhys: r };
}

// Returns { source, name, regionPhys } for the current mode.
async function resolveTarget(s) {
  const monitors = await helper.monitors();
  monitorsCache = monitors;
  const method = s.video.captureMethod;
  const withRect = (t) => ({ ...t, regionPhys: t.regionPhys || sourceRect(monitors, t.source) });
  switch (s.mode) {
    case 'rect': {
      const r = rectWin ? interiorFromWindow(rectWin.getBounds()) : s.target.rect;
      return withRect({ source: regionSource(monitors, toPhysical(r), method), name: 'Screen' });
    }
    case 'full':
      return withRect({ source: displaySource(monitors, s.target.display, method), name: 'Screen' });
    case 'mouse': {
      // Capture the whole monitor under the cursor and steer a crop window with the cursor.
      const c = platform.dipToPhysPoint(screen.getCursorScreenPoint());
      const even = (n) => n - (n % 2);
      if (platform.isMac || !filterCaps.has('zmq')) return mouseTargetFallback(monitors, c, s, method, even);
      const m = monitorFor(monitors, { x: c.x, y: c.y, w: 1, h: 1 });
      const w = even(Math.min(s.target.mouseSize.w, m.w)), h = even(Math.min(s.target.mouseSize.h, m.h));
      const x = Math.max(0, Math.min(m.w - w, Math.round(c.x - m.x - w / 2)));
      const y = Math.max(0, Math.min(m.h - h, Math.round(c.y - m.y - h / 2)));
      const source = method === 'dda' ? { kind: 'dda', outputIdx: m.index } : { kind: 'wgc-monitor', hmonitor: m.hmonitor };
      return { source, follow: { w, h, x, y, monitor: m }, name: 'Screen', regionPhys: { x: m.x + x, y: m.y + y, w, h } };
    }
    case 'window': {
      const w = s.target.window;
      if (!w) throw new Error('Please select a window to record first (Home → Specific window).');
      const live = (await helper.windows()).find((x) => x.hwnd === w.hwnd);
      if (!live) throw new Error(`The window "${w.title}" is no longer open. Please select it again.`);
      if (platform.isMac) return { source: regionSource(monitors, live, method), name: live.exe || 'Window', regionPhys: live };
      return { source: { kind: 'wgc-window', hwnd: w.hwnd }, name: live.exe || 'Window', regionPhys: live };
    }
    case 'game': {
      const fg = await helper.foreground().catch(() => null);
      const target = fg && fg.pid !== process.pid && fg.class !== 'Progman' && fg.class !== 'WorkerW' ? fg : lastGameTarget;
      if (!target) throw new Error('No game window detected. Start your game, then press the record hotkey while it is in front.');
      if (platform.isMac) return { source: regionSource(monitors, target, method), name: target.exe || 'Game', regionPhys: target };
      return { source: { kind: 'wgc-window', hwnd: target.hwnd }, name: target.exe || 'Game', regionPhys: target };
    }
    case 'audio':
      return { source: null, name: 'Audio' };
    case 'device':
      if (!s.target.device.videoId) throw new Error("You can't start recording in Device Recording Mode because the capture device is not selected.");
      return { source: null, device: true, name: 'Device' };
    default:
      throw new Error(`Unknown recording mode: ${s.mode}`);
  }
}

// Only one start can be in flight: a second REC press during start-up/countdown is ignored
// (or aborts the countdown), so two ffmpeg processes can never be launched.
async function startRecording(opts = {}) {
  if (rec.starting || stopPromise || recorder.state !== 'idle') return;
  rec.starting = true;
  try {
    await startRecordingInner(opts);
  } catch (e) {
    audioWin?.webContents.send('audio:stop');
    toast('error', `Failed to start recording.\n${e.message}`);
  } finally {
    rec.starting = false;
    rec.counting = false;
    if (recorder.state === 'idle') { rec.regionDip = null; updateOverlays(); }
  }
}

async function startRecordingInner({ scheduleId = null } = {}) {
  const s = settings.get();
  const audioOnly = s.mode === 'audio';
  rec.autoPaused = false;
  rec.scheduleId = scheduleId;
  let target;
  try { target = await resolveTarget(s); } catch (e) { toast('error', e.message); return; }
  rec.regionDip = target.regionPhys ? toDip(target.regionPhys) : null;

  // Countdown on the capture-visible overlay; it disappears before the first frame is captured.
  if (!audioOnly && !target.device && s.video.countdown > 0) {
    rec.counting = true;
    rec.abortCountdown = false;
    overlays.open(overlayConfig(false));
    for (let n = s.video.countdown; n > 0 && !rec.abortCountdown; n--) {
      overlays.broadcast('overlay:countdown', { n });
      await sleep(1000);
    }
    overlays.broadcast('overlay:countdown', { n: 0 });
    rec.counting = false;
    if (rec.abortCountdown) { updateOverlays(); return; }
    await sleep(150);
  }

  const aplan = target.device ? { tracks: 0 } : audioPlan(s, audioOnly); // device mode records the device's own audio
  if (audioOnly && !aplan.tracks) { toast('error', 'There is no sound device activated. Please select at least one device.'); return; }

  const container = audioOnly ? s.audio.audioOnlyFormat : s.video.container;
  const finalPath = outputPath(s.general, { kind: audioOnly ? 'audio' : 'video', targetName: target.name, ext: container });
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });

  let ffEncoder = null;
  if (!audioOnly) {
    try { ffEncoder = codecs.VIDEO_CODECS[s.video.codec].encoders[codecs.resolveEncoder(s.video.codec, s.video.encoder, available)]; }
    catch (e) { toast('error', e.message); return; }
  }
  const audio = audioOnly ? { ...s.audio, codec: container === 'wav' ? 'pcm' : 'mp3' } : s.audio;
  const logo = !audioOnly && s.overlays.logo.enabled && fs.existsSync(s.overlays.logo.image) ? s.overlays.logo : null;
  rec.tmpFiles = [];
  const texts = audioOnly ? [] : s.overlays.texts.filter((t) => t.enabled !== false && t.text).map((t, i) => {
    const f = path.join(os.tmpdir(), `capturepro-text-${process.pid}-${i}.txt`);
    fs.writeFileSync(f, textFileContent(t.text));
    rec.tmpFiles.push(f);
    return { ...t, textFile: f };
  });

  const audioResult = await startAudioEngine(aplan);
  if (audioResult !== true) {
    if (audioOnly) { toast('error', `Failed to start audio capture: ${audioResult}`); return; }
    toast('warn', `Recording without sound: ${audioResult}`);
    aplan.tracks = 0;
  }

  rec.follower = target.follow ? new MouseFollower(target.follow) : null;
  const plan = (enc) => ({
    finalPath, container, audioTracks: aplan.tracks, priority: s.video.priority,
    external: target.device ? device.external({ video: s.video, audio: s.audio, ffEncoder: enc, container, device: s.target.device }) : null,
    splitTracks: s.audio.saveTracksAsFiles && !audioOnly,
    beforeSegment: target.follow ? async () => { target.follow.port = await MouseFollower.freePort(); } : null,
    buildArgs: (seg, pipes) => buildRecordArgs({
      source: target.source, showCursor: s.video.showCursor, video: s.video, audio, ffEncoder: enc,
      container, audioPipes: pipes, logo, texts, output: seg,
      follow: target.follow && { ...target.follow, x: Math.round(target.follow.x), y: Math.round(target.follow.y) },
    }),
  });

  try {
    await recorder.start(plan(ffEncoder));
  } catch (e) {
    if (ffEncoder && /_(nvenc|qsv|amf|videotoolbox)$/.test(ffEncoder) && available.has('libx264') && s.video.codec === 'h264') {
      toast('warn', `Failed to initialize ${ffEncoder} (${e.message}). Retrying with H.264 (CPU).`);
      try { await recorder.start(plan('libx264')); } catch (e2) { return failStart(e2); }
    } else {
      return failStart(e);
    }
  }
  rec.mode = s.mode;
  rec.targetName = target.name;
  rec.file = finalPath;
  rec.startedAt = Date.now();
  rec.lastSoundAt = Date.now();
  if (s.video.soundEffects) playSound('start');
  if (s.video.hideMainWindow && !audioOnly) mainWin.minimize();
  if (s.overlays.mouse.clickEffect || s.overlays.mouse.clickSound) helper.mouseEvents(true);
  updateOverlays();
  if (!audioOnly) webcam.startRecording(finalPath);
  refreshTray();
}

function failStart(e) {
  audioWin?.webContents.send('audio:stop');
  updateOverlays();
  const hint = platform.isMac ? '\nOn macOS, allow CapturePro in System Settings → Privacy & Security → Screen Recording (and Microphone), then restart CapturePro.' : '';
  toast('error', `Failed to start video capture.\n${e.message}${hint}`);
}

// Repeated stop requests (hotkey + tray + "Stop and exit") share the same in-flight save.
let stopPromise = null;
function stopRecording() {
  if (stopPromise) return stopPromise;
  if (recorder.state === 'idle') return Promise.resolve(null);
  stopPromise = stopRecordingInner().finally(() => { stopPromise = null; });
  return stopPromise;
}

async function stopRecordingInner() {
  const s = settings.get();
  // A recording stopped by hand ends its schedule window too, so the schedule can't later stop
  // (and run the after-action on) an unrelated recording.
  if (scheduleRun && rec.scheduleId === scheduleRun.id) scheduleRun = null;
  helper.mouseEvents(false);
  const webcamFile = webcam.stopRecording();
  let result = null;
  try {
    result = await recorder.stop();
  } catch (e) {
    toast('error', `Failed to save the recording.\n${e.message}`);
  } finally {
    audioWin?.webContents.send('audio:stop');
    for (const f of rec.tmpFiles) fs.rm(f, () => {});
    rec.regionDip = null;
    updateOverlays();
    refreshTray();
  }
  if (result && await webcamFile) broadcast('outputs:changed', {});
  if (s.video.soundEffects) playSound('stop');
  if (s.video.hideMainWindow && mainWin.isMinimized()) mainWin.restore();
  if (!result) return null;
  broadcast('outputs:changed', {});
  if (result.rescued) toast('warn', `The file could not be written as ${path.extname(rec.file)}; it was saved as MKV instead.`);
  notify('Recording saved', path.basename(result.file), () => shell.showItemInFolder(result.file));
  if (s.video.openPlayerAfter && rec.mode !== 'game') shell.openPath(result.file);
  return result;
}

async function cancelRecording() {
  // Never cancel while a recording is being saved: that would delete it.
  if (recorder.state === 'idle' || recorder.state === 'stopping' || stopPromise || rec.starting) return;
  helper.mouseEvents(false);
  webcam.stopRecording().then((f) => f && fs.rm(f, () => {}));
  await recorder.cancel();
  audioWin?.webContents.send('audio:stop');
  rec.regionDip = null;
  updateOverlays();
  refreshTray();
  toast('info', 'Recording canceled.');
}

function toggleRecording() {
  if (rec.counting) { rec.abortCountdown = true; return; }
  if (rec.starting) return; // start-up in progress
  return recorder.state === 'idle' ? startRecording() : stopRecording();
}

// user=false is used by auto-pause; any manual pause/resume clears the auto-pause state.
async function togglePause(user = true) {
  if (user) rec.autoPaused = false;
  try {
    if (recorder.state === 'recording') { webcam.pause(true); await recorder.pause(); }
    else if (recorder.state === 'paused') { webcam.pause(false); await recorder.resume(); }
  } catch (e) {
    toast('error', `Failed to resume the recording; the part recorded so far is being saved.\n${e.message}`);
    await stopRecording();
  }
  broadcastStatus();
}

// ---------------------------------------------------------------------------- overlays & drawing
// Effects are only active while recording; drawing works any time.
function overlayConfig(recording) {
  const s = settings.get();
  const screenMode = SCREEN_MODES.includes(rec.mode || s.mode);
  return {
    mouse: recording ? s.overlays.mouse : {},
    keystroke: recording && screenMode && rec.mode !== 'game' ? s.overlays.keystroke : { enabled: false },
    region: rec.regionDip || previewRegion(),
  };
}

function updateOverlays() {
  const s = settings.get();
  const recording = recorder.state === 'recording' || recorder.state === 'paused';
  const m = s.overlays.mouse;
  const effects = recording && SCREEN_MODES.includes(rec.mode) && (m.clickEffect || m.highlight || s.overlays.keystroke.enabled);
  if (drawState.enabled || effects || rec.counting) overlays.open(overlayConfig(recording));
  else overlays.close();
  if (drawState.enabled) overlays.broadcast('overlay:draw', { ...drawState });
}

// DIP rect of the area that will be recorded in the current mode (for overlay/webcam placement).
function previewRegion() {
  const s = settings.get();
  if (rec.regionDip) return rec.regionDip;
  if (s.mode === 'rect') return rectWin ? interiorFromWindow(rectWin.getBounds()) : s.target.rect;
  if (s.mode === 'full' && s.target.display >= 0 && monitorsCache[s.target.display]) return toDip(monitorsCache[s.target.display]);
  const b = screen.getPrimaryDisplay().bounds;
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

function toggleDrawing(on = !drawState.enabled) {
  if (on === drawState.enabled) return;
  drawState.enabled = on;
  if (on) {
    updateOverlays();
    overlays.setInteractive(drawState.tool !== 'cursor');
    showDrawbar();
  } else {
    // Tell the overlays drawing is over (they may stay open for click effects while recording).
    overlays.broadcast('overlay:drawCmd', 'clear');
    overlays.broadcast('overlay:draw', { ...drawState });
    overlays.setInteractive(false);
    if (drawbarWin && !drawbarWin.isDestroyed()) drawbarWin.hide();
    updateOverlays();
  }
  broadcast('draw:state', drawState.enabled);
}

// The toolbar must stay above the (full-screen, topmost) drawing overlays and keep keyboard focus,
// otherwise clicks on its buttons would draw on the overlay instead.
function raiseDrawbar(focus = true) {
  if (!drawbarWin || drawbarWin.isDestroyed() || !drawState.enabled) return;
  drawbarWin.setAlwaysOnTop(true, 'screen-saver');
  drawbarWin.moveTop();
  if (focus) drawbarWin.focus();
}

function showDrawbar() {
  if (drawbarWin && !drawbarWin.isDestroyed()) { drawbarWin.show(); raiseDrawbar(); return; }
  const wa = screen.getPrimaryDisplay().workArea;
  const win = drawbarWin = new BrowserWindow({
    width: 860, height: 46, x: Math.round(wa.x + (wa.width - 860) / 2), y: wa.y + 12,
    frame: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnTop: true, show: false, hasShadow: false,
    minimizable: false, maximizable: false, fullscreenable: false,
    webPreferences: { preload: PRELOAD },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  protectFromCapture(win, () => true);
  // Closing the toolbar (Alt+F4) must not leave an interactive full-screen overlay behind: exit drawing.
  win.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); toggleDrawing(false); } });
  win.on('closed', () => { if (drawbarWin === win) drawbarWin = null; });
  win.webContents.on('render-process-gone', () => { if (!win.isDestroyed()) win.destroy(); toggleDrawing(false); });
  win.loadFile(path.join(RENDERER, 'drawbar', 'drawbar.html'));
  win.once('ready-to-show', () => { if (!win.isDestroyed() && drawState.enabled) { win.show(); raiseDrawbar(); } });
}

function keystrokeText(k) {
  if (!k.accel) return null;
  return k.accel.split('+').map((p) => (p.length === 1 ? p.toUpperCase() : p)).join(' + ');
}

recorder.on('state', () => { broadcastStatus(); refreshTray(); });
recorder.on('segment', () => { if (rec.follower) rec.follower.attach(rec.follower.f.port); });
recorder.on('segment-end', () => rec.follower?.detach());
recorder.on('failed', async (msg) => {
  toast('error', `The recording has stopped because of an encoder problem.\n${msg}`);
  if (recorder.state === 'recording') await stopRecording();
});
recorder.on('log', (l) => { if (process.env.CAPTUREPRO_DEBUG) console.log(l); });

// Status tick: UI timer, disk space and auto-complete rules.
let statfsCache = { at: 0, free: null };
function freeBytes(dir) {
  if (Date.now() - statfsCache.at > 2000) {
    try { const st = fs.statfsSync(fs.existsSync(dir) ? dir : os.homedir()); statfsCache = { at: Date.now(), free: st.bavail * st.bsize }; } catch { /* ignore */ }
  }
  return statfsCache.free;
}

function broadcastStatus() {
  const st = recorder.stats();
  const s = settings.get();
  broadcast('rec:status', { ...st, free: freeBytes(s.general.outputDir), levels: rec.levels, mute: rec.mute, mode: rec.mode || s.mode, target: rec.targetName });
}

setInterval(async () => {
  if (recorder.state === 'idle') return;
  broadcastStatus();
  if (recorder.state !== 'recording') return;
  const s = settings.get();
  const st = recorder.stats();
  const free = freeBytes(s.general.outputDir);
  if (free !== null && free < 200 * 1024 * 1024) {
    await stopRecording();
    toast('error', 'Recording has stopped due to insufficient disk space.');
    return;
  }
  const ac = s.autoComplete;
  const done = (ac.mode === 'time' && st.elapsedMs >= ac.timeSec * 1000)
    || (ac.mode === 'size' && st.bytes >= ac.sizeMB * 1024 * 1024)
    || (ac.mode === 'silence' && Date.now() - rec.lastSoundAt >= ac.silenceSec * 1000);
  if (done) await autoComplete(ac.after);
}, 500);

// ---------------------------------------------------------------------------- timer, schedules, auto-pause
let timerAt = null;          // Date when timer recording starts
let scheduleRun = null;      // { id, end, after } while a scheduled recording runs
const scheduleFired = new Map(); // schedule id -> start time already triggered

function timerStatus() { return timerAt ? { at: timerAt.getTime() } : null; }

async function applyScheduleTarget(sc) {
  if (sc.target === 'full') settings.update({ mode: 'full', target: { display: sc.display ?? 0 } });
  else if (sc.target === 'rect' && sc.rect) {
    settings.update({ mode: 'rect', target: { rect: sc.rect } });
    rectWin?.setBounds(rectWindowBounds(clampRect(sc.rect)));
  }
}

let automationTicking = false;
setInterval(async () => {
  if (!settings || !helper || automationTicking) return; // a slow tick must not overlap the next one
  automationTicking = true;
  try { await automationTick(); } catch (e) { logError('automation', e); } finally { automationTicking = false; }
}, 1000);

async function automationTick() {
  const s = settings.get();
  const now = new Date();

  if (timerAt && now >= timerAt) {
    timerAt = null;
    broadcast('timer:status', null);
    if (recorder.state === 'idle') {
      if (s.timer.minimizeOnStart) mainWin.hide();
      startRecording();
    }
  }

  if (scheduleRun && now >= scheduleRun.end) {
    const { after, id } = scheduleRun;
    scheduleRun = null;
    // Only stop (and run the after-action for) the recording this schedule started.
    if (recorder.state !== 'idle' && rec.scheduleId === id) await autoComplete(after);
  }

  if (!scheduleRun && recorder.state === 'idle' && !rec.starting && !stopPromise) {
    const d = scheduler.due(s.schedules, now);
    if (d && scheduleFired.get(d.schedule.id) !== d.window.start.getTime()) {
      scheduleFired.set(d.schedule.id, d.window.start.getTime());
      await applyScheduleTarget(d.schedule);
      scheduleRun = { id: d.schedule.id, end: d.window.end, after: d.schedule.after };
      await startRecording({ scheduleId: d.schedule.id });
      if (recorder.state === 'idle') scheduleRun = null;
    }
  }

  // Auto-pause after a period of user inactivity (screen modes), resume on input.
  const ap = s.video.autoPause;
  if (ap.enabled && SCREEN_MODES.includes(rec.mode) && (recorder.state === 'recording' || recorder.state === 'paused')) {
    const idle = await helper.idleMs().catch(() => 0);
    if (recorder.busy) return;
    if (recorder.state === 'recording' && idle >= ap.idleSec * 1000) { rec.autoPaused = true; await togglePause(false); toast('info', 'Recording paused (no activity).'); }
    else if (recorder.state === 'paused' && rec.autoPaused && idle < 1000) { rec.autoPaused = false; await togglePause(false); }
  }
}

function scheduleList() {
  const now = new Date();
  return settings.get().schedules.map((sc) => {
    const w = scheduler.nextWindow(sc, now);
    return { ...sc, status: scheduler.status(sc, now), next: w ? { start: w.start.getTime(), end: w.end.getTime() } : null, durationMs: scheduler.durationMs(sc) };
  });
}

async function autoComplete(after) {
  await stopRecording();
  switch (after) {
    case 'new': setTimeout(() => startRecording(), 300); break;
    case 'exit': quit(); break;
    case 'shutdown': platform.powerAction('shutdown'); break;
    case 'hibernate': platform.powerAction('hibernate'); break;
    default: break;
  }
}

// ---------------------------------------------------------------------------- image capture
// One capture at a time (repeat capture can fire while a slow capture is still running).
let capturingImage = false;
async function captureImage() {
  if (capturingImage) return;
  capturingImage = true;
  try { await captureImageInner(); } catch (e) { toast('error', `Failed to capture image. Please check your output folder.\n${e.message}`); }
  finally { capturingImage = false; }
}

async function captureImageInner() {
  const s = settings.get();
  let target;
  try {
    target = s.mode === 'audio' ? { source: displaySource(await helper.monitors(), 0, s.video.captureMethod), name: 'Screen' } : await resolveTarget(s);
  } catch (e) { toast('error', e.message); return; }
  const fmt = s.image.format;
  const out = outputPath(s.general, { kind: 'image', targetName: target.name, ext: fmt });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const logo = s.overlays.logo.enabled && fs.existsSync(s.overlays.logo.image) ? s.overlays.logo : null;
  try {
    if (target.device) {
      // Snapshot of the device preview, then format conversion (and logo) through ffmpeg.
      const png = path.join(os.tmpdir(), `capturepro-snap-${process.pid}.png`);
      fs.writeFileSync(png, await device.snapshot());
      const vf = logo ? null : (fmt === 'jpg' ? 'format=yuvj444p' : fmt === 'bmp' ? 'format=bgr24' : 'format=rgb24');
      const args = logo
        ? ['-loglevel', 'error', '-i', png, '-i', logo.image, '-filter_complex', `[1:v]format=rgba,colorchannelmixer=aa=${logo.opacity / 100}[l];[0:v][l]overlay=W-w-${logo.marginX}:${logo.marginY}`, '-frames:v', '1', out]
        : ['-loglevel', 'error', '-i', png, '-vf', vf, '-frames:v', '1', ...(fmt === 'jpg' ? ['-q:v', String(Math.round(31 - 29 * s.image.jpgQuality / 100))] : []), out];
      await ffmpeg.run(args, { timeoutMs: 15000 });
      fs.rm(png, () => {});
    } else {
      const args = buildImageArgs({ source: target.source, showCursor: s.image.showCursor, format: fmt, jpgQuality: s.image.jpgQuality, logo, output: out });
      await ffmpeg.run(args.slice(3), { timeoutMs: 15000 });
    }
  } catch (e) {
    toast('error', `Failed to capture image. Please check your output folder.\n${e.message}`);
    return;
  }
  if (s.image.shutterSound) playSound('shutter');
  if (s.image.copyToClipboard) clipboard.writeImage(nativeImage.createFromPath(out));
  broadcast('outputs:changed', {});
  broadcast('toast', { type: 'info', message: `Image saved: ${path.basename(out)}` });
}

function applyImageRepeat() {
  clearInterval(imageRepeatTimer);
  const r = settings.get().image.repeat;
  if (r.enabled && r.sec >= 1) imageRepeatTimer = setInterval(() => captureImage(), r.sec * 1000);
}

// ---------------------------------------------------------------------------- game mode target tracking
setInterval(async () => {
  if (!helper || settings.get().mode !== 'game' || recorder.state !== 'idle') return;
  const fg = await helper.foreground().catch(() => null);
  if (fg && fg.pid !== process.pid && fg.class !== 'Progman' && fg.class !== 'WorkerW' && fg.class !== 'Shell_TrayWnd') {
    lastGameTarget = fg;
    broadcast('game:target', { exe: fg.exe, title: fg.title, w: fg.w, h: fg.h, fullscreen: fg.fullscreen });
  }
}, 1000);

// ---------------------------------------------------------------------------- IPC
function registerIpc() {
  ipcMain.handle('app:init', async () => ({
    settings: settings.get(),
    version: app.getVersion(),
    ffmpegPath: ffmpeg.getPath(),
    platform: process.platform,
    available: [...available],
    videoCodecs: codecs.VIDEO_CODECS,
    audioCodecs: codecs.AUDIO_CODECS,
    encoderLabels: codecs.ENCODER_LABELS,
    presets: codecs.BUILTIN_PRESETS,
    displays: (await helper.monitors().catch(() => [])).map((m, i) => ({ index: i, label: `Display ${i + 1} (${m.w}×${m.h})${m.primary ? ' – primary' : ''}` })),
    recStatus: { ...recorder.stats(), mute: rec.mute, free: freeBytes(settings.get().general.outputDir) },
  }));

  ipcMain.handle('settings:update', (_e, patch) => settings.update(patch));
  ipcMain.handle('settings:reset', () => settings.reset());

  ipcMain.handle('rec:toggle', () => toggleRecording());
  ipcMain.handle('rec:pause', () => togglePause());
  ipcMain.handle('rec:stop', () => stopRecording());
  ipcMain.handle('rec:cancel', () => cancelRecording());
  ipcMain.handle('rec:mute', (_e, which, value) => setMute(which, value));
  ipcMain.handle('image:capture', () => captureImage());

  ipcMain.handle('windows:list', async () => {
    const [wins, sources] = await Promise.all([
      helper.windows(),
      desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 320, height: 180 } }),
    ]);
    const thumbs = new Map(sources.map((s) => [Number(s.id.split(':')[1]), s.thumbnail.toDataURL()]));
    return wins.filter((w) => w.pid !== process.pid && w.w > 50 && w.h > 50)
      .map((w) => ({ hwnd: w.hwnd, title: w.title, exe: w.exe, w: w.w, h: w.h, thumb: thumbs.get(w.hwnd) || null }));
  });

  ipcMain.handle('outputs:list', (_e, kind, sort) => outputs.list(settings.get().general.outputDir, kind, sort));
  ipcMain.handle('outputs:thumb', (_e, file) => outputs.thumbnailFor(file, path.join(app.getPath('userData'), 'thumbs')));
  ipcMain.handle('outputs:open', (_e, file) => shell.openPath(file));
  ipcMain.handle('outputs:reveal', (_e, file) => shell.showItemInFolder(file));
  ipcMain.handle('outputs:openFolder', () => openOutputFolder());
  ipcMain.handle('outputs:delete', async (_e, files) => { for (const f of files) await shell.trashItem(f); broadcast('outputs:changed', {}); });
  ipcMain.handle('outputs:rename', (_e, file, name) => { const p = outputs.rename(file, name); broadcast('outputs:changed', {}); return p; });
  ipcMain.handle('outputs:info', (_e, file) => ffmpeg.probe(file));

  ipcMain.handle('dialog:folder', async () => {
    const r = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.get().general.outputDir });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:image', async () => {
    const r = await dialog.showOpenDialog(mainWin, { properties: ['openFile'], filters: [{ name: 'PNG Files', extensions: ['png'] }] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('hotkey:capture', () => new Promise((resolve) => {
    if (hotkeyCapture) hotkeyCapture(undefined); // a previous field was still listening: release it
    hotkeyCapture = resolve;
    setTimeout(() => { if (hotkeyCapture === resolve) { hotkeyCapture = null; resolve(undefined); } }, 15000);
  }));
  ipcMain.handle('hotkey:cancel', () => { if (hotkeyCapture) { const r = hotkeyCapture; hotkeyCapture = null; r(undefined); } });
  ipcMain.handle('shell:external', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });

  ipcMain.handle('win:minimize', () => mainWin.minimize());
  ipcMain.handle('win:close', () => mainWin.close());
  ipcMain.handle('win:tray', () => mainWin.hide());

  // capture frame (rectangle mode)
  ipcMain.handle('rect:getBounds', () => rectWin.getBounds());
  ipcMain.handle('rect:setInterior', (_e, r) => {
    if (recorder.state !== 'idle') return;
    rectWin.setBounds(rectWindowBounds(clampRect(r)));
    saveRectFromWindow();
  });
  ipcMain.handle('rect:setSize', (_e, w, h) => {
    const cur = interiorFromWindow(rectWin.getBounds());
    const scale = screen.getDisplayMatching(rectWin.getBounds()).scaleFactor;
    rectWin.setBounds(rectWindowBounds(clampRect({ x: cur.x, y: cur.y, w: Math.round(w / scale), h: Math.round(h / scale) })));
    saveRectFromWindow();
  });
  ipcMain.handle('rect:fullscreen', () => {
    const d = screen.getDisplayMatching(rectWin.getBounds()).workArea;
    rectWin.setBounds(rectWindowBounds(clampRect({ x: d.x, y: d.y + RECT_BAR, w: d.width, h: d.height - RECT_BAR })));
    saveRectFromWindow();
  });
  ipcMain.on('rect:ignoreMouse', (_e, ignore) => rectWin?.setIgnoreMouseEvents(ignore, { forward: true }));
  ipcMain.handle('rect:hide', () => { rectWin.userHidden = true; updateRectVisibility(); });

  // timer & scheduled recording
  ipcMain.handle('timer:get', () => timerStatus());
  ipcMain.handle('timer:set', (_e, t) => {
    settings.update({ timer: t });
    const now = new Date();
    if (t.mode === 'at') {
      const [h, m] = String(t.at || '00:00').split(':').map(Number);
      timerAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
      if (timerAt <= now) timerAt = new Date(timerAt.getTime() + 86400000);
    } else {
      timerAt = new Date(now.getTime() + Math.max(1, Math.min(1440, Number(t.startIn) || 1)) * 60000);
    }
    broadcast('timer:status', timerStatus());
    return timerStatus();
  });
  ipcMain.handle('timer:cancel', () => { timerAt = null; broadcast('timer:status', null); });
  ipcMain.handle('schedules:list', () => scheduleList());
  ipcMain.handle('schedules:save', (_e, sc) => {
    const err = scheduler.validate(sc);
    if (err) return { error: err };
    const list = settings.get().schedules;
    const clash = sc.active && scheduler.overlapping(sc, list);
    if (clash) return { error: `The recording time overlaps with "${clash}".` };
    const i = list.findIndex((x) => x.id === sc.id);
    const next = [...list];
    if (i >= 0) next[i] = sc; else next.push({ ...sc, id: sc.id || `s${Date.now().toString(36)}` });
    settings.update({ schedules: next });
    return { ok: true };
  });
  ipcMain.handle('schedules:delete', (_e, ids) => { settings.update({ schedules: settings.get().schedules.filter((x) => !ids.includes(x.id)) }); });
  ipcMain.handle('rect:current', () => (rectWin ? interiorFromWindow(rectWin.getBounds()) : settings.get().target.rect));

  // drawing mode
  ipcMain.handle('draw:toggle', () => toggleDrawing());
  ipcMain.on('overlay:setDraw', (_e, d) => {
    Object.assign(drawState, d, { enabled: drawState.enabled });
    overlays.broadcast('overlay:draw', { ...drawState });
    overlays.setInteractive(drawState.enabled && drawState.tool !== 'cursor');
    raiseDrawbar(false);
  });
  ipcMain.on('overlay:strokeEnd', () => raiseDrawbar(!overlays.typing()));
  ipcMain.on('overlay:keyboard', (e, on) => {
    overlays.setKeyboard(BrowserWindow.fromWebContents(e.sender), on);
    if (!on) raiseDrawbar(); // typing finished: the toolbar gets the keyboard back
  });
  ipcMain.on('overlay:drawCmd', (_e, cmd) => (cmd === 'exit' ? toggleDrawing(false) : overlays.broadcast('overlay:drawCmd', cmd)));

  // device recording window
  ipcMain.on('device:chunk', (_e, buf) => device.chunk(buf));
  ipcMain.on('device:ack', (_e, name, value) => device.resolve(name, value));
  ipcMain.on('device:zoom', (_e, w, h) => {
    if (!device.win || !w) return;
    const sf = screen.getDisplayMatching(device.win.getBounds()).scaleFactor;
    device.win.setContentSize(Math.round(w / sf), Math.round(h / sf) + 39);
  });
  ipcMain.on('device:fullscreen', () => device.win?.setFullScreen(!device.win.isFullScreen()));
  ipcMain.on('device:hide', () => device.win?.hide());
  ipcMain.handle('device:show', () => device.sync());

  // webcam overlay
  ipcMain.on('webcam:aspect', (_e, a) => webcam.setCameraAspect(a));
  ipcMain.on('webcam:dragStart', () => webcam.dragStart());
  ipcMain.on('webcam:dragMove', (_e, dx, dy) => webcam.dragMove(dx, dy));
  ipcMain.on('webcam:dragEnd', () => webcam.dragEnd());
  ipcMain.on('webcam:resize', (_e, dir) => webcam.resize(dir));
  ipcMain.on('webcam:chunk', (_e, buf) => webcam.chunk(buf));
  ipcMain.on('webcam:recordDone', () => webcam.recordDone());

  // audio engine
  ipcMain.on('audio:pcm', (_e, track, buf) => recorder.writeAudio(track, Buffer.from(buf)));
  ipcMain.on('audio:level', (_e, levels) => {
    rec.levels = levels;
    if (Math.max(levels.speaker || 0, levels.mic || 0) > 0.01) rec.lastSoundAt = Date.now();
  });
}

// ---------------------------------------------------------------------------- startup
app.whenReady().then(async () => {
  settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
  fs.mkdirSync(settings.get().general.outputDir, { recursive: true });

  helper = new Helper(HELPER_EXE);
  // macOS only: global hotkeys and click effects need the Input Monitoring permission.
  helper.on('permission', () => toast('warn', 'To use hotkeys, click effects and keystrokes on macOS, allow CapturePro in System Settings → Privacy & Security → Input Monitoring, then restart CapturePro.'));
  helper.on('error', (e) => {
    logError('helper', e);
    toast('error', `The CapturePro helper could not start (${e.message}). Hotkeys and window selection won't work; try reinstalling or allowing it in your antivirus.`);
  });
  overlays = new Overlays({ preload: PRELOAD, rendererDir: RENDERER });
  overlays.on('close-request', () => toggleDrawing(false));
  overlays.on('shown', () => { if (drawState.enabled) raiseDrawbar(); });
  webcam = new Webcam({ preload: PRELOAD, rendererDir: RENDERER, settings, getRegion: () => previewRegion() });
  device = new Device({ preload: PRELOAD, rendererDir: RENDERER, settings });

  helper.on('press', onHotkey);
  helper.on('press', (k) => {
    if (recorder.state === 'recording' && settings.get().overlays.keystroke.enabled) overlays.broadcast('overlay:key', { text: keystrokeText(k) });
  });
  helper.on('key', onPushToTalk);
  helper.on('mouse', (m) => {
    if (recorder.state !== 'recording') return;
    overlays.mouse(m);
    if (m.type === 'down' && settings.get().overlays.mouse.clickSound) playSound(m.btn === 'right' ? 'rclick' : 'click');
  });
  helper.start();
  helper.monitors().then((m) => { monitorsCache = m; }).catch(() => {});

  // Only our own local pages are loaded, so media permission checks can be granted. This also lets
  // enumerateDevices() return real device ids/labels without first opening a camera or microphone.
  const isOwnPage = (url) => String(url || '').startsWith('file://');
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => permission === 'media' && isOwnPage(origin || wc?.getURL()));
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(['media', 'display-capture'].includes(permission) && isOwnPage(wc.getURL())));

  // System-audio loopback for the audio engine (getDisplayMedia → WASAPI loopback).
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((s) => cb({ video: s[0], audio: 'loopback' })).catch(() => cb({}));
  });

  if (!ffmpeg.locate(process.resourcesPath)) {
    dialog.showErrorBox('CapturePro', 'FFmpeg was not found. Install FFmpeg (e.g. "winget install Gyan.FFmpeg") and restart CapturePro.');
  } else {
    available = await ffmpeg.detectEncoders(path.join(app.getPath('userData'), 'encoders.json'));
    filterCaps = ffmpeg.detectFilters(['zmq']);
  }

  registerIpc();
  createAudioWindow();
  createMainWindow();
  createRectWindow();
  createTray();
  rectWin.webContents.once('did-finish-load', () => updateRectVisibility());
  applyImageRepeat();

  settings.onChange((s, patch) => {
    if (!patch || patch.mode) { if (rectWin) rectWin.userHidden = false; updateRectVisibility(); }
    if (!patch || patch.general) {
      mainWin.setAlwaysOnTop(!!s.general.alwaysOnTop);
      app.setLoginItemSettings({ openAtLogin: !!s.general.runOnStartup, args: ['--minimized'] });
    }
    if (!patch || patch.video) applyMainProtection();
    if (!patch || patch.image) applyImageRepeat();
    if (!patch || patch.target) { if (rectWin && patch?.target?.rect === undefined) sendRectInfo(); }
    if (!patch || patch.mode || patch.target || patch.overlays?.webcam) webcam.sync();
    if (!patch || patch.mode) device.sync();
    broadcast('settings:changed', s);
  });
  webcam.sync();
  device.sync();

  if (settings.get().general.recordOnStartup) {
    settings.update({ mode: 'full' });
    setTimeout(() => startRecording(), 1500);
  }
});

app.on('second-instance', () => showMain());
// macOS: Cmd+Q / Dock "Quit" goes through the same confirmation as closing the window while recording.
app.on('before-quit', (e) => {
  if (app.isQuitting || !mainWin || mainWin.isDestroyed()) return;
  e.preventDefault();
  mainWin.close();
});
app.on('activate', () => { if (mainWin && !mainWin.isDestroyed()) showMain(); }); // Dock icon click
app.on('window-all-closed', () => {});
