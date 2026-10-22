// Launches Brisk, exercises a few features, saves screenshots, and quits.
// Usage: electron test/smoke.js <outdir>
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6) || path.join(__dirname, 'smoke-out');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile'));
require('../src/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => fs.appendFileSync(path.join(out, 'log.txt'), a.join(' ') + '\n');

async function shot(w, name) {
  const ui = await w.ui.webContents.capturePage();
  fs.writeFileSync(path.join(out, `${name}-ui.png`), ui.toPNG());
  if (w.active) {
    const page = await w.active.wc.capturePage();
    fs.writeFileSync(path.join(out, `${name}-page.png`), page.toPNG());
  }
}

app.whenReady().then(async () => {
  try {
    await wait(2500);
    const b = global.__brisk;
    const w = b.currentWindow();
    log('windows', b.windows.size, 'tabs', w.order.length, 'chromeHeight', w.chromeHeight, 'blocker', !!b.shields.blocker);
    b.currentProfile().store.addBookmark({ title: 'Example', url: 'https://example.com/' });
    b.currentProfile().store.addBookmark({ title: 'Wikipedia', url: 'https://www.wikipedia.org/' });
    b.currentProfile().store.addBookmark({ title: 'Calendar', url: 'https://calendar.example.com/' });
    await wait(800);
    await shot(w, '1-newtab');
    w.createTab('brisk://settings');
    await wait(1500);
    await shot(w, '2-settings');

    w.createTab('brisk://bookmarks');
    await wait(1200);
    await shot(w, '3-bookmarks');

    w.createTab('brisk://error/?code=-105&desc=ERR_NAME_NOT_RESOLVED&url=https%3A%2F%2Fnope.invalid%2F');
    await wait(1000);
    await shot(w, '4-error');

    // UI interactions through the real UI page
    w.ui.webContents.send('find:open');
    await wait(400);
    await shot(w, '5-find');
    log('chromeHeight after find', w.chromeHeight);

    // Toggle setting & check persisted
    b.currentProfile().store.setSetting('theme', 'dark');
    await wait(800);
    await shot(w, '6-dark');

    w.cycleTab(1);
    w.closeTab(w.activeId);
    w.reopenClosedTab();
    log('tabs after close/reopen', w.order.length, 'closedTabs', w.closedTabs.length);

    const s = await w.ui.webContents.executeJavaScript('document.querySelectorAll(".tab").length + "|" + document.querySelectorAll(".bm").length');
    log('rendered tabs|bookmarks', s);
    log('suggest exa', JSON.stringify(b.currentProfile().store.suggest('exa')));
    b.currentProfile().store.flush();
    log('data file', fs.existsSync(path.join(out, 'profile', 'brisk-data.json')));
  } catch (e) {
    log('ERROR', e.stack);
  }
  app.exit(0);
});
