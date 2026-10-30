// Downloads bar: appears on download, shows progress, × clears one item, bar closes when empty.
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFileSync } = require('child_process');
const { app } = require('electron');
const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
const userData = path.join(out, 'profile-shelf');
fs.rmSync(userData, { recursive: true, force: true });
app.setPath('userData', userData);
app.setPath('downloads', path.join(out, 'dl-folder'));
fs.rmSync(path.join(out, 'dl-folder'), { recursive: true, force: true });
require('../src/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => fs.appendFileSync(path.join(out, 'shelf.txt'), a.join(' ') + '\n');
const screen = (name) => execFileSync('import', ['-window', 'root', path.join(out, `${name}.png`)]);

// A slow download (2 MB over ~4s) and a quick one.
http
  .createServer((req, res) => {
    if (req.url.startsWith('/slow')) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': 2_000_000, 'Content-Disposition': 'attachment; filename="big-movie-trailer.mp4"' });
      let sent = 0;
      const t = setInterval(() => {
        res.write(Buffer.alloc(100_000));
        sent += 100_000;
        if (sent >= 2_000_000) {
          clearInterval(t);
          res.end();
        }
      }, 200);
      return;
    }
    if (req.url.startsWith('/quick')) {
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="invoice.pdf"' });
      return res.end(Buffer.alloc(12345));
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<a id="a" href="/slow">slow</a> <a id="b" href="/quick">quick</a>');
  })
  .listen(8768, '127.0.0.1');

app.whenReady().then(async () => {
  try {
    await wait(2500);
    const b = global.__brisk;
    const w = b.currentWindow();
    w.win.setBounds({ x: 0, y: 0, width: 1300, height: 820 });
    w.navigate('http://127.0.0.1:8768/');
    await wait(1200);
    const js = (c) => w.shelf.webContents.executeJavaScript(c);
    w.active.wc.downloadURL('http://127.0.0.1:8768/slow');
    await wait(1200);
    log('shelf visible', w.shelfVisible, 'bounds', JSON.stringify(w.shelf && w.shelf.getBounds()), 'tab bounds', JSON.stringify(w.active.view.getBounds()));
    log('chips', await js('[...document.querySelectorAll(".dl")].map(e => e.querySelector(".name").textContent + " | " + e.querySelector(".sub").textContent).join(" ;; ")'));
    screen('dl-1-progress');
    w.active.wc.downloadURL('http://127.0.0.1:8768/quick');
    await wait(1500);
    log('chips', await js('[...document.querySelectorAll(".dl")].map(e => e.querySelector(".name").textContent + " | " + e.querySelector(".sub").textContent + " | " + e.className).join(" ;; ")'));
    screen('dl-2-two');
    // × on the finished one
    await js(`[...document.querySelectorAll('.dl')].find(e => e.classList.contains('done')).querySelector('.x').click()`);
    await wait(500);
    log('after × on finished: chips', await js('document.querySelectorAll(".dl").length'), 'shelf visible', w.shelfVisible, 'list still has', b.downloads.length);
    // right-click menu opens upward
    await js(`document.querySelector('.dl').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 20 }))`);
    await wait(500);
    const menu = await w.ui.webContents.executeJavaScript('(() => { const p = document.querySelector(".pm"); if (!p) return "none"; const r = p.getBoundingClientRect(); return `${Math.round(r.top)}-${Math.round(r.bottom)} of ${innerHeight} :: ` + [...p.querySelectorAll(".pm-label")].map(e => e.textContent).join("|"); })()');
    log('item menu', menu);
    screen('dl-3-menu');
    await w.ui.webContents.executeJavaScript('document.querySelector("#scrim").dispatchEvent(new MouseEvent("mousedown"))');
    await wait(4000);
    log('slow finished: chips', await js('[...document.querySelectorAll(".dl")].map(e => e.querySelector(".sub").textContent).join(" ;; ")'), 'file exists', fs.existsSync(path.join(out, 'dl-folder', 'big-movie-trailer.mp4')));
    screen('dl-4-done');
    await js(`document.querySelector('.dl .x').click()`);
    await wait(500);
    log('after clearing last: shelf visible', w.shelfVisible, 'tab height', w.active.view.getBounds().height, 'toolbar list', b.downloads.length);
    // Setting off: no bar
    b.currentProfile().store.setSetting('showDownloadBar', false);
    w.active.wc.downloadURL('http://127.0.0.1:8768/quick');
    await wait(1000);
    log('setting off: shelf visible', w.shelfVisible);
  } catch (e) {
    log('ERROR', e.stack);
  }
  app.exit(0);
});
