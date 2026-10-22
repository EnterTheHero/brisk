// Checks error-page history cleanup and a normal quit.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
app.setPath('userData', path.join(out, 'profile-nav'));
require('../src/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  await wait(1500);
  const b = global.__brisk;
  const w = b.currentWindow();
  w.navigate('brisk://settings');
  await wait(800);
  w.navigate('https://nope.invalid/');
  await wait(4000);
  const nh = w.active.wc.navigationHistory;
  const entries = [];
  for (let i = 0; i < nh.length(); i++) entries.push(nh.getEntryAtIndex(i).url.slice(0, 40));
  console.log('NAV', JSON.stringify(entries), 'active', nh.getActiveIndex());
  console.log('SESSION', JSON.stringify(w.sessionInfo().urls));
  const t0 = Date.now();
  app.on('will-quit', () => console.log('QUIT after', Date.now() - t0, 'ms'));
  app.quit();
});
