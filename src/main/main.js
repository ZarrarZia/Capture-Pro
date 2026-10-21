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
const { toPhysical, toDip, regionSource, displaySource, sourceRect } = require('./targets');
const outputs = require('./outputs');
const { Overlays } = require('./overlays');
const { Webcam } = require('./webcam');

const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const PRELOAD = path.join(ROOT, 'src', 'preload', 'preload.js');
const ICON = path.join(ROOT, 'assets', 'icon.png');
const RECT_BAR = 34; // DIP height of the capture frame's control bar
const RECT_BORDER = 3;

if (process.env.CAPTUREPRO_USER_DATA) app.setPath('userData', process.env.CAPTUREPRO_USER_DATA); // isolated profiles for tests
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId('com.capturepro.app');

let settings, helper, tray;
let mainWin, audioWin, rectWin;
let available = new Set();
const recorder = new Recorder();
const rec = { mode: null, targetName: '', file: null, startedAt: 0, lastSoundAt: 0, levels: { speaker: 0, mic: 0 }, mute: { speaker: false, mic: false }, tmpFiles: [] };
let lastGameTarget = null;
let hotkeyCapture = null;
let imageRepeatTimer = null;
let overlays, webcam, drawbarWin;
let monitorsCache = [];
const drawState = { enabled: false, tool: 'pen', color: '#ff3b48', width: 4, whiteboard: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCREEN_MODES = ['rect', 'full', 'window', 'mouse', 'game'];

// ---------------------------------------------------------------------------- windows
// WDA_EXCLUDEFROMCAPTURE set on a hidden window is lost when it is shown, so re-apply on every show.
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
  rectWin.on('moved', () => saveRectFromWindow());
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
  const p = toPhysical(r);
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

function toast(type, message) {
  broadcast('toast', { type, message });
  if (type === 'error' && mainWin && !mainWin.isVisible()) dialog.showErrorBox('CapturePro', message);
}

function notify(title, body, onClick) {
  if (!settings.get().general.trayNotifications || !Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON, silent: true });
  if (onClick) n.on('click', onClick);
  n.show();
}

function playSound(name) { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('sound', name); }

// ---------------------------------------------------------------------------- tray
function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(ROOT, 'assets', 'tray.png')));
  tray.setToolTip('CapturePro');
  tray.on('click', () => showMain());
  refreshTray();
}

function refreshTray() {
  if (!tray) return;
  const active = recorder.state !== 'idle';
  tray.setImage(nativeImage.createFromPath(path.join(ROOT, 'assets', active ? 'tray-rec.png' : 'tray.png')));
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
function quit() { app.isQuitting = true; helper?.stop(); app.quit(); }
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
    ipcMain.once('audio:started', (_e, res) => { clearTimeout(t); resolve(res.ok ? true : res.error); });
    audioWin.webContents.send('audio:start', {
      speaker: plan.speaker ? s.audio.speaker : null, mic: plan.mic ? s.audio.mic : null,
      tracks: plan.tracks, mute: rec.mute,
      micOpen: !(s.audio.pushTo.enabled && s.audio.pushTo.mode === 'talk'),
    });
  });
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
      const c = screen.dipToScreenPoint(screen.getCursorScreenPoint());
      const sz = s.target.mouseSize;
      return withRect({ source: regionSource(monitors, { x: Math.round(c.x - sz.w / 2), y: Math.round(c.y - sz.h / 2), w: sz.w, h: sz.h }, method), name: 'Screen' });
    }
    case 'window': {
      const w = s.target.window;
      if (!w) throw new Error('Please select a window to record first (Home → Specific window).');
      const live = (await helper.windows()).find((x) => x.hwnd === w.hwnd);
      if (!live) throw new Error(`The window "${w.title}" is no longer open. Please select it again.`);
      return { source: { kind: 'wgc-window', hwnd: w.hwnd }, name: live.exe || 'Window', regionPhys: live };
    }
    case 'game': {
      const fg = await helper.foreground().catch(() => null);
      const target = fg && fg.pid !== process.pid && fg.class !== 'Progman' && fg.class !== 'WorkerW' ? fg : lastGameTarget;
      if (!target) throw new Error('No game window detected. Start your game, then press the record hotkey while it is in front.');
      return { source: { kind: 'wgc-window', hwnd: target.hwnd }, name: target.exe || 'Game', regionPhys: target };
    }
    case 'audio':
      return { source: null, name: 'Audio' };
    default:
      throw new Error('Device recording is not available yet.');
  }
}

async function startRecording() {
  if (recorder.state !== 'idle') return;
  const s = settings.get();
  const audioOnly = s.mode === 'audio';
  if (rec.counting) return;
  let target;
  try { target = await resolveTarget(s); } catch (e) { toast('error', e.message); return; }
  rec.regionDip = target.regionPhys ? toDip(target.regionPhys) : null;

  // Countdown on the capture-visible overlay; it disappears before the first frame is captured.
  if (!audioOnly && s.video.countdown > 0) {
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

  const aplan = audioPlan(s, audioOnly);
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

  const plan = (enc) => ({
    finalPath, container, audioTracks: aplan.tracks, priority: s.video.priority,
    splitTracks: s.audio.saveTracksAsFiles && !audioOnly,
    buildArgs: (seg, pipes) => buildRecordArgs({
      source: target.source, showCursor: s.video.showCursor, video: s.video, audio, ffEncoder: enc,
      container, audioPipes: pipes, logo, texts, output: seg,
    }),
  });

  try {
    await recorder.start(plan(ffEncoder));
  } catch (e) {
    if (ffEncoder && /_(nvenc|qsv|amf)$/.test(ffEncoder) && available.has('libx264') && s.video.codec === 'h264') {
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
  toast('error', `Failed to start video capture.\n${e.message}`);
}

async function stopRecording() {
  if (recorder.state === 'idle' || recorder.state === 'stopping') return;
  const s = settings.get();
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
  if (recorder.state === 'idle') return;
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
  return recorder.state === 'idle' ? startRecording() : stopRecording();
}
function togglePause() {
  if (recorder.state === 'recording') { webcam.pause(true); return recorder.pause().then(() => broadcastStatus()); }
  if (recorder.state === 'paused') { webcam.pause(false); return recorder.resume().then(() => broadcastStatus()); }
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
  drawState.enabled = on;
  if (on) {
    updateOverlays();
    overlays.setInteractive(drawState.tool !== 'cursor');
    showDrawbar();
  } else {
    overlays.broadcast('overlay:drawCmd', 'clear');
    overlays.setInteractive(false);
    drawbarWin?.hide();
    updateOverlays();
  }
  broadcast('draw:state', drawState.enabled);
}

function showDrawbar() {
  if (!drawbarWin || drawbarWin.isDestroyed()) {
    const wa = screen.getPrimaryDisplay().workArea;
    drawbarWin = new BrowserWindow({
      width: 860, height: 46, x: Math.round(wa.x + (wa.width - 860) / 2), y: wa.y + 12,
      frame: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnTop: true, show: false, hasShadow: false,
      webPreferences: { preload: PRELOAD },
    });
    drawbarWin.setAlwaysOnTop(true, 'screen-saver');
    protectFromCapture(drawbarWin, () => true);
    drawbarWin.loadFile(path.join(RENDERER, 'drawbar', 'drawbar.html'));
    drawbarWin.once('ready-to-show', () => drawbarWin.show());
  } else {
    drawbarWin.show();
  }
}

function keystrokeText(k) {
  if (!k.accel) return null;
  return k.accel.split('+').map((p) => (p.length === 1 ? p.toUpperCase() : p)).join(' + ');
}

recorder.on('state', () => { broadcastStatus(); refreshTray(); });
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

async function autoComplete(after) {
  await stopRecording();
  switch (after) {
    case 'new': setTimeout(() => startRecording(), 300); break;
    case 'exit': quit(); break;
    case 'shutdown': execFile('shutdown', ['/s', '/t', '60', '/c', 'CapturePro: recording finished. Run "shutdown /a" to cancel.']); break;
    case 'hibernate': execFile('shutdown', ['/h']); break;
    default: break;
  }
}

// ---------------------------------------------------------------------------- image capture
async function captureImage() {
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
    const args = buildImageArgs({ source: target.source, showCursor: s.image.showCursor, format: fmt, jpgQuality: s.image.jpgQuality, logo, output: out });
    await ffmpeg.run(args.slice(3), { timeoutMs: 15000 });
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

  // drawing mode
  ipcMain.handle('draw:toggle', () => toggleDrawing());
  ipcMain.on('overlay:setDraw', (_e, d) => {
    Object.assign(drawState, d, { enabled: drawState.enabled });
    overlays.broadcast('overlay:draw', { ...drawState });
    overlays.setInteractive(drawState.enabled && drawState.tool !== 'cursor');
  });
  ipcMain.on('overlay:drawCmd', (_e, cmd) => (cmd === 'exit' ? toggleDrawing(false) : overlays.broadcast('overlay:drawCmd', cmd)));

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

  helper = new Helper(path.join(ROOT, 'native', 'bin', 'CaptureProHelper.exe'));
  overlays = new Overlays({ preload: PRELOAD, rendererDir: RENDERER });
  webcam = new Webcam({ preload: PRELOAD, rendererDir: RENDERER, settings, getRegion: () => previewRegion() });

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

  // System-audio loopback for the audio engine (getDisplayMedia → WASAPI loopback).
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((s) => cb({ video: s[0], audio: 'loopback' })).catch(() => cb({}));
  });

  if (!ffmpeg.locate(process.resourcesPath)) {
    dialog.showErrorBox('CapturePro', 'FFmpeg was not found. Install FFmpeg (e.g. "winget install Gyan.FFmpeg") and restart CapturePro.');
  } else {
    available = await ffmpeg.detectEncoders(path.join(app.getPath('userData'), 'encoders.json'));
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
    broadcast('settings:changed', s);
  });
  webcam.sync();

  if (settings.get().general.recordOnStartup) {
    settings.update({ mode: 'full' });
    setTimeout(() => startRecording(), 1500);
  }
});

app.on('second-instance', () => showMain());
app.on('window-all-closed', () => {});
