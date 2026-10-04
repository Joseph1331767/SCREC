// In-process low-level keyboard/mouse hooks (Windows) via koffi -- no helper executable, and unlike a
// listen-only hook they can SWALLOW events, so while the hotkey chord is held games/apps never see them.
// Callbacks return true to swallow the event. They run on the main thread inside the hook callback, so keep them fast.
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const KBD = koffi.struct('KBDLLHOOKSTRUCT', { vkCode: 'uint32', scanCode: 'uint32', flags: 'uint32', time: 'uint32', extra: 'uintptr_t' });
const MSL = koffi.struct('MSLLHOOKSTRUCT', { x: 'int32', y: 'int32', mouseData: 'uint32', flags: 'uint32', time: 'uint32', extra: 'uintptr_t' });
const HookProc = koffi.proto('intptr_t __stdcall HookProc(int nCode, uintptr_t wParam, void *lParam)');
const SetHook = user32.func('uintptr_t __stdcall SetWindowsHookExW(int id, HookProc *fn, uintptr_t mod, uint32_t tid)');
const Unhook = user32.func('bool __stdcall UnhookWindowsHookEx(uintptr_t h)');
const CallNext = user32.func('intptr_t __stdcall CallNextHookEx(uintptr_t h, int n, uintptr_t w, void *l)');
const GetModule = kernel32.func('uintptr_t __stdcall GetModuleHandleW(void *name)');
const GetAsync = user32.func('int16_t __stdcall GetAsyncKeyState(int vk)'); // read-only physical key state; injects nothing
const physDown = vk => (GetAsync(vk) & 0x8000) !== 0;

const WH_KEYBOARD_LL = 13, WH_MOUSE_LL = 14;
const KEYS_DOWN = new Set([0x100, 0x104]);

// onKey(vk, isDown) / onButton(btn 1=left 2=right 3=middle 4/5=X1/X2, isDown) / onWheel(delta) / onHWheel() -> true to swallow.
// The keyboard hook is always on (it must see the chord). The mouse hook only exists while the chord is
// held (startMouse/stopMouse), so normal mouse input -- games -- never goes through this process.
function start({ onKey, onButton, onWheel, onHWheel }) {
  const mod = GetModule(null);
  let kbHandle = 0, msHandle = 0;
  const keep = {}; // callbacks must stay referenced

  keep.kb = koffi.register((nCode, wParam, lParam) => {
    if (nCode >= 0) {
      let swallow = false;
      try { swallow = !!onKey(koffi.decode(lParam, KBD).vkCode, KEYS_DOWN.has(Number(wParam))); } catch (e) { console.error('key hook', e); }
      if (swallow) return 1;
    }
    return CallNext(0, nCode, wParam, lParam);
  }, koffi.pointer(HookProc));

  keep.ms = koffi.register((nCode, wParam, lParam) => {
    if (nCode >= 0) {
      const w = Number(wParam);
      if (w === 0x200) return CallNext(0, nCode, wParam, lParam); // mouse move: nothing to do
      let swallow = false;
      try {
        if (w === 0x201 || w === 0x202) swallow = !!onButton(1, w === 0x201);
        else if (w === 0x204 || w === 0x205) swallow = !!onButton(2, w === 0x204);
        else if (w === 0x207 || w === 0x208) swallow = !!onButton(3, w === 0x207);
        else if (w === 0x20B || w === 0x20C) swallow = !!onButton((koffi.decode(lParam, MSL).mouseData >>> 16) === 1 ? 4 : 5, w === 0x20B);
        else if (w === 0x20A) swallow = !!onWheel(((koffi.decode(lParam, MSL).mouseData >>> 16) << 16) >> 16);
        else if (w === 0x20E) swallow = !!(onHWheel && onHWheel());
      } catch (e) { console.error('mouse hook', e); }
      if (swallow) return 1;
    }
    return CallNext(0, nCode, wParam, lParam);
  }, koffi.pointer(HookProc));

  kbHandle = SetHook(WH_KEYBOARD_LL, keep.kb, mod, 0);
  if (!kbHandle) throw new Error('SetWindowsHookEx failed');
  return {
    startMouse() { if (!msHandle) msHandle = SetHook(WH_MOUSE_LL, keep.ms, mod, 0); },
    stopMouse() { if (msHandle) { try { Unhook(msHandle); } catch { /* ignore */ } msHandle = 0; } },
    stop() { this.stopMouse(); try { Unhook(kbHandle); } catch { /* ignore */ } },
    // Physical state straight from the OS (not from hook events, which can be lost: secure desktop, hook timeout...).
    mods() { return { ctrl: physDown(0x11), alt: physDown(0x12), shift: physDown(0x10) }; },
    buttonsDown() { return [0x01, 0x02, 0x04, 0x05, 0x06].some(physDown); },
  };
}

module.exports = { start };
