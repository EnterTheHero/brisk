// Small diagnostic log (userData/brisk-debug.log) for tracking down problems that only happen on one computer.
// Records what Brisk did (menus, new tabs), never page contents. Kept under ~300 KB.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let file = null;
function dlog(...parts) {
  try {
    if (!file) file = path.join(app.getPath('userData'), 'brisk-debug.log');
    const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
    try {
      if (fs.statSync(file).size > 300_000) fs.renameSync(file, `${file}.old`);
    } catch {}
    fs.appendFileSync(file, line);
  } catch {}
}
// Only the site name of an address, so the log doesn't hold full browsing addresses.
dlog.host = (u) => {
  try {
    return new URL(u).host || String(u).slice(0, 20);
  } catch {
    return String(u || '').slice(0, 20);
  }
};
module.exports = { dlog };
