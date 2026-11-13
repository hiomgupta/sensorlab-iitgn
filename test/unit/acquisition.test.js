import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../../src/util/clock.js';
import { SimulatedTransport } from '../../src/transport/simulated.js';
import { AcquisitionService } from '../../src/acquisition/acquisition-service.js';
import { Q } from '../../src/acquisition/quality.js';
import { computeTare, twoPointCalibration, applyCalibration, identityCalibration } from '../../src/acquisition/calibration.js';

function setup() {
    const clock = new ManualClock({ seed: 9 });
    const sim = new SimulatedTransport({ clock });
    const svc = new AcquisitionService({ clock });
    const readings = [];
    svc.addSink((r) => readings.push(r));
    return { clock, sim, svc, readings };
}

const twoCh = (serial, faults = {}) => ({
    serial, periodUs: 20_000, faults,
    channels: [
        { name: 'strain', unit: 'µε', scale: 0.1, offset: 0, signal: { type: 'constant', offset: 100 } },
        { name: 'temp', unit: '°C', scale: 0.01, offset: 0, signal: { type: 'constant', offset: 25 } },
    ],
});

test('readings carry (deviceId, channelId) identity, engineering units and SIMULATED flag', async () => {
    const { clock, sim, svc, readings } = setup();
    svc.addDevice(sim.addDevice(twoCh('X1')), { kind: 'sltp' });
    await clock.advance(200);
    const ch0 = readings.filter(r => r.channelId === 0), ch1 = readings.filter(r => r.channelId === 1);
    assert.ok(ch0.length > 3 && ch0.length === ch1.length);
    assert.ok(ch0.every(r => Math.abs(r.value - 100) < 1e-9 && r.raw === 1000));
    assert.ok(ch1.every(r => Math.abs(r.value - 25) < 1e-9 && r.raw === 2500));
    assert.ok(readings.every(r => r.flags & Q.SIMULATED));
});

test('fault injection: drops, duplicates, reordering, malformed, bad version are all accounted', async () => {
    const { clock, sim, svc, readings } = setup();
    const dev = sim.addDevice(twoCh('F1', { dropProb: 0.05, duplicateProb: 0.05, reorderProb: 0.05, malformedProb: 0.03, badVersionProb: 0.02 }));
    const e = svc.addDevice(dev, { kind: 'sltp' });
    await clock.advance(30_000);
    const s = e.tracker.snapshot();
    assert.ok(dev.stats.dropped > 0 && dev.stats.duplicated > 0 && dev.stats.reordered > 0 && dev.stats.malformed > 0);
    assert.equal(s.duplicates, dev.stats.duplicated, 'every duplicate detected');
    assert.equal(e.parse.invalidPackets, dev.stats.malformed, 'every malformed packet counted, none stored');
    assert.ok(e.parse.errors.LENGTH_MISMATCH > 0 && e.parse.errors.UNSUPPORTED_VERSION > 0);
    // loss accounting: everything sampled while subscribed = received + missing (malformed count as missing seqs)
    const ch0 = readings.filter(r => r.channelId === 0);
    assert.equal(ch0.length, s.received);
    const span = s.lastSeq - s.firstSeq + 1;
    assert.equal(s.received + s.missing, span, 'received + missing covers the whole sequence span');
    // invalid packets are not confused with confirmed sequence loss: they are counted separately
    assert.ok(s.missing >= dev.stats.dropped);
    // no duplicates stored
    const seqs = ch0.map(r => r.seq);
    assert.equal(new Set(seqs).size, seqs.length);
});

test('invalid channel bit → value null + INVALID flag, raw preserved (no sentinel numbers)', async () => {
    const { clock, sim, svc, readings } = setup();
    const e = svc.addDevice(sim.addDevice(twoCh('V1', { invalidChannelProb: 0.3 })), { kind: 'sltp' });
    await clock.advance(5000);
    const bad = readings.filter(r => r.flags & Q.INVALID);
    assert.ok(bad.length > 0);
    assert.ok(bad.every(r => r.value === null && Number.isInteger(r.raw)));
    assert.equal(e.invalidSamples, bad.length);
});

test('legacy text-float with open-circuit sentinel: SENTINEL+INVALID, HOST_TIME_ONLY', async () => {
    const { clock, sim, svc, readings } = setup();
    const dev = sim.addDevice({ serial: 'L1', periodUs: 100_000, legacyFormat: 'text-float', channels: [{ name: 'r', unit: 'Ω', scale: 1, signal: { type: 'constant', offset: 1000000 } }] });
    svc.addDevice(dev, { kind: 'legacy', serviceUuid: 'x', charUuid: 'y', format: 'text-float', unit: 'Ω', label: 'Resistance', scaleFactor: 1, sentinels: [1000000] });
    await clock.advance(1000);
    assert.ok(readings.length > 0);
    assert.ok(readings.every(r => (r.flags & Q.SENTINEL) && (r.flags & Q.INVALID) && r.value === null && (r.flags & Q.HOST_TIME_ONLY)));
    assert.ok(readings.every(r => r.devUs === null));
});

test('a throwing visualization sink does not stop recording hand-off', async () => {
    const { clock, sim, svc } = setup();
    const appended = [];
    svc.recorder = { append: (r) => appended.push(r), start: async () => 'sid', stop: async () => ({}), upsertDevice() {} };
    svc.addSink(() => { throw new Error('chart exploded'); });
    svc.addDevice(sim.addDevice(twoCh('T1')), { kind: 'sltp' });
    await svc.startRecording({ name: 't' });
    await clock.advance(500);
    assert.ok(appended.length > 10);
    assert.ok(svc.sinkErrors > 0);
});

test('relative time restarts at recording start and uses the device clock', async () => {
    const { clock, sim, svc } = setup();
    const appended = [];
    svc.recorder = { append: (r) => appended.push(r), start: async () => 'sid', stop: async () => ({}), upsertDevice() {} };
    const dev = sim.addDevice({ ...twoCh('T2'), faults: { deliveryJitterMs: 15 } });
    svc.addDevice(dev, { kind: 'sltp' });
    await clock.advance(2000);
    await svc.startRecording({ name: 't' });
    await clock.advance(1000);
    const ch0 = appended.filter(r => r.channelId === 0);
    assert.ok(ch0[0].relS >= 0 && ch0[0].relS < 0.1);
    for (let i = 1; i < ch0.length; i++) {
        const dt = ch0[i].relS - ch0[i - 1].relS;
        assert.ok(Math.abs(dt - 0.02 * (ch0[i].seq - ch0[i - 1].seq)) < 1e-9, 'intervals are exact device-clock intervals despite host jitter');
    }
});

test('tare zeroes the current reading; calibration changes are versioned and logged', async () => {
    const { clock, sim, svc, readings } = setup();
    const e = svc.addDevice(sim.addDevice(twoCh('C1')), { kind: 'sltp' });
    await clock.advance(500);
    const r = svc.tare(e.handle, 0);
    assert.equal(r.ok, true);
    assert.ok(Math.abs(r.tare - 100) < 1e-9);
    readings.length = 0;
    await clock.advance(200);
    assert.ok(readings.filter(x => x.channelId === 0).every(x => Math.abs(x.value) < 1e-9));
    assert.ok(readings.filter(x => x.channelId === 0).every(x => x.raw === 1000), 'raw untouched');
    assert.equal(e.calibration[0].version, 1);
    assert.equal(e.calLog.length, 1);
    assert.equal(svc.setCalibration(e.handle, 0, { gain: 0, offset: 0 }).ok, false);
});

test('calibration math', () => {
    assert.equal(computeTare([], identityCalibration(), 0).ok, false);
    const tp = twoPointCalibration(1, 10, 3, 30);
    assert.deepEqual([tp.gain, tp.offset], [10, 0]);
    assert.equal(twoPointCalibration(1, 10, 1, 30).ok, false);
    assert.equal(applyCalibration(2, { gain: 2, offset: 1, tare: 0.5 }), 4.5);
});

test('annotations require a recording and use the capture time, not completion time', async () => {
    const { clock, svc } = setup();
    let got = null;
    svc.recorder = { append() {}, start: async () => 'sid', stop: async () => ({}), upsertDevice() {}, addAnnotation: async (a) => { got = a; return { ok: true }; } };
    assert.equal((await svc.addAnnotation('x', clock.now())).ok, false);
    await svc.startRecording({ name: 't' });
    await clock.advance(1000);
    const captured = clock.now();
    await clock.advance(7000); // user takes 7 s to type
    await svc.addAnnotation('added 100 g', captured);
    assert.ok(Math.abs(got.relS - 1) < 1e-9);
});

test('legacy multi-channel device added during recording: session metadata gets every channel', async () => {
    const { clock, sim, svc } = setup();
    const metas = {};
    svc.recorder = { append() {}, start: async () => 'sid', stop: async () => ({}), upsertDevice: (m) => { metas[m.deviceId] = m; } };
    await svc.startRecording({ name: 't' });
    const dev = sim.addDevice({ serial: 'CSV1', periodUs: 100_000, legacyFormat: 'text-csv', channels: [
        { name: 'a', unit: 'V', scale: 1, signal: { type: 'constant', offset: 1 } }, { name: 'b', unit: 'V', scale: 1, signal: { type: 'constant', offset: 2 } }] });
    const e = svc.addDevice(dev, { kind: 'legacy', serviceUuid: 'x', charUuid: 'y', format: 'text-csv', unit: 'V', label: 'volt', scaleFactor: 1 });
    await clock.advance(1000);
    assert.equal(e.channels.length, 2);
    assert.deepEqual(metas[e.deviceId].channels.map(c => c.name), ['volt[0]', 'volt[1]']);
});
