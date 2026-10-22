const test = require('node:test');
const assert = require('node:assert');
const bm = require('../src/bookmarks');

const flatImportOfOldVersion = () =>
  bm.upgrade([
    { id: 'a', title: 'Meld', url: 'https://meld.com/', createdAt: 1, updatedAt: 1, order: 1 },
    { id: 'b', title: 'Plex', url: 'https://plex.tv/', createdAt: 2, updatedAt: 2, order: 2 },
    { id: 'c', title: 'News', url: 'https://news.com/', createdAt: 3, updatedAt: 3, order: 3 },
  ]);

const braveExport = {
  bar: [
    { type: 'bookmark', title: 'News', url: 'https://news.com/' },
    { type: 'folder', title: 'Work', children: [{ type: 'bookmark', title: 'Meld', url: 'https://meld.com/' }, { type: 'folder', title: 'Vendors', children: [{ type: 'bookmark', title: 'Lowes', url: 'https://lowes.com/' }] }] },
  ],
  other: [{ type: 'folder', title: 'Media', children: [{ type: 'bookmark', title: 'Plex', url: 'https://plex.tv/' }] }],
};

test('old bookmarks get defaults (bookmark type, on the bar)', () => {
  const items = flatImportOfOldVersion();
  assert.ok(items.every((b) => b.type === 'bookmark' && b.parentId === 'bar'));
});

test('re-importing with folders moves loose bookmarks into folders, no duplicates', () => {
  const items = flatImportOfOldVersion();
  const stats = bm.importTree(items, braveExport);
  assert.deepStrictEqual(stats, { added: 1, moved: 2, folders: 3, skipped: 0 });
  const bar = bm.children(items, 'bar').map((b) => b.title);
  assert.deepStrictEqual(bar, ['News', 'Work']);
  const work = bm.children(items, 'bar').find((b) => b.title === 'Work');
  assert.deepStrictEqual(bm.children(items, work.id).map((b) => b.title), ['Meld', 'Vendors']);
  assert.strictEqual(bm.children(items, 'other')[0].title, 'Media');
  assert.strictEqual(items.filter((b) => b.url === 'https://plex.tv/' && !b.deleted).length, 1);
  assert.strictEqual(items.find((b) => b.id === 'b').parentId, bm.children(items, 'other')[0].id, 'same id kept so sync follows it');
});

test('importing the same file twice changes nothing the second time', () => {
  const items = flatImportOfOldVersion();
  bm.importTree(items, braveExport);
  const count = items.length;
  const stats = bm.importTree(items, braveExport);
  assert.strictEqual(items.length, count);
  assert.strictEqual(stats.added + stats.folders, 0);
  assert.deepStrictEqual(bm.children(items, 'bar').map((b) => b.title), ['News', 'Work'], 'order still matches the file');
});

test('tree, folder list and path', () => {
  const items = [];
  bm.importTree(items, braveExport);
  const t = bm.tree(items, 'bar');
  assert.strictEqual(t[1].children[1].children[0].title, 'Lowes');
  const folders = bm.folderList(items).map((f) => `${f.depth}:${f.title}`);
  assert.deepStrictEqual(folders, ['0:Bookmarks bar', '1:Work', '2:Vendors', '0:Other bookmarks', '1:Media']);
  const lowes = items.find((b) => b.title === 'Lowes');
  assert.strictEqual(bm.path(items, lowes.id), 'Bookmarks bar / Work / Vendors');
});

test('deleting a folder deletes its contents; orphans show in Other', () => {
  const items = [];
  bm.importTree(items, braveExport);
  const work = items.find((b) => b.title === 'Work');
  assert.strictEqual(bm.remove(items, work.id), 4);
  assert.deepStrictEqual(bm.children(items, 'bar').map((b) => b.title), ['News']);
  // A bookmark synced from another computer into a folder that was deleted here
  items.push({ id: 'z', type: 'bookmark', title: 'Orphan', url: 'https://o.com/', parentId: work.id, order: 1, createdAt: 1, updatedAt: 1 });
  assert.ok(bm.children(items, 'other').some((b) => b.title === 'Orphan'));
});

test('move between folders and reorder; cannot move a folder into itself', () => {
  const items = [];
  bm.importTree(items, braveExport);
  const work = items.find((b) => b.title === 'Work');
  const vendors = items.find((b) => b.title === 'Vendors');
  const news = items.find((b) => b.title === 'News');
  bm.move(items, news.id, work.id, 0);
  assert.deepStrictEqual(bm.children(items, work.id).map((b) => b.title), ['News', 'Meld', 'Vendors']);
  assert.strictEqual(bm.move(items, work.id, vendors.id), null);
  bm.move(items, vendors.id, 'bar', 0);
  assert.deepStrictEqual(bm.children(items, 'bar').map((b) => b.title), ['Vendors', 'Work']);
});

test('export round-trips folders', () => {
  const items = [];
  bm.importTree(items, braveExport);
  const html = bm.toNetscapeHtml(items);
  assert.match(html, /PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar/);
  assert.match(html, /<H3[^>]*>Vendors<\/H3>/);
  assert.match(html, /HREF="https:\/\/lowes.com\/"/);
});

test('folders moved into each other on two computers stay visible', () => {
  const items = bm.upgrade([
    { id: 'x', type: 'folder', title: 'X', parentId: 'y', order: 1, createdAt: 1, updatedAt: 5 },
    { id: 'y', type: 'folder', title: 'Y', parentId: 'x', order: 2, createdAt: 1, updatedAt: 6 },
    { id: 'k', type: 'bookmark', title: 'Kept', url: 'https://k.com/', parentId: 'y', order: 1, createdAt: 1, updatedAt: 1 },
  ]);
  const all = JSON.stringify(bm.tree(items, 'other'));
  assert.match(all, /"X"/);
  assert.match(all, /"Y"/);
  assert.match(all, /Kept/);
  assert.strictEqual((all.match(/Kept/g) || []).length, 1, 'shown once');
});

test('moving between two items with equal order still works', () => {
  const items = bm.upgrade([
    { id: 'a', title: 'A', url: 'https://a/', order: 5, createdAt: 1, updatedAt: 1 },
    { id: 'b', title: 'B', url: 'https://b/', order: 5, createdAt: 2, updatedAt: 1 },
    { id: 'c', title: 'C', url: 'https://c/', order: 9, createdAt: 3, updatedAt: 1 },
  ]);
  bm.move(items, 'c', 'bar', 1);
  assert.deepStrictEqual(bm.children(items, 'bar').map((b) => b.id), ['a', 'c', 'b']);
});
