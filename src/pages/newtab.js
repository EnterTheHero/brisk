/* global briskPages */
'use strict';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function tick() {
  const now = new Date();
  document.getElementById('clock').textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  document.getElementById('date').textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}
tick();
setInterval(tick, 10_000);

async function load() {
  const s = await briskPages.state();
  const stat = document.getElementById('stat');
  if (s.isPrivate) {
    stat.hidden = false;
    stat.innerHTML = 'Private window: history, cookies and site data are erased when you close it.';
  } else if (s.settings.adblock && s.blockedTotal > 0) {
    stat.hidden = false;
    stat.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z"/></svg><span><b>${s.blockedTotal.toLocaleString()}</b> ads &amp; trackers blocked since Brisk opened</span>`;
  }

  const tiles = document.getElementById('tiles');
  tiles.innerHTML = s.bookmarks
    .slice(0, 12)
    .map((b) => {
      let host = '';
      try {
        host = new URL(b.url).hostname;
      } catch {}
      const letter = (b.title || host || '?').trim().charAt(0).toUpperCase();
      return `<a class="tile" href="${esc(b.url)}" title="${esc(b.title)}"><div class="ic" data-letter="${esc(letter)}">${
        host ? `<img src="https://${esc(host)}/favicon.ico" alt="">` : esc(letter)
      }</div><span>${esc(b.title || host)}</span></a>`;
    })
    .join('');
  tiles.querySelectorAll('img').forEach((img) => {
    img.onerror = () => {
      const ic = img.parentElement;
      ic.textContent = ic.dataset.letter;
    };
  });
}

load();
briskPages.onChanged(load);
