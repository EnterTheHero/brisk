// Shields: ad and tracker blocking, HTTPS upgrade and Global Privacy Control.
//
// Blocking uses Ghostery's open-source engine with EasyList, EasyPrivacy and
// related lists (the same family of lists Brave uses). Lists are cached on
// disk and refreshed in the background every few days.
//
// Electron allows only one webRequest listener per event, so this module owns
// those listeners and calls into the blocker itself. That lets us add
// per-site "shields off", HTTPS upgrade and per-tab blocked counts.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { app, ipcMain, webContents } = require('electron');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const { adjustRequestHeaders } = require('./compat');

const LIST_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const COSMETIC_PRELOAD = require.resolve('@ghostery/adblocker-electron-preload');

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function isLocalHost(host) {
  return (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.localhost') ||
    /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
    host === '[::1]'
  );
}

class Shields extends EventEmitter {
  constructor() {
    super();
    this.stores = new WeakMap(); // session -> that profile's store (settings + per-site choices)
    this.blocker = null;
    this.cacheFile = path.join(app.getPath('userData'), 'brisk-filters.bin');
    this.counts = new Map(); // webContentsId -> blocked count for current page
    this.totalBlocked = 0;
    this.httpFallback = new Set(); // hosts that failed over HTTPS this session
    this.upgraded = new Map(); // webContentsId -> https:// URL we auto-upgraded and haven't seen load yet
    this.sessions = new Set();
    this._ipcReady = false;
  }

  async init() {
    try {
      const stat = fs.statSync(this.cacheFile);
      this.blocker = ElectronBlocker.deserialize(new Uint8Array(fs.readFileSync(this.cacheFile)));
      if (Date.now() - stat.mtimeMs > LIST_MAX_AGE_MS) this._refreshLists();
    } catch {
      await this._refreshLists();
    }
  }

  async _refreshLists() {
    try {
      const fresh = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch);
      fs.writeFileSync(this.cacheFile, Buffer.from(fresh.serialize()));
      this.blocker = fresh;
    } catch (err) {
      console.error('[shields] could not download filter lists:', err.message);
    }
  }

  // ---- per-site state ----
  siteHostForRequest(details) {
    if (details.resourceType === 'mainFrame') return hostOf(details.url);
    const wc = details.webContentsId ? webContents.fromId(details.webContentsId) : null;
    return wc && !wc.isDestroyed() ? hostOf(wc.getURL()) : hostOf(details.referrer);
  }

  // Requests made by extensions themselves (popups, background pages) are never blocked.
  fromExtension(details) {
    if (String(details.referrer || '').startsWith('chrome-extension://')) return true;
    const wc = details.webContentsId ? webContents.fromId(details.webContentsId) : null;
    return !!(wc && !wc.isDestroyed() && wc.getURL().startsWith('chrome-extension://'));
  }

  activeFor(store, host) {
    return !!store && store.get('adblock') && !!this.blocker && !store.shieldsOffFor(host);
  }

  countFor(wcId) {
    return this.counts.get(wcId) || 0;
  }

  resetCount(wcId) {
    this.counts.set(wcId, 0);
    this.emit('count', wcId, 0);
  }

  _bump(wcId) {
    if (!wcId) return;
    const n = (this.counts.get(wcId) || 0) + 1;
    this.counts.set(wcId, n);
    this.totalBlocked += 1;
    this.emit('count', wcId, n);
  }

  markHttpFallback(host) {
    this.httpFallback.add(host);
  }

  // Did we auto-upgrade this exact navigation? (Only then is falling back to HTTP safe.)
  wasUpgraded(wcId, url) {
    const u = this.upgraded.get(wcId);
    return !!u && hostOf(u) === hostOf(url);
  }

  clearUpgrade(wcId) {
    this.upgraded.delete(wcId);
  }

  forget(wcId) {
    this.upgraded.delete(wcId);
    this.counts.delete(wcId);
  }

  // ---- attach to a browser session ----
  attach(ses, store) {
    if (this.sessions.has(ses)) return;
    this.sessions.add(ses);
    this.stores.set(ses, store);
    this._registerCosmeticIpc();

    // Hides ad placeholders and runs anti-adblock fixes inside pages.
    ses.registerPreloadScript({ type: 'frame', filePath: COSMETIC_PRELOAD });

    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const url = details.url;

      // 1) Upgrade top-level http:// navigations to https://
      if (details.resourceType === 'mainFrame' && url.startsWith('http://') && store.get('httpsUpgrade')) {
        const host = hostOf(url);
        if (host && !isLocalHost(host) && !this.httpFallback.has(host)) {
          const httpsUrl = 'https://' + url.slice('http://'.length);
          if (details.webContentsId) this.upgraded.set(details.webContentsId, httpsUrl);
          callback({ redirectURL: httpsUrl });
          return;
        }
      }

      // 2) Block ads and trackers
      if (!url.startsWith('http') || this.fromExtension(details) || !this.activeFor(store, this.siteHostForRequest(details))) {
        callback({});
        return;
      }
      this.blocker.onBeforeRequest(details, (result) => {
        if (result && (result.cancel || result.redirectURL)) this._bump(details.webContentsId);
        callback(result);
      });
    });

    // A site whose HTTPS redirects back to HTTP doesn't support HTTPS: stop upgrading it
    // (otherwise we'd loop until ERR_TOO_MANY_REDIRECTS).
    ses.webRequest.onBeforeRedirect({ urls: ['https://*/*'] }, (details) => {
      if (details.resourceType !== 'mainFrame' || !details.redirectURL.startsWith('http://')) return;
      const from = hostOf(details.url);
      if (from && from === hostOf(details.redirectURL)) this.httpFallback.add(from);
    });

    ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
      if (!this.activeFor(store, this.siteHostForRequest(details))) {
        callback({});
        return;
      }
      this.blocker.onHeadersReceived(details, callback);
    });

    // Global Privacy Control: tells sites not to sell or share your data.
    ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
      if (store.get('sendGPC')) {
        details.requestHeaders['Sec-GPC'] = '1';
      }
      adjustRequestHeaders(details); // Google sign-in compatibility
      callback({ requestHeaders: details.requestHeaders });
    });
  }

  _registerCosmeticIpc() {
    if (this._ipcReady) return;
    this._ipcReady = true;
    ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (event, url, msg) => {
      if (!this.activeFor(this.stores.get(event.sender.session), hostOf(event.sender.getURL()))) return undefined;
      return this.blocker.onInjectCosmeticFilters(event, url, msg);
    });
    ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', (event) => {
      if (!this.blocker) return false;
      return this.blocker.onIsMutationObserverEnabled(event);
    });
  }
}

module.exports = { Shields, hostOf, isLocalHost };
