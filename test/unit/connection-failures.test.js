/**
 * Connection failure paths through the real Web Bluetooth driver (W3C API mock). SIMULATED, not radio.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../../src/util/clock.js';
import { WebBluetoothTransport } from '../../src/transport/web-bluetooth.js';
import { AcquisitionService } from '../../src/acquisition/acquisition-service.js';
import { STATES } from '../../src/acquisition/device-connection.js';
import { FakePeripheral, installFakeNavigatorBluetooth } from '../helpers/fake-web-bluetooth.js';

async function one(setup = () => {}, cfg = {}) {
    const clock = new ManualClock();
    const p = new FakePeripheral({ clock, id: 'F', serial: 'FAIL1' });
    setup(p);
    installFakeNavigatorBluetooth([p]);
    const svc = new AcquisitionService({ clock, connectionConfig: cfg });
    const e = svc.addDevice(await new WebBluetoothTransport({ clock }).requestDevice({}), { kind: 'sltp' });
    return { clock, p, svc, e };
}

test('permission denied / blocked by policy: requestDevice rejects with the browser error, nothing is added', async () => {
    for (const denyWith of [{ name: 'NotAllowedError', message: 'Bluetooth permission has been blocked.' }, { name: 'SecurityError', message: 'Origin is not allowed to access the service.' }]) {
        installFakeNavigatorBluetooth([], { denyWith });
        const svc = new AcquisitionService({ clock: new ManualClock() });
        await assert.rejects(new WebBluetoothTransport({ clock: new ManualClock() }).requestDevice({}), { name: denyWith.name });
        assert.equal(svc.list().length, 0);
    }
});

test('missing GATT service: bounded retries, then DEAD with the service error visible; no listeners leaked', async () => {
    const { clock, p, e } = await one((p) => { p.noService = true; }, { maxAttempts: 3 });
    await clock.advance(120_000);
    assert.equal(e.conn.state, STATES.DEAD);
    assert.equal(e.conn.counters.failedAttempts, 4, 'initial attempt + 3 bounded retries');
    assert.match(e.conn.detail.lastError.message, /No Services matching UUID/);
    assert.equal(p.totalListeners(), 0);
    assert.equal(e.deviceId, null, 'no identity assigned from a device that never exposed SLTP');
});

test('failed notification subscription: listener removed (no leak), retried, recovers with exactly one listener', async () => {
    const { clock, p, e } = await one((p) => { p.failSubscribe = true; });
    await clock.advance(50);
    assert.equal(e.conn.state, STATES.BACKOFF);
    assert.match(e.conn.lastError.message, /GATT operation failed/);
    assert.equal(p.totalListeners(), 0, 'driver removed its listener when startNotifications failed');
    p.failSubscribe = false;
    await clock.advance(5_000);
    assert.equal(e.conn.state, STATES.STREAMING);
    assert.equal(p.totalListeners(), 1);
    assert.equal(p.subscribed.size, 1);
});

test('repeated link loss: listeners never accumulate across reconnects', async () => {
    const { clock, p, e } = await one();
    await clock.advance(300);
    // backoff grows across rapid flaps (attempts reset only after 30 s of stable streaming), so wait for each reconnect (bounded)
    for (let k = 0; k < 5; k++) {
        p.linkLoss();
        for (let t = 0; t < 60_000 && e.conn.state !== STATES.STREAMING; t += 250) await clock.advance(250);
        assert.equal(e.conn.state, STATES.STREAMING, `reconnect ${k + 1}`);
        assert.equal(p.totalListeners(), 1, `one listener after reconnect ${k + 1}`);
    }
    assert.equal(e.conn.counters.reconnects, 5);
    assert.equal(p.totalListeners(), 1, 'one live listener after 5 reconnects');
});
