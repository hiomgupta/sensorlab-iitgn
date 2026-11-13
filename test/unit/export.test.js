import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    buildCsvParts, buildJson, buildJsonParts, parseExportJson, parseCsv, csvText, csvNum, safeFilename, CSV_COLUMNS,
    buildAnnotationsCsv, integrityReport, buildMetadataJson,
} from '../../src/export/export.js';
import { buildZip, buildZipParts, crc32 } from '../../src/export/zip.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Q } from '../../src/acquisition/quality.js';

const TEST_WALL = '2026-01-02T03:04:05.000Z';

function makeSnapshot({ n = 10, name = 'Trial 1', devName = 'Left arm', unit = 'Ω', state = 'closed' } = {}) {
    const cols = { d: [], c: [], q: [], t: [], h: [], r: [], raw: [], v: [], f: [] };
    for (let i = 0; i < n; i++) {
        const dev = i % 2; const invalid = i % 7 === 3;
        cols.d.push(dev); cols.c.push(i % 3 === 0 ? 1 : 0); cols.q.push(i); cols.t.push(i * 50_000); cols.h.push(i * 50 + 3);
        cols.r.push(i * 0.05); cols.raw.push(i - 5); cols.v.push(invalid ? null : (i - 5) * 0.01); cols.f.push(invalid ? Q.INVALID : (i === 4 ? Q.GAP_BEFORE : 0));
    }
    const device = (id, dn) => ({ deviceId: id, displayName: dn, protocol: 'sltp/1', channels: [{ channelId: 0, name: 'resistance', unit }, { channelId: 1, name: 'temp', unit: '°C' }] });
    return {
        session: {
            sessionId: 'sess-1', name, group: 'G', notes: '', state, createdWall: TEST_WALL, startedWall: TEST_WALL, endedWall: TEST_WALL, simulated: false,
            devices: { 'ble:AAA': device('ble:AAA', devName), 'ble:BBB': device('ble:BBB', 'Right') },
            quality: { 'ble:AAA': { stream: { missing: 1 } } }, storage: { readingsPersisted: n }, visibility: [],
        },
        chunks: n ? [{ chunkNo: 0, n, wall: 'w', dict: ['ble:AAA', 'ble:BBB'], cols }] : [],
        corruptChunks: [], missingChunkNos: [],
        annotations: [{ sessionId: 'sess-1', annotationId: 'a1', relS: 0.25, text: 'added "100 g", then\nwaited', deviceId: null, wall: TEST_WALL }],
    };
}

test('CSV field escaping: quotes, commas, newlines, formula triggers on text only', () => {
    assert.equal(csvText('a,b'), '"a,b"');
    assert.equal(csvText('say "hi"'), '"say ""hi"""');
    assert.equal(csvText('line1\nline2'), '"line1\nline2"');
    assert.equal(csvText('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
    assert.equal(csvText('+1'), "'+1");
    assert.equal(csvText('-cmd'), "'-cmd");
    assert.equal(csvText('@SUM(A1)'), "'@SUM(A1)");
    assert.equal(csvText('Ω'), 'Ω');
    assert.equal(csvNum(-5), '-5', 'negative numbers are not formula-escaped');
    assert.equal(csvNum(null), '');
    assert.equal(csvNum(NaN), '');
    assert.equal(csvNum(0.1 + 0.2), '0.30000000000000004', 'full round-trip precision');
});

test('CSV: header, BOM, CRLF, complete row count, device/channel association, Unicode units', () => {
    const snap = makeSnapshot({ n: 21, devName: '=evil,"name"\n', unit: 'µε' });
    const { parts, rows } = buildCsvParts(snap);
    const text = parts.join('');
    assert.equal(text.charCodeAt(0), 0xfeff);
    assert.ok(text.includes('\r\n'));
    assert.equal(rows, 21);
    const table = parseCsv(text);
    assert.deepEqual(table[0], CSV_COLUMNS);
    assert.equal(table.length, 22);
    const r0 = Object.fromEntries(CSV_COLUMNS.map((k, i) => [k, table[1][i]]));
    assert.equal(r0.device_id, 'ble:AAA');
    assert.equal(r0.device_name, `'=evil,"name"\n`);
    assert.equal(r0.channel_id, '1');
    assert.equal(r0.parameter, 'temp');
    assert.equal(r0.unit, '°C');
    assert.equal(r0.raw_value, '-5');
    const r1 = Object.fromEntries(CSV_COLUMNS.map((k, i) => [k, table[2][i]]));
    assert.equal(r1.unit, 'µε');
    const inv = Object.fromEntries(CSV_COLUMNS.map((k, i) => [k, table[4][i]]));
    assert.equal(inv.valid, '0');
    assert.equal(inv.value, '');
    assert.equal(inv.quality_flags, 'invalid');
    const gap = Object.fromEntries(CSV_COLUMNS.map((k, i) => [k, table[5][i]]));
    assert.equal(gap.quality_flags, 'gap_before');
    // every value survives the round trip exactly
    for (let i = 0; i < 21; i++) {
        const row = Object.fromEntries(CSV_COLUMNS.map((k, j) => [k, table[i + 1][j]]));
        assert.equal(Number(row.sequence), i);
        assert.equal(Number(row.relative_time_s), snap.chunks[0].cols.r[i]);
        if (snap.chunks[0].cols.v[i] !== null) assert.equal(Number(row.value), snap.chunks[0].cols.v[i]);
    }
});

test('empty session exports header only and reports integrity', () => {
    const snap = makeSnapshot({ n: 0 });
    snap.session.storage.readingsPersisted = 0;
    const { parts, rows } = buildCsvParts(snap);
    assert.equal(rows, 0);
    assert.equal(parseCsv(parts.join('')).length, 1);
    const integ = integrityReport(snap);
    assert.equal(integ.readingCount, 0);
    assert.equal(integ.complete, true);
});

test('large session (>100,000 samples): complete, bounded time', () => {
    const snap = makeSnapshot({ n: 120_000 });
    const t0 = performance.now();
    const { parts, rows } = buildCsvParts(snap);
    const csvMs = performance.now() - t0;
    assert.equal(rows, 120_000);
    const lines = parts.join('').split('\r\n').length - 2; // header + trailing EOL
    assert.equal(lines, 120_000);
    const t1 = performance.now();
    const json = buildJson(snap);
    const jsonMs = performance.now() - t1;
    const back = parseExportJson(json);
    assert.equal(back.ok, true);
    assert.equal(back.snapshot.chunks[0].n, 120_000);
    console.log(`  [measured] 120k-row CSV build ${csvMs.toFixed(0)} ms, JSON build ${jsonMs.toFixed(0)} ms, CSV ${(parts.join('').length / 1e6).toFixed(1)} MB`);
});

test('JSON export: versioned schema, metadata/diagnostics separated, semantic round trip', () => {
    const snap = makeSnapshot({ n: 30 });
    const json = buildJson(snap, { app: { version: 't' }, exportedWall: TEST_WALL });
    const o = JSON.parse(json);
    assert.equal(o.schema, 'sensorlab-export/1');
    assert.ok(o.session && o.devices && o.quality && o.annotations && o.integrity && o.readings);
    assert.equal(o.readings.rows.length, 30);
    assert.equal(o.annotations[0].text, 'added "100 g", then\nwaited');
    const back = parseExportJson(json);
    assert.equal(back.ok, true);
    const json2 = buildJson(back.snapshot, { app: { version: 't' }, exportedWall: TEST_WALL });
    assert.deepEqual(JSON.parse(json2).readings, o.readings, 'readings identical after import/export');
    assert.deepEqual(JSON.parse(json2).devices, o.devices);
    assert.equal(parseExportJson('{"schema":"other"}').ok, false);
    assert.equal(parseExportJson('not json').ok, false);
});

test('JSON import enforces byte/row limits and validates timestamps, values, and device-channel references', () => {
    const text = buildJson(makeSnapshot({ n: 2 }), { exportedWall: TEST_WALL });
    assert.match(parseExportJson(text, { maxBytes: 16 }).error, /byte import limit/);
    assert.match(parseExportJson(text, { maxReadings: 1 }).error, /row import limit/);

    const mutate = (change) => {
        const o = JSON.parse(text);
        change(o);
        return parseExportJson(JSON.stringify(o));
    };
    assert.match(mutate(o => { o.readings.rows[0][0] = 'unknown-device'; }).error, /unknown device or channel/);
    assert.match(mutate(o => { o.readings.rows[0][1] = 99; }).error, /unknown device or channel/);
    assert.match(mutate(o => { o.readings.rows[0][2] = -1; }).error, /sequence/);
    assert.match(mutate(o => { o.readings.rows[0][4] = -0.5; }).error, /timestamp/);
    assert.match(mutate(o => { o.readings.rows[0][7] = 'not-a-number'; }).error, /value/);
    assert.match(mutate(o => { o.session.startedWall = 'not a timestamp'; }).error, /timestamp/);
    assert.match(mutate(o => { o.devices.find(d => d.deviceId === o.readings.rows[0][0]).channels = []; }).error, /unknown device or channel/);
});

test('integrity warnings: open, recovered, corrupt, missing, unsaved, simulated', () => {
    const snap = makeSnapshot({ n: 5, state: 'recovered' });
    snap.corruptChunks = [{ chunkNo: 2, reason: 'x' }];
    snap.missingChunkNos = [1];
    snap.session.simulated = true;
    snap.session.storage.unsavedAtStop = 3;
    const r = integrityReport(snap);
    assert.equal(r.complete, false);
    assert.equal(r.warnings.length, 5 + 0);
    assert.ok(r.warnings.some(w => /SIMULATED/.test(w)));
    const meta = JSON.parse(buildMetadataJson(snap));
    assert.equal(meta.integrity.complete, false);
    assert.equal(meta.readings, undefined);
});

test('annotations CSV escapes free text', () => {
    const t = parseCsv(buildAnnotationsCsv(makeSnapshot()));
    assert.equal(t[1][4], 'added "100 g", then\nwaited');
});

test('filename sanitization', () => {
    assert.equal(safeFilename('Wheatstone Bridge — Trial 3'), 'Wheatstone Bridge _ Trial 3');
    assert.equal(safeFilename('../../etc/passwd'), 'etc_passwd');
    assert.equal(safeFilename('CON'), 'session');
    assert.equal(safeFilename(''), 'session');
    assert.equal(safeFilename('a'.repeat(200)).length, 80);
    assert.equal(safeFilename('Ω-test'), 'Ω-test');
});

test('ZIP bundle is a valid archive readable by an independent implementation (python zipfile)', (t) => {
    assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
    const zip = buildZip([{ name: 'readings.csv', data: 'a,b\r\n1,2\r\n' }, { name: 'métadata.json', data: '{"x":"Ω"}' }]);
    const dir = mkdtempSync(path.join(tmpdir(), 'slzip-'));
    const f = path.join(dir, 'b.zip');
    writeFileSync(f, zip);
    let py = null;
    for (const c of ['python', 'python3', 'py']) { try { execFileSync(c, ['--version'], { stdio: 'ignore' }); py = c; break; } catch { /* next */ } }
    if (!py) { t.skip('python not available for independent ZIP verification'); return; }
    const out = execFileSync(py, ['-I', '-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;sys.stdout.buffer.write("|".join(n+"="+z.read(n).decode("utf-8") for n in z.namelist()).encode("utf-8"))', f]).toString('utf8').trim();
    assert.equal(out, 'readings.csv=a,b\r\n1,2\r\n|métadata.json={"x":"Ω"}'.replace(/\r\n/g, '\r\n'));
});

test('integrity warnings for startup failure and lifecycle events; lifecycle exported in metadata', () => {
    const snap = makeSnapshot({ n: 3, state: 'startup_failed' });
    snap.session.lifecycle = { state: 'START_FAILED', events: [{ type: 'device_disconnected' }, { type: 'stream_state', to: 'STALE' }, { type: 'lifecycle_gap', kind: 'timer_stall' }], keepAwake: { state: 'active' } };
    const r = integrityReport(snap);
    assert.equal(r.complete, false);
    assert.ok(r.warnings.some(w => /startup FAILED/.test(w)));
    assert.ok(r.warnings.some(w => /1 device disconnection\(s\), 1 stream .*1 app\/system interruption/.test(w)));
    const meta = JSON.parse(buildMetadataJson(snap));
    assert.equal(meta.session.lifecycle.keepAwake.state, 'active');
});

// Regression tests for the 6 M-reading export failures (docs/evidence/readiness/large-session-*.txt): ZIP export threw
// "Invalid string length" (whole CSV joined into one string) and JSON held several full-size copies.
test('bounded export: JSON parts are byte-identical to buildJson, each part ≤ ~1 MB, and parse back', () => {
    const snap = makeSnapshot({ n: 60_000 });
    const opts = { app: { version: 't' }, exportedWall: TEST_WALL };
    const { parts, rows } = buildJsonParts(snap, { ...opts, partBytes: 64 * 1024 });
    assert.equal(rows, 60_000);
    assert.ok(parts.length > 10, 'output is split into many parts');
    const maxPart = Math.max(...parts.map(p => p.length));
    assert.ok(maxPart <= 64 * 1024 + 4096, `part size bounded (max ${maxPart})`);
    assert.equal(parts.join(''), buildJson(snap, opts));
    const back = parseExportJson(parts.join(''));
    assert.equal(back.ok, true);
    assert.equal(back.snapshot.chunks[0].n, 60_000);
    // default part size is 1 MB
    assert.ok(Math.max(...buildJsonParts(snap, opts).parts.map(p => p.length)) <= (1 << 20) + 4096);
});

test('bounded export: buildZipParts == buildZip, accepts CSV parts without joining, and is CRC/size-correct per part', (t) => {
    const snap = makeSnapshot({ n: 30_000 });
    const csv = buildCsvParts(snap).parts;
    assert.ok(csv.length > 1, 'CSV arrives as several parts');
    const when = new Date(2026, 9, 14, 12, 0, 0);
    const files = [{ name: 'readings.csv', data: csv }, { name: 'metadata.json', data: buildMetadataJson(snap, {}) }, { name: 'annotations.csv', data: buildAnnotationsCsv(snap) }];
    const parts = buildZipParts(files, when);
    assert.ok(parts.every(p => p instanceof Uint8Array));
    // The readings entry is emitted part by part (no single buffer holding the whole CSV).
    const csvBytes = new TextEncoder().encode(csv.join('')).length;
    assert.ok(Math.max(...parts.map(p => p.length)) < csvBytes, 'no part holds the whole CSV');
    const joined = buildZip([{ name: 'readings.csv', data: csv.join('') }, files[1], files[2]], when);
    const flat = Buffer.concat(parts.map(p => Buffer.from(p)));
    assert.deepEqual(new Uint8Array(flat), joined);
    let py = null;
    for (const c of ['python', 'python3', 'py']) { try { execFileSync(c, ['--version'], { stdio: 'ignore' }); py = c; break; } catch { /* next */ } }
    if (!py) { t.skip('python not available for independent ZIP verification'); return; }
    const dir = mkdtempSync(path.join(tmpdir(), 'slzip-'));
    const f = path.join(dir, 'p.zip');
    writeFileSync(f, flat);
    const out = execFileSync(py, ['-I', '-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(len(z.read("readings.csv")))', f]).toString().trim();
    assert.equal(Number(out), csvBytes);
});

test('bounded export: ZIP32 limit is an explicit error, not silent corruption', () => {
    // A zero-byte array reporting a 4 GiB length: the CRC loop does nothing, the size check must still refuse it.
    const big = new Uint8Array(0); Object.defineProperty(big, 'length', { value: 0x100000000 });
    assert.throws(() => buildZipParts([{ name: 'x', data: [big] }]), /4 GiB ZIP32 limit/);
});

test('download blob URL stays valid long enough for large files (6 M-reading CSV was cancelled at 10 s)', async () => {
    const { revokeDelayMs } = await import('../../src/ui/dom.js');
    assert.equal(revokeDelayMs(0), 60_000);
    assert.equal(revokeDelayMs(10 * 1048576), 60_000);
    assert.equal(revokeDelayMs(575 * 1048576), 575_000);
    assert.ok(revokeDelayMs(2 * 1024 * 1048576) >= 2048_000);
});

test('history export uses bounded builders and reports a hand-off, not a completed save', () => {
    const src = readFileSync(fileURLToPath(new URL('../../src/ui/history-view.js', import.meta.url)), 'utf8');
    const body = src.slice(src.indexOf('async export('), src.indexOf('async export(') + 3000);
    assert.ok(body.includes('buildJsonParts('));
    assert.ok(body.includes('buildZipParts('));
    assert.ok(!body.includes(".join('')"), 'no whole-file string join in the export path');
    assert.ok(!body.includes('`Exported ${'), 'no "Exported N readings" success claim');
    assert.match(body, /handed to the browser/);
});

// Regression: a single download above ~500 MB was cancelled by Chrome at 0 bytes (6 M-reading CSV, measured), and so was a
// second large download overlapping the first. Large CSV/ZIP exports are offered in parts of <= MAX_SINGLE_DOWNLOAD_BYTES.
test('large export split: utf8Length is exact; CSV parts are complete files whose rows concatenate to the original', async () => {
    const { utf8Length, splitCsvFiles, MAX_SINGLE_DOWNLOAD_BYTES } = await import('../../src/export/export.js');
    for (const s of ['', 'abc', 'Ω°C', 'µs 𝛀 é', 'x'.repeat(1000) + '😀']) assert.equal(utf8Length(s), Buffer.byteLength(s, 'utf8'), s);
    assert.equal(MAX_SINGLE_DOWNLOAD_BYTES, 256 * 1048576);
    const snap = makeSnapshot({ n: 40_000 });
    const { parts, rows } = buildCsvParts(snap);
    const total = parts.reduce((a, p) => a + utf8Length(p), 0);
    const max = Math.ceil(total / 3.5);
    const files = splitCsvFiles(parts, max);
    assert.ok(files.length >= 4, `split into ${files.length} files`);
    const header = parts[0];
    let allRows = '';
    for (const f of files) {
        const text = f.parts.join('');
        assert.ok(text.startsWith(header), 'each part starts with the header (BOM + columns)');
        assert.equal(f.bytes, Buffer.byteLength(text, 'utf8'));
        assert.ok(f.bytes <= max + (1 << 20) + header.length, 'part size bounded (one 1 MB build part of slack)');
        assert.equal(f.rows, text.split('\r\n').length - 2);
        const back = parseCsv(text);
        assert.equal(back.length - 1, f.rows, 'each part parses on its own');
        allRows += text.slice(header.length);
    }
    assert.equal(files.reduce((a, f) => a + f.rows, 0), rows);
    assert.equal(header + allRows, parts.join(''), 'rows in order, nothing lost or duplicated');
    assert.equal(splitCsvFiles(parts, total * 2).length, 1, 'small export stays one file');
    assert.equal(splitCsvFiles([header], max).length, 1, 'empty session: header-only file');
});

test('history export guards the single-download limit (parts for CSV/ZIP, explicit refusal for JSON)', () => {
    const src = readFileSync(fileURLToPath(new URL('../../src/ui/history-view.js', import.meta.url)), 'utf8');
    const body = src.slice(src.indexOf('async export('), src.indexOf('async importFile('));
    assert.ok(body.includes('csvBytes > limit') && body.includes('this._offerParts('), 'CSV/ZIP above the limit are offered in parts');
    assert.ok(/bytes > limit\) \{[\s\S]*JSON export not started[\s\S]*return;/.test(body), 'JSON above the limit is refused with an explanation');
    assert.ok(body.includes("btn.addEventListener('click'"), 'each part is built on its own click (one download in flight)');
});

// Regression: after a CSV parts export the "Save part" buttons stayed visible when a JSON/ZIP export was started.
test('history export clears a previous parts panel before starting a new export', () => {
    const src = readFileSync(fileURLToPath(new URL('../../src/ui/history-view.js', import.meta.url)), 'utf8');
    const start = src.indexOf('async export(');
    const body = src.slice(start, src.indexOf('async importFile('));
    const clearAt = body.indexOf('this._clearExportParts()');
    assert.ok(clearAt > 0, 'export() clears the parts panel');
    assert.ok(clearAt < body.indexOf('readSnapshot('), 'cleared before any await/early return');
    assert.ok(clearAt < body.indexOf('this._offerParts('), 'cleared before new parts are offered');
});
