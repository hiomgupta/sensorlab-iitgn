/**
 * SLTP v1 — SensorLab Telemetry Protocol (see docs/PROTOCOL.md).
 * Pure functions: no DOM, BLE, storage or chart dependencies. Never throws on bad input;
 * every failure is returned as { ok: false, error: { code, detail } }.
 */

export const SLTP_VERSION = 1;
export const HEADER_LEN = 12;
export const MAX_CHANNELS = 8;

export const UUIDS = Object.freeze({
    service: '075e0001-9ad5-4c6a-96ae-ff1cbd6c71a6',
    data: '075e0002-9ad5-4c6a-96ae-ff1cbd6c71a6',
    info: '075e0003-9ad5-4c6a-96ae-ff1cbd6c71a6',
    control: '075e0004-9ad5-4c6a-96ae-ff1cbd6c71a6',
});

export const PACKET_FLAGS = Object.freeze({
    BOOT: 0x01,
    DEVICE_OVERRUN: 0x02,
    SENSOR_FAULT: 0x04,
});
const KNOWN_FLAG_BITS = 0x07;

export const OPCODES = Object.freeze({ STREAM_START: 0x01, STREAM_STOP: 0x02, SET_PERIOD: 0x03 });
export const PERIOD_MIN_US = 1000;
export const PERIOD_MAX_US = 10_000_000;

export const CONTROL_ERRORS = Object.freeze({ 0: 'OK', 1: 'BAD_VERSION', 2: 'UNKNOWN_OPCODE', 3: 'BAD_LENGTH', 4: 'OUT_OF_RANGE' });

/** Normalize DataView / ArrayBuffer / typed array input to a Uint8Array view of exactly the payload bytes. */
export function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof DataView) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return null;
}

export function bytesToHex(bytes, max = 64) {
    const b = toBytes(bytes);
    if (!b) return '';
    const n = Math.min(b.length, max);
    let s = '';
    for (let i = 0; i < n; i++) s += b[i].toString(16).padStart(2, '0');
    return b.length > max ? s + '…' : s;
}

function fail(code, detail) { return { ok: false, error: { code, detail } }; }

/**
 * Parse a DATA notification.
 * @param input bytes
 * @param {number|null} expectedChannels channel count from INFO (null = not yet known)
 */
export function parseDataPacket(input, expectedChannels = null) {
    const b = toBytes(input);
    if (!b) return fail('NOT_BYTES', 'payload is not a byte buffer');
    if (b.length < HEADER_LEN + 4) return fail('TOO_SHORT', `length ${b.length} < minimum ${HEADER_LEN + 4}`);
    const version = b[0];
    if (version !== SLTP_VERSION) return fail('UNSUPPORTED_VERSION', `version ${version}`);
    const n = b[1];
    if (n < 1 || n > MAX_CHANNELS) return fail('BAD_CHANNEL_COUNT', `channel count ${n}`);
    const expectedLen = HEADER_LEN + 4 * n;
    if (b.length !== expectedLen) return fail('LENGTH_MISMATCH', `length ${b.length} != ${expectedLen} for ${n} channels`);
    if (expectedChannels != null && n !== expectedChannels) {
        return fail('CHANNEL_COUNT_MISMATCH', `packet has ${n} channels, device info declares ${expectedChannels}`);
    }
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const flags = b[10];
    if (flags & ~KNOWN_FLAG_BITS) return fail('RESERVED_FLAGS', `flags 0x${flags.toString(16)}`);
    const validMask = b[11];
    if (n < 8 && (validMask >> n) !== 0) return fail('BAD_VALID_MASK', `mask 0x${validMask.toString(16)} for ${n} channels`);
    const values = new Array(n);
    const valid = new Array(n);
    for (let i = 0; i < n; i++) {
        values[i] = dv.getInt32(HEADER_LEN + 4 * i, true);
        valid[i] = ((validMask >> i) & 1) === 1;
    }
    return {
        ok: true,
        packet: {
            version,
            channelCount: n,
            sequence: dv.getUint32(2, true),
            deviceTimeUs: dv.getUint32(6, true),
            flags,
            values,
            valid,
        },
    };
}

/** Encode a DATA packet (used by the simulator and tests; mirrors firmware sltp_encode_data). */
export function encodeDataPacket({ sequence, deviceTimeUs, flags = 0, values, valid }) {
    const n = values.length;
    if (n < 1 || n > MAX_CHANNELS) throw new RangeError('channel count');
    const b = new Uint8Array(HEADER_LEN + 4 * n);
    const dv = new DataView(b.buffer);
    b[0] = SLTP_VERSION;
    b[1] = n;
    dv.setUint32(2, sequence >>> 0, true);
    dv.setUint32(6, deviceTimeUs >>> 0, true);
    b[10] = flags & 0xff;
    let mask = 0;
    for (let i = 0; i < n; i++) {
        if (!valid || valid[i]) mask |= 1 << i;
        dv.setInt32(HEADER_LEN + 4 * i, values[i] | 0, true);
    }
    b[11] = mask;
    return b;
}

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Parse and validate the INFO characteristic JSON. */
export function parseDeviceInfo(input) {
    const b = toBytes(input);
    if (!b) return fail('NOT_BYTES', 'payload is not a byte buffer');
    if (b.length === 0) return fail('EMPTY', 'empty info');
    if (b.length > 512) return fail('TOO_LONG', `info length ${b.length} > 512`);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return fail('BAD_UTF8', 'info is not valid UTF-8'); }
    let o;
    try { o = JSON.parse(text); } catch (e) { return fail('BAD_JSON', String(e.message).slice(0, 120)); }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return fail('BAD_INFO', 'info is not an object');
    if (o.p !== SLTP_VERSION) return fail('UNSUPPORTED_VERSION', `protocol ${JSON.stringify(o.p)}`);
    if (typeof o.id !== 'string' || !ID_RE.test(o.id)) return fail('BAD_INFO', 'id missing or invalid');
    if (!Array.isArray(o.ch) || o.ch.length < 1 || o.ch.length > MAX_CHANNELS) return fail('BAD_INFO', 'ch must have 1..8 entries');
    const channels = [];
    for (let i = 0; i < o.ch.length; i++) {
        const c = o.ch[i];
        if (!c || typeof c.n !== 'string' || c.n.length === 0 || c.n.length > 32) return fail('BAD_INFO', `ch[${i}].n invalid`);
        if (typeof c.u !== 'string' || c.u.length > 16) return fail('BAD_INFO', `ch[${i}].u invalid`);
        if (typeof c.s !== 'number' || !Number.isFinite(c.s) || c.s === 0) return fail('BAD_INFO', `ch[${i}].s invalid`);
        const off = c.o ?? 0;
        if (typeof off !== 'number' || !Number.isFinite(off)) return fail('BAD_INFO', `ch[${i}].o invalid`);
        channels.push({ channelId: i, name: c.n, unit: c.u, scale: c.s, offset: off });
    }
    const period = o.period_us;
    if (period != null && (!Number.isInteger(period) || period < PERIOD_MIN_US || period > PERIOD_MAX_US)) {
        return fail('BAD_INFO', 'period_us out of range');
    }
    return {
        ok: true,
        info: {
            protocol: o.p,
            firmware: typeof o.fw === 'string' ? o.fw.slice(0, 32) : null,
            serial: o.id,
            model: typeof o.model === 'string' ? o.model.slice(0, 32) : null,
            periodUs: period ?? null,
            streaming: o.st === 1 ? true : o.st === 0 ? false : null,
            lastError: Number.isInteger(o.err) ? o.err : null,
            bootId: Number.isInteger(o.b) && o.b >= 0 && o.b <= 0xffffffff ? o.b : null,
            channels,
        },
    };
}

export function encodeDeviceInfo(info) {
    const o = {
        p: SLTP_VERSION, fw: info.firmware, id: info.serial, model: info.model,
        period_us: info.periodUs, st: info.streaming ? 1 : 0, err: info.lastError ?? 0, b: info.bootId ?? 0,
        ch: info.channels.map(c => ({ n: c.name, u: c.unit, s: c.scale, o: c.offset })),
    };
    return new TextEncoder().encode(JSON.stringify(o));
}

export function encodeControl(opcode, arg) {
    if (opcode === OPCODES.SET_PERIOD) {
        if (!Number.isInteger(arg) || arg < PERIOD_MIN_US || arg > PERIOD_MAX_US) throw new RangeError('period_us out of range');
        const b = new Uint8Array(6);
        b[0] = SLTP_VERSION; b[1] = opcode;
        new DataView(b.buffer).setUint32(2, arg, true);
        return b;
    }
    if (opcode === OPCODES.STREAM_START || opcode === OPCODES.STREAM_STOP) return Uint8Array.of(SLTP_VERSION, opcode);
    throw new RangeError('unknown opcode');
}

/** Device-side control decoding (used by the simulator; mirrors firmware sltp_decode_control). */
export function decodeControl(input) {
    const b = toBytes(input);
    if (!b || b.length < 2) return { err: 3 };
    if (b[0] !== SLTP_VERSION) return { err: 1 };
    const op = b[1];
    if (op === OPCODES.STREAM_START || op === OPCODES.STREAM_STOP) return b.length === 2 ? { err: 0, op } : { err: 3 };
    if (op === OPCODES.SET_PERIOD) {
        if (b.length !== 6) return { err: 3 };
        const p = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(2, true);
        if (p < PERIOD_MIN_US || p > PERIOD_MAX_US) return { err: 4 };
        return { err: 0, op, periodUs: p };
    }
    return { err: 2 };
}
