import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcquisitionService } from '../../src/acquisition/acquisition-service.js';
import { StreamTracker } from '../../src/acquisition/stream-tracker.js';
import { STATES } from '../../src/acquisition/device-connection.js';
import { identityCalibration } from '../../src/acquisition/calibration.js';
import { expectedIntervalMs } from '../../src/acquisition/stream-health.js';
import { GenericGattAdapter, UartFramer } from '../../src/protocol/adapters.js';
import { MAX_PROFILE_BYTES, parseDeviceProfileJson, stringifyDeviceProfile, validateDeviceProfile } from '../../src/protocol/device-profile.js';
import { ManualClock } from '../../src/util/clock.js';

const profileInput = {
    schema: 'sensorlab-device-profile/1',
    version: 1,
    id: 'test-sensor',
    name: 'Test sensor',
    transport: 'web-bluetooth',
    adapter: 'generic-gatt',
    characteristics: [
        { id: 'fast', serviceUuid: '0x181a', characteristicUuid: '0x2a6e', mode: 'notify', decoder: 'uint16-le' },
        { id: 'event', serviceUuid: '0x181a', characteristicUuid: '0x2a6f', mode: 'indicate', decoder: 'uint8' },
        { id: 'polled', serviceUuid: '0x181a', characteristicUuid: '0x2a70', mode: 'read', decoder: 'uint8' },
        { id: 'control', serviceUuid: '0x181a', characteristicUuid: '0x2a71', mode: 'write' },
    ],
    channels: [
        { channelId: 0, name: 'Temperature', unit: '°C', characteristicId: 'fast', valueIndex: 0, scale: 0.1, offset: 0 },
        { channelId: 1, name: 'Event', unit: '', characteristicId: 'event', valueIndex: 0, scale: 1, offset: 0 },
        { channelId: 2, name: 'Battery', unit: '%', characteristicId: 'polled', valueIndex: 0, scale: 1, offset: 0 },
    ],
};

test('device profile schema validates UUIDs and rejects unrecognized command fields', () => {
    const checked = validateDeviceProfile(profileInput);
    assert.equal(checked.ok, true);
    assert.equal(checked.profile.characteristics[0].serviceUuid, 0x181a);
    assert.equal(checked.profile.characteristics[3].write, true);
    const portable = stringifyDeviceProfile(checked.profile);
    assert.equal(parseDeviceProfileJson(portable).ok, true);
    assert.equal(JSON.parse(portable).kind, undefined);
    assert.match(validateDeviceProfile({ ...profileInput, initializationCommands: [{ bytes: [1] }] }).error, /unsupported profile field/);
    assert.match(validateDeviceProfile({ ...profileInput, channels: [{ ...profileInput.channels[0], channelId: 4 }] }).error, /contiguous zero-based/);
    assert.equal(validateDeviceProfile({ ...profileInput, characteristics: [{ ...profileInput.characteristics[0], serviceUuid: 'not-a-uuid' }] }).ok, false);
    assert.match(parseDeviceProfileJson(' '.repeat(MAX_PROFILE_BYTES + 1)).error, /byte limit/);
    const paced = validateDeviceProfile({ ...profileInput, sampling: { intervalMs: 6000 } }).profile;
    assert.deepEqual(expectedIntervalMs({ profile: paced, tracker: null, info: null }), { ms: 6000, source: 'generic GATT profile interval' });
});

test('UART framing retains fragmented input, returns multiple frames, and bounds frame size', () => {
    const framer = new UartFramer({ type: 'newline', maxFrameBytes: 16 });
    const encoder = new TextEncoder();
    assert.deepEqual(framer.feed(encoder.encode('12.5\n-4')).frames.map(frame => new TextDecoder().decode(frame)), ['12.5']);
    assert.deepEqual(framer.feed(encoder.encode('.5\n0\n')).frames.map(frame => new TextDecoder().decode(frame)), ['-4.5', '0']);

    const lengthFramer = new UartFramer({ type: 'length-prefixed', lengthBytes: 1, byteOrder: 'little', maxFrameBytes: 4 });
    assert.equal(lengthFramer.feed(Uint8Array.of(2, 0x34)).frames.length, 0);
    assert.deepEqual([...lengthFramer.feed(Uint8Array.of(0x12)).frames[0]], [0x34, 0x12]);

    const bounded = new UartFramer({ type: 'newline', maxFrameBytes: 3 });
    assert.equal(bounded.feed(encoder.encode('four')).errors[0].code, 'FRAME_TOO_LARGE');
    assert.deepEqual(bounded.feed(encoder.encode('1\n')).frames.map(frame => new TextDecoder().decode(frame)), ['1']);
    assert.equal(new UartFramer({ type: 'newline', maxFrameBytes: 3 }).feed(encoder.encode('four\n')).errors[0].code, 'FRAME_TOO_LARGE');
});

test('generic protocol adapter maps decoded values to profile channels', () => {
    const checked = validateDeviceProfile({
        ...profileInput,
        characteristics: [{ ...profileInput.characteristics[0], framing: { type: 'newline' }, decoder: 'text-csv' }],
        channels: [
            { ...profileInput.channels[0], valueIndex: 1 },
        ],
    });
    const adapter = new GenericGattAdapter(checked.profile);
    assert.deepEqual(adapter.decode(new TextEncoder().encode('2,15\n'), 'fast'), {
        ok: true,
        samples: [{ values: [15], channelIds: [0], valid: [true] }],
    });
});

class FakeGattDevice {
    constructor(profile) {
        this.transportId = 'fake-gatt:test';
        this.name = 'Fake GATT';
        this.kind = 'webbluetooth';
        this.connected = false;
        this.callbacks = new Map();
        this.writes = [];
        this.disconnectHandlers = new Set();
        this.characteristics = new Map(profile.characteristics.map(spec => {
            const properties = {
                read: spec.mode === 'read',
                notify: spec.mode === 'notify',
                indicate: spec.mode === 'indicate',
                write: spec.mode !== 'write' && spec.write,
                writeWithoutResponse: spec.mode === 'write',
            };
            const value = {
                uuid: spec.characteristicUuid,
                properties,
                read: async () => Uint8Array.of(77),
                write: async bytes => this.writes.push([...bytes]),
                subscribe: async callback => {
                    this.callbacks.set(spec.id, callback);
                    return async () => this.callbacks.delete(spec.id);
                },
            };
            return [String(spec.characteristicUuid), value];
        }));
    }

    async connect() { this.connected = true; }
    async getCharacteristic(_serviceUuid, characteristicUuid) {
        const characteristic = this.characteristics.get(String(characteristicUuid));
        if (!characteristic) throw new Error('characteristic not found');
        return characteristic;
    }
    onDisconnect(callback) { this.disconnectHandlers.add(callback); return () => this.disconnectHandlers.delete(callback); }
    disconnect() { this.connected = false; for (const callback of this.disconnectHandlers) callback(); }
    dispose() {}
}

test('multiple generic GATT sources feed independent channels through acquisition', async () => {
    const checked = validateDeviceProfile(profileInput);
    const clock = new ManualClock();
    const service = new AcquisitionService({ clock });
    const readings = [];
    service.addSink(reading => readings.push(reading));
    const device = new FakeGattDevice(checked.profile);
    const entry = service.addDevice(device, checked.profile);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(entry.conn.state, STATES.STREAMING);
    assert.equal(device.callbacks.size, 2);

    device.callbacks.get('fast')(Uint8Array.of(0x2c, 0x01), clock.now());
    device.callbacks.get('event')(Uint8Array.of(9), clock.now());
    await new Promise(resolve => setImmediate(resolve));
    const battery = readings.find(reading => reading.channelId === 2);
    assert.ok(battery, 'read characteristics are polled into acquisition');
    assert.equal(battery.value, 77);
    assert.equal(readings.find(reading => reading.channelId === 0).value, 30);
    assert.equal(readings.find(reading => reading.channelId === 1).value, 9);

    const result = await service.writeGattCharacteristic(entry.handle, 'control', Uint8Array.of(1, 2));
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(device.writes, [[1, 2]]);
    await service.removeDevice(entry.handle);
    assert.equal(device.callbacks.size, 0);
});

test('a late read timeout after disconnect does not revive or degrade a closed connection', async () => {
    const profile = validateDeviceProfile({
        ...profileInput,
        characteristics: [{ id: 'polled', serviceUuid: '0x181a', characteristicUuid: '0x2a70', mode: 'read', decoder: 'uint8' }],
        channels: [{ channelId: 0, name: 'Value', unit: '', characteristicId: 'polled', valueIndex: 0, scale: 1, offset: 0 }],
    }).profile;
    const clock = new ManualClock();
    const service = new AcquisitionService({ clock });
    const device = new FakeGattDevice(profile);
    device.characteristics.get(String(profile.characteristics[0].characteristicUuid)).read = () => new Promise(() => {});
    const entry = service.addDevice(device, profile);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(clock.pending > 0);
    await service.removeDevice(entry.handle);
    assert.equal(entry.conn.state, STATES.CLOSED);
    await clock.advance(6000);
    assert.equal(entry.conn.state, STATES.CLOSED);
});

test('generic channel data uses host timestamps and preserves normal calibration state', () => {
    const profile = validateDeviceProfile(profileInput).profile;
    const clock = new ManualClock();
    const service = new AcquisitionService({ clock });
    const readings = [];
    service.addSink(reading => readings.push(reading));
    const entry = {
        profile,
        adapter: new GenericGattAdapter(profile),
        deviceId: 'test-device',
        simulated: false,
        channels: profile.channels.map(channel => ({ ...channel })),
        calibration: profile.channels.map(() => identityCalibration()),
        recent: profile.channels.map(() => []),
        tracker: new StreamTracker({ hostTimeOnly: true }),
        parse: { errors: {}, invalidPackets: 0, last: null },
        invalidSamples: 0,
    };
    assert.equal(service._onBytes(entry, Uint8Array.of(5), 10, 'event'), true);
    assert.equal(readings[0].devUs, null);
    assert.equal(readings[0].channelId, 1);
});
