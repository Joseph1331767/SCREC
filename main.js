const { app, BrowserWindow, ipcMain, screen, desktopCapturer, session, dialog, Tray, Menu, nativeImage, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');

if (process.env.SCREC_SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), 'screc-selftest'));
if (!app.requestSingleInstanceLock()) { app.quit(); }

const defaults = {
  saveDir: path.join(app.getPath('videos'), 'SCREC'),
  resolution: 'auto', // auto | 720 | 1080 | 1440 | 2160
  fit: 'fit',         // fit | stretch | fill
  fps: 30,
  system: true,
  mic: true,
  micDevice: 'auto',
  startup: true,
  zoom: true,
  lastMoveDir: null,
  barPos: null,
};
let settings = { ...defaults };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { settings = { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { /* first run */ }
}
function saveSettings() {
  try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch { /* ignore */ }
}
function applyStartup() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: !!settings.startup, args: ['--hidden-start'] });
}

let barWin = null, tray = null, zoomWin = null;
let selectWins = [];
let pendingDisplayId = null, pendingSystemAudio = false;
let recStream = null, recPath = null;
let selectKind = null;

const preload = path.join(__dirname, 'preload.js');
const stamp = () => {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `SCREC_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};
const toBar = (ch, ...a) => { if (barWin && !barWin.isDestroyed()) barWin.webContents.send(ch, ...a); };

// ---------- bar ----------
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
function createBar() {
  const wa = screen.getPrimaryDisplay().workArea;
  let pos = { x: Math.round(wa.x + wa.width / 2 - 70), y: wa.y };
  if (settings.barPos) {
    const d = screen.getDisplayNearestPoint(settings.barPos);
    pos = {
      x: clamp(settings.barPos.x, d.workArea.x, d.workArea.x + d.workArea.width - 40),
      y: clamp(settings.barPos.y, d.workArea.y, d.workArea.y + d.workArea.height - 30),
    };
  }
  barWin = new BrowserWindow({
    x: pos.x, y: pos.y, width: 140, height: 30,
    frame: false, transparent: true, resizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false, show: false, backgroundColor: '#00000000',
    webPreferences: { preload, backgroundThrottling: false },
  });
  barWin.setAlwaysOnTop(true, 'screen-saver');
  barWin.loadFile(path.join(__dirname, 'renderer', 'bar.html'));
  barWin.once('ready-to-show', () => barWin.show());
}

// Window size follows the content. It grows away from the nearest screen edge so the bar itself never jumps.
ipcMain.on('bar:size', (_e, w, h) => {
  if (!barWin) return;
  w = Math.ceil(w); h = Math.ceil(h);
  const b = barWin.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const right = b.x + b.width / 2 > wa.x + wa.width / 2;
  const bottom = b.y + b.height / 2 > wa.y + wa.height / 2;
  const x = clamp(right ? b.x + b.width - w : b.x, wa.x, wa.x + wa.width - w);
  const y = clamp(bottom ? b.y + b.height - h : b.y, wa.y, wa.y + wa.height - h);
  barWin.setBounds({ x, y, width: w, height: h });
  toBar('bar:anchor', { right, bottom });
});

// Manual drag so we can snap to screen edges when released.
let drag = null;
ipcMain.on('bar:dragStart', () => {
  if (!barWin || drag) return;
  const p = screen.getCursorScreenPoint(), b = barWin.getBounds();
  drag = { dx: p.x - b.x, dy: p.y - b.y, w: b.width, h: b.height };
  drag.t = setInterval(() => {
    const c = screen.getCursorScreenPoint();
    barWin.setBounds({ x: c.x - drag.dx, y: c.y - drag.dy, width: drag.w, height: drag.h });
  }, 8);
});
ipcMain.on('bar:dragEnd', () => {
  if (!drag) return;
  clearInterval(drag.t); drag = null;
  const b = barWin.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const T = 36;
  let x = b.x, y = b.y;
  if (Math.abs(b.x - wa.x) < T) x = wa.x;
  else if (Math.abs(b.x + b.width - (wa.x + wa.width)) < T) x = wa.x + wa.width - b.width;
  if (Math.abs(b.y - wa.y) < T) y = wa.y;
  else if (Math.abs(b.y + b.height - (wa.y + wa.height)) < T) y = wa.y + wa.height - b.height;
  x = clamp(x, wa.x, wa.x + wa.width - b.width); y = clamp(y, wa.y, wa.y + wa.height - b.height);
  barWin.setBounds({ x, y, width: b.width, height: b.height });
  settings.barPos = { x, y }; saveSettings();
});

// ---------- tray ----------
function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16 }));
  tray.setToolTip('SCREC');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show bar', click: () => { barWin.show(); } },
    { label: 'Check for updates', click: () => checkUpdates(true) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('click', () => barWin.show());
}

// ---------- region selection ----------
function startSelect(kind) {
  if (selectWins.length) return;
  selectKind = kind;
  barWin.hide();
  for (const d of screen.getAllDisplays()) {
    const w = new BrowserWindow({
      x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
      frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false,
      fullscreenable: false, hasShadow: false, show: false, backgroundColor: '#00000000',
      webPreferences: { preload },
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.display = d;
    w.loadFile(path.join(__dirname, 'renderer', 'select.html'), { query: { kind } });
    w.once('ready-to-show', () => { w.show(); w.focus(); });
    selectWins.push(w);
  }
}
function closeSelect() {
  for (const w of selectWins) if (!w.isDestroyed()) w.destroy();
  selectWins = [];
}
ipcMain.on('select:done', async (e, rect) => {
  const w = selectWins.find(x => x.webContents === e.sender);
  const kind = selectKind;
  closeSelect();
  if (!w || !rect) { barWin.show(); return; }
  await new Promise(r => setTimeout(r, 200)); // let the dim overlay vanish
  try {
    if (kind === 'image') await captureImage(w.display, rect);
    else await beginVideo(w.display, rect);
  } catch (err) {
    barWin.show();
    toBar('error', String(err && err.message || err));
  }
});

// ---------- screenshot ----------
async function sourceFor(display, noThumb) {
  const sf = display.scaleFactor;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: noThumb ? { width: 0, height: 0 } : { width: Math.round(display.bounds.width * sf), height: Math.round(display.bounds.height * sf) },
  });
  const idx = screen.getAllDisplays().findIndex(d => d.id === display.id);
  return sources.find(s => s.display_id === String(display.id)) || sources[idx] || sources[0];
}
async function captureImage(display, rect) {
  const src = await sourceFor(display);
  const sf = display.scaleFactor;
  const crop = {
    x: Math.round(rect.x * sf), y: Math.round(rect.y * sf),
    width: Math.max(1, Math.round(rect.width * sf)), height: Math.max(1, Math.round(rect.height * sf)),
  };
  const img = src.thumbnail.crop(crop);
  fs.mkdirSync(settings.saveDir, { recursive: true });
  const file = path.join(settings.saveDir, stamp() + '.png');
  fs.writeFileSync(file, img.toPNG());
  barWin.show();
  toBar('result', { kind: 'image', file, name: path.basename(file) });
}

// ---------- video ----------
async function beginVideo(display, rect) {
  pendingDisplayId = String(display.id);
  pendingSystemAudio = !!settings.system;
  barWin.show();
  toBar('rec:start', {
    region: { x: display.bounds.x + rect.x, y: display.bounds.y + rect.y, width: rect.width, height: rect.height },
    display: { x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height, scale: display.scaleFactor },
    settings,
  });
}

function setupDisplayMedia() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const src = sources.find(s => s.display_id === pendingDisplayId) || sources[0];
      cb(pendingSystemAudio ? { video: src, audio: 'loopback' } : { video: src });
    } catch { cb({}); }
  }, { useSystemPicker: false });
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['media', 'display-capture'].includes(perm)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => ['media', 'display-capture'].includes(perm));
}

ipcMain.handle('rec:open', (_e, ext) => {
  fs.mkdirSync(settings.saveDir, { recursive: true });
  recPath = path.join(settings.saveDir, stamp() + '.' + ext);
  recStream = fs.createWriteStream(recPath);
  return recPath;
});
ipcMain.handle('rec:chunk', (_e, buf) => new Promise(res => recStream.write(Buffer.from(buf), () => res())));
ipcMain.handle('rec:finish', () => new Promise(res => {
  const file = recPath;
  recStream.end(() => { recStream = null; recPath = null; res({ kind: 'video', file, name: path.basename(file) }); });
}));

// ---------- settings / result actions ----------
ipcMain.handle('settings:get', () => ({ ...settings, version: app.getVersion(), packaged: app.isPackaged }));
ipcMain.handle('settings:set', (_e, patch) => {
  settings = { ...settings, ...patch };
  saveSettings(); applyStartup();
  return settings;
});
ipcMain.handle('settings:pickDir', async () => {
  const r = await dialog.showOpenDialog(barWin, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.saveDir });
  if (r.canceled) return settings.saveDir;
  settings.saveDir = r.filePaths[0]; saveSettings();
  return settings.saveDir;
});
ipcMain.on('capture:start', (_e, kind) => startSelect(kind));
ipcMain.on('app:quit', () => app.quit());
ipcMain.on('app:minimize', () => barWin.hide());
ipcMain.on('app:checkUpdates', () => checkUpdates(true));
ipcMain.on('app:installUpdate', () => { try { require('electron-updater').autoUpdater.quitAndInstall(); } catch { /* ignore */ } });

ipcMain.handle('file:move', async (_e, file) => {
  const ext = path.extname(file);
  const r = await dialog.showSaveDialog(barWin, {
    defaultPath: path.join(settings.lastMoveDir || app.getPath('videos'), path.basename(file)),
    filters: [{ name: ext.slice(1).toUpperCase(), extensions: [ext.slice(1)] }],
  });
  if (r.canceled || !r.filePath) return null;
  const dest = r.filePath;
  try { fs.renameSync(file, dest); } catch {
    fs.copyFileSync(file, dest); fs.unlinkSync(file);
  }
  settings.lastMoveDir = path.dirname(dest); saveSettings();
  return dest;
});
ipcMain.on('file:reveal', (_e, f) => shell.showItemInFolder(f));
ipcMain.on('file:delete', (_e, f) => { try { fs.unlinkSync(f); } catch { /* ignore */ } });
ipcMain.on('file:copyImage', (_e, f) => clipboard.writeImage(nativeImage.createFromPath(f)));
ipcMain.on('file:copyPath', (_e, f) => clipboard.writeText(f));

// ---------- zoom hotkey (Ctrl+Alt+Shift held, then hold LMB) ----------
// The overlay shows a snapshot taken at press time. A live overlay would be captured by the screen
// capture (window exclusion isn't honoured) and feed back into itself, so the zoom is a frozen still.
let uio = null, UKey = null;
const down = new Set();
let zooming = false, zoomTimer = null, zoomDisplay = null;

function ensureZoomWin(d) {
  if (zoomWin && !zoomWin.isDestroyed() && zoomDisplay && zoomDisplay.id === d.id) return;
  if (zoomWin && !zoomWin.isDestroyed()) zoomWin.destroy();
  zoomDisplay = d;
  zoomWin = new BrowserWindow({
    x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false,
    focusable: false, fullscreenable: false, hasShadow: false, show: false, backgroundColor: '#00000000',
    webPreferences: { preload },
  });
  zoomWin.setAlwaysOnTop(true, 'screen-saver');
  zoomWin.setIgnoreMouseEvents(true);
  zoomWin.loadFile(path.join(__dirname, 'renderer', 'zoom.html'));
}
function sendZoom(active) {
  const p = screen.getCursorScreenPoint();
  if (zoomWin && !zoomWin.isDestroyed()) zoomWin.webContents.send('zoom:state', { active, x: p.x, y: p.y });
}
async function startZoom() {
  if (!settings.zoom || zooming) return;
  zooming = true;
  try {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const visible = zoomWin && !zoomWin.isDestroyed() && zoomWin.isVisible() && zoomDisplay && zoomDisplay.id === d.id;
    if (!visible) {
      ensureZoomWin(d);
      if (zoomWin.webContents.isLoading()) await new Promise(r => zoomWin.webContents.once('did-finish-load', r));
      const src = await sourceFor(d); // overlay is hidden here, so the snapshot is clean
      if (!zooming) return;
      zoomWin.webContents.send('zoom:image', src.thumbnail.toJPEG(92), { x: d.bounds.x, y: d.bounds.y });
      await new Promise(r => { const t = setTimeout(r, 1500); ipcMain.once('zoom:ready', () => { clearTimeout(t); r(); }); });
      if (!zooming) return;
      zoomWin.showInactive();
    }
    sendZoom(true);
    zoomTimer = setInterval(() => sendZoom(true), 8);
  } catch (e) { console.error('zoom failed', e); zooming = false; }
}
function stopZoom() {
  if (zoomTimer) { clearInterval(zoomTimer); zoomTimer = null; }
  if (!zooming) return;
  zooming = false;
  sendZoom(false);
}
ipcMain.on('zoom:hide', () => { if (!zooming && zoomWin && !zoomWin.isDestroyed()) zoomWin.hide(); });

function setupHooks() {
  try {
    const m = require('uiohook-napi');
    uio = m.uIOhook; UKey = m.UiohookKey;
  } catch (e) { console.error('uiohook unavailable', e); return; }
  const grp = { ctrl: [UKey.Ctrl, UKey.CtrlRight], alt: [UKey.Alt, UKey.AltRight], shift: [UKey.Shift, UKey.ShiftRight] };
  const has = g => grp[g].some(k => down.has(k));
  const combo = () => has('ctrl') && has('alt') && has('shift');
  uio.on('keydown', e => { down.add(e.keycode); });
  uio.on('keyup', e => { down.delete(e.keycode); });
  uio.on('mousedown', e => { if (e.button === 1 && combo()) startZoom(); });
  uio.on('mouseup', e => { if (e.button === 1) stopZoom(); });
  uio.start();
}

// ---------- updates ----------
function checkUpdates(manual) {
  if (!app.isPackaged) { if (manual) toBar('update', { state: 'dev' }); return; }
  try {
    const { autoUpdater } = require('electron-updater');
    if (!checkUpdates.wired) {
      checkUpdates.wired = true;
      autoUpdater.autoDownload = true;
      autoUpdater.on('update-available', i => toBar('update', { state: 'downloading', version: i.version }));
      autoUpdater.on('update-not-available', () => toBar('update', { state: 'none' }));
      autoUpdater.on('update-downloaded', i => toBar('update', { state: 'ready', version: i.version }));
      autoUpdater.on('error', e => toBar('update', { state: 'error', message: String(e && e.message || e) }));
    }
    autoUpdater.checkForUpdates().catch(() => {});
  } catch (e) { toBar('update', { state: 'error', message: String(e.message || e) }); }
}

// ---------- boot ----------
app.on('second-instance', () => { if (barWin) barWin.show(); });
app.whenReady().then(() => {
  loadSettings(); applyStartup();
  setupDisplayMedia();
  createBar(); createTray(); setupHooks();
  setTimeout(() => checkUpdates(false), 4000);
  if (process.env.SCREC_SELFTEST) require('./scripts/selftest')({ app, barWin, screen, startSelect, beginVideo, captureImage, ipcMain, startZoom, stopZoom, getSettings: () => settings });
});
app.on('window-all-closed', e => e.preventDefault());
app.on('will-quit', () => { try { uio && uio.stop(); } catch { /* ignore */ } });
