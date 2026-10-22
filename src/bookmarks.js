// Bookmark tree logic (folders, ordering, import). Pure functions over the
// store's bookmarks array, so it can be unit-tested without Electron.
//
// Item: { id, type: 'bookmark'|'folder', title, url?, parentId, order, createdAt, updatedAt, deleted? }
// Two fixed roots that are not items themselves: 'bar' (Bookmarks bar) and 'other' (Other bookmarks).

const crypto = require('crypto');

const BAR = 'bar';
const OTHER = 'other';
const ROOTS = new Set([BAR, OTHER]);
const ROOT_TITLES = { [BAR]: 'Bookmarks bar', [OTHER]: 'Other bookmarks' };

const now = () => Date.now();
const newId = () => crypto.randomUUID();

// Fill defaults for data saved before folders existed (and from older synced copies).
function upgrade(items) {
  for (const b of items) {
    if (!b.type) b.type = b.url ? 'bookmark' : 'folder';
    if (!b.parentId) b.parentId = BAR;
    if (typeof b.order !== 'number') b.order = b.createdAt || 0;
  }
  return items;
}

function live(items) {
  return items.filter((b) => !b.deleted);
}

// Items whose parent is missing or deleted (e.g. a folder deleted on another computer) show in Other bookmarks.
function effectiveParent(byId, item) {
  const p = item.parentId;
  if (ROOTS.has(p)) return p;
  const parent = byId.get(p);
  return parent && !parent.deleted && parent.type === 'folder' ? p : OTHER;
}

// Where each live item is shown. Normally its parentId, but anything that can't be
// reached from the two roots (a deleted parent, or two folders moved into each other
// on different computers) is shown in Other bookmarks, so nothing ever disappears.
function effectiveParents(items) {
  const byId = new Map(items.map((b) => [b.id, b]));
  const parentOf = new Map();
  for (const b of live(items)) parentOf.set(b.id, effectiveParent(byId, b));
  const reached = new Set();
  const childrenOf = () => {
    const m = new Map();
    for (const [id, p] of parentOf) {
      if (!m.has(p)) m.set(p, []);
      m.get(p).push(id);
    }
    return m;
  };
  const mark = (rootId, m) => {
    const stack = [...(m.get(rootId) || [])];
    while (stack.length) {
      const id = stack.pop();
      if (reached.has(id)) continue;
      reached.add(id);
      stack.push(...(m.get(id) || []));
    }
  };
  let m = childrenOf();
  mark(BAR, m);
  mark(OTHER, m);
  let guard = 0;
  while (reached.size < parentOf.size && guard++ < 1000) {
    // Break one loop: find an unreached item, climb to a folder inside the loop, re-root it.
    let id = [...parentOf.keys()].find((x) => !reached.has(x));
    const seen = new Set();
    while (!seen.has(id) && parentOf.has(parentOf.get(id))) {
      seen.add(id);
      id = parentOf.get(id);
    }
    parentOf.set(id, OTHER);
    m = childrenOf();
    reached.add(id);
    mark(id, m);
  }
  return parentOf;
}

function index(items) {
  const byId = new Map(items.map((b) => [b.id, b]));
  const parentOf = effectiveParents(items);
  const kids = new Map();
  for (const b of live(items)) {
    const p = parentOf.get(b.id);
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(b);
  }
  for (const list of kids.values()) list.sort((a, b) => a.order - b.order || (a.createdAt || 0) - (b.createdAt || 0));
  return { byId, kids };
}

function children(items, parentId) {
  return index(items).kids.get(parentId) || [];
}

// Nested tree for menus and the manager: { id, title, type, url?, children? }
function tree(items, parentId) {
  const { kids } = index(items);
  const build = (pid, depth) =>
    (kids.get(pid) || []).map((b) =>
      b.type === 'folder'
        ? { id: b.id, type: 'folder', title: b.title, children: depth < 30 ? build(b.id, depth + 1) : [] }
        : { id: b.id, type: 'bookmark', title: b.title, url: b.url }
    );
  return build(parentId, 0);
}

// Flat list of folders with depth, for "Move to" pickers.
function folderList(items) {
  const { kids } = index(items);
  const out = [];
  const walk = (pid, depth) => {
    for (const b of kids.get(pid) || []) {
      if (b.type !== 'folder') continue;
      out.push({ id: b.id, title: b.title, depth });
      if (depth < 30) walk(b.id, depth + 1);
    }
  };
  for (const root of [BAR, OTHER]) {
    out.push({ id: root, title: ROOT_TITLES[root], depth: 0 });
    walk(root, 1);
  }
  return out;
}

function path(items, id) {
  const byId = new Map(items.map((b) => [b.id, b]));
  const parts = [];
  let cur = byId.get(id);
  let guard = 0;
  while (cur && guard++ < 50) {
    const p = effectiveParent(byId, cur);
    if (ROOTS.has(p)) {
      parts.unshift(ROOT_TITLES[p]);
      break;
    }
    cur = byId.get(p);
    if (cur) parts.unshift(cur.title);
  }
  return parts.join(' / ');
}

function isDescendant(items, maybeChildId, ancestorId) {
  const byId = new Map(items.map((b) => [b.id, b]));
  let cur = byId.get(maybeChildId);
  let guard = 0;
  while (cur && guard++ < 60) {
    if (cur.parentId === ancestorId) return true;
    cur = byId.get(cur.parentId);
  }
  return false;
}

function nextOrder(items, parentId) {
  const list = children(items, parentId);
  return list.length ? list[list.length - 1].order + 1000 : now();
}

function create(items, { type = 'bookmark', title, url, parentId = BAR }) {
  const t = now();
  const item = { id: newId(), type, title: String(title || url || 'Untitled').slice(0, 300), parentId: validParent(items, parentId), order: nextOrder(items, parentId), createdAt: t, updatedAt: t };
  if (type === 'bookmark') item.url = url;
  items.push(item);
  return item;
}

function validParent(items, parentId) {
  if (ROOTS.has(parentId)) return parentId;
  const p = items.find((b) => b.id === parentId && !b.deleted && b.type === 'folder');
  return p ? p.id : BAR;
}

// Move an item to a folder at a position (index among that folder's current children).
function move(items, id, parentId, position) {
  const item = items.find((b) => b.id === id && !b.deleted);
  if (!item) return null;
  const target = validParent(items, parentId);
  if (item.type === 'folder' && (target === item.id || isDescendant(items, target, item.id))) return null;
  let siblings = children(items, target).filter((b) => b.id !== id);
  const pos = typeof position === 'number' ? Math.max(0, Math.min(position, siblings.length)) : siblings.length;
  // No room between neighbours (equal orders from two computers, or many moves into one gap): renumber first.
  const tight = siblings.some((b, i) => i > 0 && b.order - siblings[i - 1].order < 1e-6);
  if (tight) {
    const base = now();
    siblings.forEach((b, i) => {
      b.order = base + i * 1000;
      b.updatedAt = now();
    });
    siblings = children(items, target).filter((b) => b.id !== id);
  }
  const before = siblings[pos - 1];
  const after = siblings[pos];
  let order;
  if (before && after) order = (before.order + after.order) / 2;
  else if (before) order = before.order + 1000;
  else if (after) order = after.order - 1000;
  else order = now();
  item.parentId = target;
  item.order = order;
  item.updatedAt = now();
  return item;
}

// Deletes an item; deleting a folder deletes everything inside it. Tombstones are kept for sync.
function remove(items, id) {
  const t = now();
  const doomed = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of items) {
      if (!b.deleted && !doomed.has(b.id) && doomed.has(b.parentId)) {
        doomed.add(b.id);
        grew = true;
      }
    }
  }
  let n = 0;
  for (const b of items) {
    if (doomed.has(b.id) && !b.deleted) {
      b.deleted = true;
      b.updatedAt = t;
      n++;
    }
  }
  return n;
}

// Import a bookmarks tree: { bar: [nodes], other: [nodes] }, node = { type:'folder', title, children } | { type:'bookmark', title, url }.
// - Folders with the same name in the same place are reused, so importing twice doesn't duplicate.
// - A bookmark that already exists loose on the bookmarks bar (e.g. from an earlier import
//   without folders) is moved into its folder instead of being added again.
// - A bookmark already filed in a folder is left where it is.
function importTree(items, treeIn) {
  const stats = { added: 0, moved: 0, folders: 0, skipped: 0 };
  const handled = new Set(); // bookmark ids placed during this import
  const t = now();
  let seq = 0;

  const looseByUrl = new Map();
  const filedUrls = new Set();
  for (const b of live(items)) {
    if (b.type !== 'bookmark') continue;
    if (b.parentId === BAR) {
      if (!looseByUrl.has(b.url)) looseByUrl.set(b.url, []);
      looseByUrl.get(b.url).push(b);
    } else filedUrls.add(b.url);
  }

  const place = (nodes, parentId, depth) => {
    if (!Array.isArray(nodes) || depth > 30) return;
    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue;
      if (n.type === 'folder') {
        const title = String(n.title || 'Folder').slice(0, 300);
        let folder = live(items).find((b) => b.type === 'folder' && b.parentId === parentId && b.title === title);
        if (!folder) {
          folder = { id: newId(), type: 'folder', title, parentId, order: t + seq++, createdAt: t, updatedAt: t };
          items.push(folder);
          stats.folders++;
        } else {
          // Re-importing: keep folders in the file's order alongside the bookmarks around them.
          folder.order = t + seq++;
          folder.updatedAt = t;
        }
        place(n.children, folder.id, depth + 1);
      } else if (typeof n.url === 'string' && /^(https?|ftp|file):/i.test(n.url)) {
        const loose = (looseByUrl.get(n.url) || []).find((b) => !handled.has(b.id));
        if (loose) {
          // Re-file the loose copy into the right folder (keeps the same id so sync follows it).
          if (loose.parentId !== parentId) {
            loose.parentId = parentId;
            stats.moved++;
          }
          loose.order = t + seq++;
          loose.updatedAt = t;
          if (n.title) loose.title = String(n.title).slice(0, 300);
          handled.add(loose.id);
          continue;
        }
        const already = live(items).find((b) => b.type === 'bookmark' && b.url === n.url && b.parentId === parentId);
        if (already || (filedUrls.has(n.url) && parentId === BAR)) {
          stats.skipped++;
          continue;
        }
        const bm = { id: newId(), type: 'bookmark', title: String(n.title || n.url).slice(0, 300), url: n.url, parentId, order: t + seq++, createdAt: t, updatedAt: t };
        items.push(bm);
        handled.add(bm.id);
        stats.added++;
      }
    }
  };

  place(treeIn && treeIn.bar, BAR, 0);
  place(treeIn && treeIn.other, OTHER, 0);
  return stats;
}

// Netscape bookmark file (what Chrome/Brave/Edge/Firefox import and export).
function toNetscapeHtml(items) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const { kids } = index(items);
  const sec = (ms) => Math.round((ms || 0) / 1000);
  const render = (pid, indent) =>
    (kids.get(pid) || [])
      .map((b) =>
        b.type === 'folder'
          ? `${indent}<DT><H3 ADD_DATE="${sec(b.createdAt)}">${esc(b.title)}</H3>\n${indent}<DL><p>\n${render(b.id, indent + '    ')}${indent}</DL><p>\n`
          : `${indent}<DT><A HREF="${esc(b.url)}" ADD_DATE="${sec(b.createdAt)}">${esc(b.title)}</A>\n`
      )
      .join('');
  return (
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n' +
    `    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>\n    <DL><p>\n${render(BAR, '        ')}    </DL><p>\n` +
    `    <DT><H3>Other bookmarks</H3>\n    <DL><p>\n${render(OTHER, '        ')}    </DL><p>\n` +
    '</DL><p>\n'
  );
}

module.exports = { effectiveParents, BAR, OTHER, ROOTS, ROOT_TITLES, upgrade, children, tree, folderList, path, create, move, remove, importTree, toNetscapeHtml, isDescendant };
