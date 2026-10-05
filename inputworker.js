// Input worker: owns the Windows low-level keyboard/mouse hooks, the chord state machine and every swallow
// decision, on its OWN thread. The hook callbacks therefore never wait for the app's busy main thread, so SCREC
// can never stall the user's keyboard or cursor -- however loaded the app (or the PC) is. It only reports
// semantic events to the main thread (chord on/off, action keys, mouse buttons, wheel).
//
// While the chord is held, arrows / 1-9 / all mouse buttons / the wheel belong to SCREC and are swallowed so games
// and apps never see them. When the chord is not held nothing is swallowed and the mouse hook does not even exist.
const { parentPort } = require('worker_threads');
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const KBD = koffi.struct('KBDLLHOOKSTRUCT', { vkCode: 'uint32', scanCode: 'uint32', flags: 'uint32', time: 'uint32', extra: 'uintptr_t' });
const MSL = koffi.struct('MSLLHOOKSTRUCT', { x: 'int32', y: 'int32', mouseData: 'uint32', flags: 'uint32', time: 'uint32', extra: 'uintptr_t' });
const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' });
const MSG = koffi.struct('MSG', { hwnd: 'uintptr_t', message: 'uint32', wParam: 'uintptr_t', lParam: 'intptr_t', time: 'uint32', pt: POINT });
const HookProc = koffi.proto('intptr_t __stdcall HookProc(int nCode, uintptr_t wParam, void *lParam)');
const SetHook = user32.func('uintptr_t __stdcall SetWindowsHookExW(int id, HookProc *fn, uintptr_t mod, uint32_t tid)');
const Unhook = user32.func('bool __stdcall UnhookWindowsHookEx(uintptr_t h)');
const CallNext = user32.func('intptr_t __stdcall CallNextHookEx(uintptr_t h, int n, uintptr_t w, void *l)');
const GetMessage = user32.func('int __stdcall GetMessageW(_Out_ MSG *msg, uintptr_t hwnd, uint32_t min, uint32_t max)');
const SetTimer = user32.func('uintptr_t __stdcall SetTimer(uintptr_t hwnd, uintptr_t id, uint32_t ms, void *cb)');
const GetAsync = user32.func('int16_t __stdcall GetAsyncKeyState(int vk)'); // physical key state; injects nothing
const KeybdEvent = user32.func('void __stdcall keybd_event(uint8_t vk, uint8_t sc, uint32_t fl, uintptr_t ex)');
const GetModule = kernel32.func('uintptr_t __stdcall GetModuleHandleW(void *name)');
const GetTick = kernel32.func('uint32_t __stdcall GetTickCount()');
const GetTid = kernel32.func('uint32_t __stdcall GetCurrentThreadId()');

const WH_KEYBOARD_LL = 13, WH_MOUSE_LL = 14, WM_TIMER = 0x113;
const MAGIC = 0x53435243; // dwExtraInfo tag on the one key event SCREC injects itself (the CapsLock correction)
const physDown = vk => (GetAsync(vk) & 0x8000) !== 0;
const now = () => performance.now();
const post = m => parentPort.postMessage(m);

// ---- key tables (Windows virtual-key codes) ----
const VK_CAPS = 0x14;
const MOD_VK = { ctrl: [0xA2, 0xA3], alt: [0xA4, 0xA5], shift: [0xA0, 0xA1], caps: [VK_CAPS] };
const MOD_PHYS = { ctrl: 0x11, alt: 0x12, shift: 0x10, caps: VK_CAPS };
const MODS = Object.keys(MOD_VK);
// A swallowed key never updates Windows' physical key state, so CapsLock (which we swallow) can't be verified with
// GetAsyncKeyState -- trust the hook's own tracking for it.
const physOK = g => g === 'caps' || physDown(MOD_PHYS[g]);
const ACT = { 0x25: 'left', 0x26: 'up', 0x27: 'right', 0x28: 'down' };
for (let n = 1; n <= 9; n++) ACT[0x30 + n] = n;
const TRACKED = new Set([...Object.values(MOD_VK).flat(), ...Object.keys(ACT).map(Number)]);

// ---- state ----
let cfg = { zoom: true, chordMods: ['ctrl', 'shift', 'caps'], perf: false };
const down = new Set();                 // virtual keys we believe are held
const heldKeys = new Set();             // action keys whose DOWN we swallowed => swallow their repeats and UP too
const heldButtons = new Set();          // mouse buttons whose DOWN we swallowed
let chord = false, chordT0 = 0, pendingUnhook = false, capsLeaked = false, capsFix = false, capsFixAt = 0;
let kbHandle = 0, msHandle = 0, badTicks = 0, idleTicks = 0;
const keep = {};
const P = { kbCalls: 0, msMoves: 0, msEvents: 0, kbCbMs: 0, msDelayMs: 0, kbDelayMs: 0 };

const has = g => MOD_VK[g].some(vk => down.has(vk));
const combo = () => cfg.chordMods.every(has);
const directing = () => chord && now() - chordT0 >= 100; // main enters director mode after the same 100 ms debounce

function parseChord(s) {
  const m = String(s || '').split('+').filter(x => MODS.includes(x));
  return m.length >= 2 ? m : ['ctrl', 'shift', 'caps'];
}

// Events can be lost (secure desktop, UAC, Win+L, hook timeout). Forget modifiers the keyboard no longer holds so a
// stale entry can never combine with one fresh key press into a false chord. `except` = the key being pressed right
// now (its physical state is not updated yet while its own hook callback runs).
function dropStale(except) {
  for (const g of MODS) if (!physOK(g) && !MOD_VK[g].includes(except)) MOD_VK[g].forEach(vk => down.delete(vk));
}
function toggleCaps() { // our own correction, tagged so the hook ignores it
  KeybdEvent(VK_CAPS, 0x3A, 0, MAGIC); KeybdEvent(VK_CAPS, 0x3A, 2, MAGIC);
}
function startMouse() { if (!msHandle) msHandle = SetHook(WH_MOUSE_LL, keep.ms, GetModule(null), 0); }
function stopMouse() { if (msHandle) { try { Unhook(msHandle); } catch { /* ignore */ } msHandle = 0; } }
// Chord over: drop the mouse hook, but only after every swallowed button has come up (else its UP would leak to the
// app under the cursor -- e.g. an orphan right-button-up pops a context menu).
function endMouse() {
  if (heldButtons.size) { pendingUnhook = true; return; }
  pendingUnhook = false; stopMouse();
}
function chordStart() {
  chord = true; chordT0 = now(); pendingUnhook = false; badTicks = 0;
  if (cfg.zoom) startMouse();
  if (capsLeaked) { capsLeaked = false; capsFix = true; } // CapsLock was pressed before the other keys, its DOWN already went through and toggled:
  // let its UP through too (a DOWN without an UP leaves Windows thinking the key is held) and undo the toggle after the release
  else if (cfg.chordMods.includes('caps') && down.has(VK_CAPS)) heldKeys.add(VK_CAPS); // swallow its auto-repeat and UP
  post({ t: 'chord', on: true });
}
function chordEnd() {
  chord = false; endMouse();
  post({ t: 'chord', on: false });
}
function forceRelease(why) {
  console.error('chord force-released:', why);
  dropStale(-1); down.delete(VK_CAPS); heldKeys.clear();
  chordEnd();
}

// Each handler returns true when the event must be swallowed.
function keydown(vk) {
  const fresh = !down.has(vk); // first DOWN of this physical press (auto-repeats are not fresh)
  down.add(vk);
  if (!chord && combo()) dropStale(vk);
  if (combo() && !chord) chordStart();
  if (vk === VK_CAPS) return capsKey(fresh);
  const key = ACT[vk];
  if (key === undefined) return false;
  // Decide once per press: a key whose first DOWN reached the app is never swallowed (neither repeats nor the UP),
  // a key whose first DOWN was swallowed stays swallowed until its UP, even if the chord ends first. Both halves of
  // a press go to the same place, so nothing ever sticks.
  if (fresh) { if (chord && cfg.zoom) heldKeys.add(vk); else heldKeys.delete(vk); }
  if (!heldKeys.has(vk)) return false;
  if (chord) post({ t: 'act', key });
  return true;
}
// CapsLock as part of the chord must never toggle caps. Pressed after the other keys it is swallowed outright.
// Pressed before them its toggle has already happened, so it is undone when the chord completes (chordStart).
function capsKey(fresh) {
  if (!cfg.zoom || !cfg.chordMods.includes('caps')) return false;
  if (fresh) {
    const others = cfg.chordMods.filter(m => m !== 'caps');
    if (others.every(has)) heldKeys.add(VK_CAPS); else { heldKeys.delete(VK_CAPS); capsLeaked = true; }
  }
  return heldKeys.has(VK_CAPS);
}
function keyup(vk) {
  down.delete(vk);
  if (vk === VK_CAPS && !chord) capsLeaked = false; // plain CapsLock use, nothing to undo
  if (chord && !combo()) chordEnd();
  const swallow = heldKeys.delete(vk);
  // Windows ignores a toggle injected while the physical key is still down, so undo the early toggle after its release
  if (vk === VK_CAPS && capsFix) { capsFix = false; capsFixAt = now() + 50; }
  return swallow;
}
function button(btn, isDown) {
  if (isDown) {
    if (!chord || !cfg.zoom) return false;
    heldButtons.add(btn);
    if (btn === 1 || btn === 2) post({ t: 'btn', btn, down: true });
    return true;
  }
  const had = heldButtons.delete(btn);
  if (btn === 1 || btn === 2) post({ t: 'btn', btn, down: false });
  return had;
}
function wheel(delta) {
  if (!cfg.zoom || !delta || !directing()) return false;
  post({ t: 'wheel', up: delta > 0 });
  return true;
}

keep.kb = koffi.register((nCode, wParam, lParam) => {
  if (nCode >= 0) {
    let swallow = false;
    const t0 = cfg.perf ? now() : 0;
    try {
      const k = koffi.decode(lParam, KBD);
      if (cfg.perf) { P.kbCalls++; P.kbDelayMs = Math.max(P.kbDelayMs, (GetTick() - k.time) >>> 0); }
      if (TRACKED.has(k.vkCode) && Number(k.extra) !== MAGIC) {
        const isDown = wParam === 0x100 || wParam === 0x104;
        swallow = isDown ? keydown(k.vkCode) : keyup(k.vkCode);
      }
    } catch (e) { console.error('key hook', e); }
    if (cfg.perf) P.kbCbMs = Math.max(P.kbCbMs, now() - t0);
    if (swallow) return 1;
  }
  return CallNext(0, nCode, wParam, lParam);
}, koffi.pointer(HookProc));

keep.ms = koffi.register((nCode, wParam, lParam) => {
  if (nCode >= 0) {
    const w = Number(wParam);
    if (w === 0x200) { // mouse move: nothing to do
      if (cfg.perf && (++P.msMoves % 25 === 0)) P.msDelayMs = Math.max(P.msDelayMs, (GetTick() - koffi.decode(lParam, MSL).time) >>> 0);
      return CallNext(0, nCode, wParam, lParam);
    }
    let swallow = false;
    try {
      if (cfg.perf) P.msEvents++;
      if (w === 0x201 || w === 0x202) swallow = button(1, w === 0x201);
      else if (w === 0x204 || w === 0x205) swallow = button(2, w === 0x204);
      else if (w === 0x207 || w === 0x208) swallow = button(3, w === 0x207);
      else if (w === 0x20B || w === 0x20C) swallow = button((koffi.decode(lParam, MSL).mouseData >>> 16) === 1 ? 4 : 5, w === 0x20B);
      else if (w === 0x20A) swallow = wheel(((koffi.decode(lParam, MSL).mouseData >>> 16) << 16) >> 16);
      else if (w === 0x20E) swallow = cfg.zoom && directing();
      if (pendingUnhook && !heldButtons.size) idleTicks = 99; // unhook on the next tick, not inside the callback
    } catch (e) { console.error('mouse hook', e); }
    if (swallow) return 1;
  }
  return CallNext(0, nCode, wParam, lParam);
}, koffi.pointer(HookProc));

// Every 150 ms (WM_TIMER): the real keyboard/mouse state is the source of truth for the chord.
function watchdog() {
  // undo the early CapsLock toggle once no Ctrl/Alt/Shift is down (with Shift held the injected toggle doesn't take)
  if (capsFixAt && now() >= capsFixAt) {
    if (!physDown(0x10) && !physDown(0x11) && !physDown(0x12)) { capsFixAt = 0; toggleCaps(); }
    else if (now() > capsFixAt + 8000) capsFixAt = 0;
  }
  if (chord && !cfg.chordMods.every(physOK)) { if (++badTicks >= 2) { badTicks = 0; forceRelease('modifier released without a key-up'); } } else badTicks = 0;
  if (pendingUnhook) { // a swallowed button whose UP never arrived (physically up) must not keep the hook alive
    const anyDown = [0x01, 0x02, 0x04, 0x05, 0x06].some(physDown);
    if (!heldButtons.size || (!anyDown && ++idleTicks >= 2)) { heldButtons.clear(); pendingUnhook = false; idleTicks = 0; stopMouse(); }
  } else idleTicks = 0;
  if (cfg.perf) { post({ t: 'perf', data: { ...P } }); P.kbCalls = P.msMoves = P.msEvents = P.kbCbMs = P.msDelayMs = P.kbDelayMs = 0; }
}

parentPort.on('message', m => {
  if (m.t === 'cfg') { cfg = { ...cfg, zoom: m.zoom !== false, chordMods: parseChord(m.chord), perf: !!m.perf }; }
});

(async function main() {
  kbHandle = SetHook(WH_KEYBOARD_LL, keep.kb, GetModule(null), 0);
  if (!kbHandle) { post({ t: 'error', message: 'SetWindowsHookEx failed' }); return; }
  SetTimer(0, 1, 150, null); // posts WM_TIMER to this thread's queue every 150 ms
  post({ t: 'ready', tid: GetTid() });
  const msg = {};
  for (;;) { // the hooks' callbacks run inside GetMessage; it returns for WM_TIMER, letting commands from main be handled
    const r = GetMessage(msg, 0, 0, 0);
    if (r <= 0) break; // WM_QUIT (posted by main on shutdown)
    if (msg.message === WM_TIMER) watchdog();
    await new Promise(res => setImmediate(res));
  }
  stopMouse(); try { if (kbHandle) Unhook(kbHandle); } catch { /* ignore */ }
  process.exit(0);
})();
