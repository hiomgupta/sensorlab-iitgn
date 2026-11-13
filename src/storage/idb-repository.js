/**
 * IndexedDB repository (Layer 4). Async interface; the UI never touches IndexedDB directly.
 *
 * Stores (DB "sensorlab-v2"):
 *   sessions     key sessionId                      session header + metadata + quality
 *   chunks       key [sessionId, chunkNo]           columnar batches of readings (journal)
 *   annotations  key [sessionId, annotationId]
 *   meta         key key                            app-level flags (e.g. legacy import status)
 *
 * Each chunk write and its session-metadata update share ONE transaction, so persisted
 * readings and the persisted quality counters never disagree. Re-writing the same chunkNo
 * (a retry) is idempotent.
 */
export const DB_NAME = 'sensorlab-v2';
export const DB_VERSION = 1;
export const SESSION_SCHEMA = 'sensorlab.session/1';
export const CHUNK_COLUMNS = ['d', 'c', 'q', 't', 'h', 'r', 'raw', 'v', 'f'];

function req(r) {
    return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
function done(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction error'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
}

export class StorageError extends Error {
    constructor(op, cause) {
        super(`${op} failed: ${cause?.name || 'Error'}${cause?.message ? ' — ' + cause.message : ''}`);
        this.name = 'StorageError';
        this.op = op;
        this.causeName = cause?.name || 'Error';
        this.quota = cause?.name === 'QuotaExceededError';
    }
}

/** Structural validation of a persisted chunk. Returns null if OK, else a reason string. */
export function validateChunk(ch) {
    if (!ch || typeof ch !== 'object') return 'not an object';
    if (!Number.isInteger(ch.n) || ch.n < 0) return 'bad n';
    if (!Array.isArray(ch.dict)) return 'missing device dictionary';
    if (!ch.cols || typeof ch.cols !== 'object') return 'missing columns';
    for (const k of CHUNK_COLUMNS) {
        if (!Array.isArray(ch.cols[k]) || ch.cols[k].length !== ch.n) return `column ${k} length mismatch`;
    }
    for (let i = 0; i < ch.n; i++) {
        const d = ch.cols.d[i];
        if (!Number.isInteger(d) || d < 0 || d >= ch.dict.length) return `bad device index at row ${i}`;
        if (!Number.isInteger(ch.cols.f[i])) return `bad flags at row ${i}`;
    }
    return null;
}

export class IdbRepository {
    constructor({ idb = globalThis.indexedDB, dbName = DB_NAME } = {}) {
        this.idb = idb;
        this.dbName = dbName;
        this.db = null;
    }

    async open() {
        if (this.db) return this;
        if (!this.idb) throw new StorageError('open', { name: 'NotSupportedError', message: 'IndexedDB is not available in this browser context' });
        const r = this.idb.open(this.dbName, DB_VERSION);
        r.onupgradeneeded = () => {
            const db = r.result;
            if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'sessionId' });
            if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: ['sessionId', 'chunkNo'] });
            if (!db.objectStoreNames.contains('annotations')) db.createObjectStore('annotations', { keyPath: ['sessionId', 'annotationId'] });
            if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        };
        try { this.db = await req(r); } catch (e) { throw new StorageError('open', e); }
        this.db.onversionchange = () => { this.db.close(); this.db = null; };
        return this;
    }

    close() { this.db?.close(); this.db = null; }

    async _run(op, stores, mode, fn) {
        await this.open();
        let tx;
        // Writes request strict durability: the commit is acknowledged only after the data is flushed to disk.
        // (Chrome's default is "relaxed", which can lose acknowledged commits on OS crash or power loss.)
        try { tx = mode === 'readwrite' ? this.db.transaction(stores, mode, { durability: 'strict' }) : this.db.transaction(stores, mode); }
        catch (e) { throw new StorageError(op, e); }
        const p = done(tx);
        let result;
        try { result = await fn(tx); } catch (e) { try { tx.abort(); } catch { /* already finished */ } p.catch(() => {}); throw new StorageError(op, e); }
        try { await p; } catch (e) { throw new StorageError(op, e); }
        return result;
    }

    async createSession(session) {
        return this._run('createSession', ['sessions'], 'readwrite', async (tx) => {
            await req(tx.objectStore('sessions').add({ schema: SESSION_SCHEMA, ...session }));
        });
    }

    /** Import a fully validated snapshot atomically; duplicate keys abort without partial records. */
    async importSnapshot(snapshot) {
        return this._run('importSnapshot', ['sessions', 'chunks', 'annotations'], 'readwrite', async (tx) => {
            const sessionId = snapshot.session.sessionId;
            await req(tx.objectStore('sessions').add({ schema: SESSION_SCHEMA, ...snapshot.session }));
            for (const chunk of snapshot.chunks) {
                const invalid = validateChunk(chunk);
                if (invalid) throw new StorageError('importSnapshot', { name: 'DataError', message: `invalid chunk ${chunk.chunkNo}: ${invalid}` });
                await req(tx.objectStore('chunks').add({ ...chunk, sessionId }));
            }
            for (const annotation of snapshot.annotations) {
                await req(tx.objectStore('annotations').add({ ...annotation, sessionId }));
            }
        });
    }

    async updateSession(sessionId, patch) {
        return this._run('updateSession', ['sessions'], 'readwrite', async (tx) => {
            const s = tx.objectStore('sessions');
            const cur = await req(s.get(sessionId));
            if (!cur) throw Object.assign(new Error(`session ${sessionId} not found`), { name: 'NotFoundError' });
            const next = { ...cur, ...patch };
            await req(s.put(next));
            return next;
        });
    }

    /** Atomically persist one chunk and the matching session metadata. */
    async appendChunk(sessionId, chunk, sessionPatch) {
        return this._run('appendChunk', ['chunks', 'sessions'], 'readwrite', async (tx) => {
            const s = tx.objectStore('sessions');
            const cur = await req(s.get(sessionId));
            if (!cur) throw Object.assign(new Error(`session ${sessionId} not found`), { name: 'NotFoundError' });
            tx.objectStore('chunks').put({ ...chunk, sessionId });
            await req(s.put({ ...cur, ...sessionPatch }));
        });
    }

    async putAnnotation(a) {
        return this._run('putAnnotation', ['annotations'], 'readwrite', async (tx) => { await req(tx.objectStore('annotations').put(a)); });
    }

    async getSession(id) {
        return this._run('getSession', ['sessions'], 'readonly', (tx) => req(tx.objectStore('sessions').get(id)));
    }

    async listSessions() {
        return this._run('listSessions', ['sessions'], 'readonly', (tx) => req(tx.objectStore('sessions').getAll()));
    }

    /**
     * Consistent snapshot of one session (single readonly transaction).
     * Corrupt chunks are reported, not silently dropped or "repaired".
     */
    async readSnapshot(id) {
        return this._run('readSnapshot', ['sessions', 'chunks', 'annotations'], 'readonly', async (tx) => {
            const range = IDBKeyRangeFor(this.idb, id);
            const [session, rawChunks, annotations] = await Promise.all([
                req(tx.objectStore('sessions').get(id)),
                req(tx.objectStore('chunks').getAll(range)),
                req(tx.objectStore('annotations').getAll(range)),
            ]);
            if (!session) return null;
            const chunks = [], corruptChunks = [], missingChunkNos = [];
            let expect = 0;
            rawChunks.sort((a, b) => a.chunkNo - b.chunkNo);
            for (const ch of rawChunks) {
                while (expect < ch.chunkNo) missingChunkNos.push(expect++);
                expect = ch.chunkNo + 1;
                const bad = validateChunk(ch);
                if (bad) corruptChunks.push({ chunkNo: ch.chunkNo, reason: bad });
                else chunks.push(ch);
            }
            annotations.sort((a, b) => a.relS - b.relS);
            return { session, chunks, corruptChunks, missingChunkNos, annotations };
        });
    }

    async countReadings(id) {
        const snap = await this.readSnapshot(id);
        return snap ? snap.chunks.reduce((a, c) => a + c.n, 0) : 0;
    }

    async deleteSession(id) {
        return this._run('deleteSession', ['sessions', 'chunks', 'annotations'], 'readwrite', async (tx) => {
            const range = IDBKeyRangeFor(this.idb, id);
            tx.objectStore('sessions').delete(id);
            tx.objectStore('chunks').delete(range);
            tx.objectStore('annotations').delete(range);
        });
    }

    async wipeAll() {
        return this._run('wipeAll', ['sessions', 'chunks', 'annotations'], 'readwrite', async (tx) => {
            tx.objectStore('sessions').clear();
            tx.objectStore('chunks').clear();
            tx.objectStore('annotations').clear();
        });
    }

    /**
     * Mark an interrupted (still "open") session as recovered. Idempotent: a session that is
     * already recovered or closed is returned unchanged. Recovery never fabricates data. It
     * counts what was persisted and records that later data is lost.
     */
    async recoverSession(id, wallIso) {
        const snap = await this.readSnapshot(id);
        if (!snap) throw new StorageError('recoverSession', { name: 'NotFoundError', message: id });
        if (snap.session.state !== 'open') return snap.session;
        const readings = snap.chunks.reduce((a, c) => a + c.n, 0);
        const last = snap.chunks[snap.chunks.length - 1];
        return this.updateSession(id, {
            state: 'recovered',
            endedWall: last?.wall ?? snap.session.startedWall,
            recovery: {
                recoveredAt: wallIso,
                persistedChunks: snap.chunks.length,
                persistedReadings: readings,
                corruptChunks: snap.corruptChunks,
                missingChunkNos: snap.missingChunkNos,
                lastPersistedWall: last?.wall ?? null,
                lastHeartbeatWall: snap.session.storage?.heartbeatWall ?? null,
                note: 'Recording was interrupted (app closed or crashed). Readings after the last persisted chunk were not saved; the size of that loss window is unknown.',
            },
        });
    }

    async getMeta(key) {
        return this._run('getMeta', ['meta'], 'readonly', async (tx) => (await req(tx.objectStore('meta').get(key)))?.value);
    }

    async setMeta(key, value) {
        return this._run('setMeta', ['meta'], 'readwrite', async (tx) => { await req(tx.objectStore('meta').put({ key, value })); });
    }
}

function IDBKeyRangeFor(idb, sessionId) {
    // [sessionId, -Infinity] .. [sessionId, []] covers every numeric/string second key part.
    const KR = globalThis.IDBKeyRange || idb?.constructor?.KeyRange;
    return KR.bound([sessionId, -Infinity], [sessionId, []]);
}

/** Browser storage persistence and usage (null fields where the API is unavailable). */
export async function storageInfo() {
    const out = { persisted: null, usage: null, quota: null };
    try { if (navigator.storage?.persisted) out.persisted = await navigator.storage.persisted(); } catch { /* unavailable */ }
    try { if (navigator.storage?.estimate) { const e = await navigator.storage.estimate(); out.usage = e.usage ?? null; out.quota = e.quota ?? null; } } catch { /* unavailable */ }
    return out;
}

export async function requestPersistence() {
    try { return navigator.storage?.persist ? await navigator.storage.persist() : null; } catch { return null; }
}
