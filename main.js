const { app, BrowserWindow, ipcMain, screen, desktopCapturer, session, dialog, Tray, Menu, nativeImage, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');

if (process.env.SCREC_SELFTEST) { // tests get their own profile AND their own recordings folder -- never touch the user's real one
  app.setPath('userData', path.join(app.getPath('temp'), 'screc-selftest'));
  app.setPath('videos', path.join(app.getPath('temp'), 'screc-selftest-videos'));
}
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

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
  chord: 'ctrl+shift+caps', // keys to hold. Ctrl+Alt+Shift (and Alt+Shift + mouse movement) blank screen capture on some PCs; this one tests clean
  settingsVersion: 2,
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
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    settings = { ...defaults, ...saved };
    // new default chord for everyone, once (compare the SAVED version -- the merge above fills in the default)
    if (saved.settingsVersion !== defaults.settingsVersion) { settings.chord = defaults.chord; settings.settingsVersion = defaults.settingsVersion; }
  } catch { /* first run */ }
  if (process.env.SCREC_SELFTEST) settings.saveDir = path.join(app.getPath('videos'), 'SCREC'); // tests never use the real recordings folder
}
function saveSettings() {
  try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch { /* ignore */ }
}
function applyStartup() {
  if (!app.isPackaged || process.env.SCREC_NO_STARTUP) return; // (smoke tests must not touch the user's login-item entry)
  app.setLoginItemSettings({ openAtLogin: !!settings.startup, args: ['--hidden-start'] });
}

let barWin = null, tray = null;
let selectWins = [];
let pendingDisplayId = null, pendingSystemAudio = false;
let recStream = null, recPath = null;
let capturing = false; // getDisplayMedia has been requested: from here on our topmost windows must not move or resize
let selectKind = null;

const preload = path.join(__dirname, 'preload.js');
const stamp = () => {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `SCREC_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};
const perf = require('./perf');
const toBar = (ch, ...a) => { if (barWin && !barWin.isDestroyed()) { perf.count('ipc>bar:' + ch); barWin.webContents.send(ch, ...a); } };

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
  barWin.loadFile(path.join(__dirname, 'renderer', 'bar.html'), { query: perf.on ? { perf: '1' } : {} });
  barWin.once('ready-to-show', () => barWin.show());
}

// Window size follows the content. It grows away from the nearest screen edge so the bar itself never jumps.
ipcMain.on('bar:size', (_e, w, h) => {
  if (recRegion || capturing) return; // never resize while the screen is being captured (see bar.js)
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
  if (!barWin || drag || recRegion || capturing) return;
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
    { label: 'Performance log (perf.log)', type: 'checkbox', checked: perf.on, click: m => { if (m.checked) perf.start(app.getPath('userData')); else perf.stop(); if (input) input.config(inputCfg()); } },
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
  if (!directing) ensureOverlay(display); // build the overlay now, not in the middle of the capture
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
ipcMain.on('perf', (_e, name, data) => perf.report(name, data));
ipcMain.handle('rec:chunk', (_e, buf) => new Promise(res => recStream.write(Buffer.from(buf), () => res())));
ipcMain.on('rec:cancelBake', () => { try { require('./render').cancel(); } catch { /* ignore */ } });
ipcMain.handle('rec:finish', async (_e, opts) => {
  const file = recPath;
  await new Promise(res => recStream.end(res));
  recStream = null; recPath = null;
  let out = file;
  const { bake, needsBake } = require('./render');
  if (opts && opts.segments && needsBake(opts.segments)) {
    try { out = await bake(file, opts.segments, opts, p => toBar('render:progress', p)); }
    catch (e) {
      toBar('error', e.message === 'cancelled' ? 'Render cancelled — kept the raw recording (speed changes not applied).'
        : 'Speed render failed — kept the raw recording. ' + e.message);
    }
  }
  return { kind: 'video', file: out, name: path.basename(out) };
});

// ---------- settings / result actions ----------
ipcMain.handle('settings:get', () => ({ ...settings, version: app.getVersion(), packaged: app.isPackaged }));
ipcMain.handle('settings:set', (_e, patch) => {
  settings = { ...settings, ...patch };
  if (input) input.config(inputCfg());
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
// ONE overlay window holds the box, HUD and live marks; it is excluded from capture and the recorder paints the
// marks into the video itself, so viewers see the zoom and marks but never the aim box/HUD.
// (setIgnoreMouseEvents would silently disable the exclusion; input is swallowed by hooks.js instead.)
const SPEEDS = [0.25, 0.4, 0.6, 0.8, 1, 1.5, 2, 3, 4];
let chord = false, chordTimer = null, directing = false, dirTimer = null;
let overlayDisplay = null, ovWin = null, barHidden = false;
let lmb = false, rmb = false, rmbLast = null, rmbPts = [];
let off = { x: 0, y: 0 };
let recRegion = null, pendingRegion = null;

// WS_EX_TRANSPARENT (without WS_EX_LAYERED, which would break capture exclusion): Chrome's native occlusion
// tracker ignores such windows. Without it, a fullscreen overlay makes Chrome think it is covered, it stops
// painting video (YouTube goes white until clicked) and the capture of that video plane breaks.
let _koffi = null;
function markTransparent(win) {
  try {
    if (!_koffi) {
      const koffi = require('koffi'), u = koffi.load('user32.dll');
      _koffi = { get: u.func('intptr_t __stdcall GetWindowLongPtrW(uint64_t h, int i)'), set: u.func('intptr_t __stdcall SetWindowLongPtrW(uint64_t h, int i, intptr_t v)') };
    }
    const h = win.getNativeWindowHandle().readBigUInt64LE(0);
    _koffi.set(h, -20, Number(_koffi.get(h, -20)) | 0x20);
  } catch (e) { console.error('markTransparent failed', e); }
}

// ONE overlay window only. Two stacked topmost windows over hardware video (e.g. YouTube in Chrome) make
// Windows screen capture go black / the video go white, so box, HUD and live marks all live in this window,
// it is excluded from capture, and the recorder paints the marks into the video itself.
const sameDisplay = (a, b) => !!a && !!b && a.id === b.id && a.scaleFactor === b.scaleFactor &&
  ['x', 'y', 'width', 'height'].every(k => a.bounds[k] === b.bounds[k]);
// While recording a region the overlay belongs on the recorded display (the box is clamped to that region).
const pickDisplay = () => (recRegion ? screen.getDisplayMatching(recRegion) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));
function ensureOverlay(d) {
  // also re-create when the display's size/position/DPI changed (game resolution switch, docking), not only its id
  if (ovWin && !ovWin.isDestroyed() && sameDisplay(overlayDisplay, d)) return;
  if (ovWin && !ovWin.isDestroyed()) ovWin.destroy();
  overlayDisplay = d;
  ovWin = new BrowserWindow({
    x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false,
    focusable: false, fullscreenable: false, hasShadow: false, show: false, backgroundColor: '#00000000',
    webPreferences: { preload, backgroundThrottling: false },
  });
  ovWin.setAlwaysOnTop(true, 'screen-saver');
  ovWin.setContentProtection(true); // must NOT use setIgnoreMouseEvents, or exclusion silently stops working
  markTransparent(ovWin);
  ovWin.loadFile(path.join(__dirname, 'renderer', 'overlay.html'), { query: perf.on ? { perf: '1' } : {} });
  ovWin.webContents.once('did-finish-load', () => ovWin.webContents.send('overlay:init', { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height }));
}
const sendBox = (ch, msg) => { if (ovWin && !ovWin.isDestroyed()) { perf.count('ipc>ov:' + ch); ovWin.webContents.send(ch, msg); } };
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
const TICK_MS = 16; // one uniform 60 Hz tick drives the box, the recorder's zoom target and stroke sampling
function directTick() {
  sampleStroke();
  const box = computeBox(), d = overlayDisplay;
  sendBox('box', { x: box.x - d.bounds.x, y: box.y - d.bounds.y, width: box.width, height: box.height, active: lmb, level: settings.zoomLevel || 2 });
  if (recRegion) toBar('zoom:state', { active: lmb, box });
  flushStroke();
}
const hud = text => sendBox('hud', text);

function enterDirector() {
  if (!settings.zoom || directing) return;
  directing = true;
  try {
    ensureOverlay(pickDisplay());
    if (barWin && barWin.isVisible()) { barWin.hide(); barHidden = true; } // keep to a single window over the screen
    off = { x: 0, y: 0 };
    ovWin.showInactive();
    directTick();
    clearInterval(dirTimer);
    dirTimer = setInterval(directTick, TICK_MS);
  } catch (e) { // never leave a half-entered director behind (no timer, no overlay, bar hidden)
    console.error('director failed to start', e);
    directing = false; clearInterval(dirTimer); dirTimer = null;
    try { if (ovWin && !ovWin.isDestroyed()) ovWin.hide(); } catch { /* ignore */ }
    if (barHidden && barWin && !barWin.isDestroyed()) barWin.showInactive();
    barHidden = false;
  }
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
  rmbLast = p; rmbPts = [];
  sendAnno({ type: 'start', x: p.x, y: p.y, style: { color: settings.annotColor, style: settings.annotStyle, size: settings.annotSize } });
}
function endStroke() {
  if (!rmb) return;
  rmb = false; flushStroke();
  sendAnno({ type: 'end' });
}
// Stroke points are sampled once per director tick and sent as ONE batched message (uniform rate, no per-point IPC).
function sampleStroke() {
  if (!rmb) return;
  const c = screen.getCursorScreenPoint();
  if (c.x !== rmbLast.x || c.y !== rmbLast.y) { rmbLast = c; rmbPts.push(c.x, c.y); }
}
function flushStroke() {
  if (rmbPts.length) { sendAnno({ type: 'pts', pts: rmbPts }); rmbPts = []; }
}

function setLevel(delta) {
  settings.zoomLevel = Math.min(6, Math.max(1.25, Math.round(((settings.zoomLevel || 2) + delta) * 4) / 4));
  clearTimeout(setLevel.t); setLevel.t = setTimeout(saveSettings, 400); // not synchronous: we are inside a hook callback
  toBar('settings:changed', settings);
  hud(`Zoom ${settings.zoomLevel}×`);
}
function setSpeed(n) {
  if (!recRegion) { hud('Start a recording first'); return; }
  const sp = SPEEDS[n - 1];
  toBar('speed:set', sp);
  hud(sp === 1 ? 'Speed normal' : `Speed ${sp}×`);
}

// While the chord is held, arrows, 1-9 and the mouse buttons belong to SCREC: they are swallowed by a
// low-level hook so games/apps never see them (and no window ever receives the click -- a click delivered
// to our topmost overlay makes Windows capture of hardware video go black/white).
function act(key) { // 'left' | 'right' | 'up' | 'down' | 1..9
  if (typeof key === 'number') { setSpeed(key); return; }
  if (!directing) return;
  const step = 10;
  if (key === 'left') off.x -= step; else if (key === 'right') off.x += step; else if (key === 'up') off.y -= step; else if (key === 'down') off.y += step;
}

// Chord / button / wheel events arrive from the input worker (its own thread, see inputworker.js).
function chordEvent(on) {
  clearTimeout(chordTimer);
  if (on) { chord = true; chordTimer = setTimeout(() => { if (chord) enterDirector(); }, 100); }
  else { chord = false; setImmediate(() => { if (!chord) exitDirector(); }); }
}
function buttonEvent(btn, isDown) {
  if (!directing) return;
  if (isDown) { if (btn === 1) lmb = true; else if (btn === 2) startStroke(); }
  else if (btn === 1 && lmb) { lmb = false; if (recRegion) toBar('zoom:state', { active: false, box: null }); }
  else if (btn === 2) endStroke();
}
function wheelEvent(up) { if (directing) setLevel(up ? 0.25 : -0.25); }
// same events, driven directly by the selftest when it doesn't inject real input
const hk = { chordStart: () => chordEvent(true), chordEnd: () => chordEvent(false), btn: buttonEvent, wheel: wheelEvent };

ipcMain.on('rec:capturing', () => { capturing = true; });
ipcMain.on('rec:state', (_e, recording) => {
  recRegion = recording ? pendingRegion : null;
  capturing = false; // recRegion takes over as the gate while recording
  if (!recording) toBar('zoom:state', { active: false, box: null });
});

let input = null;
const inputCfg = () => ({ zoom: settings.zoom, chord: settings.chord, perf: perf.on });
function setupHooks() {
  try {
    input = require('./input').start({
      onChord: chordEvent, onAct: act, onBtn: buttonEvent, onWheel: wheelEvent,
      onPerf: d => perf.report('input', d),
      onReady: () => { if (process.env.SCREC_SMOKE) console.log('[smoke] input worker ready'); },
      onError: m => console.error('input hooks unavailable:', m),
    }, inputCfg());
  } catch (e) { console.error('input hooks unavailable', e); }
  setTimeout(() => { if (!directing) ensureOverlay(pickDisplay()); }, 2500); // pre-warm so the first press is instant
}

// ---------- updates ----------
function checkUpdates(manual) {
  checkUpdates.manual = !!manual; // background checks only speak up when they find an update
  if (!app.isPackaged) { if (manual) toBar('update', { state: 'dev' }); return; }
  try {
    const { autoUpdater } = require('electron-updater');
    if (!checkUpdates.wired) {
      checkUpdates.wired = true;
      autoUpdater.autoDownload = true;
      autoUpdater.on('update-available', i => toBar('update', { state: 'downloading', version: i.version }));
      autoUpdater.on('update-not-available', () => { if (checkUpdates.manual) toBar('update', { state: 'none' }); });
      autoUpdater.on('update-downloaded', i => toBar('update', { state: 'ready', version: i.version }));
      autoUpdater.on('error', e => { if (checkUpdates.manual) toBar('update', { state: 'error', message: String(e && e.message || e) }); });
    }
    autoUpdater.checkForUpdates().catch(() => {});
  } catch (e) { if (manual) toBar('update', { state: 'error', message: String(e.message || e) }); }
}

// ---------- keep the process out of Windows' power throttling ----------
// SCREC sits idle for hours with a keyboard hook installed. If Windows puts an idle background process in
// "efficiency mode" its hook callbacks get slow and the whole PC's typing feels laggy. Opt out (and keep Chromium's
// own timers/renderers from backgrounding too).
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
function disablePowerThrottling() {
  try {
    const koffi = require('koffi'), k = koffi.load('kernel32.dll');
    const State = koffi.struct('PROCESS_POWER_THROTTLING_STATE', { Version: 'uint32', ControlMask: 'uint32', StateMask: 'uint32' });
    const cur = k.func('intptr_t __stdcall GetCurrentProcess()');
    const setInfo = k.func('bool __stdcall SetProcessInformation(intptr_t h, int cls, PROCESS_POWER_THROTTLING_STATE *info, uint32_t size)');
    const ok = setInfo(cur(), 4 /* ProcessPowerThrottling */, { Version: 1, ControlMask: 1 /* EXECUTION_SPEED */, StateMask: 0 /* never throttle */ }, 12);
    if (!ok) console.error('power-throttling opt-out refused');
  } catch (e) { console.error('power-throttling opt-out failed', e.message); }
}

// ---------- boot ----------
app.on('second-instance', () => { if (barWin) barWin.show(); });
app.whenReady().then(() => {
  if (!gotLock) return; // a second launch: do nothing (no windows, no hooks) while it quits
  loadSettings(); applyStartup(); disablePowerThrottling();
  if (process.env.SCREC_PERF) perf.start(process.env.SCREC_SELFTEST ? null : app.getPath('userData'));
  setupDisplayMedia();
  createBar(); createTray(); setupHooks();
  setTimeout(() => checkUpdates(false), 4000);
  if (process.env.SCREC_SMOKE) setTimeout(() => app.quit(), 7000);
  if (process.env.SCREC_SELFTEST) require('./scripts/selftest')({ app, barWin, screen, startSelect, beginVideo, captureImage, ipcMain, hk, act, swallowed: () => 0, getSettings: () => settings });
});
app.on('window-all-closed', e => e.preventDefault());
app.on('will-quit', () => {
  try { require('./render').cancel(); } catch { /* ignore */ } 
  try { input && input.stop(); } catch { /* ignore */ } if (setLevel.t) { clearTimeout(setLevel.t); saveSettings(); } });
