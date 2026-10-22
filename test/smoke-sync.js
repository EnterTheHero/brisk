// Simulates two computers syncing through a fake Drive file (no Google account needed).
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
app.setPath('userData', path.join(out, 'profile-sync'));
app.whenReady().then(async () => {
  const { Store } = require('../src/store');
  const { Sync } = require('../src/sync');
  const store = new Store();
  const sync = new Sync(store);
  // Fake remote: pretend another computer already uploaded data.
  let remote = { bookmarks: [{ id: 'r1', title: 'From laptop', url: 'https://laptop.example/', createdAt: 1, updatedAt: Date.now() }], settings: { values: { searchEngine: 'brave' }, stamps: { searchEngine: Date.now() } }, shields: {} };
  let uploads = 0;
  sync.auth = { clientId: 'x', refreshToken: 'y' };
  sync._findFile = async () => 'file1';
  sync._download = async () => JSON.parse(JSON.stringify(remote));
  sync._upload = async (d) => { uploads++; remote = JSON.parse(JSON.stringify(d)); };
  store.addBookmark({ title: 'From desktop', url: 'https://desktop.example/' });
  await sync.syncNow();
  const r1 = { local: store.listBookmarks().map((b) => b.title), engine: store.get('searchEngine'), remote: remote.bookmarks.map((b) => b.title), uploads, status: sync.status.state };
  console.log('RESULT1', JSON.stringify(r1));
  // Second sync with nothing new should not upload again.
  await sync.syncNow();
  console.log('RESULT2 uploads', uploads);
  // Delete locally, sync, remote should have tombstone.
  store.removeBookmark(store.listBookmarks().find((b) => b.title === 'From laptop').id);
  await sync.syncNow();
  console.log('RESULT3', JSON.stringify(remote.bookmarks.map((b) => [b.title, !!b.deleted])), 'uploads', uploads);
  app.exit(0);
});
