/**
 * Legacy (pre-SLTP) payload formats. These carry no sequence number and no device timestamp.
 * Pure, strict and non-throwing. Malformed input returns an explicit error rather than being
 * silently skipped or partially parsed.
 */
import { toBytes } from './sltp.js';

export const LEGACY_FORMATS = Object.freeze([
    'text-float', 'text-csv', 'text-json',
    'float32-le', 'float32-be', 'int16-le', 'int16-be', 'uint16-le', 'uint16-be', 'uint8',
    'gatt-heart-rate',
]);

const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const MAX_TEXT = 512;

function fail(code, detail) { return { ok: false, error: { code, detail } }; }

function strictNumber(s) {
    const t = s.trim();
    if (!NUM_RE.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
}

function decodeText(b) {
    if (b.length > MAX_TEXT) return { error: fail('TOO_LONG', `text payload ${b.length} bytes`) };
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(b) }; }
    catch { return { error: fail('BAD_UTF8', 'payload is not valid UTF-8') }; }
}

const FIXED = {
    'float32-le': [4, (dv) => dv.getFloat32(0, true)],
    'float32-be': [4, (dv) => dv.getFloat32(0, false)],
    'int16-le': [2, (dv) => dv.getInt16(0, true)],
    'int16-be': [2, (dv) => dv.getInt16(0, false)],
    'uint16-le': [2, (dv) => dv.getUint16(0, true)],
    'uint16-be': [2, (dv) => dv.getUint16(0, false)],
    'uint8': [1, (dv) => dv.getUint8(0)],
};

/**
 * @returns {{ok:true, values:number[]} | {ok:false, error:{code,detail}}}
 * Values are raw device values (before scale factor / calibration).
 */
export function parseLegacy(input, format) {
    const b = toBytes(input);
    if (!b) return fail('NOT_BYTES', 'payload is not a byte buffer');
    if (b.length === 0) return fail('EMPTY', 'empty notification');

    if (FIXED[format]) {
        const [len, read] = FIXED[format];
        if (b.length !== len) return fail('LENGTH_MISMATCH', `${format} expects ${len} bytes, got ${b.length}`);
        const v = read(new DataView(b.buffer, b.byteOffset, b.byteLength));
        if (!Number.isFinite(v)) return fail('NON_FINITE', `${format} decoded ${v}`);
        return { ok: true, values: [v] };
    }

    switch (format) {
        case 'gatt-heart-rate': {
            // Bluetooth SIG Heart Rate Measurement (0x2A37): flags bit0 selects uint8 / uint16 LE.
            const wide = (b[0] & 0x01) === 1;
            const need = wide ? 3 : 2;
            if (b.length < need) return fail('TOO_SHORT', `heart rate needs ${need} bytes, got ${b.length}`);
            const v = wide ? (b[1] | (b[2] << 8)) : b[1];
            return { ok: true, values: [v] };
        }
        case 'text-float': {
            const d = decodeText(b); if (d.error) return d.error;
            const n = strictNumber(d.text);
            return n === null ? fail('NOT_A_NUMBER', JSON.stringify(d.text.slice(0, 40))) : { ok: true, values: [n] };
        }
        case 'text-csv': {
            const d = decodeText(b); if (d.error) return d.error;
            const parts = d.text.trim().split(',');
            const values = [];
            for (const p of parts) {
                const n = strictNumber(p);
                if (n === null) return fail('NOT_A_NUMBER', `csv field ${JSON.stringify(p.slice(0, 20))}`);
                values.push(n);
            }
            if (values.length > 8) return fail('BAD_CHANNEL_COUNT', `${values.length} csv fields`);
            return { ok: true, values };
        }
        case 'text-json': {
            const d = decodeText(b); if (d.error) return d.error;
            let o;
            try { o = JSON.parse(d.text); } catch { return fail('BAD_JSON', JSON.stringify(d.text.slice(0, 40))); }
            let arr = null;
            if (typeof o === 'number') arr = [o];
            else if (Array.isArray(o)) arr = o;
            else if (o && typeof o === 'object') {
                if (typeof o.value === 'number') arr = [o.value];
                else if (typeof o.v === 'number') arr = [o.v];
                else if (Array.isArray(o.values)) arr = o.values;
            }
            if (!arr) return fail('UNRECOGNIZED_JSON_SHAPE', 'expected number, array, {value}, {v} or {values}');
            if (arr.length < 1 || arr.length > 8) return fail('BAD_CHANNEL_COUNT', `${arr.length} values`);
            if (!arr.every(x => typeof x === 'number' && Number.isFinite(x))) return fail('NOT_A_NUMBER', 'non-numeric JSON value');
            return { ok: true, values: arr.slice() };
        }
        default:
            return fail('UNKNOWN_FORMAT', String(format));
    }
}
