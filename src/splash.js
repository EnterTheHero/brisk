// Startup picture: a small Brisk card shown while the first window loads (Settings → Appearance → Startup picture).
const path = require('path');
const { BrowserWindow } = require('electron');

const MIN_MS = 1200; // long enough to see, short enough not to slow anyone down
const MAX_MS = 8000; // never hang around if something goes wrong

class Splash {
  constructor() {
    this.shownAt = Date.now();
    this.win = new BrowserWindow({
      width: 480,
      height: 300,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      center: true,
      hasShadow: true,
      backgroundColor: '#00000000',
      webPreferences: { sandbox: true, contextIsolation: true, javascript: false },
    });
    this.win.loadFile(path.join(__dirname, 'ui', 'splash.html'));
    this.win.once('ready-to-show', () => !this.win.isDestroyed() && this.win.showInactive());
    this.timer = setTimeout(() => this.close(), MAX_MS);
  }

  // Close once the browser is ready (but not before the minimum time).
  done() {
    const wait = Math.max(0, MIN_MS - (Date.now() - this.shownAt));
    setTimeout(() => this.close(), wait);
  }

  close() {
    clearTimeout(this.timer);
    const w = this.win;
    if (!w || w.isDestroyed()) return;
    this.win = null;
    let o = 1;
    const fade = setInterval(() => {
      o -= 0.12;
      if (w.isDestroyed()) return clearInterval(fade);
      if (o <= 0) {
        clearInterval(fade);
        w.destroy();
      } else w.setOpacity(o);
    }, 16);
  }
}

module.exports = { Splash };
