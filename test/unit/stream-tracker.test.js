import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamTracker, AMBIGUOUS_HOST_GAP_MS } from '../../src/acquisition/stream-tracker.js';
import { Q } from '../../src/acquisition/quality.js';

const U32 = 2 ** 32;
const pkt = (sequence, deviceTimeUs, flags = 0) => ({ sequence, deviceTimeUs, flags });

/** feed seqs at 10 Hz device time, 100 ms host spacing; returns results */
function feed(tr, seqs, { t0 = 0, host0 = 1000, flags = {} } = {}) {
    return seqs.map((s) => tr.observe(pkt(s >>> 0, (t0 + s * 100_000) % U32, flags[s] || 0), host0 + s * 100));
}

test('contiguous sequence: no gaps, exact device intervals', () => {
    const tr = new StreamTracker();
    const r = feed(tr, [0, 1, 2, 3, 4]);
    assert.ok(r.every(x => x.accept && x.gapBefore === 0));
    const s = tr.snapshot();
    assert.equal(s.received, 5);
    assert.equal(s.missing, 0);
    assert.equal(s.deviceIntervalUs.mean, 100_000);
    assert.equal(s.deviceIntervalUs.std, 0);
    assert.equal(tr.measuredRateHz(), 10);
});

test('single and multiple missing samples are counted and located', () => {
    const tr = new StreamTracker();
    const r = feed(tr, [0, 1, 3, 4, 9]);
    assert.equal(r[2].gapBefore, 1);
    assert.ok(r[2].quality & Q.GAP_BEFORE);
    assert.equal(r[4].gapBefore, 4);
    const s = tr.snapshot();
    assert.equal(s.missing, 5);
    assert.equal(s.gapCount, 2);
    assert.equal(s.longestGap, 4);
    assert.deepEqual(s.gaps.map(g => [g.afterSeq, g.missing]), [[1, 1], [4, 4]]);
    // intervals across gaps are excluded from jitter stats
    assert.equal(s.deviceIntervalUs.n, 2);
});

test('duplicate is rejected and counted, not stored', () => {
    const tr = new StreamTracker();
    const r = feed(tr, [0, 1, 1, 2]);
    assert.equal(r[2].accept, false);
    assert.equal(r[2].kind, 'duplicate');
    assert.equal(tr.snapshot().duplicates, 1);
    assert.equal(tr.snapshot().received, 3);
});

test('late (out-of-order) packet fills a counted gap', () => {
    const tr = new StreamTracker();
    const r = feed(tr, [0, 1, 3, 2]);
    assert.equal(r[3].accept, true);
    assert.equal(r[3].kind, 'late');
    assert.ok(r[3].quality & Q.OUT_OF_ORDER);
    const s = tr.snapshot();
    assert.equal(s.outOfOrder, 1);
    assert.equal(s.missing, 0);
    assert.equal(s.recoveredLate, 1);
    // a second copy of the late packet is a duplicate
    assert.equal(tr.observe(pkt(2, 200_000), 2000).kind, 'duplicate');
});

test('sequence wraparound 2^32-1 → 0 is a forward step, not a gap', () => {
    const tr = new StreamTracker();
    const seqs = [U32 - 3, U32 - 2, U32 - 1, 0, 1];
    const r = seqs.map((s, i) => tr.observe(pkt(s, i * 100_000), i * 100));
    assert.ok(r.every(x => x.accept && x.gapBefore === 0));
    assert.equal(tr.snapshot().missing, 0);
    // a gap across the wrap is counted correctly
    const tr2 = new StreamTracker();
    tr2.observe(pkt(U32 - 1, 0), 0);
    assert.equal(tr2.observe(pkt(2, 400_000), 400).gapBefore, 2);
});

test('device timestamp rollover (≈71.6 min) is unwrapped monotonically', () => {
    const tr = new StreamTracker();
    const start = U32 - 250_000; // 0.25 s before wrap
    const r = [0, 1, 2, 3, 4].map(i => tr.observe(pkt(i, (start + i * 100_000) % U32), i * 100));
    for (let i = 1; i < r.length; i++) assert.equal(r[i].devUs - r[i - 1].devUs, 100_000);
    assert.ok(r[4].devUs > U32);
    assert.equal(tr.snapshot().clockAnomalies, 0);
    assert.equal(tr.snapshot().deviceIntervalUs.max, 100_000);
});

test('long continuous run across several timestamp wraps stays monotonic', () => {
    const tr = new StreamTracker();
    let prev = -1;
    // 1 Hz for 5 hours (> 4 wraps) with host time advancing equally
    for (let i = 0; i < 5 * 3600; i++) {
        const r = tr.observe(pkt(i, (i * 1_000_000) % U32), i * 1000);
        assert.ok(r.devUs > prev);
        prev = r.devUs;
    }
    assert.equal(prev, (5 * 3600 - 1) * 1_000_000);
});

test('host silence longer than half the wrap period → explicit timebase reset, no guessing', () => {
    const tr = new StreamTracker();
    tr.observe(pkt(0, 0), 0);
    const r = tr.observe(pkt(30_000, 5_000), AMBIGUOUS_HOST_GAP_MS + 1);
    assert.ok(r.quality & Q.TIMEBASE_RESET);
    assert.equal(tr.snapshot().timebaseResets, 1);
    assert.equal(r.gapBefore, 29_999); // sequence accounting still works
});

test('BOOT flag starts a new epoch: no false gap, restart counted', () => {
    const tr = new StreamTracker();
    feed(tr, [100, 101, 102], { t0: 0 });
    const r = tr.observe(pkt(0, 5000, 0x01), 99_999);
    assert.ok(r.quality & Q.BOOT);
    assert.equal(r.gapBefore, 0);
    const s = tr.snapshot();
    assert.equal(s.restarts, 1);
    assert.equal(s.missing, 0);
    assert.equal(s.epoch, 1);
});

test('device overrun flag attributes the gap to the device', () => {
    const tr = new StreamTracker();
    feed(tr, [0, 1]);
    const r = tr.observe(pkt(5, 500_000, 0x02), 1500);
    assert.ok(r.quality & Q.DEVICE_OVERRUN);
    assert.equal(tr.snapshot().missingDeviceAttributed, 3);
});

test('clock going backwards on a forward step is flagged as an anomaly', () => {
    const tr = new StreamTracker();
    tr.observe(pkt(0, 1_000_000), 0);
    const r = tr.observe(pkt(1, 900_000), 100);
    assert.ok(r.quality & Q.CLOCK_ANOMALY);
});

test('resetCounters keeps continuity: first packet after reset is not a false gap', () => {
    const tr = new StreamTracker();
    feed(tr, [0, 1, 2]);
    tr.resetCounters();
    const r = tr.observe(pkt(3, 300_000), 1300);
    assert.equal(r.gapBefore, 0);
    assert.equal(tr.snapshot().received, 1);
});

test('relative time uses the anchored device clock (host jitter does not leak into intervals)', () => {
    const tr = new StreamTracker();
    const hostJitter = [0, 37, 3, 61, 12];
    const r = hostJitter.map((j, i) => tr.observe(pkt(i, i * 50_000), 10_000 + i * 50 + j));
    const rel = r.map(x => tr.relativeTimeS(x.devUs, 0, 10_000));
    for (let i = 1; i < rel.length; i++) assert.ok(Math.abs(rel[i] - rel[i - 1] - 0.05) < 1e-12);
    assert.equal(rel[0], 0);
});

test('legacy streams are host-time only and never report gaps', () => {
    const tr = new StreamTracker({ hostTimeOnly: true });
    const r = [0, 100, 250].map(h => tr.observe({}, h));
    assert.ok(r.every(x => x.quality & Q.HOST_TIME_ONLY));
    assert.equal(tr.snapshot().missing, 0);
    assert.equal(tr.relativeTimeS(null, 250, 0), 0.25);
});

test('drift estimate from windowed minimum offsets', () => {
    const tr = new StreamTracker();
    // device clock runs 100 ppm fast relative to host: host = dev*(1-1e-4)
    for (let i = 0; i < 1500; i++) {
        const devUs = i * 100_000;
        const host = (devUs / 1000) * (1 - 1e-4) + 5 + (i % 7); // latency 5..11 ms
        tr.observe(pkt(i, devUs), host);
    }
    const d = tr.driftPpm();
    assert.ok(d !== null && Math.abs(d - -100) < 5, `drift ${d}`);
});

test('newEpoch (boot nonce changed while disconnected): sequence reset is not misread as late packets', () => {
    const tr = new StreamTracker();
    feed(tr, [500, 501, 502]);
    tr.newEpoch();
    const r = tr.observe(pkt(40, 4_000_000), 99_000);
    assert.equal(r.kind, 'first');
    assert.equal(r.accept, true);
    assert.equal(tr.snapshot().restarts, 1);
    assert.equal(tr.snapshot().outOfOrder, 0);
});
