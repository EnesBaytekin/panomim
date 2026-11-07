// API client: access token stays in memory, refresh token lives in an
// HttpOnly cookie. Single-flight silent refresh + one retry on 401.

export class Api {
  constructor() {
    this.token = null;
    this.expiresAt = 0;
    this.user = null;
    this.refreshing = null;
    this.clientId = sessionStorage.getItem('panomim.clientId') || this._rand();
    sessionStorage.setItem('panomim.clientId', this.clientId);
    this.deviceId = localStorage.getItem('panomim.deviceId') || this._rand();
    localStorage.setItem('panomim.deviceId', this.deviceId);
  }

  _rand() {
    return Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
  }

  /** Fetch with auth header; auto-refreshes once on 401. */
  async req(method, path, body, opts = {}) {
    if (!opts.noAuth && (!this.token || Date.now() > this.expiresAt - 60_000)) {
      await this.ensureRefresh();
    }
    const headers = { 'X-Client-Id': this.clientId, ...opts.headers };
    if (!opts.noAuth && this.token) headers['Authorization'] = 'Bearer ' + this.token;
    let payload;
    if (body instanceof FormData) {
      payload = body;
    } else if (opts.raw) {
      // caller-supplied bytes (ArrayBuffer/Blob/string); caller sets Content-Type
      payload = body;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    // FormData is single-use: clone it before sending so a 401 refresh + retry
    // can resend the same file (re-sending a consumed FormData sends an empty
    // body and the server rejects it as "missing file").
    let formClone = null;
    if (body instanceof FormData) {
      formClone = new FormData();
      for (const [k, v] of body.entries()) formClone.append(k, v);
    }
    let res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
    if (res.status === 401 && !opts.noAuth && !opts._retried) {
      const ok = await this.ensureRefresh(true);
      if (ok) return this.req(method, path, formClone ?? body, { ...opts, _retried: true, headers: { ...opts.headers } });
    }
    if (!res.ok) {
      let msg = res.statusText;
      let data = null;
      try { data = await res.json(); msg = data.error || msg; } catch {}
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    if (res.status === 204) return null;
    if (opts.blob) return res.blob();
    return res.json();
  }

  get(path, opts) { return this.req('GET', path, undefined, opts); }
  post(path, body, opts) { return this.req('POST', path, body, opts); }
  patch(path, body, opts) { return this.req('PATCH', path, body, opts); }
  put(path, body, opts) { return this.req('PUT', path, body, opts); }
  del(path, opts) { return this.req('DELETE', path, undefined, opts); }

  /** Single-flight refresh; resolves true when a session is alive. */
  ensureRefresh(force = false) {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this._doRefresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async _doRefresh() {
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Device-Id': this.deviceId },
      });
      if (!res.ok) { this.token = null; return false; }
      const data = await res.json();
      this._absorb(data);
      return true;
    } catch {
      this.token = null;
      return false;
    }
  }

  _absorb(data) {
    this.token = data.accessToken;
    this.expiresAt = data.expiresAt;
    this.user = data.user;
  }

  async register(username, password) {
    const data = await this.req('POST', '/api/auth/register', { username, password, deviceId: this.deviceId }, { noAuth: true });
    this._absorb(data);
    return data.user;
  }

  async login(username, password) {
    const data = await this.req('POST', '/api/auth/login', { username, password, deviceId: this.deviceId }, { noAuth: true });
    this._absorb(data);
    return data.user;
  }

  async logout() {
    try { await this.req('POST', '/api/auth/logout', {}, { noAuth: true }); } catch {}
    this.token = null;
    this.user = null;
  }

  /** One-time websocket ticket. */
  async wsTicket() {
    const data = await this.get('/api/ws/ticket');
    return data.ticket;
  }
}

export const api = new Api();

// Pano ekleri: <img> bearer başlığı taşıyamaz → fetch + objectURL, önbellekli.
const fileURLs = new Map();    // fileId -> objectURL
const fileFetches = new Map(); // fileId -> in-flight promise

export function fileURL(fileId) {
  if (!fileId) return Promise.resolve(null);
  if (fileURLs.has(fileId)) return Promise.resolve(fileURLs.get(fileId));
  if (fileFetches.has(fileId)) return fileFetches.get(fileId);
  const p = api.req('GET', `/api/files/${fileId}`, undefined, { blob: true })
    .then(blob => {
      const url = URL.createObjectURL(blob);
      fileURLs.set(fileId, url);
      return url;
    })
    .catch(() => null)
    .finally(() => fileFetches.delete(fileId));
  fileFetches.set(fileId, p);
  return p;
}
