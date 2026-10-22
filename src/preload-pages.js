// Loaded in every tab, but only exposes an API on Brisk's own brisk:// pages.
// Regular websites get nothing from this script. The main process also checks
// the sender's URL on every call.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'brisk:') {
  const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
  const on = (ch) => (fn) => {
    const handler = (_e, ...args) => fn(...args);
    ipcRenderer.on(ch, handler);
    return () => ipcRenderer.removeListener(ch, handler);
  };
  contextBridge.exposeInMainWorld('briskPages', {
    state: invoke('pages:state'),
    setSetting: invoke('pages:setSetting'),
    addBookmark: invoke('pages:bookmarkAdd'),
    importBookmarks: invoke('pages:bookmarkImport'),
    bookmarks: invoke('pages:bookmarks'),
    addFolder: invoke('pages:bookmarkAddFolder'),
    moveBookmark: invoke('pages:bookmarkMove'),
    exportBookmarks: invoke('pages:bookmarkExport'),
    profiles: invoke('pages:profiles'),
    createProfile: invoke('pages:profileCreate'),
    updateProfile: invoke('pages:profileUpdate'),
    openProfile: invoke('pages:profileOpen'),
    removeProfile: invoke('pages:profileRemove'),
    updateBookmark: invoke('pages:bookmarkUpdate'),
    removeBookmark: invoke('pages:bookmarkRemove'),
    clearBookmarks: invoke('pages:bookmarkClear'),
    shieldsOn: invoke('pages:shieldsOn'),
    syncSetClient: invoke('pages:syncSetClient'),
    syncConnect: invoke('pages:syncConnect'),
    syncDisconnect: invoke('pages:syncDisconnect'),
    syncNow: invoke('pages:syncNow'),
    clearData: invoke('pages:clearData'),
    extensions: invoke('pages:extensions'),
    removeExtension: invoke('pages:extensionRemove'),
    openTab: invoke('pages:openTab'),
    openExternal: invoke('pages:openExternal'),
    onChanged: on('pages:changed'),
    onSync: on('pages:sync'),
  });
}
