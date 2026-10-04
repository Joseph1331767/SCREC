const $ = id => document.getElementById(id);
let S = {};            // settings
let rec = null;        // active recording session
const marks = new Marks();
api.onAnno(m => marks.handle(m));
let zoomCb = null;
api.onZoom(s => zoomCb && zoomCb(s));
let speedCb = null;
api.onSpeed(sp => speedCb && speedCb(sp));
api.onRenderProgress(p => { if (rec && rec.baking) $('timer').textContent = 'Baking ' + Math.round(p * 100) + '%'; });
let resultFile = null, resultKind = null;

// ---------- layout ----------
new ResizeObserver(() => api.setSize($('app').offsetWidth, $('app').offsetHeight)).observe($('app'));
api.onAnchor(a => { $('app').classList.toggle('right', a.right); $('app').classList.toggle('up', a.bottom); });
const grip = $('grip');
grip.addEventListener('pointerdown', e => { grip.setPointerCapture(e.pointerId); api.dragStart(); });
grip.addEventListener('pointerup', () => api.dragEnd());
grip.addEventListener('pointercancel', () => api.dragEnd());
const syncOpen = () => $('app').classList.toggle('open', !$('panel').classList.contains('hidden') || !$('result').classList.contains('hidden'));
const show = (id, on) => { $(id).classList.toggle('hidden', !on); if (id === 'panel' || id === 'result') syncOpen(); };
function toast(t) { $('msg').textContent = t; show('msg', !!t); }

// ---------- settings ----------
async function loadSettings() {
  S = await api.getSettings();
  $('sRes').value = S.resolution; $('sFit').value = S.fit; $('sFps').value = String(S.fps);
  $('cSys').checked = S.system; $('cMic').checked = S.mic; $('cZoom').checked = S.zoom; $('cStart').checked = S.startup;
  $('dir').textContent = S.saveDir;
  $('ver').textContent = 'v' + S.version;
  syncMarks();
  await fillMics();
}
const bind = (id, key, get) => $(id).addEventListener('change', async () => { S = { ...S, ...(await api.setSettings({ [key]: get($(id)) })) }; });
bind('sRes', 'resolution', e => e.value); bind('sFit', 'fit', e => e.value); bind('sFps', 'fps', e => +e.value);
bind('cSys', 'system', e => e.checked); bind('cMic', 'mic', e => e.checked); bind('cZoom', 'zoom', e => e.checked);
bind('cStart', 'startup', e => e.checked);
function syncMarks() {
  $('rZoom').value = S.zoomLevel; $('vZoom').textContent = S.zoomLevel + '×';
  $('iCol').value = S.annotColor; $('sAnn').value = S.annotStyle; $('rSize').value = S.annotSize; $('vSize').textContent = S.annotSize;
}
bind('rZoom', 'zoomLevel', e => +e.value); bind('iCol', 'annotColor', e => e.value);
bind('sAnn', 'annotStyle', e => e.value); bind('rSize', 'annotSize', e => +e.value);
$('rZoom').addEventListener('input', () => { $('vZoom').textContent = $('rZoom').value + '×'; });
$('rSize').addEventListener('input', () => { $('vSize').textContent = $('rSize').value; });
api.onSettingsChanged(s => { S = { ...S, ...s }; syncMarks(); }); bind('sMic', 'micDevice', e => e.value);
$('btnDir').onclick = async () => { $('dir').textContent = await api.pickDir(); };
$('btnSet').onclick = () => { const open = $('panel').classList.contains('hidden'); show('panel', open); if (open) show('result', false); };
$('btnHide').onclick = () => api.minimize();
$('btnQuit').onclick = () => api.quit();
$('btnUpd').onclick = () => { toast('Checking for updates…'); api.checkUpdates(); };

// ---------- microphones ----------
// Prefer headset-ish devices: label with "headset" (+ "wireless" best), then wireless, then headphone/earphone, then default.
function micScore(l) {
  l = l.toLowerCase();
  if (/stereo mix|loopback|virtual|what u hear/.test(l)) return -1;
  let s = 0;
  if (l.includes('headset')) s += 4;
  if (l.includes('wireless')) s += 3;
  if (/headphone|earphone|earbud/.test(l)) s += 1;
  return s;
}
async function listMics() {
  try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach(t => t.stop()); } catch { /* no mic perm */ }
  const all = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
  // collapse the virtual "default"/"communications" entries when a real one exists
  const real = all.filter(d => d.deviceId !== 'default' && d.deviceId !== 'communications');
  return real.length ? real : all;
}
function pickMic(devs) {
  if (S.micDevice && S.micDevice !== 'auto') {
    const m = devs.find(d => d.label === S.micDevice);
    if (m) return m;
  }
  let best = null, bs = 0;
  for (const d of devs) { const s = micScore(d.label); if (s > bs) { bs = s; best = d; } }
  return best || devs[0] || null;
}
async function fillMics() {
  const devs = await listMics();
  const sel = $('sMic'); sel.innerHTML = '';
  const auto = pickMic(devs && S.micDevice === 'auto' ? devs : devs);
  sel.add(new Option('Auto' + (auto ? ' — ' + auto.label : ''), 'auto'));
  for (const d of devs) sel.add(new Option(d.label, d.label));
  sel.value = devs.some(d => d.label === S.micDevice) ? S.micDevice : 'auto';
}
navigator.mediaDevices.addEventListener('devicechange', () => fillMics());

// ---------- capture buttons ----------
$('btnImg').onclick = () => { toast(''); show('result', false); api.capture('image'); };
$('btnVid').onclick = () => { toast(''); show('result', false); api.capture('video'); };

// ---------- recording ----------
const MIMES = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];
const even = n => Math.max(2, Math.round(n / 2) * 2);

api.onRecStart(async cfg => {
  try { await startRecording(cfg); }
  catch (e) { toast('Could not start: ' + (e && e.message || e)); await teardown(); }
});

async function startRecording({ region, display, settings }) {
  S = settings;
  const fps = S.fps || 30;
  const wantSys = !!S.system;
  const ds = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: fps, max: fps }, width: { ideal: Math.round(display.width * display.scale) }, height: { ideal: Math.round(display.height * display.scale) } },
    audio: wantSys,
  });
  const video = document.createElement('video');
  video.muted = true; video.srcObject = ds; await video.play();
  await new Promise(r => (video.videoWidth ? r() : (video.onloadedmetadata = r)));
  const k = video.videoWidth / display.width; // video px per DIP

  // base source rect (video px)
  let bx = (region.x - display.x) * k, by = (region.y - display.y) * k, bw = region.width * k, bh = region.height * k;
  bx = Math.max(0, bx); by = Math.max(0, by); bw = Math.min(bw, video.videoWidth - bx); bh = Math.min(bh, video.videoHeight - by);

  // output size + fit mapping
  let ow, oh;
  if (S.resolution === 'auto') { ow = even(bw); oh = even(bh); }
  else { oh = even(+S.resolution); ow = even(oh * 16 / 9); }
  let dx = 0, dy = 0, dw = ow, dh = oh;
  if (S.resolution !== 'auto' && S.fit === 'fit') {
    const sc = Math.min(ow / bw, oh / bh); dw = bw * sc; dh = bh * sc; dx = (ow - dw) / 2; dy = (oh - dh) / 2;
  } else if (S.resolution !== 'auto' && S.fit === 'fill') {
    const tr = ow / oh, sr = bw / bh;
    if (sr > tr) { const nw = bh * tr; bx += (bw - nw) / 2; bw = nw; } else { const nh = bw / tr; by += (bh - nh) / 2; bh = nh; }
  }

  const canvas = document.createElement('canvas'); canvas.width = ow; canvas.height = oh;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingQuality = 'high';
  const cs = canvas.captureStream(0);
  const vtrack = cs.getVideoTracks()[0];

  // viewport box (abs DIP, from main) -> source rect in video px, eased so the zoom glides in and out
  const full = { x: bx, y: by, w: bw, h: bh };
  let curR = { ...full }, tgtR = { ...full }, lastT = performance.now();
  zoomCb = s => {
    if (!s.active || !s.box) { tgtR = { ...full }; return; }
    const fx = (s.box.x - region.x) / region.width, fy = (s.box.y - region.y) / region.height;
    tgtR = { x: bx + fx * bw, y: by + fy * bh, w: (s.box.width / region.width) * bw, h: (s.box.height / region.height) * bh };
  };
  const draw = () => {
    const now = performance.now(), a = 1 - Math.exp(-(now - lastT) / 110); lastT = now;
    for (const k of ['x', 'y', 'w', 'h']) curR[k] += (tgtR[k] - curR[k]) * a;
    if (dx || dy) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, ow, oh); }
    ctx.drawImage(video, curR.x, curR.y, curR.w, curR.h, dx, dy, dw, dh);
    if (!marks.empty) { // abs screen DIP -> output pixels, following the current zoom crop
      const sx = (k * dw) / curR.w, sy = (k * dh) / curR.h;
      ctx.save();
      ctx.beginPath(); ctx.rect(dx, dy, dw, dh); ctx.clip();
      ctx.setTransform(sx, 0, 0, sy, dx - (k * display.x + curR.x) * dw / curR.w, dy - (k * display.y + curR.y) * dh / curR.h);
      marks.draw(ctx);
      ctx.restore();
    }
    vtrack.requestFrame && vtrack.requestFrame();
  };
  const timer = setInterval(draw, 1000 / fps);

  // audio mix
  const ac = new AudioContext();
  const dest = ac.createMediaStreamDestination();
  let nAudio = 0; const micStream = [];
  const sysTracks = ds.getAudioTracks();
  if (sysTracks.length) { ac.createMediaStreamSource(new MediaStream(sysTracks)).connect(dest); nAudio++; }
  if (S.mic) {
    try {
      const mic = pickMic(await listMics());
      const ms = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: mic ? { exact: mic.deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      micStream.push(ms); ac.createMediaStreamSource(ms).connect(dest); nAudio++;
    } catch (e) { toast('Mic unavailable: ' + e.message); }
  }
  const out = new MediaStream([vtrack, ...(nAudio ? dest.stream.getAudioTracks() : [])]);

  const mime = MIMES.find(m => MediaRecorder.isTypeSupported(m)) || '';
  const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  const bps = Math.min(60e6, Math.max(4e6, ow * oh * fps * 0.12));
  const mr = new MediaRecorder(out, { mimeType: mime, videoBitsPerSecond: bps, audioBitsPerSecond: 160000 });
  await api.recOpen(ext);
  let chain = Promise.resolve();
  mr.ondataavailable = e => { if (e.data.size) chain = chain.then(async () => api.recChunk(await e.data.arrayBuffer())); };

  rec = { hasAudio: nAudio > 0, fps, segs: [{ t: 0, speed: 1 }], mr, ds, video, timer, ac, micStream, canvas, ext, t0: 0, acc: 0, paused: false, tick: null, info: { w: ow, h: oh, k } };
  rec.donePromise = new Promise(res => { mr.onstop = async () => { await chain; res(await api.recFinish(rec.finishOpts)); }; });
  // stop if the capture source dies
  ds.getVideoTracks()[0].onended = () => stopRecording();
  mr.start(1000);
  rec.t0 = performance.now();
  rec.tick = setInterval(updateTimer, 250);
  speedCb = sp => { if (!rec) return; rec.segs.push({ t: elapsed() / 1000, speed: sp }); show('spd', sp !== 1); $('spd').textContent = sp + '×'; };
  show('spd', false);
  api.recState(true);
  show('idle', false); show('recing', true); show('panel', false); show('result', false); toast('');
  setPaused(false); updateTimer();
}

function elapsed() { return rec ? rec.acc + (rec.paused ? 0 : performance.now() - rec.t0) : 0; }
function updateTimer() {
  const s = Math.floor(elapsed() / 1000), p = n => String(n).padStart(2, '0');
  $('timer').textContent = (s >= 3600 ? p(Math.floor(s / 3600)) + ':' : '') + p(Math.floor(s / 60) % 60) + ':' + p(s % 60);
}
$('btnPause').onclick = () => {
  if (!rec) return;
  if (rec.paused) { rec.mr.resume(); rec.t0 = performance.now(); rec.paused = false; setPaused(false); }
  else { rec.mr.pause(); rec.acc += performance.now() - rec.t0; rec.paused = true; setPaused(true); }
  updateTimer();
};
function setPaused(p) { show('icPause', !p); show('icPlay', p); $('dot').classList.toggle('paused', p); $('btnPause').title = p ? 'Resume' : 'Pause'; }
$('btnStop').onclick = () => stopRecording();

async function stopRecording() {
  if (!rec || rec.stopping) return;
  rec.stopping = true;
  const r = rec;
  if (r.mr.state !== 'inactive') r.mr.stop();
  r.segs.forEach((s, i) => { s.end = i + 1 < r.segs.length ? r.segs[i + 1].t : null; });
  const total = elapsed() / 1000;
  const segments = r.segs.map(s => ({ start: s.t, end: s.end, speed: s.speed })).filter(s => s.end == null || s.end > s.start);
  r.finishOpts = { segments, hasAudio: r.hasAudio, fps: r.fps, total };
  if (segments.some(s => s.speed !== 1)) { r.baking = true; ['btnPause', 'btnStop', 'spd', 'dot'].forEach(id => show(id, false)); $('timer').textContent = 'Baking 0%'; }
  const result = await r.donePromise;
  await teardown();
  showResult(result);
}
async function teardown() {
  if (rec) {
    clearInterval(rec.timer); clearInterval(rec.tick);
    rec.ds.getTracks().forEach(t => t.stop()); rec.micStream.forEach(s => s.getTracks().forEach(t => t.stop()));
    try { await rec.ac.close(); } catch { /* ignore */ }
    rec.video.srcObject = null; rec = null; marks.clear(); zoomCb = null; speedCb = null;
    ['btnPause', 'btnStop', 'dot'].forEach(id => show(id, true)); show('spd', false); api.recState(false);
  }
  show('recing', false); show('idle', true);
}

// ---------- result ----------
function showResult(r) {
  resultFile = r.file; resultKind = r.kind;
  const url = 'file:///' + r.file.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:');
  $('preview').innerHTML = '';
  const el = document.createElement(r.kind === 'image' ? 'img' : 'video');
  el.src = url; if (r.kind === 'video') { el.controls = true; el.muted = false; }
  $('preview').appendChild(el);
  $('rname').textContent = r.file;
  $('rCopy').textContent = r.kind === 'image' ? 'Copy image' : 'Copy path';
  show('result', true); show('panel', false);
}
$('rMove').onclick = async () => {
  const d = await api.moveFile(resultFile);
  if (d) { resultFile = d; $('rname').textContent = 'Moved → ' + d; const v = $('preview').firstChild; if (v && v.pause) v.pause(); }
};
$('rOpen').onclick = () => api.reveal(resultFile);
$('rCopy').onclick = () => (resultKind === 'image' ? api.copyImage(resultFile) : api.copyPath(resultFile));
$('rDel').onclick = () => { const v = $('preview').firstChild; if (v && v.pause) { v.removeAttribute('src'); v.load(); } api.deleteFile(resultFile); show('result', false); };
$('rDone').onclick = () => { const v = $('preview').firstChild; if (v && v.pause) { v.removeAttribute('src'); v.load(); } show('result', false); };
api.onResult(showResult);
api.onError(m => toast(m));
api.onUpdate(u => {
  const m = { dev: 'Updates only work in the installed app.', none: 'You are up to date.', downloading: `Downloading v${u.version}…`, error: 'Update check failed.' };
  if (u.state === 'ready') {
    $('msg').innerHTML = `Update v${u.version} ready — <a href="#" id="inst" style="color:#fff">restart to install</a>`;
    show('msg', true); $('inst').onclick = e => { e.preventDefault(); api.installUpdate(); };
  } else toast(m[u.state] || '');
});

loadSettings();
