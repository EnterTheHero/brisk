// Deleting a profile, including when its windows are the only ones open.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
const userData = path.join(out, 'profile-delete');
fs.rmSync(userData, { recursive: true, force: true });
app.setPath('userData', userData);
require('../src/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => fs.appendFileSync(path.join(out, 'delete.txt'), a.join(' ') + '\n');
app.whenReady().then(async () => {
  try {
    await wait(2000);
    const b = global.__brisk;
    log('start');
    const meta = b.profiles.create({ name: 'Temp' });
    log('created');
    const w2 = await b.openProfile(meta.id);
    log('opened');
    w2.profile.store.addBookmark({ title: 'x', url: 'https://x.example/' });
    log('added');
    w2.profile.store.flush();
    log('flushed', b.windows.size);
    for (const name of ['beforeWindowClose', 'onWindowClosed', 'saveSession', 'saveSessionSoon', 'applyTheme']) {
      const orig = b[name].bind(b);
      b[name] = (...args) => { log('->', name); try { const r = orig(...args); log('<-', name); return r; } catch (e) { log('THROW', name, e.stack); throw e; } };
    }
    // close the Personal window so only Temp's window is open
    for (const w of [...b.windows.values()]) if (w !== w2) w.win.close();
    await wait(500);
    log('windows before delete', b.windows.size, [...b.windows.values()].map((w) => w.profile.meta.name).join(','));
    const dir = path.join(userData, 'Profiles', meta.id);
    log('profile dir exists', fs.existsSync(dir));
    await b.profiles.remove(meta.id);
    await wait(1500);
    log('windows after delete', b.windows.size, [...b.windows.values()].map((w) => w.profile.meta.name).join(','));
    log('profiles', JSON.stringify(b.profiles.list().map((p) => p.name)), 'saved file', JSON.stringify(JSON.parse(fs.readFileSync(path.join(userData, 'brisk-profiles.json'))).profiles.map((p) => p.name)));
    log('profile dir removed', !fs.existsSync(dir));
    // double open is deduped
    const [a1, a2] = await Promise.all([b.openProfile('default'), b.openProfile('default')]);
    log('double open same window', a1 === a2, 'windows', b.windows.size);
  } catch (e) {
    log('ERROR', e.stack);
  }
  app.exit(0);
});
