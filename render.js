// Bakes playback-speed changes into a finished recording with ffmpeg.
// segments: [{ start, end|null, speed }] in seconds of recorded media time.
//
// Video and audio are processed in SEPARATE passes and muxed with a stream copy. A single filter graph that
// concat-ed video and audio branches stalled badly (the audio branches back up against the slow-motion video
// branch): a 95 s clip took 143 s, with ~80 s spent before the first 10 %. Separately it is ~15 s.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function ffmpegPath() {
  return require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
}

function atempo(speed) {
  const parts = [];
  while (speed > 2) { parts.push('atempo=2'); speed /= 2; }
  while (speed < 0.5) { parts.push('atempo=0.5'); speed *= 2; }
  parts.push('atempo=' + speed.toFixed(4));
  return parts.join(',');
}

// Drop tiny segments and merge neighbours that share a speed.
function normalize(segments) {
  const out = [];
  for (const s of segments) {
    if (s.end != null && s.end - s.start < 0.05) continue;
    const last = out[out.length - 1];
    if (last && last.speed === s.speed) last.end = s.end; else out.push({ ...s });
  }
  return out;
}

function needsBake(segments) {
  return normalize(segments).some(s => s.speed !== 1);
}

const running = new Set(); // running ffmpeg children
let temps = [];                // temp files to remove on cancel/quit
let cancelled = false;

function unlinkQuiet(f) { try { fs.unlinkSync(f); } catch { /* ignore */ } }

// Stops a running bake (user cancel or app quit) and removes its temp files. The raw recording is never touched.
function cancel() {
  cancelled = true;
  for (const p of running) { try { p.kill(); } catch { /* ignore */ } }
  for (const f of temps) unlinkQuiet(f);
}

function run(args, onTime) {
  return new Promise((resolve, reject) => {
    if (cancelled) return reject(new Error('cancelled'));
    const p = spawn(ffmpegPath(), ['-hide_banner', '-nostats', '-progress', 'pipe:1', ...args], { windowsHide: true });
    running.add(p);
    let err = '';
    p.stdout.on('data', d => {
      const m = /out_time_us=(\d+)/.exec(String(d));
      if (m && onTime) onTime(Number(m[1]) / 1e6);
    });
    p.stderr.on('data', d => { err = (err + d).slice(-2000); });
    p.on('error', e => { running.delete(p); reject(e); });
    p.on('close', code => {
      running.delete(p);
      if (cancelled) return reject(new Error('cancelled'));
      if (code !== 0) return reject(new Error('ffmpeg failed: ' + err.slice(-300)));
      resolve();
    });
  });
}

async function bake(file, segments, { hasAudio, fps }, onProgress) {
  cancelled = false;
  const segs = normalize(segments);
  const total = Math.max(0.1, segs.reduce((t, s) => t + ((s.end ?? s.start + 1) - s.start) / s.speed, 0));
  const dir = path.dirname(file), base = path.basename(file, path.extname(file));
  const vTmp = path.join(dir, base + '.baking.v.mp4'), aTmp = path.join(dir, base + '.baking.a.m4a'), out = path.join(dir, base + '.baking.mp4');
  temps = [vTmp, aTmp, out];
  let vFrac = 0, aFrac = hasAudio ? 0 : 1;
  const report = () => onProgress && onProgress(Math.min(0.99, vFrac * 0.85 + aFrac * 0.12));
  const range = s => `start=${s.start}` + (s.end != null ? `:end=${s.end}` : '');

  try {
    // video and audio are independent, so run both passes at once
    const vf = segs.map((s, i) => `[0:v]trim=${range(s)},setpts=(PTS-STARTPTS)/${s.speed}[v${i}]`)
      .concat(`${segs.map((_, i) => `[v${i}]`).join('')}concat=n=${segs.length}:v=1:a=0[vc]`, `[vc]fps=${fps || 30}[v]`).join(';');
    const passes = [run(['-y', '-i', file, '-filter_complex', vf, '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', vTmp],
      t => { vFrac = Math.min(1, t / total); report(); })];
    if (hasAudio) {
      const af = segs.map((s, i) => `[0:a]atrim=${range(s)},asetpts=PTS-STARTPTS,${atempo(s.speed)}[a${i}]`)
        .concat(`${segs.map((_, i) => `[a${i}]`).join('')}concat=n=${segs.length}:v=0:a=1[a]`).join(';');
      passes.push(run(['-y', '-i', file, '-filter_complex', af, '-map', '[a]', '-c:a', 'aac', '-b:a', '160k', aTmp],
        t => { aFrac = Math.min(1, t / total); report(); }));
    }
    await Promise.all(passes);
    if (cancelled) throw new Error('cancelled');
    // mux, no re-encode
    await run(['-y', '-i', vTmp, ...(hasAudio ? ['-i', aTmp] : []), '-c', 'copy', '-movflags', '+faststart', out], null);
  } catch (e) {
    cancel(); // kills whichever pass is still running (e.g. when the other failed) and removes temp files
    temps = [];
    throw e; // raw recording is untouched
  }
  const final = path.join(dir, base + '.mp4');
  unlinkQuiet(vTmp); unlinkQuiet(aTmp);
  unlinkQuiet(file); // replaced by the baked file
  fs.renameSync(out, final);
  temps = [];
  return final;
}

module.exports = { bake, needsBake, cancel };
