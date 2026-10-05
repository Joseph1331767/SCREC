// Main-thread side of the input worker (see inputworker.js).
const { Worker } = require('worker_threads');
const path = require('path');
const koffi = require('koffi');
const PostThreadMessage = koffi.load('user32.dll').func('bool __stdcall PostThreadMessageW(uint32_t tid, uint32_t msg, uintptr_t w, intptr_t l)');

// handlers: { onChord(on), onAct(key), onBtn(btn, down), onWheel(up), onPerf(data), onError(msg) }
function start(handlers, cfg) {
  const file = path.join(__dirname, 'inputworker.js').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  const w = new Worker(file);
  const send = c => w.postMessage({ t: 'cfg', zoom: c.zoom, chord: c.chord, perf: c.perf });
  let tid = 0;
  send(cfg);
  w.on('message', m => {
    if (m.t === 'ready') { tid = m.tid; handlers.onReady && handlers.onReady(m); }
    else if (m.t === 'chord') handlers.onChord(m.on);
    else if (m.t === 'act') handlers.onAct(m.key);
    else if (m.t === 'btn') handlers.onBtn(m.btn, m.down);
    else if (m.t === 'wheel') handlers.onWheel(m.up);
    else if (m.t === 'perf') handlers.onPerf && handlers.onPerf(m.data);
    else if (m.t === 'error') handlers.onError && handlers.onError(m.message);
  });
  w.on('error', e => { console.error('input worker crashed', e); handlers.onError && handlers.onError(String(e && e.message || e)); });
  return {
    config: send,
    // The worker sits in a blocking GetMessage, so it can't see a normal message: wake it with WM_QUIT.
    stop() { try { if (tid) PostThreadMessage(tid, 0x12, 0, 0); } catch { /* ignore */ } },
  };
}

module.exports = { start };
