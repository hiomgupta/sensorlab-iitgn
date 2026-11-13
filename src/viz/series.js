/**
 * Pure visualization data structures (no DOM, no Chart.js).
 * Live series are bounded ring buffers keyed by (deviceId, channelId). Gaps and invalid samples
 * are kept as explicit null points, so a line never bridges missing data.
 */

export const seriesKey = (deviceId, channelId) => `${deviceId}|${channelId}`;

export class RingBuffer {
    constructor(capacity) {
        this.cap = capacity;
        this.x = new Float64Array(capacity);
        this.y = new Float64Array(capacity); // NaN = gap / invalid
        this.start = 0;
        this.length = 0;
    }
    push(x, y) {
        const i = (this.start + this.length) % this.cap;
        this.x[i] = x;
        this.y[i] = y === null || y === undefined ? NaN : y;
        if (this.length < this.cap) this.length++;
        else this.start = (this.start + 1) % this.cap;
    }
    get(i) { const k = (this.start + i) % this.cap; return [this.x[k], this.y[k]]; }
    lastX() { return this.length ? this.x[(this.start + this.length - 1) % this.cap] : null; }
    clear() { this.start = 0; this.length = 0; }
    /** points with x in [x0, x1] as arrays */
    window(x0, x1) {
        const xs = [], ys = [];
        for (let i = 0; i < this.length; i++) {
            const [x, y] = this.get(i);
            if (x >= x0 && x <= x1) { xs.push(x); ys.push(y); }
        }
        return { xs, ys };
    }
}

/**
 * Min/max bucket decimation that preserves extremes and gaps. Each bucket emits its min and max
 * in x order. A bucket that contains a gap (NaN) also emits a null point so lines break there.
 * @returns {{x:number, y:number|null}[]}
 */
export function decimateMinMax(xs, ys, maxPoints) {
    const n = xs.length;
    if (n <= maxPoints) return xs.map((x, i) => ({ x, y: Number.isNaN(ys[i]) || ys[i] === null ? null : ys[i] }));
    const buckets = Math.max(1, Math.floor(maxPoints / 3));
    const x0 = xs[0], span = xs[n - 1] - x0 || 1;
    const out = [];
    let b = 0, i = 0;
    while (i < n) {
        const bEnd = x0 + (span * (b + 1)) / buckets;
        let minI = -1, maxI = -1, gap = -1;
        while (i < n && (xs[i] <= bEnd || b === buckets - 1)) {
            const y = ys[i];
            if (y === null || Number.isNaN(y)) { if (gap < 0) gap = i; }
            else {
                if (minI < 0 || y < ys[minI]) minI = i;
                if (maxI < 0 || y > ys[maxI]) maxI = i;
            }
            i++;
        }
        const pts = [];
        if (minI >= 0) pts.push(minI);
        if (maxI >= 0 && maxI !== minI) pts.push(maxI);
        pts.sort((a, c) => a - c);
        const emitted = pts.map(k => ({ x: xs[k], y: ys[k] }));
        if (gap >= 0) {
            // place the break at its true position relative to the extremes
            const g = { x: xs[gap], y: null };
            const pos = emitted.findIndex(p => p.x > g.x);
            if (pos < 0) emitted.push(g); else emitted.splice(pos, 0, g);
        }
        out.push(...emitted);
        b++;
    }
    return out;
}

/** Group series by unit so incompatible units never share a y axis. */
export function axisPlan(series) {
    const units = [];
    for (const s of series) if (!units.includes(s.unit)) units.push(s.unit);
    return units.map((unit, i) => ({ id: 'y' + i, unit, position: i % 2 === 0 ? 'left' : 'right' }));
}
