// store.js: never lose a recording. Autosaves chunks while recording; lists and recovers
// sessions after a reload or crash. Logic is pure over a tiny backend interface, so it is
// tested in Node with memoryBackend() and runs in the browser on idbBackend().
//
// Contract
//   Backend: { put(store, key, value), get(store, key), getAll(store, keyPrefix?), del(store, key) }
//            stores: 'sessions' (key = id), 'chunks' (key = `${id}:${seq 6 digits}`)
//   memoryBackend() -> Backend;   await idbBackend(dbName = 'opengrip') -> Backend (browser only)
//   const saver = new AutoSaver({ backend, id?, everySamples = 500, everyMs = 2000, now })
//   await saver.begin({ meta, channels, channelNames })   writes the session record (complete: false)
//   saver.add(rows)          rows from Session.drain(); flushes when either threshold is reached
//   await saver.flush()      writes pending rows as one chunk; safe to call any time
//   await saver.finish(extra?)  flush + mark complete (CSV saved)
//   await listSessions(backend) -> [{ id, meta, channels, channelNames, startedAt, updatedAt, samples, complete }] newest first
//   await loadSession(backend, id) -> recording { channels, channelNames, t, data, labels, markers, meta }
//   await deleteSession(backend, id)
// Failure behaviour: a failed write keeps rows in memory (pending) and is retried next flush;
// lastError holds the message so the UI can warn.

const pad = (n) => String(n).padStart(6, '0');

export function memoryBackend() {
  const stores = { sessions: new Map(), chunks: new Map() };
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  return {
    async put(s, k, v) { stores[s].set(k, clone(v)); },
    async get(s, k) { return clone(stores[s].get(k)); },
    async getAll(s, prefix = '') {
      return [...stores[s].entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => clone(v));
    },
    async del(s, k) { stores[s].delete(k); },
    _stores: stores,
  };
}

export function idbBackend(dbName = 'opengrip') {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions');
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks');
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const run = (s, mode, fn) => new Promise((res, rej) => {
        const tx = db.transaction(s, mode);
        const r = fn(tx.objectStore(s));
        tx.oncomplete = () => res(r && 'result' in r ? r.result : undefined);
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error || new Error('IndexedDB write aborted (disk full?)'));
      });
      resolve({
        put: (s, k, v) => run(s, 'readwrite', (st) => st.put(v, k)),
        get: (s, k) => run(s, 'readonly', (st) => st.get(k)),
        getAll: (s, prefix = '') => run(s, 'readonly', (st) => (prefix ? st.getAll(IDBKeyRange.bound(prefix, `${prefix}￿`)) : st.getAll())),
        del: (s, k) => run(s, 'readwrite', (st) => st.delete(k)),
      });
    };
  });
}

export class AutoSaver {
  constructor({ backend, id = null, everySamples = 500, everyMs = 2000, now = () => Date.now() }) {
    this.backend = backend;
    this.id = id || `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    this.everySamples = everySamples;
    this.everyMs = everyMs;
    this.now = now;
    this.pending = [];
    this.markers = [];
    this.seq = 0;
    this.samples = 0;
    this.lastFlush = now();
    this.lastError = null;
    this._writing = null;
  }

  async begin({ meta = {}, channels = 0, channelNames = [] } = {}) {
    this.record = { id: this.id, meta, channels, channelNames, startedAt: new Date().toISOString(), updatedAt: null, samples: 0, complete: false };
    await this.backend.put('sessions', this.id, this.record);
  }

  add(rows, markers = []) {
    if (rows.length) this.pending.push(...rows);
    if (markers.length) this.markers.push(...markers);
    if (this.pending.length >= this.everySamples || this.now() - this.lastFlush >= this.everyMs) return this.flush();
    return Promise.resolve();
  }

  async flush() {
    // Serialise writes so chunk sequence numbers stay in order.
    if (this._writing) await this._writing.catch(() => {});
    if (!this.pending.length && !this.markers.length) return;
    const rows = this.pending;
    const markers = this.markers;
    this.pending = [];
    this.markers = [];
    this.lastFlush = this.now();
    const seq = this.seq;
    this._writing = (async () => {
      await this.backend.put('chunks', `${this.id}:${pad(seq)}`, { seq, rows, markers });
      this.seq = seq + 1;
      this.samples += rows.length;
      this.record.samples = this.samples;
      this.record.updatedAt = new Date().toISOString();
      await this.backend.put('sessions', this.id, this.record);
    })();
    try {
      await this._writing;
      this.lastError = null;
    } catch (e) {
      // Keep the data; try again next time.
      this.pending = rows.concat(this.pending);
      this.markers = markers.concat(this.markers);
      this.lastError = e?.message || String(e);
    } finally {
      this._writing = null;
    }
  }

  async update(fields) {
    Object.assign(this.record, fields);
    await this.backend.put('sessions', this.id, this.record);
  }

  async finish(extra = {}) {
    await this.flush();
    await this.update({ ...extra, complete: true });
  }
}

export async function listSessions(backend) {
  const all = await backend.getAll('sessions');
  return all.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export async function loadSession(backend, id) {
  const rec = await backend.get('sessions', id);
  if (!rec) return null;
  const chunks = await backend.getAll('chunks', `${id}:`);
  chunks.sort((a, b) => a.seq - b.seq);
  const t = [];
  const labels = [];
  const rows = [];
  const markers = [];
  for (const ch of chunks) {
    for (const r of ch.rows) { t.push(r.t); rows.push(r.values); labels.push(r.label); }
    markers.push(...(ch.markers || []));
  }
  const channels = rec.channels || (rows[0] ? rows[0].length : 0);
  const data = Array.from({ length: channels }, (_, c) => rows.map((r) => r[c]));
  return { channels, channelNames: rec.channelNames?.length ? rec.channelNames : data.map((_, i) => `ch${i + 1}`), t, data, labels, markers, meta: rec.meta || {}, complete: rec.complete };
}

export async function deleteSession(backend, id) {
  const chunks = await backend.getAll('chunks', `${id}:`);
  for (const ch of chunks) await backend.del('chunks', `${id}:${pad(ch.seq)}`);
  await backend.del('sessions', id);
}
