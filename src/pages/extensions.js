/* global briskPages */
'use strict';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const box = document.getElementById('list');

function render(list) {
  if (!list.length) {
    box.innerHTML = '<div class="empty">No extensions yet.</div>';
    return;
  }
  box.innerHTML = list
    .map(
      (e) => `<div class="ext" data-id="${esc(e.id)}">
        ${e.icon ? `<img class="ic" src="${esc(e.icon)}" alt="">` : '<span class="ic"></span>'}
        <div class="info"><div class="name">${esc(e.name)}<small>${esc(e.version)}</small></div><div class="desc">${esc(e.description)}</div></div>
        ${e.options ? `<button data-act="options" data-url="${esc(e.options)}">Options</button>` : ''}
        <button class="danger" data-act="remove">Remove</button>
      </div>`
    )
    .join('');
  box.querySelectorAll('img.ic').forEach((img) => (img.onerror = () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'ic' }))));
}

async function load() {
  render(await briskPages.extensions());
}

box.addEventListener('click', async (e) => {
  const act = e.target.dataset.act;
  if (!act) return;
  const row = e.target.closest('.ext');
  if (act === 'options') briskPages.openTab(e.target.dataset.url);
  if (act === 'remove') {
    const name = row.querySelector('.name').firstChild.textContent;
    if (!confirm(`Remove ${name}?`)) return;
    e.target.disabled = true;
    render(await briskPages.removeExtension(row.dataset.id));
  }
});

document.getElementById('store').addEventListener('click', () => {
  location.href = 'https://chromewebstore.google.com/';
});

briskPages.onChanged((kind) => kind === 'extensions' && load());
load();
