// Groups survive a restart with "Restore tabs" off; dragging onto a one-tab group joins it; background tabs flash.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
const phase2 = process.argv.includes('--phase2');
const userData = path.join(out, 'profile-groups2');
if (!phase2) fs.rmSync(userData, { recursive: true, force: true });
app.setPath('userData', userData);
require('../src/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => fs.appendFileSync(path.join(out, 'groups2.txt'), a.join(' ') + '\n');
const desc = (w) => w.order.map((id) => { const t = w.tabs.get(id); const g = w.groups.get(t.groupId); return `${t.url.replace('brisk://', '')}${g ? `[${g.name}]` : ''}`; }).join(' ');
app.whenReady().then(async () => {
  try {
    await wait(2500);
    const b = global.__brisk;
    const w = b.currentWindow();
    if (phase2) {
      log('P2 restored:', desc(w));
      app.exit(0);
      return;
    }
    b.currentProfile().store.setSetting('restoreTabs', false);
    for (const u of ['brisk://settings', 'brisk://bookmarks', 'brisk://profiles']) w.createTab(u);
    await wait(500);
    const [t1, t2, t3, t4] = w.order;
    const g = w.addTabsToGroup([t2]);
    w.updateGroup(g.id, { name: 'Solo' });
    await w.ui.webContents.executeJavaScript(`document.querySelector('.group-editor') && document.querySelector('.group-editor').remove()`);
    w.setOverlay(false);
    // drag t4 over the single grouped tab (UI passes that tab's group)
    w.moveTab(t4, w.order.indexOf(t2) + 1, g.id);
    log('drag onto one-tab group:', desc(w));
    // drag t4 over an ungrouped tab -> leaves
    w.moveTab(t4, 0, null);
    log('drag onto ungrouped tab:', desc(w));
    w.moveTab(t4, w.order.length, g.id);
    log('drop on group heading:', desc(w));
    // background tab flag
    w.createTab('brisk://extensions', { background: true });
    await wait(100);
    const fresh = await new Promise((r) => setTimeout(async () => r(await w.ui.webContents.executeJavaScript('document.querySelectorAll(".tab.fresh").length')), 200));
    log("fresh tabs highlighted", fresh, await w.ui.webContents.executeJavaScript("[...document.querySelectorAll(\".tab\")].map(e=>e.className).join(\" / \")"));
    log('P1 before quit:', desc(w));
    app.quit();
  } catch (e) {
    log('ERROR', e.stack);
    app.exit(1);
  }
});
