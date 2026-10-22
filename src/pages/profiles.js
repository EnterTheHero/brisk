/* global briskPages */
'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let state = { profiles: [], current: '', colors: [] };
let pictureFor = null;

function avatarHtml(p) {
  return p.avatar ? `<img src="${esc(p.avatar)}" alt="">` : esc((p.name || '?').trim().charAt(0).toUpperCase());
}

function render() {
  $('#list').innerHTML = state.profiles
    .map(
      (p) => `<section class="card prof${p.id === state.current ? ' current' : ''}" id="p-${esc(p.id)}" data-id="${esc(p.id)}">
      <div class="big-avatar" data-act="picture" title="Change picture" style="background:${esc(p.color)}">${avatarHtml(p)}</div>
      <div class="pbody">
        <div><input type="text" class="pname" value="${esc(p.name)}" maxlength="40" />${p.id === state.current ? '<span class="tag">This window</span>' : ''}</div>
        <div class="swatches">
          ${state.colors.map((c) => `<button class="swatch${c.toLowerCase() === p.color.toLowerCase() ? ' on' : ''}" data-color="${c}" title="${c}" style="background:${c}"></button>`).join('')}
          <input type="color" class="custom-color" value="${esc(p.color)}" title="Custom color" />
        </div>
        <div class="actions">
          ${p.id === state.current ? '' : '<button data-act="open">Open</button>'}
          ${p.avatar ? '<button data-act="nopic">Remove picture</button>' : '<button data-act="picture">Add picture</button>'}
          ${p.id === 'default' ? '' : '<button class="danger" data-act="delete">Delete</button>'}
        </div>
      </div>
    </section>`
    )
    .join('');
}

async function load() {
  state = await briskPages.profiles();
  render();
  const id = decodeURIComponent(location.hash.slice(1));
  if (id) {
    const card = document.getElementById(`p-${id}`);
    if (card) card.scrollIntoView({ block: 'center' });
  }
}

const idOf = (el) => el.closest('[data-id]').dataset.id;

$('#list').addEventListener('click', async (e) => {
  const sw = e.target.closest('[data-color]');
  if (sw) return briskPages.updateProfile(idOf(sw), { color: sw.dataset.color });
  const act = e.target.closest('[data-act]');
  if (!act) return;
  const id = idOf(act);
  const p = state.profiles.find((x) => x.id === id);
  if (act.dataset.act === 'picture') {
    pictureFor = id;
    $('#file').click();
  } else if (act.dataset.act === 'nopic') briskPages.updateProfile(id, { avatar: '' });
  else if (act.dataset.act === 'open') briskPages.openProfile(id);
  else if (act.dataset.act === 'delete') {
    if (!confirm(`Delete the profile “${p.name}”? Its bookmarks, history, extensions and sign-ins on this computer will be erased. (Anything synced to Google Drive stays there.)`)) return;
    state.profiles = await briskPages.removeProfile(id);
    render();
  }
});

$('#list').addEventListener('change', (e) => {
  if (e.target.classList.contains('pname')) briskPages.updateProfile(idOf(e.target), { name: e.target.value });
  if (e.target.classList.contains('custom-color')) briskPages.updateProfile(idOf(e.target), { color: e.target.value });
});
$('#list').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('pname')) e.target.blur();
});

// Pictures: crop to a centered square and shrink before saving.
$('#file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !pictureFor) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const size = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    canvas.getContext('2d').drawImage(img, (img.naturalWidth - size) / 2, (img.naturalHeight - size) / 2, size, size, 0, 0, 256, 256);
    URL.revokeObjectURL(url);
    briskPages.updateProfile(pictureFor, { avatar: canvas.toDataURL('image/png') });
  };
  img.onerror = () => alert('That file isn’t a picture Brisk can read. Try a JPG or PNG.');
  img.src = url;
});

$('#add').addEventListener('click', () => briskPages.createProfile());
briskPages.onChanged((kind) => kind === 'profiles' && load());
load();
