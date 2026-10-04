// Bakes playback-speed changes into a finished recording with ffmpeg.
// segments: [{ start, end|null, speed }] in seconds of recorded media time.
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

function bake(file, segments, { hasAudio, fps }, onProgress) {
  const segs = normalize(segments);
  const total = segs.reduce((t, s) => t + ((s.end ?? s.start + 1) - s.start) / s.speed, 0);
  const parts = [], ins = [];
  segs.forEach((s, i) => {
    const range = `start=${s.start}` + (s.end != null ? `:end=${s.end}` : '');
    parts.push(`[0:v]trim=${range},setpts=(PTS-STARTPTS)/${s.speed}[v${i}]`);
    if (hasAudio) parts.push(`[0:a]atrim=${range},asetpts=PTS-STARTPTS,${atempo(s.speed)}[a${i}]`);
    ins.push(`[v${i}]` + (hasAudio ? `[a${i}]` : ''));
  });
  parts.push(`${ins.join('')}concat=n=${segs.length}:v=1:a=${hasAudio ? 1 : 0}[vc]${hasAudio ? '[ac]' : ''}`);
  parts.push(`[vc]fps=${fps || 30}[v]`);
  const out = path.join(path.dirname(file), path.basename(file, path.extname(file)) + '.baking.mp4');
  const args = ['-y', '-i', file, '-filter_complex', parts.join(';'), '-map', '[v]'];
  if (hasAudio) args.push('-map', '[ac]');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
  if (hasAudio) args.push('-c:a', 'aac', '-b:a', '160k');
  args.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', out);

  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), args, { windowsHide: true });
    try { require('os').setPriority(p.pid, require('os').constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* ignore */ } // don't starve a game running meanwhile
    let err = '';
    p.stdout.on('data', d => {
      const m = /out_time_us=(\d+)/.exec(String(d));
      if (m && total > 0) onProgress && onProgress(Math.min(0.99, Number(m[1]) / 1e6 / total));
    });
    p.stderr.on('data', d => { err = (err + d).slice(-2000); });
    p.on('error', reject);
    p.on('close', code => {
      if (code !== 0) { try { fs.unlinkSync(out); } catch { /* ignore */ } return reject(new Error('ffmpeg failed: ' + err.slice(-300))); }
      const final = path.join(path.dirname(file), path.basename(file, path.extname(file)) + '.mp4');
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      fs.renameSync(out, final);
      resolve(final);
    });
  });
}

module.exports = { bake, needsBake };
