// Dev-only end-to-end test: SCREC_SELFTEST=1 npm start
// Records a region while simulating the director hotkeys (zoom box, annotations, beacon, speed changes).
const fs = require('fs');
const { spawn } = require('child_process');

module.exports = ({ app, barWin, screen, captureImage, beginVideo, hk }) => {
  const d = screen.getPrimaryDisplay();
  const sf = d.scaleFactor;
  const log = m => console.log('[selftest]', m);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ps = spawn('powershell', ['-NoProfile', '-Command',
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing; while($l=[Console]::In.ReadLine()){$p=$l.Split(" ");[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point([int]$p[0],[int]$p[1])}']);
  const move = (x, y) => ps.stdin.write(`${Math.round(x * sf)} ${Math.round(y * sf)}\n`);
  const glide = async (x0, y0, x1, y1, ms) => { const n = Math.max(2, Math.round(ms / 40)); for (let i = 1; i <= n; i++) { move(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n); await sleep(ms / n); } };
  const key = async (c, hold = 80) => { hk.keydown(c); await sleep(hold); hk.keyup(c); };

  (async () => {
    await sleep(3000);
    log(`display ${d.bounds.width}x${d.bounds.height} scale ${sf}`);
    const region = { x: 200, y: 150, width: 1600, height: 900 };
    await captureImage(d, region);
    await beginVideo(d, region); log('recording started');
    await sleep(2500);                                   // 0-2.5s  plain, normal speed
    move(700, 450); await sleep(200);
    [29, 56, 42].forEach(c => hk.keydown(c)); await sleep(400); log('chord held, box visible');
    await sleep(1200);                                   // aim box without LMB (not zoomed)
    hk.mousedown(1); log('LMB: zoom engaged');
    await glide(700, 450, 1200, 600, 1800);              // box follows mouse, video zoomed
    hk.wheel(-1); await sleep(900);                      // zoom amount up
    hk.keydown(57421); hk.keyup(57421); hk.keydown(57421); hk.keyup(57421); await sleep(600); // nudge
    hk.mousedown(2);                                     // RMB draw
    for (let a = 0; a <= 6.4; a += 0.2) { move(1200 + 120 * Math.cos(a), 600 + 90 * Math.sin(a)); await sleep(40); }
    hk.mouseup(2); await sleep(600);
    hk.mousedown(2); await sleep(80); hk.mouseup(2); log('beacon tap'); await sleep(1500);
    hk.mouseup(1); log('LMB released: zoom out'); await sleep(1500);
    hk.keydown(10); log('speed 9'); await sleep(2500);   // 4x for ~2.5s
    hk.keydown(2); log('speed 1'); await sleep(1500);    // 0.25x for ~1.5s
    hk.keydown(6); log('speed 5'); await sleep(2000);    // normal
    [29, 56, 42].forEach(c => hk.keyup(c)); await sleep(1500);
    await barWin.webContents.executeJavaScript("document.getElementById('btnStop').click()");
    await sleep(25000);
    log('files: ' + fs.readdirSync(app.getPath('videos') + '/SCREC').join(', '));
    ps.kill(); app.quit();
  })().catch(e => { console.error('[selftest] FAILED', e); app.quit(); });
};
