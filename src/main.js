// Brisk — main process. Wires together windows, shields, sync, internal pages and menus.

// Windows installer (Squirrel) runs the app briefly during install/update/uninstall to
// create or remove shortcuts. Handle that and exit before anything else starts.
if (process.platform === 'win32' && require('electron-squirrel-startup')) {
  require('electron').app.quit();
  return;
}

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const {
  app,
  BaseWindow,
  session,
  protocol,
  net,
  ipcMain,
  Menu,
  nativeTheme,
  dialog,
  shell,
  desktopCapturer,
  nativeImage,
} = require('electron');
require('./extensions'); // load early: it registers the crx: scheme before the app is ready
const { registerCompatPreload } = require('./compat');
const { SEARCH_ENGINES } = require('./store');
const { Shields } = require('./shields');
const { ProfileManager, COLORS } = require('./profiles');
const { BrowserWin, NEW_TAB } = require('./window');
const { Updater } = require('./updater');

const IS_MAC = process.platform === 'darwin';
const PAGES_DIR = path.join(__dirname, 'pages');
const FONTS_DIR = path.join(__dirname, 'fonts');
const PAGES = {
  newtab: 'newtab.html',
  settings: 'settings.html',
  bookmarks: 'bookmarks.html',
  extensions: 'extensions.html',
  profiles: 'profiles.html',
  error: 'error.html',
};

// ---------------------------------------------------------------- pre-ready setup
// Must list every custom scheme in one call (a later call replaces earlier ones).
protocol.registerSchemesAsPrivileged([
  { scheme: 'brisk', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'crx', privileges: { bypassCSP: true } }, // extension icons in the toolbar
]);

// Present as plain Chrome. The default Electron user agent includes "Electron/x"
// and the app name, which makes you easier to fingerprint and makes some sites
// (notably Google sign-in) refuse to work.
app.userAgentFallback = app.userAgentFallback
  .replace(/\sElectron\/\S+/i, '')
  .replace(/\sbrisk-browser\/\S+/i, '')
  .replace(/\sBrisk\/\S+/i, '')
  // Real Chrome only reports its major version ("Chrome/152.0.0.0"); the full number is a giveaway.
  .replace(/Chrome\/(\d+)[\d.]*/, 'Chrome/$1.0.0.0');

if (!app.requestSingleInstanceLock()) {
  app.exit(0); // another Brisk is already running; it gets our URLs via 'second-instance'
}

// ------------------------------------------------------------------ controller
class BriskApp {
  constructor() {
    this.shields = new Shields();
    this.windows = new Map(); // BaseWindow id -> BrowserWin
    this.lastFocused = null;
    this.quitting = false;
    this.downloads = [];
    this.permissionDecisions = new Map();
    this._sessionTimer = null;
    this._privateCount = 0;

    this.shields.init();
    this.shields.on('count', (wcId) => {
      for (const w of this.windows.values()) w.onBlockedCount(wcId);
    });

    this.updater = new Updater(this);
    this.profiles = new ProfileManager(this);
    this.profiles.on('change', () => {
      this.broadcastState();
      this.notifyPages('pages:changed', 'profiles');
    });
  }

  // The profile of the window you're looking at (or the last one you used).
  currentProfile() {
    const w = this.currentWindow();
    return w ? w.profile : this.profiles.get(this.profiles.state.lastUsed);
  }

  onProfileDataChanged(profile, kind) {
    if (kind === 'settings' || kind === 'all') this.applyTheme();
    for (const w of this.windows.values()) if (w.profile === profile) w.pushState();
    this.notifyPages('pages:changed', kind, profile);
  }

  applyTheme() {
    const w = this.currentWindow();
    if (!w) return;
    const t = w.profile.store.get('theme');
    nativeTheme.themeSource = t === 'light' || t === 'dark' ? t : 'system';
  }

  // ---- sessions ----
  setupSession(ses, profile) {
    this.shields.attach(ses, profile.store);
    registerCompatPreload(ses);
    ses.protocol.handle('brisk', (req) => {
      const u = new URL(req.url);
      const file = u.pathname === '/' || u.pathname === '' ? PAGES[u.host] : path.basename(u.pathname);
      let full = file && path.join(PAGES_DIR, file);
      if (file && !fs.existsSync(full)) full = path.join(FONTS_DIR, file); // shared font files
      if (!full || !(full.startsWith(PAGES_DIR) || full.startsWith(FONTS_DIR)) || !fs.existsSync(full)) {
        return new Response('Not found', { status: 404 });
      }
      return net.fetch(pathToFileURL(full).toString());
    });

    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      const always = ['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock'];
      if (always.includes(permission)) return callback(true);
      // Extensions declared their permissions when you installed them.
      if (String(details.requestingUrl || '').startsWith('chrome-extension://')) return callback(true);
      const labels = {
        media: details.mediaTypes && details.mediaTypes.includes('video') ? 'use your camera and microphone' : 'use your microphone',
        geolocation: 'know your location',
        notifications: 'show notifications',
        'clipboard-read': 'read your clipboard',
        midiSysex: 'use your MIDI devices',
      };
      if (!labels[permission]) return callback(false);
      let origin = '';
      try {
        origin = new URL(details.requestingUrl).origin;
      } catch {
        return callback(false);
      }
      if (!origin || origin === 'null') return callback(false);
      const key = `${origin}|${permission}|${(details.mediaTypes || []).join(',')}`;
      if (this.permissionDecisions.has(key)) return callback(this.permissionDecisions.get(key));
      const bw = this.windowForContents(wc);
      dialog
        .showMessageBox(bw ? bw.win : undefined, {
          type: 'question',
          buttons: ['Allow', 'Block'],
          defaultId: 1,
          cancelId: 1,
          message: `${new URL(origin).host} wants to ${labels[permission]}.`,
          checkboxLabel: 'Remember until Brisk restarts',
          checkboxChecked: true,
        })
        .then(({ response, checkboxChecked }) => {
          const allow = response === 0;
          if (checkboxChecked) this.permissionDecisions.set(key, allow);
          callback(allow);
        });
    });

    // Answers a page's "is this permission granted?" check (e.g. Notification.permission).
    // Electron's default says yes to everything, so only report what you actually allowed.
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
      if (['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock'].includes(permission)) return true;
      if (String(requestingOrigin || '').startsWith('chrome-extension://')) return true;
      for (const [key, allowed] of this.permissionDecisions) {
        if (allowed && key.startsWith(`${requestingOrigin}|${permission}|`)) return true;
      }
      return false;
    });

    // Screen sharing (e.g. Meet or Zoom on the web). macOS 15+ shows its own picker;
    // elsewhere Brisk asks first, then offers your screens and windows.
    ses.setDisplayMediaRequestHandler(
      async (req, callback) => {
        try {
          const origin = (req.frame && req.frame.origin) || req.securityOrigin || 'This site';
          const bw = this.windowForContents(req.frame && require('electron').webContents.fromFrame(req.frame));
          const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
          if (!sources.length) return callback({});
          const screens = sources.filter((src) => src.id.startsWith('screen:'));
          const windows = sources.filter((src) => src.id.startsWith('window:')).slice(0, 12);
          const choices = [...screens, ...windows];
          const { response } = await dialog.showMessageBox(bw ? bw.win : undefined, {
            type: 'question',
            message: `${origin.replace(/^https?:\/\//, '')} wants to share your screen.`,
            detail: 'Choose what to share.',
            buttons: ['Don’t Share', ...choices.map((src, i) => (src.id.startsWith('screen:') ? (screens.length > 1 ? `Screen ${i + 1}` : 'Entire Screen') : src.name.slice(0, 40)))],
            defaultId: 0,
            cancelId: 0,
          });
          callback(response > 0 ? { video: choices[response - 1] } : {});
        } catch {
          callback({});
        }
      },
      { useSystemPicker: true }
    );

    ses.on('will-download', (_e, item, wc) => this.trackDownload(item, wc));
  }

  newPrivateSession(profile) {
    const ses = session.fromPartition(`brisk-private-${Date.now()}-${++this._privateCount}`); // no "persist:" = memory only
    this.setupSession(ses, profile);
    return ses;
  }

  // ---- windows ----
  newWindow({ urls, isPrivate = false, activeIndex, bounds, profile } = {}) {
    profile = profile || this.currentProfile();
    const ses = isPrivate ? this.newPrivateSession(profile) : profile.session;
    const w = new BrowserWin(this, { profile, isPrivate, ses, urls, activeIndex, bounds });
    this.windows.set(w.id, w);
    this.lastFocused = w;
    if (!isPrivate) this.profiles.setLastUsed(profile.id);
    return w;
  }

  // Opens (or focuses) a profile's window, restoring its tabs from last time.
  // Clicking twice while a profile is still loading opens it once.
  openProfile(id) {
    this._opening = this._opening || new Map();
    if (!this._opening.has(id)) {
      this._opening.set(id, this._openProfile(id).finally(() => this._opening.delete(id)));
    }
    return this._opening.get(id);
  }

  async _openProfile(id) {
    const profile = this.profiles.get(id);
    await profile.ready;
    const existing = [...this.windows.values()].find((w) => w.profile === profile && !w.isPrivate);
    if (existing) {
      if (existing.win.isMinimized()) existing.win.restore();
      existing.win.focus();
      return existing;
    }
    const saved = profile.store.get('restoreTabs') ? profile.store.loadSession() : [];
    if (saved.length) {
      let first = null;
      for (const s of saved) {
        const w = this.newWindow({ urls: s.urls, activeIndex: s.activeIndex, bounds: s.bounds, profile });
        first = first || w;
      }
      return first;
    }
    return this.newWindow({ profile });
  }

  currentWindow() {
    const focused = BaseWindow.getFocusedWindow();
    return (focused && this.windows.get(focused.id)) || this.lastFocused || [...this.windows.values()][0] || null;
  }

  windowForContents(wc) {
    for (const w of this.windows.values()) {
      if (w.ui.webContents === wc) return w;
      for (const t of w.tabs.values()) if (t.wc === wc) return w;
    }
    return null;
  }

  onWindowFocus(w) {
    this.lastFocused = w;
    this.applyTheme();
    if (!w.isPrivate) this.profiles.setLastUsed(w.profile.id);
  }

  beforeWindowClose(w) {
    if (this.quitting || w.isPrivate) return;
    const others = [...this.windows.values()].filter((x) => x !== w && !x.isPrivate && x.profile === w.profile);
    // Closing a profile's last window: keep its tabs so they come back next time it's opened.
    if (!others.length) w.profile.store.saveSession([w.sessionInfo()]);
  }

  onWindowClosed(w) {
    this.windows.delete(w.id);
    if (this.lastFocused === w) this.lastFocused = null;
    if (w.isPrivate) w.ses.clearStorageData().catch(() => {});
    else if (!this.quitting && [...this.windows.values()].some((x) => !x.isPrivate && x.profile === w.profile)) this.saveSessionSoon();
    // Closing the very last window quits (on Windows): reopen this profile next launch.
    if (this.windows.size === 0 && !w.isPrivate && !this.quitting) this.profiles.setOpenAtQuit([w.profile.id]);
    if (!IS_MAC && this.windows.size === 0) app.quit();
  }

  broadcastState() {
    for (const w of this.windows.values()) w.pushState();
  }

  // Tell open brisk:// pages something changed (only that profile's pages, if given).
  notifyPages(channel, payload, profile) {
    for (const w of this.windows.values()) {
      if (profile && w.profile !== profile) continue;
      for (const t of w.tabs.values()) {
        if (!t.wc.isDestroyed() && t.wc.getURL().startsWith('brisk://')) t.wc.send(channel, payload);
      }
    }
  }

  // ---- session restore ----
  saveSessionSoon() {
    if (this.quitting) return;
    clearTimeout(this._sessionTimer);
    this._sessionTimer = setTimeout(() => this.saveSession(), 1000);
  }

  saveSession() {
    const byProfile = new Map();
    for (const w of this.windows.values()) {
      if (w.isPrivate || w.win.isDestroyed()) continue;
      if (!byProfile.has(w.profile)) byProfile.set(w.profile, []);
      byProfile.get(w.profile).push(w.sessionInfo());
    }
    for (const [profile, list] of byProfile) profile.store.saveSession(list);
    return [...byProfile.keys()].map((p) => p.id);
  }

  // Quitting, or Windows shutting down / restarting / signing out (which skips 'before-quit').
  saveEverythingForQuit() {
    if (this.quitting) return;
    const open = this.saveSession();
    if (open.length) this.profiles.setOpenAtQuit(open);
    this.quitting = true;
    for (const p of this.profiles.loaded.values()) p.store.flush();
  }

  async restoreOrOpen() {
    for (const id of this.profiles.startupIds()) await this.openProfile(id);
  }

  openUrls(urls) {
    const w = this.currentWindow();
    if (!w) {
      this.newWindow({ urls });
      return;
    }
    urls.forEach((u) => w.createTab(u));
    if (w.win.isMinimized()) w.win.restore();
    w.win.focus();
  }

  // ---- profiles menu (avatar button) ----
  showProfileMenu(w, anchor) {
    const others = this.profiles.list().filter((p) => p.id !== w.profile.id);
    const template = [
      { label: w.profile.meta.name.replace(/&/g, '&&'), enabled: false },
      { label: 'Edit Profile…', click: () => w.createTab(`brisk://profiles#${w.profile.id}`) },
      { type: 'separator' },
      ...(others.length ? others.map((p) => ({ label: `Open ${p.name.replace(/&/g, '&&')}`, click: () => this.openProfile(p.id) })) : []),
      ...(others.length ? [{ type: 'separator' }] : []),
      {
        label: 'Add Profile…',
        click: async () => {
          const meta = this.profiles.create();
          const nw = await this.openProfile(meta.id);
          nw.createTab(`brisk://profiles#${meta.id}`);
        },
      },
      { label: 'Manage Profiles', click: () => w.createTab('brisk://profiles') },
    ];
    const opts = { window: w.win };
    if (anchor && typeof anchor.x === 'number') Object.assign(opts, { x: Math.round(anchor.x), y: Math.round(anchor.y) });
    Menu.buildFromTemplate(template).popup(opts);
  }

  // ---- downloads ----
  trackDownload(item, wc) {
    const dir = app.getPath('downloads');
    const base = item.getFilename() || 'download';
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    let target = path.join(dir, base);
    for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${stem} (${i})${ext}`);
    item.setSavePath(target);

    const rec = { id: Date.now() + Math.random(), name: path.basename(target), path: target, state: 'progressing', received: 0, total: item.getTotalBytes() };
    this.downloads.unshift(rec);
    this.downloads = this.downloads.slice(0, 20);
    const push = () => {
      const w = this.windowForContents(wc) || this.currentWindow();
      if (w && !w.ui.webContents.isDestroyed()) w.ui.webContents.send('downloads', this.downloads);
    };
    item.on('updated', (_e, state) => {
      rec.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      rec.received = item.getReceivedBytes();
      rec.total = item.getTotalBytes();
      push();
    });
    item.once('done', (_e, state) => {
      rec.state = state; // completed | cancelled | interrupted
      rec.received = item.getReceivedBytes();
      push();
      if (IS_MAC && state === 'completed') app.dock.downloadFinished(target);
    });
    push();
  }

  showDownloadsMenu(w) {
    const items = this.downloads.length
      ? this.downloads.map((d) => ({
          label: `${d.name}${d.state === 'progressing' ? ` — ${d.total ? Math.round((d.received / d.total) * 100) + '%' : 'downloading'}` : d.state === 'completed' ? '' : ` — ${d.state}`}`,
          enabled: d.state === 'completed',
          click: () => shell.showItemInFolder(d.path),
        }))
      : [{ label: 'No downloads yet', enabled: false }];
    items.push(
      { type: 'separator' },
      { label: 'Open Downloads Folder', click: () => shell.openPath(app.getPath('downloads')) },
      {
        label: 'Clear List',
        click: () => {
          this.downloads = this.downloads.filter((d) => d.state === 'progressing');
          w.ui.webContents.send('downloads', this.downloads);
        },
      }
    );
    Menu.buildFromTemplate(items).popup({ window: w.win });
  }

  // ---- menus ----
  mainMenu(w) {
    const syncState = w.profile.sync.publicState();
    return Menu.buildFromTemplate([
      { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => w.createTab() },
      { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => this.newWindow({ profile: w.profile }) },
      { label: 'New Private Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => this.newWindow({ isPrivate: true, profile: w.profile }) },
      { type: 'separator' },
      { label: 'Bookmarks', click: () => w.createTab('brisk://bookmarks') },
      { label: 'Extensions', enabled: !w.isPrivate, click: () => w.createTab('brisk://extensions') },
      { label: 'Profiles', click: () => w.createTab('brisk://profiles') },
      { label: 'Downloads', click: () => this.showDownloadsMenu(w) },
      { type: 'separator' },
      { label: 'Zoom In', click: () => w.zoom(1) },
      { label: 'Zoom Out', click: () => w.zoom(-1) },
      { label: 'Actual Size', click: () => w.zoom(0) },
      { type: 'separator' },
      { label: 'Find in Page…', click: () => w.ui.webContents.send('find:open') },
      { label: 'Print…', click: () => w.active && w.active.wc.print() },
      { type: 'separator' },
      {
        label: syncState.connected
          ? `Sync: ${syncState.state === 'error' ? 'needs attention' : syncState.email || 'on'}`
          : 'Sync: off',
        click: () => w.createTab('brisk://settings#sync'),
      },
      { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => w.createTab('brisk://settings') },
      ...(this.updater.menuItem() ? [{ type: 'separator' }, this.updater.menuItem()] : []),
    ]);
  }

  buildAppMenu() {
    const cur = () => this.currentWindow();
    const call = (fn) => () => {
      const w = cur();
      if (w) fn(w);
      else this.newWindow();
    };
    const focusedWc = () => require('electron').webContents.getFocusedWebContents();
    const edit = (method) => () => {
      const wc = focusedWc();
      if (wc) wc[method]();
    };

    const tabNumbers = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
      label: n === 9 ? 'Last Tab' : `Tab ${n}`,
      accelerator: `CmdOrCtrl+${n}`,
      click: call((w) => w.selectTabNumber(n)),
    }));

    const template = [
      ...(IS_MAC
        ? [
            {
              label: 'Brisk',
              submenu: [
                { role: 'about' },
                { type: 'separator' },
                { label: 'Settings…', accelerator: 'Cmd+,', click: call((w) => w.createTab('brisk://settings')) },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
              ],
            },
          ]
        : []),
      {
        label: 'File',
        submenu: [
          { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: call((w) => w.createTab()) },
          { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => this.newWindow() },
          { label: 'New Private Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => this.newWindow({ isPrivate: true }) },
          { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: call((w) => w.reopenClosedTab()) },
          { label: 'Open Location…', accelerator: 'CmdOrCtrl+L', click: call((w) => w.focusOmnibox()) },
          { label: 'Open Location', accelerator: 'Alt+D', visible: false, acceleratorWorksWhenHidden: true, click: call((w) => w.focusOmnibox()) },
          { type: 'separator' },
          { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: call((w) => w.closeTab(w.activeId)) },
          { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', click: call((w) => w.win.close()) },
          { type: 'separator' },
          { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: call((w) => w.active && w.active.wc.print()) },
          ...(IS_MAC ? [] : [{ type: 'separator' }, { label: 'Settings', click: call((w) => w.createTab('brisk://settings')) }, { role: 'quit', label: 'Exit' }]),
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: edit('undo') },
          { label: 'Redo', accelerator: IS_MAC ? 'Cmd+Shift+Z' : 'Ctrl+Y', click: edit('redo') },
          { type: 'separator' },
          { label: 'Cut', accelerator: 'CmdOrCtrl+X', click: edit('cut') },
          { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: edit('copy') },
          { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: edit('paste') },
          { label: 'Paste and Match Style', accelerator: 'CmdOrCtrl+Shift+V', click: edit('pasteAndMatchStyle') },
          { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: edit('selectAll') },
          { type: 'separator' },
          { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: call((w) => w.ui.webContents.send('find:open')) },
          { label: 'Find Next', accelerator: IS_MAC ? 'Cmd+G' : 'F3', click: call((w) => w.ui.webContents.send('find:next', true)) },
          { label: 'Find Previous', accelerator: IS_MAC ? 'Cmd+Shift+G' : 'Shift+F3', click: call((w) => w.ui.webContents.send('find:next', false)) },
        ],
      },
      {
        label: 'View',
        submenu: [
          { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: call((w) => w.reload()) },
          { label: 'Reload', accelerator: 'F5', visible: false, acceleratorWorksWhenHidden: true, click: call((w) => w.reload()) },
          { label: 'Hard Reload', accelerator: 'CmdOrCtrl+Shift+R', click: call((w) => w.reload(true)) },
          { label: 'Stop', accelerator: 'Escape', visible: false, acceleratorWorksWhenHidden: true, click: call((w) => w.stop()) },
          { type: 'separator' },
          { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: call((w) => w.zoom(1)) },
          { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', visible: false, acceleratorWorksWhenHidden: true, click: call((w) => w.zoom(1)) },
          { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: call((w) => w.zoom(-1)) },
          { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: call((w) => w.zoom(0)) },
          { type: 'separator' },
          {
            label: 'Show Bookmarks Bar',
            accelerator: 'CmdOrCtrl+Shift+B',
            click: () => {
              const store = this.currentProfile().store;
              store.setSetting('showBookmarksBar', !store.get('showBookmarksBar'));
            },
          },
          { label: 'Toggle Full Screen', accelerator: IS_MAC ? 'Ctrl+Cmd+F' : 'F11', click: call((w) => w.win.setFullScreen(!w.win.isFullScreen())) },
          { type: 'separator' },
          { label: 'Developer Tools', accelerator: IS_MAC ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', click: call((w) => w.toggleDevTools()) },
          { label: 'Developer Tools', accelerator: 'F12', visible: false, acceleratorWorksWhenHidden: true, click: call((w) => w.toggleDevTools()) },
        ],
      },
      {
        label: 'History',
        submenu: [
          { label: 'Back', accelerator: IS_MAC ? 'Cmd+[' : 'Alt+Left', click: call((w) => w.goBack()) },
          { label: 'Forward', accelerator: IS_MAC ? 'Cmd+]' : 'Alt+Right', click: call((w) => w.goForward()) },
          { label: 'Home', accelerator: IS_MAC ? 'Cmd+Shift+H' : 'Alt+Home', click: call((w) => w.goHome()) },
        ],
      },
      {
        label: 'Bookmarks',
        submenu: [
          { label: 'Bookmark This Page', accelerator: 'CmdOrCtrl+D', click: call((w) => w.toggleBookmark()) },
          { label: 'Bookmark Manager', accelerator: IS_MAC ? 'Alt+Cmd+B' : 'Ctrl+Shift+O', click: call((w) => w.createTab('brisk://bookmarks')) },
        ],
      },
      {
        label: 'Tab',
        submenu: [
          { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: call((w) => w.cycleTab(1)) },
          { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: call((w) => w.cycleTab(-1)) },
          ...(IS_MAC
            ? [
                { label: 'Next Tab', accelerator: 'Alt+Cmd+Right', visible: false, acceleratorWorksWhenHidden: true, click: call((w) => w.cycleTab(1)) },
                { label: 'Previous Tab', accelerator: 'Alt+Cmd+Left', visible: false, acceleratorWorksWhenHidden: true, click: call((w) => w.cycleTab(-1)) },
              ]
            : []),
          { label: 'Mute Tab', click: call((w) => w.toggleMute()) },
          { type: 'separator' },
          ...tabNumbers,
        ],
      },
      ...(IS_MAC ? [{ role: 'windowMenu' }] : []),
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }
}

// Profile pictures: re-encode whatever the page sent as a small PNG (or clear it).
function cleanAvatar(dataUrl) {
  if (!dataUrl) return '';
  if (!/^data:image\/(png|jpeg);base64,/.test(dataUrl) || dataUrl.length > 3_000_000) return '';
  const img = nativeImage.createFromDataURL(dataUrl);
  if (img.isEmpty()) return '';
  return img.resize({ width: 128, height: 128, quality: 'best' }).toDataURL();
}

// ------------------------------------------------------------------- IPC wiring
function registerIpc(brisk) {

  // From the toolbar UI. The sender must be one of our toolbar views.
  const ui = (channel, fn) =>
    ipcMain.handle(channel, (event, ...args) => {
      const w = [...brisk.windows.values()].find((x) => x.ui.webContents === event.sender);
      if (!w) return undefined;
      return fn(w, ...args);
    });

  ui('ui:height', (w, h) => w.setChromeHeight(h));
  ui('ui:overlay', (w, on) => w.setOverlay(on));
  ui('tab:new', (w, url) => w.createTab(url || NEW_TAB));
  ui('tab:close', (w, id) => w.closeTab(id));
  ui('tab:activate', (w, id) => w.activate(id));
  ui('tab:move', (w, id, idx) => w.moveTab(id, idx));
  ui('tab:mute', (w, id) => w.toggleMute(id));
  ui('nav:go', (w, input) => w.navigate(input));
  ui('nav:back', (w) => w.goBack());
  ui('nav:forward', (w) => w.goForward());
  ui('nav:reload', (w, hard) => w.reload(!!hard));
  ui('nav:stop', (w) => w.stop());
  ui('nav:home', (w) => w.goHome());
  ui('nav:focusPage', (w) => w.active && w.active.wc.focus());
  ui('bookmark:toggle', (w, anchor) => w.toggleBookmark(anchor));
  ui('bookmark:folder', (w, id, anchor) => w.showBookmarkFolder(String(id), anchor));
  ui('bookmark:overflow', (w, ids, anchor) => w.showBookmarkOverflow(Array.isArray(ids) ? ids.map(String) : [], anchor));
  ui('menu:profile', (w, anchor) => brisk.showProfileMenu(w, anchor));
  ui('bookmark:open', (w, url, newTab) => (newTab ? w.createTab(url, { background: true }) : w.navigate(url)));
  ui('suggest', (w, text) => (w.isPrivate ? w.profile.store.suggest(text).filter((s) => s.type === 'bookmark') : w.profile.store.suggest(text)));
  ui('find:query', (w, text, opts) => w.find(text, opts || {}));
  ui('find:stop', (w) => w.stopFind());
  ui('menu:main', (w) => w.showMainMenu());
  ui('menu:shields', (w) => w.showShieldsMenu());
  ui('menu:tab', (w, id) => w.showTabMenu(id));
  ui('menu:bookmark', (w, id) => w.showBookmarkMenu(id));
  ui('menu:downloads', (w) => brisk.showDownloadsMenu(w));

  // From internal brisk:// pages only.
  const page = (channel, fn) =>
    ipcMain.handle(channel, (event, ...args) => {
      const url = (event.senderFrame && event.senderFrame.url) || '';
      if (!url.startsWith('brisk://')) throw new Error('Not allowed');
      return fn(event, ...args);
    });

  const profileFor = (event) => {
    const w = brisk.windowForContents(event.sender);
    return w ? w.profile : brisk.currentProfile();
  };

  page('pages:state', (event) => {
    const w = brisk.windowForContents(event.sender);
    const P = profileFor(event);
    return {
      settings: P.store.getSettings(),
      engines: Object.fromEntries(Object.entries(SEARCH_ENGINES).map(([k, v]) => [k, v.name])),
      sync: P.sync.publicState(),
      bookmarks: P.store.bookmarkChildren('bar').filter((b) => b.type === 'bookmark'),
      shieldsOff: Object.entries(P.store.data.shields)
        .filter(([, r]) => r.off)
        .map(([host]) => host),
      blockedTotal: brisk.shields.totalBlocked,
      version: app.getVersion(),
      platform: process.platform,
      isPrivate: !!(w && w.isPrivate),
      profile: P.publicInfo(),
      colors: COLORS,
    };
  });
  page('pages:setSetting', (e, key, value) => profileFor(e).store.setSetting(key, value));

  // ---- bookmarks ----
  page('pages:bookmarks', (e) => {
    const store = profileFor(e).store;
    const placed = require('./bookmarks').effectiveParents(store.data.bookmarks);
    const items = store.data.bookmarks
      .filter((b) => !b.deleted)
      .map((b) => ({ id: b.id, type: b.type, title: b.title, url: b.url, parentId: placed.get(b.id) || b.parentId, order: b.order }));
    return { items, folders: store.bookmarkFolders(), bar: store.bookmarkTree('bar'), other: store.bookmarkTree('other') };
  });
  page('pages:bookmarkAdd', (e, title, url, parentId) => profileFor(e).store.addBookmarkTo({ title, url, parentId }));
  page('pages:bookmarkAddFolder', (e, title, parentId) => profileFor(e).store.addFolder({ title, parentId }));
  page('pages:bookmarkImport', (e, tree) => profileFor(e).store.importBookmarks(tree && typeof tree === 'object' ? tree : {}));
  page('pages:bookmarkExport', (e) => profileFor(e).store.exportBookmarksHtml());
  page('pages:bookmarkUpdate', (e, id, fields) => profileFor(e).store.updateBookmark(id, fields || {}));
  page('pages:bookmarkMove', (e, id, parentId, position) => profileFor(e).store.moveBookmark(id, parentId, position));
  page('pages:bookmarkRemove', (e, id) => profileFor(e).store.removeBookmark(id));

  page('pages:shieldsOn', (e, host) => profileFor(e).store.setShieldsOff(host, false));
  page('pages:syncSetClient', (e, id, secret) => profileFor(e).sync.setClient(id, secret));
  page('pages:syncConnect', async (e) => {
    try {
      await profileFor(e).sync.connect();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  page('pages:syncDisconnect', (e) => profileFor(e).sync.disconnect());
  page('pages:syncNow', (e) => profileFor(e).sync.syncNow());
  page('pages:clearData', async (e, what) => {
    const P = profileFor(e);
    if (what.history) P.store.clearHistory();
    if (what.cache) await P.session.clearCache();
    if (what.cookies) await P.session.clearStorageData();
    return true;
  });
  page('pages:extensions', (e) => profileFor(e).extensions.list());
  page('pages:extensionRemove', async (e, id) => {
    if (!/^[a-p]{32}$/.test(String(id))) throw new Error('Bad extension id');
    const P = profileFor(e);
    await P.extensions.uninstall(id);
    return P.extensions.list();
  });
  page('pages:openTab', (event, url) => {
    if (!/^(https:\/\/|chrome-extension:\/\/)/.test(url)) return;
    const w = brisk.windowForContents(event.sender) || brisk.currentWindow();
    if (w) w.createTab(url);
  });

  // ---- profiles ----
  page('pages:profiles', (e) => ({ profiles: brisk.profiles.list(), current: profileFor(e).id, colors: COLORS }));
  page('pages:profileCreate', async () => {
    const meta = brisk.profiles.create();
    const w = await brisk.openProfile(meta.id);
    w.createTab(`brisk://profiles#${meta.id}`);
    return meta.id;
  });
  page('pages:profileUpdate', (_e, id, fields) => {
    const clean = {};
    if (fields && typeof fields.name === 'string') clean.name = fields.name;
    if (fields && typeof fields.color === 'string') clean.color = fields.color;
    if (fields && typeof fields.avatar === 'string') clean.avatar = cleanAvatar(fields.avatar);
    return brisk.profiles.update(String(id), clean);
  });
  page('pages:profileOpen', (_e, id) => brisk.openProfile(String(id)).then(() => true));
  page('pages:profileRemove', async (_e, id) => {
    await brisk.profiles.remove(String(id));
    return brisk.profiles.list();
  });
  page('pages:openExternal', (_e, url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });
}

// ------------------------------------------------------------------- lifecycle
const pendingUrls = process.argv.slice(1).filter((a) => /^https?:\/\//.test(a));
let brisk = null;

app.on('open-url', (event, url) => {
  event.preventDefault();
  if (brisk) brisk.openUrls([url]);
  else pendingUrls.push(url);
});

// Popups that aren't Brisk tabs (extension popups, sign-in windows): open their links as tabs.
app.on('web-contents-created', (_e, wc) => {
  if (wc.getType() !== 'window') return;
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (!brisk || !wc.getURL().startsWith('chrome-extension://')) return { action: 'allow' };
    const w = brisk.currentWindow();
    if (w && !url.startsWith('brisk://')) w.createTab(url, { background: disposition === 'background-tab' });
    return { action: 'deny' };
  });
});

app.on('second-instance', (_e, argv) => {
  if (!brisk) return;
  const urls = argv.filter((a) => /^https?:\/\//.test(a));
  if (urls.length) brisk.openUrls(urls);
  else {
    const w = brisk.currentWindow();
    if (w) {
      if (w.win.isMinimized()) w.win.restore();
      w.win.focus();
    } else brisk.newWindow();
  }
});

app.whenReady().then(async () => {
  brisk = new BriskApp();
  global.__brisk = brisk; // handy for debugging from DevTools / smoke tests
  registerIpc(brisk);
  brisk.buildAppMenu();
  // Each profile loads its extensions before its tabs open, so their content scripts apply.
  await brisk.restoreOrOpen();
  brisk.updater.start();
  if (pendingUrls.length) brisk.openUrls(pendingUrls.splice(0));

  app.on('activate', () => {
    if (brisk.windows.size === 0) brisk.restoreOrOpen();
  });
});

app.on('before-quit', () => {
  if (brisk) brisk.saveEverythingForQuit();
});

app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});
