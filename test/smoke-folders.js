// Bookmark folders + profiles end-to-end test.
const path = require('path');
const fs = require('fs');
const { app, nativeImage } = require('electron');
const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
const userData = path.join(out, 'profile-folders');
fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
// Data saved by v0.3 (flat, no folders) — what you have after the first import.
const old = ['https://news.ycombinator.com/', 'https://calendar.example.com/', 'https://docs.example.com/', 'https://www.lowes.com/', 'https://www.homedepot.com/', 'https://comics.example.com/', 'https://plex.tv/', 'https://www.wikipedia.org/', 'https://www.seriouseats.com/'];
fs.writeFileSync(path.join(userData, 'brisk-data.json'), JSON.stringify({ bookmarks: old.map((url, i) => ({ id: `old${i}`, title: url, url, createdAt: i, updatedAt: i, order: i })), settings: { values: {}, stamps: {} }, shields: {} }));
app.setPath('userData', userData);
require('../src/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => fs.appendFileSync(path.join(out, 'folders.txt'), a.join(' ') + '\n');
const png = async (wc, name) => fs.writeFileSync(path.join(out, name), (await wc.capturePage()).toPNG());

app.whenReady().then(async () => {
  try {
    await wait(2500);
    const b = global.__brisk;
    const w = b.currentWindow();
    const store = w.profile.store;
    log('before import: bar items', store.bookmarkChildren('bar').length);
    w.navigate('brisk://bookmarks');
    await wait(1500);
    const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'chrome-bookmarks.html'), 'utf8');
    const stats = await w.active.wc.executeJavaScript(`briskPages.importBookmarks(parseBookmarkFile(${JSON.stringify(html)}))`);
    log('import stats', JSON.stringify(stats));
    const show = (nodes, d = 0) => nodes.map((n) => '  '.repeat(d) + (n.type === 'folder' ? `[${n.title}]\n` + show(n.children, d + 1) : n.title + '\n')).join('');
    log('BAR:\n' + show(store.bookmarkTree('bar')) + 'OTHER:\n' + show(store.bookmarkTree('other')));
    log('total live bookmarks', store.listBookmarks().length, 'ids kept', store.listBookmarks().filter((x) => x.id.startsWith('old')).length);
    const again = await w.active.wc.executeJavaScript(`briskPages.importBookmarks(parseBookmarkFile(${JSON.stringify(html)}))`);
    log('second import', JSON.stringify(again), 'total', store.listBookmarks().length);
    await wait(800);
    await png(w.active.wc, 'bm-manager.png');
    // open the Work folder in the manager
    const work = store.bookmarkChildren('bar').find((x) => x.title === 'Work & Projects');
    await w.active.wc.executeJavaScript(`location.hash = ${JSON.stringify(work.id)}`);
    await wait(700);
    await png(w.active.wc, 'bm-manager-folder.png');
    await png(w.ui.webContents, 'bm-bar.png');
    w.showBookmarkFolder(work.id, { x: 10, y: 100 }); // native menu; just must not throw
    log('folder menu ok');

    // Lots of loose items -> overflow chevron
    for (let i = 0; i < 25; i++) store.addBookmarkTo({ title: `Site number ${i}`, url: `https://site${i}.example/` });
    await wait(800);
    log('overflow', await w.ui.webContents.executeJavaScript('document.querySelectorAll(".bm.overflow").length + " hidden, chevron " + !document.querySelector(".bm-more").hidden'));
    await png(w.ui.webContents, 'bm-bar-overflow.png');

    // ---- profiles ----
    const meta = b.profiles.create({ name: 'Work' });
    const avatar = nativeImage.createFromBuffer(fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.png'))).resize({ width: 64 }).toDataURL();
    const w2 = await b.openProfile(meta.id);
    await wait(2000);
    log('profiles', JSON.stringify(b.profiles.list().map((p) => [p.name, p.color])));
    log('work profile separate', w2.profile !== w.profile, w2.profile.partition, 'bookmarks', w2.profile.store.listBookmarks().length);
    await w.profile.session.cookies.set({ url: 'https://example.com', name: 'who', value: 'personal' });
    const c2 = await w2.profile.session.cookies.get({ url: 'https://example.com' });
    log('cookies isolated', c2.length === 0);
    await png(w2.ui.webContents, 'profile-work-ui.png');
    w2.createTab('brisk://profiles');
    await wait(1500);
    await w2.active.wc.executeJavaScript(`briskPages.updateProfile('default', { avatar: ${JSON.stringify(avatar)} })`);
    await wait(800);
    await png(w2.active.wc, 'profiles-page.png');
    await png(w.ui.webContents, 'profile-personal-ui.png');
    w2.createTab('brisk://settings');
    await wait(1200);
    await w2.active.wc.executeJavaScript('document.querySelector("#swatches").scrollIntoView()');
    await wait(300);
    await png(w2.active.wc, 'settings-colors.png');
    log('settings swatches', await w2.active.wc.executeJavaScript('document.querySelectorAll("#swatches .swatch").length'));
    log('ext page per profile', JSON.stringify(await w2.active.wc.executeJavaScript('briskPages.extensions().then(l => l.length)')));

    // dark mode look
    w.profile.store.setSetting('theme', 'dark');
    w.win.focus();
    b.applyTheme();
    await wait(800);
    await png(w.ui.webContents, 'profile-personal-dark.png');
    w.profile.store.setSetting('theme', 'system');

    const open = b.saveSession();
    log('open profiles at quit', JSON.stringify(open));
  } catch (e) {
    log('ERROR', e.stack);
  }
  app.exit(0);
});
