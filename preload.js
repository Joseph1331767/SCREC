const { contextBridge, ipcRenderer } = require('electron');
const on = (ch, fn) => ipcRenderer.on(ch, (_e, ...a) => fn(...a));
contextBridge.exposeInMainWorld('api', {
  // bar
  setHeight: h => ipcRenderer.send('bar:height', h),
  capture: kind => ipcRenderer.send('capture:start', kind),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: p => ipcRenderer.invoke('settings:set', p),
  pickDir: () => ipcRenderer.invoke('settings:pickDir'),
  quit: () => ipcRenderer.send('app:quit'),
  minimize: () => ipcRenderer.send('app:minimize'),
  checkUpdates: () => ipcRenderer.send('app:checkUpdates'),
  installUpdate: () => ipcRenderer.send('app:installUpdate'),
  recOpen: ext => ipcRenderer.invoke('rec:open', ext),
  recChunk: buf => ipcRenderer.invoke('rec:chunk', buf),
  recFinish: () => ipcRenderer.invoke('rec:finish'),
  recState: r => ipcRenderer.send('rec:state', r),
  moveFile: f => ipcRenderer.invoke('file:move', f),
  reveal: f => ipcRenderer.send('file:reveal', f),
  deleteFile: f => ipcRenderer.send('file:delete', f),
  copyImage: f => ipcRenderer.send('file:copyImage', f),
  copyPath: f => ipcRenderer.send('file:copyPath', f),
  onRecStart: fn => on('rec:start', fn),
  onResult: fn => on('result', fn),
  onError: fn => on('error', fn),
  onUpdate: fn => on('update', fn),
  onZoom: fn => on('zoom:state', fn),
  // select overlay
  selectDone: r => ipcRenderer.send('select:done', r),
  // zoom overlay
  zoomHide: () => ipcRenderer.send('zoom:hide'),
  onZoomPrepare: fn => on('zoom:prepare', fn),
  onZoomRelease: fn => on('zoom:release', fn),
});
