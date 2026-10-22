const test = require('node:test');
const assert = require('node:assert');
const { resolveInput } = require('../src/url-utils');

const search = (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`;
const r = (s) => resolveInput(s, search);

test('domains become https URLs', () => {
  assert.strictEqual(r('example.com'), 'https://example.com');
  assert.strictEqual(r('news.ycombinator.com/item?id=1'), 'https://news.ycombinator.com/item?id=1');
  assert.strictEqual(r('example.org'), 'https://example.org');
});

test('full URLs pass through', () => {
  assert.strictEqual(r('http://example.com'), 'http://example.com');
  assert.strictEqual(r('https://a.b/c'), 'https://a.b/c');
  assert.strictEqual(r('brisk://settings'), 'brisk://settings');
});

test('local addresses use http', () => {
  assert.strictEqual(r('localhost:3000'), 'http://localhost:3000');
  assert.strictEqual(r('192.168.1.1'), 'http://192.168.1.1');
  assert.strictEqual(r('printer.local'), 'http://printer.local');
});

test('everything else is a search', () => {
  assert.strictEqual(r('how to fix a leaky faucet'), search('how to fix a leaky faucet'));
  assert.strictEqual(r('plex'), search('plex'));
  assert.strictEqual(r('node.js'), 'https://node.js'); // looks like a domain; acceptable
});

test('script URLs are never navigated to', () => {
  assert.strictEqual(r('javascript:alert(1)'), search('javascript:alert(1)'));
});

test('empty input does nothing', () => {
  assert.strictEqual(r('   '), null);
});
