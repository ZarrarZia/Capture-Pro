// Narrow, explicit bridge between renderers and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch) => (fn) => {
  const h = (_e, payload) => fn(payload);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('capturepro', {
  init: invoke('app:init'),
  settings: { update: invoke('settings:update'), reset: invoke('settings:reset'), onChange: on('settings:changed') },
  rec: {
    toggle: invoke('rec:toggle'), pause: invoke('rec:pause'), stop: invoke('rec:stop'), cancel: invoke('rec:cancel'),
    mute: invoke('rec:mute'), onStatus: on('rec:status'), onMute: on('rec:mute'),
  },
  image: { capture: invoke('image:capture') },
  windows: { list: invoke('windows:list') },
  outputs: {
    list: invoke('outputs:list'), thumb: invoke('outputs:thumb'), open: invoke('outputs:open'), reveal: invoke('outputs:reveal'),
    openFolder: invoke('outputs:openFolder'), delete: invoke('outputs:delete'), rename: invoke('outputs:rename'),
    info: invoke('outputs:info'), onChanged: on('outputs:changed'),
  },
  dialog: { folder: invoke('dialog:folder'), image: invoke('dialog:image') },
  hotkey: { capture: invoke('hotkey:capture'), cancel: invoke('hotkey:cancel') },
  shell: { external: invoke('shell:external') },
  win: { minimize: invoke('win:minimize'), close: invoke('win:close'), tray: invoke('win:tray') },
  rect: {
    getBounds: invoke('rect:getBounds'), setInterior: invoke('rect:setInterior'), setSize: invoke('rect:setSize'),
    fullscreen: invoke('rect:fullscreen'), hide: invoke('rect:hide'),
    ignoreMouse: (v) => ipcRenderer.send('rect:ignoreMouse', v), onInfo: on('rect:info'),
  },
  audio: {
    onStart: on('audio:start'), onStop: on('audio:stop'), onSet: on('audio:set'),
    started: (res) => ipcRenderer.send('audio:started', res),
    pcm: (track, buf) => ipcRenderer.send('audio:pcm', track, buf),
    level: (l) => ipcRenderer.send('audio:level', l),
  },
  overlay: {
    onConfig: on('overlay:config'), onMouse: on('overlay:mouse'), onCursor: on('overlay:cursor'), onKey: on('overlay:key'),
    onCountdown: on('overlay:countdown'), onDraw: on('overlay:draw'), onDrawCmd: on('overlay:drawCmd'),
    setDraw: (d) => ipcRenderer.send('overlay:setDraw', d), drawCmd: (c) => ipcRenderer.send('overlay:drawCmd', c),
    toggleDrawing: invoke('draw:toggle'),
  },
  webcam: {
    onConfig: on('webcam:config'), onRecord: on('webcam:record'),
    cameraAspect: (a) => ipcRenderer.send('webcam:aspect', a),
    dragStart: () => ipcRenderer.send('webcam:dragStart'), dragMove: (dx, dy) => ipcRenderer.send('webcam:dragMove', dx, dy),
    dragEnd: () => ipcRenderer.send('webcam:dragEnd'), resize: (dir) => ipcRenderer.send('webcam:resize', dir),
    chunk: (buf) => ipcRenderer.send('webcam:chunk', buf), recordDone: () => ipcRenderer.send('webcam:recordDone'),
  },
  on: {
    toast: on('toast'), sound: on('sound'), gameTarget: on('game:target'), mouse: on('input:mouse'),
  },
});
