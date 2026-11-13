/**
 * Per-device connection lifecycle with watchdogs, bounded jittered backoff and idempotent
 * disconnect handling.
 *
 * Healthy is defined by data, not by GATT state. A device is STREAMING only after a valid
 * packet has arrived on the current subscription. Connected-but-no-data is WAITING_FOR_DATA,
 * and a stall is DEGRADED.
 */
import { withTimeout } from '../util/clock.js';
import { createProtocolAdapter } from '../protocol/adapters.js';

export const STATES = Object.freeze({
    IDLE: 'IDLE', CONNECTING: 'CONNECTING', DISCOVERING: 'DISCOVERING', SUBSCRIBING: 'SUBSCRIBING',
    WAITING_FOR_DATA: 'WAITING_FOR_DATA', STREAMING: 'STREAMING', DEGRADED: 'DEGRADED',
    DISCONNECTED: 'DISCONNECTED', BACKOFF: 'BACKOFF', DEAD: 'DEAD', CLOSED: 'CLOSED',
});
const S = STATES;

export const DEFAULT_CONFIG = Object.freeze({
    connectTimeoutMs: 10_000,
    discoverTimeoutMs: 10_000,
    subscribeTimeoutMs: 5_000,
    firstDataTimeoutMs: 5_000,
    staleAfterMs: 3_000,          // no valid packet for this long → DEGRADED
    watchdogIntervalMs: 500,
    backoffBaseMs: 1_000,
    backoffCapMs: 30_000,
    maxAttempts: 6,               // reconnect attempts before DEAD (explicit Retry needed)
    stableResetMs: 30_000,        // sustained STREAMING needed before the attempt counter resets
    controlAckTimeoutMs: 2_000,
});

/** Delay before reconnect attempt `n` (0-based): capped exponential with "equal jitter" in [d/2, d]. */
export function backoffDelay(n, cfg, random) {
    const d = Math.min(cfg.backoffCapMs, cfg.backoffBaseMs * 2 ** n);
    return Math.round(d / 2 + (d / 2) * random());
}

/** Serializes connection attempts across devices (conservative default; see ADR). */
export class ConnectQueue {
    constructor() { this._tail = Promise.resolve(); this.enabled = true; }
    run(fn) {
        if (!this.enabled) return fn();
        const p = this._tail.then(fn, fn);
        this._tail = p.catch(() => {});
        return p;
    }
}

export class DeviceConnection {
    /**
     * @param {object} o
     * @param o.device transport device
     * @param o.profile {kind:'sltp'} | {kind:'legacy', serviceUuid, charUuid, ...}
     * @param o.hooks {onInfo(info), onBytes(bytes, hostMs) -> boolean valid, onState(state, detail)}
     */
    constructor({ device, profile, clock, queue, hooks, config = {} }) {
        this.device = device;
        this.profile = profile;
        this.adapter = createProtocolAdapter(profile);
        this.clock = clock;
        this.queue = queue || new ConnectQueue();
        this.hooks = hooks;
        this.cfg = { ...DEFAULT_CONFIG, ...config };
        this.state = S.IDLE;
        this.detail = null;
        this.lastError = null;
        this.attempts = 0;
        this.counters = { connects: 0, disconnects: 0, reconnects: 0, failedAttempts: 0, timeouts: 0 };
        this.subscribedAtMs = null;
        this.lastValidMs = null;
        this.nextRetryAtMs = null;
        this._gen = 0;
        this._unsub = null;
        this._unsubs = [];
        this._readStreams = [];
        this._timers = new Set();
        this._chars = null;
        this._everConnected = false;
        this._offDisc = device.onDisconnect(() => this._onLinkLost());
    }

    _set(state, detail = null) {
        this.state = state;
        this.detail = detail;
        try { this.hooks.onState?.(state, detail); } catch { /* UI errors must not affect the lifecycle */ }
    }

    _timer(fn, ms) {
        const h = this.clock.setTimeout(() => { this._timers.delete(h); fn(); }, ms);
        this._timers.add(h);
        return h;
    }

    _clearTimers() { for (const h of this._timers) this.clock.clearTimeout(h); this._timers.clear(); }

    /** True once required services/characteristics were discovered on the current connection. */
    get discovered() { return !!(this._chars && (this._chars.data || this._chars.streams?.length)); }
    /** True while a notification or configured GATT-read data source is active. */
    get subscriptionActive() { return this._unsubs.length > 0 || this._readStreams.length > 0; }

    start() { if (this.state === S.IDLE) this._attempt(); }

    /** Explicit user retry after DEAD (or to skip a pending backoff). */
    retry() {
        if (this.state !== S.DEAD && this.state !== S.BACKOFF) return false;
        this._clearTimers();
        this.attempts = 0;
        this._attempt();
        return true;
    }

    async _attempt() {
        const gen = ++this._gen;
        const stale = () => gen !== this._gen;
        this._clearTimers();
        this.nextRetryAtMs = null;
        try {
            await this.queue.run(async () => {
                if (stale()) return;
                this._set(S.CONNECTING);
                await withTimeout(this.device.connect(), this.cfg.connectTimeoutMs, this.clock, 'CONNECT_TIMEOUT');
                if (stale()) return;
                this._set(S.DISCOVERING);
                this._chars = await withTimeout(this._discover(), this.cfg.discoverTimeoutMs, this.clock, 'DISCOVER_TIMEOUT');
                if (stale()) return;
                this._set(S.SUBSCRIBING);
                const streams = this._chars.streams || [{ id: 'data', characteristic: this._chars.data, mode: 'notify' }];
                const readStreams = [];
                this._unsubs = [];
                this._readStreams = readStreams;
                this._unsub = async () => {
                    for (const stop of this._unsubs.splice(0)) await stop();
                };
                for (const stream of streams) {
                    if (stream.mode === 'write') continue;
                    if (stream.mode === 'read') {
                        readStreams.push(stream);
                        continue;
                    }
                    const unsub = await withTimeout(
                        stream.characteristic.subscribe((bytes, hostMs) => this._onBytes(gen, bytes, hostMs, stream.id)),
                        this.cfg.subscribeTimeoutMs, this.clock, 'SUBSCRIBE_TIMEOUT');
                    this._unsubs.push(unsub);
                    if (stale()) {
                        await this._unsub();
                        return;
                    }
                }
            });
            if (stale()) return;
            this.counters.connects++;
            if (this._everConnected) this.counters.reconnects++;
            this._everConnected = true;
            this.subscribedAtMs = this.clock.now();
            this.lastValidMs = null;
            this._set(S.WAITING_FOR_DATA);
            this._watchdog(gen);
            if (this._readStreams?.length) this._pollReads(gen);
        } catch (e) {
            if (stale()) return;
            this.counters.failedAttempts++;
            if (/TIMEOUT/.test(e.code || '')) this.counters.timeouts++;
            this.lastError = { code: e.code || 'CONNECT_FAILED', message: String(e.message || e), atMs: this.clock.now() };
            await this._teardown();
            if (stale()) return;
            if (e.nonRetryable) { this._set(S.DEAD, this.lastError); return; }
            this._scheduleReconnect();
        }
    }

    async _discover() {
        return this.adapter.discover(this.device, this.profile, this.hooks);
    }

    _onBytes(gen, bytes, hostMs, characteristicId = 'data') {
        if (gen !== this._gen) return; // stale subscription from an earlier connection
        let valid = false;
        try { valid = this.hooks.onBytes(bytes, hostMs, characteristicId) === true; } catch { valid = false; }
        if (!valid) return;
        this.lastValidMs = hostMs;
        if (this.state === S.WAITING_FOR_DATA || this.state === S.DEGRADED) {
            this._set(S.STREAMING);
            this._streamingSinceMs = hostMs;
        }
        if (this.state === S.STREAMING && this.attempts > 0 && hostMs - this._streamingSinceMs >= this.cfg.stableResetMs) {
            this.attempts = 0; // reset backoff only after sustained valid streaming
        }
    }

    async _pollReads(gen) {
        if (gen !== this._gen || !this._readStreams?.length) return;
        for (const stream of this._readStreams) {
            if (gen !== this._gen) return;
            try {
                const bytes = await withTimeout(stream.characteristic.read(), this.cfg.subscribeTimeoutMs, this.clock, 'GATT_READ_TIMEOUT');
                this._onBytes(gen, bytes, this.clock.now(), stream.id);
            } catch (e) {
                if (gen !== this._gen) return;
                this.lastError = { code: 'GATT_READ_FAILED', message: `${stream.id}: ${String(e.message || e)}`, atMs: this.clock.now() };
                this._set(S.DEGRADED, this.lastError);
            }
        }
        if (gen !== this._gen) return;
        const interval = Math.min(...this._readStreams.map(stream => stream.intervalMs || this.profile.sampling?.intervalMs || 1_000));
        this._timer(() => this._pollReads(gen), interval);
    }

    _watchdog(gen) {
        this._timer(() => {
            if (gen !== this._gen) return;
            const now = this.clock.now();
            const profileInterval = this.profile.kind === 'generic' ? this.profile.sampling?.intervalMs || 0 : 0;
            const firstDataTimeoutMs = Math.max(this.cfg.firstDataTimeoutMs, profileInterval * 2);
            if (this.state === S.WAITING_FOR_DATA && now - this.subscribedAtMs >= firstDataTimeoutMs) {
                this._set(S.DEGRADED, { code: 'NO_DATA_AFTER_SUBSCRIBE', message: `no valid data ${Math.round((now - this.subscribedAtMs) / 1000)} s after subscribing` });
            } else if (this.state === S.STREAMING && now - this.lastValidMs >= this._staleAfter()) {
                this._set(S.DEGRADED, { code: 'STALE', message: `no valid data for ${((now - this.lastValidMs) / 1000).toFixed(1)} s` });
            } else if (this.state === S.DEGRADED && this.lastValidMs !== null && now - this.lastValidMs < this._staleAfter()) {
                this._set(S.STREAMING);
            }
            if (!this.device.connected && [S.WAITING_FOR_DATA, S.STREAMING, S.DEGRADED].includes(this.state)) {
                this._onLinkLost(); // missed disconnect event (e.g. tab was hidden)
                return;
            }
            this._watchdog(gen);
        }, this.cfg.watchdogIntervalMs);
    }

    /** Link-level stall threshold: the configured floor, or longer for slow streams (hook supplied by the service). */
    _staleAfter() {
        let h = null;
        try { h = this.hooks.staleAfterMs?.(); } catch { h = null; }
        return Number.isFinite(h) ? Math.max(this.cfg.staleAfterMs, h) : (h === Infinity ? Infinity : this.cfg.staleAfterMs);
    }

    /** Idempotent: repeated or concurrent disconnect events start at most one reconnect task. */
    _onLinkLost() {
        if (![S.WAITING_FOR_DATA, S.STREAMING, S.DEGRADED].includes(this.state)) return; // attempt in flight handles its own failure
        this._gen++;
        this.counters.disconnects++;
        this._clearTimers();
        this._set(S.DISCONNECTED);
        this._teardown().then(() => { if (this.state === S.DISCONNECTED) this._scheduleReconnect(); });
    }

    _scheduleReconnect() {
        if (this.attempts >= this.cfg.maxAttempts) {
            this._set(S.DEAD, { code: 'RETRIES_EXHAUSTED', message: `gave up after ${this.attempts} reconnect attempts`, lastError: this.lastError });
            return;
        }
        const delay = backoffDelay(this.attempts, this.cfg, this.clock.random);
        this.attempts++;
        this.nextRetryAtMs = this.clock.now() + delay;
        this._set(S.BACKOFF, { attempt: this.attempts, maxAttempts: this.cfg.maxAttempts, retryInMs: delay, lastError: this.lastError });
        const gen = this._gen;
        this._timer(() => { if (gen === this._gen && this.state === S.BACKOFF) this._attempt(); }, delay);
    }

    async _teardown() {
        const u = this._unsub;
        this._unsub = null;
        if (u) { try { await u(); } catch { /* ignore */ } }
        this.adapter.reset?.();
        this._unsubs = [];
        this._readStreams = [];
        this._chars = null;
        try { this.device.disconnect(); } catch { /* ignore */ }
    }

    /**
     * Write a CONTROL command, then confirm it by reading INFO back.
     * Resolves {ok, info} or {ok:false, error}.
     */
    async sendControl(bytes, verify) {
        if (!this.adapter.sendControl) return { ok: false, error: 'this protocol adapter does not provide control commands' };
        if (!this._chars) return { ok: false, error: 'device is not discovered' };
        return this.adapter.sendControl(this._chars, bytes, verify, this.clock, this.cfg);
    }

    async writeCharacteristic(id, input) {
        const characteristic = this._chars?.writes?.find(item => item.id === id)?.characteristic;
        if (!characteristic) return { ok: false, error: 'profile does not expose this write characteristic' };
        if (!(input instanceof Uint8Array) || input.length < 1 || input.length > 512) {
            return { ok: false, error: 'write payload must be a Uint8Array of 1–512 bytes' };
        }
        try {
            await withTimeout(characteristic.write(input), this.cfg.controlAckTimeoutMs, this.clock, 'GATT_WRITE_TIMEOUT');
            return { ok: true };
        } catch (e) {
            return { ok: false, error: String(e.message || e) };
        }
    }

    /** User-initiated close: no reconnect. */
    async close() {
        this._gen++;
        this._clearTimers();
        this._offDisc?.();            // detach first so our own disconnect cannot trigger a reconnect
        this._offDisc = null;
        this._set(S.CLOSED);
        await this._teardown();
        this.device.dispose?.();
    }
}
