// Dev-only smoke test: SCREC_SELFTEST=1 npm start  → screenshot, 9s recording with a zoom in the middle, then quit.
const fs = require('fs');
module.exports = ({ app, barWin, screen, captureImage, beginVideo, startZoom, stopZoom }) => {
  const d = screen.getPrimaryDisplay();
  const rect = { x: 0, y: 0, width: d.bounds.width, height: d.bounds.height };
  const log = m => console.log('[selftest]', m);
  setTimeout(async () => {
    await captureImage(d, rect); log('screenshot ok');
    await beginVideo(d, rect); log('recording started');
    setTimeout(() => { log('zoom start'); startZoom(); }, 3000);
    setTimeout(() => { log('zoom stop'); stopZoom(); }, 6000);
    setTimeout(() => barWin.webContents.executeJavaScript("document.getElementById('btnStop').click()"), 9000);
    setTimeout(() => { log('files: ' + fs.readdirSync(app.getPath('videos') + '/SCREC').join(', ')); app.quit(); }, 12000);
  }, 3000);
};
