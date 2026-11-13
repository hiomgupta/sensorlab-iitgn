/**
 * StreamTracker: per-device sequence and timestamp accounting.
 *
 * Pure logic. Callers pass the host monotonic receipt time (ms). No wall clock is used.
 * Sequence arithmetic is modulo 2^32 (docs/PROTOCOL.md §4). Device time is unwrapped as in §5.
 */
import { Q, RunningStats } from './quality.js';

const U32 = 0x1_0000_0000;
const HALF = 0x8000_0000;
const WINDOW = 4096;              // sequence window for duplicate / late classification
const MAX_GAP_LOG = 200;
const RATE_RING = 256;
export const AMBIGUOUS_HOST_GAP_MS = HALF / 1000;   // ≈ 35.8 min

/** forward distance a→b modulo 2^32 */
function fwd(a, b) { return (b - a + U32) % U32; }

export class StreamTracker {
    /** @param {{hostTimeOnly?: boolean}} opts hostTimeOnly = legacy stream without seq/timestamps */
    constructor({ hostTimeOnly = false } = {}) {
        this.hostTimeOnly = hostTimeOnly;
        this.epoch = 0;
        this.timebase = 0;
        this._resetEpochState();
        this.resetCounters();
    }

    _resetEpochState() {
        this.lastSeq = null;          // highest sequence seen in this epoch (modular sense)
        this.seen = new Set();        // sequences received within WINDOW behind lastSeq
        this.missing = new Set();     // sequences counted missing within WINDOW
        this._resetTimebase();
    }

    _resetTimebase() {
        this.wraps = 0;
        this.lastDevUs = null;        // unwrapped device time of lastSeq packet
        this.lastHostMs = null;
        this.anchor = null;           // { hostMs, devUs } for relative-time mapping
        this.minOffsetMs = null;      // min(host - device) in this timebase (clock mapping)
        this._driftWin = null;        // current 30 s window {startUs, min}
        this._driftFirst = null;      // first completed window {midUs, min}
        this._driftLast = null;       // latest completed window {midUs, min}
    }

    /**
     * Start a new epoch without a BOOT packet, e.g. when INFO shows a new boot nonce after a
     * reconnect. The next packet is treated as the first in the epoch, so no false gap or
     * "late" classification results.
     */
    newEpoch() {
        if (this.lastSeq !== null) this.c.restarts++;
        this.epoch++;
        this._resetEpochState();
    }

    /** Reset diagnostic counters (e.g. at recording start) without losing continuity state. */
    resetCounters() {
        this.c = {
            received: 0, missing: 0, missingDeviceAttributed: 0, duplicates: 0, outOfOrder: 0,
            recoveredLate: 0, tooOld: 0, gapCount: 0, longestGap: 0, restarts: 0,
            timebaseResets: 0, clockAnomalies: 0, firstSeq: null, lastSeq: null,
        };
        this.gaps = [];
        this.devInterval = new RunningStats();   // µs, consecutive samples only
        this.hostInterval = new RunningStats();  // ms, consecutive samples only
        this.excessLatency = new RunningStats(); // ms above min(host-device) offset
        this._rate = [];                          // recent sample times (device µs or host ms·1000)
    }

    /**
     * Classify one packet.
     * @param {{sequence?:number, deviceTimeUs?:number, flags?:number}} p parsed packet (ignored fields for legacy)
     * @param {number} hostMs host monotonic receipt time
     * @returns {{accept:boolean, kind:string, quality:number, gapBefore:number, seq:number|null, devUs:number|null}}
     */
    observe(p, hostMs) {
        if (this.hostTimeOnly) return this._observeLegacy(hostMs);

        let quality = 0;
        const flags = p.flags || 0;
        if (flags & 0x01) { // BOOT
            if (this.lastSeq !== null) this.c.restarts++;
            this.epoch++;
            this._resetEpochState();
            quality |= Q.BOOT;
        }
        if (flags & 0x04) quality |= Q.SENSOR_FAULT;

        // Ambiguous unwrap: too long since the previous packet on the host clock.
        if (this.lastHostMs !== null && hostMs - this.lastHostMs >= AMBIGUOUS_HOST_GAP_MS) {
            this.timebase++;
            this.c.timebaseResets++;
            this._resetTimebase();
            quality |= Q.TIMEBASE_RESET;
        }

        const seq = p.sequence >>> 0;
        let kind, gapBefore = 0;

        if (this.lastSeq === null) {
            kind = 'first';
        } else {
            const d = fwd(this.lastSeq, seq);
            if (d === 0) kind = 'duplicate';
            else if (d < HALF) kind = 'forward';
            else kind = 'late';
        }

        if (kind === 'duplicate') { this.c.duplicates++; return { accept: false, kind, quality, gapBefore, seq, devUs: null }; }

        if (kind === 'late') {
            const behind = fwd(seq, this.lastSeq);
            if (behind >= WINDOW) { this.c.tooOld++; return { accept: false, kind: 'too_old', quality, gapBefore, seq, devUs: null }; }
            if (this.seen.has(seq)) { this.c.duplicates++; return { accept: false, kind: 'duplicate', quality, gapBefore, seq, devUs: null }; }
            // A late arrival fills a gap that was counted as missing.
            this.c.outOfOrder++;
            if (this.missing.delete(seq)) { this.c.missing--; this.c.recoveredLate++; }
            this.seen.add(seq);
            quality |= Q.OUT_OF_ORDER;
            const devUs = this._unwrapNear(p.deviceTimeUs >>> 0);
            this.c.received++;
            return { accept: true, kind, quality, gapBefore, seq, devUs };
        }

        // first or forward
        if (kind === 'forward') {
            gapBefore = fwd(this.lastSeq, seq) - 1;
            if (gapBefore > 0) {
                quality |= Q.GAP_BEFORE;
                this.c.missing += gapBefore;
                this.c.gapCount++;
                if (gapBefore > this.c.longestGap) this.c.longestGap = gapBefore;
                if (flags & 0x02) { quality |= Q.DEVICE_OVERRUN; this.c.missingDeviceAttributed += gapBefore; }
                if (this.gaps.length < MAX_GAP_LOG) this.gaps.push({ afterSeq: this.lastSeq, missing: gapBefore, hostMs, epoch: this.epoch });
                const toMark = Math.min(gapBefore, WINDOW);
                for (let k = gapBefore - toMark + 1; k <= gapBefore; k++) this.missing.add((this.lastSeq + k) % U32);
            }
        } else if (flags & 0x02) {
            quality |= Q.DEVICE_OVERRUN;
        }

        const raw = p.deviceTimeUs >>> 0;
        const devUs = this.lastDevUs === null ? this.wraps * U32 + raw : this._unwrapNear(raw);
        if (this.lastDevUs !== null && devUs < this.lastDevUs) { quality |= Q.CLOCK_ANOMALY; this.c.clockAnomalies++; }

        if (kind === 'forward' && gapBefore === 0 && !(quality & (Q.CLOCK_ANOMALY | Q.TIMEBASE_RESET))) {
            this.devInterval.push(devUs - this.lastDevUs);
            this.hostInterval.push(hostMs - this.lastHostMs);
        }

        // clock mapping (min-filter of host - device)
        const off = hostMs - devUs / 1000;
        if (this.minOffsetMs === null || off < this.minOffsetMs) this.minOffsetMs = off;
        this._trackDrift(devUs, off);
        this.excessLatency.push(off - this.minOffsetMs);
        if (!this.anchor) this.anchor = { hostMs, devUs };

        this.lastSeq = seq;
        this.lastDevUs = devUs;
        this.lastHostMs = hostMs;
        this.wraps = Math.floor(devUs / U32);
        this.seen.add(seq);
        this._prune();
        this.c.received++;
        if (this.c.firstSeq === null) this.c.firstSeq = seq;
        this.c.lastSeq = seq;
        this._pushRate(devUs);
        return { accept: true, kind, quality, gapBefore, seq, devUs };
    }

    _observeLegacy(hostMs) {
        if (this.lastHostMs !== null) this.hostInterval.push(hostMs - this.lastHostMs);
        this.lastHostMs = hostMs;
        const seq = this.c.received; // host-assigned arrival counter
        this.c.received++;
        if (this.c.firstSeq === null) this.c.firstSeq = seq;
        this.c.lastSeq = seq;
        if (!this.anchor) this.anchor = { hostMs, devUs: null };
        this._pushRate(hostMs * 1000);
        return { accept: true, kind: 'legacy', quality: Q.HOST_TIME_ONLY, gapBefore: 0, seq, devUs: null };
    }

    /** choose the unwrapped value (raw + k·2^32) closest to the last unwrapped device time */
    _unwrapNear(raw) {
        if (this.lastDevUs === null) return this.wraps * U32 + raw;
        const base = Math.floor(this.lastDevUs / U32) * U32;
        let best = base + raw, bestD = Math.abs(best - this.lastDevUs);
        for (const cand of [base + raw + U32, base + raw - U32]) {
            if (cand < 0) continue;
            const dd = Math.abs(cand - this.lastDevUs);
            if (dd < bestD) { best = cand; bestD = dd; }
        }
        return best;
    }

    _prune() {
        if (this.seen.size > WINDOW * 2) {
            for (const s of this.seen) if (fwd(s, this.lastSeq) >= WINDOW) this.seen.delete(s);
        }
        if (this.missing.size > WINDOW * 2) {
            for (const s of this.missing) if (fwd(s, this.lastSeq) >= WINDOW) this.missing.delete(s);
        }
    }

    _pushRate(tUs) {
        this._rate.push(tUs);
        if (this._rate.length > RATE_RING) this._rate.shift();
    }

    /**
     * Session-relative time (s) of a sample.
     * SLTP: anchored device clock, so intra-device intervals are exact device-clock intervals.
     * Legacy: host receipt time.
     */
    relativeTimeS(devUs, hostMs, sessionStartHostMs) {
        if (devUs === null || !this.anchor || this.anchor.devUs === null) return (hostMs - sessionStartHostMs) / 1000;
        return (this.anchor.hostMs - sessionStartHostMs) / 1000 + (devUs - this.anchor.devUs) / 1e6;
    }

    /** Re-anchor the relative time mapping (e.g. when a recording starts). */
    reanchor() { this.anchor = null; }

    /** Measured sample rate (Hz) over the recent window, from device clock (or host clock for legacy). */
    measuredRateHz() {
        const r = this._rate;
        if (r.length < 2) return null;
        const span = r[r.length - 1] - r[0];
        return span > 0 ? ((r.length - 1) * 1e6) / span : null;
    }

    /** Minimum (host − device) offset per 30 s device-time window; minima are robust to latency spikes. */
    _trackDrift(devUs, off) {
        const W = 30e6;
        if (!this._driftWin) { this._driftWin = { startUs: devUs, min: off }; return; }
        if (devUs - this._driftWin.startUs >= W) {
            const done = { midUs: this._driftWin.startUs + W / 2, min: this._driftWin.min };
            if (!this._driftFirst) this._driftFirst = done; else this._driftLast = done;
            this._driftWin = { startUs: devUs, min: off };
        } else if (off < this._driftWin.min) this._driftWin.min = off;
    }

    /**
     * Estimated device-vs-host clock drift (ppm): slope between the minimum offsets of the first
     * and latest complete 30 s windows. null until ≥ 60 s separates the windows. Diagnostic only.
     */
    driftPpm() {
        const a = this._driftFirst, b = this._driftLast;
        if (!a || !b) return null;
        const spanMs = (b.midUs - a.midUs) / 1000;
        if (spanMs < 60_000) return null;
        return ((b.min - a.min) / spanMs) * 1e6;
    }

    snapshot() {
        return {
            ...this.c,
            epoch: this.epoch,
            timebase: this.timebase,
            hostTimeOnly: this.hostTimeOnly,
            gaps: this.gaps.slice(),
            deviceIntervalUs: this.devInterval.toJSON(),
            hostIntervalMs: this.hostInterval.toJSON(),
            excessReceiptLatencyMs: this.excessLatency.toJSON(),
            measuredRateHz: this.measuredRateHz(),
            driftPpmEstimate: this.driftPpm(),
        };
    }
}
