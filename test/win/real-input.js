// Windows-only: drives Brisk with REAL mouse and keyboard input (via input.ps1), the way a person would.
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFileSync } = require('child_process');
const { app, screen } = require('electron');
const out = path.resolve(process.argv.find((a) => a.startsWith('--out='))?.slice(6) || path.join(__dirname, 'out'));
fs.mkdirSync(out, { recursive: true });
const log = (...a) => { const l = (process.argv.includes('--left') ? '[left' : '[top') + (process.argv.includes('--dashlane') ? '+dashlane] ' : '] ') + a.join(' '); console.log(l); fs.appendFileSync(path.join(out, 'result.txt'), l + '\n'); };
const LEFT = process.argv.includes('--left');
const DASH = process.argv.includes('--dashlane');
const SITE = (process.argv.find((a) => a.startsWith('--site=')) || '').slice(7);
if (process.argv.includes('--scale15')) app.commandLine.appendSwitch('force-device-scale-factor', '1.5');
app.setPath('userData', path.join(out, (LEFT ? 'profile-left' : 'profile') + (DASH ? '-dash' : '')));
log('started', process.versions.electron);
require('../../src/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (...args) => execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'input.ps1'), ...args.map(String)]);
let shotN = 0;
const shot = (name) => ps('shot', 0, 0, path.join(out, `${LEFT ? 'L' : 'T'}${DASH ? 'D' : ''}${String(++shotN).padStart(2, '0')}-${name}.png`));
// window content point (DIP) -> physical screen pixels
function toScreen(w, x, y) {
  const cb = w.win.getContentBounds();
  const p = screen.dipToScreenPoint({ x: cb.x + x, y: cb.y + y });
  return [Math.round(p.x), Math.round(p.y)];
}
async function rectIn(wc, js) {
  return wc.executeJavaScript(`(() => { const e = ${js}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
}
async function clickEl(w, view, js, button = 'lclick') {
  const r = await rectIn(view.webContents, js);
  if (!r) return false;
  const vb = view.getBounds();
  ps(button, ...toScreen(w, vb.x + r.x, vb.y + r.y));
  return true;
}
const menuLabels = (w) => w.ui.webContents.executeJavaScript('[...document.querySelectorAll(".pm-item .pm-label")].map(e => e.textContent).join(" | ") || "NO MENU"');
const findItem = (label) => `[...document.querySelectorAll('.pm-item')].filter(e => e.textContent.trim().startsWith(${JSON.stringify(label)})).pop()`;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(req.url === '/' ? '<html><body style="margin:0;font:20px sans-serif"><a id="l" href="/other" style="display:block;margin:40px;width:300px;height:80px;font-size:40px">A link</a></body></html>' : '<html><body>other page</body></html>');
}).listen(8767, '127.0.0.1');

app.whenReady().then(async () => {
  try {
    await wait(4000);
    const b = global.__brisk;
    const w = b.currentWindow();
    w.win.setBounds({ x: 40, y: 40, width: 1200, height: 800 });
    w.win.focus();
    if (LEFT) {
      b.currentProfile().store.setSetting('tabsPosition', 'left');
      b.currentProfile().store.setSetting('restoreTabs', false);
      await wait(1500);
    }
    if (DASH) {
      const { installExtension } = require('electron-chrome-web-store');
      try {
        const ext = await installExtension('fdjamakpfbbddfjaooikfcpapjohcfmg', { session: b.currentProfile().session, extensionsPath: b.currentProfile().extensionsPath });
        log('installed', ext.name, ext.version);
      } catch (e) {
        log('install failed', e.message);
      }
      await wait(4000);
    }
    const tabView = () => (LEFT ? w.side : w.ui);
    const tabSel = LEFT ? '.vtab' : '.tab';
    log('scale', screen.getPrimaryDisplay().scaleFactor, 'content', JSON.stringify(w.win.getContentBounds()));
    w.navigate(SITE || 'http://127.0.0.1:8767/');
    await wait(SITE ? 7000 : 2000);
    shot('page');
    // where to right-click: the first visible link on the page
    const linkPt = await w.active.wc.executeJavaScript(`(() => { for (const a of document.querySelectorAll('a[href]')) { const r = a.getBoundingClientRect(); if (r.width > 20 && r.height > 8 && r.top > 0 && r.top < innerHeight - 20 && r.left >= 0) return { x: r.left + Math.min(r.width / 2, 40), y: r.top + r.height / 2, href: a.href }; } return { x: 100, y: 80 }; })()`);
    log('right-click target', JSON.stringify(linkPt));

    // ---- A: right-click a link, choose Open Link in New Tab ----
    let fired = false;
    w.active.wc.once('context-menu', (_e, p) => { fired = true; log('A context-menu event, linkURL =', p.linkURL); });
    const tb = w.active.view.getBounds();
    ps('rclick', ...toScreen(w, tb.x + linkPt.x, tb.y + linkPt.y));
    await wait(1200);
    log('A event fired', fired, '| ui height', w.ui.getBounds().height, '| menu:', await menuLabels(w));
    shot('A-after-rightclick');
    const before = w.order.length;
    const activeBefore = w.activeId;
    const ok = await clickEl(w, w.ui, findItem('Open Link in New Tab'));
    await wait(1500);
    log('A clicked item', ok, '| stayed on original tab', w.activeId === activeBefore, '| tabs', before, '->', w.order.length, '| menu still open', await w.ui.webContents.executeJavaScript('!!document.querySelector(".pm")'));
    shot('A-after-pick');

    // ---- B: right-click a tab, Add Tab to New Group, type a name ----
    await clickEl(w, tabView(), `document.querySelectorAll('${tabSel}')[0]`); // activate first tab
    await wait(500);
    await clickEl(w, tabView(), `document.querySelectorAll('${tabSel}')[0]`, 'rclick');
    await wait(1000);
    log('B tab menu:', await menuLabels(w));
    shot('B-tab-menu');
    await clickEl(w, w.ui, findItem('Add Tab to New Group'));
    await wait(1200);
    const ed = await w.ui.webContents.executeJavaScript('(() => { const e = document.querySelector(".group-editor"); return e ? "editor open, input focused=" + (document.activeElement === e.querySelector("input")) + ", doc focused=" + document.hasFocus() : "NO EDITOR"; })()');
    log('B', ed, '| groups', w.groups.size, '| ui wc focused', w.ui.webContents.isFocused(), '| page wc focused', w.active.wc.isFocused());
    shot('B-editor');
    ps('type', 0, 0, 'Work');
    await wait(500);
    log('B after typing, group names:', [...w.groups.values()].map((g) => JSON.stringify(g.name)).join(','), '| address bar:', await w.ui.webContents.executeJavaScript('document.querySelector("#address").value'));
    ps('type', 0, 0, '{ENTER}');
    await wait(800);
    log('B after Enter, group names:', [...w.groups.values()].map((g) => JSON.stringify(g.name)).join(','), '| editor still open', await w.ui.webContents.executeJavaScript('!!document.querySelector(".group-editor")'));
    shot('B-after-enter');

    // ---- C: right-click another tab, Add Tab to Group > Work ----
    const lastTab = `[...document.querySelectorAll('${tabSel}')].pop()`;
    await clickEl(w, tabView(), lastTab, 'rclick');
    await wait(1000);
    log('C tab menu:', await menuLabels(w));
    await clickEl(w, w.ui, findItem('Add Tab to Group'));
    await wait(800);
    log('C after opening submenu, panels:', await w.ui.webContents.executeJavaScript('document.querySelectorAll(".pm").length'), '| menu:', await menuLabels(w));
    shot('C-submenu');
    const sub = `[...document.querySelectorAll('.pm[data-level="1"] .pm-item')][0]`;
    const ok2 = await clickEl(w, w.ui, sub);
    await wait(1000);
    log('C clicked group item', ok2, '| tabs per group:', [...w.groups.values()].map((g) => `${g.name}=${w._groupTabs(g.id).length}`).join(','));
    shot('C-after');
    // ---- D: bookmarks-bar folder dropdown, right-click a bookmark, Open in New Tab ----
    const store = b.currentProfile().store;
    store.setSetting('showBookmarksBar', true);
    const f = store.addFolder({ title: 'Comics' });
    store.addBookmarkTo({ title: 'Local page', url: 'http://127.0.0.1:8767/other', parentId: f.id });
    await wait(1200);
    await clickEl(w, w.ui, `document.querySelector('#bookmarks .bm.folder')`);
    await wait(900);
    log('D dropdown:', await menuLabels(w));
    await clickEl(w, w.ui, findItem('Local page'), 'rclick');
    await wait(700);
    log('D after right-click:', await menuLabels(w));
    shot('D-bookmark-rightclick');
    const n0 = w.order.length;
    const act0 = w.activeId;
    await clickEl(w, w.ui, findItem('Open in New Tab'));
    await wait(1200);
    log('D tabs', n0, '->', w.order.length, '| stayed', w.activeId === act0, '| menus left', await w.ui.webContents.executeJavaScript('document.querySelectorAll(".pm").length'));
  } catch (e) {
    log('ERROR', e.stack);
  }
  app.exit(0);
});
