// Lightweight performance logger. Enable with SCREC_PERF=1 (dev) or the tray menu "Performance log".
// Once a second it prints/appends one line: main-thread event-loop lag, IPC message rates, input-hook latency,
// plus what the overlay (fps) and the recorder (draws/s, draw time) report from their renderers.
const fs = require('fs');
const path = require('path');

let on = false, file = null, timer = null, lagTimer = null;
let c = {}, m = {}, r = {};       // counters, maxima, renderer reports (last value)
let lagMax = 0, lagN50 = 0, last = 0;

const count = (k, n = 1) => { if (on) c[k] = (c[k] || 0) + n; };
const max = (k, v) => { if (on && v > (m[k] || 0)) m[k] = v; };
const report = (name, data) => { if (on) r[name] = data; };

function flush() {
  const line = '[perf] ' + JSON.stringify({ lagMaxMs: Math.round(lagMax), lag50: lagN50, ...c, ...Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Math.round(v * 100) / 100])), ...r });
  console.log(line);
  if (file) { try { fs.appendFileSync(file, new Date().toISOString() + ' ' + line + '\n'); } catch { /* ignore */ } }
  c = {}; m = {}; r = {}; lagMax = 0; lagN50 = 0;
}

function start(dir) {
  if (on) return;
  on = true;
  file = dir ? path.join(dir, 'perf.log') : null;
  last = performance.now();
  lagTimer = setInterval(() => { // how late does a 10 ms timer fire = how busy the main thread is
    const n = performance.now(), lag = n - last - 10; last = n;
    if (lag > lagMax) lagMax = lag;
    if (lag > 50) lagN50++;
  }, 10);
  timer = setInterval(flush, 1000);
  if (file) console.log('[perf] logging to', file);
}
function stop() { on = false; clearInterval(timer); clearInterval(lagTimer); c = {}; m = {}; r = {}; }

module.exports = { start, stop, count, max, report, get on() { return on; } };
