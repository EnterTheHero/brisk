// Local data store: bookmarks, settings and per-site shield choices.
// Saved as JSON in the app's data folder. Emits 'change' so the UI and sync
// can react.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { app } = require('electron');
const { normalize } = require('./merge');
const BM = require('./bookmarks');

const DEFAULT_SETTINGS = {
  searchEngine: 'duckduckgo',
  homepage: 'brisk://newtab',
  adblock: true,
  httpsUpgrade: true,
  sendGPC: true,
  showBookmarksBar: true,
  restoreTabs: true,
  theme: 'system',
};

const SEARCH_ENGINES = {
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s' },
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
};

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

class Store extends EventEmitter {
  constructor(dir = app.getPath('userData')) {
    super();
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(this.dir, 'brisk-data.json');
    this.sessionFile = path.join(this.dir, 'brisk-session.json');
    this.historyFile = path.join(this.dir, 'brisk-history.json');
    this.history = null;
    this.data = this._load();
    this._saveTimer = null;
  }

  _load() {
    try {
      const data = normalize(JSON.parse(fs.readFileSync(this.file, 'utf8')));
      BM.upgrade(data.bookmarks);
      return data;
    } catch {
      return normalize({});
    }
  }

  _save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flush(), 300);
  }

  // Stop writing (used when a profile is deleted, so its folder isn't recreated).
  dispose() {
    this.disposed = true;
    clearTimeout(this._saveTimer);
    clearTimeout(this._historyTimer);
    this.removeAllListeners();
  }

  flush() {
    clearTimeout(this._saveTimer);
    if (this.disposed) return;
    fs.mkdirSync(this.dir, { recursive: true });
    atomicWrite(this.file, JSON.stringify(this.data, null, 2));
    if (this.history && this._historyTimer) {
      clearTimeout(this._historyTimer);
      atomicWrite(this.historyFile, JSON.stringify(this.history));
    }
  }

  _changed(kind) {
    this._save();
    this.emit('change', kind);
  }

  // Replace everything with merged data coming back from sync.
  replaceAll(data) {
    this.data = normalize(JSON.parse(JSON.stringify(data)));
    BM.upgrade(this.data.bookmarks);
    this._changed('all');
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.data));
  }

  // ---- settings ----
  getSettings() {
    return { ...DEFAULT_SETTINGS, ...this.data.settings.values };
  }

  get(key) {
    return this.getSettings()[key];
  }

  setSetting(key, value) {
    if (!(key in DEFAULT_SETTINGS)) throw new Error(`Unknown setting: ${key}`);
    this.data.settings.values[key] = value;
    this.data.settings.stamps[key] = Date.now();
    this._changed('settings');
  }

  searchUrl(query) {
    const engine = SEARCH_ENGINES[this.get('searchEngine')] || SEARCH_ENGINES.duckduckgo;
    return engine.url.replace('%s', encodeURIComponent(query));
  }

  // ---- bookmarks (folders live in bookmarks.js) ----
  listBookmarks() {
    return this.data.bookmarks.filter((b) => !b.deleted && b.type === 'bookmark');
  }

  findBookmarkByUrl(url) {
    return this.listBookmarks().find((b) => b.url === url);
  }

  bookmarkChildren(parentId) {
    return BM.children(this.data.bookmarks, parentId);
  }

  bookmarkTree(parentId) {
    return BM.tree(this.data.bookmarks, parentId);
  }

  bookmarkFolders() {
    return BM.folderList(this.data.bookmarks);
  }

  bookmarkPath(id) {
    return BM.path(this.data.bookmarks, id);
  }

  // Star button / Ctrl+D: one bookmark per URL.
  addBookmark({ title, url, parentId = BM.BAR }) {
    const existing = this.findBookmarkByUrl(url);
    if (existing) return existing;
    const bm = BM.create(this.data.bookmarks, { type: 'bookmark', title, url, parentId });
    this._changed('bookmarks');
    return bm;
  }

  // From the bookmark manager: always adds (the same link may live in several folders).
  addBookmarkTo({ title, url, parentId = BM.BAR }) {
    if (typeof url !== 'string' || !/^(https?|ftp|file):/i.test(url)) return null;
    const bm = BM.create(this.data.bookmarks, { type: 'bookmark', title, url, parentId });
    this._changed('bookmarks');
    return bm;
  }

  addFolder({ title, parentId = BM.BAR }) {
    const f = BM.create(this.data.bookmarks, { type: 'folder', title: title || 'New folder', parentId });
    this._changed('bookmarks');
    return f;
  }

  importBookmarks(tree) {
    const stats = BM.importTree(this.data.bookmarks, tree);
    this._changed('bookmarks');
    return stats;
  }

  exportBookmarksHtml() {
    return BM.toNetscapeHtml(this.data.bookmarks);
  }

  updateBookmark(id, fields) {
    const bm = this.data.bookmarks.find((b) => b.id === id && !b.deleted);
    if (!bm) return null;
    if (typeof fields.title === 'string') bm.title = fields.title.slice(0, 300);
    if (typeof fields.url === 'string' && bm.type === 'bookmark') bm.url = fields.url;
    bm.updatedAt = Date.now();
    this._changed('bookmarks');
    return bm;
  }

  moveBookmark(id, parentId, position) {
    const r = BM.move(this.data.bookmarks, id, parentId, position);
    if (r) this._changed('bookmarks');
    return r;
  }

  removeBookmark(id) {
    // Keeps tombstones so the delete syncs to other computers; folders take their contents with them.
    if (BM.remove(this.data.bookmarks, id)) this._changed('bookmarks');
  }

  // ---- per-site shields ----
  shieldsOffFor(host) {
    const rec = host && this.data.shields[host];
    return !!(rec && rec.off);
  }

  setShieldsOff(host, off) {
    if (!host) return;
    this.data.shields[host] = { off: !!off, updatedAt: Date.now() };
    this._changed('shields');
  }

  // ---- history (local only, never synced) ----
  _loadHistory() {
    if (this.history) return this.history;
    try {
      this.history = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
    } catch {
      this.history = [];
    }
    return this.history;
  }

  _saveHistory() {
    clearTimeout(this._historyTimer);
    this._historyTimer = setTimeout(() => {
      if (this.disposed) return;
      try {
        atomicWrite(this.historyFile, JSON.stringify(this.history));
      } catch {
        /* not critical */
      }
    }, 2000);
  }

  addVisit(url, title) {
    if (!/^https?:/.test(url)) return;
    const list = this._loadHistory();
    const i = list.findIndex((h) => h.url === url);
    const prev = i >= 0 ? list.splice(i, 1)[0] : null;
    list.unshift({ url, title: title || (prev && prev.title) || url, ts: Date.now(), visits: (prev ? prev.visits : 0) + 1 });
    if (list.length > 3000) list.length = 3000;
    this._saveHistory();
  }

  updateVisitTitle(url, title) {
    const h = this._loadHistory().find((x) => x.url === url);
    if (h && title) {
      h.title = title;
      this._saveHistory();
    }
  }

  // Address-bar suggestions from bookmarks first, then history.
  suggest(query, limit = 6) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const strip = (u) => u.replace(/^https?:\/\/(www\.)?/, '');
    const hits = (item) => strip(item.url).toLowerCase().startsWith(q) || item.title.toLowerCase().includes(q) || item.url.toLowerCase().includes(q);
    const out = [];
    const seen = new Set();
    for (const b of this.listBookmarks()) {
      if (hits(b) && !seen.has(b.url)) {
        out.push({ type: 'bookmark', url: b.url, title: b.title });
        seen.add(b.url);
      }
    }
    const hist = this._loadHistory()
      .filter((h) => hits(h) && !seen.has(h.url))
      .sort((a, b) => b.visits * 2 + b.ts / 8.64e7 - (a.visits * 2 + a.ts / 8.64e7));
    for (const h of hist) {
      if (out.length >= limit) break;
      out.push({ type: 'history', url: h.url, title: h.title });
    }
    return out.slice(0, limit);
  }

  clearHistory() {
    this.history = [];
    try {
      atomicWrite(this.historyFile, '[]');
    } catch {
      /* ignore */
    }
  }

  // ---- open tabs (local only, never synced) ----
  saveSession(windows) {
    if (this.disposed) return;
    try {
      atomicWrite(this.sessionFile, JSON.stringify({ windows }));
    } catch {
      /* not critical */
    }
  }

  loadSession() {
    try {
      return JSON.parse(fs.readFileSync(this.sessionFile, 'utf8')).windows || [];
    } catch {
      return [];
    }
  }
}

module.exports = { Store, DEFAULT_SETTINGS, SEARCH_ENGINES };
