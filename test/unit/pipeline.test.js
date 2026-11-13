/**
 * Complete acquisition path through the REAL Web Bluetooth driver (src/transport/web-bluetooth.js)
 * against a mock of the W3C Web Bluetooth API:
 *   requestDevice → gatt.connect → getPrimaryService/getCharacteristic → INFO read → startNotifications
 *   → characteristicvaluechanged → SLTP parse → StreamTracker → readings (viz ring buffer + Recorder)
 *   → IndexedDB chunks → simulated crash → interrupted detection → recovery → CSV export → parsed back.
 * Evidence class: SIMULATED INTEGRATION (mock API; no radio, no OS Bluetooth stack).
 */
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../../src/util/clock.js';
import { WebBluetoothTransport } from '../../src/transport/web-bluetooth.js';
import { AcquisitionService } from '../../src/acquisition/acquisition-service.js';
import { STATES } from '../../src/acquisition/device-connection.js';
import { IdbRepository } from '../../src/storage/idb-repository.js';
import { Recorder, findInterruptedSessions } from '../../src/storage/recorder.js';
import { buildCsvParts, parseCsv, CSV_COLUMNS } from '../../src/export/export.js';
import { RingBuffer, seriesKey } from '../../src/viz/series.js';
import { UUIDS } from '../../src/protocol/sltp.js';
import { FakePeripheral, installFakeNavigatorBluetooth } from '../helpers/fake-web-bluetooth.js';

function fakeLocks() {
    const held = new Map();
    return {
        held,
        request(name, opts, cb) { let rel; const p = new Promise(r => { rel = r; }); held.set(name, rel); Promise.resolve(cb()).then(() => { held.delete(name); rel(); }); return p; },
        async query() { return { held: [...held.keys()].map(name => ({ name })) }; },
    };
}

let dbn = 0, idn = 0;
function rig() {
    const clock = new ManualClock({ seed: 11 });
    const repo = new IdbRepository({ dbName: 'pipeline-' + (++dbn) });
    const locks = fakeLocks();
    const recorder = new Recorder({ repo, clock, locks, newId: () => 'sess-' + (++idn), persist: async () => null });
    const svc = new AcquisitionService({ clock, appInfo: { version: 'test' } });
    svc.recorder = recorder;
    return { clock, repo, locks, recorder, svc };
}

test('full path via the real Web Bluetooth driver: connect → notify → parse → track → record → crash → recover → export', async () => {
    const { clock, repo, locks, recorder, svc } = rig();
    const p = new FakePeripheral({ clock });
    const bt = installFakeNavigatorBluetooth([p]);
    const transport = new WebBluetoothTransport({ clock });

    // 1. connection + GATT discovery + subscription (driver code under test)
    const dev = await transport.requestDevice({ filters: [{ services: [UUIDS.service] }], optionalServices: [UUIDS.service] });
    assert.deepEqual(bt.lastOptions.filters, [{ services: [UUIDS.service] }]);
    assert.equal(dev.transportId, 'webbt:FAKEID==');
    const viz = new Map();
    svc.addSink((r, e) => { const k = seriesKey(r.deviceId, r.channelId); if (!viz.has(k)) viz.set(k, new RingBuffer(1000)); viz.get(k).push(r.relS, r.value); });
    const e = svc.addDevice(dev, { kind: 'sltp' });
    await clock.advance(5);
    assert.equal(e.conn.state, STATES.WAITING_FOR_DATA, 'subscribed but no sample yet → not STREAMING');
    assert.equal(e.deviceId, 'ble:FAKE0001', 'identity from INFO serial, not the BLE name');
    await clock.advance(100);
    assert.equal(e.conn.state, STATES.STREAMING);

    // 2. record
    const sid = await svc.startRecording({ name: 'pipeline' });
    await clock.advance(2000);

    // 3. link loss → backoff → reconnect: driver must rediscover fresh characteristic objects
    const before = p.liveChars.length;
    p.linkLoss();
    assert.equal(e.conn.state, STATES.DISCONNECTED);
    await clock.advance(1500);
    assert.equal(e.conn.state, STATES.STREAMING, 'reconnected and streaming again');
    assert.ok(p.liveChars.length > before, 'characteristics were rediscovered after reconnect');
    assert.equal(p.subscribed.size, 1, 'exactly one active subscription (no stale or duplicate listeners)');
    await clock.advance(2000);

    // 4. crash: no stop(); the tab's lock disappears
    const appended = recorder.counters.appended;
    await recorder.flush();
    const persistedAtCrash = recorder.counters.persisted;
    recorder._timer && clock.clearTimeout(recorder._timer);
    recorder.state = 'crashed';
    for (const rel of locks.held.values()) rel();
    locks.held.clear();
    const interrupted = await findInterruptedSessions(repo, { locks });
    assert.deepEqual(interrupted.map(s => s.sessionId), [sid]);
    const rec = await repo.recoverSession(sid, '2026-10-12T00:00:00Z');
    assert.equal(rec.recovery.persistedReadings, persistedAtCrash);
    assert.ok(persistedAtCrash <= appended);

    // 5. export from storage and verify every value against the peripheral's known signal
    const snap = await repo.readSnapshot(sid);
    const { parts, rows } = buildCsvParts(snap);
    const table = parseCsv(parts.join(''));
    assert.equal(rows, persistedAtCrash);
    const col = Object.fromEntries(CSV_COLUMNS.map((c, i) => [c, i]));
    const seqs = { 0: [], 1: [] };
    for (const row of table.slice(1)) {
        const seq = Number(row[col.sequence]), ch = Number(row[col.channel_id]);
        assert.equal(row[col.device_id], 'ble:FAKE0001');
        const expected = ch === 0 ? seq * 0.1 : (2500 + seq) * 0.01;
        assert.ok(Math.abs(Number(row[col.value]) - expected) < 1e-9, `value for seq ${seq} ch ${ch} (buffer copied before reuse)`);
        assert.equal(Number(row[col.device_time_us]), seq * 50_000);
        seqs[ch].push(seq);
    }
    for (const ch of [0, 1]) for (let i = 1; i < seqs[ch].length; i++) assert.ok(seqs[ch][i] > seqs[ch][i - 1]);
    // the disconnect produced a counted gap that matches the missing sequence numbers in the file
    const gapInFile = seqs[0][seqs[0].length - 1] - seqs[0][0] + 1 - seqs[0].length;
    assert.ok(gapInFile > 0);
    assert.equal(snap.session.quality['ble:FAKE0001'].stream.missing, gapInFile);
    assert.ok(viz.get(seriesKey('ble:FAKE0001', 0)).length > 0, 'visualization sink received the same readings');
});

test('driver: connect failure surfaces as BACKOFF and a later attempt succeeds', async () => {
    const { clock, svc } = rig();
    const p = new FakePeripheral({ clock, id: 'F2', serial: 'FAKE0002' });
    p.failConnects = 1;
    installFakeNavigatorBluetooth([p]);
    const dev = await new WebBluetoothTransport({ clock }).requestDevice({ acceptAllDevices: true });
    const e = svc.addDevice(dev, { kind: 'sltp' });
    await clock.advance(5);
    assert.equal(e.conn.state, STATES.BACKOFF);
    assert.match(e.conn.lastError.message, /Connection failed/);
    await clock.advance(2000);
    assert.equal(e.conn.state, STATES.STREAMING);
});

test('driver: chooser cancelled → NotFoundError propagates (no device added)', async () => {
    installFakeNavigatorBluetooth([]);
    await assert.rejects(new WebBluetoothTransport({ clock: new ManualClock() }).requestDevice({ acceptAllDevices: true }), { name: 'NotFoundError' });
});

test('driver: listServices and control write + INFO readback through the W3C API', async () => {
    const { clock, svc } = rig();
    const p = new FakePeripheral({ clock, id: 'F3', serial: 'FAKE0003' });
    installFakeNavigatorBluetooth([p]);
    const dev = await new WebBluetoothTransport({ clock }).requestDevice({ acceptAllDevices: true });
    await dev.connect();
    const services = await dev.listServices();
    assert.equal(services[0].serviceUuid, UUIDS.service);
    assert.deepEqual(services[0].characteristics.map(c => c.uuid).sort(), [UUIDS.data, UUIDS.info, UUIDS.control].sort());
    const e = svc.addDevice(dev, { kind: 'sltp' });
    await clock.advance(200);
    const r = await svc.setRate(e.handle, 10);
    assert.equal(r.ok, true);
    assert.equal(p.periodUs, 100_000);
});

test('driver: listServices reconnects once after a transient GATT disconnect', async () => {
    const { clock } = rig();
    const p = new FakePeripheral({ clock, id: 'F4', serial: 'FAKE0004' });
    installFakeNavigatorBluetooth([p]);
    const dev = await new WebBluetoothTransport({ clock }).requestDevice({ acceptAllDevices: true });
    await dev.connect();
    const getPrimaryServices = p.device.gatt.getPrimaryServices.bind(p.device.gatt);
    let calls = 0;
    p.device.gatt.getPrimaryServices = async () => {
        calls++;
        if (calls === 1) {
            p.linkLoss();
            throw new DOMException('GATT Server is disconnected. Cannot retrieve services.', 'NetworkError');
        }
        return getPrimaryServices();
    };

    const services = await dev.listServices();

    assert.equal(calls, 2);
    assert.equal(p.connectCalls, 2);
    assert.equal(dev.connected, true);
    assert.equal(services[0].serviceUuid, UUIDS.service);
});

test('REGRESSION: quality of a device removed mid-recording is kept in the saved session', async () => {
    const { clock, repo, svc } = rig();
    const a = new FakePeripheral({ clock, id: 'A', serial: 'DEVA' }), b = new FakePeripheral({ clock, id: 'B', serial: 'DEVB' });
    installFakeNavigatorBluetooth([a, b]);
    const t = new WebBluetoothTransport({ clock });
    const ea = svc.addDevice(await t.requestDevice({}), { kind: 'sltp' });
    svc.addDevice(await t.requestDevice({}), { kind: 'sltp' });
    await clock.advance(200);
    const sid = await svc.startRecording({ name: 'remove mid-session' });
    await clock.advance(1000);
    const receivedA = ea.tracker.snapshot().received;
    await svc.removeDevice(ea.handle);
    await clock.advance(1000);
    await svc.stopRecording();
    const s = await repo.getSession(sid);
    assert.ok(s.quality['ble:DEVA'], 'removed device still has a quality record');
    assert.equal(s.quality['ble:DEVA'].stream.received, receivedA);
    assert.equal(s.quality['ble:DEVA'].state, STATES.CLOSED);
    assert.ok(s.quality['ble:DEVB'].stream.received > receivedA);
});

test('REGRESSION: connection events before recording do not leak into the session statistics', async () => {
    const { clock, repo, svc } = rig();
    const p = new FakePeripheral({ clock, id: 'C', serial: 'DEVC' });
    installFakeNavigatorBluetooth([p]);
    const e = svc.addDevice(await new WebBluetoothTransport({ clock }).requestDevice({}), { kind: 'sltp' });
    await clock.advance(200);
    p.linkLoss();
    await clock.advance(3000);
    assert.equal(e.conn.counters.disconnects, 1);
    const sid = await svc.startRecording({ name: 'clean counters' });
    await clock.advance(1000);
    await svc.stopRecording();
    const q = (await repo.getSession(sid)).quality['ble:DEVC'];
    assert.equal(q.connection.disconnects, 0, 'session counts only its own disconnects');
    assert.equal(q.connection.reconnects, 0);
});
