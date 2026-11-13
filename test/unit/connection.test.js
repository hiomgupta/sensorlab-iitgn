import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../../src/util/clock.js';
import { SimulatedTransport } from '../../src/transport/simulated.js';
import { AcquisitionService } from '../../src/acquisition/acquisition-service.js';
import { STATES, backoffDelay, DEFAULT_CONFIG } from '../../src/acquisition/device-connection.js';

const spec = (serial, extra = {}) => ({
    serial, name: 'SIM-' + serial, periodUs: 50_000,
    channels: [{ name: 'a', unit: 'V', scale: 0.001, offset: 0, signal: { type: 'sine', amplitude: 1, freqHz: 1 } }],
    ...extra,
});

function setup(cfg = {}) {
    const clock = new ManualClock({ seed: 3 });
    const sim = new SimulatedTransport({ clock });
    const svc = new AcquisitionService({ clock, connectionConfig: cfg });
    const states = new Map();
    svc.on('device', (e) => { if (!states.has(e.handle)) states.set(e.handle, []); const l = states.get(e.handle); if (l[l.length - 1] !== e.conn.state) l.push(e.conn.state); });
    const readings = [];
    svc.addSink((r) => readings.push(r));
    return { clock, sim, svc, states, readings };
}

test('connect → discover → subscribe → WAITING_FOR_DATA → STREAMING only after first valid sample', async () => {
    const { clock, sim, svc, states, readings } = setup();
    const dev = sim.addDevice(spec('A1'));
    const e = svc.addDevice(dev, { kind: 'sltp' });
    await clock.advance(1);
    assert.equal(e.conn.state, STATES.WAITING_FOR_DATA);
    assert.equal(readings.length, 0);
    await clock.advance(60);
    assert.equal(e.conn.state, STATES.STREAMING);
    assert.deepEqual(states.get(e.handle).slice(0, 5), ['CONNECTING', 'DISCOVERING', 'SUBSCRIBING', 'WAITING_FOR_DATA', 'STREAMING']);
    assert.equal(e.deviceId, 'sim:A1');
    assert.ok(readings.length >= 1);
    assert.ok(readings.every(r => r.deviceId === 'sim:A1'));
});

test('connected but silent device is DEGRADED, never STREAMING', async () => {
    const { clock, sim, svc } = setup();
    const dev = sim.addDevice(spec('S1', { faults: { silent: true } }));
    const e = svc.addDevice(dev, { kind: 'sltp' });
    await clock.advance(DEFAULT_CONFIG.firstDataTimeoutMs + 600);
    assert.equal(e.conn.state, STATES.DEGRADED);
    assert.equal(e.conn.detail.code, 'NO_DATA_AFTER_SUBSCRIBE');
    dev.setFaults({ silent: false });
    await clock.advance(200);
    assert.equal(e.conn.state, STATES.STREAMING);
});

test('stream stall after streaming → DEGRADED with STALE, recovers when data resumes', async () => {
    const { clock, sim, svc } = setup();
    const dev = sim.addDevice(spec('S2'));
    const e = svc.addDevice(dev, { kind: 'sltp' });
    await clock.advance(500);
    assert.equal(e.conn.state, STATES.STREAMING);
    dev.setFaults({ silent: true });
    await clock.advance(DEFAULT_CONFIG.staleAfterMs + 600);
    assert.equal(e.conn.state, STATES.DEGRADED);
    assert.equal(e.conn.detail.code, 'STALE');
    dev.setFaults({ silent: false });
    await clock.advance(200);
    assert.equal(e.conn.state, STATES.STREAMING);
});

test('connect timeout watchdog fires; failure goes to BACKOFF, not a hang', async () => {
    const { clock, sim, svc } = setup({ maxAttempts: 2 });
    const dev = sim.addDevice(spec('H1', { faults: { connectHang: true } }));
    const e = svc.addDevice(dev, { kind: 'sltp' });
    await clock.advance(DEFAULT_CONFIG.connectTimeoutMs + 1);
    assert.equal(e.conn.state, STATES.BACKOFF);
    assert.equal(e.conn.lastError.code, 'CONNECT_TIMEOUT');
    assert.equal(e.conn.counters.timeouts, 1);
});

test('disconnect → bounded jittered backoff → reconnect with fresh subscription; stale handler ignored', async () => {
    const { clock, sim, svc, readings } = setup();
    const dev = sim.addDevice(spec('R1'));
    const e = svc.addDevice(dev, { kind: 'sltp' });
    await clock.advance(500);
    const before = readings.length;
    dev.forceDisconnect();
    dev.forceDisconnect(); // repeated events are idempotent
    assert.equal(e.conn.state, STATES.DISCONNECTED);
    await clock.advance(1);
    assert.equal(e.conn.state, STATES.BACKOFF);
    assert.ok(e.conn.detail.retryInMs >= 500 && e.conn.detail.retryInMs <= 1000);
    await clock.advance(1500);
    assert.equal(e.conn.state, STATES.STREAMING);
    assert.equal(e.conn.counters.disconnects, 1);
    assert.equal(e.conn.counters.reconnects, 1);
    assert.equal(dev._subs.size, 1, 'exactly one live subscription after reconnect');
    // sequence kept counting while disconnected → measured gap, no duplicates
    const s = e.tracker.snapshot();
    assert.ok(s.missing > 0);
    assert.equal(s.duplicates, 0);
    assert.ok(readings.length > before);
});

test('retry exhaustion → DEAD with explicit error; explicit retry recovers', async () => {
    const { clock, sim, svc } = setup({ maxAttempts: 3 });
    const dev = sim.addDevice(spec('D1'));
    const e = svc.addDevice(dev, { kind: 'sltp' });
    await clock.advance(300);
    dev.powerOff();
    await clock.advance(120_000);
    assert.equal(e.conn.state, STATES.DEAD);
    assert.equal(e.conn.detail.code, 'RETRIES_EXHAUSTED');
    assert.equal(e.conn.counters.failedAttempts, 3);
    const pendingBefore = clock.pending;
    await clock.advance(60_000);
    assert.equal(e.conn.state, STATES.DEAD, 'no silent retry loop after DEAD');
    assert.ok(clock.pending <= pendingBefore);
    dev.powerOn();
    assert.equal(svc.retry(e.handle), true);
    await clock.advance(500);
    assert.equal(e.conn.state, STATES.STREAMING);
    // device rebooted while away: boot nonce changed → new epoch, not "late" packets
    assert.equal(e.tracker.snapshot().outOfOrder, 0);
    assert.ok(e.tracker.snapshot().restarts >= 1);
});

test('backoff delays are capped and jittered within [d/2, d]', () => {
    const cfg = DEFAULT_CONFIG;
    for (let n = 0; n < 10; n++) {
        const d = Math.min(cfg.backoffCapMs, cfg.backoffBaseMs * 2 ** n);
        assert.equal(backoffDelay(n, cfg, () => 0), d / 2);
        assert.equal(backoffDelay(n, cfg, () => 1), d);
    }
});

test('multiple devices disconnect simultaneously; one failing does not reset another', async () => {
    const { clock, sim, svc, readings } = setup({ maxAttempts: 2 });
    const a = sim.addDevice(spec('M1')), b = sim.addDevice(spec('M2')), c = sim.addDevice(spec('M3'));
    const ea = svc.addDevice(a, { kind: 'sltp' }), eb = svc.addDevice(b, { kind: 'sltp' }), ec = svc.addDevice(c, { kind: 'sltp' });
    await clock.advance(500);
    assert.ok([ea, eb, ec].every(e => e.conn.state === STATES.STREAMING));
    a.forceDisconnect(); b.forceDisconnect();
    c.powerOff();
    await clock.advance(5000);
    assert.equal(ea.conn.state, STATES.STREAMING);
    assert.equal(eb.conn.state, STATES.STREAMING);
    await clock.advance(60_000);
    assert.equal(ec.conn.state, STATES.DEAD);
    assert.equal(ea.conn.state, STATES.STREAMING);
    // readings never mixed across devices
    const ids = new Set(readings.map(r => r.deviceId));
    assert.deepEqual([...ids].sort(), ['sim:M1', 'sim:M2', 'sim:M3']);
    for (const id of ids) {
        const own = readings.filter(r => r.deviceId === id && r.channelId === 0).map(r => r.seq);
        for (let i = 1; i < own.length; i++) assert.ok(own[i] > own[i - 1], `${id} sequences increase`);
    }
});

test('invalid INFO (protocol mismatch) is non-retryable → DEAD, no loop', async () => {
    const { clock, sim, svc } = setup();
    const dev = sim.addDevice(spec('I1', { faults: { infoMalformed: true } }));
    const e = svc.addDevice(dev, { kind: 'sltp' });
    await clock.advance(100);
    assert.equal(e.conn.state, STATES.DEAD);
    assert.match(e.conn.lastError.code, /^INFO_/);
});

test('two devices reporting the same serial: second is refused (no merged streams)', async () => {
    const { clock, svc } = setup();
    const sim1 = new SimulatedTransport({ clock, seed: 1 }), sim2 = new SimulatedTransport({ clock, seed: 2 });
    const d1 = sim1.addDevice(spec('DUP')), d2 = sim2.addDevice(spec('DUP'));
    d2.transportId = 'sim:DUP-other-radio';
    const e1 = svc.addDevice(d1, { kind: 'sltp' });
    await clock.advance(100);
    const e2 = svc.addDevice(d2, { kind: 'sltp' });
    await clock.advance(100);
    assert.equal(e1.conn.state, STATES.STREAMING);
    assert.equal(e2.conn.state, STATES.DEAD);
    assert.equal(e2.conn.lastError.code, 'IDENTITY_COLLISION');
});

test('user close does not trigger reconnect and removes all listeners', async () => {
    const { clock, sim, svc } = setup();
    const dev = sim.addDevice(spec('C1'));
    const e = svc.addDevice(dev, { kind: 'sltp' });
    await clock.advance(300);
    await svc.removeDevice(e.handle);
    await clock.advance(60_000);
    assert.equal(e.conn.state, STATES.CLOSED);
    assert.equal(dev._subs.size, 0);
    assert.equal(dev._discCbs.size, 0);
    assert.equal(e.conn.counters.reconnects, 0);
});

test('sample-rate control is confirmed by INFO readback; out-of-range rejected', async () => {
    const { clock, sim, svc } = setup();
    const dev = sim.addDevice(spec('K1'));
    const e = svc.addDevice(dev, { kind: 'sltp' });
    await clock.advance(200);
    const r = await svc.setRate(e.handle, 20);
    assert.equal(r.ok, true);
    assert.equal(e.info.periodUs, 50_000);
    const r2 = await svc.setRate(e.handle, 5000);
    assert.equal(r2.ok, false);
});

test('slow sensor (0.25 Hz) is not reported as stalled between its normal samples (rate-aware stall threshold)', async () => {
    const { clock, sim, svc } = setup();
    const e = svc.addDevice(sim.addDevice(spec('SLOW', { periodUs: 4_000_000 })), { kind: 'sltp' });
    await clock.advance(4_100);
    assert.equal(e.conn.state, STATES.STREAMING);
    const seen = new Set();
    for (let i = 0; i < 60; i++) { await clock.advance(250); seen.add(e.conn.state); }
    assert.deepEqual([...seen], [STATES.STREAMING], 'never DEGRADED during 15 s of normal 4 s intervals');
    sim.devices.get('SLOW').setFaults({ silent: true });
    await clock.advance(21_000);
    assert.equal(e.conn.state, STATES.DEGRADED, 'still detected after 5 missed intervals');
});
