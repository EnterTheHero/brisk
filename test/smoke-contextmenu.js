// Right-click a link and choose "Open Link in New Tab" (captures the native menu's template).
const path = require('path');
const fs = require('fs');
const http = require('http');
const electron = require('electron');
const { app, Menu } = electron;
const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
app.setPath('userData', path.join(out, 'profile-ctx'));
let lastTemplate = null;
const realBuild = Menu.buildFromTemplate.bind(Menu);
Menu.buildFromTemplate = (t) => {
  lastTemplate = t;
  return realBuild(t);
};
require('../src/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => fs.appendFileSync(path.join(out, 'ctx.txt'), a.join(' ') + '\n');
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(req.url === '/' ? '<html><body style="margin:0"><a id="l" href="/other" style="display:block;width:300px;height:100px;font-size:40px">A link</a></body></html>' : '<html><body>other page</body></html>');
}).listen(8767, '127.0.0.1');
app.whenReady().then(async () => {
  try {
    await wait(2500);
    const w = global.__brisk.currentWindow();
    w.navigate('http://127.0.0.1:8767/');
    await wait(1500);
    const wc = w.active.wc;
    let fired = false;
    wc.once('context-menu', () => (fired = true));
    wc.sendInputEvent({ type: 'mouseDown', x: 50, y: 40, button: 'right', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: 50, y: 40, button: 'right', clickCount: 1 });
    await wait(1000);
    const labels = await w.ui.webContents.executeJavaScript('[...document.querySelectorAll(".pm-item .pm-label")].map(e => e.textContent).join(" | ")');
    log('context-menu fired', fired, 'menu labels:', labels || 'NO MENU', 'ui height', w.ui.getBounds().height);
    fs.writeFileSync(path.join(out, 'ctx-menu.png'), (await w.ui.webContents.capturePage()).toPNG());
    const before = w.order.length;
    await w.ui.webContents.executeJavaScript('[...document.querySelectorAll(".pm-item")].find(e => e.textContent.includes("Open Link in New Tab")).click()');
    await wait(1500);
    log('tabs', before, '->', w.order.length, w.order.map((id) => w.tabs.get(id).wc.getURL()).join(' '), 'ui height after', w.ui.getBounds().height);
    // toolbar menus
    for (const sel of ['#menu', '#profile', '#shields']) {
      await w.ui.webContents.executeJavaScript(`document.querySelector('${sel}').click()`);
      await wait(700);
      const info = await w.ui.webContents.executeJavaScript('(() => { const p = document.querySelector(".pm"); if (!p) return "none"; const r = p.getBoundingClientRect(); return Math.round(r.left) + "-" + Math.round(r.right) + " of " + innerWidth + " | " + [...p.querySelectorAll(".pm-label")].map(e => e.textContent).slice(0,6).join(", "); })()');
      log(sel, info);
      fs.writeFileSync(path.join(out, `menu-${sel.slice(1)}.png`), (await w.ui.webContents.capturePage()).toPNG());
      await w.ui.webContents.executeJavaScript('document.querySelector("#scrim").dispatchEvent(new MouseEvent("mousedown"))');
      await wait(300);
    }
    // middle click / ctrl+click on the link
    wc.sendInputEvent({ type: 'mouseDown', x: 50, y: 40, button: 'middle', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: 50, y: 40, button: 'middle', clickCount: 1 });
    await wait(1500);
    log('after middle click tabs', w.order.length);
  } catch (e) {
    log('ERROR', e.stack);
  }
  app.exit(0);
});
