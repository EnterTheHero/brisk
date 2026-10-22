// One browser window: the toolbar UI on top and one WebContentsView per tab.

const path = require('path');
const { BaseWindow, WebContentsView, Menu, clipboard, nativeTheme, shell, screen } = require('electron');
const { resolveInput, displayUrl } = require('./url-utils');
const { hostOf } = require('./shields');

const IS_MAC = process.platform === 'darwin';
const NEW_TAB = 'brisk://newtab';
const UI_PRELOAD = path.join(__dirname, 'preload-ui.js');
const PAGE_PRELOAD = path.join(__dirname, 'preload-pages.js');
const ZOOM_STEPS = [-3, -2.5, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3];

// Network errors where retrying over plain HTTP makes sense after an auto-upgrade.
const HTTPS_FAIL_CODES = new Set([-100, -101, -102, -105, -106, -107, -109, -118, -200, -201, -202, -203, -207, -310, -324]);

let nextTabId = 1;

// Menu labels: keep them short, and stop Windows treating "&" as a keyboard shortcut marker.
function menuLabel(text) {
  const t = String(text || '').trim() || 'Untitled';
  return (t.length > 60 ? `${t.slice(0, 58)}…` : t).replace(/&/g, '&&');
}

function findNode(nodes, id) {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) {
      const f = findNode(n.children, id);
      if (f) return f;
    }
  }
  return null;
}

class BrowserWin {
  constructor(app, { profile, isPrivate = false, ses, urls = [], activeIndex = 0, bounds } = {}) {
    this.app = app; // the BriskApp controller (shields, windows, downloads)
    this.profile = profile; // whose bookmarks, settings, extensions and cookies this window uses
    this.isPrivate = isPrivate;
    this.ses = ses;
    this.tabs = new Map();
    this.order = [];
    this.activeId = null;
    this.closedTabs = [];
    this.chromeHeight = 108;
    this.overlay = false;
    this.htmlFullscreen = false;
    this._stateTimer = null;

    if (bounds && !BrowserWin.onScreen(bounds)) bounds = { width: bounds.width, height: bounds.height };
    this.win = new BaseWindow({
      width: (bounds && bounds.width) || 1280,
      height: (bounds && bounds.height) || 840,
      x: bounds && bounds.x,
      y: bounds && bounds.y,
      minWidth: 500,
      minHeight: 320,
      title: isPrivate ? 'Brisk — Private' : 'Brisk',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1d21' : '#f4f5f7',
      autoHideMenuBar: true,
      ...(IS_MAC ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 13 } } : {}),
      show: false,
    });

    this._id = this.win.id;

    this.ui = new WebContentsView({
      // sandbox off only so the preload can load the extension-toolbar component; this view only ever shows Brisk's own UI file.
      webPreferences: { preload: UI_PRELOAD, contextIsolation: true, sandbox: false, nodeIntegration: false },
    });
    this.ui.setBackgroundColor('#00000000');
    this.win.contentView.addChildView(this.ui);
    this.ui.webContents.loadFile(path.join(__dirname, 'ui', 'index.html'));
    this.ui.webContents.on('context-menu', (_e, params) => this._editMenu(this.ui.webContents, params));
    this.ui.webContents.on('will-navigate', (e) => e.preventDefault());
    this.ui.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.ui.webContents.once('did-finish-load', () => {
      this.win.show();
      this.pushState();
    });

    this.win.on('resize', () => this.layout());
    this.win.on('enter-full-screen', () => this.pushState());
    this.win.on('leave-full-screen', () => this.pushState());
    this.win.on('focus', () => this.app.onWindowFocus(this));
    this.win.on('close', () => this._onClose());
    // Windows shutdown/restart/sign-out closes windows without 'before-quit': save everything first.
    this.win.on('query-session-end', () => this.app.saveEverythingForQuit());
    this.win.on('session-end', () => this.app.saveEverythingForQuit());
    this.win.on('closed', () => {
      // BaseWindow doesn't destroy its views' contents; do it so audio stops and memory is freed.
      for (const t of this.tabs.values()) {
        this.app.shields.forget(t.wc.id);
        if (!this.isPrivate && !t.wc.isDestroyed()) this.profile.extensions.removeTab(t.wc);
        if (!t.wc.isDestroyed()) t.wc.close();
      }
      if (!this.ui.webContents.isDestroyed()) this.ui.webContents.close();
      this.app.onWindowClosed(this);
    });
    // Mouse back/forward buttons (Windows) and trackpad swipes (Mac)
    this.win.on('app-command', (_e, cmd) => {
      if (cmd === 'browser-backward') this.goBack();
      if (cmd === 'browser-forward') this.goForward();
    });
    this.win.on('swipe', (_e, dir) => {
      if (dir === 'left') this.goBack();
      if (dir === 'right') this.goForward();
    });

    const list = urls.length ? urls : [this.profile.store.get('homepage') || NEW_TAB];
    list.forEach((u, i) => this.createTab(u, { background: i !== Math.min(activeIndex, list.length - 1) }));
    this.layout();
  }

  // Cached: the window's id can't be read once it has been destroyed (during 'closed').
  get id() {
    return this._id;
  }

  static onScreen(b) {
    if (typeof b.x !== 'number' || typeof b.y !== 'number') return false;
    return screen.getAllDisplays().some(({ workArea: a }) => b.x + 100 > a.x && b.x < a.x + a.width - 100 && b.y >= a.y - 20 && b.y < a.y + a.height - 100);
  }

  // ---------------------------------------------------------------- layout
  layout() {
    if (this.win.isDestroyed()) return;
    const { width, height } = this.win.getContentBounds();
    const top = this.htmlFullscreen ? 0 : this.chromeHeight;
    this.ui.setBounds({ x: 0, y: 0, width, height: this.overlay ? height : this.htmlFullscreen ? 0 : top });
    for (const [id, tab] of this.tabs) {
      const active = id === this.activeId;
      tab.view.setVisible(active);
      if (active) tab.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
    }
  }

  setChromeHeight(h) {
    const n = Math.max(40, Math.min(200, Math.round(h)));
    if (n !== this.chromeHeight) {
      this.chromeHeight = n;
      this.layout();
    }
  }

  setOverlay(on) {
    this.overlay = !!on;
    this.layout();
  }

  _raiseUi() {
    // Re-adding moves the toolbar view above the tab views so dropdowns can overlap the page.
    this.win.contentView.addChildView(this.ui);
  }

  // ------------------------------------------------------------------ tabs
  createTab(url = NEW_TAB, { background = false, index } = {}) {
    const id = nextTabId++;
    const view = new WebContentsView({
      webPreferences: {
        session: this.ses,
        preload: PAGE_PRELOAD,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: true,
      },
    });
    view.setBackgroundColor('#ffffff');
    const tab = { id, view, wc: view.webContents, title: 'New Tab', url, favicon: '', loading: false, crashed: false };
    this.tabs.set(id, tab);
    if (typeof index === 'number') this.order.splice(index, 0, id);
    else this.order.push(id);

    this.win.contentView.addChildView(view);
    view.setVisible(false);
    this._raiseUi();
    this._wireTab(tab);
    if (!this.isPrivate) this.profile.extensions.addTab(tab.wc, this.win);
    tab.wc.loadURL(url).catch(() => {});

    if (!background || !this.activeId) this.activate(id);
    else this.pushState();
    return tab;
  }

  _wireTab(tab) {
    const wc = tab.wc;
    const update = () => this.pushState();

    wc.on('page-title-updated', (_e, title) => {
      tab.title = title;
      if (!this.isPrivate) this.profile.store.updateVisitTitle(wc.getURL(), title);
      update();
    });
    wc.on('page-favicon-updated', (_e, favicons) => {
      tab.favicon = favicons[0] || '';
      update();
    });
    wc.on('did-start-loading', () => {
      tab.loading = true;
      update();
    });
    wc.on('did-stop-loading', () => {
      tab.loading = false;
      update();
    });
    wc.on('did-finish-load', () => this.app.shields.clearUpgrade(wc.id));

    // Websites may not navigate to Brisk's internal brisk:// pages (only Brisk itself and its own pages can).
    const guard = (e) => {
      if (e.url.startsWith('brisk://') && !wc.getURL().startsWith('brisk://')) e.preventDefault();
    };
    wc.on('will-navigate', guard);
    wc.on('will-frame-navigate', guard);
    wc.on('will-redirect', guard);
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        tab.favicon = '';
        this.app.shields.resetCount(wc.id);
        if (!details.isRedirect) this.app.shields.clearUpgrade(wc.id);
      }
    });
    const navigated = () => {
      tab.url = wc.getURL();
      tab.crashed = false;
      if (tab.dropFailedEntry) {
        const failed = tab.dropFailedEntry;
        tab.dropFailedEntry = null;
        const nh = wc.navigationHistory;
        const idx = nh.getActiveIndex();
        if (idx > 0 && nh.getEntryAtIndex(idx - 1).url === failed) nh.removeEntryAtIndex(idx - 1);
      }
      if (!this.isPrivate) this.profile.store.addVisit(tab.url, wc.getTitle());
      update();
    };
    wc.on('did-navigate', navigated);
    wc.on('did-navigate-in-page', (_e, _url, isMainFrame) => isMainFrame && navigated());
    wc.on('media-started-playing', update);
    wc.on('media-paused', update);

    wc.on('did-fail-load', (_e, code, desc, validatedURL, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3 = aborted (normal when navigating away)
      if (validatedURL.startsWith('brisk://')) return;
      const host = hostOf(validatedURL);
      const upgraded = this.app.shields.wasUpgraded(wc.id, validatedURL);
      this.app.shields.clearUpgrade(wc.id);
      tab.dropFailedEntry = validatedURL;
      if (validatedURL.startsWith('https://') && HTTPS_FAIL_CODES.has(code) && upgraded) {
        // We upgraded this navigation to HTTPS and it didn't work: fall back to HTTP for this session.
        this.app.shields.markHttpFallback(host);
        wc.loadURL('http://' + validatedURL.slice('https://'.length)).catch(() => {});
        return;
      }
      const q = new URLSearchParams({ code: String(code), desc, url: validatedURL });
      wc.loadURL(`brisk://error/?${q}`).catch(() => {});
    });

    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      tab.crashed = true;
      tab.title = 'Page crashed';
      update();
    });

    wc.on('enter-html-full-screen', () => {
      this.htmlFullscreen = true;
      this.layout();
    });
    wc.on('leave-html-full-screen', () => {
      this.htmlFullscreen = false;
      this.layout();
    });

    wc.on('zoom-changed', (_e, dir) => this.zoom(dir === 'in' ? 1 : -1, tab));
    wc.on('found-in-page', (_e, result) => {
      if (tab.id === this.activeId) this.ui.webContents.send('find:result', result);
    });

    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (url.startsWith('brisk://') && !wc.getURL().startsWith('brisk://')) return { action: 'deny' };
      // Real popups (e.g. "Sign in with…" windows) need window.opener, so allow them.
      if (disposition === 'new-window') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { width: 520, height: 680, autoHideMenuBar: true, webPreferences: { session: this.ses } },
        };
      }
      const idx = this.order.indexOf(tab.id) + 1;
      this.createTab(url, { background: disposition === 'background-tab', index: idx });
      return { action: 'deny' };
    });

    wc.on('context-menu', (_e, params) => this._pageMenu(tab, params));
  }

  activate(id) {
    if (!this.tabs.has(id)) return;
    this.activeId = id;
    this.layout();
    const tab = this.tabs.get(id);
    if (!this.isPrivate) this.profile.extensions.selectTab(tab.wc);
    this.ui.webContents.send('find:close');
    if (tab.url.startsWith(NEW_TAB) && !tab.wc.navigationHistory.canGoBack()) this.focusOmnibox();
    else tab.wc.focus();
    this.pushState();
  }

  closeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const idx = this.order.indexOf(id);
    if (!this.isPrivate && !tab.url.startsWith(NEW_TAB)) {
      this.closedTabs.push({ url: tab.url, index: idx });
      if (this.closedTabs.length > 25) this.closedTabs.shift();
    }
    this.order.splice(idx, 1);
    this.tabs.delete(id);
    this.win.contentView.removeChildView(tab.view);
    if (!this.isPrivate) this.profile.extensions.removeTab(tab.wc);
    this.app.shields.forget(tab.wc.id);
    tab.wc.close();

    if (!this.order.length) {
      this.win.close();
      return;
    }
    if (this.activeId === id) this.activate(this.order[Math.min(idx, this.order.length - 1)]);
    else this.pushState();
  }

  reopenClosedTab() {
    const last = this.closedTabs.pop();
    if (last) this.createTab(last.url, { index: Math.min(last.index, this.order.length) });
  }

  moveTab(id, toIndex) {
    const from = this.order.indexOf(id);
    if (from < 0) return;
    this.order.splice(from, 1);
    this.order.splice(Math.max(0, Math.min(toIndex, this.order.length)), 0, id);
    this.pushState();
  }

  cycleTab(delta) {
    if (!this.order.length) return;
    const i = this.order.indexOf(this.activeId);
    this.activate(this.order[(i + delta + this.order.length) % this.order.length]);
  }

  selectTabNumber(n) {
    const id = n === 9 ? this.order[this.order.length - 1] : this.order[n - 1];
    if (id) this.activate(id);
  }

  get active() {
    return this.tabs.get(this.activeId);
  }

  // ------------------------------------------------------------ navigation
  navigate(input) {
    const url = resolveInput(input, (q) => this.profile.store.searchUrl(q));
    if (!url || !this.active) return;
    this.active.wc.loadURL(url).catch(() => {});
    this.active.wc.focus();
  }

  goBack() {
    const t = this.active;
    if (t && t.wc.navigationHistory.canGoBack()) t.wc.navigationHistory.goBack();
  }

  goForward() {
    const t = this.active;
    if (t && t.wc.navigationHistory.canGoForward()) t.wc.navigationHistory.goForward();
  }

  reload(hard = false) {
    const t = this.active;
    if (!t) return;
    if (t.crashed) t.wc.loadURL(t.url).catch(() => {});
    else if (hard) t.wc.reloadIgnoringCache();
    else t.wc.reload();
  }

  stop() {
    if (this.active) this.active.wc.stop();
  }

  goHome() {
    if (this.active) this.active.wc.loadURL(this.profile.store.get('homepage') || NEW_TAB).catch(() => {});
  }

  zoom(delta, tab = this.active) {
    if (!tab) return;
    if (delta === 0) {
      tab.wc.setZoomLevel(0);
      return;
    }
    const cur = tab.wc.getZoomLevel();
    const next = delta > 0 ? ZOOM_STEPS.find((z) => z > cur + 0.01) : [...ZOOM_STEPS].reverse().find((z) => z < cur - 0.01);
    if (next !== undefined) tab.wc.setZoomLevel(next);
  }

  find(text, { forward = true, findNext = false } = {}) {
    if (!this.active) return;
    if (!text) {
      this.active.wc.stopFindInPage('clearSelection');
      return;
    }
    this.active.wc.findInPage(text, { forward, findNext });
  }

  stopFind() {
    if (this.active) this.active.wc.stopFindInPage('keepSelection');
  }

  focusOmnibox() {
    this.ui.webContents.focus();
    this.ui.webContents.send('focus-omnibox');
  }

  toggleDevTools() {
    if (this.active) this.active.wc.toggleDevTools();
  }

  toggleMute(id = this.activeId) {
    const t = this.tabs.get(id);
    if (t) {
      t.wc.setAudioMuted(!t.wc.isAudioMuted());
      this.pushState();
    }
  }

  // ------------------------------------------------------------- bookmarks
  // Star button / Ctrl+D: bookmark the page, or if it already is, offer remove / move.
  toggleBookmark(anchor) {
    const t = this.active;
    if (!t || !/^https?:/.test(t.url)) return;
    const store = this.profile.store;
    const existing = store.findBookmarkByUrl(t.url);
    if (!existing) {
      store.addBookmark({ title: t.wc.getTitle() || t.title, url: t.url });
      return;
    }
    const folders = store.bookmarkFolders();
    this._popup(
      [
        { label: `Bookmarked in ${store.bookmarkPath(existing.id) || 'Bookmarks bar'}`, enabled: false },
        { type: 'separator' },
        {
          label: 'Move to',
          submenu: folders.map((f) => ({
            label: `${'    '.repeat(Math.max(0, f.depth))}${menuLabel(f.title)}`,
            type: 'radio',
            checked: existing.parentId === f.id,
            click: () => store.moveBookmark(existing.id, f.id),
          })),
        },
        { label: 'Edit in Bookmark Manager…', click: () => this.createTab(`brisk://bookmarks#${existing.id}`) },
        { type: 'separator' },
        { label: 'Remove Bookmark', click: () => store.removeBookmark(existing.id) },
      ],
      anchor
    );
  }

  _popup(template, anchor) {
    const opts = { window: this.win };
    if (anchor && typeof anchor.x === 'number') {
      opts.x = Math.round(anchor.x);
      opts.y = Math.round(anchor.y);
    }
    Menu.buildFromTemplate(template).popup(opts);
  }

  _bookmarkMenuItems(nodes, depth = 0) {
    if (!nodes.length) return [{ label: '(empty)', enabled: false }];
    return nodes.map((n) => {
      if (n.type !== 'folder') return { label: menuLabel(n.title || n.url), click: () => this.navigate(n.url) };
      const links = n.children.filter((c) => c.type === 'bookmark');
      const sub = depth < 25 ? this._bookmarkMenuItems(n.children, depth + 1) : [];
      if (links.length > 1) sub.unshift({ label: `Open All (${links.length}) in Tabs`, click: () => this.openAll(links) }, { type: 'separator' });
      return { label: menuLabel(n.title), submenu: sub };
    });
  }

  openAll(links) {
    links.slice(0, 50).forEach((b, i) => this.createTab(b.url, { background: i > 0 }));
  }

  // Dropdown for a folder on the bookmarks bar (or 'other' for Other bookmarks).
  showBookmarkFolder(id, anchor) {
    const store = this.profile.store;
    const node = id === 'other' || id === 'bar' ? { children: store.bookmarkTree(id) } : findNode(store.bookmarkTree('bar'), id) || findNode(store.bookmarkTree('other'), id);
    if (!node) return;
    const items = this._bookmarkMenuItems(node.children);
    const links = node.children.filter((c) => c.type === 'bookmark');
    if (links.length > 1) items.unshift({ label: `Open All (${links.length}) in Tabs`, click: () => this.openAll(links) }, { type: 'separator' });
    this._popup(items, anchor);
  }

  // Bar items that didn't fit, shown behind the » button.
  showBookmarkOverflow(ids, anchor) {
    const tree = this.profile.store.bookmarkTree('bar');
    const want = new Set(ids);
    this._popup(this._bookmarkMenuItems(tree.filter((n) => want.has(n.id))), anchor);
  }

  // ----------------------------------------------------------------- state
  pushState() {
    clearTimeout(this._stateTimer);
    this._stateTimer = setTimeout(() => this._sendState(), 16);
    this.app.saveSessionSoon();
  }

  _sendState() {
    if (this.win.isDestroyed() || this.ui.webContents.isDestroyed()) return;
    const { shields } = this.app;
    const { store } = this.profile;
    const tabs = this.order.map((id) => {
      const t = this.tabs.get(id);
      const wc = t.wc;
      const url = wc.isDestroyed() ? t.url : wc.getURL() || t.url;
      return {
        id,
        title: t.title || url,
        url,
        display: displayUrl(url),
        favicon: t.favicon,
        loading: t.loading,
        crashed: t.crashed,
        canGoBack: !wc.isDestroyed() && wc.navigationHistory.canGoBack(),
        canGoForward: !wc.isDestroyed() && wc.navigationHistory.canGoForward(),
        audible: !wc.isDestroyed() && wc.isCurrentlyAudible(),
        muted: !wc.isDestroyed() && wc.isAudioMuted(),
        blocked: shields.countFor(wc.id),
        bookmarked: !!store.findBookmarkByUrl(url),
        secure: url.startsWith('https://') || (url.startsWith('brisk://') && !url.startsWith('brisk://error')),
        web: /^https?:/.test(url),
        shieldsOff: store.shieldsOffFor(hostOf(url)),
      };
    });
    const settings = store.getSettings();
    this.ui.webContents.send('state', {
      tabs,
      activeId: this.activeId,
      activeWcId: this.active && !this.active.wc.isDestroyed() ? this.active.wc.id : -1,
      isPrivate: this.isPrivate,
      platform: process.platform,
      fullscreen: this.win.isFullScreen(),
      bookmarks: settings.showBookmarksBar ? store.bookmarkChildren('bar').map((b) => ({ id: b.id, type: b.type, title: b.title, url: b.url })) : null,
      hasOtherBookmarks: store.bookmarkChildren('other').length > 0,
      adblock: settings.adblock,
      profile: this.profile.publicInfo(),
      profileCount: this.app.profiles.list().length,
      partition: this.profile.partition,
      updateReady: !!this.app.updater.menuItem(),
    });
    const active = this.active;
    if (active) this.win.setTitle(`${active.title || 'Brisk'}${this.isPrivate ? ' — Private' : ''}`);
  }

  onBlockedCount(wcId) {
    for (const t of this.tabs.values()) {
      if (!t.wc.isDestroyed() && t.wc.id === wcId) {
        this.pushState();
        return;
      }
    }
  }

  sessionInfo() {
    // Save the address the user meant, not the error page shown for it.
    const realUrl = (u) => (u && u.startsWith('brisk://error') ? displayUrl(u) || NEW_TAB : u || NEW_TAB);
    return {
      urls: this.order.map((id) => realUrl(this.tabs.get(id).url)),
      activeIndex: Math.max(0, this.order.indexOf(this.activeId)),
      bounds: this.win.getNormalBounds(),
    };
  }

  _onClose() {
    this.app.beforeWindowClose(this);
  }

  // ----------------------------------------------------------------- menus
  showTabMenu(id) {
    const t = this.tabs.get(id);
    if (!t) return;
    Menu.buildFromTemplate([
      { label: 'New Tab to the Right', click: () => this.createTab(NEW_TAB, { index: this.order.indexOf(id) + 1 }) },
      { label: 'Reload', click: () => t.wc.reload() },
      { label: 'Duplicate', click: () => this.createTab(t.url, { index: this.order.indexOf(id) + 1 }) },
      { label: t.wc.isAudioMuted() ? 'Unmute Site' : 'Mute Site', click: () => this.toggleMute(id) },
      { type: 'separator' },
      { label: 'Close Tab', click: () => this.closeTab(id) },
      {
        label: 'Close Other Tabs',
        enabled: this.order.length > 1,
        click: () => [...this.order].filter((x) => x !== id).forEach((x) => this.closeTab(x)),
      },
      {
        label: 'Close Tabs to the Right',
        enabled: this.order.indexOf(id) < this.order.length - 1,
        click: () => this.order.slice(this.order.indexOf(id) + 1).forEach((x) => this.closeTab(x)),
      },
    ]).popup({ window: this.win });
  }

  showBookmarkMenu(id) {
    const store = this.profile.store;
    const item = store.data.bookmarks.find((b) => b.id === id && !b.deleted);
    if (!item) return;
    if (item.type === 'folder') {
      const links = store.bookmarkChildren(id).filter((b) => b.type === 'bookmark');
      Menu.buildFromTemplate([
        { label: `Open All (${links.length}) in Tabs`, enabled: links.length > 0, click: () => this.openAll(links) },
        { type: 'separator' },
        { label: 'Edit in Bookmark Manager…', click: () => this.createTab(`brisk://bookmarks#${id}`) },
        { label: 'Delete Folder', click: () => store.removeBookmark(id) },
      ]).popup({ window: this.win });
      return;
    }
    const bm = item;
    Menu.buildFromTemplate([
      { label: 'Open in New Tab', click: () => this.createTab(bm.url, { background: true }) },
      { label: 'Open in New Window', click: () => this.app.newWindow({ urls: [bm.url], profile: this.profile }) },
      { label: 'Copy Link', click: () => clipboard.writeText(bm.url) },
      { type: 'separator' },
      { label: 'Edit…', click: () => this.createTab(`brisk://bookmarks#${id}`) },
      { label: 'Delete', click: () => this.profile.store.removeBookmark(id) },
    ]).popup({ window: this.win });
  }

  showShieldsMenu() {
    const t = this.active;
    if (!t) return;
    const host = hostOf(t.url);
    const { shields } = this.app;
    const { store } = this.profile;
    const web = /^https?:/.test(t.url);
    const off = store.shieldsOffFor(host);
    const count = shields.countFor(t.wc.id);
    Menu.buildFromTemplate([
      { label: web ? host : 'Brisk Shields', enabled: false },
      {
        label: !store.get('adblock')
          ? 'Blocking is off in Settings'
          : off
            ? 'Shields are down for this site'
            : `${count} ad${count === 1 ? '' : 's'} & trackers blocked on this page`,
        enabled: false,
      },
      { type: 'separator' },
      {
        label: off ? 'Turn Shields Back On for This Site' : 'Turn Shields Off for This Site',
        enabled: web && store.get('adblock'),
        click: () => {
          store.setShieldsOff(host, !off);
          t.wc.reload();
        },
      },
      { label: 'Shields Settings…', click: () => this.createTab('brisk://settings') },
    ]).popup({ window: this.win });
  }

  showMainMenu() {
    this.app.mainMenu(this).popup({ window: this.win });
  }

  _editMenu(wc, params) {
    const items = [];
    if (params.isEditable) {
      items.push(
        { label: 'Undo', enabled: params.editFlags.canUndo, click: () => wc.undo() },
        { label: 'Redo', enabled: params.editFlags.canRedo, click: () => wc.redo() },
        { type: 'separator' },
        { label: 'Cut', enabled: params.editFlags.canCut, click: () => wc.cut() },
        { label: 'Copy', enabled: params.editFlags.canCopy, click: () => wc.copy() },
        { label: 'Paste', enabled: params.editFlags.canPaste, click: () => wc.paste() },
        { label: 'Select All', click: () => wc.selectAll() }
      );
    } else if (params.selectionText) {
      items.push({ label: 'Copy', click: () => wc.copy() });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: this.win });
  }

  _pageMenu(tab, params) {
    const wc = tab.wc;
    const items = [];
    const idx = this.order.indexOf(tab.id) + 1;
    const sel = params.selectionText && params.selectionText.trim();

    if (params.linkURL) {
      items.push(
        { label: 'Open Link in New Tab', click: () => this.createTab(params.linkURL, { background: true, index: idx }) },
        { label: 'Open Link in New Window', click: () => this.app.newWindow({ urls: [params.linkURL], profile: this.profile }) },
        { label: 'Open Link in Private Window', click: () => this.app.newWindow({ urls: [params.linkURL], isPrivate: true, profile: this.profile }) },
        { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' }
      );
    }
    if (params.mediaType === 'image' && params.srcURL) {
      items.push(
        { label: 'Open Image in New Tab', click: () => this.createTab(params.srcURL, { background: true, index: idx }) },
        { label: 'Save Image As…', click: () => wc.downloadURL(params.srcURL) },
        { label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) },
        { label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) },
        { type: 'separator' }
      );
    }
    if (params.isEditable) {
      if (params.misspelledWord) {
        for (const s of params.dictionarySuggestions.slice(0, 4)) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
        items.push({ label: 'Add to Dictionary', click: () => this.ses.addWordToSpellCheckerDictionary(params.misspelledWord) }, { type: 'separator' });
      }
      items.push(
        { label: 'Cut', enabled: params.editFlags.canCut, click: () => wc.cut() },
        { label: 'Copy', enabled: params.editFlags.canCopy, click: () => wc.copy() },
        { label: 'Paste', enabled: params.editFlags.canPaste, click: () => wc.paste() },
        { label: 'Select All', click: () => wc.selectAll() },
        { type: 'separator' }
      );
    } else if (sel) {
      const short = sel.length > 24 ? `${sel.slice(0, 24)}…` : sel;
      items.push(
        { label: 'Copy', click: () => wc.copy() },
        { label: `Search for “${short}”`, click: () => this.createTab(this.profile.store.searchUrl(sel), { index: idx }) },
        { type: 'separator' }
      );
    }
    if (!params.linkURL && !params.isEditable && !sel && params.mediaType === 'none') {
      items.push(
        { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Reload', click: () => wc.reload() },
        { type: 'separator' },
        { label: 'Save Page As…', click: () => wc.downloadURL(wc.getURL()) },
        { label: 'View Page Source', click: () => this.createTab(`view-source:${wc.getURL()}`, { index: idx }) },
        { type: 'separator' }
      );
    }
    if (!this.isPrivate) {
      const extItems = this.profile.extensions.contextMenuItems(wc, params);
      if (extItems.length) items.push(...extItems, { type: 'separator' });
    }
    items.push({ label: 'Inspect', click: () => wc.inspectElement(params.x, params.y) });
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }

  openExternal(url) {
    shell.openExternal(url);
  }
}

module.exports = { BrowserWin, NEW_TAB };
