import 'fake-indexeddb/auto';
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
import { SessionController } from '../../src/acquisition/session-controller.js';
import { IdbRepository } from '../../src/storage/idb-repository.js';
import { Recorder } from '../../src/storage/recorder.js';
import { buildCsvParts, buildJson, CSV_COLUMNS, integrityReport, iterateReadings, parseCsv, parseExportJson } from '../../src/export/export.js';
import { Q } from '../../src/acquisition/quality.js';

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

test('multiple generic devices retain distinct identities through verified recording and export', async t => {
    const profile = validateDeviceProfile({
        ...profileInput,
        sampling: { intervalMs: 100 },
        characteristics: [profileInput.characteristics[2]],
        channels: [{ ...profileInput.channels[2], channelId: 0 }],
    }).profile;
    const clock = new ManualClock();
    const repo = new IdbRepository({ dbName: 'generic-recording' });
    const service = new AcquisitionService({ clock });
    service.recorder = new Recorder({ repo, clock, locks: null, persist: async () => null, newId: () => 'generic-session' });
    const controller = new SessionController({ service, clock });
    t.after(async () => { await service.shutdown(); repo.close(); });
    const expected = [];
    service.addSink((reading, entry) => { if (service.isRecorded(entry)) expected.push({ ...reading }); });
    const devices = [77, 123].map((value, i) => {
        const device = new FakeGattDevice(profile);
        device.transportId += '-' + i;
        device.characteristics.get(String(profile.characteristics[0].characteristicUuid)).read = async () => Uint8Array.of(value);
        return device;
    });
    const entries = devices.map(device => service.addDevice(device, profile));
    await clock.advance(10);
    assert.deepEqual(entries.map(entry => entry.deviceId), devices.map(device => device.transportId));
    const starting = controller.start({ name: 'Two generic sensors', include: entries.map(entry => entry.handle), keepAwake: false });
    await clock.advance(1000);
    const started = await starting;
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(controller.state, 'RECORDING');
    await clock.advance(1000);
    const stopping = controller.stop();
    await clock.advance(100);
    const summary = await stopping;
    assert.equal(summary.ok, true);
    const snapshot = await repo.readSnapshot(started.sessionId);
    const stored = [...iterateReadings(snapshot)];
    assert.ok(stored.length > 10);
    assert.deepEqual(stored, expected);
    assert.equal(summary.persisted, expected.length);
    for (const [i, device] of devices.entries()) {
        const readings = stored.filter(reading => reading.deviceId === device.transportId);
        assert.ok(readings.length > 5);
        assert.ok(readings.every(reading => reading.value === [77, 123][i] && reading.devUs === null && (reading.flags & Q.HOST_TIME_ONLY)));
        const metadata = snapshot.session.devices[device.transportId];
        assert.equal(metadata.protocol, 'generic-gatt/1');
        assert.equal(snapshot.session.quality[device.transportId].stream.hostTimeOnly, true);
    }
    const csv = parseCsv(buildCsvParts(snapshot).parts.join(''));
    assert.equal(csv.length - 1, stored.length);
    const deviceColumn = CSV_COLUMNS.indexOf('device_id');
    const valueColumn = CSV_COLUMNS.indexOf('value');
    assert.deepEqual(csv.slice(1).map(row => [row[deviceColumn], Number(row[valueColumn])]), stored.map(reading => [reading.deviceId, reading.value]));
    assert.ok(integrityReport(snapshot).warnings.some(warning => /sample loss cannot be detected/.test(warning)));
    const imported = parseExportJson(buildJson(snapshot));
    assert.equal(imported.ok, true, imported.error);
    assert.deepEqual([...iterateReadings(imported.snapshot)], stored);
});

test('reconnection discards incomplete generic frames and ignores old subscription callbacks', async t => {
    for (const spec of [
        { framing: { type: 'newline' }, decoder: 'text-float', before: new TextEncoder().encode('12'), after: new TextEncoder().encode('3\n'), expected: 3 },
        { framing: { type: 'length-prefixed', lengthBytes: 1 }, decoder: 'uint8', before: Uint8Array.of(2, 0x34), after: Uint8Array.of(1, 5), expected: 5 },
    ]) {
        const profile = validateDeviceProfile({
            ...profileInput,
            characteristics: [{ ...profileInput.characteristics[0], framing: spec.framing, decoder: spec.decoder }],
            channels: [{ ...profileInput.channels[0], scale: 1 }],
        }).profile;
        const clock = new ManualClock();
        const service = new AcquisitionService({ clock });
        t.after(() => service.shutdown());
        const readings = [];
        service.addSink(reading => readings.push(reading));
        const device = new FakeGattDevice(profile);
        const entry = service.addDevice(device, profile);
        await clock.advance(1);
        const oldCallback = device.callbacks.get('fast');
        oldCallback(spec.before, clock.now());
        assert.equal(readings.length, 0);
        device.disconnect();
        await clock.advance(1200);
        assert.equal(entry.conn.state, STATES.WAITING_FOR_DATA);
        oldCallback(spec.after, clock.now());
        assert.equal(readings.length, 0, 'old subscriptions must not mutate the new connection parser');
        device.callbacks.get('fast')(spec.after, clock.now());
        assert.deepEqual(readings.map(reading => reading.raw), [spec.expected], spec.framing.type);
        assert.equal(entry.conn.counters.reconnects, 1);
    }
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
