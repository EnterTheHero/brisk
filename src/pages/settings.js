/* global briskPages */
'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let current = null;
let changingClient = false;

function timeAgo(ts) {
  if (!ts) return 'Not synced yet';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return 'Synced just now';
  if (s < 60) return `Synced ${s} seconds ago`;
  if (s < 3600) return `Synced ${Math.round(s / 60)} min ago`;
  return `Synced ${new Date(ts).toLocaleString()}`;
}

function renderSync(sync) {
  const pill = $('#sync-pill');
  const showSetup = !sync.hasClient || changingClient;
  $('#sync-setup').hidden = !showSetup;
  $('#sync-connect').hidden = showSetup || sync.connected;
  $('#sync-on').hidden = !sync.connected;
  $('#sync-change').hidden = showSetup || sync.connected;
  $('#client-short').textContent = sync.clientId ? `${sync.clientId.slice(0, 14)}…` : '';

  pill.className = 'pill';
  if (!sync.connected) {
    pill.textContent = 'Off';
  } else if (sync.state === 'error') {
    pill.textContent = 'Error';
    pill.classList.add('bad');
  } else if (sync.state === 'syncing') {
    pill.textContent = 'Syncing…';
    pill.classList.add('ok');
  } else {
    pill.textContent = 'On';
    pill.classList.add('ok');
  }
  $('#sync-email').textContent = sync.email || 'Google account';
  $('#sync-last').textContent = sync.error ? sync.error : timeAgo(sync.lastSync);
  $('#sync-line').textContent =
    sync.error && !sync.connected
      ? sync.error
      : 'Keep bookmarks and settings the same on all your computers using your Google Drive.';
}

function render(s) {
  current = s;
  document.querySelectorAll('[data-setting]').forEach((el) => {
    const v = s.settings[el.dataset.setting];
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.tagName === 'SELECT' && el.id === 'engine') {
      if (!el.options.length) {
        el.innerHTML = Object.entries(s.engines)
          .map(([k, name]) => `<option value="${esc(k)}">${esc(name)}</option>`)
          .join('');
      }
      el.value = v;
    } else el.value = v;
  });
  const home = $('#homepage');
  if (document.activeElement !== home) home.value = s.settings.homepage === 'brisk://newtab' ? '' : s.settings.homepage;

  const off = $('#shields-off');
  off.innerHTML = s.shieldsOff.length
    ? s.shieldsOff
        .map((h) => `<div class="row" style="padding:8px 0"><div class="label">${esc(h)}</div><button data-on="${esc(h)}">Turn shields on</button></div>`)
        .join('')
    : '<span class="muted">None</span>';

  renderSync(s.sync);
  $('#subline').textContent = `Settings for the “${s.profile.name}” profile. Settings, bookmarks and per-site shield choices sync to every computer this profile signs in on.`;
  $('#swatches').innerHTML = s.colors
    .map((c) => `<button class="swatch${c.toLowerCase() === s.profile.color.toLowerCase() ? ' on' : ''}" data-color="${c}" title="${c}"></button>`)
    .join('');
  $('#swatches').querySelectorAll('.swatch').forEach((el) => el.style.setProperty('background', el.dataset.color));
  $('#about').textContent = `Brisk ${s.version} · Chromium engine via Electron`;
}

async function load() {
  render(await briskPages.state());
  if (location.hash === '#sync') $('#sync').scrollIntoView();
}

// settings controls
document.querySelectorAll('[data-setting]').forEach((el) => {
  el.addEventListener('change', () => {
    briskPages.setSetting(el.dataset.setting, el.type === 'checkbox' ? el.checked : el.value);
  });
});
$('#homepage').addEventListener('change', (e) => {
  let v = e.target.value.trim();
  if (v && !/^[a-z]+:\/\//i.test(v)) v = `https://${v}`;
  briskPages.setSetting('homepage', v || 'brisk://newtab');
});
$('#shields-off').addEventListener('click', (e) => {
  const host = e.target.dataset && e.target.dataset.on;
  if (host) briskPages.shieldsOn(host);
});

$('#swatches').addEventListener('click', (e) => {
  const c = e.target.dataset && e.target.dataset.color;
  if (c) briskPages.updateProfile(current.profile.id, { color: c });
});

// sync controls
$('#open-console').addEventListener('click', () => briskPages.openExternal('https://console.cloud.google.com/apis/library/drive.googleapis.com'));
$('#save-client').addEventListener('click', async () => {
  const id = $('#client-id').value.trim();
  const secret = $('#client-secret').value.trim();
  if (!/\.apps\.googleusercontent\.com$/.test(id)) {
    alert('That doesn’t look like a Google OAuth client ID. It should end in .apps.googleusercontent.com');
    return;
  }
  await briskPages.syncSetClient(id, secret);
  changingClient = false;
  $('#client-secret').value = '';
  load();
});
$('#change-client').addEventListener('click', () => {
  changingClient = true;
  $('#client-id').value = current.sync.clientId || '';
  renderSync(current.sync);
});
$('#connect').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = 'Waiting for Google…';
  const res = await briskPages.syncConnect();
  btn.disabled = false;
  btn.textContent = 'Connect';
  if (!res.ok) alert(`Couldn’t connect: ${res.error}`);
  load();
});
$('#sync-now').addEventListener('click', () => briskPages.syncNow());
$('#disconnect').addEventListener('click', async () => {
  if (!confirm('Stop syncing on this computer? Your bookmarks stay here and in Drive.')) return;
  await briskPages.syncDisconnect();
  load();
});

// clear data
$('#clear').addEventListener('click', async (e) => {
  const what = { history: $('#clr-history').checked, cache: $('#clr-cache').checked, cookies: $('#clr-cookies').checked };
  if (!what.history && !what.cache && !what.cookies) return;
  e.target.disabled = true;
  await briskPages.clearData(what);
  e.target.textContent = 'Cleared';
  setTimeout(() => {
    e.target.disabled = false;
    e.target.textContent = 'Clear';
  }, 1500);
});

briskPages.onChanged(load); // includes profile color changes
briskPages.onSync((sync) => {
  if (current) {
    current.sync = sync;
    renderSync(sync);
  }
});
setInterval(() => current && renderSync(current.sync), 15_000);
load();
