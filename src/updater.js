// Updates from GitHub Releases (github.com/EnterTheHero/brisk).
//
// Windows: Squirrel downloads new versions in the background and installs them
// the next time Brisk restarts (you're offered "Restart to update").
// Mac: without a paid Apple Developer account macOS won't let an app replace
// itself, so Brisk checks for a newer version and offers the download page.

const { app, autoUpdater, dialog, Notification, shell, net } = require('electron');

const REPO = 'EnterTheHero/brisk';
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

class Updater {
  constructor(brisk) {
    this.brisk = brisk;
    this.state = { status: 'idle', latest: null }; // idle | checking | downloading | ready | available | error
  }

  start() {
    if (!app.isPackaged) return; // only installed copies update
    if (process.platform === 'win32') this._startWindows();
    setTimeout(() => this.check(), 30_000);
    setInterval(() => this.check(), CHECK_EVERY_MS);
  }

  _startWindows() {
    try {
      // Squirrel reads RELEASES and the .nupkg from the latest GitHub release.
      autoUpdater.setFeedURL({ url: `https://github.com/${REPO}/releases/latest/download` });
    } catch (err) {
      console.error('[updater] setFeedURL failed', err.message);
      return;
    }
    autoUpdater.on('checking-for-update', () => this._set({ status: 'checking' }));
    autoUpdater.on('update-available', () => this._set({ status: 'downloading' }));
    autoUpdater.on('update-not-available', () => this._set({ status: 'idle' }));
    autoUpdater.on('error', (err) => {
      console.error('[updater]', err && err.message);
      this._set({ status: 'error' });
    });
    autoUpdater.on('update-downloaded', (_e, notes, name) => {
      this._set({ status: 'ready', latest: name || null });
      this._notify('Brisk update ready', 'Restart Brisk to finish updating.', () => this.restartToUpdate());
    });
  }

  check() {
    if (!app.isPackaged) return;
    if (process.platform === 'win32') {
      if (this.state.status === 'ready' || this.state.status === 'downloading') return;
      try {
        autoUpdater.checkForUpdates();
      } catch (err) {
        console.error('[updater] check failed', err.message);
      }
      return;
    }
    this._checkLatestRelease();
  }

  // Mac (and anything else): compare with the newest release on GitHub.
  async _checkLatestRelease() {
    try {
      const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) return;
      const rel = await res.json();
      const latest = String(rel.tag_name || '').replace(/^v/, '');
      if (latest && isNewer(latest, app.getVersion())) {
        const first = this.state.latest !== latest;
        this._set({ status: 'available', latest });
        if (first) this._notify(`Brisk ${latest} is available`, 'Click to download the new version.', () => this.openDownload());
      }
    } catch {
      /* offline; try again later */
    }
  }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this.brisk.broadcastState();
  }

  _notify(title, body, onClick) {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: true });
    n.on('click', onClick);
    n.show();
  }

  // Shown in the ⋯ menu when there's something to do.
  menuItem() {
    if (this.state.status === 'ready') return { label: 'Restart to Update Brisk', click: () => this.restartToUpdate() };
    if (this.state.status === 'available') return { label: `Download Brisk ${this.state.latest}…`, click: () => this.openDownload() };
    return null;
  }

  async restartToUpdate() {
    const w = this.brisk.currentWindow();
    const { response } = await dialog.showMessageBox(w ? w.win : undefined, {
      type: 'question',
      message: 'Restart Brisk to finish updating?',
      detail: 'Your tabs will reopen.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return;
    this.brisk.saveEverythingForQuit();
    autoUpdater.quitAndInstall();
  }

  openDownload() {
    shell.openExternal(RELEASES_PAGE);
  }
}

function isNewer(a, b) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

module.exports = { Updater, isNewer };
