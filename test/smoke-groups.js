// Tab groups: create, name/color, collapse, drag in/out, close, and restore after restart.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { app } = require('electron');
const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
const phase = process.argv.includes('--phase2') ? 2 : 1;
const userData = path.join(out, 'profile-groups');
if (phase === 1) fs.rmSync(userData, { recursive: true, force: true });
app.setPath('userData', userData);
require('../src/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => fs.appendFileSync(path.join(out, 'groups.txt'), a.join(' ') + '\n');
const screen = (name) => execFileSync('import', ['-window', 'root', path.join(out, `${name}.png`)]);
const desc = (w) => w.order.map((id) => { const t = w.tabs.get(id); const g = w.groups.get(t.groupId); return g ? `${id}[${g.name || g.color}${g.collapsed ? ',c' : ''}]` : `${id}`; }).join(' ');
app.whenReady().then(async () => {
  try {
    await wait(3000);
    const b = global.__brisk;
    const w = b.currentWindow();
    w.win.setBounds({ x: 0, y: 0, width: 1300, height: 820 });
    if (phase === 2) {
      log('P2 restored:', desc(w), 'groups', w.groups.size);
      app.exit(0);
      return;
    }
    b.currentProfile().store.setSetting('restoreTabs', true);
    for (const u of ['brisk://settings', 'brisk://bookmarks', 'brisk://profiles', 'brisk://extensions', 'brisk://newtab']) w.createTab(u);
    await wait(800);
    const [t1, t2, t3, t4, t5, t6] = w.order;
    const g = w.addTabsToGroup([t2, t3]);
    await wait(500);
    log('editor open', await w.ui.webContents.executeJavaScript('!!document.querySelector(".group-editor")'));
    // type a name in the editor like a person would
    await w.ui.webContents.executeJavaScript(`(() => { const i = document.querySelector('.group-editor input'); i.value = 'Work'; i.dispatchEvent(new Event('input')); })()`);
    await wait(300);
    screen('g-1-editor');
    await w.ui.webContents.executeJavaScript(`document.querySelector('.group-editor input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}))`);
    await wait(300);
    log('after name', desc(w), 'overlay closed', !(await w.ui.webContents.executeJavaScript('!document.querySelector("#scrim").hidden')));
    const g2 = w.addTabsToGroup([t5]);
    w.updateGroup(g2.id, { name: 'Read later', color: 'green' });
    await w.ui.webContents.executeJavaScript(`document.querySelector('.group-editor input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}))`);
    w.addTabsToGroup([t1], g.id);
    await wait(300);
    log('t1 joined Work at end', desc(w));
    // new tab opened from a grouped tab joins the group
    w.activate(t2);
    w.newTabInGroup(g.id);
    await wait(300);
    log('new tab in group', desc(w));
    // drag a lone tab into the middle of Work
    w.moveTab(t6, w.order.indexOf(t3));
    log('dragged t6 into Work', desc(w));
    w.moveTab(t6, w.order.length - 1);
    log('dragged t6 out', desc(w));
    w.activate(t3);
    await wait(500);
    screen('g-2-strip');
    w.toggleGroup(g.id);
    await wait(500);
    log('collapsed; active is outside group', w.tabs.get(w.activeId).groupId !== g.id, desc(w));
    screen('g-3-collapsed');
    // clicking the chip expands it again
    await w.ui.webContents.executeJavaScript(`document.querySelector('.group-chip').click()`);
    await wait(400);
    log('expanded by chip click', !w.groups.get(g.id).collapsed);
    b.currentProfile().store.setSetting('tabsPosition', 'left');
    await wait(1000);
    screen('g-4-left');
    const heads = await w.side.webContents.executeJavaScript('[...document.querySelectorAll(".vgroup .gname")].map(e=>e.textContent).join("|")');
    log('sidebar group heads', heads);
    // right-click a sidebar group head → editor shows in the top UI
    await w.side.webContents.executeJavaScript(`document.querySelector('.vgroup').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true}))`);
    await wait(600);
    log('editor from sidebar', await w.ui.webContents.executeJavaScript('!!document.querySelector(".group-editor")'));
    screen('g-5-left-editor');
    await w.ui.webContents.executeJavaScript(`document.querySelector('.group-editor input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}))`);
    b.currentProfile().store.setSetting('tabsPosition', 'top');
    // close the green group
    w.closeGroup(g2.id);
    await wait(300);
    log('closed Read later', desc(w), 'groups', [...w.groups.values()].map((x) => x.name).join(','));
    log('session', JSON.stringify(w.sessionInfo().groups), JSON.stringify(w.sessionInfo().tabGroups));
    log('P1 before quit:', desc(w));
    app.quit();
  } catch (e) {
    log('ERROR', e.stack);
    app.exit(1);
  }
});
