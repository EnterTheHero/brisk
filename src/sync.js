// Google Drive sync for bookmarks, settings and per-site shield choices.
//
// Data is stored as one JSON file in your Drive's hidden "app data" folder,
// which only this app can see (it does not show up in your normal Drive files).
// Sign-in happens in your regular web browser using Google's recommended
// desktop flow (loopback redirect + PKCE). The refresh token is encrypted with
// the operating system's keychain (macOS Keychain / Windows DPAPI).

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { app, shell, safeStorage } = require('electron');
const { merge, normalize } = require('./merge');

const SCOPES = ['https://www.googleapis.com/auth/drive.appdata', 'openid', 'email'];
const SYNC_FILE = 'brisk-sync.json';
const AUTO_SYNC_MS = 5 * 60 * 1000;
const CHANGE_DEBOUNCE_MS = 5000;

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function decodeJwtEmail(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8'));
    return payload.email || '';
  } catch {
    return '';
  }
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

function stableString(data) {
  const d = normalize(data);
  return JSON.stringify(sortKeys({
    bookmarks: [...d.bookmarks].sort((a, b) => (a.id < b.id ? -1 : 1)),
    settings: d.settings,
    shields: d.shields,
  }));
}

class Sync extends EventEmitter {
  // opts.isDefault: the first profile (keeps the original file name)
  // opts.getName(): the profile's name, used to pair the same profile across computers
  constructor(store, dir = app.getPath('userData'), opts = {}) {
    super();
    this.store = store;
    this.opts = opts;
    this.authFile = path.join(dir, 'brisk-auth.json'); // this profile's Google sign-in
    // The OAuth client (ID/secret) is shared by all profiles so it only has to be entered once.
    this.clientFile = path.join(app.getPath('userData'), 'brisk-oauth-client.json');
    this.auth = this._loadAuth();
    if (!this.auth.clientId) {
      try {
        const shared = JSON.parse(fs.readFileSync(this.clientFile, 'utf8'));
        this.auth.clientId = shared.clientId || '';
        this.auth.clientSecret = shared.clientSecret || '';
      } catch {
        /* none saved yet */
      }
    }
    this.accessToken = null;
    this.accessTokenExpires = 0;
    this.fileId = null;
    this.status = { state: 'idle', lastSync: null, error: null };
    this._running = null;
    this._pending = false;
    this._applying = false;
    this._timer = null;
    this._debounce = null;

    store.on('change', () => {
      if (this._applying || !this.isConnected()) return;
      clearTimeout(this._debounce);
      this._debounce = setTimeout(() => this.syncNow(), CHANGE_DEBOUNCE_MS);
    });
  }

  // ---- credentials on disk ----
  _loadAuth() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.authFile, 'utf8'));
      if (raw.refreshTokenEnc) {
        raw.refreshToken = safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(Buffer.from(raw.refreshTokenEnc, 'base64'))
          : null;
      }
      return raw;
    } catch {
      return {};
    }
  }

  _saveAuth() {
    const out = { clientId: this.auth.clientId || '', clientSecret: this.auth.clientSecret || '', email: this.auth.email || '', syncKey: this.auth.syncKey || '' };
    if (this.auth.refreshToken) {
      if (safeStorage.isEncryptionAvailable()) {
        out.refreshTokenEnc = safeStorage.encryptString(this.auth.refreshToken).toString('base64');
      } else {
        // Refuse to write the token in plain text; you'd need to sign in again next launch.
        console.warn('[sync] OS encryption unavailable; refresh token kept in memory only');
      }
    }
    fs.writeFileSync(this.authFile, JSON.stringify(out, null, 2), { mode: 0o600 });
  }

  // Each profile syncs to its own file, so two profiles on one Google account stay separate.
  // Profiles with the same name on different computers share a file. The name is fixed
  // when sync is first connected, so renaming a profile later doesn't split it.
  fileName() {
    if (this.opts.isDefault) return SYNC_FILE;
    if (!this.auth.syncKey) {
      const slug = String((this.opts.getName && this.opts.getName()) || 'profile')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40);
      this.auth.syncKey = slug || 'profile';
    }
    return `brisk-sync-${this.auth.syncKey}.json`;
  }

  isConnected() {
    return !!(this.auth.clientId && this.auth.refreshToken);
  }

  publicState() {
    return {
      connected: this.isConnected(),
      email: this.auth.email || '',
      hasClient: !!this.auth.clientId,
      clientId: this.auth.clientId || '',
      ...this.status,
    };
  }

  _setStatus(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.publicState());
  }

  setClient(clientId, clientSecret) {
    this.auth.clientId = String(clientId || '').trim();
    this.auth.clientSecret = String(clientSecret || '').trim();
    this._saveAuth();
    try {
      fs.writeFileSync(this.clientFile, JSON.stringify({ clientId: this.auth.clientId, clientSecret: this.auth.clientSecret }), { mode: 0o600 });
    } catch {
      /* not critical */
    }
    this.emit('status', this.publicState());
  }

  // ---- sign in ----
  async connect() {
    if (!this.auth.clientId) throw new Error('Add your Google OAuth client ID first.');
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));

    const { code, redirectUri } = await new Promise((resolve, reject) => {
      let port = 0;
      const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          `<html><body style="font-family:system-ui;padding:48px;text-align:center">` +
            `<h2>${ok ? 'Brisk is connected to Google Drive.' : 'Sign-in did not complete.'}</h2>` +
            `<p>You can close this tab and go back to Brisk.</p></body></html>`
        );
        clearTimeout(timeout);
        server.close();
        if (ok) resolve({ code: u.searchParams.get('code'), redirectUri: `http://127.0.0.1:${port}/callback` });
        else reject(new Error(u.searchParams.get('error') || 'Sign-in was cancelled.'));
      });
      const timeout = setTimeout(() => {
        server.close();
        reject(new Error('Sign-in timed out.'));
      }, 5 * 60 * 1000);
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        const params = new URLSearchParams({
          client_id: this.auth.clientId,
          redirect_uri: `http://127.0.0.1:${port}/callback`,
          response_type: 'code',
          scope: SCOPES.join(' '),
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
          access_type: 'offline',
          prompt: 'consent',
        });
        shell.openExternal(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
      });
    });

    const tokens = await this._tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });
    if (!tokens.refresh_token) throw new Error('Google did not return a refresh token. Try again.');
    this.auth.refreshToken = tokens.refresh_token;
    this.auth.email = decodeJwtEmail(tokens.id_token || '');
    this.fileName(); // fix this profile's sync file name now, before saving
    this._useAccessToken(tokens);
    this._saveAuth();
    this.fileId = null;
    this._setStatus({ error: null });
    this.start();
    return this.syncNow();
  }

  async disconnect() {
    const token = this.auth.refreshToken;
    this.auth.refreshToken = null;
    this.auth.email = '';
    this.accessToken = null;
    this.fileId = null;
    this._saveAuth();
    clearInterval(this._timer);
    this._setStatus({ state: 'idle', lastSync: null, error: null });
    if (token) {
      fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => {});
    }
  }

  async _tokenRequest(fields) {
    const body = new URLSearchParams({ client_id: this.auth.clientId, ...fields });
    if (this.auth.clientSecret) body.set('client_secret', this.auth.clientSecret);
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error_description || json.error || `Token request failed (${res.status})`);
    return json;
  }

  _useAccessToken(tokens) {
    this.accessToken = tokens.access_token;
    this.accessTokenExpires = Date.now() + (tokens.expires_in || 3600) * 1000 - 60_000;
  }

  async _token() {
    if (this.accessToken && Date.now() < this.accessTokenExpires) return this.accessToken;
    try {
      this._useAccessToken(await this._tokenRequest({ grant_type: 'refresh_token', refresh_token: this.auth.refreshToken }));
    } catch (err) {
      if (/invalid_grant/i.test(err.message)) {
        // Token was revoked or expired (e.g. a "Testing" OAuth app expires tokens after 7 days).
        this.auth.refreshToken = null;
        this._saveAuth();
        throw new Error('Google sign-in expired. Reconnect in Settings.');
      }
      throw err;
    }
    return this.accessToken;
  }

  async _drive(url, opts = {}) {
    const token = await this._token();
    const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Drive error ${res.status}: ${text.slice(0, 200)}`);
    }
    return res;
  }

  // ---- Drive file helpers ----
  async _findFile() {
    if (this.fileId) return this.fileId;
    const q = encodeURIComponent(`name='${this.fileName()}' and trashed=false`);
    const res = await this._drive(
      `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)&orderBy=modifiedTime desc`
    );
    const { files } = await res.json();
    this.fileId = files && files[0] ? files[0].id : null;
    return this.fileId;
  }

  async _download(id) {
    const res = await this._drive(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
    try {
      return JSON.parse(await res.text());
    } catch {
      return {};
    }
  }

  async _upload(data) {
    const body = JSON.stringify({ app: 'brisk', version: 1, savedAt: new Date().toISOString(), ...data });
    if (this.fileId) {
      await this._drive(`https://www.googleapis.com/upload/drive/v3/files/${this.fileId}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      return;
    }
    const boundary = `brisk${crypto.randomBytes(8).toString('hex')}`;
    const meta = JSON.stringify({ name: this.fileName(), parents: ['appDataFolder'], mimeType: 'application/json' });
    const multipart =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
    const res = await this._drive('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipart,
    });
    this.fileId = (await res.json()).id;
  }

  // ---- the sync itself ----
  start() {
    clearInterval(this._timer);
    if (!this.isConnected()) return;
    this._timer = setInterval(() => this.syncNow(), AUTO_SYNC_MS);
    this.syncNow();
  }

  syncNow() {
    if (!this.isConnected()) return Promise.resolve(this.publicState());
    if (this._running) {
      this._pending = true;
      return this._running;
    }
    this._running = this._doSync().finally(() => {
      this._running = null;
      if (this._pending) {
        this._pending = false;
        this.syncNow();
      }
    });
    return this._running;
  }

  dispose() {
    this.disposed = true;
    clearInterval(this._timer);
    clearTimeout(this._debounce);
    this.removeAllListeners();
  }

  async _doSync() {
    if (this.disposed) return this.publicState();
    this._setStatus({ state: 'syncing', error: null });
    try {
      const id = await this._findFile();
      const remote = id ? normalize(await this._download(id)) : null;
      // Snapshot only now (no awaits until it's applied) so edits made during the download aren't lost.
      const local = this.store.snapshot();
      const merged = merge(local, remote || {});

      if (this.disposed) return this.publicState();
      if (stableString(merged) !== stableString(local)) {
        this._applying = true;
        try {
          this.store.replaceAll(merged);
        } finally {
          this._applying = false;
        }
      }
      if (!remote || stableString(merged) !== stableString(remote)) {
        await this._upload(merged);
      }
      this._setStatus({ state: 'idle', lastSync: Date.now(), error: null });
    } catch (err) {
      console.error('[sync]', err.message);
      if (/Drive error 404/.test(err.message)) this.fileId = null;
      this._setStatus({ state: 'error', error: err.message });
    }
    return this.publicState();
  }
}

module.exports = { Sync };
