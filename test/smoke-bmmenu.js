// Right-click a bookmark inside a bookmarks-bar folder dropdown -> Open in New Tab.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
const userData = path.join(out, 'profile-bmmenu');
fs.rmSync(userData, { recursive: true, force: true });
app.setPath('userData', userData);
require('../src/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => fs.appendFileSync(path.join(out, 'bmmenu.txt'), a.join(' ') + '\n');
app.whenReady().then(async () => {
  try {
    await wait(2500);
    const b = global.__brisk;
    const w = b.currentWindow();
    const store = b.currentProfile().store;
    const f = store.addFolder({ title: 'Comics' });
    store.addBookmarkTo({ title: 'Example', url: 'https://example.com/', parentId: f.id });
    await wait(800);
    w.showBookmarkFolder(f.id, { x: 20, y: 90 });
    await wait(600);
    const js = (c) => w.ui.webContents.executeJavaScript(c);
    log('dropdown:', await js('[...document.querySelectorAll(".pm-item .pm-label")].map(e=>e.textContent).join("|")'));
    await js(`(() => { const el = [...document.querySelectorAll('.pm-item')].find(e => e.textContent.includes('Example')); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5, button: 2 })); })()`);
    await wait(300);
    log('after right-click:', await js('[...document.querySelectorAll(".pm")].map(p => [...p.querySelectorAll(".pm-label")].map(e=>e.textContent).join("|")).join("  //  ")'));
    const before = w.order.length;
    const active = w.activeId;
    await js(`[...document.querySelectorAll('.pm-item')].find(e => e.textContent.trim() === 'Open in New Tab').click()`);
    await wait(800);
    log('tabs', before, '->', w.order.length, 'new tab url', w.tabs.get(w.order[w.order.length - 1]).url, 'stayed', w.activeId === active, 'menus left', await js('document.querySelectorAll(".pm").length'), 'overlay', w.overlay);
  } catch (e) {
    log('ERROR', e.stack);
  }
  app.exit(0);
});
