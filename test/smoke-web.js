// Loads real ad-heavy pages and reports how many requests Shields blocked.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6) || path.join(__dirname, 'smoke-out');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile'));
app.commandLine.appendSwitch('ignore-certificate-errors'); // sandbox proxy only
require('../src/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => fs.appendFileSync(path.join(out, 'web.txt'), a.join(' ') + '\n');
app.whenReady().then(async () => {
  await wait(2000);
  const b = global.__brisk;
  const w = b.currentWindow();
  for (const url of (process.env.URLS || 'https://www.cnn.com/').split(',')) {
    w.navigate(url);
    await wait(12000);
    const t = w.active;
    log(url, '->', t.wc.getURL(), 'title:', t.wc.getTitle(), 'blocked:', b.shields.countFor(t.wc.id));
    fs.writeFileSync(path.join(out, `web-${new URL(url).hostname}.png`), (await t.wc.capturePage()).toPNG());
  }
  log('UA', w.active.wc.getUserAgent());
  app.exit(0);
});
