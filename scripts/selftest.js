// Dev-only end-to-end test: SCREC_SELFTEST=1 npm start
// Records a region while exercising the director hotkeys (zoom box, annotations, beacon, speed changes).
//   SCREC_SELFTEST_REAL=1      inject genuine OS-level key/mouse events (what a user does) instead of calling handlers
//   SCREC_SELFTEST_CHROME=url  play a page/video in a separate Chrome profile underneath the recording
const fs = require('fs');
const { spawn } = require('child_process');

const PS = `
Add-Type -Namespace W -Name U -MemberDefinition '
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint fl, UIntPtr ex);
[DllImport("user32.dll")] public static extern void mouse_event(uint fl, int dx, int dy, int d, UIntPtr ex);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);'
Add-Type -TypeDefinition @'
using System; using System.Diagnostics; using System.Runtime.InteropServices;
public class J { [DllImport("user32.dll")] static extern void mouse_event(uint f, int dx, int dy, int d, UIntPtr e);
  public static void Run(int ms, int hz) { var sw = Stopwatch.StartNew(); double a = 0, step = 1000.0 / hz, next = 0; while (sw.ElapsedMilliseconds < ms) { if (sw.Elapsed.TotalMilliseconds >= next) { next += step; a += 0.04; mouse_event(1, (int)(Math.Cos(a) * 4), (int)(Math.Sin(a) * 4), 0, UIntPtr.Zero); } } } }
'@
[W.U]::SetProcessDPIAware() | Out-Null
while ($l = [Console]::In.ReadLine()) {
  $p = $l.Split(' ')
  switch ($p[0]) {
    'P' { [W.U]::SetCursorPos([int]$p[1], [int]$p[2]) | Out-Null }
    'K' { $fl = 0; if ($p[2] -eq 'u') { $fl = 2 }; if ($p[3] -eq 'x') { $fl = $fl -bor 1 }; [W.U]::keybd_event([byte][int]$p[1], 0, $fl, [UIntPtr]::Zero) }
    'M' { [W.U]::mouse_event([uint32][int]$p[1], 0, 0, 0, [UIntPtr]::Zero) }
    'F' { $h = [W.U]::GetForegroundWindow(); $sb = New-Object System.Text.StringBuilder 200; $cb = New-Object System.Text.StringBuilder 200; [W.U]::GetWindowText($h, $sb, 200) | Out-Null; [W.U]::GetClassName($h, $cb, 200) | Out-Null; Write-Output ('FG ' + $p[1] + ' class=' + $cb.ToString() + ' title=' + $sb.ToString()) }
    'J' { [J]::Run([int]$p[1], [int]$p[2]) }
    'W' { [W.U]::mouse_event(2048, 0, 0, [int]$p[1], [UIntPtr]::Zero) }
  }
}`;

module.exports = ({ app, barWin, screen, captureImage, beginVideo, hk, act, swallowed }) => {
  const d = screen.getPrimaryDisplay();
  const sf = d.scaleFactor;
  const real = !!process.env.SCREC_SELFTEST_REAL;
  const log = m => console.log('[selftest]', m);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ps = spawn('powershell', ['-NoProfile', '-Command', PS]);
  const send = l => ps.stdin.write(l + '\n');
  ps.stdout.on('data', d => String(d).split(/\r?\n/).filter(x => x.startsWith('FG')).forEach(x => log(x)));
  const move = (x, y) => send(`P ${Math.round(x * sf)} ${Math.round(y * sf)}`);
  const glide = async (x0, y0, x1, y1, ms) => { const n = Math.max(2, Math.round(ms / 40)); for (let i = 1; i <= n; i++) { move(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n); await sleep(ms / n); } };

  // chord / mouse / keys: real OS events or direct handler calls
  const VK = { ctrl: 0x11, alt: 0x12, shift: 0x10, caps: 0x14 };
  const chordKeys = (process.env.SCREC_CHORD || 'ctrl+shift+caps').split('+'); // must match the app's `chord` setting
  const chordDown = async () => { if (real) { for (const k of chordKeys) { send(`K ${VK[k]} d`); await sleep(40); } } else hk.chordStart(); };
  const chordUp = async () => { if (real) { for (const k of chordKeys.slice().reverse()) { send(`K ${VK[k]} u`); await sleep(40); } } else hk.chordEnd(); };
  const lmb = down => (real ? send(`M ${down ? 2 : 4}`) : hk.btn(1, down));
  const rmb = down => (real ? send(`M ${down ? 8 : 16}`) : hk.btn(2, down));
  const wheelUp = () => (real ? send('W 120') : hk.wheel(true));
  const arrowRight = async () => { if (real) { send('K 39 d x'); await sleep(40); send('K 39 u x'); } else act('right'); };
  const digit = async n => { if (real) { send(`K ${0x30 + n} d`); await sleep(40); send(`K ${0x30 + n} u`); } else act(n); };
  const stop = () => barWin.webContents.executeJavaScript("document.getElementById('btnStop').click()");

  (async () => {
    let chrome = null;
    if (process.env.SCREC_SELFTEST_CHROME) {
      const u = process.env.SCREC_SELFTEST_CHROME;
      chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--user-data-dir=' + require('path').join(app.getPath('temp'), 'st-chrome'), '--no-first-run',
        '--app=' + (u.startsWith('http') ? '' : 'file:///') + u, '--window-position=0,0', '--window-size=1700,1000', '--autoplay-policy=no-user-gesture-required']);
      await sleep(9000);
    }
    await sleep(3000);
    log(`display ${d.bounds.width}x${d.bounds.height} scale ${sf} real=${real}`);
    const region = { x: 200, y: 150, width: 1600, height: 900 };
    await captureImage(d, region);
    await beginVideo(d, region); log('recording started');
    await sleep(2500);
    move(700, 450); await sleep(200);
    if (!process.env.SCREC_NOCHORD && !(process.env.SCREC_STEPS || '').startsWith('rawclick')) await chordDown(); await sleep(500); log('chord held; swallowed keys/buttons: ' + swallowed());
    await sleep(1200);
    const steps = (process.env.SCREC_STEPS || 'lmb,wheel,arrow,draw,beacon,digits').split(',');
    const on = s => steps.includes(s);
    send('F before-click'); await sleep(300);
    if (on('lmb')) { lmb(true); await sleep(300); send('F during-lmb'); await sleep(300); log('LMB: zoom engaged'); await glide(700, 450, 1200, 600, 1800); }
    if (on('wheel')) { wheelUp(); await sleep(900); }
    if (on('arrow')) { await arrowRight(); await arrowRight(); await sleep(600); }
    if (on('draw')) { rmb(true); for (let a = 0; a <= 6.4; a += 0.2) { move(1200 + 120 * Math.cos(a), 600 + 90 * Math.sin(a)); await sleep(40); } rmb(false); await sleep(600); }
    if (on('beacon')) { rmb(true); await sleep(80); rmb(false); log('beacon tap'); await sleep(1500); }
    if (on('lmb')) { lmb(false); log('LMB released: zoom out'); await sleep(800); send('F after-lmb'); await sleep(700); }
    if (on('digits')) { await digit(9); log('speed 9'); await sleep(2500); await digit(1); log('speed 1'); await sleep(1500); await digit(5); log('speed 5'); await sleep(2000); }
    if (on('rawclick')) { /* no chord: plain real click on the page */ await chordUp(); move(700, 450); await sleep(300); lmb(true); await sleep(80); lmb(false); log('raw click'); await sleep(4000); }
    if (on('diag')) {
      for (let i = 0; i < 9; i++) {
        const r = await barWin.webContents.executeJavaScript(`(() => { try { const v = rec.video, tr = rec.ds.getVideoTracks()[0];
          const c = document.createElement('canvas'); c.width = 64; c.height = 36; const x = c.getContext('2d'); x.drawImage(v, 0, 0, 64, 36); const d = x.getImageData(0, 0, 64, 36).data; let s = 0; for (let k = 0; k < d.length; k += 4) s += d[k];
          const o = rec.canvas.getContext('2d').getImageData(Math.floor(rec.canvas.width / 2), Math.floor(rec.canvas.height / 2), 1, 1).data;
          return JSON.stringify({ vidLuma: Math.round(s / (d.length / 4)), outPx: o[0], rs: v.readyState, paused: v.paused, vw: v.videoWidth, trk: tr.readyState + (tr.muted ? '/muted' : ''), vis: document.visibilityState }); } catch (e) { return 'ERR ' + e.message; } })()`);
        log('diag t+' + (i * 0.5) + 's ' + r); await sleep(500);
      }
    }
    if (on('jiggle')) { log('jiggle: 1000 Hz real mouse moves for 4 s'); send('J 4000 1000'); await sleep(4500); }
    if (on('jiggledraw')) { rmb(true); log('jiggle while drawing'); send('J 4000 1000'); await sleep(4500); rmb(false); }
    if (on('barmove')) { for (let i = 0; i < 4; i++) { const b = barWin.getBounds(); barWin.setBounds({ ...b, x: b.x + 30 }); await sleep(300); } log('bar moved'); await sleep(1500); }
    if (on('barsize')) { const b = barWin.getBounds(); barWin.setBounds({ ...b, width: b.width + 40 }); log('bar resized'); await sleep(2500); }
    if (on('movefix1')) { for (let i = 0; i < 3; i++) { const b = barWin.getBounds(); barWin.setBounds({ ...b, x: b.x + 30 }); await sleep(200); } barWin.setContentProtection(false); await sleep(300); barWin.setContentProtection(true); log('toggled protection'); await sleep(3000); }
    if (on('movefix2')) { for (let i = 0; i < 3; i++) { const b = barWin.getBounds(); barWin.setBounds({ ...b, x: b.x + 30 }); await sleep(200); } barWin.hide(); await sleep(300); barWin.showInactive(); log('hide/show after move'); await sleep(3000); }
    if (on('moveunprot')) { barWin.setContentProtection(false); await sleep(500); for (let i = 0; i < 3; i++) { const b = barWin.getBounds(); barWin.setBounds({ ...b, x: b.x + 30 }); await sleep(200); } log('moved unprotected'); await sleep(3000); }
    if (on('barhide')) { barWin.hide(); await sleep(800); barWin.showInactive(); log('bar hide/show'); await sleep(2500); }
    if (!steps.some(s => s !== 'none')) await sleep(1000);
    await sleep(1500);
    await chordUp(); await sleep(500);
    log('after release, swallowed keys/buttons: ' + swallowed());
    await sleep(6000); // watch for lingering damage (white/black video)
    await stop();
    if (process.env.SCREC_BARSHOT) { await sleep(2500); const img = await barWin.webContents.capturePage(); fs.writeFileSync(process.env.SCREC_BARSHOT, img.toPNG()); log('bar screenshot saved'); }
    await sleep(12000);
    log('files: ' + fs.readdirSync(app.getPath('videos') + '/SCREC').join(', '));
    ps.kill();
    if (chrome) chrome.kill();
    app.quit();
  })().catch(e => { console.error('[selftest] FAILED', e); app.quit(); });
};
