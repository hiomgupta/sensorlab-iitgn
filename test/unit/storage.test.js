import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdbRepository, validateChunk } from '../../src/storage/idb-repository.js';
import { Recorder, findInterruptedSessions, LOCK_PREFIX } from '../../src/storage/recorder.js';
import { ManualClock } from '../../src/util/clock.js';

let dbn = 0;
const newRepo = () => new IdbRepository({ dbName: 'test-' + (++dbn) });

/** Repository wrapper that fails the next N writes (storage-error / quota simulation). */
class FaultyRepo {
    constructor(inner) { this.inner = inner; this.failNext = 0; this.errorName = 'QuotaExceededError'; }
    _maybeFail(op) {
        if (this.failNext > 0) {
            this.failNext--;
            const e = new Error(`${op} failed: ${this.errorName}`);
            e.causeName = this.errorName; e.quota = this.errorName === 'QuotaExceededError';
            throw e;
        }
    }
    async createSession(s) { this._maybeFail('createSession'); return this.inner.createSession(s); }
    async appendChunk(...a) { this._maybeFail('appendChunk'); return this.inner.appendChunk(...a); }
    async updateSession(...a) { this._maybeFail('updateSession'); return this.inner.updateSession(...a); }
    async putAnnotation(a) { this._maybeFail('putAnnotation'); return this.inner.putAnnotation(a); }
}

/** fake Web Locks implementation (held while callback promise is pending) */
function fakeLocks() {
    const held = new Set();
    return {
        held,
        request(name, opts, cb) { held.add(name); return Promise.resolve(cb()).finally(() => held.delete(name)); },
        async query() { return { held: [...held].map(name => ({ name })) }; },
    };
}

let idc = 0;
function makeRecorder(repo, clock, extra = {}) {
    return new Recorder({ repo, clock, locks: null, newId: () => 'id-' + (++idc), persist: async () => false, ...extra });
}

function reading(i, dev = 'sim:A', ch = 0) {
    return { deviceId: dev, channelId: ch, seq: i, devUs: i * 1000, hostMs: i, relS: i / 1000, raw: i, value: i * 0.5, flags: 0 };
}

async function stopWithClock(rec, clock) {
    const p = rec.stop();
    for (let k = 0; k < 50; k++) await clock.advance(1000);
    return p;
}

test('session header is written before any reading; unique IDs for identical names', async () => {
    const repo = newRepo();
    const clock = new ManualClock();
    const r1 = makeRecorder(repo, clock), r2 = makeRecorder(repo, clock);
    const a = await r1.start({ name: 'Trial', devices: [] });
    assert.equal((await repo.getSession(a)).state, 'open');
    assert.equal(r1.append(reading(1)), true);
    await r1.stop();
    const b = await r2.start({ name: 'Trial', devices: [] });
    await r2.stop();
    assert.notEqual(a, b);
    const all = await repo.listSessions();
    assert.equal(all.filter(s => s.name === 'Trial').length, 2);
});

test('header write failure → recording does not start, nothing accepted', async () => {
    const repo = new FaultyRepo(newRepo());
    const rec = makeRecorder(repo, new ManualClock());
    repo.failNext = 1;
    await assert.rejects(rec.start({ name: 'x' }));
    assert.equal(rec.append(reading(1)), false);
});

test('importSnapshot commits session, chunks, and annotations atomically', async () => {
    const repo = newRepo();
    const chunk = { chunkNo: 0, n: 1, wall: '2026-01-01T00:00:00.000Z', dict: ['d'], cols: {
        d: [0], c: [0], q: [0], t: [0], h: [0], r: [0], raw: [1], v: [1], f: [0],
    } };
    const snapshot = {
        session: { sessionId: 'atomic-import', name: 'import', state: 'imported', devices: {}, storage: {} },
        chunks: [chunk, chunk],
        annotations: [{ sessionId: 'atomic-import', annotationId: 'a', relS: 0, text: 'note', deviceId: null }],
    };
    await assert.rejects(repo.importSnapshot(snapshot));
    assert.equal(await repo.getSession('atomic-import'), undefined, 'failed transaction must not leave the session header');
    assert.equal(await repo.countReadings('atomic-import'), 0, 'failed transaction must not leave the first chunk');

    snapshot.chunks = [chunk];
    await repo.importSnapshot(snapshot);
    assert.equal(await repo.countReadings('atomic-import'), 1);
    assert.equal((await repo.readSnapshot('atomic-import')).annotations.length, 1);
});

test('continuous batched persistence: data is in storage before Stop', async () => {
    const repo = newRepo();
    const clock = new ManualClock();
    const rec = makeRecorder(repo, clock, { flushIntervalMs: 250 });
    const id = await rec.start({ name: 'live' });
    for (let i = 0; i < 1000; i++) rec.append(reading(i));
    await clock.advance(300);
    assert.equal(await repo.countReadings(id), 1000, 'persisted while still recording');
    const s = await repo.getSession(id);
    assert.equal(s.state, 'open');
    assert.equal(s.storage.readingsPersisted, 1000);
    for (let i = 1000; i < 1500; i++) rec.append(reading(i));
    const sum = await rec.stop();
    assert.equal(sum.ok, true);
    assert.equal(sum.persisted, 1500);
    assert.equal(sum.unsaved, 0);
    const snap = await repo.readSnapshot(id);
    assert.equal(snap.session.state, 'closed');
    const seqs = snap.chunks.flatMap(c => c.cols.q);
    assert.deepEqual(seqs, [...Array(1500).keys()], 'order and integrity preserved');
});

test('transient storage error: retried with the same chunk (no duplicates), error surfaced', async () => {
    const inner = newRepo();
    const repo = new FaultyRepo(inner);
    const clock = new ManualClock();
    const statuses = [];
    const rec = makeRecorder(repo, clock, { onStatus: (s) => statuses.push(s) });
    const id = await rec.start({ name: 'retry' });
    for (let i = 0; i < 100; i++) rec.append(reading(i));
    repo.failNext = 2;
    await clock.advance(300);
    assert.ok(statuses.some(s => s.lastError && s.lastError.quota), 'quota error visible');
    for (let i = 100; i < 200; i++) rec.append(reading(i));
    await clock.advance(5000);
    const sum = await stopWithClock(rec, clock);
    assert.equal(sum.ok, true);
    assert.equal(sum.writeErrors, 2);
    const snap = await inner.readSnapshot(id);
    const seqs = snap.chunks.flatMap(c => c.cols.q);
    assert.deepEqual(seqs, [...Array(200).keys()]);
    assert.equal(snap.session.storage.writeErrors, 2);
});

test('persistent storage failure: stop reports unsaved readings honestly (no false "saved")', async () => {
    const repo = new FaultyRepo(newRepo());
    const clock = new ManualClock();
    const rec = makeRecorder(repo, clock);
    await rec.start({ name: 'full disk' });
    for (let i = 0; i < 50; i++) rec.append(reading(i));
    repo.failNext = 1e9;
    const sum = await stopWithClock(rec, clock);
    assert.equal(sum.ok, false);
    assert.equal(sum.unsaved, 50);
    assert.equal(sum.closed, false);
});

test('backpressure: readings beyond maxPending are counted as droppedUnsaved, not silently lost', async () => {
    const repo = new FaultyRepo(newRepo());
    const clock = new ManualClock();
    const rec = makeRecorder(repo, clock, { maxPending: 10 });
    await rec.start({ name: 'bp' });
    repo.failNext = 1e9;
    for (let i = 0; i < 25; i++) rec.append(reading(i));
    assert.equal(rec.status().droppedUnsaved, 15);
    repo.failNext = 0;
    const sum = await stopWithClock(rec, clock);
    assert.equal(sum.persisted, 10);
    assert.equal(sum.droppedUnsaved, 15);
    assert.equal(sum.ok, false);
});

test('interrupted session detected (lock released / stale heartbeat), recovery idempotent, no fabricated data', async () => {
    const repo = newRepo();
    const clock = new ManualClock();
    const locks = fakeLocks();
    const rec = makeRecorder(repo, clock, { locks });
    const id = await rec.start({ name: 'crash' });
    for (let i = 0; i < 300; i++) rec.append(reading(i));
    await clock.advance(300);
    for (let i = 300; i < 350; i++) rec.append(reading(i)); // never flushed: "crash" now
    assert.ok(locks.held.has(LOCK_PREFIX + id));
    assert.deepEqual(await findInterruptedSessions(repo, { locks }), [], 'live recording is not "interrupted"');
    rec._releaseLock(); // tab died → lock released by the browser
    await Promise.resolve();
    const found = await findInterruptedSessions(repo, { locks });
    assert.deepEqual(found.map(s => s.sessionId), [id]);
    // heartbeat fallback without Web Locks
    const stale = await findInterruptedSessions(repo, { locks: null, nowWall: Date.parse(found[0].storage.heartbeatWall) + 60_000 });
    assert.equal(stale.length, 1);
    const r1 = await repo.recoverSession(id, '2026-10-12T00:00:00Z');
    assert.equal(r1.state, 'recovered');
    assert.equal(r1.recovery.persistedReadings, 300);
    const r2 = await repo.recoverSession(id, '2026-10-12T01:00:00Z');
    assert.deepEqual(r2.recovery, r1.recovery, 'repeated recovery changes nothing');
    assert.equal(await repo.countReadings(id), 300, 'no duplicate or fabricated readings');
});

test('corrupt or missing chunks are detected and reported, valid data still readable', async () => {
    const repo = newRepo();
    const clock = new ManualClock();
    const rec = makeRecorder(repo, clock);
    const id = await rec.start({ name: 'corrupt' });
    for (let k = 0; k < 4; k++) { for (let i = 0; i < 10; i++) rec.append(reading(k * 10 + i)); await rec.flush(); }
    await rec.stop();
    // simulate a damaged tail chunk and a missing chunk
    await repo._run('corrupt', ['chunks'], 'readwrite', async (tx) => {
        const st = tx.objectStore('chunks');
        st.put({ sessionId: id, chunkNo: 3, n: 10, dict: ['sim:A'], cols: { d: [0] } });
        st.delete([id, 1]);
    });
    const snap = await repo.readSnapshot(id);
    assert.deepEqual(snap.corruptChunks.map(c => c.chunkNo), [3]);
    assert.deepEqual(snap.missingChunkNos, [1]);
    assert.equal(snap.chunks.reduce((a, c) => a + c.n, 0), 20);
    assert.equal(validateChunk(null), 'not an object');
});

test('delete one session only (same display name) and wipe all', async () => {
    const repo = newRepo();
    const clock = new ManualClock();
    const ids = [];
    for (let k = 0; k < 2; k++) {
        const rec = makeRecorder(repo, clock);
        ids.push(await rec.start({ name: 'Same Name' }));
        for (let i = 0; i < 5; i++) rec.append(reading(i));
        await rec.addAnnotation({ relS: 1, text: 'note ' + k });
        await rec.stop();
    }
    await repo.deleteSession(ids[0]);
    assert.equal(await repo.getSession(ids[0]), undefined);
    const other = await repo.readSnapshot(ids[1]);
    assert.equal(other.chunks[0].n, 5);
    assert.equal(other.annotations.length, 1);
    await repo.wipeAll();
    assert.equal((await repo.listSessions()).length, 0);
});

test('annotation write failure is reported, not swallowed', async () => {
    const repo = new FaultyRepo(newRepo());
    const rec = makeRecorder(repo, new ManualClock());
    await rec.start({ name: 'a' });
    repo.failNext = 1;
    const r = await rec.addAnnotation({ relS: 0, text: 'x' });
    assert.equal(r.ok, false);
});
