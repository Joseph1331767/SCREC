const { app, globalShortcut, BrowserWindow, ipcMain, screen, desktopCapturer, session, dialog, Tray, Menu, nativeImage, clipboard, shell } = require('electron');
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
  zoomLevel: 2,
  annotColor: '#ff3b30',
  annotStyle: 'pen', // pen | marker | glow
  annotSize: 5,
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

let barWin = null, tray = null;
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
  barWin.setContentProtection(true); // keep the bar out of recordings
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
  pendingRegion = { x: display.bounds.x + rect.x, y: display.bounds.y + rect.y, width: rect.width, height: rect.height };
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
ipcMain.handle('rec:finish', async (_e, opts) => {
  const file = recPath;
  await new Promise(res => recStream.end(res));
  recStream = null; recPath = null;
  let out = file;
  const { bake, needsBake } = require('./render');
  if (opts && opts.segments && needsBake(opts.segments)) {
    try { out = await bake(file, opts.segments, opts, p => toBar('render:progress', p)); }
    catch (e) { toBar('error', 'Speed render failed — kept the raw recording. ' + e.message); }
  }
  return { kind: 'video', file: out, name: path.basename(out) };
});

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

// ---------- director hotkeys (hold Ctrl+Alt+Shift) ----------
// While the chord is held: a viewport box follows the mouse (wheel = zoom amount, arrows = nudge),
// LMB held = recording zooms into the box, RMB = annotate (tap = beacon), 1-9 = baked playback speed.
// The box/HUD window is excluded from capture; the annotation window is not, so viewers see marks.
// (Window exclusion only works on windows that are NOT click-through, so overlays catch input while shown.)
const SPEEDS = [0.25, 0.4, 0.6, 0.8, 1, 1.5, 2, 3, 4];
const K = { ctrl: [29, 3613], alt: [56, 3640], shift: [42, 54], left: 57419, right: 57421, up: 57416, down: 57424 };
const down = new Set();
let uio = null;
let chord = false, chordTimer = null, directing = false, dirTimer = null;
let overlayDisplay = null, ovWin = null, barHidden = false;
let lmb = false, rmb = false, rmbTimer = null, rmbLast = null;
let off = { x: 0, y: 0 };
let recRegion = null, pendingRegion = null;

// ONE overlay window only. Two stacked topmost windows over hardware video (e.g. YouTube in Chrome) make
// Windows screen capture go black / the video go white, so box, HUD and live marks all live in this window,
// it is excluded from capture, and the recorder paints the marks into the video itself.
function ensureOverlay(d) {
  if (ovWin && !ovWin.isDestroyed() && overlayDisplay && overlayDisplay.id === d.id) return;
  if (ovWin && !ovWin.isDestroyed()) ovWin.destroy();
  overlayDisplay = d;
  ovWin = new BrowserWindow({
    x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false,
    focusable: false, fullscreenable: false, hasShadow: false, show: false, backgroundColor: '#00000000',
    webPreferences: { preload, backgroundThrottling: false },
  });
  ovWin.setAlwaysOnTop(true, 'screen-saver');
  ovWin.setContentProtection(true); // must NOT be click-through, or exclusion silently stops working
  ovWin.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  ovWin.webContents.once('did-finish-load', () => ovWin.webContents.send('overlay:init', { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height }));
}
const sendBox = (ch, msg) => { if (ovWin && !ovWin.isDestroyed()) ovWin.webContents.send(ch, msg); };
const sendAnno = msg => { sendBox('anno', msg); if (recRegion) toBar('anno', msg); };

function viewBounds() { return recRegion || overlayDisplay.bounds; }
function computeBox() {
  const p = screen.getCursorScreenPoint(), B = viewBounds(), z = settings.zoomLevel || 2;
  const w = B.width / z, h = B.height / z;
  off.x = clamp(off.x, -B.width, B.width); off.y = clamp(off.y, -B.height, B.height);
  return {
    x: clamp(p.x + off.x - w / 2, B.x, B.x + B.width - w),
    y: clamp(p.y + off.y - h / 2, B.y, B.y + B.height - h),
    width: w, height: h,
  };
}
function directTick() {
  const box = computeBox(), d = overlayDisplay;
  sendBox('box', { x: box.x - d.bounds.x, y: box.y - d.bounds.y, width: box.width, height: box.height, active: lmb, level: settings.zoomLevel || 2 });
  if (recRegion) toBar('zoom:state', { active: lmb, box });
}
const hud = text => sendBox('hud', text);

function enterDirector() {
  if (!settings.zoom || directing) return;
  directing = true;
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  ensureOverlay(d);
  if (barWin && barWin.isVisible()) { barWin.hide(); barHidden = true; } // keep to a single window over the screen
  off = { x: 0, y: 0 };
  ovWin.showInactive();
  directTick();
  dirTimer = setInterval(directTick, 8);
}
function exitDirector() {
  clearTimeout(chordTimer);
  if (!directing) return;
  directing = false;
  clearInterval(dirTimer); dirTimer = null;
  if (lmb) { lmb = false; if (recRegion) toBar('zoom:state', { active: false, box: null }); }
  endStroke();
  if (ovWin && !ovWin.isDestroyed()) { ovWin.webContents.send('anno', { type: 'reset' }); ovWin.hide(); }
  if (barHidden && barWin && !barWin.isDestroyed()) { barWin.showInactive(); } barHidden = false;
}

function startStroke() {
  if (rmb || !directing) return;
  rmb = true;
  const p = screen.getCursorScreenPoint();
  rmbLast = p;
  sendAnno({ type: 'start', x: p.x, y: p.y, style: { color: settings.annotColor, style: settings.annotStyle, size: settings.annotSize } });
  rmbTimer = setInterval(() => {
    const c = screen.getCursorScreenPoint();
    if (c.x === rmbLast.x && c.y === rmbLast.y) return;
    rmbLast = c; sendAnno({ type: 'pt', x: c.x, y: c.y });
  }, 8);
}
function endStroke() {
  if (!rmb) return;
  rmb = false; clearInterval(rmbTimer); rmbTimer = null;
  sendAnno({ type: 'end' });
}

function setLevel(delta) {
  settings.zoomLevel = Math.min(6, Math.max(1.25, Math.round(((settings.zoomLevel || 2) + delta) * 4) / 4));
  saveSettings(); toBar('settings:changed', settings);
  hud(`Zoom ${settings.zoomLevel}×`);
}
function setSpeed(n) {
  if (!recRegion) { hud('Start a recording first'); return; }
  const sp = SPEEDS[n - 1];
  toBar('speed:set', sp);
  hud(sp === 1 ? 'Speed normal' : `Speed ${sp}×`);
}

// Arrows and 1-9 are only acted on (and swallowed, so games/apps never see them) while the chord is held.
// uiohook can't block keys, but a registered global hotkey is consumed by Windows.
const ACCEL = { 57419: 'Left', 57421: 'Right', 57416: 'Up', 57424: 'Down' };
for (let n = 1; n <= 9; n++) ACCEL[n + 1] = String(n);
const swallow = new Set();
function act(code) {
  if (code === K.left || code === K.right || code === K.up || code === K.down) {
    if (!directing) return;
    const step = 10;
    if (code === K.left) off.x -= step; else if (code === K.right) off.x += step;
    else if (code === K.up) off.y -= step; else off.y += step;
  } else if (code >= 2 && code <= 10) setSpeed(code - 1);
}
function grabKeys() {
  if (!settings.zoom) return;
  for (const [code, key] of Object.entries(ACCEL)) {
    try { if (globalShortcut.register('Ctrl+Alt+Shift+' + key, () => act(+code))) swallow.add(+code); } catch { /* combo taken: key passes through */ }
  }
}
function releaseKeys() { globalShortcut.unregisterAll(); swallow.clear(); }
const has = g => K[g].some(k => down.has(k));
const combo = () => has('ctrl') && has('alt') && has('shift');
const hk = {
  keydown(code) {
    down.add(code);
    if (combo() && !chord) { chord = true; chordTimer = setTimeout(() => { if (chord) enterDirector(); }, 100); }
    if (chord && !swallow.size) grabKeys();
    if (!chord || swallow.has(code)) return; // swallowed keys are handled by their global hotkey
    act(code);
  },
  keyup(code) {
    down.delete(code);
    if (chord && !combo()) { chord = false; releaseKeys(); exitDirector(); }
  },
  mousedown(btn) {
    if (!directing) return;
    if (btn === 1) lmb = true; else if (btn === 2) startStroke();
  },
  mouseup(btn) {
    if (btn === 1 && lmb) { lmb = false; if (recRegion) toBar('zoom:state', { active: false, box: null }); }
    else if (btn === 2) endStroke();
  },
  wheel(rotation) { if (directing && rotation) setLevel(rotation < 0 ? 0.25 : -0.25); },
};

ipcMain.on('rec:state', (_e, recording) => {
  recRegion = recording ? pendingRegion : null;
  if (!recording) toBar('zoom:state', { active: false, box: null });
});

function setupHooks() {
  try { uio = require('uiohook-napi').uIOhook; } catch (e) { console.error('uiohook unavailable', e); return; }
  uio.on('keydown', e => hk.keydown(e.keycode));
  uio.on('keyup', e => hk.keyup(e.keycode));
  uio.on('mousedown', e => hk.mousedown(e.button));
  uio.on('mouseup', e => hk.mouseup(e.button));
  uio.on('wheel', e => hk.wheel(e.rotation));
  uio.start();
  setTimeout(() => ensureOverlay(screen.getPrimaryDisplay()), 2500); // pre-warm so the first press is instant
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
  if (process.env.SCREC_SELFTEST) require('./scripts/selftest')({ app, barWin, screen, startSelect, beginVideo, captureImage, ipcMain, hk, act, screen: screen, swallowed: () => [...swallow], getSettings: () => settings });
});
app.on('window-all-closed', e => e.preventDefault());
app.on('will-quit', () => { globalShortcut.unregisterAll(); try { uio && uio.stop(); } catch { /* ignore */ } });
