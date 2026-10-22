// Adds chrome.alarms and chrome.idle to extensions (Electron doesn't provide them).
// Runs in extension service workers and extension pages; the real timers live in
// the main process (ext-polyfill.js) so alarms survive the worker being shut down.
const { contextBridge, ipcRenderer } = require('electron');

const isExtension = process.type === 'service-worker' || (typeof location !== 'undefined' && location.protocol === 'chrome-extension:');

if (isExtension) {
  // Only plain data crosses into the extension's world (functions can't be passed in service workers).
  const bridge = {
    call: (method, ...args) => ipcRenderer.invoke('brisk-ext-api', method, ...args),
  };
  ipcRenderer.on('brisk-ext-event', (_e, kind, payload) => {
    try {
      contextBridge.executeInMainWorld({
        func: (k, p) => globalThis.__briskExtDispatch && globalThis.__briskExtDispatch(k, p),
        args: [kind, payload],
      });
    } catch (err) {
      console.error('[brisk] event dispatch failed', err);
    }
  });

  function mainWorld() {
    const b = globalThis.__briskExt;
    if (typeof chrome !== 'object' || !b) return;
    const handlers = { alarm: new Set(), idle: new Set() };
    Object.defineProperty(globalThis, '__briskExtDispatch', {
      value: (kind, payload) => {
        for (const fn of handlers[kind] || []) {
          try {
            fn(payload);
          } catch (err) {
            console.error(err);
          }
        }
      },
    });
    const event = (kind) => {
      const fns = handlers[kind];
      return {
        addListener: (fn) => {
          if (!fns.size && kind === 'idle') b.call('idle.listen');
          fns.add(fn);
        },
        removeListener: (fn) => fns.delete(fn),
        hasListener: (fn) => fns.has(fn),
        hasListeners: () => fns.size > 0,
      };
    };
    // Support both promise and callback styles, like Chrome.
    const api = (method) => (...args) => {
      const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      const p = b.call(method, ...args);
      if (cb) p.then((r) => cb(r), () => cb());
      return p;
    };
    if (!chrome.alarms) {
      Object.defineProperty(chrome, 'alarms', {
        value: {
          create: (name, info) => {
            if (typeof name === 'object') [name, info] = ['', name];
            return api('alarms.create')(name || '', info || {});
          },
          get: api('alarms.get'),
          getAll: api('alarms.getAll'),
          clear: api('alarms.clear'),
          clearAll: api('alarms.clearAll'),
          onAlarm: event('alarm'),
        },
        enumerable: true,
        configurable: true,
      });
    }
    if (!chrome.idle) {
      Object.defineProperty(chrome, 'idle', {
        value: {
          queryState: api('idle.queryState'),
          setDetectionInterval: api('idle.setDetectionInterval'),
          getAutoLockDelay: api('idle.getAutoLockDelay'),
          onStateChanged: event('idle'),
          IdleState: { ACTIVE: 'active', IDLE: 'idle', LOCKED: 'locked' },
        },
        enumerable: true,
        configurable: true,
      });
    }
  }

  try {
    contextBridge.exposeInMainWorld('__briskExt', bridge);
    contextBridge.executeInMainWorld({ func: mainWorld });
  } catch (err) {
    console.error('[brisk] extension polyfill failed', err);
  }
}
