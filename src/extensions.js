// Chrome extension support: installs from the Chrome Web Store, keeps extensions
// updated, and provides the chrome.tabs / windows / action / contextMenus APIs
// extensions expect. Extensions run only in normal windows, never private ones.

const path = require('path');
const { dialog, nativeImage, session: electronSession } = require('electron');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const { installChromeWebStore, uninstallExtension, updateExtensions } = require('electron-chrome-web-store');

const UPDATE_EVERY_MS = 5 * 60 * 60 * 1000;
const { ExtPolyfill } = require('./ext-polyfill');

let crxHandled = false;

// One instance per profile: each profile has its own extensions, in its own session.
class Extensions {
  constructor(brisk, profile) {
    const ses = profile.session;
    this.brisk = brisk;
    this.profile = profile;
    this.session = ses;
    this.ready = null;
    const windowsOfProfile = () => [...brisk.windows.values()].filter((w) => w.profile === profile && !w.isPrivate);
    const currentWindow = () => {
      const cur = brisk.currentWindow();
      return cur && cur.profile === profile && !cur.isPrivate ? cur : windowsOfProfile()[0] || null;
    };

    // Registered first so chrome.alarms / chrome.idle exist before the extension API layer freezes `chrome`.
    this.polyfill = new ExtPolyfill(ses, profile.dir);

    this.api = new ElectronChromeExtensions({
      // electron-chrome-extensions is dual-licensed; GPL-3.0 is the free option for personal use.
      license: 'GPL-3.0',
      session: ses,
      createTab: async (details) => {
        const byId = this._winById(details.windowId);
        const w = (byId && byId.profile === profile ? byId : null) || currentWindow() || brisk.newWindow({ urls: [], profile });
        const tab = w.createTab(details.url || 'brisk://newtab', { background: details.active === false });
        return [tab.wc, w.win];
      },
      selectTab: (wc) => {
        const found = this._findTab(wc);
        if (found && found.w._ignoreExtSelect !== found.tab.id) found.w.activate(found.tab.id);
      },
      removeTab: (wc) => {
        const found = this._findTab(wc);
        if (found) found.w.closeTab(found.tab.id);
      },
      createWindow: async (details) => {
        const urls = details.url ? [].concat(details.url) : undefined;
        return brisk.newWindow({ urls, profile }).win;
      },
      removeWindow: async (win) => {
        const w = brisk.windows.get(win.id);
        if (w) w.win.close();
      },
    });

    for (const ev of ['extension-loaded', 'extension-unloaded']) {
      ses.extensions.on(ev, () => brisk.notifyPages('pages:changed', 'extensions'));
    }

    // Lets the toolbar (which lives in the default session) show extension icons.
    if (!crxHandled) {
      crxHandled = true;
      ElectronChromeExtensions.handleCRXProtocol(electronSession.defaultSession);
    }

    this.ready = installChromeWebStore({
      session: ses,
      extensionsPath: profile.extensionsPath, // undefined = default location (first profile)
      // The library's built-in updater is shared by all sessions and starves later profiles; each profile runs its own.
      autoUpdate: false,
      beforeInstall: async (details) => {
        const perms = [...new Set([...(details.manifest.permissions || []), ...(details.manifest.host_permissions || [])])]
          .filter((p) => typeof p === 'string')
          .slice(0, 12);
        const w = currentWindow();
        const { response } = await dialog.showMessageBox(w ? w.win : undefined, {
          type: 'question',
          icon: details.icon,
          message: `Add “${details.localizedName}” to Brisk?`,
          detail: perms.length ? `It can:\n• ${perms.map(describePermission).join('\n• ')}` : 'It doesn’t ask for any special permissions.',
          buttons: ['Add Extension', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
        });
        return { action: response === 0 ? 'allow' : 'deny' };
      },
    }).catch((err) => console.error('[extensions] could not load extensions:', err));

    const update = () => updateExtensions(ses).catch((err) => console.error('[extensions] update check failed:', err.message));
    this.ready.then(() => {
      if (this.disposed) return;
      this._firstUpdate = setTimeout(update, 60_000);
      this._updateTimer = setInterval(update, UPDATE_EVERY_MS);
    });
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this._firstUpdate);
    clearInterval(this._updateTimer);
    this.polyfill.dispose();
    for (const ext of this.session.extensions.getAllExtensions()) {
      try {
        this.session.extensions.removeExtension(ext.id);
      } catch {
        /* already gone */
      }
    }
  }

  _winById(id) {
    return typeof id === 'number' && id >= 0 ? this.brisk.windows.get(id) : null;
  }

  _findTab(wc) {
    for (const w of this.brisk.windows.values()) {
      for (const tab of w.tabs.values()) if (tab.wc === wc) return { w, tab };
    }
    return null;
  }

  // ---- called by windows ----
  addTab(wc, win) {
    try {
      this.api.addTab(wc, win);
    } catch (err) {
      console.error('[extensions] addTab', err.message);
    }
  }

  selectTab(wc) {
    try {
      this.api.selectTab(wc);
    } catch {
      /* tab not tracked */
    }
  }

  removeTab(wc) {
    try {
      this.api.removeTab(wc);
    } catch {
      /* already gone */
    }
  }

  contextMenuItems(wc, params) {
    try {
      return this.api.getContextMenuItems(wc, params);
    } catch {
      return [];
    }
  }

  // ---- for brisk://extensions ----
  list() {
    return this.session.extensions
      .getAllExtensions()
      .map((ext) => {
        const m = ext.manifest || {};
        const optionsPage = (m.options_ui && m.options_ui.page) || m.options_page;
        return {
          id: ext.id,
          name: ext.name,
          version: ext.version,
          description: typeof m.description === 'string' && !m.description.startsWith('__MSG_') ? m.description : '',
          options: optionsPage ? `chrome-extension://${ext.id}/${optionsPage.replace(/^\//, '')}` : '',
          icon: iconUrl(ext),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async uninstall(id) {
    await uninstallExtension(id, { session: this.session });
  }
}

// Icons are read from disk as data URLs: extension files usually can't be loaded by other pages.
function iconUrl(ext) {
  const icons = (ext.manifest && ext.manifest.icons) || {};
  const sizes = Object.keys(icons)
    .map(Number)
    .sort((a, b) => a - b);
  const best = sizes.find((s) => s >= 32) || sizes[sizes.length - 1];
  if (!best) return '';
  const file = path.resolve(ext.path, String(icons[best]).replace(/^\//, ''));
  if (!file.startsWith(path.resolve(ext.path))) return '';
  const img = nativeImage.createFromPath(file);
  return img.isEmpty() ? '' : img.resize({ width: 72 }).toDataURL();
}

function describePermission(p) {
  const map = {
    '<all_urls>': 'Read and change data on all websites',
    tabs: 'See your open tabs and their addresses',
    storage: 'Store its own data',
    cookies: 'Read and change cookies',
    history: 'Read your browsing history',
    bookmarks: 'Read and change bookmarks',
    downloads: 'Manage downloads',
    notifications: 'Show notifications',
    clipboardRead: 'Read your clipboard',
    clipboardWrite: 'Write to your clipboard',
    webRequest: 'Watch network requests',
    declarativeNetRequest: 'Block or change network requests',
    scripting: 'Run scripts on pages',
    contextMenus: 'Add right-click menu items',
    activeTab: 'Access the current tab when you click it',
    alarms: 'Run on a schedule',
    identity: 'Use your Google identity',
  };
  if (map[p]) return map[p];
  if (/^(\*|https?):\/\//.test(p)) return `Access ${p.replace(/\/\*$/, '')}`;
  return p;
}

module.exports = { Extensions };
