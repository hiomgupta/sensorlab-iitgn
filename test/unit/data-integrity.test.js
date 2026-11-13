/**
 * End-to-end DATA INTEGRITY with deterministic, known inputs.
 * Scripted SLTP packets (known sequence, device timestamps and values) travel through the real Web Bluetooth
 * driver (W3C API mock) → parser → StreamTracker → SessionController/AcquisitionService → Recorder → IndexedDB
 * (fake-indexeddb) → export, and every stored/exported record is compared with the source.
 *
 * Time model (docs/PROTOCOL.md §5, EXPORT_SCHEMA.md): device_time_us = device clock (unwrapped);
 * relative_time_s = device clock anchored at the first recorded sample; rows are in arrival order.
 * Intentional transformations, accounted for in expected results: duplicates are suppressed (counted, not stored),
 * malformed packets are rejected (counted, not stored), late packets are stored and flagged out_of_order.
 * Evidence class: SIMULATED INTEGRATION. These are synthetic test values, not sensor measurements.
 */
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../../src/util/clock.js';
import { WebBluetoothTransport } from '../../src/transport/web-bluetooth.js';
import { AcquisitionService } from '../../src/acquisition/acquisition-service.js';
import { SessionController } from '../../src/acquisition/session-controller.js';
import { SESSION } from '../../src/acquisition/session-state.js';
import { IdbRepository } from '../../src/storage/idb-repository.js';
import { Recorder, findInterruptedSessions } from '../../src/storage/recorder.js';
import { encodeDataPacket } from '../../src/protocol/sltp.js';
import { buildCsvParts, parseCsv, CSV_COLUMNS, buildJson, parseExportJson, iterateReadings } from '../../src/export/export.js';
import { Q } from '../../src/acquisition/quality.js';
import { FakePeripheral, installFakeNavigatorBluetooth } from '../helpers/fake-web-bluetooth.js';

const T0_US = 1_000_000, DT_US = 100_000; // known source time model: 1 s + i × 100 ms
const pkt = (seq, base = 10, timeUs = T0_US + seq * DT_US) => encodeDataPacket({ sequence: seq, deviceTimeUs: timeUs, values: [base + seq, base + 2000 + seq] });
// expected engineering values for the mock's channel map (strain scale 0.1 µε, temp scale 0.01 °C)
const expected = (seq, base, ch) => (ch === 0 ? (base + seq) * 0.1 : (base + 2000 + seq) * 0.01);

class NoKeepAwake { constructor() { this.mechanism = 'fake'; } onChange() {} status() { return { state: 'not_requested' }; } async enable() { return this.status(); } async disable() { return this.status(); } }

let dbn = 0;
async function rig({ devices = 1, periodUs = DT_US, repoWrap = (r) => r, dbName } = {}) {
    const clock = new ManualClock({ seed: 21 });
    const name = dbName || 'integrity-' + (++dbn);
    const inner = new IdbRepository({ dbName: name });
    const repo = repoWrap(inner, clock);
    let id = 0;
    const recorder = new Recorder({ repo, clock, locks: null, newId: () => `${name}-S${++id}`, persist: async () => null });
    const service = new AcquisitionService({ clock });
    service.recorder = recorder;
    const ctl = new SessionController({ service, keepAwake: new NoKeepAwake(), clock });
    const ps = [];
    for (let i = 0; i < devices; i++) { const p = new FakePeripheral({ clock, id: `D${i}`, serial: `DEV${i}`, periodUs }); p.silent = true; ps.push(p); }
    installFakeNavigatorBluetooth(ps);
    const t = new WebBluetoothTransport({ clock });
    const entries = [];
    for (const _ of ps) entries.push(service.addDevice(await t.requestDevice({}), { kind: 'sltp' }));
    await clock.advance(50); // connected + subscribed, nothing sent yet (silent): WAITING_FOR_DATA
    return { clock, name, inner, repo, recorder, service, ctl, ps, entries, all: entries.map(e => e.handle) };
}

async function settle(clock, p, step = 100, max = 600_000) {
    let done = false, val, err;
    p.then(v => { done = true; val = v; }, e => { done = true; err = e; });
    for (let t = 0; t < max && !done; t += step) await clock.advance(step);
    if (err) throw err;
    assert.ok(done, 'did not settle');
    return val;
}

/** Start a session, then deliver `script[k]` (array of [peripheralIndex, bytes]) every intervalMs once recording is active. */
async function recordScript(r, script, intervalMs, name = 'integrity') {
    const started = r.ctl.start({ name, include: r.all });
    for (let i = 0; i < 200 && !r.service.recording; i++) await r.clock.advance(5);
    assert.ok(r.service.recording, 'pipeline active (header persisted) before any scripted sample');
    let k = 0;
    const tick = () => { const step = script[k++]; if (!step) return; for (const [pi, bytes] of step) r.ps[pi].sendRaw(bytes); r.clock.setTimeout(tick, intervalMs); };
    tick();
    const res = await settle(r.clock, started);
    assert.equal(res.ok, true, 'startup verified');
    await r.clock.advance(script.length * intervalMs + 500);
    const sum = await settle(r.clock, r.ctl.stop());
    return { sessionId: res.sessionId, sum };
}

/** stream_state transitions to SUSPECT/STALE that happened while data was still arriving */
function problemsWhileFlowing(snap) {
    const lastRel = Math.max(...[...iterateReadings(snap)].map(x => x.relS));
    return snap.session.lifecycle.events.filter(e => e.type === 'stream_state' && ['SUSPECT', 'STALE'].includes(e.to) && e.t <= lastRel);
}

function rowsBy(snap) {
    const out = new Map();
    for (const r of iterateReadings(snap)) {
        const k = `${r.deviceId}|${r.channelId}`;
        if (!out.has(k)) out.set(k, []);
        out.get(k).push(r);
    }
    return out;
}

test('1000 known samples × 2 devices × 2 channels: exact counts, values, timestamps, ordering, identity, export equality', async () => {
    const r = await rig({ devices: 2 });
    const N = 1000;
    const script = Array.from({ length: N }, (_, i) => [[0, pkt(i, 10)], [1, pkt(i, 5000)]]);
    const { sessionId, sum } = await recordScript(r, script, 100);
    assert.equal(sum.ok, true);
    assert.equal(sum.persisted, N * 2 * 2, 'sample count: 1000 samples × 2 channels × 2 devices');
    assert.equal(r.ctl.state, SESSION.COMPLETED);
    const snap = await r.inner.readSnapshot(sessionId);
    const by = rowsBy(snap);
    assert.deepEqual([...by.keys()].sort(), ['ble:DEV0|0', 'ble:DEV0|1', 'ble:DEV1|0', 'ble:DEV1|1']);
    for (const [k, rows] of by) {
        const [dev, ch] = k.split('|');
        const base = dev === 'ble:DEV0' ? 10 : 5000;
        assert.equal(rows.length, N, `${k} count`);
        rows.forEach((x, i) => {
            assert.equal(x.seq, i, `${k} seq ${i}`);
            assert.equal(x.devUs, T0_US + i * DT_US, `${k} device time ${i}`);
            assert.ok(Math.abs(x.value - expected(i, base, Number(ch))) < 1e-9, `${k} value ${i} (identity: no cross-device mixing)`);
            assert.equal(x.raw, ch === '0' ? base + i : base + 2000 + i);
            assert.equal(x.flags & ~Q.SIMULATED, 0, `${k} no quality flags on clean data`);
            if (i > 0) {
                assert.ok(Math.abs(x.relS - rows[i - 1].relS - 0.1) < 1e-9, `${k} relative time steps exactly 0.1 s`);
                assert.ok(x.hostMs >= rows[i - 1].hostMs, `${k} host receipt time non-decreasing`);
            }
        });
    }
    // same parameter names on both devices stay separate
    assert.equal(snap.session.devices['ble:DEV0'].channels[0].name, snap.session.devices['ble:DEV1'].channels[0].name);
    // quality summary == persisted records
    for (const dev of ['ble:DEV0', 'ble:DEV1']) {
        const q = snap.session.quality[dev].stream;
        assert.equal(q.received, N); assert.equal(q.missing, 0); assert.equal(q.duplicates, 0); assert.equal(q.outOfOrder, 0);
        assert.equal(q.firstSeq, 0); assert.equal(q.lastSeq, N - 1);
        assert.equal(q.deviceIntervalUs.mean, DT_US); assert.equal(q.deviceIntervalUs.std, 0);
    }
    // CSV: row-by-row equal to storage
    const table = parseCsv(buildCsvParts(snap).parts.join(''));
    const col = Object.fromEntries(CSV_COLUMNS.map((c, i) => [c, i]));
    assert.equal(table.length - 1, N * 4);
    let i = 1;
    for (const x of iterateReadings(snap)) {
        const row = table[i++];
        assert.equal(row[col.session_id], sessionId);
        assert.equal(row[col.device_id], x.deviceId);
        assert.equal(Number(row[col.channel_id]), x.channelId);
        assert.equal(Number(row[col.sequence]), x.seq);
        assert.equal(Number(row[col.device_time_us]), x.devUs);
        assert.equal(Number(row[col.relative_time_s]), x.relS);
        assert.equal(Number(row[col.host_receive_ms]), x.hostMs);
        assert.equal(Number(row[col.raw_value]), x.raw);
        assert.equal(Number(row[col.value]), x.value);
        assert.equal(row[col.unit], x.channelId === 0 ? 'µε' : '°C');
    }
    // JSON: semantic round trip
    const back = parseExportJson(buildJson(snap));
    assert.equal(back.ok, true);
    assert.deepEqual([...iterateReadings(back.snapshot)], [...iterateReadings(snap)]);
    assert.deepEqual(problemsWhileFlowing(snap), [], 'no SUSPECT/STALE while samples were flowing (only after the script ended)');
});

test('known faults: duplicate suppressed, late packet stored+flagged, malformed rejected, gap counted, with exact expected totals', async () => {
    const r = await rig();
    const N = 1000;
    const script = [];
    for (let i = 0; i < N; i++) {
        if (i >= 700 && i < 710) continue;                    // gap of 10 (never sent)
        if (i === 600) continue;                              // sent late, after 601
        script.push([[0, pkt(i)]]);
        if (i === 601) script.push([[0, pkt(600)]]);          // out-of-order arrival
        if (i === 500) script.push([[0, pkt(500)]]);          // duplicate
        if (i === 300) script.push([[0, pkt(300).slice(0, 15)]]); // truncated/malformed packet
    }
    const { sessionId, sum } = await recordScript(r, script, 100);
    const snap = await r.inner.readSnapshot(sessionId);
    const ch0 = rowsBy(snap).get('ble:DEV0|0');
    assert.equal(ch0.length, 990, 'stored = 1000 − 10 never sent (duplicate and malformed not stored)');
    assert.equal(sum.persisted, 990 * 2);
    const seqs = ch0.map(x => x.seq);
    assert.equal(new Set(seqs).size, 990, 'no duplicates stored');
    assert.deepEqual([...seqs].sort((a, b) => a - b), [...Array(N).keys()].filter(i => i < 700 || i >= 710));
    assert.equal(seqs.indexOf(600), seqs.indexOf(601) + 1, 'arrival order preserved: 601 then 600');
    const late = ch0.find(x => x.seq === 600);
    assert.ok(late.flags & Q.OUT_OF_ORDER);
    assert.equal(late.devUs, T0_US + 600 * DT_US, 'late sample keeps its own device time');
    assert.ok(ch0.find(x => x.seq === 710).flags & Q.GAP_BEFORE);
    const q = snap.session.quality['ble:DEV0'];
    assert.equal(q.stream.received, 990);
    assert.equal(q.stream.missing, 10, 'the 1-sample hole at 600 was filled by the late packet');
    assert.equal(q.stream.duplicates, 1);
    assert.equal(q.stream.outOfOrder, 1);
    assert.equal(q.invalidPackets, 1);
    assert.equal(q.parseErrors.TOO_SHORT, 1, 'a 15-byte packet is below the 16-byte minimum');
    const table = parseCsv(buildCsvParts(snap).parts.join(''));
    assert.equal(table.length - 1, 990 * 2, 'export agrees with storage');
});

test('one device malformed packets do not contaminate another device stream or its persisted data', async () => {
    const r = await rig({ devices: 2 });
    const malformed = new Uint8Array([0x01, 0x02, 0x00]);
    const script = [
        [[0, pkt(0, 100)], [1, pkt(0, 900)]],
        [[0, malformed], [1, pkt(1, 900)]],
        [[0, pkt(2, 100)], [1, pkt(2, 900)]],
    ];
    const { sessionId, sum } = await recordScript(r, script, 100, 'fault isolation');
    assert.equal(sum.ok, true);

    const snap = await r.inner.readSnapshot(sessionId);
    const byDevice = new Map();
    for (const reading of iterateReadings(snap)) {
        if (!byDevice.has(reading.deviceId)) byDevice.set(reading.deviceId, []);
        byDevice.get(reading.deviceId).push(reading);
    }

    assert.equal(r.entries[0].parse.invalidPackets, 1);
    assert.equal(r.entries[1].parse.invalidPackets, 0);
    assert.equal(r.entries[0].tracker.snapshot().missing, 1);
    assert.equal(r.entries[1].tracker.snapshot().missing, 0);
    assert.deepEqual(byDevice.get('ble:DEV0').filter(x => x.channelId === 0).map(x => x.seq), [0, 2]);
    assert.deepEqual(byDevice.get('ble:DEV1').filter(x => x.channelId === 0).map(x => x.seq), [0, 1, 2]);
    assert.ok(byDevice.get('ble:DEV1').every(x => x.value !== null));
});

test('bursty BLE delivery (20 packets per 400 ms connection event at 50 Hz): all stored, device timing exact, never marked stale', async () => {
    const r = await rig({ periodUs: 20_000 });
    const burst = (b) => Array.from({ length: 20 }, (_, j) => [0, pkt(b * 20 + j, 10, T0_US + (b * 20 + j) * 20_000)]);
    const script = Array.from({ length: 25 }, (_, b) => burst(b));
    const { sessionId } = await recordScript(r, script, 400);
    const snap = await r.inner.readSnapshot(sessionId);
    const ch0 = rowsBy(snap).get('ble:DEV0|0');
    assert.equal(ch0.length, 500);
    for (let i = 1; i < 500; i++) assert.ok(Math.abs(ch0[i].relS - ch0[i - 1].relS - 0.02) < 1e-9, 'relative time from the device clock, not burst arrival');
    const q = snap.session.quality['ble:DEV0'].stream;
    assert.equal(q.deviceIntervalUs.std, 0);
    assert.ok(q.hostIntervalMs.max >= 350 && q.hostIntervalMs.min === 0, 'host receipt shows the batching (diagnostic only)');
    assert.deepEqual(problemsWhileFlowing(snap), [], 'bursts every 400 ms never make a 50 Hz stream look stale');
});

test('session isolation: consecutive sessions never share samples', async () => {
    const r = await rig();
    const a = await recordScript(r, Array.from({ length: 200 }, (_, i) => [[0, pkt(i)]]), 100, 'A');
    r.ctl.acknowledge();
    const b = await recordScript(r, Array.from({ length: 200 }, (_, i) => [[0, pkt(200 + i)]]), 100, 'B');
    assert.notEqual(a.sessionId, b.sessionId);
    const sa = rowsBy(await r.inner.readSnapshot(a.sessionId)).get('ble:DEV0|0').map(x => x.seq);
    const sb = rowsBy(await r.inner.readSnapshot(b.sessionId)).get('ble:DEV0|0').map(x => x.seq);
    assert.deepEqual(sa, [...Array(200).keys()]);
    assert.deepEqual(sb, [...Array(200).keys()].map(i => 200 + i));
    assert.equal((await r.inner.readSnapshot(b.sessionId)).session.quality['ble:DEV0'].stream.received, 200, 'session B counters exclude session A');
});

test('reload: a completed session reads back identically from a fresh repository instance', async () => {
    const r = await rig();
    const { sessionId } = await recordScript(r, Array.from({ length: 300 }, (_, i) => [[0, pkt(i)]]), 100);
    const before = JSON.stringify(await r.inner.readSnapshot(sessionId));
    r.inner.close();
    const reopened = new IdbRepository({ dbName: r.name }); // what a page reload does
    const after = JSON.stringify(await reopened.readSnapshot(sessionId));
    assert.equal(after, before, 'byte-identical snapshot after reload');
    assert.equal((await reopened.getSession(sessionId)).state, 'closed');
    assert.deepEqual(await findInterruptedSessions(reopened, { locks: null, nowWall: Date.now() + 3600_000 }), [], 'completed session is not mistaken for an interrupted one');
});

test('delayed storage writes (2 s each): never overlapping, nothing duplicated or lost, Stop waits and reports STOPPING until done', async () => {
    let inFlight = 0, maxInFlight = 0, calls = 0;
    const wrap = (inner, clock) => new Proxy(inner, {
        get(t, k) {
            if (k !== 'appendChunk') return typeof t[k] === 'function' ? t[k].bind(t) : t[k];
            return async (...a) => { calls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise(res => clock.setTimeout(res, 2000)); try { return await t.appendChunk(...a); } finally { inFlight--; } };
        },
    });
    const r = await rig({ repoWrap: wrap });
    const started = r.ctl.start({ name: 'slow disk', include: r.all });
    for (let i = 0; i < 200 && !r.service.recording; i++) await r.clock.advance(5);
    let k = 0;
    const tick = () => { if (k >= 300) return; r.ps[0].sendRaw(pkt(k++)); r.clock.setTimeout(tick, 100); };
    tick();
    assert.equal((await settle(r.clock, started)).ok, true);
    await r.clock.advance(30_500);
    const stopping = r.ctl.stop();
    await r.clock.advance(10);
    assert.equal(r.ctl.state, SESSION.STOPPING, 'UI can show "stopping / finalizing" while writes are pending');
    const sum = await settle(r.clock, stopping);
    assert.equal(sum.ok, true);
    assert.equal(maxInFlight, 1, 'one chunk write at a time');
    const ch0 = rowsBy(await r.inner.readSnapshot(sum.sessionId)).get('ble:DEV0|0');
    assert.deepEqual(ch0.map(x => x.seq), [...Array(300).keys()], 'every sample exactly once, in order');
    assert.equal(sum.persisted, 600);
    assert.ok(calls < 300, 'writes are batched, not one per sample');
});
