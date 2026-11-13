/**
 * The hardware-run export checker (tools/check-export.mjs) must accept a correct export, including power-cycle epochs, gaps and
 * late arrivals, and must reject tampered exports. The CSV is produced by the app's real exporter (buildCsvParts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildCsvParts, buildJson } from '../../src/export/export.js';
import { Q } from '../../src/acquisition/quality.js';
import { checkCsv, compareWithJson } from '../../tools/check-export.mjs';

/** One device, 2 channels, 10 Hz: seq 0..49, gap of 5 at 20, late arrival of 30 after 32, then a BOOT epoch 0..19. */
function snapshot() {
    const cols = { d: [], c: [], q: [], t: [], h: [], r: [], raw: [], v: [], f: [] };
    const push = (seq, devUs, flags, k) => {
        for (const ch of [0, 1]) {
            cols.d.push(0); cols.c.push(ch); cols.q.push(seq); cols.t.push(devUs); cols.h.push(k * 100); cols.r.push(k * 0.1);
            cols.raw.push(ch ? 1000 : 16 * 2000); cols.v.push(ch ? 10 : 2000); cols.f.push(flags);
        }
    };
    let k = 0;
    const order = [];
    for (let s = 0; s < 50; s++) { if (s >= 20 && s < 25) continue; if (s === 30) continue; order.push(s); if (s === 32) order.push(30); }
    for (const s of order) push(s, s * 100_000, (s === 25 ? Q.GAP_BEFORE : 0) | (s === 31 ? Q.GAP_BEFORE : 0) | (s === 30 ? Q.OUT_OF_ORDER : 0), k++);
    for (let s = 0; s < 20; s++) push(s, s * 100_000, s === 0 ? Q.BOOT : 0, k++);
    const n = cols.d.length;
    return {
        session: {
            sessionId: 'S1', name: 'hw', group: '', notes: '', state: 'closed', createdWall: 'w', startedWall: 'w', endedWall: 'w', simulated: false,
            devices: { 'ble:AABBCCDDEEFF': { deviceId: 'ble:AABBCCDDEEFF', displayName: 'SLab-EEFF', protocol: 'sltp/1', channels: [{ channelId: 0, name: 'adc_sum16', unit: 'count' }, { channelId: 1, name: 'resistance', unit: 'Ω' }] } },
            quality: { 'ble:AABBCCDDEEFF': { stream: { missing: 5, restarts: 1, duplicates: 0, outOfOrder: 1 } } }, storage: { readingsPersisted: n }, visibility: [],
        },
        chunks: [{ chunkNo: 0, n, wall: 'w', dict: ['ble:AABBCCDDEEFF'], cols }],
        corruptChunks: [], missingChunkNos: [], annotations: [],
    };
}

const dir = mkdtempSync(path.join(tmpdir(), 'slchk-'));
const write = (name, text) => { const p = path.join(dir, name); writeFileSync(p, text); return p; };

test('check-export accepts a correct export with a gap, a late arrival and a power-cycle epoch; matches app quality', async () => {
    const snap = snapshot();
    const csv = buildCsvParts(snap).parts.join('');
    const res = await checkCsv(write('ok.csv', csv));
    assert.deepEqual(res.findings, []);
    assert.equal(res.streams.length, 2);
    const s0 = res.streams.find(s => s.channel === 0);
    assert.equal(s0.epochs, 2);
    assert.equal(s0.missing, 5, 'gap of 5 counted; late arrival 30 fills its gap');
    assert.equal(s0.longestGap, 5);
    assert.equal(Math.round(s0.epochDetail[0].deviceStepUs.median), 100_000, 'device period 100 ms recovered');
    const cmp = compareWithJson(res, buildJson(snap, { app: { version: 't' }, exportedWall: 'E' }));
    assert.deepEqual(cmp.map(c => c.ok), [true]);
});

test('check-export rejects tampering: duplicate row, unflagged jump, unflagged backward step, quality mismatch', async () => {
    const snap = snapshot();
    const lines = buildCsvParts(snap).parts.join('').split('\r\n');
    // duplicate a data row
    const dup = [...lines.slice(0, 5), lines[4], ...lines.slice(5)].join('\r\n');
    assert.match((await checkCsv(write('dup.csv', dup))).findings.join('\n'), /duplicate sequence/);
    // delete rows (seq 3 for both channels) → a jump without gap_before
    const del = lines.filter((l, i) => !(i >= 7 && i <= 8)).join('\r\n');
    assert.match((await checkCsv(write('del.csv', del))).findings.join('\n'), /without gap_before/);
    // remove the out_of_order flag from the late arrival → an unflagged backward step
    const unflag = lines.map(l => l.replace(/,out_of_order$/, ',')).join('\r\n');
    assert.match((await checkCsv(write('unflag.csv', unflag))).findings.join('\n'), /went back/);
    // app quality claims a different missing count
    const bad = snapshot(); bad.session.quality['ble:AABBCCDDEEFF'].stream.missing = 0;
    const res = await checkCsv(write('ok2.csv', lines.join('\r\n')));
    assert.deepEqual(compareWithJson(res, buildJson(bad, { app: { version: 't' }, exportedWall: 'E' })).map(c => c.ok), [false]);
});
