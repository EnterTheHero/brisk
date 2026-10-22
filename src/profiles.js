// Profiles: separate people/uses in one browser. Each profile has its own
// cookies and sign-ins, bookmarks, settings, history, extensions and Google
// sync account, plus a name, color and picture.
//
// A profile is only loaded (session, extensions, sync) when one of its windows
// is opened, so profiles you aren't using cost nothing.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { app, session } = require('electron');
const { Store } = require('./store');
const { Sync } = require('./sync');

const COLORS = ['#e8572a', '#3b6fe0', '#0f9d8a', '#3a9d4a', '#7c4ddb', '#d6457c', '#d99a1b', '#5b6270'];
const DEFAULT_ID = 'default';

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

class Profile extends EventEmitter {
  constructor(brisk, meta) {
    super();
    this.brisk = brisk;
    this.meta = meta;
    this.id = meta.id;
    const root = app.getPath('userData');
    // The first profile keeps using the original locations, so nothing moves for existing data.
    const isDefault = this.id === DEFAULT_ID;
    this.dir = isDefault ? root : path.join(root, 'Profiles', this.id);
    this.partition = isDefault ? 'persist:brisk' : `persist:brisk-${this.id}`;
    this.extensionsPath = isDefault ? undefined : path.join(this.dir, 'Extensions');

    this.store = new Store(this.dir);
    this.sync = new Sync(this.store, this.dir, { isDefault, getName: () => this.meta.name });
    this.session = session.fromPartition(this.partition);
    brisk.setupSession(this.session, this);
    const { Extensions } = require('./extensions');
    this.extensions = new Extensions(brisk, this);
    this.ready = Promise.race([this.extensions.ready, new Promise((r) => setTimeout(r, 5000))]);

    this.store.on('change', (kind) => brisk.onProfileDataChanged(this, kind));
    this.sync.on('status', (s) => brisk.notifyPages('pages:sync', s, this));
    this.sync.start();
  }

  dispose() {
    this.disposed = true;
    this.sync.dispose();
    this.store.dispose();
    this.extensions.dispose();
  }

  publicInfo() {
    return { id: this.id, name: this.meta.name, color: this.meta.color, avatar: this.meta.avatar || '' };
  }
}

class ProfileManager extends EventEmitter {
  constructor(brisk) {
    super();
    this.brisk = brisk;
    this.file = path.join(app.getPath('userData'), 'brisk-profiles.json');
    this.loaded = new Map(); // id -> Profile
    this.state = this._read();
  }

  _read() {
    let state;
    try {
      state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      state = null;
    }
    if (!state || !Array.isArray(state.profiles) || !state.profiles.length) {
      state = { profiles: [{ id: DEFAULT_ID, name: 'Personal', color: COLORS[0], avatar: '' }], lastUsed: DEFAULT_ID, openAtQuit: [] };
    }
    if (!state.profiles.some((p) => p.id === DEFAULT_ID)) state.profiles.unshift({ id: DEFAULT_ID, name: 'Personal', color: COLORS[0], avatar: '' });
    return state;
  }

  save() {
    try {
      atomicWrite(this.file, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error('[profiles] save failed', err.message);
    }
  }

  list() {
    return this.state.profiles.map((p) => ({ id: p.id, name: p.name, color: p.color, avatar: p.avatar || '' }));
  }

  meta(id) {
    return this.state.profiles.find((p) => p.id === id) || null;
  }

  // Loads a profile (creating its session, store, sync and extensions) on first use.
  get(id) {
    const meta = this.meta(id) || this.meta(DEFAULT_ID);
    if (!this.loaded.has(meta.id)) this.loaded.set(meta.id, new Profile(this.brisk, meta));
    return this.loaded.get(meta.id);
  }

  create({ name, color, avatar } = {}) {
    const used = new Set(this.state.profiles.map((p) => p.color));
    const meta = {
      id: crypto.randomBytes(6).toString('hex'),
      name: String(name || `Profile ${this.state.profiles.length + 1}`).slice(0, 40),
      color: color || COLORS.find((c) => !used.has(c)) || COLORS[this.state.profiles.length % COLORS.length],
      avatar: avatar || '',
    };
    this.state.profiles.push(meta);
    this.save();
    this.emit('change');
    return meta;
  }

  update(id, fields) {
    const meta = this.meta(id);
    if (!meta) return null;
    if (typeof fields.name === 'string' && fields.name.trim()) meta.name = fields.name.trim().slice(0, 40);
    if (typeof fields.color === 'string' && /^#[0-9a-f]{6}$/i.test(fields.color)) meta.color = fields.color;
    if (typeof fields.avatar === 'string') meta.avatar = fields.avatar;
    this.save();
    this.emit('change');
    return meta;
  }

  // Removes a profile and its data from this computer. The first profile can't be removed.
  async remove(id) {
    if (id === DEFAULT_ID) throw new Error('The first profile can’t be removed.');
    const meta = this.meta(id);
    if (!meta) return;
    // Forget it first, so it's gone even if closing its windows ends the app (Windows quits on the last window).
    this.state.profiles = this.state.profiles.filter((p) => p.id !== id);
    if (this.state.lastUsed === id) this.state.lastUsed = DEFAULT_ID;
    this.state.openAtQuit = (this.state.openAtQuit || []).filter((x) => x !== id);
    this.save();
    this.emit('change');

    const loaded = this.loaded.get(id);
    this.loaded.delete(id);
    if (loaded) {
      const windows = [...this.brisk.windows.values()].filter((w) => w.profile === loaded);
      // Don't let closing them leave no windows at all: open the first profile like Chrome does.
      if (windows.length && [...this.brisk.windows.values()].every((w) => w.profile === loaded)) await this.brisk.openProfile(DEFAULT_ID);
      loaded.dispose();
      for (const w of windows) w.win.close();
    }
    const ses = loaded ? loaded.session : session.fromPartition(`persist:brisk-${id}`);
    await ses.clearStorageData().catch(() => {});
    await ses.clearCache().catch(() => {});
    const root = app.getPath('userData');
    for (const dir of [path.join(root, 'Profiles', id), path.join(root, 'Partitions', `brisk-${id}`)]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* files still in use; removed harmlessly next time or left as leftovers */
      }
    }
  }

  setLastUsed(id) {
    if (this.state.lastUsed !== id) {
      this.state.lastUsed = id;
      this.save();
    }
  }

  setOpenAtQuit(ids) {
    this.state.openAtQuit = ids;
    this.save();
  }

  startupIds() {
    const valid = (id) => this.state.profiles.some((p) => p.id === id);
    const open = (this.state.openAtQuit || []).filter(valid);
    return open.length ? open : [valid(this.state.lastUsed) ? this.state.lastUsed : DEFAULT_ID];
  }
}

module.exports = { ProfileManager, Profile, COLORS, DEFAULT_ID };
