// Tabs on the left: sidebar appears, tab views shift right, resizing works; the startup picture shows and closes.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');
const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
const userData = path.join(out, 'profile-vtabs');
fs.rmSync(userData, { recursive: true, force: true });
app.setPath('userData', userData);
require('../src/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => fs.appendFileSync(path.join(out, 'vtabs.txt'), a.join(' ') + '\n');
const screen = (name) => execFileSync('import', ['-window', 'root', path.join(out, `${name}.png`)]);
app.whenReady().then(async () => {
  try {
    await wait(300);
    log('splash windows at start', BrowserWindow.getAllWindows().length);
    screen('vt-0-splash');
    await wait(3500);
    log('splash windows later', BrowserWindow.getAllWindows().length);
    const b = global.__brisk;
    const w = b.currentWindow();
    w.win.setBounds({ x: 0, y: 0, width: 1300, height: 820 });
    w.createTab('brisk://settings');
    w.createTab('brisk://bookmarks');
    await wait(800);
    b.currentProfile().store.setSetting('tabsPosition', 'left');
    await wait(1200);
    log('side exists', !!w.side, 'side bounds', JSON.stringify(w.side && w.side.getBounds()), 'tab bounds', JSON.stringify(w.active.view.getBounds()));
    const rows = await w.side.webContents.executeJavaScript('document.querySelectorAll(".vtab").length');
    log('sidebar rows', rows, 'tabs', w.order.length);
    screen('vt-1-left');
    // resize via the UI bridge, as the drag handle does
    await w.side.webContents.executeJavaScript('brisk.setSidebarWidth(220, true)');
    await wait(600);
    log('after resize', JSON.stringify(w.side.getBounds()), 'saved', b.currentProfile().store.get('sidebarWidth'));
    screen('vt-2-wide');
    await w.side.webContents.executeJavaScript('brisk.setSidebarWidth(50, true)');
    await wait(600);
    screen('vt-3-narrow');
    // click the first tab in the sidebar
    const first = w.order[0];
    await w.side.webContents.executeJavaScript('document.querySelector(".vtab").dispatchEvent(new MouseEvent("mousedown",{bubbles:true,button:0}))');
    await wait(400);
    log('activated first', w.activeId === first);
    b.currentProfile().store.setSetting('tabsPosition', 'top');
    await wait(800);
    log('back to top: side visible', w.side ? JSON.stringify(w.side.getBounds()) : 'none', 'tab bounds', JSON.stringify(w.active.view.getBounds()));
    screen('vt-4-top');
  } catch (e) {
    log('ERROR', e.stack);
  }
  app.exit(0);
});
