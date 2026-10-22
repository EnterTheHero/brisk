// Main-process side of chrome.alarms and chrome.idle for extensions.
// Alarms are saved to disk and fire even if the extension's background worker
// was shut down: we start the worker, then deliver the event.

const fs = require('fs');
const path = require('path');
const { app, ipcMain, powerMonitor } = require('electron');

const MIN_PERIOD_MIN = 0.5; // Chrome's minimum (30 seconds)

const bySession = new Map(); // session -> ExtPolyfill (one per profile)
let frameIpcRegistered = false;

class ExtPolyfill {
  constructor(ses, dir = app.getPath('userData')) {
    this.ses = ses;
    bySession.set(ses, this);
    this.file = path.join(dir, 'brisk-alarms.json');
    this.alarms = this._load(); // { extId: { name: { name, scheduledTime, periodInMinutes } } }
    this.timers = new Map(); // `${extId}\n${name}` -> timeout
    this.idleInterval = new Map(); // extId -> seconds
    this.idleState = new Map(); // extId -> last state
    this.workers = new Set();

    ses.registerPreloadScript({ id: 'brisk-ext-polyfill', type: 'service-worker', filePath: path.join(__dirname, 'ext-polyfill-preload.js') });
    ses.registerPreloadScript({ id: 'brisk-ext-polyfill-frame', type: 'frame', filePath: path.join(__dirname, 'ext-polyfill-preload.js') });

    // Calls from extension service workers.
    ses.serviceWorkers.on('running-status-changed', ({ runningStatus, versionId }) => {
      if (runningStatus !== 'starting') return;
      const worker = ses.serviceWorkers.getWorkerFromVersionID(versionId);
      if (!worker || this.workers.has(worker) || !worker.scope.startsWith('chrome-extension://')) return;
      this.workers.add(worker);
      const extId = new URL(worker.scope).host;
      worker.ipc.handle('brisk-ext-api', (_e, method, ...args) => this.call(extId, method, args));
    });
    // Calls from extension pages (popups, options pages). One handler for all profiles.
    if (!frameIpcRegistered) {
      frameIpcRegistered = true;
      ipcMain.handle('brisk-ext-api', (event, method, ...args) => {
        const url = (event.senderFrame && event.senderFrame.url) || '';
        const target = bySession.get(event.sender.session);
        if (!url.startsWith('chrome-extension://') || !target) throw new Error('Not allowed');
        return target.call(new URL(url).host, method, args);
      });
    }

    for (const [extId, list] of Object.entries(this.alarms)) {
      for (const alarm of Object.values(list)) this._arm(extId, alarm);
    }

    this.idlePoll = setInterval(() => this._checkIdle(), 15_000);
    this._onLock = () => this._checkIdle();
    powerMonitor.on('lock-screen', this._onLock);
    powerMonitor.on('unlock-screen', this._onLock);
  }

  // Stop timers (used when a profile is deleted).
  dispose() {
    clearInterval(this.idlePoll);
    powerMonitor.off('lock-screen', this._onLock);
    powerMonitor.off('unlock-screen', this._onLock);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.idleInterval.clear();
    bySession.delete(this.ses);
  }

  _load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
    } catch {
      return {};
    }
  }

  _save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.alarms));
    } catch {
      /* not critical */
    }
  }

  call(extId, method, args) {
    switch (method) {
      case 'alarms.create': {
        const [name, info] = args;
        const now = Date.now();
        let period = typeof info.periodInMinutes === 'number' ? Math.max(MIN_PERIOD_MIN, info.periodInMinutes) : undefined;
        let when = typeof info.when === 'number' ? info.when : undefined;
        if (when === undefined) {
          const delay = typeof info.delayInMinutes === 'number' ? info.delayInMinutes : period;
          when = now + Math.max(MIN_PERIOD_MIN, delay || MIN_PERIOD_MIN) * 60_000;
        }
        const alarm = { name: String(name || ''), scheduledTime: when };
        if (period) alarm.periodInMinutes = period;
        (this.alarms[extId] ||= {})[alarm.name] = alarm;
        this._save();
        this._arm(extId, alarm);
        return undefined;
      }
      case 'alarms.get': {
        const [name] = args;
        return (this.alarms[extId] || {})[typeof name === 'string' ? name : ''];
      }
      case 'alarms.getAll':
        return Object.values(this.alarms[extId] || {});
      case 'alarms.clear': {
        const name = typeof args[0] === 'string' ? args[0] : '';
        const had = !!(this.alarms[extId] && this.alarms[extId][name]);
        this._disarm(extId, name);
        if (had) delete this.alarms[extId][name];
        this._save();
        return had;
      }
      case 'alarms.clearAll': {
        for (const name of Object.keys(this.alarms[extId] || {})) this._disarm(extId, name);
        const had = !!Object.keys(this.alarms[extId] || {}).length;
        delete this.alarms[extId];
        this._save();
        return had;
      }
      case 'idle.queryState':
        return powerMonitor.getSystemIdleState(Math.max(15, Number(args[0]) || 60));
      case 'idle.setDetectionInterval':
        this.idleInterval.set(extId, Math.max(15, Number(args[0]) || 60));
        return undefined;
      case 'idle.listen':
        if (!this.idleInterval.has(extId)) this.idleInterval.set(extId, 60);
        return undefined;
      case 'idle.getAutoLockDelay':
        return 0;
      default:
        throw new Error(`Unsupported: ${method}`);
    }
  }

  _key(extId, name) {
    return `${extId}\n${name}`;
  }

  _disarm(extId, name) {
    const k = this._key(extId, name);
    clearTimeout(this.timers.get(k));
    this.timers.delete(k);
  }

  _arm(extId, alarm) {
    this._disarm(extId, alarm.name);
    // setTimeout can't take more than ~24.8 days; re-check periodically for long alarms.
    const delay = Math.min(Math.max(0, alarm.scheduledTime - Date.now()), 2 ** 31 - 1);
    const t = setTimeout(() => {
      if (Date.now() < alarm.scheduledTime - 1000) return this._arm(extId, alarm);
      this._fire(extId, alarm);
    }, delay);
    this.timers.set(this._key(extId, alarm.name), t);
  }

  async _fire(extId, alarm) {
    const current = (this.alarms[extId] || {})[alarm.name];
    if (current !== alarm) return; // replaced or cleared
    const payload = { ...alarm };
    if (alarm.periodInMinutes) {
      alarm.scheduledTime = Date.now() + alarm.periodInMinutes * 60_000;
      this._arm(extId, alarm);
    } else {
      delete this.alarms[extId][alarm.name];
    }
    this._save();
    await this._send(extId, 'alarm', payload, true);
  }

  async _send(extId, kind, payload, wake) {
    const scope = `chrome-extension://${extId}/`;
    const running = Object.entries(this.ses.serviceWorkers.getAllRunning()).find(([, info]) => info.scope === scope);
    let worker = running ? this.ses.serviceWorkers.getWorkerFromVersionID(Number(running[0])) : null;
    if (!worker && wake) {
      try {
        worker = await this.ses.serviceWorkers.startWorkerForScope(scope);
        await new Promise((r) => setTimeout(r, 300)); // let top-level listeners register
      } catch {
        return; // extension removed or has no background worker
      }
    }
    if (worker) worker.send('brisk-ext-event', kind, payload);
  }

  _checkIdle() {
    for (const [extId, seconds] of this.idleInterval) {
      const state = powerMonitor.getSystemIdleState(seconds);
      if (this.idleState.get(extId) !== state) {
        this.idleState.set(extId, state);
        this._send(extId, 'idle', state, true);
      }
    }
  }
}

module.exports = { ExtPolyfill };
