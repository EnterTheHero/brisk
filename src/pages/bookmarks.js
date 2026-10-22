/* global briskPages */
'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ICON = {
  folder: '<svg viewBox="0 0 24 24"><path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.2h8a1.5 1.5 0 0 1 1.5 1.5v8.8a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
};
const ROOTS = { bar: 'Bookmarks bar', other: 'Other bookmarks' };

let data = { items: [], folders: [] };
let byId = new Map();
let kids = new Map();
let current = 'bar';
let editingId = null;
let highlightId = null;
const expanded = new Set(['bar', 'other']);

const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
};

function indexData() {
  byId = new Map(data.items.map((b) => [b.id, b]));
  kids = new Map();
  for (const b of data.items) {
    const p = byId.has(b.parentId) || ROOTS[b.parentId] ? b.parentId : 'other';
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(b);
  }
  for (const list of kids.values()) list.sort((a, b) => a.order - b.order);
}

function ancestors(id) {
  const out = [];
  let cur = byId.get(id);
  let guard = 0;
  while (cur && guard++ < 50) {
    out.unshift(cur.parentId);
    cur = byId.get(cur.parentId);
  }
  return out;
}

function titleOf(id) {
  return ROOTS[id] || (byId.get(id) || {}).title || '';
}

// ---------- tree ----------
function renderTree() {
  const box = $('#tree');
  const rows = [];
  const walk = (id, depth) => {
    const sub = (kids.get(id) || []).filter((b) => b.type === 'folder');
    const open = expanded.has(id);
    rows.push(
      `<div class="tnode${id === current ? ' current' : ''}" data-folder="${esc(id)}" style="padding-left:${4 + depth * 14}px">` +
        `<span class="tw" data-toggle="${esc(id)}">${sub.length ? (open ? ICON.down : ICON.right) : ''}</span>` +
        `<span class="ficon">${ICON.folder}</span><span class="tlabel">${esc(titleOf(id))}</span></div>`
    );
    if (open) for (const f of sub) walk(f.id, depth + 1);
  };
  walk('bar', 0);
  walk('other', 0);
  box.innerHTML = rows.join('');
}

$('#tree').addEventListener('click', (e) => {
  const tog = e.target.closest('[data-toggle]');
  if (tog && tog.innerHTML) {
    const id = tog.dataset.toggle;
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    renderTree();
    return;
  }
  const node = e.target.closest('[data-folder]');
  if (node) openFolder(node.dataset.folder);
});

function openFolder(id) {
  current = id;
  editingId = null;
  $('#filter').value = '';
  for (const a of ancestors(id)) expanded.add(a);
  render();
}

// ---------- list ----------
function folderOptions(item) {
  // Folders it can be moved to (not into itself or its own subfolders).
  const banned = new Set();
  if (item.type === 'folder') {
    banned.add(item.id);
    let grew = true;
    while (grew) {
      grew = false;
      for (const b of data.items) if (b.type === 'folder' && banned.has(b.parentId) && !banned.has(b.id)) banned.add(b.id), (grew = true);
    }
  }
  return data.folders
    .filter((f) => !banned.has(f.id))
    .map((f) => `<option value="${esc(f.id)}"${f.id === item.parentId ? ' selected' : ''}>${'   '.repeat(f.depth)}${esc(f.title)}</option>`)
    .join('');
}

function pathText(id) {
  return [...ancestors(id)].map(titleOf).join(' / ');
}

function rowHtml(b, searching) {
  if (b.id === editingId) {
    return `<div class="bmrow" data-id="${esc(b.id)}">${b.type === 'folder' ? `<span class="ficon">${ICON.folder}</span>` : '<span class="fav"></span>'}
      <div class="info"><input type="text" class="e-title" value="${esc(b.title)}">${b.type === 'bookmark' ? `<input type="text" class="e-url" value="${esc(b.url)}">` : ''}</div>
      <button class="primary" data-act="save">Save</button><button data-act="cancel">Cancel</button></div>`;
  }
  const host = hostOf(b.url);
  const iconHtml = b.type === 'folder' ? `<span class="ficon">${ICON.folder}</span>` : host ? `<img class="fav" src="https://${esc(host)}/favicon.ico" alt="">` : '<span class="fav"></span>';
  const count = b.type === 'folder' ? (kids.get(b.id) || []).length : 0;
  const sub = b.type === 'folder' ? `${count} item${count === 1 ? '' : 's'}` : searching ? `${esc(pathText(b.id))} · ${esc(b.url)}` : esc(b.url);
  return `<div class="bmrow${b.type === 'folder' ? ' is-folder' : ''}" data-id="${esc(b.id)}" draggable="${searching ? 'false' : 'true'}">
    ${searching ? '' : '<span class="handle" title="Drag to move">⋮⋮</span>'}${iconHtml}
    <div class="info" ${b.type === 'folder' ? 'data-act="open"' : ''}><span class="t">${esc(b.title)}</span>${
      b.type === 'bookmark' ? `<a class="u" href="${esc(b.url)}" title="${esc(b.url)}">${sub}</a>` : `<span class="u">${sub}</span>`
    }</div>
    <div class="rowacts">
      <select data-act="move" title="Move to folder"><option value="" disabled>Move to…</option>${folderOptions(b)}</select>
      <button data-act="edit">${b.type === 'folder' ? 'Rename' : 'Edit'}</button>
      <button class="danger" data-act="del">Delete</button>
    </div></div>`;
}

function render() {
  indexData();
  const total = data.items.filter((b) => b.type === 'bookmark').length;
  const folders = data.items.length - total;
  $('#count').textContent = `${total} bookmark${total === 1 ? '' : 's'} in ${folders} folder${folders === 1 ? '' : 's'}`;
  renderTree();

  const q = $('#filter').value.trim().toLowerCase();
  const box = $('#list');
  let list;
  if (q) {
    list = data.items.filter((b) => b.type === 'bookmark' && `${b.title} ${b.url}`.toLowerCase().includes(q)).slice(0, 500);
    $('#crumbs').innerHTML = `${list.length} result${list.length === 1 ? '' : 's'} for “${esc(q)}”`;
  } else {
    list = kids.get(current) || [];
    const trail = [...ancestors(current), current].filter((id) => id === current || ROOTS[id] || byId.has(id));
    $('#crumbs').innerHTML = trail.map((id, i) => (i < trail.length - 1 ? `<a data-crumb="${esc(id)}">${esc(titleOf(id))}</a><span class="sep">›</span>` : esc(titleOf(id)))).join('');
  }
  box.innerHTML = list.length ? list.map((b) => rowHtml(b, !!q)).join('') : `<div class="empty">${q ? 'No matches.' : 'This folder is empty.'}</div>`;
  box.querySelectorAll('img.fav').forEach((img) => (img.onerror = () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'fav' }))));
  if (highlightId) {
    const row = box.querySelector(`[data-id="${CSS.escape(highlightId)}"]`);
    if (row) {
      row.scrollIntoView({ block: 'center' });
      row.style.background = 'var(--accent-soft)';
    }
    highlightId = null;
  }
  const edit = box.querySelector('.e-title');
  if (edit) {
    edit.focus();
    edit.select();
  }
}

async function load() {
  data = await briskPages.bookmarks();
  indexData();
  if (current !== 'bar' && current !== 'other' && !byId.has(current)) current = 'bar';
  render();
}

$('#crumbs').addEventListener('click', (e) => {
  const c = e.target.closest('[data-crumb]');
  if (c) openFolder(c.dataset.crumb);
});
$('#filter').addEventListener('input', render);

$('#list').addEventListener('click', async (e) => {
  const actEl = e.target.closest('[data-act]');
  if (!actEl || actEl.tagName === 'SELECT') return;
  const row = actEl.closest('.bmrow');
  const id = row && row.dataset.id;
  const item = byId.get(id);
  const act = actEl.dataset.act;
  if (act === 'open') openFolder(id);
  else if (act === 'edit') {
    editingId = id;
    render();
  } else if (act === 'cancel') {
    editingId = null;
    render();
  } else if (act === 'save') save(row);
  else if (act === 'del') {
    const n = item.type === 'folder' ? countDeep(id) : 0;
    if (item.type === 'folder' && n && !confirm(`Delete “${item.title}” and the ${n} item${n === 1 ? '' : 's'} inside it?`)) return;
    await briskPages.removeBookmark(id);
  }
});

$('#list').addEventListener('keydown', (e) => {
  if (!e.target.closest('.bmrow') || !editingId) return;
  if (e.key === 'Enter') save(e.target.closest('.bmrow'));
  if (e.key === 'Escape') {
    editingId = null;
    render();
  }
});

$('#list').addEventListener('change', async (e) => {
  if (e.target.dataset.act !== 'move') return;
  const id = e.target.closest('.bmrow').dataset.id;
  await briskPages.moveBookmark(id, e.target.value);
});

function countDeep(id) {
  let n = 0;
  for (const c of kids.get(id) || []) n += 1 + (c.type === 'folder' ? countDeep(c.id) : 0);
  return n;
}

async function save(row) {
  const id = row.dataset.id;
  const title = row.querySelector('.e-title').value.trim();
  const urlEl = row.querySelector('.e-url');
  const fields = { title: title || (urlEl ? urlEl.value : 'Folder') };
  if (urlEl) {
    let url = urlEl.value.trim();
    if (url && !/^[a-z]+:/i.test(url)) url = `https://${url}`;
    fields.url = url;
  }
  editingId = null;
  await briskPages.updateBookmark(id, fields);
}

// ---------- drag and drop ----------
let dragId = null;
$('#list').addEventListener('dragstart', (e) => {
  const row = e.target.closest('.bmrow');
  if (!row) return;
  dragId = row.dataset.id;
  row.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragId);
});
$('#list').addEventListener('dragend', () => {
  dragId = null;
  document.querySelectorAll('.dragging,.drop-before,.drop').forEach((el) => el.classList.remove('dragging', 'drop-before', 'drop'));
});
$('#list').addEventListener('dragover', (e) => {
  const row = e.target.closest('.bmrow');
  if (!dragId || !row || row.dataset.id === dragId) return;
  e.preventDefault();
  document.querySelectorAll('.drop-before').forEach((el) => el.classList.remove('drop-before'));
  row.classList.add('drop-before');
});
$('#list').addEventListener('drop', async (e) => {
  const row = e.target.closest('.bmrow');
  if (!dragId || !row) return;
  e.preventDefault();
  const siblings = (kids.get(current) || []).filter((b) => b.id !== dragId);
  const pos = siblings.findIndex((b) => b.id === row.dataset.id);
  await briskPages.moveBookmark(dragId, current, pos < 0 ? siblings.length : pos);
});
$('#tree').addEventListener('dragover', (e) => {
  const node = e.target.closest('[data-folder]');
  if (!dragId || !node) return;
  e.preventDefault();
  document.querySelectorAll('.tnode.drop').forEach((el) => el.classList.remove('drop'));
  node.classList.add('drop');
});
$('#tree').addEventListener('dragleave', (e) => {
  const node = e.target.closest('[data-folder]');
  if (node) node.classList.remove('drop');
});
$('#tree').addEventListener('drop', async (e) => {
  const node = e.target.closest('[data-folder]');
  if (!dragId || !node) return;
  e.preventDefault();
  await briskPages.moveBookmark(dragId, node.dataset.folder);
});

// ---------- add ----------
$('#new-folder').addEventListener('click', async () => {
  const f = await briskPages.addFolder('New folder', current);
  if (f) {
    editingId = f.id;
    await load();
  }
});
$('#new-bookmark').addEventListener('click', () => {
  $('#adder').hidden = false;
  $('#new-title').focus();
});
$('#add-cancel').addEventListener('click', () => ($('#adder').hidden = true));
async function addBookmark() {
  let url = $('#new-url').value.trim();
  if (!url) return;
  if (!/^[a-z]+:/i.test(url)) url = `https://${url}`;
  await briskPages.addBookmark($('#new-title').value.trim() || hostOf(url) || url, url, current);
  $('#new-title').value = '';
  $('#new-url').value = '';
  $('#adder').hidden = true;
}
$('#add').addEventListener('click', addBookmark);
$('#new-url').addEventListener('keydown', (e) => e.key === 'Enter' && addBookmark());

// ---------- import / export ----------
// Reads the Netscape bookmark file format that Brave, Chrome, Edge and Firefox export.
function parseBookmarkFile(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const root = doc.querySelector('dl');
  if (!root) return { bar: [], other: [] };

  const parseDL = (dl, depth) => {
    const out = [];
    if (!dl || depth > 30) return out;
    const entries = [];
    // Entries are <DT> children, sometimes wrapped in <p> by the HTML parser.
    const collect = (el) => {
      for (const c of el.children) {
        if (c.tagName === 'DT') entries.push(c);
        else if (c.tagName === 'P') collect(c);
        else if (c.tagName === 'DL' && entries.length) entries[entries.length - 1]._dl = c; // folder contents placed after its <DT>
      }
    };
    collect(dl);
    for (const dt of entries) {
      const h3 = dt.querySelector(':scope > h3');
      const a = dt.querySelector(':scope > a');
      if (h3) {
        const sub = dt.querySelector(':scope > dl') || dt._dl || (dt.nextElementSibling && dt.nextElementSibling.tagName === 'DL' ? dt.nextElementSibling : null);
        out.push({ type: 'folder', title: h3.textContent.trim(), toolbar: h3.hasAttribute('personal_toolbar_folder'), children: parseDL(sub, depth + 1) });
      } else if (a && a.getAttribute('href')) {
        out.push({ type: 'bookmark', title: a.textContent.trim(), url: a.getAttribute('href') });
      }
    }
    return out;
  };

  const top = parseDL(root, 0);
  const result = { bar: [], other: [] };
  const toolbar = top.find((n) => n.type === 'folder' && n.toolbar);
  for (const n of top) {
    if (n === toolbar) result.bar.push(...n.children);
    else if (n.type === 'folder' && /^other bookmarks$/i.test(n.title)) result.other.push(...n.children);
    else if (!toolbar) result.bar.push(n);
    else result.other.push(n);
  }
  return result;
}

$('#import').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const tree = parseBookmarkFile(await file.text());
  const stats = await briskPages.importBookmarks(tree);
  e.target.value = '';
  const parts = [];
  if (stats.added) parts.push(`${stats.added} bookmark${stats.added === 1 ? '' : 's'} added`);
  if (stats.moved) parts.push(`${stats.moved} moved into their folders`);
  if (stats.folders) parts.push(`${stats.folders} folder${stats.folders === 1 ? '' : 's'} created`);
  alert(parts.length ? `Import done: ${parts.join(', ')}.` : 'Everything in that file is already here.');
  openFolder('bar');
});

$('#export').addEventListener('click', async () => {
  const html = await briskPages.exportBookmarks();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  a.download = 'brisk-bookmarks.html';
  a.click();
});

// Opened as brisk://bookmarks#<id>: show that bookmark or folder.
function fromHash() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (!id) return;
  const item = byId.get(id);
  if (!item) return;
  if (item.type === 'folder') openFolder(id);
  else {
    highlightId = id;
    openFolder(item.parentId);
  }
}

window.parseBookmarkFile = parseBookmarkFile; // used by tests
briskPages.onChanged((kind) => (kind === 'bookmarks' || kind === 'all') && load());
window.addEventListener('hashchange', fromHash);
load().then(fromHash);
