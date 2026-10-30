/* global brisk */
'use strict';

const $ = (sel) => document.querySelector(sel);

const ICONS = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  forward: '<path d="M9 18l6-6-6-6"/>',
  reload: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  stop: '<path d="M18 6L6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M18 6L6 18M6 6l12 12"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  shield: '<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z"/>',
  shieldOff: '<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z"/><path d="M4 4l16 16"/>',
  menu: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.6 5.4 3.6 8.5s-1.1 5.9-3.6 8.5c-2.5-2.6-3.6-5.4-3.6-8.5S9.5 6.1 12 3.5z"/>',
  history: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.6"/><path d="M4 4v4.6h4.6M12 8v4l3 2"/>',
  bookmark: '<path d="M7 4h10v16l-5-3.5L7 20z"/>',
  folder: '<path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.2h8a1.5 1.5 0 0 1 1.5 1.5v8.8a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  chevrons: '<path d="M7 7l5 5-5 5M13 7l5 5-5 5"/>',
  sound: '<path d="M5 9v6h3.5L13 19V5L8.5 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>',
  muted: '<path d="M5 9v6h3.5L13 19V5L8.5 9z"/><path d="M17 9.5l4 5M21 9.5l-4 5"/>',
  brisk: '<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`;

let state = { tabs: [], activeId: null, bookmarks: null };
let editing = false; // user is typing in the address bar
let suggestions = [];
let selIndex = 0;
let findOpen = false;
let downloads = [];

// ---------- static icons ----------
$('#back').innerHTML = icon('back');
$('#forward').innerHTML = icon('forward');
$('#new-tab').innerHTML = icon('plus');
$('#menu').innerHTML = icon('menu');
$('#star').innerHTML = icon('star');
$('#downloads').innerHTML = icon('download');
$('#find-prev').innerHTML = icon('back').replace('M15 18l-6-6 6-6', 'M6 15l6-6 6 6');
$('#find-next').innerHTML = icon('back').replace('M15 18l-6-6 6-6', 'M6 9l6 6 6-6');
$('#find-close').innerHTML = icon('close');
$('#shields').insertAdjacentHTML('afterbegin', icon('shield'));

// ---------- chrome height → main process ----------
const chromeEl = $('#chrome');
new ResizeObserver(() => brisk.setHeight(chromeEl.getBoundingClientRect().height)).observe(chromeEl);

// ---------- helpers ----------
const activeTab = () => state.tabs.find((t) => t.id === state.activeId);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
};

// ---------- render ----------
function render() {
  document.body.classList.toggle('mac', state.platform === 'darwin');
  document.body.classList.toggle('fullscreen', !!state.fullscreen);
  document.body.classList.toggle('private', !!state.isPrivate);
  document.body.classList.toggle('tabs-left', !!state.tabsLeft);
  $('#private-badge').hidden = !state.isPrivate;
  renderTabs();
  renderToolbar();
  renderBookmarks();
  renderProfile();
  $('#menu').classList.toggle('update', !!state.updateReady);
  $('#menu').title = state.updateReady ? 'Menu — update available' : 'Menu';
  // Extension buttons: created once we know this window's profile (each profile has its own extensions).
  let actions = $('#ext-actions');
  if (!actions && state.partition && !state.isPrivate) {
    actions = document.createElement('browser-action-list');
    actions.id = 'ext-actions';
    actions.setAttribute('partition', state.partition);
    actions.setAttribute('alignment', 'bottom left');
    $('#shields').before(actions);
  }
  if (actions && state.activeWcId > 0 && actions.getAttribute('tab') !== String(state.activeWcId)) actions.setAttribute('tab', String(state.activeWcId));
}

// Profile color tints the window so profiles are easy to tell apart.
function renderProfile() {
  const p = state.profile;
  if (!p) return;
  document.documentElement.style.setProperty('--profile', p.color);
  const btn = $('#profile');
  btn.title = `${p.name} — switch or manage profiles`;
  const av = btn.querySelector('.avatar');
  const key = `${p.avatar ? p.avatar.length + p.avatar.slice(-32) : ''}|${p.name}|${p.color}`;
  if (av.dataset.key === key) return;
  av.dataset.key = key;
  av.style.background = p.color;
  if (p.avatar) av.innerHTML = `<img src="${p.avatar}" alt="">`;
  else av.textContent = (p.name || '?').trim().charAt(0).toUpperCase();
}

function groupChip(g) {
  const el = document.createElement('div');
  el.className = 'group-chip';
  el.dataset.group = g.id;
  el.addEventListener('click', () => brisk.toggleGroup(g.id));
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const r = el.getBoundingClientRect();
    brisk.editGroup(g.id, { x: r.left, y: r.bottom + 4 });
  });
  el.addEventListener('auxclick', (e) => e.button === 1 && e.preventDefault());
  el.addEventListener('dragover', (e) => {
    if (dragId == null) return;
    e.preventDefault();
    const members = state.tabs.filter((t) => t.groupId === g.id && t.id !== dragId);
    if (!members.length) return;
    const ids = state.tabs.map((t) => t.id).filter((x) => x !== dragId);
    const key = `chip:${g.id}`;
    if (key !== lastDragIdx) {
      lastDragIdx = key;
      brisk.moveTab(dragId, ids.indexOf(members[members.length - 1].id) + 1, g.id);
    }
  });
  return el;
}

function renderTabs() {
  const box = $('#tabs');
  const existing = new Map([...box.children].map((el) => [el.dataset.group ? `g:${el.dataset.group}` : Number(el.dataset.id), el]));
  const groups = new Map((state.groups || []).map((g) => [g.id, g]));
  const width = box.parentElement.clientWidth - 140;
  const visibleCount = state.tabs.filter((t) => !(groups.get(t.groupId) || {}).collapsed).length;
  const narrow = visibleCount * 92 + groups.size * 40 > width;
  const seq = [];
  let prevGroup = null;

  state.tabs.forEach((t) => {
    const g = groups.get(t.groupId);
    if (g && g.id !== prevGroup) {
      let chip = existing.get(`g:${g.id}`);
      if (!chip) chip = groupChip(g);
      existing.delete(`g:${g.id}`);
      chip.style.setProperty('--group', g.hex);
      chip.classList.toggle('collapsed', !!g.collapsed);
      chip.classList.toggle('unnamed', !g.name);
      chip.textContent = g.name || '';
      const count = state.tabs.filter((x) => x.groupId === g.id).length;
      chip.title = `${g.name || 'Unnamed group'} — ${count} tab${count === 1 ? '' : 's'}\nClick to ${g.collapsed ? 'expand' : 'collapse'}, right-click to edit`;
      seq.push(chip);
    }
    prevGroup = g ? g.id : null;

    let el = existing.get(t.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'tab';
      el.dataset.id = t.id;
      el.draggable = true;
      el.innerHTML = `<span class="favicon"></span><span class="title"></span><span class="audio" hidden></span><span class="close">${icon('close')}</span>`;
      wireTab(el, t.id);
    }
    existing.delete(t.id);
    seq.push(el);

    el.classList.toggle('active', t.id === state.activeId);
    el.classList.toggle('narrow', narrow);
    el.classList.toggle('fresh', !!t.fresh && t.id !== state.activeId);
    el.classList.toggle('grouped', !!g);
    el.classList.toggle('hidden-in-group', !!(g && g.collapsed));
    if (g) el.style.setProperty('--group', g.hex);
    else el.style.removeProperty('--group');
    el.title = t.title;
    el.querySelector('.title').textContent = t.title || 'New Tab';

    const fav = el.querySelector('.favicon');
    const favKey = t.loading ? 'loading' : t.favicon || (t.web ? 'globe' : 'brisk');
    if (fav.dataset.key !== favKey) {
      fav.dataset.key = favKey;
      if (t.loading) fav.innerHTML = '<span class="spinner"></span>';
      else if (t.favicon) {
        fav.innerHTML = `<img src="${esc(t.favicon)}" alt="">`;
        fav.querySelector('img').onerror = () => (fav.innerHTML = icon('globe'));
      } else fav.innerHTML = icon(t.web ? 'globe' : 'brisk');
    }

    const audio = el.querySelector('.audio');
    const showAudio = t.audible || t.muted;
    audio.hidden = !showAudio;
    if (showAudio) {
      const k = t.muted ? 'muted' : 'sound';
      if (audio.dataset.k !== k) {
        audio.dataset.k = k;
        audio.innerHTML = icon(k);
        audio.title = t.muted ? 'Unmute tab' : 'Mute tab';
      }
    }
  });
  seq.forEach((el, i) => box.children[i] !== el && box.insertBefore(el, box.children[i] || null));
  for (const el of existing.values()) el.remove();
}

let dragId = null;
let lastDragIdx = -1;
function wireTab(el, id) {
  el.addEventListener('mousedown', (e) => {
    if (e.button === 0 && !e.target.closest('.close') && !e.target.closest('.audio')) brisk.activateTab(id);
  });
  el.addEventListener('auxclick', (e) => {
    if (e.button === 1) brisk.closeTab(id);
  });
  el.querySelector('.close').addEventListener('click', (e) => {
    e.stopPropagation();
    brisk.closeTab(id);
  });
  el.querySelector('.audio').addEventListener('click', (e) => {
    e.stopPropagation();
    brisk.muteTab(id);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    brisk.tabMenu(id);
  });
  el.addEventListener('dragstart', (e) => {
    dragId = id;
    lastDragIdx = -1;
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragend', () => {
    dragId = null;
    el.classList.remove('dragging');
  });
  el.addEventListener('dragover', (e) => {
    if (dragId == null || dragId === id) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    const ids = state.tabs.map((t) => t.id).filter((x) => x !== dragId);
    const idx = ids.indexOf(id) + (after ? 1 : 0);
    // Hovering a grouped tab puts the dragged tab in that group; an ungrouped tab takes it out.
    const over = state.tabs.find((t) => t.id === id);
    const group = (over && over.groupId) || null;
    const key = `${idx}:${group}`;
    if (key !== lastDragIdx) {
      lastDragIdx = key;
      brisk.moveTab(dragId, idx, group);
    }
  });
}

function renderToolbar() {
  const t = activeTab();
  if (!t) return;
  $('#back').disabled = !t.canGoBack;
  $('#forward').disabled = !t.canGoForward;
  const reload = $('#reload');
  const rk = t.loading ? 'stop' : 'reload';
  if (reload.dataset.k !== rk) {
    reload.dataset.k = rk;
    reload.innerHTML = icon(rk);
    reload.title = t.loading ? 'Stop' : 'Reload';
  }

  if (!editing) $('#address').value = t.display;

  const site = $('#site-icon');
  const sk = !t.display ? 'search' : t.secure ? 'lock' : t.web ? 'warn' : 'globe';
  if (site.dataset.k !== sk) {
    site.dataset.k = sk;
    site.innerHTML = icon(sk);
  }
  site.classList.toggle('insecure', sk === 'warn');
  site.title = sk === 'lock' ? 'Connection is secure' : sk === 'warn' ? 'Not secure' : '';

  const star = $('#star');
  star.hidden = !t.web;
  star.classList.toggle('on', t.bookmarked);
  star.title = t.bookmarked ? 'Remove bookmark' : 'Bookmark this page';

  const shields = $('#shields');
  const off = !state.adblock || t.shieldsOff;
  shields.classList.toggle('off', off);
  const svg = shields.querySelector('svg');
  const want = off ? 'shieldOff' : 'shield';
  if (shields.dataset.k !== want) {
    shields.dataset.k = want;
    svg.outerHTML = icon(want);
  }
  const count = $('#shields-count');
  count.hidden = off || !t.blocked;
  count.textContent = t.blocked > 99 ? '99+' : String(t.blocked);
  shields.title = off ? 'Shields are down' : `${t.blocked} blocked on this page`;
}

function bookmarkEl(b) {
  const el = document.createElement('div');
  el.className = 'bm';
  el.dataset.id = b.id;
  if (b.type === 'folder') {
    el.classList.add('folder');
    el.title = b.title;
    el.innerHTML = `${icon('folder')}<span>${esc(b.title)}</span>`;
    el.addEventListener('click', () => brisk.bookmarkFolder(b.id, anchorOf(el)));
  } else {
    el.title = `${b.title}\n${b.url}`;
    const host = hostOf(b.url);
    el.innerHTML = `${host ? `<img src="https://${esc(host)}/favicon.ico" alt="">` : '<span class="dot"></span>'}<span>${esc(b.title || host)}</span>`;
    const img = el.querySelector('img');
    if (img) img.onerror = () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'dot' }));
    el.addEventListener('click', (e) => brisk.openBookmark(b.url, e.metaKey || e.ctrlKey));
    el.addEventListener('auxclick', (e) => e.button === 1 && brisk.openBookmark(b.url, true));
  }
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    brisk.bookmarkMenu(b.id);
  });
  return el;
}

// Where a dropdown should appear: just under the element.
// For buttons at the right edge: the menu's right side lines up with the button's.
function anchorRight(el) {
  const r = el.getBoundingClientRect();
  return { x: r.right, y: r.bottom + 2, alignRight: true };
}

function anchorOf(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.bottom + 2 };
}

function renderBookmarks() {
  const bar = $('#bookmarks');
  if (!state.bookmarks) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const key = JSON.stringify([state.bookmarks, state.hasOtherBookmarks]);
  if (bar.dataset.key === key) {
    fitBookmarks();
    return;
  }
  bar.dataset.key = key;
  bar.innerHTML = '';
  if (!state.bookmarks.length && !state.hasOtherBookmarks) {
    const mod = state.platform === 'darwin' ? '⌘D' : 'Ctrl+D';
    bar.innerHTML = `<span class="bm-hint">Bookmarks you add appear here. Press ${mod} or click the star.</span>`;
    return;
  }
  const items = document.createElement('div');
  items.className = 'bm-items';
  for (const b of state.bookmarks) items.appendChild(bookmarkEl(b));
  bar.appendChild(items);

  const more = document.createElement('div');
  more.className = 'bm bm-more';
  more.title = 'More bookmarks';
  more.innerHTML = icon('chevrons');
  more.hidden = true;
  more.addEventListener('click', () => {
    const hidden = [...items.children].filter((el) => el.classList.contains('overflow')).map((el) => el.dataset.id);
    brisk.bookmarkOverflow(hidden, anchorOf(more));
  });
  bar.appendChild(more);

  if (state.hasOtherBookmarks) {
    const other = document.createElement('div');
    other.className = 'bm folder bm-other';
    other.innerHTML = `${icon('folder')}<span>Other bookmarks</span>`;
    other.addEventListener('click', () => brisk.bookmarkFolder('other', anchorOf(other)));
    bar.appendChild(other);
  }
  fitBookmarks();
}

// Items that don't fit move behind the » button instead of being cut off.
function fitBookmarks() {
  const bar = $('#bookmarks');
  const items = bar.querySelector('.bm-items');
  const more = bar.querySelector('.bm-more');
  if (!items || !more) return;
  for (const el of items.children) el.classList.remove('overflow');
  // Measure with the » button showing, so the last visible item isn't cut off by it.
  more.hidden = false;
  const limit = items.getBoundingClientRect().right;
  let any = false;
  for (const el of items.children) {
    if (el.getBoundingClientRect().right > limit + 1) {
      el.classList.add('overflow');
      any = true;
    }
  }
  if (!any) {
    more.hidden = true;
    // Without the button there's more room; nothing overflowed even with it, so we're done.
  }
}
window.addEventListener('resize', fitBookmarks);
document.fonts.ready.then(fitBookmarks); // re-measure once the Inter font has loaded

// ---------- address bar & suggestions ----------
const address = $('#address');
const omnibox = $('#omnibox');
const suggBox = $('#suggestions');

function setOverlay(on) {
  $('#scrim').hidden = !on;
  brisk.setOverlay(on);
}

function showSuggestions(list) {
  suggestions = list;
  selIndex = 0;
  if (!list.length) {
    hideSuggestions();
    return;
  }
  suggBox.innerHTML = list
    .map(
      (s, i) =>
        `<div class="sugg${i === 0 ? ' sel' : ''}" data-i="${i}">${icon(s.icon)}<span class="s-title">${esc(s.title)}</span>${
          s.sub ? `<span class="s-url">— ${esc(s.sub)}</span>` : ''
        }</div>`
    )
    .join('');
  suggBox.hidden = false;
  setOverlay(true);
}

function hideSuggestions() {
  if (suggBox.hidden) return;
  suggBox.hidden = true;
  suggestions = [];
  if (!menuOpen) setOverlay(false);
}

function highlight(i) {
  selIndex = (i + suggestions.length) % suggestions.length;
  [...suggBox.children].forEach((el, j) => el.classList.toggle('sel', j === selIndex));
}

function looksLikeUrl(text) {
  return /^[a-z]+:\/\//i.test(text) || /^[^\s]+\.[a-z]{2,}(\/|$|:|\?)/i.test(text) || /^localhost/i.test(text);
}

let suggestSeq = 0;
async function updateSuggestions() {
  const text = address.value.trim();
  if (!text) {
    hideSuggestions();
    return;
  }
  const seq = ++suggestSeq;
  const found = await brisk.suggest(text);
  if (seq !== suggestSeq || !editing) return;
  const first = looksLikeUrl(text)
    ? { icon: 'globe', title: text, sub: 'Go to address', go: text }
    : { icon: 'search', title: text, sub: 'Search', go: text };
  showSuggestions([
    first,
    ...found.map((s) => ({ icon: s.type === 'bookmark' ? 'bookmark' : 'history', title: s.title, sub: s.url.replace(/^https?:\/\/(www\.)?/, ''), go: s.url })),
  ]);
}

function commit(value) {
  editing = false;
  hideSuggestions();
  if (value && value.trim()) brisk.go(value.trim());
}

address.addEventListener('focus', () => {
  omnibox.classList.add('focused');
  setTimeout(() => address.select(), 0);
});
address.addEventListener('blur', () => {
  omnibox.classList.remove('focused');
  setTimeout(() => {
    if (document.activeElement !== address) {
      editing = false;
      hideSuggestions();
      renderToolbar();
    }
  }, 120);
});
address.addEventListener('input', () => {
  editing = true;
  updateSuggestions();
});
address.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' && suggestions.length) {
    e.preventDefault();
    highlight(selIndex + 1);
  } else if (e.key === 'ArrowUp' && suggestions.length) {
    e.preventDefault();
    highlight(selIndex - 1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const s = suggestions[selIndex];
    commit(s ? s.go : address.value);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    if (!suggBox.hidden) hideSuggestions();
    else {
      editing = false;
      renderToolbar();
      brisk.focusPage();
    }
  }
});
suggBox.addEventListener('mousedown', (e) => {
  const row = e.target.closest('.sugg');
  if (!row) return;
  e.preventDefault();
  commit(suggestions[Number(row.dataset.i)].go);
});
$('#scrim').addEventListener('mousedown', () => {
  hideSuggestions();
  address.blur();
});

// ---------- buttons ----------
$('#back').addEventListener('click', () => brisk.back());
$('#forward').addEventListener('click', () => brisk.forward());
$('#reload').addEventListener('click', (e) => (activeTab()?.loading ? brisk.stop() : brisk.reload(e.shiftKey)));
$('#new-tab').addEventListener('click', () => brisk.newTab());
$('#star').addEventListener('click', () => brisk.toggleBookmark(anchorOf($('#star'))));
$('#profile').addEventListener('click', () => brisk.profileMenu(anchorOf($('#profile'))));
$('#shields').addEventListener('click', () => brisk.shieldsMenu(anchorRight($('#shields'))));
$('#menu').addEventListener('click', () => brisk.mainMenu(anchorRight($('#menu'))));
$('#downloads').addEventListener('click', () => {
  $('#downloads').classList.remove('active');
  brisk.downloadsMenu(anchorRight($('#downloads')));
});

// ---------- find in page ----------
const findInput = $('#find-input');
function openFind() {
  findOpen = true;
  $('#findbar').hidden = false;
  findInput.focus();
  findInput.select();
  if (findInput.value) brisk.find(findInput.value, { forward: true });
}
function closeFind() {
  if (!findOpen) return;
  findOpen = false;
  $('#findbar').hidden = true;
  $('#find-count').textContent = '';
  brisk.stopFind();
  brisk.focusPage();
}
function findNext(forward) {
  if (!findOpen) return openFind();
  if (findInput.value) brisk.find(findInput.value, { forward, findNext: true });
}
findInput.addEventListener('input', () => {
  if (findInput.value) brisk.find(findInput.value, { forward: true });
  else {
    brisk.find('');
    $('#find-count').textContent = '';
  }
});
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') findNext(!e.shiftKey);
  if (e.key === 'Escape') closeFind();
});
$('#find-next').addEventListener('click', () => findNext(true));
$('#find-prev').addEventListener('click', () => findNext(false));
$('#find-close').addEventListener('click', closeFind);

// ---------- events from main ----------
brisk.onState((s) => {
  state = s;
  render();
});
brisk.onFocusOmnibox(() => {
  address.focus();
  address.select();
});
brisk.onFindOpen(openFind);
brisk.onFindNext((forward) => findNext(forward));
brisk.onFindClose(() => {
  if (findOpen) {
    findOpen = false;
    $('#findbar').hidden = true;
    $('#find-count').textContent = '';
  }
});
brisk.onFindResult((r) => {
  if (r.finalUpdate !== false) $('#find-count').textContent = r.matches ? `${r.activeMatchOrdinal}/${r.matches}` : 'No results';
});
brisk.onDownloads((list) => {
  const before = downloads.length;
  downloads = list;
  const btn = $('#downloads');
  btn.hidden = !list.length;
  const busy = list.some((d) => d.state === 'progressing');
  if (busy || list.length > before) btn.classList.add('active');
  const done = list.filter((d) => d.state === 'completed').length;
  btn.title = busy ? 'Downloading…' : `${done} download${done === 1 ? '' : 's'}`;
});

window.addEventListener('resize', renderTabs);

// ---------- Brisk's own menus (toolbar, right-click, bookmark folders) ----------
// The main process sends a menu as plain data; we draw it over the page and send back the picked id.
const MENU_ICONS = {
  folder: ICONS.folder,
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  arrow: '<path d="M9 6l6 6-6 6"/>',
};
let menuOpen = false;

function closeMenu(silent, why = '') {
  if (menuOpen) brisk.debugLog(`menu close ${why || (silent ? 'silent' : '')}`);
  document.querySelectorAll('.pm').forEach((el) => el.remove());
  if (menuOpen && !silent) {
    menuOpen = false;
    if (suggBox.hidden) setOverlay(false);
  }
  menuOpen = false;
}

function menuItemEl(it) {
  if (it.type === 'separator') return Object.assign(document.createElement('div'), { className: 'pm-sep' });
  const el = document.createElement('div');
  el.className = 'pm-item' + (it.enabled ? '' : ' disabled') + (it.submenu ? ' has-sub' : '') + (it.header ? ' header' : '');
  let lead = '';
  if (it.avatar) {
    const a = it.avatar;
    lead = `<span class="pm-avatar" style="background:${esc(a.color)}">${a.img ? `<img src="${esc(a.img)}" alt="">` : esc(a.letter || '')}</span>`;
  } else if (it.favicon) {
    lead = `<img class="pm-fav" src="https://${esc(it.favicon)}/favicon.ico" alt="">`;
  } else if (it.folder) {
    lead = `<span class="pm-ico folder">${icon('folder')}</span>`;
  } else if (it.checked !== undefined) {
    lead = `<span class="pm-ico">${it.checked ? `<svg viewBox="0 0 24 24">${MENU_ICONS.check}</svg>` : ''}</span>`;
  }
  el.innerHTML = `${lead}<span class="pm-label">${esc(it.label)}</span>${it.accel ? `<span class="pm-accel">${esc(it.accel)}</span>` : ''}${
    it.submenu ? `<span class="pm-ico sub"><svg viewBox="0 0 24 24">${MENU_ICONS.arrow}</svg></span>` : ''
  }`;
  const fav = el.querySelector('.pm-fav');
  if (fav) fav.onerror = () => fav.replaceWith(Object.assign(document.createElement('span'), { className: 'pm-dot' }));
  return el;
}

function openMenuPanel(items, x, y, { alignRight = false, level = 0, parentRect = null } = {}) {
  document.querySelectorAll('.pm').forEach((el) => Number(el.dataset.level) >= level && el.remove());
  const panel = document.createElement('div');
  panel.className = 'pm';
  panel.dataset.level = String(level);
  for (const it of items) {
    const el = menuItemEl(it);
    panel.appendChild(el);
    if (it.type === 'separator' || !it.enabled) {
      el.addEventListener('mouseenter', () => document.querySelectorAll('.pm').forEach((p) => Number(p.dataset.level) > level && p.remove()));
      continue;
    }
    if (it.submenu) {
      const open = () => {
        const r = el.getBoundingClientRect();
        openMenuPanel(it.submenu, r.right - 4, r.top - 6, { level: level + 1, parentRect: r });
      };
      el.addEventListener('mouseenter', open);
      el.addEventListener('click', open);
    } else {
      el.addEventListener('mouseenter', () => document.querySelectorAll('.pm').forEach((p) => Number(p.dataset.level) > level && p.remove()));
      el.addEventListener('click', () => {
        brisk.debugLog(`menu item click "${it.label}"`);
        closeMenu(false, 'picked');
        brisk.menuPick(it.id);
      });
      if (it.url) {
        // Right-click a bookmark in a dropdown: the usual "open in…" choices, like Chrome.
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          brisk.debugLog('bookmark item right-click');
          openLinkMenu(it.url, e.clientX, e.clientY, level + 1);
        });
      }
      el.addEventListener('auxclick', (e) => {
        if (e.button === 1 && it.url) {
          closeMenu();
          brisk.openBookmark(it.url, true);
        }
      });
    }
  }
  document.body.appendChild(panel);
  // Fit inside the window: flip left/up when needed, scroll when too tall.
  const W = window.innerWidth;
  const H = window.innerHeight;
  panel.style.maxHeight = `${H - 16}px`;
  const r = panel.getBoundingClientRect();
  let left = alignRight ? x - r.width : x;
  let top = y;
  if (left + r.width > W - 6) left = parentRect ? parentRect.left - r.width + 4 : W - r.width - 6;
  if (left < 6) left = 6;
  if (top + r.height > H - 8) top = Math.max(8, H - r.height - 8);
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

function openLinkMenu(url, x, y, level) {
  document.querySelectorAll('.pm').forEach((p) => Number(p.dataset.level) >= level && p.remove());
  const panel = document.createElement('div');
  panel.className = 'pm';
  panel.dataset.level = String(level);
  const choices = [
    ['tab', 'Open in New Tab'],
    ['window', 'Open in New Window'],
    ['private', 'Open in Private Window'],
    ['sep'],
    ['copy', 'Copy Link Address'],
  ];
  for (const [where, label] of choices) {
    if (where === 'sep') {
      panel.appendChild(Object.assign(document.createElement('div'), { className: 'pm-sep' }));
      continue;
    }
    const el = menuItemEl({ label, enabled: true });
    el.addEventListener('click', () => {
      closeMenu(false, `bookmark ${where}`);
      brisk.openBookmarkIn(url, where);
    });
    panel.appendChild(el);
  }
  document.body.appendChild(panel);
  const r = panel.getBoundingClientRect();
  panel.style.left = `${Math.max(6, Math.min(x, innerWidth - r.width - 6))}px`;
  panel.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
}

brisk.onMenuShow(({ items, anchor }) => {
  hideSuggestions();
  closeMenu(true);
  menuOpen = true;
  setOverlay(true);
  // Wait a frame so the toolbar has grown to cover the window before measuring.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      openMenuPanel(items, anchor.x, anchor.y, { alignRight: !!anchor.alignRight });
      const p = document.querySelector('.pm');
      const r = p && p.getBoundingClientRect();
      brisk.debugLog(`menu drawn ${items.length} items at ${r ? `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}` : 'NONE'} viewport ${innerWidth}x${innerHeight} focus=${document.hasFocus()}`);
    })
  );
});

$('#scrim').addEventListener('mousedown', (e) => closeMenu(false, `scrim mousedown btn=${e.button} at ${e.clientX},${e.clientY}`));
$('#scrim').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  closeMenu();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && menuOpen) closeMenu();
});
window.addEventListener('blur', () => menuOpen && closeMenu(false, 'window blur'));


// ---------- tab group editor (name, color, actions) ----------
let groupEditId = null;
function closeGroupEditor() {
  const ed = document.querySelector('.group-editor');
  if (!ed) return;
  const input = ed.querySelector('input');
  if (groupEditId && input) brisk.updateGroup(groupEditId, { name: input.value });
  ed.remove();
  groupEditId = null;
  if (!menuOpen && suggBox.hidden) setOverlay(false);
}

function openGroupEditor(id, anchor) {
  closeMenu(true);
  closeGroupEditor();
  const g = (state.groups || []).find((x) => x.id === id);
  if (!g) return;
  if (!anchor) {
    const chip = document.querySelector(`.group-chip[data-group="${id}"]`);
    const r = chip ? chip.getBoundingClientRect() : { left: 80, bottom: 40 };
    anchor = { x: r.left, y: r.bottom + 4 };
  }
  groupEditId = id;
  setOverlay(true);
  const ed = document.createElement('div');
  ed.className = 'group-editor pm';
  const colors = state.groupColors || {};
  ed.innerHTML = `<input type="text" maxlength="40" placeholder="Name this group" spellcheck="false">
    <div class="ge-colors">${Object.entries(colors)
      .map(([name, hex]) => `<button class="ge-color${name === g.color ? ' on' : ''}" data-color="${name}" title="${name}" style="--c:${hex}"></button>`)
      .join('')}</div>
    <div class="pm-sep"></div>
    <div class="pm-item" data-act="new"><span class="pm-label">New tab in group</span></div>
    <div class="pm-item" data-act="ungroup"><span class="pm-label">Ungroup</span></div>
    <div class="pm-item" data-act="close"><span class="pm-label">Close group</span></div>`;
  const input = ed.querySelector('input');
  input.value = g.name || '';
  input.addEventListener('input', () => brisk.updateGroup(id, { name: input.value }));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') closeGroupEditor();
  });
  ed.querySelector('.ge-colors').addEventListener('click', (e) => {
    const c = e.target.dataset && e.target.dataset.color;
    if (!c) return;
    ed.querySelectorAll('.ge-color').forEach((b) => b.classList.toggle('on', b.dataset.color === c));
    brisk.updateGroup(id, { color: c });
  });
  ed.querySelectorAll('[data-act]').forEach((el) =>
    el.addEventListener('click', () => {
      const act = el.dataset.act;
      groupEditId = null; // don't re-save the name after the group is gone
      brisk.updateGroup(id, { name: input.value });
      ed.remove();
      setOverlay(false);
      if (act === 'new') brisk.newTabInGroup(id);
      if (act === 'ungroup') brisk.ungroup(id);
      if (act === 'close') brisk.closeGroup(id);
    })
  );
  document.body.appendChild(ed);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const r = ed.getBoundingClientRect();
      ed.style.left = `${Math.max(6, Math.min(anchor.x, window.innerWidth - r.width - 6))}px`;
      ed.style.top = `${Math.max(6, Math.min(anchor.y, window.innerHeight - r.height - 8))}px`;
      input.focus();
      input.select();
    })
  );
}
brisk.onGroupEdit(({ id, anchor }) => openGroupEditor(id, anchor));
$('#scrim').addEventListener('mousedown', () => closeGroupEditor());
window.addEventListener('keydown', (e) => e.key === 'Escape' && closeGroupEditor());

window.addEventListener('error', (e) => brisk.debugLog(`error ${e.message} @${e.lineno}`));
document.addEventListener('mousedown', (e) => menuOpen && brisk.debugLog(`mousedown btn=${e.button} on ${e.target.className || e.target.tagName} at ${e.clientX},${e.clientY}`), true);
