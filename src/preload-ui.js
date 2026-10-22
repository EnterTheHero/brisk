// Bridge for the toolbar UI (tabs, address bar, bookmarks bar).
const { contextBridge, ipcRenderer } = require('electron');
const { injectBrowserAction } = require('electron-chrome-extensions/browser-action');

// Adds the <browser-action-list> element that shows installed extensions' toolbar buttons.
injectBrowserAction();

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch) => (fn) => {
  const handler = (_e, ...args) => fn(...args);
  ipcRenderer.on(ch, handler);
  return () => ipcRenderer.removeListener(ch, handler);
};

contextBridge.exposeInMainWorld('brisk', {
  setHeight: invoke('ui:height'),
  setOverlay: invoke('ui:overlay'),
  newTab: invoke('tab:new'),
  closeTab: invoke('tab:close'),
  activateTab: invoke('tab:activate'),
  moveTab: invoke('tab:move'),
  muteTab: invoke('tab:mute'),
  go: invoke('nav:go'),
  back: invoke('nav:back'),
  forward: invoke('nav:forward'),
  reload: invoke('nav:reload'),
  stop: invoke('nav:stop'),
  home: invoke('nav:home'),
  focusPage: invoke('nav:focusPage'),
  toggleBookmark: invoke('bookmark:toggle'),
  openBookmark: invoke('bookmark:open'),
  suggest: invoke('suggest'),
  find: invoke('find:query'),
  stopFind: invoke('find:stop'),
  mainMenu: invoke('menu:main'),
  shieldsMenu: invoke('menu:shields'),
  tabMenu: invoke('menu:tab'),
  bookmarkMenu: invoke('menu:bookmark'),
  bookmarkFolder: invoke('bookmark:folder'),
  bookmarkOverflow: invoke('bookmark:overflow'),
  profileMenu: invoke('menu:profile'),
  downloadsMenu: invoke('menu:downloads'),
  onState: on('state'),
  onDownloads: on('downloads'),
  onFocusOmnibox: on('focus-omnibox'),
  onFindOpen: on('find:open'),
  onFindNext: on('find:next'),
  onFindClose: on('find:close'),
  onFindResult: on('find:result'),
});
