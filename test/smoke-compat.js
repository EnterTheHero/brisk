// Checks the Google sign-in compatibility shim using a local server that pretends to be accounts.google.com.
// Run with: --host-resolver-rules="MAP accounts.google.com 127.0.0.1"
const path = require('path');
const fs = require('fs');
const http = require('http');
const { app } = require('electron');
const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
app.setPath('userData', path.join(out, 'profile-compat'));
require('../src/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => fs.appendFileSync(path.join(out, 'compat.txt'), a.join(' ') + '\n');
let seen = {};
http.createServer((req, res) => {
  (seen[req.headers.host] ||= []).push([req.url, req.headers['user-agent'].includes('Firefox') ? 'FF' : 'CHROME', req.headers['sec-ch-ua'] ? 'hints' : 'nohints']);
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<html><body>hi</body></html>');
}).listen(8766, '127.0.0.1');
app.whenReady().then(async () => {
  await wait(2000);
  const b = global.__brisk;
  b.currentProfile().store.setSetting('httpsUpgrade', false);
  const w = b.currentWindow();
  const js = 'JSON.stringify({ua: navigator.userAgent, uad: typeof navigator.userAgentData, chrome: typeof window.chrome, vendor: navigator.vendor, platform: navigator.platform})';
  for (const url of ['http://signin.test:8766/', 'http://127.0.0.1:8766/']) {
    w.navigate(url);
    await wait(2000);
    log(url, 'page:', await w.active.wc.executeJavaScript(js));
  }
  log('server saw', JSON.stringify(seen));
  // font check
  w.navigate('brisk://settings');
  await wait(1500);
  log('settings font', await w.active.wc.executeJavaScript('document.fonts.check("14px Inter") + " " + [...document.fonts].filter(f=>f.status==="loaded").map(f=>f.family).join(",")'));
  log('ui font', await w.ui.webContents.executeJavaScript('document.fonts.check("13px Inter") + " " + [...document.fonts].filter(f=>f.status==="loaded").map(f=>f.family).join(",")'));
  fs.writeFileSync(path.join(out, 'font-ui.png'), (await w.ui.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(out, 'font-settings.png'), (await w.active.wc.capturePage()).toPNG());
  w.navigate('brisk://newtab');
  await wait(1200);
  fs.writeFileSync(path.join(out, 'font-newtab.png'), (await w.active.wc.capturePage()).toPNG());
  app.exit(0);
});
