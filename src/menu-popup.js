// Shows a native menu under a toolbar button. Windows opens menus to the right of
// the point given, so for buttons on the right edge we shift the menu left by its
// (estimated) width so it lines up under the button and stays inside the window.

const { Menu } = require('electron');

function estimateWidth(items) {
  let longest = 0;
  for (const it of items) {
    if (!it || it.type === 'separator' || it.visible === false) continue;
    const label = String(it.label || '').replace(/&&/g, '&');
    const extra = (it.accelerator ? String(it.accelerator).length + 4 : 0) + (it.submenu ? 3 : 0);
    longest = Math.max(longest, label.length + extra);
  }
  return Math.min(480, Math.max(170, Math.round(longest * 7.3 + 70)));
}

function popupMenu(template, win, anchor) {
  const opts = { window: win };
  if (anchor && typeof anchor.x === 'number' && typeof anchor.y === 'number') {
    const x = anchor.alignRight ? anchor.x - estimateWidth(template) : anchor.x;
    opts.x = Math.max(0, Math.round(x));
    opts.y = Math.max(0, Math.round(anchor.y));
  }
  Menu.buildFromTemplate(template).popup(opts);
}

module.exports = { popupMenu, estimateWidth };
