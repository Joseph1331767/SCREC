// Dev-only smoke test: SCREC_SELFTEST=1 npm start  → screenshot + 4s recording, then quit.
const fs = require('fs');
module.exports = ({ app, barWin, screen, captureImage, beginVideo }) => {
  const d = screen.getPrimaryDisplay();
  const rect = { x: 100, y: 100, width: 800, height: 450 };
  const log = m => { console.log('[selftest]', m); };
  setTimeout(async () => {
    await captureImage(d, rect); log('screenshot ok');
    await beginVideo(d, rect); log('recording started');
    setTimeout(() => { barWin.webContents.executeJavaScript("document.getElementById('btnStop').click()"); }, 4000);
    setTimeout(() => { log('files: ' + fs.readdirSync(require('electron').app.getPath('videos') + '/SCREC').join(', ')); app.quit(); }, 7000);
  }, 3000);
};
