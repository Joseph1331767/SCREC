// Generates build/icon.png (256x256 red record dot on dark rounded square) with no deps.
const zlib = require('zlib'), fs = require('fs');
const N = 256, raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  for (let x = 0; x < N; x++) {
    const o = y * (N * 4 + 1) + 1 + x * 4;
    const dx = x - 127.5, dy = y - 127.5, r = Math.hypot(dx, dy);
    const cx = Math.max(Math.abs(dx) - 88, 0), cy = Math.max(Math.abs(dy) - 88, 0);
    const inSq = Math.hypot(cx, cy) <= 40;
    let c = [0, 0, 0, 0];
    if (inSq) c = [28, 30, 38, 255];
    if (r < 62) c = [239, 68, 68, 255];
    else if (r < 80 && inSq) c = [239, 68, 68, 255 * (r > 72 ? 0.0 : 1)] && (r < 72 ? [239, 68, 68, 255] : c);
    raw.set(c, o);
  }
}
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = b => { let c = ~0; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return ~c >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
fs.writeFileSync('build/icon.png', Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
