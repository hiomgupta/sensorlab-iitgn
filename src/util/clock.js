/**
 * Injectable clocks. All acquisition timing uses a monotonic clock (performance.now), never
 * Date.now. Wall-clock time appears only as human-readable session metadata.
 */
export const realClock = {
    now: () => performance.now(),
    wallNow: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
    random: () => Math.random(),
};

/** Deterministic PRNG (mulberry32) for the simulator and tests. */
export function seededRandom(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Manual clock for deterministic simulation: timers run only when advanced.
 * advance() is async so promise continuations scheduled by timers settle between timers.
 */
export class ManualClock {
    constructor({ start = 0, wallStart = Date.UTC(2026, 0, 1), seed = 1 } = {}) {
        this.t = start;
        this.wallStart = wallStart - start;
        this._timers = [];
        this._id = 0;
        this.random = seededRandom(seed);
    }
    now() { return this.t; }
    wallNow() { return this.wallStart + this.t; }
    setTimeout(fn, ms) {
        const id = ++this._id;
        this._timers.push({ id, at: this.t + Math.max(0, ms || 0), fn });
        return id;
    }
    clearTimeout(id) { this._timers = this._timers.filter(x => x.id !== id); }
    get pending() { return this._timers.length; }
    async advance(ms) {
        const end = this.t + ms;
        await flush();
        for (;;) {
            this._timers.sort((a, b) => a.at - b.at || a.id - b.id);
            const next = this._timers[0];
            if (!next || next.at > end) break;
            this._timers.shift();
            this.t = Math.max(this.t, next.at); // monotonic: overdue timers run "late", time never goes back
            next.fn();
            await flush();
        }
        this.t = end;
        await flush();
    }
}

async function flush() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    // Let macrotask-based I/O (e.g. IndexedDB in Node test shims) settle as well.
    if (typeof setImmediate === 'function') await new Promise(r => setImmediate(r));
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Reject if `promise` does not settle within ms (on the given clock). */
export function withTimeout(promise, ms, clock, code) {
    return new Promise((resolve, reject) => {
        const h = clock.setTimeout(() => {
            const e = new Error(`${code} after ${ms} ms`);
            e.code = code;
            reject(e);
        }, ms);
        promise.then(v => { clock.clearTimeout(h); resolve(v); }, e => { clock.clearTimeout(h); reject(e); });
    });
}
