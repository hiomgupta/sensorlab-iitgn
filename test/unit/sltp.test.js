import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    parseDataPacket, encodeDataPacket, parseDeviceInfo, encodeDeviceInfo,
    encodeControl, decodeControl, OPCODES, bytesToHex,
} from '../../src/protocol/sltp.js';

const V = JSON.parse(readFileSync(new URL('../fixtures/sltp-v1-vectors.json', import.meta.url), 'utf8'));
const hex = (h) => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));

test('every data vector decodes to its declared fields (little-endian, signed)', () => {
    for (const v of V.data) {
        const r = parseDataPacket(hex(v.hex));
        assert.equal(r.ok, true, v.name);
        assert.equal(r.packet.sequence, v.sequence, v.name);
        assert.equal(r.packet.deviceTimeUs, v.deviceTimeUs, v.name);
        assert.equal(r.packet.flags, v.flags, v.name);
        assert.deepEqual(r.packet.values, v.values, v.name);
        assert.deepEqual(r.packet.valid, v.valid, v.name);
    }
});

test('encoder produces the hand-computed bytes exactly', () => {
    for (const v of V.data) assert.equal(bytesToHex(encodeDataPacket(v), 1000), v.hex, v.name);
});

test('every invalid vector is rejected with the expected code', () => {
    for (const v of V.invalid_data) {
        const r = parseDataPacket(hex(v.hex));
        assert.equal(r.ok, false, v.name);
        assert.equal(r.error.code, v.code, v.name);
    }
});

test('parser accepts DataView with non-zero byteOffset (no whole-buffer decode)', () => {
    const pkt = hex(V.data[0].hex);
    const big = new Uint8Array(pkt.length + 7);
    big.set(pkt, 5);
    const r = parseDataPacket(new DataView(big.buffer, 5, pkt.length));
    assert.equal(r.ok, true);
    assert.deepEqual(r.packet.values, [100, -5]);
});

test('channel count must match device info when known', () => {
    const r = parseDataPacket(hex(V.data[0].hex), 3);
    assert.equal(r.error.code, 'CHANNEL_COUNT_MISMATCH');
});

test('min and max valid lengths', () => {
    assert.equal(parseDataPacket(encodeDataPacket({ sequence: 0, deviceTimeUs: 0, values: [1] })).ok, true);
    assert.equal(parseDataPacket(encodeDataPacket({ sequence: 0, deviceTimeUs: 0, values: [1, 2, 3, 4, 5, 6, 7, 8] })).ok, true);
});

test('int32 boundary values round-trip', () => {
    const values = [2147483647, -2147483648, 0, -1];
    const r = parseDataPacket(encodeDataPacket({ sequence: 9, deviceTimeUs: 9, values }));
    assert.deepEqual(r.packet.values, values);
});

test('fuzz: random bytes never throw and always return ok or a coded error', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 20000; i++) {
        const len = Math.floor(rnd() * 50);
        const b = new Uint8Array(len);
        for (let j = 0; j < len; j++) b[j] = Math.floor(rnd() * 256);
        if (len > 0 && rnd() < 0.5) b[0] = 1;
        if (len > 1 && rnd() < 0.5) b[1] = 1 + Math.floor(rnd() * 8);
        const r = parseDataPacket(b);
        assert.ok(r.ok === true || (r.ok === false && typeof r.error.code === 'string'));
    }
    for (const bad of [null, undefined, 42, 'abc', {}, []]) assert.equal(parseDataPacket(bad).ok, false);
});

test('device info: valid round trip and strict validation', () => {
    const info = {
        firmware: '2.0.0', serial: 'A1B2C3D4E5F6', model: 'SLab-R1', periodUs: 100000, streaming: true, lastError: 0,
        channels: [{ name: 'adc_mean', unit: 'count', scale: 0.0625, offset: 0 }, { name: 'resistance', unit: 'Ω', scale: 0.01, offset: 0 }],
    };
    const r = parseDeviceInfo(encodeDeviceInfo(info));
    assert.equal(r.ok, true);
    assert.equal(r.info.serial, 'A1B2C3D4E5F6');
    assert.equal(r.info.channels[1].unit, 'Ω');
    assert.equal(r.info.channels[1].channelId, 1);
    const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
    const base = { p: 1, id: 'X1', ch: [{ n: 'a', u: 'V', s: 1, o: 0 }] };
    assert.equal(parseDeviceInfo(enc(base)).ok, true);
    assert.equal(parseDeviceInfo(enc({ ...base, p: 2 })).error.code, 'UNSUPPORTED_VERSION');
    assert.equal(parseDeviceInfo(enc({ ...base, id: '<script>' })).error.code, 'BAD_INFO');
    assert.equal(parseDeviceInfo(enc({ ...base, ch: [] })).error.code, 'BAD_INFO');
    assert.equal(parseDeviceInfo(enc({ ...base, ch: [{ n: 'a', u: 'V', s: 0 }] })).error.code, 'BAD_INFO');
    assert.equal(parseDeviceInfo(enc({ ...base, period_us: 5 })).error.code, 'BAD_INFO');
    assert.equal(parseDeviceInfo(new TextEncoder().encode('{nope')).error.code, 'BAD_JSON');
    assert.equal(parseDeviceInfo(Uint8Array.of(0xff, 0xfe)).error.code, 'BAD_UTF8');
    assert.equal(parseDeviceInfo(new Uint8Array(600)).error.code, 'TOO_LONG');
});

test('control encode matches vectors; device-side decode validates', () => {
    for (const c of V.control) assert.equal(bytesToHex(encodeControl(c.opcode, c.arg)), c.hex, c.name);
    assert.deepEqual(decodeControl(hex('0103a0860100')), { err: 0, op: 3, periodUs: 100000 });
    assert.equal(decodeControl(hex('0203a0860100')).err, 1);
    assert.equal(decodeControl(hex('0109')).err, 2);
    assert.equal(decodeControl(hex('0103a086')).err, 3);
    assert.equal(decodeControl(hex('010301000000')).err, 4);
    assert.throws(() => encodeControl(OPCODES.SET_PERIOD, 10));
});
