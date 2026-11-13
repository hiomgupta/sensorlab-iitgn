import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importLegacyIfPresent, convertLegacy, LEGACY_DB } from '../../src/storage/legacy-import.js';
import { IdbRepository } from '../../src/storage/idb-repository.js';
import { Q } from '../../src/acquisition/quality.js';

/** Recreate the exact SensorLab 1.x schema (data-store.js, DB version 4). */
async function seedLegacy() {
    await new Promise((res, rej) => {
        const r = indexedDB.open(LEGACY_DB, 4);
        r.onupgradeneeded = () => {
            const db = r.result;
            const rec = db.createObjectStore('recordings', { keyPath: 'id', autoIncrement: true });
            rec.createIndex('session', 'session'); rec.createIndex('deviceId', 'deviceId');
            db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
            db.createObjectStore('annotations', { keyPath: 'id', autoIncrement: true }).createIndex('session', 'session');
        };
        r.onsuccess = () => {
            const db = r.result;
            const tx = db.transaction(['recordings', 'sessions', 'annotations'], 'readwrite');
            tx.objectStore('sessions').add({ name: 'Trial', group: 'A', startTime: 1000 });
            tx.objectStore('sessions').add({ name: 'Trial', group: 'A', startTime: 5000 }); // same name!
            tx.objectStore('sessions').add({ name: 'Other', group: '', startTime: 9000 });
            for (const t of [1100, 1200, 5100, 5200, 5300, 9100]) {
                tx.objectStore('recordings').add({ deviceId: 'dev1', name: 'SLab-A3B5', value: t / 100, unit: 'Ω', timestamp: t, session: t >= 9000 ? 'Other' : 'Trial', channelIndex: 0 });
            }
            tx.objectStore('annotations').add({ timestamp: 5150, text: 'added weight', session: 'Trial' });
            tx.oncomplete = () => { db.close(); res(); };
            tx.onerror = () => rej(tx.error);
        };
        r.onerror = () => rej(r.error);
    });
}

test('no legacy database: nothing imported and none created', async () => {
    const repo = new IdbRepository({ dbName: 'li-none' });
    const r = await importLegacyIfPresent(repo);
    assert.equal(r.status, 'none');
    const dbs = await indexedDB.databases();
    assert.equal(dbs.some(d => d.name === LEGACY_DB), false);
});

test('legacy sessions with identical names are split by time range, flagged, imported once', async () => {
    await seedLegacy();
    const repo = new IdbRepository({ dbName: 'li-new' });
    let n = 0;
    const r = await importLegacyIfPresent(repo, { newId: () => 'L' + (++n), wallIso: '2026-10-12T00:00:00.000Z' });
    assert.equal(r.status, 'imported');
    assert.equal(r.sessions, 3);
    assert.equal(r.readings, 6);
    const sessions = (await repo.listSessions()).sort((a, b) => a.startedWall.localeCompare(b.startedWall));
    assert.deepEqual(sessions.map(s => s.name), ['Trial', 'Trial', 'Other']);
    assert.ok(sessions.every(s => s.state === 'imported'));
    assert.match(sessions[0].provenance.nameCollision, /heuristic/);
    const s2 = await repo.readSnapshot(sessions[1].sessionId);
    assert.deepEqual(s2.chunks[0].cols.v, [51, 52, 53]);
    assert.ok(s2.chunks[0].cols.f.every(f => f & Q.HOST_TIME_ONLY));
    assert.equal(s2.annotations.length, 1);
    assert.equal(s2.annotations[0].relS, 0.15);
    const again = await importLegacyIfPresent(repo);
    assert.equal(again.status, 'already-imported');
    assert.equal((await repo.listSessions()).length, 3);
    // legacy DB untouched
    const dbs = await indexedDB.databases();
    assert.ok(dbs.some(d => d.name === LEGACY_DB));
});

test('convertLegacy handles empty input', () => {
    assert.deepEqual(convertLegacy({ sessions: [], recordings: [], annotations: [] }, { newId: () => 'x', importedWall: 'w' }), []);
});
