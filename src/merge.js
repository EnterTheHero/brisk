// Pure merge logic for sync. No Electron imports, so it can be unit-tested.
//
// Synced data shape:
// {
//   bookmarks: [{ id, title, url, createdAt, updatedAt, deleted? }],
//   settings:  { values: { key: value }, stamps: { key: timestamp } },
//   shields:   { [hostname]: { off: boolean, updatedAt } }
// }
//
// Every record carries a timestamp. When two copies disagree, the newer one
// wins. Deletions are kept as "tombstones" so a delete on one computer is not
// undone by an older copy on another.

const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // forget deletions after 90 days

function emptyData() {
  return { bookmarks: [], settings: { values: {}, stamps: {} }, shields: {} };
}

function normalize(data) {
  const d = data && typeof data === 'object' ? data : {};
  return {
    bookmarks: Array.isArray(d.bookmarks) ? d.bookmarks.filter((b) => b && b.id) : [],
    settings: {
      values: (d.settings && d.settings.values) || {},
      stamps: (d.settings && d.settings.stamps) || {},
    },
    shields: d.shields && typeof d.shields === 'object' ? d.shields : {},
  };
}

function mergeBookmarks(a, b, now) {
  const byId = new Map();
  for (const item of [...a, ...b]) {
    const existing = byId.get(item.id);
    if (!existing || (item.updatedAt || 0) > (existing.updatedAt || 0)) {
      byId.set(item.id, item);
    }
  }
  return [...byId.values()]
    .filter((bm) => !(bm.deleted && now - (bm.updatedAt || 0) > TOMBSTONE_TTL_MS))
    .sort((x, y) => (x.order ?? x.createdAt ?? 0) - (y.order ?? y.createdAt ?? 0));
}

function mergeSettings(a, b) {
  const values = { ...a.values };
  const stamps = { ...a.stamps };
  for (const key of Object.keys(b.values)) {
    if ((b.stamps[key] || 0) > (stamps[key] || 0)) {
      values[key] = b.values[key];
      stamps[key] = b.stamps[key] || 0;
    }
  }
  return { values, stamps };
}

function mergeShields(a, b) {
  const out = { ...a };
  for (const [host, rec] of Object.entries(b)) {
    if (!out[host] || (rec.updatedAt || 0) > (out[host].updatedAt || 0)) out[host] = rec;
  }
  return out;
}

function merge(local, remote, now = Date.now()) {
  const l = normalize(local);
  const r = normalize(remote);
  return {
    bookmarks: mergeBookmarks(l.bookmarks, r.bookmarks, now),
    settings: mergeSettings(l.settings, r.settings),
    shields: mergeShields(l.shields, r.shields),
  };
}

module.exports = { merge, normalize, emptyData, TOMBSTONE_TTL_MS };
