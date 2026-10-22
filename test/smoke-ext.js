// Loads two unpacked extensions and checks toolbar buttons, popups, content scripts,
// chrome.tabs, context menus and the brisk://extensions page.
// Usage: electron test/smoke-ext.js --out=DIR --ext=PATH1,PATH2
const path = require('path');
const fs = require('fs');
const http = require('http');
const { app, BrowserWindow } = require('electron');
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const out = arg('out');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile-ext'));
require('../src/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => fs.appendFileSync(path.join(out, 'ext.txt'), a.join(' ') + '\n');
const png = async (wc, name) => fs.writeFileSync(path.join(out, name), (await wc.capturePage()).toPNG());

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<html><body style="background:#fff;color:#000;font:20px sans-serif;padding:40px"><h1>Test page</h1><p>Plain white page for content-script tests.</p></body></html>');
}).listen(8765, '127.0.0.1');

app.whenReady().then(async () => {
  try {
    await wait(2500);
    const b = global.__brisk;
    b.currentProfile().session.serviceWorkers.on('console-message', (_e, d) => log('SW console:', d.message, d.sourceUrl || ''));
    log('preloads', JSON.stringify(b.currentProfile().session.getPreloadScripts().map((p) => [p.id, p.type, require('path').basename(p.filePath)])));
    if (process.env.PROBE) b.currentProfile().session.registerPreloadScript({ type: 'service-worker', filePath: process.env.PROBE });
    b.currentProfile().session.on('preload-error', (_e, p, err) => log('PRELOAD ERROR', p, err && err.message));
    for (const p of arg('ext').split(',')) {
      const ext = await b.currentProfile().session.extensions.loadExtension(p);
      log('loaded', ext.name, ext.id);
    }
    const w = b.currentWindow();
    w.createTab('http://127.0.0.1:8765/');
    await wait(4000);
    const page = w.active.wc;
    log('content script', await page.executeJavaScript('document.documentElement.dataset.briskCs + " " + document.documentElement.dataset.briskTabs'));
    await wait(1500);
    log('after alarm', await page.executeJavaScript('document.documentElement.dataset.briskLater'));
    log('page bg', await page.executeJavaScript('getComputedStyle(document.body).backgroundColor'));
    await png(page, 'ext-page.png');
    await png(w.ui.webContents, 'ext-ui.png');

    const actions = await w.ui.webContents.executeJavaScript(`(() => {
      const list = document.querySelector('browser-action-list');
      const btns = list && list.shadowRoot ? [...list.shadowRoot.querySelectorAll('button, [part=action]')] : [];
      return btns.map((x) => (x.title || x.getAttribute('aria-label') || x.textContent || '?').trim());
    })()`);
    log('toolbar actions', JSON.stringify(actions));

    const tabsBefore = w.order.length;
    const clickAction = (title) => w.ui.webContents.executeJavaScript(`(() => {
      const list = document.querySelector('browser-action-list');
      const btn = [...list.shadowRoot.querySelectorAll('[part=action]')].find((x) => (x.title || '').includes(${JSON.stringify(title)}));
      if (!btn) return false;
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
      return true;
    })()`);
    log('click test action', await clickAction('Test'));
    await wait(2000);
    log('tabs before/after action click', tabsBefore, w.order.length, w.active.wc.getURL());

    const winsBefore = BrowserWindow.getAllWindows().length;
    log('click dark reader', await clickAction('Dark Reader'));
    await wait(3500);
    const popups = BrowserWindow.getAllWindows().filter((x) => x.webContents.getURL().startsWith('chrome-extension://'));
    log('popup windows', winsBefore, '->', popups.length, popups.map((p) => p.webContents.getURL()).join(' '), popups[0] && JSON.stringify(popups[0].getBounds()));
    if (popups[0]) await png(popups[0].webContents, 'ext-popup.png');

    w.activate(w.order[w.order.length - 1]);
    const items = b.currentProfile().extensions.contextMenuItems(w.active.wc, { x: 1, y: 1, pageURL: w.active.wc.getURL(), mediaType: 'none', editFlags: {}, selectionText: '', linkURL: '', srcURL: '', isEditable: false, frameURL: '' });
    log('context menu items', items.map((i) => i.label).join(' | '));

    w.createTab('brisk://extensions');
    await wait(1500);
    await png(w.active.wc, 'ext-manager.png');
    log('manager rows', await w.active.wc.executeJavaScript('document.querySelectorAll(".ext").length'));
    log('list()', JSON.stringify(b.currentProfile().extensions.list().map((e) => [e.name, !!e.icon, e.options])));

    // a normal website must not be able to open brisk:// pages
    w.createTab('http://127.0.0.1:8765/');
    await wait(1500);
    await w.active.wc.executeJavaScript('location.href = "brisk://settings"');
    await wait(800);
    log('site->brisk nav blocked', w.active.wc.getURL());
  } catch (e) {
    log('ERROR', e.stack);
  }
  app.exit(0);
});
