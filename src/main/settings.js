// Persistent settings: a JSON file in userData, deep-merged over defaults so new keys appear on upgrade.
const fs = require('fs');
const path = require('path');
const os = require('os');

const defaults = () => ({
  mode: 'rect', // rect | full | window | mouse | game | device | audio
  general: {
    outputDir: path.join(os.homedir(), 'Documents', 'CapturePro'),
    alwaysOnTop: false,
    startMinimized: false,
    runOnStartup: false,
    recordOnStartup: false,
    trayNotifications: true,
    subfolder: 'none', // none | target | type | date
    namePrefix: 'target', // target | custom | none
    customPrefix: 'CapturePro',
    nameSuffix: 'datetime', // datetime | sequence
  },
  target: {
    rect: { x: 200, y: 150, w: 1280, h: 720 }, // DIP
    display: 0, // monitor index, -1 = all displays
    mouseSize: { w: 1280, h: 720 },
    window: null, // { hwnd, title, exe }
    recentSizes: [],
    sizePresets: [],
  },
  video: {
    captureMethod: 'wgc', // wgc (Windows.Graphics.Capture) | dda (Desktop Duplication) | gdi
    showCursor: true,
    container: 'mp4', // mp4 | avi | mkv
    codec: 'h264', // h264 | hevc | av1 | mpeg1 | xvid | mjpeg
    encoder: 'auto', // auto | cpu | nvenc | qsv | amf
    fps: 30,
    fpsMode: 'vfr', // vfr | cfr
    size: 'full', // full | half | fitWidth | fitHeight | custom
    width: 1280,
    height: 720,
    rateControl: 'vbr', // vbr (quality) | cbr (bitrate)
    quality: 80, // 0..100
    bitrate: 8000, // kbps
    keyframeSec: 2,
    optimize: 'balanced', // speed | balanced | size
    countdown: 0,
    hideMainWindow: false,
    excludeOwnWindows: true,
    soundEffects: true,
    openPlayerAfter: false,
    autoPause: { enabled: false, idleSec: 10 },
    priority: 'normal', // normal | high | highest
  },
  audio: {
    enabled: true,
    speaker: { enabled: true, volume: 100, mono: false },
    mic: { enabled: false, deviceId: 'default', volume: 100, mono: false, noiseSuppression: 'off' },
    mix: true, // mix speaker+mic into one track; false = two tracks
    saveTracksAsFiles: false,
    pushTo: { enabled: false, mode: 'talk', key: 'CapsLock' },
    codec: 'aac', // aac | mp3 | mp2 | pcm
    bitrate: 192,
    sampleRate: 48000,
    channels: 2,
    audioOnlyFormat: 'mp3', // mp3 | wav
  },
  image: {
    format: 'png', // png | jpg | bmp
    jpgQuality: 90,
    showCursor: true,
    repeat: { enabled: false, sec: 5 },
    shutterSound: true,
    copyToClipboard: false,
  },
  hotkeys: {
    record: 'F12',
    pause: 'Shift+F12',
    cancel: '',
    image: 'F11',
    muteSpeaker: '',
    muteMic: '',
    toggleDraw: 'Ctrl+Alt+D',
    toggleRect: 'Ctrl+Alt+H',
  },
  overlays: {
    webcam: {
      enabled: false, deviceId: 'default', size: 25, position: 'bottom-right', x: null, y: null,
      flip: 'none', rotate: 0, shape: 'circle', border: { style: 'solid', width: 4, color: '#ffffff' },
      background: { mode: 'original', image: '', chroma: { color: '#00ff00', similarity: 40, blend: 10 } },
    },
    logo: { enabled: false, image: '', opacity: 80, position: 'top-right', marginX: 16, marginY: 16 },
    mouse: {
      clickEffect: false, clickSize: 40, leftColor: '#ffd400', rightColor: '#3da9ff',
      highlight: false, highlightSize: 60, highlightColor: '#ffff00', highlightOpacity: 35,
      clickSound: false,
    },
    keystroke: { enabled: false, size: 'medium', position: 'bottom-center' },
    texts: [], // { text, font, size, color, alpha, shadow, outline, position, margin }
  },
  autoComplete: { mode: 'off', timeSec: 3600, sizeMB: 4096, silenceSec: 60, silencePopup: true, after: 'nothing' },
  timer: { enabled: false, startIn: 10, startAt: null, minimizeOnStart: true },
  schedules: [],
  presets: [], // user-defined format presets { name, video:{...}, audio:{...} }
  ui: { lastPage: 'home' },
});

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = k in base ? merge(base[k], over[k]) : over[k];
  return out;
}

class Settings {
  constructor(file) {
    this.file = file;
    this.data = defaults();
    try { this.data = merge(defaults(), JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* first run */ }
    this.listeners = new Set();
  }

  get() { return this.data; }

  // Patch with a partial object, e.g. { video: { fps: 60 } }.
  update(patch) {
    this.data = merge(this.data, patch);
    this.save();
    for (const fn of this.listeners) fn(this.data, patch);
    return this.data;
  }

  reset() {
    this.data = defaults();
    this.save();
    for (const fn of this.listeners) fn(this.data, null);
    return this.data;
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Settings, defaults, merge };
