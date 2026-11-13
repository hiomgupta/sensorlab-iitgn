/**
 * Recorder: continuous, batched persistence of readings while a session is recording.
 *
 * - The session header is written (and awaited) before any reading is accepted.
 * - Readings are appended to an in-memory columnar batch and flushed every flushIntervalMs.
 * - A failed chunk is retried with the SAME chunkNo and content, so retries are idempotent.
 * - Errors are surfaced through onStatus. The recorder never pretends data was saved, and it never
 *   silently falls back to memory-only recording. Readings beyond maxPending are counted as
 *   droppedUnsaved.
 * - A Web Lock is held for the session's lifetime so another tab can tell a live recording
 *   from an interrupted one.
 */
import { requestPersistence } from './idb-repository.js';

export const LOCK_PREFIX = 'sensorlab-rec-';

function emptyCols() { return { d: [], c: [], q: [], t: [], h: [], r: [], raw: [], v: [], f: [] }; }

export class Recorder {
    constructor({ repo, clock, flushIntervalMs = 250, maxPending = 200_000, heartbeatMs = 5_000, locks, onStatus, newId, persist = requestPersistence }) {
        this.repo = repo;
        this.clock = clock;
        this.flushIntervalMs = flushIntervalMs;
        this.maxPending = maxPending;
        this.heartbeatMs = heartbeatMs;
        this.locks = locks === undefined ? (globalThis.navigator?.locks ?? null) : locks;
        this.onStatus = onStatus || (() => {});
        this.newId = newId || (() => crypto.randomUUID());
        this.persist = persist;
        this._resetState();
    }

    _resetState() {
        this.sessionId = null;
        this.state = 'idle';
        this.session = null;
        this.devices = {};
        this.dict = [];
        this.dictIndex = new Map();
        this.cols = emptyCols();
        this.pendingN = 0;
        this.inflight = null;
        this.chunkNo = 0;
        this.counters = { appended: 0, persisted: 0, droppedUnsaved: 0, writeErrors: 0, consecutiveErrors: 0, chunks: 0 };
        this.lastError = null;
        this.lastFlushWall = null;
        this._timer = null;
        this._flushing = null;
        this._retryAt = 0;
        this._lastHeartbeat = 0;
        this._annotations = 0;
    }

    status() {
        return {
            state: this.state, sessionId: this.sessionId, ...this.counters,
            pending: this.pendingN + (this.inflight ? this.inflight.chunk.n : 0),
            lastError: this.lastError, lastFlushWall: this.lastFlushWall,
        };
    }

    _notify() { try { this.onStatus(this.status()); } catch { /* UI errors must not affect recording */ } }

    _wallIso() { return new Date(this.clock.wallNow()).toISOString(); }

    async start(meta, getQuality = () => ({}), getVisibility = () => []) {
        // Synchronous guard: a second concurrent start() must fail before any await (defect D24 created two sessions).
        if (this.state !== 'idle') throw new Error(`recorder busy (${this.state})`);
        this._resetState();
        this.state = 'starting';
        try { return await this._start(meta, getQuality, getVisibility); }
        catch (e) { this._releaseLock?.(); this._releaseLock = null; this.state = 'idle'; this.sessionId = null; throw e; }
    }

    async _start(meta, getQuality, getVisibility) {
        this.getQuality = getQuality;
        this.getVisibility = getVisibility;
        const sessionId = this.newId();
        const wall = this._wallIso();
        for (const d of meta.devices || []) this.devices[d.deviceId] = d;
        const persisted = await this.persist();
        this.session = {
            sessionId,
            name: String(meta.name || 'Untitled').slice(0, 200),
            group: String(meta.group || '').slice(0, 200),
            notes: String(meta.notes || '').slice(0, 2000),
            state: 'open',
            createdWall: wall,
            startedWall: wall,
            endedWall: null,
            simulated: !!meta.simulated,
            app: meta.app || {},
            devices: this.devices,
            quality: {},
            visibility: [],
            storage: { chunks: 0, readingsPersisted: 0, lastFlushWall: null, heartbeatWall: wall, writeErrors: 0, droppedUnsaved: 0, persistGranted: persisted },
            recovery: null,
            lifecycle: meta.lifecycle || null,
        };
        this.lifecycle = this.session.lifecycle;
        await this.repo.createSession(this.session); // throws → recording does not start
        if (this.locks) {
            await new Promise((granted) => {
                this.locks.request(LOCK_PREFIX + sessionId, { mode: 'exclusive' }, () => {
                    granted();
                    return new Promise((release) => { this._releaseLock = release; });
                }).catch(() => granted());
            });
        }
        if (this.state !== 'starting') throw new Error('recorder start was aborted');
        this.sessionId = sessionId;
        this.state = 'recording';
        this._lastHeartbeat = this.clock.now();
        this._schedule(this.flushIntervalMs);
        this._notify();
        return sessionId;
    }

    /** Lifecycle state/events/keep-awake/startup info; persisted with the next write. */
    setLifecycle(lifecycle) {
        if (!this.session) return;
        this.lifecycle = lifecycle;
        this._metaDirty = true;
    }

    upsertDevice(meta) {
        if (!this.sessionId || !meta.deviceId) return;
        this.devices[meta.deviceId] = { ...(this.devices[meta.deviceId] || {}), ...meta };
        this._metaDirty = true;
    }

    /** Synchronous and cheap. Called once for every reading on the acquisition path. */
    append(r) {
        if (this.state !== 'recording') return false;
        if (this.pendingN >= this.maxPending) {
            this.counters.droppedUnsaved++;
            if (this.counters.droppedUnsaved === 1) this._notify();
            return false;
        }
        let di = this.dictIndex.get(r.deviceId);
        if (di === undefined) { di = this.dict.length; this.dict.push(r.deviceId); this.dictIndex.set(r.deviceId, di); }
        const c = this.cols;
        c.d.push(di); c.c.push(r.channelId); c.q.push(r.seq); c.t.push(r.devUs); c.h.push(r.hostMs);
        c.r.push(r.relS); c.raw.push(r.raw); c.v.push(r.value); c.f.push(r.flags);
        this.pendingN++;
        this.counters.appended++;
        return true;
    }

    _schedule(ms) {
        if (this._timer) this.clock.clearTimeout(this._timer);
        this._timer = this.clock.setTimeout(() => { this._timer = null; this._tick(); }, ms);
    }

    async _tick() {
        if (this.state !== 'recording') return;
        await this.flush();
        if (this.state === 'recording') {
            const wait = this.counters.consecutiveErrors > 0 ? Math.min(10_000, 500 * 2 ** (this.counters.consecutiveErrors - 1)) : this.flushIntervalMs;
            this._schedule(wait);
        }
    }

    _sessionPatch(extraReadings) {
        const wall = this._wallIso();
        return {
            devices: this.devices,
            quality: this.getQuality(),
            visibility: this.getVisibility(),
            lifecycle: this.lifecycle ?? null,
            storage: {
                ...this.session.storage,
                chunks: this.counters.chunks + (extraReadings !== null ? 1 : 0),
                readingsPersisted: this.counters.persisted + (extraReadings || 0),
                lastFlushWall: extraReadings !== null ? wall : this.lastFlushWall,
                heartbeatWall: wall,
                writeErrors: this.counters.writeErrors,
                droppedUnsaved: this.counters.droppedUnsaved,
            },
        };
    }

    /** Flush pending readings (one chunk per call). Concurrent calls share one in-flight write. */
    flush() {
        if (this._flushing) return this._flushing;
        this._flushing = this._flushOnce().finally(() => { this._flushing = null; });
        return this._flushing;
    }

    async _flushOnce() {
        if (!this.sessionId) return true;
        if (!this.inflight && this.pendingN > 0) {
            this.inflight = {
                chunk: { chunkNo: this.chunkNo, n: this.pendingN, wall: this._wallIso(), dict: this.dict.slice(), cols: this.cols },
            };
            this.cols = emptyCols();
            this.pendingN = 0;
        }
        try {
            if (this.inflight) {
                const ch = this.inflight.chunk;
                const patch = this._sessionPatch(ch.n);
                await this.repo.appendChunk(this.sessionId, ch, patch);
                this.session.storage = patch.storage;
                this.counters.persisted += ch.n;
                this.counters.chunks++;
                this.chunkNo++;
                this.inflight = null;
                this.lastFlushWall = patch.storage.lastFlushWall;
                this._lastHeartbeat = this.clock.now();
                this._metaDirty = false;
            } else if (this._metaDirty || this.clock.now() - this._lastHeartbeat >= this.heartbeatMs) {
                const patch = this._sessionPatch(null);
                await this.repo.updateSession(this.sessionId, patch);
                this.session.storage = patch.storage;
                this._lastHeartbeat = this.clock.now();
                this._metaDirty = false;
            }
            if (this.counters.consecutiveErrors > 0 || this.lastError) { this.counters.consecutiveErrors = 0; this.lastError = null; this._notify(); }
            else this._notify();
            return true;
        } catch (e) {
            this.counters.writeErrors++;
            this.counters.consecutiveErrors++;
            this.lastError = { message: e.message, name: e.causeName || e.name, quota: !!e.quota, wall: this._wallIso() };
            this._notify();
            return false;
        }
    }

    async addAnnotation({ relS, text, deviceId = null }) {
        if (this.state !== 'recording') return { ok: false, error: 'not recording' };
        const a = { sessionId: this.sessionId, annotationId: this.newId(), relS, text, deviceId, wall: this._wallIso() };
        try { await this.repo.putAnnotation(a); this._annotations++; return { ok: true, annotation: a }; }
        catch (e) { this.counters.writeErrors++; this.lastError = { message: e.message, name: e.causeName || e.name, wall: this._wallIso() }; this._notify(); return { ok: false, error: e.message }; }
    }

    /**
     * Stop recording: flush everything (bounded retries), then mark the session closed.
     * Returns an honest summary. ok is true only if every appended reading was persisted.
     */
    async stop({ maxAttempts = 5, retryDelayMs = 200, finalState = 'closed' } = {}) {
        if (this.state !== 'recording') return null;
        this.state = 'stopping';
        if (this._timer) { this.clock.clearTimeout(this._timer); this._timer = null; }
        this._notify();
        let attempts = 0;
        while ((this.inflight || this.pendingN > 0) && attempts < maxAttempts) {
            if (this._flushing) await this._flushing;
            const ok = await this.flush();
            if (!ok) { attempts++; await new Promise(r => this.clock.setTimeout(r, retryDelayMs * attempts)); }
        }
        const unsaved = this.pendingN + (this.inflight ? this.inflight.chunk.n : 0) + this.counters.droppedUnsaved;
        let closed = false;
        try {
            const patch = this._sessionPatch(null);
            await this.repo.updateSession(this.sessionId, {
                ...patch,
                state: finalState,
                endedWall: this._wallIso(),
                storage: { ...patch.storage, unsavedAtStop: unsaved },
            });
            closed = true;
        } catch (e) {
            this.lastError = { message: e.message, name: e.causeName || e.name, wall: this._wallIso() };
        }
        const summary = {
            sessionId: this.sessionId,
            ok: unsaved === 0 && closed,
            appended: this.counters.appended,
            persisted: this.counters.persisted,
            unsaved,
            droppedUnsaved: this.counters.droppedUnsaved,
            writeErrors: this.counters.writeErrors,
            closed,
            lastError: this.lastError,
            annotations: this._annotations,
            finalState: closed ? finalState : null,
        };
        this._releaseLock?.();
        this._releaseLock = null;
        this.state = 'idle';
        this.lastSummary = summary;
        this._notify();
        return summary;
    }
}

/**
 * Sessions still marked "open" that no live tab is recording. Uses Web Locks when available,
 * otherwise falls back to a stale heartbeat (> 3 × heartbeat interval).
 */
export async function findInterruptedSessions(repo, { locks = globalThis.navigator?.locks ?? null, nowWall = Date.now(), heartbeatMs = 5_000 } = {}) {
    const open = (await repo.listSessions()).filter(s => s.state === 'open');
    if (open.length === 0) return [];
    let held = null;
    if (locks?.query) {
        try { held = new Set(((await locks.query()).held || []).map(l => l.name)); } catch { held = null; }
    }
    return open.filter(s => {
        if (held) return !held.has(LOCK_PREFIX + s.sessionId);
        const hb = Date.parse(s.storage?.heartbeatWall || s.startedWall);
        return !Number.isFinite(hb) || nowWall - hb > 3 * heartbeatMs;
    });
}
