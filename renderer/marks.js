// Freehand marks (RMB drag) and attention beacons (RMB tap).
// Coordinates are absolute screen DIP; the caller sets the canvas transform. Used by the live overlay
// (what you see) and by the recorder (what viewers get painted into the video).
class Marks {
  constructor() { this.strokes = []; this.beacons = []; this.cur = null; }
  get empty() { return !this.strokes.length && !this.beacons.length; }
  clear() { this.strokes = []; this.beacons = []; this.cur = null; }

  handle(m) {
    const now = performance.now();
    if (m.type === 'start') {
      this.cur = { pts: [{ x: m.x, y: m.y }], style: m.style, t0: now, end: 0, len: 0 };
      this.strokes.push(this.cur);
    } else if (m.type === 'pts' && this.cur) { // batched [x0,y0,x1,y1,...]; points closer than ~1.5 px are dropped
      for (let i = 0; i < m.pts.length; i += 2) {
        const l = this.cur.pts[this.cur.pts.length - 1], x = m.pts[i], y = m.pts[i + 1], d = Math.hypot(x - l.x, y - l.y);
        if (d < 1.5) continue;
        this.cur.len += d; this.cur.pts.push({ x, y });
      }
    } else if (m.type === 'end' && this.cur) {
      if (now - this.cur.t0 < 320 && this.cur.len < 10) { // a tap -> beacon
        this.beacons.push({ x: this.cur.pts[0].x, y: this.cur.pts[0].y, t0: now, style: this.cur.style });
        this.strokes.splice(this.strokes.indexOf(this.cur), 1);
      } else this.cur.end = now;
      this.cur = null;
    } else if (m.type === 'reset') this.clear();
  }

  draw(ctx) {
    const now = performance.now(), HOLD = 1500, FADE = 700, BEACON = 1900;
    this.strokes = this.strokes.filter(s => s === this.cur || now - s.end < HOLD + FADE);
    this.beacons = this.beacons.filter(b => now - b.t0 < BEACON);
    for (const s of this.strokes) Marks.stroke(ctx, s, s === this.cur ? 1 : Math.min(1, 1 - (now - s.end - HOLD) / FADE));
    for (const b of this.beacons) Marks.beacon(ctx, b, now - b.t0, BEACON);
  }

  static stroke(ctx, s, alpha) {
    const { color, style, size: w } = s.style;
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = color; ctx.globalAlpha = alpha;
    if (style === 'marker') { ctx.lineWidth = w * 3.2; ctx.globalAlpha = alpha * 0.4; ctx.lineCap = 'butt'; }
    else if (style === 'glow') { ctx.lineWidth = w; ctx.shadowColor = color; ctx.shadowBlur = w * 3; }
    else ctx.lineWidth = w;
    ctx.beginPath();
    const q = s.pts;
    ctx.moveTo(q[0].x, q[0].y);
    if (q.length === 1) ctx.lineTo(q[0].x + 0.1, q[0].y);
    else if (q.length === 2) ctx.lineTo(q[1].x, q[1].y);
    else {
      for (let i = 1; i < q.length - 1; i++) ctx.quadraticCurveTo(q[i].x, q[i].y, (q[i].x + q[i + 1].x) / 2, (q[i].y + q[i + 1].y) / 2);
      ctx.lineTo(q[q.length - 1].x, q[q.length - 1].y);
    }
    ctx.stroke();
    if (style === 'glow') { ctx.shadowBlur = 0; ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(1, w * 0.35); ctx.globalAlpha = alpha * 0.9; ctx.stroke(); }
    ctx.restore();
  }

  static beacon(ctx, b, t, total) {
    const k = t / total, color = b.style.color;
    ctx.save();
    ctx.strokeStyle = color; ctx.fillStyle = color;
    for (let i = 0; i < 3; i++) {
      const kk = k * 2.2 - i * 0.28; if (kk < 0 || kk > 1) continue;
      ctx.globalAlpha = (1 - kk) * 0.9; ctx.lineWidth = 4 * (1 - kk) + 1;
      ctx.beginPath(); ctx.arc(b.x, b.y, 10 + 80 * kk, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = Math.max(0, 1 - k) * (0.65 + 0.35 * Math.sin(t / 90));
    ctx.beginPath(); ctx.arc(b.x, b.y, 9, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}
