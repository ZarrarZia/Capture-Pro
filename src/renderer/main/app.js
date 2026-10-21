// CapturePro main window.
const api = window.capturepro;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fileUrl = (p) => 'file:///' + encodeURI(p.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F');

let APP = null; // init payload
let S = null;   // current settings
let page = 'home';
let status = { state: 'idle', elapsedMs: 0, bytes: 0 };
let gameTarget = null;

// ------------------------------------------------------------------ icons
const I = {
  rect: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5.5" width="17" height="13" rx="1.5" stroke-dasharray="3 2"/></svg>',
  full: '<svg viewBox="0 0 24 24"><rect x="2.5" y="4" width="19" height="13" rx="1.5"/><path d="M8 20.5h8M12 17v3.5"/></svg>',
  window: '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="1.5"/><path d="M3 8.5h18M6 6.5h.1M8.5 6.5h.1"/></svg>',
  mouse: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="1.5" stroke-dasharray="3 2"/><path d="M11 10l6 2.2-2.6 1 -1 2.6z"/></svg>',
  game: '<svg viewBox="0 0 24 24"><path d="M6.5 8h11a3.5 3.5 0 013.4 4.3l-1 4a2.4 2.4 0 01-4.1 1L14.5 16h-5l-1.3 1.3a2.4 2.4 0 01-4.1-1l-1-4A3.5 3.5 0 016.5 8z"/><path d="M8 11v3M6.5 12.5h3M15.5 12h.1M17 13.5h.1"/></svg>',
  device: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10.5l5-3v9l-5-3"/></svg>',
  audio: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21"/></svg>',
  spk: '<svg viewBox="0 0 20 20"><path d="M3.5 7.5h3l4-3.5v12l-4-3.5h-3z"/><path d="M13.5 7a4 4 0 010 6M15.5 5a7 7 0 010 10"/></svg>',
  spkOff: '<svg viewBox="0 0 20 20"><path d="M3.5 7.5h3l4-3.5v12l-4-3.5h-3z"/><path d="M13.5 7.5l4 5M17.5 7.5l-4 5"/></svg>',
  mic: '<svg viewBox="0 0 20 20"><rect x="7" y="2.5" width="6" height="10" rx="3"/><path d="M4.5 9.5a5.5 5.5 0 0011 0M10 15v2.5"/></svg>',
  micOff: '<svg viewBox="0 0 20 20"><rect x="7" y="2.5" width="6" height="10" rx="3"/><path d="M4.5 9.5a5.5 5.5 0 0011 0M10 15v2.5M3 3l14 14"/></svg>',
  play: '<svg viewBox="0 0 20 20"><path d="M6 4l10 6-10 6z"/></svg>',
};

const MODES = [
  { id: 'rect', label: 'Rectangle', title: 'Screen Recording – Rectangle on a screen', desc: 'Record a part of the screen inside a resizable capture frame.', steps: ['Move and resize the capture frame to the area you want to record.', 'Click REC or press the record hotkey.'] },
  { id: 'full', label: 'Fullscreen', title: 'Screen Recording – Fullscreen', desc: 'Record a whole monitor, or all monitors at once.', steps: ['Choose the display to capture.', 'Click REC or press the record hotkey.'] },
  { id: 'window', label: 'Window', title: 'Screen Recording – Specific window', desc: 'Record one window, even when other windows cover it.', steps: ['Choose a window to capture.', 'Click REC or press the record hotkey.'] },
  { id: 'mouse', label: 'Around mouse', title: 'Screen Recording – Around mouse', desc: 'Record an area centred on the mouse cursor when recording starts.', steps: ['Choose the capture size.', 'Click REC or press the record hotkey.'] },
  { id: 'game', label: 'Game', title: 'Game Recording', desc: 'Record the game (or any app) that is in front when you press the record hotkey.', steps: ['Start your game and bring it to the front.', 'Press the record hotkey (the REC button records the last active app).'] },
  { id: 'device', label: 'Device', title: 'Device Recording', desc: 'Record webcams and HDMI capture devices.', steps: ['Coming in the next CapturePro phase.'] },
  { id: 'audio', label: 'Audio only', title: 'Audio-only Recording', desc: 'Record only the computer sound and/or microphone.', steps: ['Choose the sound sources below.', 'Click REC or press the record hotkey.'] },
];

// ------------------------------------------------------------------ settings binding
function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function patchFor(path, value) {
  const keys = path.split('.');
  const root = {};
  keys.reduce((o, k, i) => (o[k] = i === keys.length - 1 ? value : {}), root);
  return root;
}
async function set(path, value) {
  S = await api.settings.update(patchFor(path, value));
  return S;
}

function readControl(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.dataset.t === 'num' || el.type === 'number' || el.type === 'range') return Number(el.value);
  return el.value;
}

function bindPage(root) {
  for (const el of $$('[data-k]', root)) {
    if (!el.dataset.k) continue;
    const v = getPath(S, el.dataset.k);
    if (el.type === 'checkbox') el.checked = !!v; else if (v !== undefined && v !== null) el.value = v;
    el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', async () => {
      let val = readControl(el);
      if (el.type === 'number' && (Number.isNaN(val) || el.value === '')) return;
      if (el.type === 'number') val = Math.min(Number(el.max || Infinity), Math.max(Number(el.min || -Infinity), val));
      await set(el.dataset.k, val);
      if (el.dataset.rerender !== undefined) render();
      const out = el.dataset.out && $(`#${el.dataset.out}`, root);
      if (out) out.textContent = el.value;
    });
  }
  for (const el of $$('.hotkey[data-hk]', root)) {
    el.textContent = getPath(S, el.dataset.hk) || '(None)';
    el.addEventListener('click', async () => {
      el.classList.add('listening');
      el.textContent = 'Press a key… (Esc cancels, Backspace clears)';
      const accel = await api.hotkey.capture();
      el.classList.remove('listening');
      if (accel !== undefined && accel !== null) {
        const others = Object.entries(S.hotkeys).filter(([k, v]) => v && v === accel && `hotkeys.${k}` !== el.dataset.hk);
        if (accel && others.length) toast('error', 'There are duplicate hotkeys. Please change the hotkey settings.');
        else await set(el.dataset.hk, accel);
      }
      el.textContent = getPath(S, el.dataset.hk) || '(None)';
    });
  }
}

// small template helpers
const opt = (v, label, cur) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(label)}</option>`;
const select = (k, options, attrs = '') => `<select data-k="${k}" ${attrs}>${options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`;
const check = (k, label, attrs = '') => `<label class="check"><input type="checkbox" data-k="${k}" ${attrs}>${label}</label>`;
const num = (k, min, max, unit = '', attrs = '') => `<input type="number" data-k="${k}" min="${min}" max="${max}" style="width:90px" ${attrs}>${unit ? `<span class="unit">${unit}</span>` : ''}`;
const row = (label, html) => `<div class="row"><span class="lbl">${label}</span>${html}</div>`;
const hotkey = (k, label) => row(label, `<button class="hotkey" data-hk="${k}"></button>`);
const range = (k, min, max, id) => `<input type="range" class="grow" data-k="${k}" min="${min}" max="${max}" data-out="${id}"><span id="${id}" class="unit" style="width:34px">${getPath(S, k)}</span>`;

// ------------------------------------------------------------------ pages
const pages = {
  home() {
    const m = MODES.find((x) => x.id === S.mode) || MODES[0];
    let detail = '';
    if (m.id === 'rect') {
      detail = `<div class="section"><h2>Capture area</h2>
        <div class="row"><button class="btn primary" id="show-frame">Show capture frame</button>
        <span class="hint">Drag the frame's top bar to move it, drag its edges to resize. Arrow keys nudge, Shift+arrows resize.</span></div>
        ${row('Size presets', `<select id="rect-size">${opt('', 'Choose a size…', '')}${[[640, 360], [854, 480], [1280, 720], [1920, 1080], [640, 480], [800, 600], [1024, 768]].map(([w, h]) => opt(`${w}x${h}`, `${w} × ${h}`, '')).join('')}</select>`)}</div>`;
    } else if (m.id === 'full') {
      detail = `<div class="section"><h2>Display</h2>${row('Recording target', select('target.display', [...APP.displays.map((d) => [d.index, d.label]), [-1, 'All displays']], 'data-t="num"'))}</div>`;
    } else if (m.id === 'window') {
      const w = S.target.window;
      detail = `<div class="section"><h2>Target window</h2><div class="target-box">
        <div class="grow">${w ? `<b>${esc(w.title)}</b><div class="hint">${esc(w.exe)}.exe</div>` : '<span class="hint">No window selected.</span>'}</div>
        <button class="btn primary" id="pick-window">${w ? 'Change window' : 'Choose a window'}</button></div></div>`;
    } else if (m.id === 'mouse') {
      detail = `<div class="section"><h2>Capture size</h2>${row('Width', num('target.mouseSize.w', 64, 7680, 'px'))}${row('Height', num('target.mouseSize.h', 64, 4320, 'px'))}</div>`;
    } else if (m.id === 'game') {
      detail = `<div class="section"><h2>Recording target</h2><div id="game-target">${gameTargetHtml()}</div>
        <p class="hint">CapturePro records the game window through Windows Graphics Capture. In-game FPS overlay and FPS limiting are not available (they require injecting code into games).</p></div>`;
    } else if (m.id === 'audio') {
      detail = `<div class="section"><h2>Recording source</h2>${check('audio.speaker.enabled', 'Record computer sound')}${check('audio.mic.enabled', 'Record microphone')}
        ${row('File type', select('audio.audioOnlyFormat', [['mp3', 'MP3'], ['wav', 'WAV (uncompressed)']]))}</div>`;
    }
    return `<h1>Select the recording mode you want to use</h1><p class="lead">Hotkeys: Record/Stop <b>${esc(S.hotkeys.record || 'none')}</b> · Image capture <b>${esc(S.hotkeys.image || 'none')}</b> · Pause <b>${esc(S.hotkeys.pause || 'none')}</b></p>
      <div class="cards">${MODES.map((x) => `<button class="card ${x.id === S.mode ? 'active' : ''}" data-mode="${x.id}">${I[x.id]}<b>${esc(x.label)}</b><span>${esc(x.desc)}</span></button>`).join('')}
      <button class="card" data-goto="videos">${I.play}<b>Play &amp; Manage</b><span>Browse your recordings and screenshots.</span></button></div>
      <div class="section"><h2>${esc(m.title)}</h2><p style="margin:0 0 8px">${esc(m.desc)}</p><ol class="steps">${m.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></div>${detail}`;
  },

  general() {
    return `<h1>General</h1><p class="lead">Output folder, startup behaviour, file naming and automatic recording control.</p>
    <div class="section"><h2>Output folder</h2><div class="row"><div class="path grow" title="${esc(S.general.outputDir)}">${esc(S.general.outputDir)}</div>
      <button class="btn" id="browse-out">Browse…</button><button class="btn" id="open-out">Open</button></div>
      ${row('Subfolder', select('general.subfolder', [['none', 'None'], ['target', 'Same as recording target name'], ['type', "'Videos' / 'Images' / 'Audios'"], ['date', 'Date (YYYY-MM-DD)']]))}</div>
    <div class="section"><h2>File naming</h2>
      ${row('Prefix', select('general.namePrefix', [['target', 'Target name'], ['custom', 'Custom prefix'], ['none', 'None']], 'data-rerender'))}
      ${S.general.namePrefix === 'custom' ? row('Custom prefix', '<input class="grow" data-k="general.customPrefix" maxlength="40">') : ''}
      ${row('Suffix', select('general.nameSuffix', [['datetime', 'Date / Time'], ['sequence', 'Sequence number']], 'data-rerender'))}
      ${row('Example', `<span class="pill">${esc(exampleName())}</span>`)}</div>
    <div class="section"><h2>Options</h2><div class="grid2">
      ${check('general.alwaysOnTop', 'CapturePro window always on top')}${check('general.startMinimized', 'Start CapturePro minimized to tray')}
      ${check('general.runOnStartup', 'Run CapturePro on Windows startup')}${check('general.recordOnStartup', 'Start full-screen recording on startup')}
      ${check('general.trayNotifications', 'Show notifications when files are saved')}</div></div>
    <div class="section"><h2>Auto Complete Recording</h2>
      ${row('Stop recording', select('autoComplete.mode', [['off', 'Disabled'], ['time', 'By recording time'], ['size', 'By file size'], ['silence', 'By silent duration']], 'data-rerender'))}
      ${S.autoComplete.mode === 'time' ? row('Max time', num('autoComplete.timeSec', 1, 86400, 'seconds')) : ''}
      ${S.autoComplete.mode === 'size' ? row('Max size', num('autoComplete.sizeMB', 1, 1048576, 'MB')) : ''}
      ${S.autoComplete.mode === 'silence' ? row('Silent for', num('autoComplete.silenceSec', 5, 86400, 'seconds')) : ''}
      ${S.autoComplete.mode !== 'off' ? row('After recording', select('autoComplete.after', [['nothing', 'Do nothing'], ['new', 'Start new recording'], ['exit', 'Exit CapturePro'], ['shutdown', 'Shut down the computer'], ['hibernate', 'Hibernate the computer']])) : ''}</div>`;
  },

  video() {
    const v = S.video;
    const fam = APP.videoCodecs;
    const codecOpts = Object.entries(fam).filter(([, f]) => f.containers.includes(v.container)).map(([id, f]) => [id, f.label]);
    const kinds = Object.entries(fam[v.codec]?.encoders || {}).filter(([, ff]) => APP.available.includes(ff)).map(([k]) => [k, APP.encoderLabels[k]]);
    const aCodecs = Object.entries(APP.audioCodecs).filter(([, c]) => c.containers.includes(v.container)).map(([id, c]) => [id, c.label]);
    return `<h1>Video</h1><p class="lead">Recording options, overlays and the output format.</p>
    <div class="section"><h2>Record</h2><div class="grid2"><div>${hotkey('hotkeys.record', 'Record/Stop hotkey')}${hotkey('hotkeys.pause', 'Pause hotkey')}${hotkey('hotkeys.cancel', 'Cancel hotkey')}</div>
      <div>${check('video.showCursor', 'Show mouse cursor')}${check('video.hideMainWindow', 'Hide main window during recording')}${check('video.excludeOwnWindows', 'Exclude CapturePro windows from recording')}
      ${check('video.soundEffects', 'Play sound effects when recording starts/stops')}${check('video.openPlayerAfter', 'Open the video after recording')}</div></div>
      ${row('Countdown timer', select('video.countdown', [[0, 'Off'], ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => [n, `${n} sec`])], 'data-t="num"'))}
      ${hotkey('hotkeys.toggleDraw', 'Drawing mode hotkey')}
      ${row('Capture method', select('video.captureMethod', [['wgc', 'Windows Graphics Capture (Windows 10+, recommended)'], ['dda', 'Desktop Duplication (Windows 8+)'], ['gdi', 'GDI (compatibility)']]))}
      ${row('Recording priority', select('video.priority', [['normal', '[Normal] General task priority'], ['high', '[High] Higher than normal priority'], ['highest', '[Highest] Other tasks may be slower']]))}</div>
    <div class="section"><h2><span class="grow">Format</span>${select('', [['', 'Apply a preset…'], ...APP.presets.map((p) => [p.id, p.name]), ...S.presets.map((p, i) => [`user:${i}`, `★ ${p.name}`])], 'id="preset"')}<button class="btn" id="save-preset">Save as preset</button></h2>
      <div class="grid2"><div>
      ${row('File type', select('video.container', [['mp4', 'MP4'], ['avi', 'AVI'], ['mkv', 'MKV']], 'data-rerender'))}
      ${row('Codec', select('video.codec', codecOpts, 'data-rerender'))}
      ${row('Encoder', select('video.encoder', [['auto', 'Auto (hardware first)'], ...kinds]))}
      ${row('FPS', select('video.fps', [5, 10, 15, 20, 24, 25, 29.97, 30, 50, 59.94, 60, 90, 120, 144, 240].map((f) => [f, String(f)]), 'data-t="num"'))}
      ${row('Frame rate mode', select('video.fpsMode', [['vfr', 'VFR – Variable (recommended)'], ['cfr', 'CFR – Constant']]))}
      ${row('Size', select('video.size', [['full', 'Full size'], ['half', 'Half size'], ['fitWidth', 'Fit width'], ['fitHeight', 'Fit height'], ['custom', 'Custom']], 'data-rerender'))}
      ${['fitWidth', 'custom'].includes(v.size) ? row('Width', num('video.width', 64, 7680, 'px')) : ''}
      ${['fitHeight', 'custom'].includes(v.size) ? row('Height', num('video.height', 64, 4320, 'px')) : ''}
      </div><div>
      ${row('Rate control', select('video.rateControl', [['vbr', 'VBR – quality based'], ['cbr', 'CBR – bitrate based']], 'data-rerender'))}
      ${v.rateControl === 'vbr' ? row('Quality', range('video.quality', 0, 100, 'q-out')) : row('Bitrate', num('video.bitrate', 100, 200000, 'kbps'))}
      ${row('Optimization', select('video.optimize', [['speed', 'Faster encoding speed'], ['balanced', 'Balanced'], ['size', 'Smaller file size']]))}
      ${row('Keyframe interval', num('video.keyframeSec', 1, 30, 'seconds'))}
      ${row('Audio codec', select('audio.codec', aCodecs))}
      ${row('Audio bitrate', select('audio.bitrate', [64, 96, 128, 160, 192, 256, 320].map((b) => [b, `${b} kbps`]), 'data-t="num"'))}
      ${row('Sample rate', select('audio.sampleRate', [[44100, '44.1 kHz'], [48000, '48 kHz']], 'data-t="num"'))}
      ${row('Channels', select('audio.channels', [[2, 'Stereo'], [1, 'Mono']], 'data-t="num"'))}
      </div></div><p class="hint">Detected encoders on this PC: ${esc(APP.available.join(', ') || 'none')}</p></div>
    <div class="section"><h2>Logo overlay</h2>${check('overlays.logo.enabled', 'Add logo overlay to video and images')}
      <div class="row"><span class="lbl">Image (PNG)</span><div class="path grow">${esc(S.overlays.logo.image || 'No image selected')}</div><button class="btn" id="logo-browse">Browse…</button></div>
      <div class="grid2"><div>${row('Opacity', range('overlays.logo.opacity', 0, 100, 'lo-out'))}${row('Position', select('overlays.logo.position', POSITIONS))}</div>
      <div>${row('Left/right margin', num('overlays.logo.marginX', 0, 2000, 'px'))}${row('Top/bottom margin', num('overlays.logo.marginY', 0, 2000, 'px'))}</div></div></div>
    <div class="section"><h2><span class="grow">Text overlay</span><button class="btn" id="text-add">Add</button></h2>
      ${S.overlays.texts.length ? S.overlays.texts.map((t, i) => `<div class="row"><input type="checkbox" data-text-toggle="${i}"${t.enabled === false ? '' : 'checked'}><span class="grow">${esc(t.text)}</span><span class="pill">${esc(t.position)}</span><button class="btn" data-text-edit="${i}">Edit</button><button class="btn danger" data-text-del="${i}">Delete</button></div>`).join('') : '<p class="hint">No text overlays. Text can include {date}, {time} and {datetime}.</p>'}</div>
    <div class="section"><h2>Webcam overlay</h2>${check('overlays.webcam.enabled', 'Add webcam overlay to video (screen and game modes)', 'data-rerender')}
      ${S.overlays.webcam.enabled ? `<div class="grid2"><div>
        ${row('Webcam', '<select id="cam-device" data-k="overlays.webcam.deviceId" class="grow"><option value="default">(Default camera)</option></select>')}
        ${row('Format', select('overlays.webcam.format', [['640x480', '640 × 480'], ['1280x720', '1280 × 720'], ['1920x1080', '1920 × 1080']]))}
        ${row('Shape', select('overlays.webcam.shape', Object.entries(SHAPE_LABELS)))}
        ${row('Overlay size', range('overlays.webcam.size', 5, 100, 'ws-out'))}
        ${row('Position', select('overlays.webcam.position', [...POSITIONS, ['custom', 'Custom (drag the overlay)']]))}
        </div><div>
        ${row('Flip', select('overlays.webcam.flip', [['none', '(None)'], ['horizontal', 'Horizontal'], ['vertical', 'Vertical']]))}
        ${row('Rotate', select('overlays.webcam.rotate', [[0, '(None)'], [90, '90°'], [180, '180°'], [270, '270°']], 'data-t="num"'))}
        ${row('Border', select('overlays.webcam.border.style', [['none', '(None)'], ['solid', 'Solid'], ['faded', 'Faded']]) + num('overlays.webcam.border.width', 1, 40, 'px') + '<input type="color" data-k="overlays.webcam.border.color">')}
        ${row('Background', select('overlays.webcam.background.mode', [['original', 'Original background'], ['chroma', 'Chroma key (green screen)']], 'data-rerender'))}
        ${S.overlays.webcam.background.mode === 'chroma' ? row('Key color', '<input type="color" data-k="overlays.webcam.background.chroma.color">') + row('Similarity', range('overlays.webcam.background.chroma.similarity', 1, 100, 'cs-out')) + row('Blend', range('overlays.webcam.background.chroma.blend', 0, 100, 'cb-out')) : ''}
        </div></div>${check('overlays.webcam.saveSeparate', 'Also save the webcam recording as a separate MP4')}
        <p class="hint">Drag the webcam overlay to move it; use the mouse wheel over it to resize.</p>` : ''}</div>
    <div class="section"><h2>Mouse</h2><div class="grid2"><div>
      ${check('overlays.mouse.clickEffect', 'Add mouse click effect')}
      ${row('Click effect size', range('overlays.mouse.clickSize', 16, 120, 'cz-out'))}
      ${row('Left / right color', '<input type="color" data-k="overlays.mouse.leftColor"> <input type="color" data-k="overlays.mouse.rightColor">')}
      ${check('overlays.mouse.clickSound', 'Play mouse click sounds while recording')}</div><div>
      ${check('overlays.mouse.highlight', 'Add mouse highlight effect')}
      ${row('Highlight size', range('overlays.mouse.highlightSize', 20, 200, 'hz-out'))}
      ${row('Highlight color', '<input type="color" data-k="overlays.mouse.highlightColor">')}
      ${row('Opacity', range('overlays.mouse.highlightOpacity', 5, 100, 'ho-out'))}</div></div></div>
    <div class="section"><h2>Keystroke</h2>${check('overlays.keystroke.enabled', 'Add keystrokes to video (screen recording modes)')}
      <div class="grid2"><div>${row('Size', select('overlays.keystroke.size', [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']]))}</div>
      <div>${row('Position', select('overlays.keystroke.position', POSITIONS.filter(([p]) => !p.startsWith('middle'))))}</div></div></div>`;
  },

  image() {
    return `<h1>Image</h1><p class="lead">Screenshots of the current recording target.</p>
    <div class="section"><h2>Capture</h2>${hotkey('hotkeys.image', 'Capture hotkey')}
      <div class="row">${check('image.repeat.enabled', 'Repeat screen capture every')}${num('image.repeat.sec', 1, 3600, 'seconds')}</div>
      ${check('image.showCursor', 'Show mouse cursor')}${check('image.shutterSound', 'Enable shutter sound')}${check('image.copyToClipboard', 'Copy captured image to clipboard')}</div>
    <div class="section"><h2>Format</h2>${row('Format', select('image.format', [['png', 'PNG'], ['jpg', 'JPG'], ['bmp', 'BMP']], 'data-rerender'))}
      ${S.image.format === 'jpg' ? row('JPG quality', range('image.jpgQuality', 20, 100, 'jq-out')) : ''}
      <p class="hint">The logo overlay (Video page) is also applied to images when enabled.</p></div>`;
  },

  audio() {
    const a = S.audio;
    return `<h1>Audio</h1><p class="lead">Sound devices for video and audio-only recording.</p>
    <div class="section"><h2>Sound</h2>${check('audio.enabled', 'Record sound with video')}
      <div class="grid2"><div><h3 style="margin:8px 0 4px;font-size:13px">Primary – Computer sound</h3>${check('audio.speaker.enabled', 'Record computer sound (speakers)')}
        ${row('Volume', range('audio.speaker.volume', 0, 200, 'sv-out'))}${check('audio.speaker.mono', 'Convert to mono')}</div>
      <div><h3 style="margin:8px 0 4px;font-size:13px">Secondary – Microphone</h3>${check('audio.mic.enabled', 'Record microphone')}
        ${row('Device', `<select data-k="audio.mic.deviceId" id="mic-device" class="grow"><option value="default">(Default input device)</option></select>`)}
        ${row('Volume', range('audio.mic.volume', 0, 200, 'mv-out'))}${check('audio.mic.mono', 'Convert to mono')}
        ${row('Noise suppression', select('audio.mic.noiseSuppression', [['off', 'Off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]))}</div></div>
      ${check('audio.mix', 'Mix computer sound and microphone into one audio track')}
      ${check('audio.saveTracksAsFiles', 'Also save audio tracks as separate WAV files')}</div>
    <div class="section"><h2>Push-to-talk</h2>${check('audio.pushTo.enabled', 'Enable push-to-talk / push-to-mute for the microphone')}
      ${row('Mode', select('audio.pushTo.mode', [['talk', '[PTT] Only record while pushing'], ['mute', '[PTM] Only mute while pushing']]))}
      ${row('Key', '<button class="hotkey" id="ptt-key"></button>')}</div>
    <div class="section"><h2>Hotkeys</h2>${hotkey('hotkeys.muteSpeaker', 'Mute speakers')}${hotkey('hotkeys.muteMic', 'Mute microphone')}</div>`;
  },

  videos() { return outputsPage('video'); },
  images() { return outputsPage('image'); },
  audios() { return outputsPage('audio'); },

  about() {
    const kinds = Object.entries(APP.videoCodecs).map(([, f]) => `<tr><td>${esc(f.label)}</td>${['cpu', 'nvenc', 'qsv', 'amf'].map((k) => `<td>${f.encoders[k] ? (APP.available.includes(f.encoders[k]) ? '<span class="pill ok">yes</span>' : '<span class="pill">no</span>') : '–'}</td>`).join('')}</tr>`).join('');
    return `<h1>About CapturePro</h1><p class="lead">Version ${esc(APP.version)}</p>
    <div class="section"><h2>Engine</h2>${row('FFmpeg', `<div class="path grow">${esc(APP.ffmpegPath || 'not found')}</div>`)}
      <table class="enc"><tr><th>Codec</th><th>CPU</th><th>NVIDIA NVENC</th><th>Intel Quick Sync</th><th>AMD VCE/VCN</th></tr>${kinds}</table></div>
    <div class="section"><h2>Settings</h2><button class="btn danger" id="reset-all">Reset all settings to defaults</button></div>`;
  },
};

const SHAPE_LABELS = {
  original: 'Original', rounded: 'Rounded', square: 'Square', roundedSquare: 'Rounded Square', rect43: 'Rectangle (4:3)',
  roundedRect43: 'Rounded Rectangle (4:3)', rect34: 'Rectangle (3:4)', roundedRect34: 'Rounded Rectangle (3:4)', circle: 'Circle',
  ellipse43: 'Ellipse (4:3)', ellipse34: 'Ellipse (3:4)', star: 'Star', star10: '10-Point Star', heart: 'Heart', pentagon: 'Pentagon',
  hexagon: 'Hexagon', hexagonFlat: 'Hexagon (Flat)', archedTop: 'Arched Top', diamond: 'Diamond', clover: 'Clover', squircle: 'Squircle',
};

const POSITIONS = [['top-left', 'Top left'], ['top-center', 'Top center'], ['top-right', 'Top right'], ['middle-left', 'Middle left'], ['middle-center', 'Center'], ['middle-right', 'Middle right'], ['bottom-left', 'Bottom left'], ['bottom-center', 'Bottom center'], ['bottom-right', 'Bottom right']];

function exampleName() {
  const g = S.general;
  const pre = g.namePrefix === 'target' ? 'Screen ' : g.namePrefix === 'custom' ? `${g.customPrefix} ` : '';
  return `${pre}${g.nameSuffix === 'sequence' ? '0001' : '2026-10-21 14-30-05-120'}.${S.video.container}`;
}

function gameTargetHtml() {
  if (!gameTarget) return '<span class="hint">Waiting for a game… bring the game window to the front.</span>';
  return `<b>${esc(gameTarget.title || gameTarget.exe)}</b> <span class="pill">${esc(gameTarget.exe)}.exe</span> <span class="pill">${gameTarget.w} × ${gameTarget.h}${gameTarget.fullscreen ? ' · fullscreen' : ''}</span>`;
}

// ------------------------------------------------------------------ outputs page
let outSort = 'date';
let outSel = new Set();
function outputsPage(kind) {
  return `<h1>${{ video: 'Videos', image: 'Images', audio: 'Audios' }[kind]}</h1>
  <div class="out-tools"><select id="out-sort">${opt('date', 'Sort by date', outSort)}${opt('name', 'Sort by name', outSort)}${opt('size', 'Sort by size', outSort)}</select>
  <span class="grow"></span><button class="btn danger" id="out-del" disabled>Delete</button><button class="btn" id="out-folder">Open output folder</button></div>
  <div id="out-grid" class="out-grid" data-kind="${kind}"><div class="empty">Loading…</div></div>`;
}

const fmtSize = (b) => !b ? '0 MB' : b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(2)} GB` : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
const fmtDate = (ms) => new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

async function loadOutputs() {
  const grid = $('#out-grid');
  if (!grid) return;
  const kind = grid.dataset.kind;
  const items = await api.outputs.list(kind, outSort);
  outSel = new Set();
  if (!items.length) { grid.innerHTML = `<div class="empty">No ${kind === 'audio' ? 'audio files' : kind + 's'} yet.</div>`; return; }
  grid.innerHTML = items.map((it, i) => `<div class="out-item" data-i="${i}" tabindex="0">
    <div class="out-thumb">${kind === 'audio' ? I.audio : I.play}</div>
    <div class="out-meta"><div class="out-name" title="${esc(it.name)}">${esc(it.name)}</div><div class="out-sub"><span>${fmtSize(it.size)}</span><span>${fmtDate(it.mtime)}</span></div></div>
    <div class="out-actions"><button data-a="open">${kind === 'image' ? 'Open' : 'Play'}</button><button data-a="reveal">Folder</button><button data-a="rename">Rename</button><button data-a="delete">Delete</button></div></div>`).join('');
  $$('.out-item', grid).forEach((el) => {
    const it = items[Number(el.dataset.i)];
    el.addEventListener('click', (e) => {
      if (e.target.dataset.a) return outAction(e.target.dataset.a, it);
      if (!e.ctrlKey) { outSel.clear(); $$('.out-item.sel', grid).forEach((x) => x.classList.remove('sel')); }
      outSel.has(it.path) ? outSel.delete(it.path) : outSel.add(it.path);
      el.classList.toggle('sel', outSel.has(it.path));
      $('#out-del').disabled = !outSel.size;
    });
    el.addEventListener('dblclick', () => api.outputs.open(it.path));
    el.addEventListener('keydown', (e) => { if (e.key === 'F2') outAction('rename', it); if (e.key === 'Delete') outAction('delete', it); });
  });
  // thumbnails load lazily, one at a time
  for (const el of $$('.out-item', grid)) {
    if (kind === 'audio') break;
    const it = items[Number(el.dataset.i)];
    const t = await api.outputs.thumb(it.path).catch(() => null);
    if (!document.body.contains(el)) return;
    if (t) { const th = $('.out-thumb', el); th.style.backgroundImage = `url("${fileUrl(t)}")`; th.innerHTML = ''; }
  }
}

async function outAction(a, it) {
  if (a === 'open') api.outputs.open(it.path);
  if (a === 'reveal') api.outputs.reveal(it.path);
  if (a === 'delete') {
    const files = outSel.size && outSel.has(it.path) ? [...outSel] : [it.path];
    if (confirm(`Move ${files.length === 1 ? 'the selected file' : `${files.length} files`} to the Recycle Bin?`)) await api.outputs.delete(files);
  }
  if (a === 'rename') {
    modal('Rename', `<div class="row"><input id="rn" class="grow" value="${esc(it.name.replace(/\.[^.]+$/, ''))}"><button class="btn primary" id="rn-ok">Rename</button></div>`);
    const input = $('#rn'); input.focus(); input.select();
    const go = async () => { try { await api.outputs.rename(it.path, input.value); closeModal(); } catch (e) { toast('error', e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); } };
    $('#rn-ok').onclick = go;
    input.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  }
}

// ------------------------------------------------------------------ page wiring
function render() {
  const scroll = $('#page').scrollTop;
  $('#page').innerHTML = pages[page]();
  bindPage($('#page'));
  wirePage();
  $('#page').scrollTop = scroll;
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('#modes .mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === S.mode));
}

function go(p) { page = p; $('#page').scrollTop = 0; render(); set('ui.lastPage', p); }

function wirePage() {
  const P = $('#page');
  $$('[data-mode]', P).forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $$('[data-goto]', P).forEach((b) => b.addEventListener('click', () => go(b.dataset.goto)));
  $('#show-frame', P)?.addEventListener('click', () => setMode('rect', true));
  $('#rect-size', P)?.addEventListener('change', (e) => { const [w, h] = e.target.value.split('x').map(Number); if (w) window.capturepro.rect.setSize(w, h); e.target.value = ''; });
  $('#pick-window', P)?.addEventListener('click', pickWindow);
  $('#browse-out', P)?.addEventListener('click', async () => { const d = await api.dialog.folder(); if (d) { await set('general.outputDir', d); render(); } });
  $('#open-out', P)?.addEventListener('click', () => api.outputs.openFolder());
  $('#logo-browse', P)?.addEventListener('click', async () => { const f = await api.dialog.image(); if (f) { await set('overlays.logo.image', f); render(); } });
  $('#text-add', P)?.addEventListener('click', () => editText(-1));
  $$('[data-text-edit]', P).forEach((b) => b.addEventListener('click', () => editText(Number(b.dataset.textEdit))));
  $$('[data-text-toggle]', P).forEach((c) => c.addEventListener('change', async () => {
    const t = [...S.overlays.texts];
    t[Number(c.dataset.textToggle)] = { ...t[Number(c.dataset.textToggle)], enabled: c.checked };
    await set('overlays.texts', t);
  }));
  $$('[data-text-del]', P).forEach((b) => b.addEventListener('click', async () => { const t = [...S.overlays.texts]; t.splice(Number(b.dataset.textDel), 1); await set('overlays.texts', t); render(); }));
  $('#preset', P)?.addEventListener('change', (e) => applyPreset(e.target.value));
  $('#save-preset', P)?.addEventListener('click', savePreset);
  $('#reset-all', P)?.addEventListener('click', async () => { if (confirm('Are you sure you want to reset all settings to the defaults?')) { S = await api.settings.reset(); render(); } });
  $('#out-sort', P)?.addEventListener('change', (e) => { outSort = e.target.value; loadOutputs(); });
  $('#out-folder', P)?.addEventListener('click', () => api.outputs.openFolder());
  $('#out-del', P)?.addEventListener('click', async () => { if (outSel.size && confirm(`Move ${outSel.size} file(s) to the Recycle Bin?`)) await api.outputs.delete([...outSel]); });
  if ($('#out-grid', P)) loadOutputs();
  if ($('#mic-device', P)) fillMicDevices();
  if ($('#cam-device', P)) fillCamDevices();
  const ptt = $('#ptt-key', P);
  if (ptt) {
    ptt.textContent = S.audio.pushTo.key || '(None)';
    ptt.onclick = async () => {
      ptt.classList.add('listening'); ptt.textContent = 'Press a key…';
      const k = await api.hotkey.capture();
      ptt.classList.remove('listening');
      if (k) await set('audio.pushTo.key', k.split('+').pop());
      ptt.textContent = S.audio.pushTo.key || '(None)';
    };
  }
}

async function fillMicDevices() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const sel = $('#mic-device');
    if (!sel) return;
    sel.innerHTML = '<option value="default">(Default input device)</option>' + devs.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || `Microphone ${i + 1}`)}</option>`).join('');
    sel.value = S.audio.mic.deviceId;
    if (sel.value !== S.audio.mic.deviceId) sel.value = 'default';
  } catch { /* no permission */ }
}

async function fillCamDevices() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const sel = $('#cam-device');
    if (!sel) return;
    sel.innerHTML = '<option value="default">(Default camera)</option>' + devs.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || `Camera ${i + 1}`)}</option>`).join('');
    sel.value = S.overlays.webcam.deviceId;
    if (sel.value !== S.overlays.webcam.deviceId) sel.value = 'default';
  } catch { /* no permission */ }
}

async function setMode(mode, showFrame) {
  if (status.state !== 'idle') { toast('warn', 'You cannot change the recording mode while recording.'); return; }
  if (mode === 'device') { toast('info', 'Device recording is coming in the next phase.'); return; }
  await set('mode', mode); // main re-shows the capture frame whenever mode is set
  render();
}

async function pickWindow() {
  modal('Choose a window to record', '<div class="empty">Loading windows…</div>');
  const wins = await api.windows.list();
  $('#modal-body').innerHTML = wins.length ? `<div class="win-grid">${wins.map((w, i) => `<button class="win-pick" data-i="${i}">${w.thumb ? `<img src="${w.thumb}" alt="">` : '<div class="noimg"></div>'}<b>${esc(w.title)}</b><span>${esc(w.exe)}.exe · ${w.w}×${w.h}</span></button>`).join('')}</div>` : '<div class="empty">No windows found.</div>';
  $$('.win-pick').forEach((b) => b.addEventListener('click', async () => {
    const w = wins[Number(b.dataset.i)];
    await set('target.window', { hwnd: w.hwnd, title: w.title, exe: w.exe });
    closeModal(); render();
  }));
}

function editText(i) {
  const t = i >= 0 ? S.overlays.texts[i] : { text: '{datetime}', font: 'Segoe UI', size: 32, color: '#ffffff', alpha: 100, shadow: true, outline: false, position: 'top-left', margin: 16, enabled: true };
  const fonts = ['Arial', 'Arial Black', 'Calibri', 'Comic Sans MS', 'Consolas', 'Courier New', 'Georgia', 'Impact', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'];
  modal(i >= 0 ? 'Edit text overlay' : 'Add text overlay', `
    ${row('Text', `<input id="tx-text" class="grow" value="${esc(t.text)}" maxlength="200">`)}
    <p class="hint" style="margin:-2px 0 8px 160px">Macros: {date} {time} {datetime}</p>
    ${row('Font', `<select id="tx-font">${fonts.map((f) => opt(f, f, t.font)).join('')}</select>`)}
    ${row('Size', `<input id="tx-size" type="number" min="8" max="300" value="${t.size}" style="width:90px">`)}
    ${row('Color / alpha', `<input id="tx-color" type="color" value="${t.color}"><input id="tx-alpha" type="range" min="0" max="100" value="${t.alpha}" class="grow">`)}
    ${row('Effects', `<label class="check"><input id="tx-shadow" type="checkbox" ${t.shadow ? 'checked' : ''}>Shadow</label><label class="check"><input id="tx-outline" type="checkbox" ${t.outline ? 'checked' : ''}>Outline</label>`)}
    ${row('Position', `<select id="tx-pos">${POSITIONS.map(([v, l]) => opt(v, l, t.position)).join('')}</select>`)}
    ${row('Margin', `<input id="tx-margin" type="number" min="0" max="2000" value="${t.margin}" style="width:90px"><span class="unit">px</span>`)}
    <div class="row" style="justify-content:flex-end"><button class="btn primary" id="tx-ok">Save</button></div>`);
  $('#tx-ok').onclick = async () => {
    const nt = { ...t, text: $('#tx-text').value, font: $('#tx-font').value, size: Number($('#tx-size').value) || 32, color: $('#tx-color').value, alpha: Number($('#tx-alpha').value), shadow: $('#tx-shadow').checked, outline: $('#tx-outline').checked, position: $('#tx-pos').value, margin: Number($('#tx-margin').value) || 0 };
    const texts = [...S.overlays.texts];
    if (i >= 0) texts[i] = nt; else if (texts.length >= 10) return toast('error', 'You cannot add more than 10 items.'); else texts.push(nt);
    await set('overlays.texts', texts);
    closeModal(); render();
  };
}

async function applyPreset(id) {
  if (!id) return;
  const p = id.startsWith('user:') ? S.presets[Number(id.slice(5))] : APP.presets.find((x) => x.id === id);
  if (!p) return;
  S = await api.settings.update({ video: p.video || {}, audio: p.audio || {} });
  const fam = APP.videoCodecs[S.video.codec];
  if (fam && !fam.containers.includes(S.video.container)) S = await api.settings.update({ video: { container: fam.containers[0] } });
  toast('info', `Preset applied: ${p.name}`);
  render();
}

function savePreset() {
  modal('Add a new preset', `<p class="hint" style="margin-top:0">Save the current format settings as a new preset.</p><div class="row"><input id="pn" class="grow" maxlength="40" placeholder="Preset name"><button class="btn primary" id="pn-ok">Save</button></div>`);
  $('#pn').focus();
  $('#pn-ok').onclick = async () => {
    const name = $('#pn').value.trim();
    if (!name) return;
    if (S.presets.some((p) => p.name === name) || APP.presets.some((p) => p.name === name)) return toast('error', 'The preset name you entered already exists. Please enter a different name.');
    const v = S.video, a = S.audio;
    const preset = { name, video: { container: v.container, codec: v.codec, encoder: v.encoder, fps: v.fps, fpsMode: v.fpsMode, size: v.size, width: v.width, height: v.height, rateControl: v.rateControl, quality: v.quality, bitrate: v.bitrate, keyframeSec: v.keyframeSec, optimize: v.optimize }, audio: { codec: a.codec, bitrate: a.bitrate, sampleRate: a.sampleRate, channels: a.channels } };
    await set('presets', [...S.presets, preset]);
    closeModal(); render();
  };
}

// ------------------------------------------------------------------ modal / toast / sounds
function modal(title, html) { $('#modal-title').textContent = title; $('#modal-body').innerHTML = html; $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; $('#modal-body').innerHTML = ''; api.hotkey.cancel(); }
$('#modal-x').onclick = closeModal;
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });

function toast(type, message) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 8000 : 4000);
}

let actx = null;
function beep(freqs, dur = 0.09, type = 'sine', gap = 0.11) {
  actx = actx || new AudioContext();
  const t0 = actx.currentTime;
  freqs.forEach((f, i) => {
    const o = new OscillatorNode(actx, { type, frequency: f });
    const g = new GainNode(actx, { gain: 0 });
    const t = t0 + i * gap;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.18, t + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur + 0.02);
  });
}
function shutter() {
  actx = actx || new AudioContext();
  const len = actx.sampleRate * 0.12;
  const b = actx.createBuffer(1, len, actx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3) * (i < len * 0.3 || i > len * 0.45 ? 1 : 0.2);
  const s = new AudioBufferSourceNode(actx, { buffer: b });
  s.connect(new GainNode(actx, { gain: 0.35 })).connect(actx.destination);
  s.start();
}
api.on.sound((name) => {
  if (name === 'start') beep([660, 990]);
  else if (name === 'stop') beep([990, 660]);
  else if (name === 'shutter') shutter();
  else if (name === 'click') beep([1800], 0.03, 'square', 0);
  else if (name === 'rclick') beep([1300], 0.03, 'square', 0);
});

// ------------------------------------------------------------------ status
const fmtTime = (ms) => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

function renderStatus(st) {
  status = st;
  const active = st.state !== 'idle';
  document.body.classList.toggle('recording', active);
  $('#st-time').textContent = fmtTime(active ? st.elapsedMs : 0);
  $('#st-size').textContent = `${fmtSize(active ? st.bytes : 0)} / ${st.free != null ? fmtSize(st.free) : '–'}`;
  $('#rec-label').textContent = active ? 'STOP' : 'REC';
  $('#btn-pause').disabled = !active;
  $('#btn-pause').classList.toggle('muted', st.state === 'paused');
  $('#title-status').textContent = st.state === 'recording' ? '● Recording' : st.state === 'paused' ? 'Paused' : st.state === 'stopping' ? 'Saving…' : '';
  const lv = st.levels || {};
  $('#lv-speaker i').style.width = `${Math.min(100, (lv.speaker || 0) * 100)}%`;
  $('#lv-mic i').style.width = `${Math.min(100, (lv.mic || 0) * 100)}%`;
  if (st.mute) renderMute(st.mute);
}

function renderMute(m) {
  $('#btn-mute-spk').innerHTML = m.speaker ? I.spkOff : I.spk;
  $('#btn-mute-mic').innerHTML = m.mic ? I.micOff : I.mic;
  $('#btn-mute-spk').classList.toggle('muted', !!m.speaker);
  $('#btn-mute-mic').classList.toggle('muted', !!m.mic);
  $('#btn-mute-spk').dataset.v = m.speaker ? '1' : '';
  $('#btn-mute-mic').dataset.v = m.mic ? '1' : '';
}

// ------------------------------------------------------------------ boot
(async function boot() {
  APP = await api.init();
  S = APP.settings;
  page = pages[S.ui.lastPage] ? S.ui.lastPage : 'home';
  $('#modes').innerHTML = MODES.map((m) => `<button class="mode" data-mode="${m.id}" title="${esc(m.title)}">${I[m.id]}<span>${esc(m.label)}</span></button>`).join('');
  $$('#modes .mode').forEach((b) => b.addEventListener('click', () => { setMode(b.dataset.mode); if (page !== 'home') go('home'); }));
  $$('#nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));
  $('#btn-rec').onclick = () => api.rec.toggle();
  $('#btn-pause').onclick = () => api.rec.pause();
  $('#btn-shot').onclick = () => api.image.capture();
  $('#btn-draw').onclick = () => api.overlay.toggleDrawing();
  $('#btn-mute-spk').onclick = (e) => api.rec.mute('speaker', !e.currentTarget.dataset.v);
  $('#btn-mute-mic').onclick = (e) => api.rec.mute('mic', !e.currentTarget.dataset.v);
  $('#btn-min').onclick = () => api.win.minimize();
  $('#btn-close').onclick = () => api.win.close();
  $('#btn-tray').onclick = () => api.win.tray();
  renderMute(APP.recStatus.mute || {});
  renderStatus({ ...APP.recStatus, state: APP.recStatus.state || 'idle' });
  render();

  api.rec.onStatus(renderStatus);
  api.rec.onMute(renderMute);
  api.on.toast(({ type, message }) => toast(type, message));
  api.outputs.onChanged(() => loadOutputs());
  api.settings.onChange((s) => { const modeChanged = s.mode !== S.mode; S = s; if (modeChanged) render(); });
  api.on.gameTarget((t) => { gameTarget = t; const el = $('#game-target'); if (el) el.innerHTML = gameTargetHtml(); });
})();
