import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdbRepository } from '../../src/storage/idb-repository.js';
import { Recorder } from '../../src/storage/recorder.js';
import { ManualClock } from '../../src/util/clock.js';
import { CloudSync, cloudDocuments, splitCloudText, MAX_CLOUD_PART_BYTES } from '../../src/cloud/sync.js';
import { validateCloudConfig, cloudCsp } from '../../scripts/cloud-config.mjs';

let dbn = 0;
const repoForTest = () => new IdbRepository({ dbName: `cloud-test-${++dbn}` });
const userA = { uid: 'account-a', email: 'a@example.test', displayName: 'A' };
const userB = { uid: 'account-b', email: 'b@example.test', displayName: 'B' };
function fakeBackend() {
    return {
        calls: [], documents: new Map(), failPart: false, onPart: null,
        async verifyUser(uid) { this.calls.push(['verify', uid]); },
        async saveProfile(user) { this.calls.push(['profile', user.uid]); },
        async savePart(uid, id, part) {
            this.calls.push(['part', uid, id, part.id]);
            if (this.failPart) { this.failPart = false; throw new Error('network disconnected'); }
            this.documents.set(`${uid}/${id}/${part.id}`, structuredClone(part.data));
            if (this.onPart) await this.onPart();
        },
        async completeSession(uid, id, manifest) {
            this.calls.push(['complete', uid, id]);
            this.documents.set(`${uid}/${id}`, structuredClone(manifest));
        },
    };
}
async function recordedSession(repo, id, { readings = 3, stop = true } = {}) {
    const rec = new Recorder({ repo, clock: new ManualClock(), locks: null, persist: async () => false, newId: () => id });
    await rec.start({ name: id });
    for (let i = 0; i < readings; i++) rec.append({
        deviceId: 'sim:cloud', channelId: 0, seq: i, devUs: i, hostMs: i,
        relS: i / 1000, raw: i, value: i, flags: 0,
    });
    if (stop) {
        await rec.addAnnotation({ relS: 0, text: 'cloud test \ud83e\uddea' });
        await rec.stop();
    }
    return rec;
}
async function signedIn(repo, backend, options = {}, user = userA) {
    const sync = new CloudSync({ repo, backend, online: () => true, ...options });
    await sync.init();
    await sync.setUser(user);
    return sync;
}
function reconstructed(backend, uid, id, kind, sourceId) {
    const parts = [...backend.documents.entries()]
        .filter(([key, value]) => key.startsWith(`${uid}/${id}/`) && value.kind === kind && value.sourceId === sourceId)
        .map(([, value]) => value).sort((a, b) => a.partNo - b.partNo);
    return JSON.parse(parts.map(part => part.payload).join(''));
}

test('offline ownership survives reload; reconnect backs up every reading and annotation, then acknowledges locally', async () => {
    const repo = repoForTest(), backend = fakeBackend();
    await signedIn(repo, backend);
    repo.close();
    let online = false;
    const reloaded = new IdbRepository({ dbName: repo.dbName });
    const sync = new CloudSync({ repo: reloaded, backend, online: () => online });
    await sync.init();
    await recordedSession(reloaded, 'offline-recording');
    assert.equal((await reloaded.getSession('offline-recording')).cloudOwnerUid, userA.uid);
    await sync.setUser(userA);
    await sync.syncNow();
    assert.equal(backend.calls.length, 0);
    assert.equal((await reloaded.getSession('offline-recording')).cloudUploadedAt, null);
    online = true;
    await sync.syncNow();
    assert.ok((await reloaded.getSession('offline-recording')).cloudUploadedAt);
    assert.deepEqual(reconstructed(backend, userA.uid, 'offline-recording', 'chunk', '0').cols.q, [0, 1, 2]);
    assert.equal(reconstructed(backend, userA.uid, 'offline-recording', 'annotations', 'all')[0].text, 'cloud test \ud83e\uddea');
    const manifest = backend.documents.get(`${userA.uid}/offline-recording`);
    assert.equal(manifest.readingCount, 3);
    assert.equal(manifest.annotationCount, 1);
    assert.equal(manifest.documentCount, 3);
    assert.equal(backend.calls.at(-1)[0], 'complete', 'completion manifest is written last');
    const count = backend.calls.length;
    await sync.syncNow();
    assert.equal(backend.calls.length, count, 'acknowledged backups and unchanged profiles are not written repeatedly');
});

test('anonymous sessions remain local; explicit selection cannot reassign another account or an open recording', async () => {
    const repo = repoForTest(), backend = fakeBackend();
    await recordedSession(repo, 'anonymous');
    const sync = await signedIn(repo, backend);
    await recordedSession(repo, 'owned-a');
    await sync.setUser(userB);
    await sync.syncNow();
    assert.equal(backend.calls.filter(call => call[0] === 'part').length, 0);
    await assert.rejects(sync.queueSession('owned-a', userB.uid), /another account/);
    await assert.rejects(sync.queueSession('anonymous', userA.uid), /intended cloud account/);
    await sync.queueSession('anonymous', userB.uid);
    await sync.syncNow();
    assert.ok(backend.documents.has(`${userB.uid}/anonymous`));
    assert.equal((await repo.getSession('owned-a')).cloudUploadedAt, null);
    const rec = await recordedSession(repo, 'active', { stop: false });
    await assert.rejects(sync.queueSession('active', userB.uid), /Stop or recover/);
    await rec.stop();
});

test('sign-out clears future ownership but never changes existing recordings; imports cannot bring cloud identity or acknowledgements', async () => {
    const repo = repoForTest(), backend = fakeBackend();
    const sync = await signedIn(repo, backend);
    await recordedSession(repo, 'before-signout');
    const snapshot = await repo.readSnapshot('before-signout');
    await sync.forgetAccount();
    await recordedSession(repo, 'after-signout');
    assert.equal((await repo.getSession('after-signout')).cloudOwnerUid, undefined);
    assert.equal((await repo.getSession('before-signout')).cloudOwnerUid, userA.uid);
    await sync.syncNow();
    assert.equal(backend.calls.length, 0);
    snapshot.session.sessionId = 'imported-copy';
    snapshot.session.cloudUploadedAt = '2026-01-01';
    await repo.importSnapshot(snapshot);
    const imported = await repo.getSession('imported-copy');
    assert.equal(imported.cloudOwnerUid, undefined);
    assert.equal(imported.cloudUploadedAt, undefined);
});

test('failed and unacknowledged uploads retry idempotently after reload without losing or duplicating rows', async () => {
    const repo = repoForTest(), backend = fakeBackend();
    let sync = await signedIn(repo, backend);
    await recordedSession(repo, 'large', { readings: 20_000 });
    const snapshot = await repo.readSnapshot('large');
    const docs = [...cloudDocuments(snapshot)];
    assert.ok(docs.length > 3, 'large columnar chunk is split across documents');
    for (const part of docs) assert.ok(Buffer.byteLength(part.data.payload, 'utf8') <= MAX_CLOUD_PART_BYTES);
    backend.failPart = true;
    await assert.rejects(sync.syncNow(), /network disconnected/);
    assert.equal(sync.status.phase, 'error');
    assert.equal((await repo.getSession('large')).cloudUploadedAt, null);
    assert.equal(backend.documents.has(`${userA.uid}/large`), false);
    sync = await signedIn(repo, backend);
    const mark = repo.markCloudUploaded.bind(repo);
    repo.markCloudUploaded = async () => { throw new Error('local acknowledgement failed'); };
    await assert.rejects(sync.syncNow(), /acknowledgement/);
    assert.equal((await repo.getSession('large')).cloudUploadedAt, null);
    const remoteCount = backend.documents.size;
    repo.markCloudUploaded = mark;
    await sync.syncNow();
    assert.equal(backend.documents.size, remoteCount, 'retry overwrites the same document IDs');
    assert.deepEqual(reconstructed(backend, userA.uid, 'large', 'chunk', '0').cols.q, snapshot.chunks[0].cols.q);
});

test('switching accounts during upload cancels old-account completion; a busy recorder performs no network work', async () => {
    const repo = repoForTest(), backend = fakeBackend();
    let busy = true;
    const sync = await signedIn(repo, backend, { busy: () => busy });
    await recordedSession(repo, 'switch');
    await sync.syncNow();
    assert.equal(backend.calls.length, 0);
    busy = false;
    backend.onPart = async () => { backend.onPart = null; await sync.setUser(userB); };
    await sync.syncNow();
    assert.equal(backend.documents.has(`${userA.uid}/switch`), false);
    assert.equal((await repo.getSession('switch')).cloudUploadedAt, null);
    await sync.syncNow();
    assert.equal(backend.calls.filter(call => call[0] === 'part' && call[1] === userB.uid).length, 0);
});

test('corrupt snapshots and failed authentication never get completion manifests or local acknowledgements', async () => {
    const repo = repoForTest(), backend = fakeBackend();
    const sync = await signedIn(repo, backend);
    await recordedSession(repo, 'corrupt');
    await repo._run('damage', ['chunks'], 'readwrite', tx => {
        tx.objectStore('chunks').put({ sessionId: 'corrupt', chunkNo: 0, n: 3, cols: {}, dict: [] });
    });

    await assert.rejects(sync.syncNow(), /corrupt or missing/);
    assert.equal(backend.calls.filter(call => call[0] === 'part' || call[0] === 'complete').length, 0);
    backend.verifyUser = async () => { throw new Error('authentication expired'); };
    await assert.rejects(sync.syncNow(), /authentication expired/);
    assert.equal((await repo.getSession('corrupt')).cloudUploadedAt, null);
});

test('a failed account metadata write is surfaced and retried without poisoning future sign-in or sign-out', async () => {
    const repo = repoForTest(), backend = fakeBackend();
    const sync = new CloudSync({ repo, backend, online: () => true });
    await sync.init();
    const setMeta = repo.setMeta.bind(repo);
    repo.setMeta = async () => { throw new Error('temporary storage failure'); };
    await assert.rejects(sync.setUser(userA), /storage failure/);
    assert.equal(sync.status.phase, 'error');
    await assert.rejects(sync.syncNow(), /storage failure/);
    repo.setMeta = setMeta;
    await sync.syncNow();
    assert.equal(sync.getAccount().uid, userA.uid);
    await sync.forgetAccount();
    await sync.setUser(userB);
    assert.equal((await repo.getMeta('cloud-account')).uid, userB.uid);
});

test('unacknowledged requests time out visibly, remain pending, and can be retried', async () => {
    const repo = repoForTest(), backend = fakeBackend();
    const sync = await signedIn(repo, backend, { requestTimeoutMs: 10 });
    await recordedSession(repo, 'timeout');
    const save = backend.savePart.bind(backend);
    backend.savePart = () => new Promise(() => {});
    await assert.rejects(sync.syncNow(), /timed out/);
    assert.equal(sync.status.phase, 'error');
    assert.equal((await repo.getSession('timeout')).cloudUploadedAt, null);
    backend.savePart = save;
    await sync.syncNow();
    assert.ok((await repo.getSession('timeout')).cloudUploadedAt);
});

test('UTF-8 parts preserve multibyte text at boundaries and never exceed the document byte budget', () => {
    const text = JSON.stringify({ note: '\ud83e\uddea\u00e9\u4e2d'.repeat(50_000) });
    for (const limit of [4, 13, MAX_CLOUD_PART_BYTES]) {
        const parts = [...splitCloudText(text, limit)];
        assert.equal(parts.join(''), text);
        for (const part of parts) {
            assert.ok(Buffer.byteLength(part, 'utf8') <= limit);
            assert.equal(Buffer.from(part, 'utf8').toString('utf8'), part);
        }
    }
    assert.throws(() => [...splitCloudText('abc', 0)], RangeError);
});

test('cloud config rejects credentials and arbitrary auth origins while generating a narrowly scoped policy', () => {
    const config = { apiKey: 'public-web-key', authDomain: 'sensorlab-test.firebaseapp.com', projectId: 'sensorlab-test', appId: '1:123:web:abc' };
    const validated = validateCloudConfig(config);
    const csp = cloudCsp(validated);
    assert.ok(csp.includes('frame-src https://sensorlab-test.firebaseapp.com;'));
    assert.ok(!csp.includes('*') && !csp.includes("'unsafe-inline'") && !csp.includes("'unsafe-eval'"));
    assert.throws(() => validateCloudConfig({ ...config, private_key: 'not-allowed' }), /service-account/);
    assert.throws(() => validateCloudConfig({ ...config, authDomain: 'other.example' }), /authDomain/);
    assert.throws(() => validateCloudConfig({ ...config, apiKey: '' }), /apiKey/);
});
