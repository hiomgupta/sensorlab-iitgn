/**
 * Export builders (docs/EXPORT_SCHEMA.md). Pure functions over a repository snapshot
 * ({session, chunks, corruptChunks, missingChunkNos, annotations}). Exports are generated from
 * persisted data, never from the live chart buffer.
 */
import { flagNames, flagsFromNames, Q } from '../acquisition/quality.js';

export const CSV_SCHEMA = 'sensorlab-csv/1';
export const JSON_SCHEMA = 'sensorlab-export/1';
export const MAX_JSON_IMPORT_BYTES = 64 * 1048576;
export const MAX_JSON_IMPORT_READINGS = 500_000;
export const MAX_JSON_IMPORT_DEVICES = 256;
export const MAX_JSON_IMPORT_ANNOTATIONS = 100_000;
export const CSV_COLUMNS = [
    'session_id', 'device_id', 'device_name', 'channel_id', 'parameter', 'sequence', 'device_time_us',
    'relative_time_s', 'host_receive_ms', 'raw_value', 'value', 'unit', 'valid', 'quality_flags',
];
export const JSON_READING_COLUMNS = ['device_id', 'channel_id', 'sequence', 'device_time_us', 'relative_time_s', 'host_receive_ms', 'raw_value', 'value', 'quality_flags'];
const BOM = '﻿';
const EOL = '\r\n';

/**
 * RFC 4180 field. Text fields from untrusted sources (device names, units, session names) get a
 * leading apostrophe if they start with a formula trigger. Numeric fields are never altered:
 * a negative number legitimately starts with "-".
 */
export function csvText(s) {
    let t = s == null ? '' : String(s);
    if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
    return /[",\r\n]/.test(t) || /^\s|\s$/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

export function csvNum(n) {
    if (n === null || n === undefined) return '';
    if (typeof n !== 'number' || !Number.isFinite(n)) return '';
    return String(n);
}

export function safeFilename(name, fallback = 'session') {
    let s = String(name ?? '').normalize('NFC').replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/\.{2,}/g, '_')
        .replace(/\s+/g, ' ').replace(/_+/g, '_').trim();
    s = s.replace(/^[._\s]+|[._\s]+$/g, '').slice(0, 80);
    if (!s || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = fallback;
    return s;
}

/** Iterate readings in persisted order. */
export function* iterateReadings(snapshot) {
    for (const ch of snapshot.chunks) {
        const c = ch.cols;
        for (let i = 0; i < ch.n; i++) {
            yield {
                deviceId: ch.dict[c.d[i]], channelId: c.c[i], seq: c.q[i], devUs: c.t[i], hostMs: c.h[i],
                relS: c.r[i], raw: c.raw[i], value: c.v[i], flags: c.f[i],
            };
        }
    }
}

export function integrityReport(snapshot) {
    const readingCount = snapshot.chunks.reduce((a, c) => a + c.n, 0);
    const s = snapshot.session;
    const warnings = [];
    if (s.state === 'open') warnings.push('Session is still recording (or was interrupted and not yet recovered): readings after the last flush are not included.');
    if (s.state === 'recovered') warnings.push('Session was interrupted and recovered: data after the last persisted chunk was lost.');
    if (s.state === 'startup_failed') warnings.push('Recording startup FAILED (one or more required channels produced no fresh valid data): this is diagnostic data, not a completed recording.');
    if (s.state === 'startup_cancelled') warnings.push('Recording was cancelled during startup: this is not a completed recording.');
    const ev = s.lifecycle?.events || [];
    const streamProblems = ev.filter(e => e.type === 'stream_state' && ['STALE', 'INVALID', 'DISCONNECTED', 'RECOVERING'].includes(e.to)).length;
    const disconnects = ev.filter(e => e.type === 'device_disconnected').length;
    const lifeGaps = ev.filter(e => e.type === 'lifecycle_gap').length;
    if (s.lifecycle?.eventsDropped) warnings.push(`${s.lifecycle.eventsDropped} oldest lifecycle event(s) were dropped (log limit ${s.lifecycle.eventLogLimit}); data samples are unaffected.`);
    if (streamProblems || disconnects || lifeGaps) warnings.push(`Lifecycle events during recording: ${disconnects} device disconnection(s), ${streamProblems} stream stale/invalid/recovering transition(s), ${lifeGaps} app/system interruption(s). See session.lifecycle.events.`);
    if (snapshot.corruptChunks.length) warnings.push(`${snapshot.corruptChunks.length} stored chunk(s) failed validation and were excluded.`);
    if (snapshot.missingChunkNos.length) warnings.push(`${snapshot.missingChunkNos.length} chunk number(s) missing from storage.`);
    if (s.storage?.unsavedAtStop) warnings.push(`${s.storage.unsavedAtStop} reading(s) could not be saved when recording stopped.`);
    if (s.storage?.droppedUnsaved) warnings.push(`${s.storage.droppedUnsaved} reading(s) were dropped because storage could not keep up.`);
    if (s.storage && Number.isInteger(s.storage.readingsPersisted) && s.storage.readingsPersisted !== readingCount && s.state !== 'imported') {
        warnings.push(`Readings in storage (${readingCount}) differ from the session's persisted counter (${s.storage.readingsPersisted}).`);
    }
    if (s.simulated) warnings.push('Contains SIMULATED data (demo mode), not physical measurements.');
    const anyLegacy = Object.values(s.devices || {}).some(d => String(d.protocol || '').startsWith('legacy'));
    if (anyLegacy) warnings.push('Some devices use a legacy protocol without sequence numbers or device timestamps: sample loss cannot be detected for them and times are host receipt times.');
    return {
        readingCount, chunkCount: snapshot.chunks.length,
        corruptChunks: snapshot.corruptChunks, missingChunkNos: snapshot.missingChunkNos,
        sessionState: s.state, complete: warnings.filter(w => !/SIMULATED|legacy protocol/.test(w)).length === 0,
        warnings,
    };
}

function channelInfo(session) {
    const map = new Map();
    for (const d of Object.values(session.devices || {})) {
        for (const c of d.channels || []) map.set(d.deviceId + '|' + c.channelId, { name: c.name, unit: c.unit });
        map.set(d.deviceId, { displayName: d.displayName });
    }
    return map;
}

/** CSV as an array of string parts (suitable for new Blob(parts)). */
export function buildCsvParts(snapshot) {
    const s = snapshot.session;
    const info = channelInfo(s);
    const parts = [BOM + CSV_COLUMNS.join(',') + EOL];
    let rows = 0;
    let buf = '';
    const sid = csvText(s.sessionId);
    for (const r of iterateReadings(snapshot)) {
        const ch = info.get(r.deviceId + '|' + r.channelId) || {};
        const dev = info.get(r.deviceId) || {};
        buf += [
            sid, csvText(r.deviceId), csvText(dev.displayName ?? ''), csvNum(r.channelId), csvText(ch.name ?? ''),
            csvNum(r.seq), csvNum(r.devUs), csvNum(r.relS), csvNum(r.hostMs), csvNum(r.raw), csvNum(r.value),
            csvText(ch.unit ?? ''), (r.flags & Q.INVALID) ? '0' : '1', flagNames(r.flags).join('|'),
        ].join(',') + EOL;
        rows++;
        if (buf.length > 1 << 20) { parts.push(buf); buf = ''; }
    }
    if (buf) parts.push(buf);
    return { parts, rows };
}

export function buildAnnotationsCsv(snapshot) {
    let out = BOM + ['session_id', 'annotation_id', 'relative_time_s', 'device_id', 'text', 'created_wall'].join(',') + EOL;
    for (const a of snapshot.annotations) {
        out += [csvText(snapshot.session.sessionId), csvText(a.annotationId), csvNum(a.relS), csvText(a.deviceId ?? ''), csvText(a.text), csvText(a.wall)].join(',') + EOL;
    }
    return out;
}

function metadataObject(snapshot, app, exportedWall) {
    const s = snapshot.session;
    return {
        schema: JSON_SCHEMA,
        csvSchema: CSV_SCHEMA,
        exportedWall,
        exportedBy: app,
        session: {
            sessionId: s.sessionId, name: s.name, group: s.group, notes: s.notes, state: s.state,
            createdWall: s.createdWall, startedWall: s.startedWall, endedWall: s.endedWall,
            simulated: !!s.simulated, app: s.app, storage: s.storage, recovery: s.recovery,
            visibility: s.visibility || [], provenance: s.provenance || null, lifecycle: s.lifecycle || null,
        },
        devices: Object.values(s.devices || {}),
        quality: s.quality || {},
        qualityFlagLegend: Object.fromEntries(Object.entries(Q).map(([k, v]) => [k.toLowerCase(), v])),
        timeDefinitions: {
            relative_time_s: 'seconds since recording start. SLTP devices: anchored device clock (first sample after start mapped by host receipt); legacy devices: host receipt time.',
            device_time_us: 'device microsecond clock, unwrapped across 2^32 rollover; null for legacy devices.',
            host_receive_ms: 'host monotonic (performance.now) receipt time in ms since recording start.',
        },
        annotations: snapshot.annotations.map(a => ({ annotationId: a.annotationId, relS: a.relS, text: a.text, deviceId: a.deviceId, wall: a.wall })),
        integrity: integrityReport(snapshot),
    };
}

export function buildMetadataJson(snapshot, { app = {}, exportedWall = new Date().toISOString() } = {}) {
    return JSON.stringify(metadataObject(snapshot, app, exportedWall), null, 2);
}

/** Full JSON export (metadata + columnar readings). */
/**
 * Full JSON export as string parts (each ≤ ~1 MB) for `new Blob(parts)`. Rows are streamed one per line, so no
 * array of all rows and no single giant string is ever built (6 M readings exceeded V8's maximum string length
 * with a whole-document string). The output is byte-identical to buildJson().
 */
/**
 * Largest single file handed to the browser as one download. Measured (headless Chrome 154, Windows 11, 23 GB RAM): a
 * blob download of 500 MB completed, 520 MB was cancelled by the browser at 0 bytes, and a second 256 MB download started
 * while the first was still being written was cancelled too. The page cannot observe that cancellation. Half the
 * measured single-file limit is used as the margin (other PCs may have lower limits). See docs/OPERATING_LIMITS.md.
 */
export const MAX_SINGLE_DOWNLOAD_BYTES = 256 * 1048576;

/** UTF-8 byte length of a string, without allocating an encoded copy. */
export function utf8Length(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x80) n += 1;
        else if (c < 0x800) n += 2;
        else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; }
        else n += 3;
    }
    return n;
}

/**
 * Split buildCsvParts() output (header part, then row-aligned parts) into files of at most ~maxBytes. Every file starts
 * with the header (a complete CSV on its own) and the rows keep their order, so concatenating the files' rows gives the
 * original export exactly. Returns [{ parts, bytes, rows }].
 */
export function splitCsvFiles(parts, maxBytes = MAX_SINGLE_DOWNLOAD_BYTES) {
    const header = parts[0];
    const hb = utf8Length(header);
    const files = [];
    let cur = null;
    for (let i = 1; i < parts.length; i++) {
        const b = utf8Length(parts[i]);
        if (!cur || (cur.bytes + b > maxBytes && cur.parts.length > 1)) { cur = { parts: [header], bytes: hb, rows: 0 }; files.push(cur); }
        cur.parts.push(parts[i]);
        cur.bytes += b;
        for (let k = parts[i].indexOf(EOL); k !== -1; k = parts[i].indexOf(EOL, k + 2)) cur.rows++;
    }
    if (!files.length) files.push({ parts: [header], bytes: hb, rows: 0 });
    return files;
}

export function buildJsonParts(snapshot, { app = {}, exportedWall = new Date().toISOString(), partBytes = 1 << 20 } = {}) {
    const meta = metadataObject(snapshot, app, exportedWall);
    const head = JSON.stringify({ ...meta, readings: { columns: JSON_READING_COLUMNS, rows: [] } }, null, 2);
    // "readings" is the last key, so its empty rows array is the last occurrence. String values cannot
    // contain an unescaped '"rows": []', so this split is unambiguous.
    const at = head.lastIndexOf('"rows": []');
    const before = head.slice(0, at), after = head.slice(at + '"rows": []'.length);
    const parts = [];
    let buf = '', rows = 0;
    for (const r of iterateReadings(snapshot)) {
        const line = '      ' + JSON.stringify([r.deviceId, r.channelId, r.seq ?? null, r.devUs ?? null, r.relS ?? null, r.hostMs ?? null, r.raw ?? null, r.value ?? null, r.flags]);
        buf += (rows === 0 ? before + '"rows": [\n' : ',\n') + line;
        rows++;
        if (buf.length >= partBytes) { parts.push(buf); buf = ''; }
    }
    if (rows === 0) return { parts: [head], rows };
    buf += '\n    ]' + after;
    parts.push(buf);
    return { parts, rows };
}

/** Full JSON export as one string (small exports, tests, import round-trips). */
export function buildJson(snapshot, opts = {}) {
    return buildJsonParts(snapshot, opts).parts.join('');
}

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function finiteOrNull(value) { return value === null || (typeof value === 'number' && Number.isFinite(value)); }
function validTimestamp(value, nullable = true) {
    if (nullable && value === null) return true;
    return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/**
 * Parse and validate a JSON export back into a repository-shaped snapshot.
 * Imported sessions get state "imported" with provenance. Readings are unchanged.
 */
export function parseExportJson(text, { maxBytes = MAX_JSON_IMPORT_BYTES, maxReadings = MAX_JSON_IMPORT_READINGS } = {}) {
    if (typeof text !== 'string') return { ok: false, error: 'input must be JSON text' };
    if (text.length > maxBytes || utf8Length(text) > maxBytes) return { ok: false, error: `file exceeds the ${maxBytes}-byte import limit` };
    let o;
    try { o = JSON.parse(text); } catch (e) { return { ok: false, error: 'not valid JSON: ' + e.message }; }
    if (!o || o.schema !== JSON_SCHEMA) return { ok: false, error: `unsupported schema ${JSON.stringify(o?.schema)} (expected ${JSON_SCHEMA})` };
    if (!isRecord(o.session) || typeof o.session.sessionId !== 'string' || !o.session.sessionId.trim() || o.session.sessionId.length > 200 ||
        typeof o.session.name !== 'string' || o.session.name.length > 200 ||
        !['open', 'closed', 'recovered', 'imported', 'startup_failed', 'startup_cancelled'].includes(o.session.state) ||
        (o.session.group !== undefined && (typeof o.session.group !== 'string' || o.session.group.length > 200)) ||
        (o.session.notes !== undefined && (typeof o.session.notes !== 'string' || o.session.notes.length > 2000)) ||
        (o.session.simulated !== undefined && typeof o.session.simulated !== 'boolean') ||
        !Array.isArray(o.devices) || !isRecord(o.readings) || !Array.isArray(o.readings.rows)) {
        return { ok: false, error: 'missing or invalid session, devices or readings' };
    }
    const cols = o.readings.columns;
    if (JSON.stringify(cols) !== JSON.stringify(JSON_READING_COLUMNS)) return { ok: false, error: 'unexpected reading columns' };
    if (!Number.isInteger(maxReadings) || maxReadings < 0 || o.readings.rows.length > maxReadings) {
        return { ok: false, error: `reading count exceeds the ${maxReadings}-row import limit` };
    }
    if (!validTimestamp(o.session.createdWall) || !validTimestamp(o.session.startedWall) || !validTimestamp(o.session.endedWall) ||
        (o.exportedWall !== undefined && !validTimestamp(o.exportedWall, false))) {
        return { ok: false, error: 'session or export timestamp is invalid' };
    }

    if (o.devices.length > MAX_JSON_IMPORT_DEVICES) return { ok: false, error: `device count exceeds the ${MAX_JSON_IMPORT_DEVICES}-device import limit` };
    const devices = {};
    for (const [i, d] of o.devices.entries()) {
        if (!isRecord(d) || typeof d.deviceId !== 'string' || !d.deviceId || d.deviceId.length > 200 ||
            typeof d.displayName !== 'string' || d.displayName.length > 200 || !Array.isArray(d.channels) ||
            d.channels.length > 256) {
            return { ok: false, error: `device ${i} is malformed` };
        }
        if (Object.hasOwn(devices, d.deviceId)) return { ok: false, error: `duplicate device ID ${JSON.stringify(d.deviceId)}` };
        const channelIds = new Set();
        for (const [j, ch] of d.channels.entries()) {
            if (!isRecord(ch) || !Number.isInteger(ch.channelId) || ch.channelId < 0 || ch.channelId > 255 ||
                typeof ch.name !== 'string' || ch.name.length > 100 ||
                typeof ch.unit !== 'string' || ch.unit.length > 32) {
                return { ok: false, error: `device ${i} channel ${j} is malformed` };
            }
            if (channelIds.has(ch.channelId)) return { ok: false, error: `device ${i} has duplicate channel ${ch.channelId}` };
            channelIds.add(ch.channelId);
        }
        devices[d.deviceId] = d;
    }

    const dict = [], idx = new Map();
    const c = { d: [], c: [], q: [], t: [], h: [], r: [], raw: [], v: [], f: [] };
    for (const [k, row] of o.readings.rows.entries()) {
        if (!Array.isArray(row) || row.length !== cols.length) return { ok: false, error: `row ${k} malformed` };
        const [dev, ch, seq, t, rel, h, raw, val, f] = row;
        const device = typeof dev === 'string' ? devices[dev] : null;
        const channelExists = device?.channels.some(channel => channel.channelId === ch) || false;
        if (!device || !Number.isInteger(ch) || !channelExists) return { ok: false, error: `row ${k} references an unknown device or channel` };
        if ((seq !== null && (!Number.isInteger(seq) || seq < 0 || seq > 0xffffffff)) ||
            (t !== null && (!Number.isSafeInteger(t) || t < 0)) ||
            !finiteOrNull(h) || (h !== null && h < 0) ||
            typeof rel !== 'number' || !Number.isFinite(rel) || rel < 0 ||
            !finiteOrNull(raw) || !finiteOrNull(val) ||
            !Number.isInteger(f) || f < 0 || (f & ~0x7ff) !== 0 ||
            ((f & Q.INVALID) !== 0 && val !== null)) {
            return { ok: false, error: `row ${k} has invalid value, timestamp, sequence or quality fields` };
        }
        let di = idx.get(dev);
        if (di === undefined) { di = dict.length; dict.push(dev); idx.set(dev, di); }
        c.d.push(di); c.c.push(ch); c.q.push(seq); c.t.push(t); c.r.push(rel); c.h.push(h); c.raw.push(raw); c.v.push(val); c.f.push(f);
    }
    const annotations = o.annotations ?? [];
    if (!Array.isArray(annotations)) return { ok: false, error: 'annotations must be an array' };
    if (annotations.length > MAX_JSON_IMPORT_ANNOTATIONS) return { ok: false, error: `annotation count exceeds the ${MAX_JSON_IMPORT_ANNOTATIONS}-item import limit` };
    const normalizedAnnotations = [];
    for (const [i, a] of annotations.entries()) {
        if (!isRecord(a) || typeof a.annotationId !== 'string' || !a.annotationId || a.annotationId.length > 200 ||
            typeof a.text !== 'string' || a.text.length > 500 ||
            typeof a.relS !== 'number' || !Number.isFinite(a.relS) || a.relS < 0 ||
            (a.deviceId !== null && a.deviceId !== undefined && !Object.hasOwn(devices, a.deviceId)) ||
            !validTimestamp(a.wall)) {
            return { ok: false, error: `annotation ${i} is malformed` };
        }
        normalizedAnnotations.push({ ...a, sessionId: o.session.sessionId });
    }
    if (o.quality !== undefined && !isRecord(o.quality)) return { ok: false, error: 'quality metadata must be an object' };
    if (o.integrity !== undefined && (!isRecord(o.integrity) ||
        (o.integrity.corruptChunks !== undefined && !Array.isArray(o.integrity.corruptChunks)) ||
        (o.integrity.missingChunkNos !== undefined && !Array.isArray(o.integrity.missingChunkNos)))) {
        return { ok: false, error: 'integrity metadata is malformed' };
    }
    const session = { ...o.session, devices, quality: o.quality || {} };
    return {
        ok: true,
        snapshot: {
            session,
            chunks: c.d.length ? [{ chunkNo: 0, n: c.d.length, wall: o.exportedWall, dict, cols: c }] : [],
            corruptChunks: o.integrity?.corruptChunks || [],
            missingChunkNos: o.integrity?.missingChunkNos || [],
            annotations: normalizedAnnotations,
        },
    };
}

/** Parse a CSV produced by buildCsvParts (for round-trip verification). */
export function parseCsv(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const rows = [];
    let row = [], f = '', i = 0, q = false;
    while (i < text.length) {
        const ch = text[i];
        if (q) {
            if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i += 2; continue; } q = false; i++; continue; }
            f += ch; i++; continue;
        }
        if (ch === '"') { q = true; i++; continue; }
        if (ch === ',') { row.push(f); f = ''; i++; continue; }
        if (ch === '\r' && text[i + 1] === '\n') { row.push(f); rows.push(row); row = []; f = ''; i += 2; continue; }
        f += ch; i++;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows;
}

export { flagNames, flagsFromNames };
