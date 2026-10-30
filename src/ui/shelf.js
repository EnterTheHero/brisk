/* global brisk */
'use strict';
// Downloads bar: one chip per download. × on a chip clears just that one; the bar closes itself when empty.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const svg = (d, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24">${d}</svg>`;
const ICON = {
  close: '<path d="M18 6L6 18M6 6l12 12"/>',
  more: '<path d="M6 9l6 6 6-6"/>',
  file: '<path d="M6 2.5h8l4.5 4.5v14.5h-12.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 2.5V7h4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
};
const R = 11.5;
const CIRC = 2 * Math.PI * R;

$('#close-bar').innerHTML = svg(ICON.close);
$('#close-bar').addEventListener('click', () => brisk.closeShelf());
$('#show-all').addEventListener('click', () => brisk.openDownloadsFolder());
$('#clear-done').addEventListener('click', () => brisk.clearFinishedDownloads());

function size(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}
function timeLeft(sec) {
  if (!isFinite(sec) || sec <= 0) return '';
  if (sec < 60) return `${Math.ceil(sec)} sec left`;
  if (sec < 3600) return `${Math.ceil(sec / 60)} min left`;
  return `${(sec / 3600).toFixed(1)} hr left`;
}
function status(d) {
  if (d.state === 'completed') return `${size(d.total || d.received)}${d.site ? ` · ${d.site}` : ''}`;
  if (d.state === 'cancelled') return 'Cancelled';
  if (d.state === 'interrupted') return 'Failed — right-click to try again';
  if (d.paused) return `Paused · ${size(d.received)}${d.total ? ` of ${size(d.total)}` : ''}`;
  const left = d.total && d.speed ? timeLeft((d.total - d.received) / d.speed) : '';
  return [d.total ? `${size(d.received)} of ${size(d.total)}` : size(d.received), left].filter(Boolean).join(' · ');
}

const seenDone = new Set();
function render(items) {
  const box = $('#items');
  const existing = new Map([...box.children].map((el) => [el.dataset.id, el]));
  items.forEach((d, i) => {
    let el = existing.get(d.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'dl';
      el.dataset.id = d.id;
      el.innerHTML = `<div class="ic"></div><div class="txt"><div class="name"></div><div class="sub"></div></div>
        <div class="btns"><button class="more" title="More options">${svg(ICON.more)}</button><button class="x">${svg(ICON.close)}</button></div>`;
      el.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        if (el.classList.contains('done')) brisk.downloadAction(d.id, 'open');
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        brisk.downloadMenu(d.id, { x: e.clientX, y: e.clientY });
      });
      el.querySelector('.more').addEventListener('click', (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        brisk.downloadMenu(d.id, { x: r.left, y: r.top });
      });
      // × on a finished download clears just it; on a running one it cancels it.
      el.querySelector('.x').addEventListener('click', () => brisk.downloadAction(d.id, 'dismiss'));
    }
    existing.delete(d.id);
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);

    const done = d.state === 'completed';
    const running = d.state === 'progressing';
    el.classList.toggle('done', done);
    el.classList.toggle('failed', d.state === 'interrupted');
    el.classList.toggle('indeterminate', running && !d.total);
    el.title = done ? `${d.name}\nClick to open · right-click for more` : d.name;
    el.querySelector('.name').textContent = d.name;
    el.querySelector('.sub').textContent = status(d);
    el.querySelector('.x').title = running ? 'Cancel download' : 'Clear from bar';

    const ic = el.querySelector('.ic');
    const key = done ? `done:${d.icon ? 'img' : 'file'}` : running ? 'run' : 'stopped';
    if (ic.dataset.key !== key) {
      ic.dataset.key = key;
      ic.innerHTML =
        (done && d.icon ? `<img src="${esc(d.icon)}" alt="">` : svg(ICON.file, 'file')) +
        (running ? `<svg class="ring" viewBox="0 0 28 28"><circle class="track" cx="14" cy="14" r="${R}"/><circle class="bar" cx="14" cy="14" r="${R}" stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC}"/></svg>` : '');
    }
    if (running) {
      const frac = d.total ? Math.min(1, d.received / d.total) : 0.25;
      ic.querySelector('.bar').setAttribute('stroke-dashoffset', String(CIRC * (1 - frac)));
    }
    if (done && !seenDone.has(d.id)) {
      seenDone.add(d.id);
      el.classList.add('fresh-done');
      setTimeout(() => el.classList.remove('fresh-done'), 2600);
    }
  });
  for (const el of existing.values()) el.remove();
  $('#clear-done').hidden = !items.some((d) => d.state !== 'progressing');
}

brisk.onShelf(({ items, profile, isPrivate }) => {
  if (profile) document.documentElement.style.setProperty('--profile', profile.color);
  document.body.classList.toggle('private', !!isPrivate);
  render(items);
});
