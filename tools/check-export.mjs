#!/usr/bin/env node
/**
 * Independent checker for a SensorLab CSV export (sensorlab-csv/1), for the hardware acceptance run
 * (docs/HARDWARE_TEST_PLAN.md A12/B5). It reads the file as a stream (works for multi-GB files), and does NOT use the app's
 * own export or tracker code, so it is an independent second opinion on what the app wrote.
 *
 *   node tools/check-export.mjs <session.csv> [<session.json>] [--json]
 *
 * Per stream (device_id × channel_id), the CSV is split into epochs at rows flagged `boot` or `timebase_reset`. Within an epoch:
 *   - duplicates: the same sequence twice                                                   → FAIL
 *   - backward steps not flagged `out_of_order`                                             → FAIL
 *   - forward jumps (> 1) not flagged `gap_before` (or `device_overrun`)                    → FAIL
 *   - missing = (max − min + 1) − distinct sequences (late arrivals fill gaps)              → reported
 *   - device_time_us step per sequence step: median / min / max (µs)                         → reported (period check)
 * With the JSON export: per device, the channel-0 missing count must equal quality[device].stream.missing → FAIL if not.
 * Exit 0 = no FAIL findings, 1 = FAIL findings, 2 = usage/parse error.
 */
import { createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

/** Split one CSV record (RFC 4180, already joined across quoted newlines). */
function splitCsv(line) {
    const out = []; let f = '', q = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) { if (ch === '"') { if (line[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; continue; }
        if (ch === '"') q = true; else if (ch === ',') { out.push(f); f = ''; } else f += ch;
    }
    out.push(f);
    return out;
}

export async function checkCsv(path) {
    const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
    let header = null, pending = null, rowNo = 0;
    const streams = new Map();
    const findings = [];
    const fail = (msg) => { if (findings.length < 200) findings.push(msg); else if (findings.length === 200) findings.push('… further findings suppressed'); };
    let sessionIds = new Set(), legacyRows = 0;
    for await (let line of rl) {
        if (pending !== null) { line = pending + '\n' + line; pending = null; }
        if ((line.match(/"/g) || []).length % 2) { pending = line; continue; } // quoted newline: keep reading
        if (header === null) {
            header = splitCsv(line.replace(/^﻿/, ''));
            for (const c of ['session_id', 'device_id', 'channel_id', 'sequence', 'device_time_us', 'relative_time_s', 'valid', 'quality_flags']) {
                if (!header.includes(c)) throw new Error(`not a SensorLab CSV export: column "${c}" missing`);
            }
            continue;
        }
        if (line === '') continue;
        rowNo++;
        const f = splitCsv(line);
        if (f.length !== header.length) { fail(`row ${rowNo}: ${f.length} fields, expected ${header.length}`); continue; }
        const r = Object.fromEntries(header.map((h, i) => [h, f[i]]));
        sessionIds.add(r.session_id);
        const flags = new Set(r.quality_flags ? r.quality_flags.split('|') : []);
        const key = `${r.device_id}|${r.channel_id}`;
        let s = streams.get(key);
        if (!s) { s = { device: r.device_id, channel: Number(r.channel_id), rows: 0, invalid: 0, epochs: [], firstRel: null, lastRel: null }; streams.set(key, s); }
        s.rows++;
        if (r.valid === '0') s.invalid++;
        const rel = r.relative_time_s === '' ? null : Number(r.relative_time_s);
        if (rel !== null) { if (s.firstRel === null) s.firstRel = rel; s.lastRel = rel; }
        if (r.sequence === '') { legacyRows++; continue; } // legacy host-time-only stream: no sequence to check
        const seq = Number(r.sequence), dev = r.device_time_us === '' ? null : Number(r.device_time_us);
        let e = s.epochs.at(-1);
        if (!e || flags.has('boot') || flags.has('timebase_reset')) {
            e = { startRow: rowNo, seen: new Set(), min: seq, max: seq, last: null, lastDev: null, steps: [] };
            s.epochs.push(e);
        }
        if (e.seen.has(seq)) fail(`${key} row ${rowNo}: duplicate sequence ${seq}`);
        if (e.last !== null) {
            const d = seq - e.last;
            if (d < 0 && !flags.has('out_of_order')) fail(`${key} row ${rowNo}: sequence went back ${e.last} → ${seq} without boot/out_of_order flag`);
            if (d > 1 && !flags.has('gap_before') && !flags.has('device_overrun')) fail(`${key} row ${rowNo}: jump ${e.last} → ${seq} without gap_before flag`);
            if (d > 0 && dev !== null && e.lastDev !== null && e.steps.length < 2_000_000) e.steps.push((dev - e.lastDev) / d);
        }
        e.seen.add(seq);
        if (seq < e.min) e.min = seq;
        if (seq > e.max) e.max = seq;
        if (!flags.has('out_of_order')) { e.last = seq; e.lastDev = dev; }
    }
    if (header === null) throw new Error('empty file');
    const out = [];
    for (const [key, s] of streams) {
        let missing = 0, longest = 0;
        const epochs = s.epochs.map(e => {
            const sorted = [...e.seen].sort((a, b) => a - b);
            let m = 0;
            for (let i = 1; i < sorted.length; i++) { const g = sorted[i] - sorted[i - 1] - 1; if (g > 0) { m += g; if (g > longest) longest = g; } }
            missing += m;
            const st = e.steps.sort((a, b) => a - b);
            return { startRow: e.startRow, first: e.min, last: e.max, samples: e.seen.size, missing: m,
                deviceStepUs: st.length ? { median: st[st.length >> 1], min: st[0], max: st.at(-1) } : null };
        });
        out.push({ stream: key, device: s.device, channel: s.channel, rows: s.rows, invalid: s.invalid, epochs: epochs.length, missing, longestGap: longest,
            relativeTimeS: [s.firstRel, s.lastRel], epochDetail: epochs });
    }
    return { file: path, rows: rowNo, sessions: [...sessionIds], legacyRows, streams: out, findings };
}

export function compareWithJson(result, jsonText) {
    const o = JSON.parse(jsonText);
    const quality = o.quality ?? o.metadata?.quality ?? o.session?.quality ?? {};
    const checks = [];
    for (const s of result.streams.filter(x => x.channel === 0)) {
        const q = quality[s.device]?.stream;
        if (!q) { checks.push({ device: s.device, ok: false, note: 'no quality.stream entry in JSON' }); continue; }
        checks.push({ device: s.device, ok: q.missing === s.missing, csvMissing: s.missing, appMissing: q.missing, restarts: q.restarts, duplicates: q.duplicates, outOfOrder: q.outOfOrder });
    }
    return checks;
}

if (/check-export\.mjs$/.test(process.argv[1] || '')) {
    const args = process.argv.slice(2);
    const asJson = args.includes('--json');
    const [csvPath, jsonPath] = args.filter(a => !a.startsWith('--'));
    if (!csvPath) { console.error('usage: node tools/check-export.mjs <session.csv> [<session.json>] [--json]'); process.exit(2); }
    let res;
    try {
        res = await checkCsv(csvPath);
        if (jsonPath) res.jsonComparison = compareWithJson(res, readFileSync(jsonPath, 'utf8'));
    } catch (e) { console.error('ERROR: ' + e.message); process.exit(2); }
    const jsonFails = (res.jsonComparison || []).filter(c => !c.ok);
    const ok = res.findings.length === 0 && jsonFails.length === 0;
    if (asJson) console.log(JSON.stringify({ ...res, verdict: ok ? 'PASS' : 'FAIL' }, null, 1));
    else {
        console.log(`${res.file}: ${res.rows} rows, session ${res.sessions.join(', ')}${res.legacyRows ? `, ${res.legacyRows} legacy rows (no sequence)` : ''}`);
        for (const s of res.streams) {
            const st = s.epochDetail.map(e => e.deviceStepUs ? `${Math.round(e.deviceStepUs.median)} µs [${Math.round(e.deviceStepUs.min)}…${Math.round(e.deviceStepUs.max)}]` : '—').join('; ');
            console.log(`  ${s.stream}: ${s.rows} rows, ${s.invalid} invalid, ${s.epochs} epoch(s), missing ${s.missing}, longest gap ${s.longestGap}, t ${s.relativeTimeS[0]}…${s.relativeTimeS[1]} s, device step ${st}`);
        }
        for (const c of res.jsonComparison || []) console.log(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.device}: missing in CSV ${c.csvMissing ?? '?'} vs app quality.stream.missing ${c.appMissing ?? '?'}${c.note ? ' (' + c.note + ')' : ''}`);
        for (const f of res.findings) console.log('  FAIL ' + f);
        console.log(ok ? 'check-export: PASS' : `check-export: FAIL (${res.findings.length + jsonFails.length} finding(s))`);
    }
    process.exit(ok ? 0 : 1);
}
