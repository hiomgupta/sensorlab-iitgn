/**
 * Recording lifecycle: confirmation → preflight → keep-awake → header → counters → pipeline → startup
 * verification → health/stale/recovery → stop/finalization. Runs through the REAL Web Bluetooth driver over a
 * W3C-API mock, the real Recorder and IndexedDB (fake-indexeddb). Evidence class: SIMULATED INTEGRATION.
 */
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../../src/util/clock.js';
import { WebBluetoothTransport } from '../../src/transport/web-bluetooth.js';
import { AcquisitionService } from '../../src/acquisition/acquisition-service.js';
import { STATES as DEV } from '../../src/acquisition/device-connection.js';
import { SessionController } from '../../src/acquisition/session-controller.js';
import { SESSION, SessionStateMachine, IllegalTransition, deriveHealth } from '../../src/acquisition/session-state.js';
import { StreamHealth, thresholds } from '../../src/acquisition/stream-health.js';
import { IdbRepository } from '../../src/storage/idb-repository.js';
import { Recorder, findInterruptedSessions } from '../../src/storage/recorder.js';
import { buildCsvParts, parseCsv, CSV_COLUMNS, iterateReadings } from '../../src/export/export.js';
import { Q } from '../../src/acquisition/quality.js';
import { SimulatedTransport } from '../../src/transport/simulated.js';
import { FakePeripheral, installFakeNavigatorBluetooth } from '../helpers/fake-web-bluetooth.js';

class FakeKeepAwake {
    constructor(result = 'active') { this.result = result; this.mechanism = 'fake'; this.calls = []; this._s = { state: 'not_requested' }; this._cbs = new Set(); }
    onChange(cb) { this._cbs.add(cb); }
    status() { return { ...this._s }; }
    async enable() { this.calls.push('enable'); this._s = { state: this.result, reason: this.result === 'active' ? null : 'denied' }; return this.status(); }
    async disable() { this.calls.push('disable'); this._s = { state: 'not_requested' }; return this.status(); }
}

class FaultyRepo {
    constructor(inner) { this.inner = inner; this.fail = new Set(); }
    _f(op) { if (this.fail.has(op)) { const e = new Error(`${op} failed: QuotaExceededError`); e.causeName = 'QuotaExceededError'; e.quota = true; throw e; } }
    async createSession(s) { this._f('createSession'); return this.inner.createSession(s); }
    async appendChunk(...a) { this._f('appendChunk'); return this.inner.appendChunk(...a); }
    async updateSession(...a) { this._f('updateSession'); return this.inner.updateSession(...a); }
    async putAnnotation(a) { return this.inner.putAnnotation(a); }
    async listSessions() { return this.inner.listSessions(); }
    async readSnapshot(id) { return this.inner.readSnapshot(id); }
    async getSession(id) { return this.inner.getSession(id); }
    async recoverSession(...a) { return this.inner.recoverSession(...a); }
}

let n = 0;
async function rig({ peripherals = [{}], keepAwake = 'active', storage = { ready: true }, config = {} } = {}) {
    const clock = new ManualClock({ seed: 5 });
    const inner = new IdbRepository({ dbName: 'life-' + (++n) });
    const repo = new FaultyRepo(inner);
    let id = 0;
    const recorder = new Recorder({ repo, clock, locks: null, newId: () => `S${n}-${++id}`, persist: async () => null });
    const service = new AcquisitionService({ clock });
    service.recorder = recorder;
    const ka = new FakeKeepAwake(keepAwake);
    const ctl = new SessionController({ service, keepAwake: ka, clock, storageStatus: async () => storage, config });
    const ps = peripherals.map((o, i) => new FakePeripheral({ clock, id: `P${i}`, serial: `DEV${i}`, ...o }));
    installFakeNavigatorBluetooth(ps);
    const t = new WebBluetoothTransport({ clock });
    const entries = [];
    for (let i = 0; i < ps.length; i++) entries.push(service.addDevice(await t.requestDevice({}), { kind: 'sltp' }));
    await clock.advance(300);
    return { clock, inner, repo, recorder, service, ka, ctl, ps, entries, all: entries.map(e => e.handle) };
}

/** advance until promise settles (ManualClock drives all timers) */
async function run(clock, p, stepMs = 100, maxMs = 60_000) {
    let done = false, val, err;
    p.then(v => { done = true; val = v; }, e => { done = true; err = e; });
    for (let t = 0; t < maxMs && !done; t += stepMs) await clock.advance(stepMs);
    if (err) throw err;
    assert.ok(done, 'operation did not settle');
    return val;
}

const types = (ctl) => ctl.events.map(e => e.type);

// ── state machine ────────────────────────────────────────────────────────────
test('session state machine rejects illegal transitions and derives health', () => {
    const sm = new SessionStateMachine();
    assert.throws(() => sm.to(SESSION.RECORDING), IllegalTransition);
    sm.to(SESSION.PREFLIGHT); sm.to(SESSION.STARTING); sm.to(SESSION.RECORDING);
    assert.throws(() => sm.to(SESSION.PREFLIGHT), IllegalTransition);
    sm.to(SESSION.DEGRADED); sm.to(SESSION.RECOVERING); sm.to(SESSION.RECORDING); sm.to(SESSION.STOPPING);
    assert.throws(() => sm.to(SESSION.RECORDING), IllegalTransition, 'cannot resume after stop');
    sm.to(SESSION.COMPLETED); sm.to(SESSION.IDLE);
    assert.equal(deriveHealth(['FRESH', 'FRESH']), SESSION.RECORDING);
    assert.equal(deriveHealth(['FRESH', 'STALE']), SESSION.DEGRADED);
    assert.equal(deriveHealth(['RECOVERING', 'STALE']), SESSION.RECOVERING);
    assert.equal(deriveHealth(['STALE', 'DISCONNECTED']), SESSION.INTERRUPTED);
    assert.equal(deriveHealth(['FRESH', 'IDLE_ON_CHANGE', 'REMOVED']), SESSION.RECORDING);
});

// ── 1/4/5 preflight ──────────────────────────────────────────────────────────
test('fatal preflight (no devices / storage unavailable / device not connected) creates no session', async () => {
    const r = await rig({ storage: { ready: false, error: 'IndexedDB blocked' } });
    const res = await run(r.clock, r.ctl.start({ name: 'x', include: r.all }));
    assert.equal(res.ok, false);
    assert.equal(res.stage, 'preflight');
    assert.ok(res.preflight.fatal.some(f => f.code === 'STORAGE_UNAVAILABLE'));
    assert.equal(r.ctl.state, SESSION.IDLE);
    assert.equal((await r.inner.listSessions()).length, 0);
    assert.deepEqual(r.ka.calls, [], 'keep-awake not acquired on fatal preflight');

    const r2 = await rig();
    assert.equal((await run(r2.clock, r2.ctl.start({ name: 'x', include: [] }))).preflight.fatal[0].code, 'NO_DEVICES');
    r2.ps[0].failConnects = 99; r2.ps[0].linkLoss();
    await r2.clock.advance(200_000);
    assert.equal(r2.entries[0].conn.state, DEV.DEAD);
    const res2 = await run(r2.clock, r2.ctl.start({ name: 'x', include: r2.all }));
    assert.ok(res2.preflight.fatal.some(f => f.code === 'DEVICE_NOT_CONNECTED'));
    assert.equal((await r2.inner.listSessions()).length, 0);
});

test('preflight warnings (excluded device, keep-awake unsupported) do not block; excluded device not recorded', async () => {
    const r = await rig({ peripherals: [{}, {}] });
    const pf = await r.ctl.preflight([r.all[0]], { keepAwake: true });
    assert.equal(pf.ok, true);
    assert.ok(pf.warnings.some(w => w.code === 'DEVICE_EXCLUDED'));
    assert.equal(pf.streams.length, 2);
    assert.deepEqual(pf.streams.map(s => s.unit), ['µε', '°C']);
    const res = await run(r.clock, r.ctl.start({ name: 'one device', include: [r.all[0]] }));
    assert.equal(res.ok, true);
    await r.clock.advance(1000);
    await run(r.clock, r.ctl.stop());
    const snap = await r.inner.readSnapshot(res.sessionId);
    const ids = new Set(snap.chunks.flatMap(c => c.cols.d.map(i => c.dict[i])));
    assert.deepEqual([...ids], ['ble:DEV0'], 'only the selected device was recorded');
    assert.deepEqual(Object.keys(snap.session.devices), ['ble:DEV0']);
});

// ── 2/3 keep-awake defaults and policy ──────────────────────────────────────
test('keep-awake requested by default, can be disabled, and a failure is a warning (not claimed active)', async () => {
    const r = await rig({ keepAwake: 'failed' });
    const res = await run(r.clock, r.ctl.start({ name: 'k', include: r.all })); // keepAwake defaults to true
    assert.equal(res.ok, true, 'wake-lock failure alone does not block recording');
    assert.deepEqual(r.ka.calls, ['enable']);
    const ev = r.ctl.events.find(e => e.type === 'keep_awake');
    assert.equal(ev.state, 'failed');
    assert.equal((await r.inner.getSession(res.sessionId)).lifecycle.keepAwake.state, 'failed');
    await run(r.clock, r.ctl.stop());
    assert.deepEqual(r.ka.calls, ['enable', 'disable'], 'released at the end of recording');

    const r2 = await rig();
    r2.ctl.acknowledge();
    const res2 = await run(r2.clock, r2.ctl.start({ name: 'k2', include: r2.all, keepAwake: false }));
    assert.equal(res2.ok, true);
    assert.deepEqual(r2.ka.calls, [], 'user disabled keep-awake: never requested');
    assert.equal(r2.ctl.events.find(e => e.type === 'keep_awake').state, 'not_requested');
});

// ── 7/8 ordering and verification ───────────────────────────────────────────
test('header persisted before any sample; STARTING until each selected device delivers valid data; then RECORDING', async () => {
    const r = await rig();
    const order = [];
    const origCreate = r.repo.createSession.bind(r.repo);
    r.repo.createSession = async (s) => { order.push('header'); return origCreate(s); };
    const origAppend = r.recorder.append.bind(r.recorder);
    r.recorder.append = (x) => { if (!order.includes('sample')) order.push('sample'); return origAppend(x); };
    r.ps[0].silent = true;
    const p = r.ctl.start({ name: 'order', include: r.all });
    await r.clock.advance(2000);
    assert.equal(r.ctl.state, SESSION.STARTING, 'no healthy state without samples');
    assert.deepEqual(order, ['header']);
    r.ps[0].silent = false;
    const res = await run(r.clock, p);
    assert.equal(res.ok, true);
    assert.equal(r.ctl.state, SESSION.RECORDING);
    assert.deepEqual(order, ['header', 'sample']);
    const t = types(r.ctl);
    assert.ok(t.indexOf('preflight') < t.indexOf('keep_awake') && t.indexOf('keep_awake') < t.indexOf('pipeline_active') && t.indexOf('pipeline_active') < t.indexOf('startup_verified'));
});

test('invalid-only data does not pass startup verification', async () => {
    const r = await rig();
    r.ps[0].invalid = true;
    const res = await run(r.clock, r.ctl.start({ name: 'invalid', include: r.all }));
    assert.equal(res.ok, false);
    assert.equal(res.stage, 'verification');
});

test('required raw ADC channel permits startup while optional resistance remains null and exported', async () => {
    const r = await rig({ peripherals: [{ model: 'SLab-R1' }] });
    r.ps[0].invalidChannels = [true, false];
    const res = await run(r.clock, r.ctl.start({ name: 'raw ADC valid', include: r.all }));
    assert.equal(res.ok, true);
    assert.deepEqual(r.ctl.startup.verifiedDevices, ['ble:DEV0']);
    assert.deepEqual(r.ctl.startup.requiredStreams, ['ble:DEV0|0']);
    assert.deepEqual(r.ctl.startup.verifiedStreams, ['ble:DEV0|0']);
    assert.equal(r.ctl.state, SESSION.DEGRADED);

    await r.clock.advance(500);
    const summary = await run(r.clock, r.ctl.stop());
    const snap = await r.inner.readSnapshot(res.sessionId);
    const readings = [...iterateReadings(snap)];
    const bySequence = new Map();
    for (const reading of readings) {
        if (!bySequence.has(reading.seq)) bySequence.set(reading.seq, new Set());
        bySequence.get(reading.seq).add(reading.channelId);
    }
    assert.ok(bySequence.size > 0);
    assert.ok([...bySequence.values()].every(channels => channels.size === 2), 'each accepted packet persists one row per channel');
    assert.equal(readings.length, summary.persisted);
    const invalid = readings.filter(r => r.channelId === 1);
    assert.ok(invalid.length > 0);
    assert.ok(invalid.every(r => r.value === null && (r.flags & Q.INVALID) !== 0));
    const { parts, rows } = buildCsvParts(snap);
    assert.equal(rows, readings.length);
    const csvRows = parseCsv(parts.join(''));
    const invalidCsv = csvRows.slice(1).map(row => Object.fromEntries(CSV_COLUMNS.map((column, i) => [column, row[i]])))
        .filter(row => row.channel_id === '1');
    assert.equal(invalidCsv.length, invalid.length);
    assert.ok(invalidCsv.every(row => row.value === '' && row.valid === '0' && row.quality_flags.includes('invalid')));
});

test('optional resistance cannot satisfy startup when the required SLab-R1 raw ADC channel is invalid', async () => {
    const r = await rig({ peripherals: [{ model: 'SLab-R1' }] });
    r.ps[0].invalidChannels = [false, true];
    const res = await run(r.clock, r.ctl.start({ name: 'optional only', include: r.all }));
    assert.equal(res.ok, false);
    assert.equal(res.stage, 'verification');
    assert.deepEqual(res.missing, ['ble:DEV0|0']);
});

// ── 9 startup timeout & rollback ─────────────────────────────────────────────
test('startup timeout: START_FAILED, session finalised as startup_failed with diagnostics, keep-awake released', async () => {
    const r = await rig({ peripherals: [{}, {}], config: { startupTimeoutMs: 3000 } });
    r.ps[1].silent = true;
    const res = await run(r.clock, r.ctl.start({ name: 'timeout', include: r.all }));
    assert.equal(res.ok, false);
    assert.equal(res.stage, 'verification');
    assert.deepEqual(res.missing.sort(), ['ble:DEV1|0', 'ble:DEV1|1']);
    assert.equal(r.ctl.state, SESSION.START_FAILED);
    const s = await r.inner.getSession(res.sessionId);
    assert.equal(s.state, 'startup_failed', 'not presented as a completed recording');
    assert.ok(s.lifecycle.events.some(e => e.type === 'startup_failed' && e.diagnostics.length === 4));
    assert.deepEqual(r.ka.calls, ['enable', 'disable']);
    assert.equal(r.service.recording, false);
    r.ctl.acknowledge();
    r.ps[1].silent = false;
    const retry = await run(r.clock, r.ctl.start({ name: 'retry', include: r.all }));
    assert.equal(retry.ok, true, 'retry path works');
});

test('session header write failure: START_FAILED, resources released, nothing recording', async () => {
    const r = await rig();
    r.repo.fail.add('createSession');
    const res = await run(r.clock, r.ctl.start({ name: 'h', include: r.all }));
    assert.equal(res.stage, 'header');
    assert.equal(r.ctl.state, SESSION.START_FAILED);
    assert.equal(r.service.recording, false);
    assert.equal(r.recorder.state, 'idle', 'recorder rolled back');
    assert.deepEqual(r.ka.calls, ['enable', 'disable']);
    assert.equal((await r.inner.listSessions()).length, 0);
});

// ── 10 duplicate submissions ─────────────────────────────────────────────────
test('duplicate Record submissions create exactly one session (controller and recorder guards; defect D24)', async () => {
    const r = await rig();
    const a = r.ctl.start({ name: 'dup', include: r.all }), b = r.ctl.start({ name: 'dup', include: r.all });
    const [ra, rb] = [await run(r.clock, a), await b];
    assert.equal(ra.ok, true);
    assert.equal(rb.stage, 'duplicate');
    assert.equal((await r.inner.listSessions()).length, 1);
    // recorder-level guard (the original defect)
    const clock = new ManualClock();
    const repo = new IdbRepository({ dbName: 'dup-rec-' + (++n) });
    const rec = new Recorder({ repo, clock, locks: null, persist: async () => null, newId: (() => { let i = 0; return () => 'r' + (++i); })() });
    const both = await Promise.allSettled([rec.start({ name: 'x' }), rec.start({ name: 'x' })]);
    assert.deepEqual(both.map(x => x.status).sort(), ['fulfilled', 'rejected']);
    assert.equal((await repo.listSessions()).length, 1);
});

// ── 11 stale detection relative to rate ──────────────────────────────────────
test('stale detection scales with each stream\'s expected interval (50 Hz vs 1 Hz)', async () => {
    const r = await rig({ peripherals: [{ periodUs: 20_000 }, { periodUs: 1_000_000 }] });
    const res = await run(r.clock, r.ctl.start({ name: 'rates', include: r.all }));
    assert.equal(res.ok, true);
    assert.deepEqual(thresholds(20), { suspectMs: 500, staleMs: 1000 }, 'floors apply to fast streams (BLE batching)');
    assert.deepEqual(thresholds(1000), { suspectMs: 3000, staleMs: 5000 });
    r.ps[0].silent = true; r.ps[1].silent = true;
    await r.clock.advance(1600);
    const st = Object.fromEntries(r.ctl.streamView().map(s => [s.key, s.state]));
    assert.equal(st['ble:DEV0|0'], 'STALE', '50 Hz stream silent 1.6 s is stale');
    assert.equal(st['ble:DEV1|0'], 'FRESH', '1 Hz stream silent 1.6 s is normal');
    await r.clock.advance(4000);
    assert.equal(Object.fromEntries(r.ctl.streamView().map(s => [s.key, s.state]))['ble:DEV1|0'], 'STALE');
    const ev = r.ctl.events.filter(e => e.type === 'stream_state' && e.to === 'STALE');
    assert.ok(ev.every(e => e.lastValid && Number.isFinite(e.lastValid.relS)), 'last valid sample preserved in the event');
    assert.equal(r.ctl.state, SESSION.INTERRUPTED);
});

test('on-change streams are not judged stale from silence', () => {
    const h = new StreamHealth();
    const e = { deviceId: 'd', handle: 'h', profile: { onChange: true }, channels: [{ channelId: 0, name: 'battery', unit: '%' }], conn: { state: DEV.STREAMING, subscribedAtMs: 0 } };
    h.track(e, 0);
    h.evaluate(60_000, [e]);
    assert.equal(h.list()[0].state, 'IDLE_ON_CHANGE');
});

// ── 12/13/14 device-scoped disconnect, recovery, no duplicates ──────────────
test('one device disconnects: its streams RECOVERING, other keeps recording; reconnect → FRESH only after new samples; no duplicates', async () => {
    const r = await rig({ peripherals: [{}, {}] });
    const res = await run(r.clock, r.ctl.start({ name: 'scoped', include: r.all }));
    assert.equal(res.ok, true);
    await r.clock.advance(1000);
    const bBefore = r.entries[1].tracker.snapshot().received;
    r.ps[0].failConnects = 2; // two failed attempts before recovery
    r.ps[0].linkLoss();
    await r.clock.advance(300);
    const view = Object.fromEntries(r.ctl.streamView().map(s => [s.key, s.state]));
    assert.equal(view['ble:DEV0|0'], 'RECOVERING');
    assert.equal(view['ble:DEV1|0'], 'FRESH');
    assert.equal(r.ctl.state, SESSION.DEGRADED);
    assert.equal(r.entries[1].conn.state, DEV.STREAMING, 'other device unaffected');
    await r.clock.advance(8000);
    assert.equal(r.entries[0].conn.state, DEV.STREAMING);
    assert.equal(r.ctl.state, SESSION.RECORDING);
    assert.ok(r.entries[1].tracker.snapshot().received > bBefore + 100);
    assert.equal(r.ps[0].subscribed.size, 1, 'one subscription after repeated attempts');
    const t = types(r.ctl);
    for (const k of ['device_disconnected', 'device_reconnecting', 'device_reconnected', 'device_streaming']) assert.ok(t.includes(k), k);
    const sum = await run(r.clock, r.ctl.stop());
    assert.equal(sum.ok, true);
    const snap = await r.inner.readSnapshot(res.sessionId);
    const seq = snap.chunks.flatMap(c => c.cols.q.filter((_, i) => c.dict[c.cols.d[i]] === 'ble:DEV0' && c.cols.c[i] === 0));
    assert.equal(new Set(seq).size, seq.length, 'no duplicate samples');
    const gapInData = seq[seq.length - 1] - seq[0] + 1 - seq.length;
    assert.ok(gapInData > 0);
    assert.equal(snap.session.quality['ble:DEV0'].stream.missing, gapInData, 'disconnection interval recorded as a gap');
    assert.ok(snap.session.lifecycle.events.some(e => e.type === 'device_disconnected'), 'lifecycle events persisted');
});

test('retry exhaustion → DISCONNECTED stream, session INTERRUPTED; manual retry recovers', async () => {
    const r = await rig();
    await run(r.clock, r.ctl.start({ name: 'dead', include: r.all }));
    r.ps[0].failConnects = 1e6;
    r.ps[0].linkLoss();
    await r.clock.advance(200_000);
    assert.equal(r.entries[0].conn.state, DEV.DEAD);
    assert.equal(r.ctl.streamView()[0].state, 'DISCONNECTED');
    assert.equal(r.ctl.state, SESSION.INTERRUPTED);
    assert.ok(types(r.ctl).includes('device_failed'));
    r.ps[0].failConnects = 0;
    r.service.retry(r.all[0]);
    await r.clock.advance(2000);
    assert.equal(r.ctl.state, SESSION.RECORDING);
});

// ── 15/22 identity, timestamps, units, gaps, export agreement ───────────────
test('export agrees with stored samples, units, session id, and quality counters', async () => {
    const r = await rig();
    const res = await run(r.clock, r.ctl.start({ name: 'export', include: r.all }));
    await r.clock.advance(1000);
    r.ps[0].linkLoss();
    await r.clock.advance(4000);
    await run(r.clock, r.ctl.stop());
    const snap = await r.inner.readSnapshot(res.sessionId);
    const table = parseCsv(buildCsvParts(snap).parts.join(''));
    const col = Object.fromEntries(CSV_COLUMNS.map((c, i) => [c, i]));
    const stored = snap.chunks.reduce((a, c) => a + c.n, 0);
    assert.equal(table.length - 1, stored);
    assert.ok(table.slice(1).every(row => row[col.session_id] === res.sessionId));
    assert.deepEqual(new Set(table.slice(1).map(row => row[col.unit])), new Set(['µε', '°C']));
    const ch0 = table.slice(1).filter(row => row[col.channel_id] === '0').map(row => Number(row[col.sequence]));
    assert.equal(snap.session.quality['ble:DEV0'].stream.missing, ch0[ch0.length - 1] - ch0[0] + 1 - ch0.length);
    assert.equal(snap.session.quality['ble:DEV0'].stream.received, ch0.length);
    const gapRows = table.slice(1).filter(row => row[col.quality_flags].includes('gap_before'));
    assert.equal(gapRows.length, 2, 'gap flagged on both channels of the first sample after the gap');
});

// ── 16 storage failures during recording / stop / finalization ──────────────
test('storage failure during recording is surfaced and retried; failure at finalization gives FINALIZE_FAILED (no false success)', async () => {
    const r = await rig();
    const res = await run(r.clock, r.ctl.start({ name: 'faults', include: r.all }));
    r.repo.fail.add('appendChunk');
    await r.clock.advance(1000);
    assert.ok(r.recorder.status().lastError?.quota);
    assert.ok([SESSION.RECORDING, SESSION.DEGRADED].includes(r.ctl.state), 'acquisition continues');
    r.repo.fail.delete('appendChunk');
    await r.clock.advance(3000);
    assert.equal(r.recorder.status().lastError, null);
    r.repo.fail.add('updateSession');
    const sum = await run(r.clock, r.ctl.stop());
    assert.equal(sum.ok, false);
    assert.equal(sum.closed, false);
    assert.equal(r.ctl.state, SESSION.FINALIZE_FAILED);
    // interrupted finalization is recoverable on next launch
    const interrupted = await findInterruptedSessions(r.inner, { locks: null, nowWall: Date.now() + 3600_000 });
    assert.deepEqual(interrupted.map(s => s.sessionId), [res.sessionId]);
    const rec = await r.inner.recoverSession(res.sessionId, 'w');
    assert.equal(rec.state, 'recovered');
    assert.ok(rec.lifecycle.events.some(e => e.type === 'finalizing'), 'lifecycle trail survives for diagnosis');
});

// ── 17 repeated stop ────────────────────────────────────────────────────────
test('repeated/concurrent Stop shares one finalization; Stop after completion is a no-op', async () => {
    const r = await rig();
    await run(r.clock, r.ctl.start({ name: 'stop', include: r.all }));
    const a = r.ctl.stop(), b = r.ctl.stop();
    assert.equal(a, b);
    const sum = await run(r.clock, a);
    assert.equal(sum.ok, true);
    assert.equal(r.ctl.state, SESSION.COMPLETED);
    assert.equal(await r.ctl.stop(), null);
    assert.equal(r.recorder.lastSummary.finalState, 'closed');
});

test('Stop during startup cancels cleanly (session marked startup_cancelled, not a recording)', async () => {
    const r = await rig();
    r.ps[0].silent = true;
    const p = r.ctl.start({ name: 'cancel', include: r.all });
    await r.clock.advance(500);
    r.ctl.stop();
    const res = await run(r.clock, p);
    assert.equal(res.stage, 'cancelled');
    assert.equal((await r.inner.getSession(res.sessionId)).state, 'startup_cancelled');
    assert.equal(r.ctl.state, SESSION.COMPLETED);
});

// Readiness audit defect R1: Cancel/Stop pressed while preflight, the keep-awake request or the session-header write was
// still pending was ignored (stop() returned null) and the recording started anyway.
test('Cancel during PREFLIGHT or before verification begins is honoured (no recording starts)', async () => {
    const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };

    // (a) during preflight: no session is created, back to IDLE
    {
        const r = await rig();
        const g = gate();
        r.ctl.storageStatus = async () => { await g.p; return { ready: true }; };
        const p = r.ctl.start({ name: 'pf', include: r.all });
        await r.clock.advance(10);
        assert.equal(r.ctl.state, SESSION.PREFLIGHT);
        const sp = r.ctl.stop();
        assert.ok(sp && typeof sp.then === 'function', 'stop() during preflight returns the start outcome');
        g.open();
        const res = await run(r.clock, p);
        assert.equal(res.ok, false);
        assert.equal(res.stage, 'cancelled');
        assert.equal(r.ctl.state, SESSION.IDLE);
        assert.equal((await r.inner.listSessions()).length, 0, 'no session created');
        assert.equal(r.service.recording, false);
    }
    // (b) during the keep-awake request: no session is created, keep-awake released, back to IDLE
    {
        const r = await rig();
        const g = gate();
        const en = r.ka.enable.bind(r.ka);
        r.ka.enable = async () => { await g.p; return en(); };
        const p = r.ctl.start({ name: 'ka', include: r.all });
        await r.clock.advance(10);
        assert.equal(r.ctl.state, SESSION.STARTING);
        r.ctl.stop();
        g.open();
        const res = await run(r.clock, p);
        assert.equal(res.stage, 'cancelled');
        assert.equal(r.ctl.state, SESSION.IDLE);
        assert.equal((await r.inner.listSessions()).length, 0, 'no session created');
        assert.equal(r.ka.calls.at(-1), 'disable', 'keep-awake released');
        assert.equal(r.service.recording, false);
    }
    // (c) during the session-header write: the created session is finalised as startup_cancelled
    {
        const r = await rig();
        const g = gate();
        const create = r.repo.createSession.bind(r.repo);
        r.repo.createSession = async (s) => { await g.p; return create(s); };
        const p = r.ctl.start({ name: 'hdr', include: r.all });
        await r.clock.advance(10);
        assert.equal(r.ctl.state, SESSION.STARTING);
        r.ctl.stop();
        g.open();
        const res = await run(r.clock, p);
        assert.equal(res.stage, 'cancelled');
        assert.equal((await r.inner.getSession(res.sessionId)).state, 'startup_cancelled');
        assert.notEqual(r.ctl.state, SESSION.RECORDING);
        assert.equal(r.service.recording, false);
    }
});

// ── 18 visibility and lifecycle interruptions ───────────────────────────────
test('visibility changes, timer stalls and wall-clock jumps are logged as lifecycle events', async () => {
    const r = await rig();
    await run(r.clock, r.ctl.start({ name: 'life', include: r.all }));
    r.ctl.noteVisibility(true);
    r.ctl.noteVisibility(false);
    r.ctl.noteLifecycle('freeze');
    r.clock.t += 10_000; // timers did not run for 10 s (frozen tab / suspended system)
    await r.clock.advance(300);
    r.clock.wallStart += 5_000; // wall clock jumps (system slept)
    await r.clock.advance(300);
    const t = types(r.ctl);
    assert.ok(t.includes('app_hidden') && t.includes('app_visible') && t.includes('lifecycle'));
    const gaps = r.ctl.events.filter(e => e.type === 'lifecycle_gap').map(e => e.kind);
    assert.ok(gaps.includes('timer_stall') && gaps.includes('wall_clock_jump'), JSON.stringify(gaps));
    // persisted (not only in memory): flush, then read the stored session (defect D29)
    await r.recorder.flush();
    const stored = (await r.inner.getSession(r.service.sessionId)).lifecycle.events.filter(e => e.type === 'lifecycle_gap').map(e => e.kind);
    assert.ok(stored.includes('timer_stall') && stored.includes('wall_clock_jump'), 'lifecycle gaps persisted: ' + JSON.stringify(stored));
});

// ── 19 device removal ───────────────────────────────────────────────────────
test('device removed during recording: quality summary kept, excluded from health, others continue', async () => {
    const r = await rig({ peripherals: [{}, {}] });
    const res = await run(r.clock, r.ctl.start({ name: 'remove', include: r.all }));
    await r.clock.advance(1000);
    await r.service.removeDevice(r.all[0]);
    await r.clock.advance(1000);
    assert.equal(r.ctl.state, SESSION.RECORDING, 'removed device does not degrade the session');
    await run(r.clock, r.ctl.stop());
    const s = await r.inner.getSession(res.sessionId);
    assert.ok(s.quality['ble:DEV0'].stream.received > 0);
    assert.ok(s.lifecycle.events.some(e => e.type === 'device_removed'));
});

// ── 21 recovery of previously saved sessions ────────────────────────────────
test('crash during recording: session detected as interrupted and recovered with its lifecycle trail', async () => {
    const r = await rig();
    const res = await run(r.clock, r.ctl.start({ name: 'crash', include: r.all }));
    await r.clock.advance(2000);
    // simulate tab death: no stop(), timers gone
    r.recorder.state = 'dead'; r.recorder._timer && r.clock.clearTimeout(r.recorder._timer); r.ctl._stopTicks();
    const found = await findInterruptedSessions(r.inner, { locks: null, nowWall: Date.now() + 3600_000 });
    assert.deepEqual(found.map(s => s.sessionId), [res.sessionId]);
    const rec = await r.inner.recoverSession(res.sessionId, 'w');
    assert.equal(rec.state, 'recovered');
    assert.ok(rec.recovery.persistedReadings > 0);
    assert.ok(rec.lifecycle.events.some(e => e.type === 'startup_verified'));
});

// ── demo devices through the same controller ────────────────────────────────
test('simulated demo devices go through the same lifecycle (SIMULATED warning in preflight)', async () => {
    const clock = new ManualClock();
    const service = new AcquisitionService({ clock });
    service.recorder = new Recorder({ repo: new IdbRepository({ dbName: 'life-sim-' + (++n) }), clock, locks: null, persist: async () => null });
    const sim = new SimulatedTransport({ clock });
    const e = service.addDevice(sim.addDevice({ serial: 'S1', periodUs: 100_000, channels: [{ name: 'v', unit: 'V', scale: 0.001, offset: 0, signal: { type: 'sine' } }] }), { kind: 'sltp' });
    await clock.advance(500);
    const ctl = new SessionController({ service, keepAwake: new FakeKeepAwake(), clock });
    const pf = await ctl.preflight([e.handle]);
    assert.ok(pf.warnings.some(w => w.code === 'SIMULATED'));
    const res = await run(clock, ctl.start({ name: 'sim', include: [e.handle] }));
    assert.equal(res.ok, true);
});

test('lifecycle event log is bounded and counts what it drops (never silent)', async () => {
    const r = await rig();
    const res = await run(r.clock, r.ctl.start({ name: 'many events', include: r.all }));
    for (let i = 0; i < 1200; i++) r.ctl.noteLifecycle('test-event', { i });
    const lc = r.ctl.lifecycle();
    assert.equal(lc.events.length, 1000);
    assert.ok(lc.eventsDropped >= 200);
    await run(r.clock, r.ctl.stop());
    const s = await r.inner.getSession(res.sessionId);
    assert.ok(s.lifecycle.eventsDropped >= 200, 'drop count persisted');
});
