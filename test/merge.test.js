const test = require('node:test');
const assert = require('node:assert');
const { merge, TOMBSTONE_TTL_MS } = require('../src/merge');

const bm = (id, updatedAt, extra = {}) => ({ id, title: id, url: `https://${id}.com`, createdAt: 1, updatedAt, ...extra });

test('union of bookmarks from both computers', () => {
  const out = merge({ bookmarks: [bm('a', 10)] }, { bookmarks: [bm('b', 20)] }, 100);
  assert.deepStrictEqual(out.bookmarks.map((b) => b.id).sort(), ['a', 'b']);
});

test('newer edit wins', () => {
  const out = merge({ bookmarks: [bm('a', 10, { title: 'old' })] }, { bookmarks: [bm('a', 20, { title: 'new' })] }, 100);
  assert.strictEqual(out.bookmarks[0].title, 'new');
  const out2 = merge({ bookmarks: [bm('a', 30, { title: 'local newer' })] }, { bookmarks: [bm('a', 20, { title: 'remote' })] }, 100);
  assert.strictEqual(out2.bookmarks[0].title, 'local newer');
});

test('a delete on one computer is not undone by an older copy elsewhere', () => {
  const out = merge({ bookmarks: [bm('a', 50, { deleted: true })] }, { bookmarks: [bm('a', 20)] }, 100);
  assert.strictEqual(out.bookmarks[0].deleted, true);
});

test('old tombstones are pruned', () => {
  const now = 10 + TOMBSTONE_TTL_MS + 1;
  const out = merge({ bookmarks: [bm('a', 10, { deleted: true })] }, {}, now);
  assert.strictEqual(out.bookmarks.length, 0);
});

test('settings merge per key by timestamp', () => {
  const local = { settings: { values: { theme: 'dark', searchEngine: 'brave' }, stamps: { theme: 50, searchEngine: 10 } } };
  const remote = { settings: { values: { theme: 'light', searchEngine: 'duckduckgo' }, stamps: { theme: 20, searchEngine: 40 } } };
  const out = merge(local, remote);
  assert.strictEqual(out.settings.values.theme, 'dark');
  assert.strictEqual(out.settings.values.searchEngine, 'duckduckgo');
});

test('per-site shields merge by timestamp', () => {
  const out = merge({ shields: { 'a.com': { off: true, updatedAt: 5 } } }, { shields: { 'a.com': { off: false, updatedAt: 9 }, 'b.com': { off: true, updatedAt: 1 } } });
  assert.strictEqual(out.shields['a.com'].off, false);
  assert.strictEqual(out.shields['b.com'].off, true);
});

test('merge is stable when both sides are identical', () => {
  const data = { bookmarks: [bm('a', 10)], settings: { values: { theme: 'dark' }, stamps: { theme: 3 } }, shields: {} };
  assert.deepStrictEqual(merge(data, data, 100), merge(merge(data, data, 100), data, 100));
});

test('garbage remote data does not break merge', () => {
  const out = merge({ bookmarks: [bm('a', 1)] }, { bookmarks: 'nope', settings: null, shields: 7 }, 100);
  assert.strictEqual(out.bookmarks.length, 1);
});
