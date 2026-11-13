/**
 * Minimal ZIP writer (stored entries, no compression, UTF-8 names). It has no dependencies, so
 * bundle export works offline.
 *
 * buildZipParts() never concatenates a whole file into one string or buffer. Each entry's data can be a list of
 * parts (strings ≤ ~1 MB or Uint8Arrays), which are encoded part by part with an incremental CRC-32, and the result is a
 * list of Uint8Array parts for `new Blob(parts)`. This avoids V8's maximum string length ("Invalid string length",
 * observed at 6 M readings) and the extra full-size copies of the previous join → encode → copy approach.
 * ZIP32 limits apply: each entry and the archive must be < 4 GiB (an explicit error otherwise).
 */
let CRC_TABLE = null;
function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        CRC_TABLE[n] = c >>> 0;
    }
    return CRC_TABLE;
}

/** Incremental CRC-32: crc32Update(state, bytes) …; final = crc32Final(state). */
export const crc32Init = () => 0xffffffff;
export function crc32Update(c, bytes) {
    const t = crcTable();
    for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return c;
}
export const crc32Final = (c) => (c ^ 0xffffffff) >>> 0;
export function crc32(bytes) { return crc32Final(crc32Update(crc32Init(), bytes)); }

function dosDateTime(d) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
}

const U32_MAX = 0xffffffff;

/**
 * @param {{name:string, data:Uint8Array|string|Array<Uint8Array|string>}[]} files
 * @returns {Uint8Array[]} archive as parts (in order)
 */
export function buildZipParts(files, when = new Date()) {
    const enc = new TextEncoder();
    const { time, date } = dosDateTime(when);
    const out = [], centrals = [];
    let offset = 0;
    for (const f of files) {
        const name = enc.encode(f.name);
        const chunks = (Array.isArray(f.data) ? f.data : [f.data]).map(p => (typeof p === 'string' ? enc.encode(p) : p));
        const size = chunks.reduce((a, c) => a + c.length, 0);
        if (size > U32_MAX || offset > U32_MAX) throw new RangeError(`ZIP entry "${f.name}" exceeds the 4 GiB ZIP32 limit; export CSV/JSON separately`);
        let crc = crc32Init();
        for (const c of chunks) crc = crc32Update(crc, c);
        crc = crc32Final(crc);
        const lh = new Uint8Array(30 + name.length);
        const lv = new DataView(lh.buffer);
        lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
        lv.setUint16(10, time, true); lv.setUint16(12, date, true); lv.setUint32(14, crc, true);
        lv.setUint32(18, size, true); lv.setUint32(22, size, true); lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
        lh.set(name, 30);
        const ch = new Uint8Array(46 + name.length);
        const cv = new DataView(ch.buffer);
        cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
        cv.setUint16(10, 0, true); cv.setUint16(12, time, true); cv.setUint16(14, date, true); cv.setUint32(16, crc, true);
        cv.setUint32(20, size, true); cv.setUint32(24, size, true); cv.setUint16(28, name.length, true);
        cv.setUint32(42, offset, true);
        ch.set(name, 46);
        out.push(lh, ...chunks);
        centrals.push(ch);
        offset += lh.length + size;
    }
    const cdSize = centrals.reduce((a, c) => a + c.length, 0);
    if (offset + cdSize > U32_MAX) throw new RangeError('ZIP archive exceeds the 4 GiB ZIP32 limit; export CSV/JSON separately');
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    out.push(...centrals, eocd);
    return out;
}

/** Whole archive in one Uint8Array (small archives: tests, release packaging). */
export function buildZip(files, when = new Date()) {
    const parts = buildZipParts(files, when);
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let p = 0;
    for (const part of parts) { out.set(part, p); p += part.length; }
    return out;
}
