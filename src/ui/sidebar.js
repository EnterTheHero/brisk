/* global brisk */
'use strict';
// Vertical tab list (Settings → Appearance → Tabs: Left). Same actions as the top tab strip.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  close: svg('<path d="M18 6L6 18M6 6l12 12"/>'),
  globe: svg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.6 5.4 3.6 8.5s-1.1 5.9-3.6 8.5c-2.5-2.6-3.6-5.4-3.6-8.5S9.5 6.1 12 3.5z"/>'),
  brisk: svg('<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>'),
  sound: svg('<path d="M5 9v6h3.5L13 19V5L8.5 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>'),
  muted: svg('<path d="M5 9v6h3.5L13 19V5L8.5 9z"/><path d="M17 9.5l4 5M21 9.5l-4 5"/>'),
};

let state = { tabs: [], activeId: null };
$('#side-new .plus').innerHTML = ICON.plus;
$('#side-new').addEventListener('click', () => brisk.newTab());

function render() {
  document.body.classList.toggle('private', !!state.isPrivate);
  document.body.classList.toggle('narrow', (state.sidebarWidth || 110) < 76);
  if (state.profile) document.documentElement.style.setProperty('--profile', state.profile.color);
  const box = $('#vtabs');
  const existing = new Map([...box.children].map((el) => [Number(el.dataset.id), el]));
  state.tabs.forEach((t, i) => {
    let el = existing.get(t.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'vtab';
      el.dataset.id = t.id;
      el.draggable = true;
      el.innerHTML = `<span class="favicon"></span><span class="title"></span><span class="audio" hidden></span><span class="close" title="Close tab">${ICON.close}</span>`;
      wire(el, t.id);
    }
    existing.delete(t.id);
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
    el.classList.toggle('active', t.id === state.activeId);
    el.title = `${t.title}\n${t.display || ''}`.trim();
    el.querySelector('.title').textContent = t.title || 'New Tab';
    const fav = el.querySelector('.favicon');
    const key = t.loading ? 'loading' : t.favicon || (t.web ? 'globe' : 'brisk');
    if (fav.dataset.key !== key) {
      fav.dataset.key = key;
      if (t.loading) fav.innerHTML = '<span class="spinner"></span>';
      else if (t.favicon) {
        fav.innerHTML = `<img src="${esc(t.favicon)}" alt="">`;
        fav.querySelector('img').onerror = () => (fav.innerHTML = ICON.globe);
      } else fav.innerHTML = t.web ? ICON.globe : ICON.brisk;
    }
    const audio = el.querySelector('.audio');
    audio.hidden = !(t.audible || t.muted);
    if (!audio.hidden) audio.innerHTML = t.muted ? ICON.muted : ICON.sound;
  });
  for (const el of existing.values()) el.remove();
  const active = box.querySelector('.vtab.active');
  if (active && state.activeId !== render.lastActive) {
    render.lastActive = state.activeId;
    active.scrollIntoView({ block: 'nearest' });
  }
}

let dragId = null;
function wire(el, id) {
  el.addEventListener('mousedown', (e) => {
    if (e.button === 0 && !e.target.closest('.close') && !e.target.closest('.audio')) brisk.activateTab(id);
  });
  el.addEventListener('auxclick', (e) => e.button === 1 && brisk.closeTab(id));
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
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragend', () => {
    dragId = null;
    document.querySelectorAll('.dragging,.drop-before').forEach((x) => x.classList.remove('dragging', 'drop-before'));
  });
  el.addEventListener('dragover', (e) => {
    if (dragId == null || dragId === id) return;
    e.preventDefault();
    document.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before'));
    el.classList.add('drop-before');
  });
  el.addEventListener('drop', (e) => {
    if (dragId == null) return;
    e.preventDefault();
    const ids = state.tabs.map((t) => t.id).filter((x) => x !== dragId);
    brisk.moveTab(dragId, ids.indexOf(id));
  });
}
// Dropping below the last tab moves it to the end.
$('#vtabs').addEventListener('dragover', (e) => dragId != null && e.preventDefault());
$('#vtabs').addEventListener('drop', (e) => {
  if (dragId == null || e.target.closest('.vtab')) return;
  e.preventDefault();
  brisk.moveTab(dragId, state.tabs.length);
});
$('#vtabs').addEventListener('dblclick', (e) => !e.target.closest('.vtab') && brisk.newTab());

// Drag the right edge to resize (narrow enough shows icons only).
const grip = $('#grip');
let startX = 0;
let startW = 0;
let pending = 0;
grip.addEventListener('pointerdown', (e) => {
  grip.setPointerCapture(e.pointerId);
  startX = e.screenX;
  startW = state.sidebarWidth || 110;
  document.body.classList.add('resizing');
});
grip.addEventListener('pointermove', (e) => {
  if (!grip.hasPointerCapture(e.pointerId)) return;
  pending = startW + (e.screenX - startX);
  requestAnimationFrame(() => pending && brisk.setSidebarWidth(pending, false));
});
grip.addEventListener('pointerup', (e) => {
  if (!grip.hasPointerCapture(e.pointerId)) return;
  grip.releasePointerCapture(e.pointerId);
  document.body.classList.remove('resizing');
  brisk.setSidebarWidth(startW + (e.screenX - startX), true);
  pending = 0;
});
grip.addEventListener('dblclick', () => brisk.setSidebarWidth(110, true));

brisk.onState((s) => {
  state = s;
  render();
});
