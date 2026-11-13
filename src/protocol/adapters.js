import { encodeControl, OPCODES, parseDataPacket, parseDeviceInfo, UUIDS } from './sltp.js';
import { parseLegacy } from './legacy.js';
import { withTimeout } from '../util/clock.js';

export class SltpAdapter {
    constructor(channelCount = null) { this.channelCount = channelCount; }
    async discover(device, _profile, hooks) {
        const data = await device.getCharacteristic(UUIDS.service, UUIDS.data);
        const info = await device.getCharacteristic(UUIDS.service, UUIDS.info);
        let control = null;
        try { control = await device.getCharacteristic(UUIDS.service, UUIDS.control); } catch { /* optional characteristic */ }
        const result = parseDeviceInfo(await info.read());
        if (!result.ok) throw Object.assign(new Error(`device info invalid: ${result.error.code} ${result.error.detail}`), {
            code: `INFO_${result.error.code}`, nonRetryable: true,
        });
        const verdict = hooks.onInfo?.(result.info);
        if (verdict?.error) throw Object.assign(new Error(verdict.error), { code: verdict.code || 'IDENTITY', nonRetryable: true });
        return { data, info, control };
    }
    decode(bytes, channelCount = this.channelCount) { return parseDataPacket(bytes, channelCount); }
    encodeSampleRate(periodUs) { return encodeControl(OPCODES.SET_PERIOD, periodUs); }
    async sendControl(chars, bytes, verify, clock, config) {
        if (!chars?.control || !chars?.info) return { ok: false, error: 'device has no control characteristic' };
        try {
            await withTimeout(chars.control.write(bytes), config.controlAckTimeoutMs, clock, 'CONTROL_WRITE_TIMEOUT');
            const result = parseDeviceInfo(await withTimeout(chars.info.read(), config.controlAckTimeoutMs, clock, 'CONTROL_ACK_TIMEOUT'));
            if (!result.ok) return { ok: false, error: `info readback invalid: ${result.error.code}` };
            if (result.info.lastError) return { ok: false, error: `device rejected command (err ${result.info.lastError})`, info: result.info };
            if (verify && !verify(result.info)) return { ok: false, error: 'readback does not match requested setting', info: result.info };
            return { ok: true, info: result.info };
        } catch (e) {
            return { ok: false, error: String(e.message || e) };
        }
    }
    reset() {}
}

export class LegacyAdapter {
    constructor(format) { this.format = format; }
    async discover(device, profile) {
        const data = await device.getCharacteristic(profile.serviceUuid, profile.charUuid);
        return { data, info: null, control: null };
    }
    decode(bytes) { return parseLegacy(bytes, this.format); }
    reset() {}
}

export class UartFramer {
    constructor(config = {}) {
        this.config = config;
        this.buffer = new Uint8Array(0);
    }

    reset() { this.buffer = new Uint8Array(0); }

    _append(bytes, max) {
        const capacity = Math.max(4096, max * 16);
        if (this.buffer.length + bytes.length > capacity) {
            this.reset();
            return { ok: false, capacity };
        }
        const joined = new Uint8Array(this.buffer.length + bytes.length);
        joined.set(this.buffer);
        joined.set(bytes, this.buffer.length);
        this.buffer = joined;
        return { ok: true };
    }

    feed(input) {
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        const type = this.config.type || 'none';
        const max = this.config.maxFrameBytes || 512;
        if (type === 'none') {
            if (bytes.length > max) return { frames: [], errors: [{ code: 'FRAME_TOO_LARGE', detail: `frame exceeded ${max} bytes` }] };
            return { frames: bytes.length ? [bytes.slice()] : [], errors: [] };
        }
        const append = this._append(bytes, max);
        if (!append.ok) return { frames: [], errors: [{ code: 'FRAME_TOO_LARGE', detail: `buffer exceeded ${append.capacity} bytes` }] };
        if (type === 'newline' || type === 'delimiter') {
            const delimiter = new TextEncoder().encode(type === 'newline' ? '\n' : this.config.delimiter);
            if (!delimiter.length) {
                this.reset();
                return { frames: [], errors: [{ code: 'BAD_FRAMING', detail: 'delimiter cannot be empty' }] };
            }
            const frames = [];
            let start = 0;
            for (let i = 0; i <= this.buffer.length - delimiter.length;) {
                let match = true;
                for (let j = 0; j < delimiter.length; j++) if (this.buffer[i + j] !== delimiter[j]) { match = false; break; }
                if (!match) { i++; continue; }
                if (i - start > max) {
                    this.reset();
                    return { frames: [], errors: [{ code: 'FRAME_TOO_LARGE', detail: `frame exceeded ${max} bytes` }] };
                }
                const frame = this.buffer.slice(start, i);
                if (frame.length && frame[frame.length - 1] === 13) frames.push(frame.slice(0, -1));
                else frames.push(frame);
                i += delimiter.length;
                start = i;
            }
            if (this.buffer.length - start > max) {
                this.reset();
                return { frames: [], errors: [{ code: 'FRAME_TOO_LARGE', detail: `frame exceeded ${max} bytes` }] };
            }
            this.buffer = this.buffer.slice(start);
            return { frames: frames.filter(frame => frame.length > 0), errors: [] };
        }
        if (type !== 'length-prefixed') {
            this.reset();
            return { frames: [], errors: [{ code: 'BAD_FRAMING', detail: String(type) }] };
        }

        const prefix = this.config.lengthBytes;
        if (![1, 2, 4].includes(prefix)) {
            this.reset();
            return { frames: [], errors: [{ code: 'BAD_FRAMING', detail: 'lengthBytes must be 1, 2, or 4' }] };
        }
        const frames = [];
        let offset = 0;
        while (this.buffer.length - offset >= prefix) {
            let length = 0;
            if ((this.config.byteOrder || 'little') === 'little') {
                for (let i = prefix - 1; i >= 0; i--) length = length * 256 + this.buffer[offset + i];
            } else {
                for (let i = 0; i < prefix; i++) length = length * 256 + this.buffer[offset + i];
            }
            if (length < 1 || length > max) {
                this.reset();
                return { frames: [], errors: [{ code: 'BAD_FRAME_LENGTH', detail: `length ${length} outside 1–${max}` }] };
            }
            if (this.buffer.length - offset < prefix + length) break;
            frames.push(this.buffer.slice(offset + prefix, offset + prefix + length));
            offset += prefix + length;
        }
        this.buffer = this.buffer.slice(offset);
        return { frames, errors: [] };
    }
}

export class GenericGattAdapter {
    constructor(profile) {
        this.profile = profile;
        this.framers = new Map(profile.characteristics.map(c => [c.id, new UartFramer(c.framing)]));
        this.channelsByCharacteristic = new Map();
        for (const channel of profile.channels) {
            if (!this.channelsByCharacteristic.has(channel.characteristicId)) this.channelsByCharacteristic.set(channel.characteristicId, []);
            this.channelsByCharacteristic.get(channel.characteristicId).push(channel);
        }
    }

    async discover(device) {
        const streams = [];
        const writes = [];
        for (const spec of this.profile.characteristics) {
            const characteristic = await device.getCharacteristic(spec.serviceUuid, spec.characteristicUuid);
            const properties = characteristic.properties;
            const supported = !properties || (spec.mode === 'read' ? properties.read :
                spec.mode === 'notify' ? properties.notify :
                spec.mode === 'indicate' ? properties.indicate : (properties.write || properties.writeWithoutResponse));
            if (!supported) throw Object.assign(new Error(`${spec.id} does not support ${spec.mode}`), {
                code: 'GATT_MODE_UNSUPPORTED', nonRetryable: true,
            });
            if (spec.write && properties && !properties.write && !properties.writeWithoutResponse) throw Object.assign(new Error(`${spec.id} does not support writes`), {
                code: 'GATT_WRITE_UNSUPPORTED', nonRetryable: true,
            });
            const resolved = { ...spec, characteristic };
            if (spec.mode === 'write' || spec.write) writes.push(resolved);
            if (spec.mode !== 'write') streams.push(resolved);
        }
        return { data: null, info: null, control: null, streams, writes };
    }

    decode(bytes, characteristicId) {
        const characteristic = this.profile.characteristics.find(c => c.id === characteristicId);
        if (!characteristic) return { ok: false, error: { code: 'UNKNOWN_CHARACTERISTIC', detail: String(characteristicId) } };
        const framed = this.framers.get(characteristicId).feed(bytes);
        if (framed.errors.length) return { ok: false, error: framed.errors[0] };
        const channels = this.channelsByCharacteristic.get(characteristicId) || [];
        const samples = [];
        for (const frame of framed.frames) {
            const decoded = parseLegacy(frame, characteristic.decoder);
            if (!decoded.ok) return decoded;
            const missingIndex = channels.find(channel => channel.valueIndex >= decoded.values.length);
            if (missingIndex) return { ok: false, error: {
                code: 'VALUE_INDEX_OUT_OF_RANGE',
                detail: `channel ${missingIndex.channelId} selects value ${missingIndex.valueIndex}, but decoder produced ${decoded.values.length}`,
            } };
            const values = channels.map(channel => {
                return decoded.values[channel.valueIndex] ?? null;
            });
            samples.push({
                values,
                channelIds: channels.map(channel => channel.channelId),
                valid: values.map(value => Number.isFinite(value)),
            });
        }
        return { ok: true, samples };
    }

    reset() { for (const framer of this.framers.values()) framer.reset(); }
}

export function createProtocolAdapter(profile, channelCount = null) {
    if (profile.kind === 'sltp') return new SltpAdapter(channelCount);
    if (profile.kind === 'generic') return new GenericGattAdapter(profile);
    return new LegacyAdapter(profile.format);
}
