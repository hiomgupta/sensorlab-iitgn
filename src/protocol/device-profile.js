import { LEGACY_FORMATS } from './legacy.js';

export const DEVICE_PROFILE_SCHEMA = 'sensorlab-device-profile/1';
export const MAX_PROFILE_BYTES = 256 * 1024;
const UUID128 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_UUID = /^0x[0-9a-f]{4}$/i;
const NAMED_UUID = /^[a-z][a-z0-9_]*$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const FRAME_TYPES = new Set(['none', 'newline', 'delimiter', 'length-prefixed']);
const BYTE_ORDERS = new Set(['little', 'big']);

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function hasUnexpectedKeys(value, allowed) { return Object.keys(value).find(key => !allowed.includes(key)) || null; }

export function normalizeGattUuid(value) {
    if (Number.isInteger(value) && value >= 0 && value <= 0xffff) return value;
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (UUID128.test(text)) return text.toLowerCase();
    if (SHORT_UUID.test(text)) return Number.parseInt(text.slice(2), 16);
    if (NAMED_UUID.test(text)) return text;
    return null;
}

function fail(error) { return { ok: false, error }; }

export function validateDeviceProfile(input) {
    if (!isRecord(input)) return fail('profile must be an object');
    const unexpected = hasUnexpectedKeys(input, ['schema', 'version', 'id', 'name', 'transport', 'adapter', 'kind', 'match', 'sampling', 'characteristics', 'channels']);
    if (unexpected) return fail(`unsupported profile field: ${unexpected}`);
    if (input.schema !== DEVICE_PROFILE_SCHEMA) return fail(`unsupported profile schema (expected ${DEVICE_PROFILE_SCHEMA})`);
    if (input.version !== 1) return fail('unsupported profile version');
    if (input.kind !== undefined && input.kind !== 'generic') return fail('kind, when provided, must be generic');
    if (typeof input.id !== 'string' || !ID.test(input.id)) return fail('profile id must be 1–64 letters, digits, "_" or "-"');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) return fail('profile name must be 1–100 characters');
    if (input.transport !== 'web-bluetooth' || input.adapter !== 'generic-gatt') return fail('profile must use web-bluetooth and generic-gatt');
    if (input.match !== undefined && (!isRecord(input.match) ||
        (input.match.namePrefix !== undefined && (typeof input.match.namePrefix !== 'string' || input.match.namePrefix.length > 64)))) {
        return fail('match must be an object with an optional namePrefix');
    }
    if (input.match && hasUnexpectedKeys(input.match, ['namePrefix'])) return fail('match contains an unsupported field');
    if (input.sampling !== undefined && (!isRecord(input.sampling) ||
        (input.sampling.intervalMs !== undefined && (!Number.isFinite(input.sampling.intervalMs) || input.sampling.intervalMs < 50 || input.sampling.intervalMs > 60_000)))) {
        return fail('sampling.intervalMs must be between 50 and 60000 ms');
    }
    if (input.sampling && hasUnexpectedKeys(input.sampling, ['intervalMs'])) return fail('sampling contains an unsupported field');
    if (!Array.isArray(input.characteristics) || input.characteristics.length < 1 || input.characteristics.length > 32) {
        return fail('profile must define 1–32 characteristics');
    }
    if (!Array.isArray(input.channels) || input.channels.length < 1 || input.channels.length > 256) {
        return fail('profile must define 1–256 channels');
    }

    const chars = new Map();
    const normalizedCharacteristics = [];
    for (const [i, source] of input.characteristics.entries()) {
        if (!isRecord(source) || typeof source.id !== 'string' || !ID.test(source.id)) return fail(`characteristic ${i} has an invalid id`);
        if (hasUnexpectedKeys(source, ['id', 'serviceUuid', 'characteristicUuid', 'mode', 'decoder', 'framing', 'write'])) return fail(`characteristic ${i} contains an unsupported field`);
        if (chars.has(source.id)) return fail(`duplicate characteristic id ${source.id}`);
        const serviceUuid = normalizeGattUuid(source.serviceUuid);
        const characteristicUuid = normalizeGattUuid(source.characteristicUuid);
        if (serviceUuid === null || characteristicUuid === null) return fail(`characteristic ${source.id} has an invalid service or characteristic UUID`);
        if (!['read', 'notify', 'indicate', 'write'].includes(source.mode)) return fail(`characteristic ${source.id} mode must be read, notify, indicate, or write`);
        if (source.mode !== 'write' && !LEGACY_FORMATS.includes(source.decoder)) return fail(`characteristic ${source.id} has an unsupported decoder`);
        if (source.write !== undefined && typeof source.write !== 'boolean') return fail(`characteristic ${source.id} write must be boolean`);
        if (source.mode === 'write' && source.write === false) return fail(`write-mode characteristic ${source.id} must be writable`);
        const frame = source.framing ?? { type: 'none' };
        if (!isRecord(frame) || hasUnexpectedKeys(frame, ['type', 'delimiter', 'lengthBytes', 'byteOrder', 'maxFrameBytes']) || !FRAME_TYPES.has(frame.type)) return fail(`characteristic ${source.id} has an unsupported frame type`);
        const normalizedFrame = { type: frame.type };
        if (frame.type === 'delimiter') {
            if (typeof frame.delimiter !== 'string' || frame.delimiter.length < 1 || frame.delimiter.length > 8) return fail(`characteristic ${source.id} delimiter must be 1–8 characters`);
            normalizedFrame.delimiter = frame.delimiter;
        } else if (frame.type === 'newline') {
            normalizedFrame.delimiter = '\n';
        } else if (frame.type === 'length-prefixed') {
            if (![1, 2, 4].includes(frame.lengthBytes) || !BYTE_ORDERS.has(frame.byteOrder ?? 'little')) return fail(`characteristic ${source.id} length prefix must be 1, 2, or 4 bytes with little/big byte order`);
            normalizedFrame.lengthBytes = frame.lengthBytes;
            normalizedFrame.byteOrder = frame.byteOrder ?? 'little';
        }
        const maxFrameBytes = frame.maxFrameBytes ?? 512;
        if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > 4096) return fail(`characteristic ${source.id} maxFrameBytes must be 1–4096`);
        normalizedFrame.maxFrameBytes = maxFrameBytes;
        const normalized = {
            id: source.id, serviceUuid, characteristicUuid, mode: source.mode, decoder: source.mode === 'write' ? null : source.decoder,
            framing: normalizedFrame, write: source.mode === 'write' || source.write === true,
        };
        chars.set(source.id, normalized);
        normalizedCharacteristics.push(normalized);
    }

    const channelIds = new Set();
    const channels = [];
    for (const [i, source] of input.channels.entries()) {
        if (isRecord(source) && Number.isInteger(source.channelId) && source.channelId !== i) return fail('channel IDs must be contiguous zero-based indices');
        if (!isRecord(source) || !Number.isInteger(source.channelId) || source.channelId < 0 || source.channelId > 255 ||
            hasUnexpectedKeys(source, ['channelId', 'name', 'unit', 'characteristicId', 'valueIndex', 'scale', 'offset']) ||
            typeof source.name !== 'string' || !source.name.trim() || source.name.length > 64 ||
            typeof source.unit !== 'string' || source.unit.length > 32 ||
            typeof source.characteristicId !== 'string' || !chars.has(source.characteristicId) ||
            !Number.isInteger(source.valueIndex ?? 0) || (source.valueIndex ?? 0) < 0 ||
            !Number.isFinite(source.scale ?? 1) || (source.scale ?? 1) === 0 ||
            !Number.isFinite(source.offset ?? 0)) {
            return fail(`channel ${i} is malformed or references an unknown characteristic`);
        }
        if (channelIds.has(source.channelId)) return fail(`duplicate channel id ${source.channelId}`);
        channelIds.add(source.channelId);
        if (chars.get(source.characteristicId).mode === 'write') return fail(`channel ${i} references a write-only characteristic`);
        channels.push({
            channelId: source.channelId, name: source.name, unit: source.unit,
            characteristicId: source.characteristicId, valueIndex: source.valueIndex ?? 0,
            scale: source.scale ?? 1, offset: source.offset ?? 0,
        });
    }
    for (const characteristic of normalizedCharacteristics) {
        if (characteristic.mode !== 'write' && !channels.some(channel => channel.characteristicId === characteristic.id)) {
            return fail(`data characteristic ${characteristic.id} must map to at least one channel`);
        }
    }
    return {
        ok: true,
        profile: {
            schema: DEVICE_PROFILE_SCHEMA, version: 1, id: input.id, name: input.name.trim(),
            transport: 'web-bluetooth', adapter: 'generic-gatt', kind: 'generic',
            match: input.match ? { ...(input.match.namePrefix ? { namePrefix: input.match.namePrefix } : {}) } : {},
            sampling: input.sampling ? { ...input.sampling } : {},
            characteristics: normalizedCharacteristics, channels,
        },
    };
}

export function parseDeviceProfileJson(text) {
    if (typeof text !== 'string') return fail('profile input must be JSON text');
    if (text.length > MAX_PROFILE_BYTES || new TextEncoder().encode(text).length > MAX_PROFILE_BYTES) return fail(`profile exceeds the ${MAX_PROFILE_BYTES}-byte limit`);
    let value;
    try { value = JSON.parse(text); } catch (e) { return fail(`invalid JSON: ${e.message}`); }
    return validateDeviceProfile(value);
}

export function stringifyDeviceProfile(profile) {
    const result = validateDeviceProfile(profile);
    if (!result.ok) throw new TypeError(result.error);
    const portableProfile = { ...result.profile };
    delete portableProfile.kind;
    return JSON.stringify(portableProfile, null, 2);
}
