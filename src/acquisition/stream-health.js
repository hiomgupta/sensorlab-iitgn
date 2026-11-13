/**
 * Per-stream (device × channel) freshness, judged relative to each stream's EXPECTED sample interval.
 *
 * Stream states:
 *   WAITING     no valid sample yet in this session/connection
 *   FRESH       last valid sample age < suspect threshold
 *   SUSPECT     age ≥ suspectFactor × interval  (default 3)
 *   STALE       age ≥ staleFactor × interval    (default 5)
 *   INVALID     packets arrive, but only invalid values (sensor fault / open circuit) for ≥ stale threshold
 *   RECOVERING  device link down or reconnecting, or reconnected but no fresh valid sample yet
 *   DISCONNECTED device failed (retries exhausted); needs manual Retry or removal
 *   REMOVED     user removed the device (excluded from session health)
 *   IDLE_ON_CHANGE  on-change stream connected, no value sent yet (healthy: silence is expected)
 *
 * Thresholds have floors (minSuspectMs / minStaleMs) because BLE delivers notifications per connection
 * interval and may batch several samples. "On change" streams (no fixed rate) are never judged stale from
 * silence alone; only connection loss affects them. Nothing here fabricates or interpolates samples. The
 * last valid sample is kept and reported with its age, never as a current value.
 */
import { STATES as DEV } from './device-connection.js';

export const DEFAULT_HEALTH_POLICY = Object.freeze({
    suspectFactor: 3, staleFactor: 5, minSuspectMs: 500, minStaleMs: 1000, fallbackIntervalMs: 1000,
});

const RECONNECTING = [DEV.DISCONNECTED, DEV.BACKOFF, DEV.CONNECTING, DEV.DISCOVERING, DEV.SUBSCRIBING, DEV.IDLE];

/**
 * Expected interval for an entry: SLTP INFO period, profile override, or measured legacy interval.
 * Returns {ms, source}; ms=null means "on change" (no rate).
 */
export function expectedIntervalMs(entry, policy = DEFAULT_HEALTH_POLICY) {
    if (entry.profile?.onChange) return { ms: null, source: 'on-change stream (no fixed rate)' };
    if (entry.profile?.expectedIntervalMs) return { ms: entry.profile.expectedIntervalMs, source: 'profile' };
    if (entry.profile?.sampling?.intervalMs) return { ms: entry.profile.sampling.intervalMs, source: 'generic GATT profile interval' };
    if (entry.info?.periodUs) return { ms: entry.info.periodUs / 1000, source: 'device INFO period' };
    const hi = entry.tracker?.hostInterval;
    if (hi && hi.n >= 5 && hi.mean > 0) return { ms: hi.mean, source: 'measured host interval' };
    return { ms: policy.fallbackIntervalMs, source: 'fallback (rate unknown)' };
}

export function thresholds(intervalMs, policy = DEFAULT_HEALTH_POLICY) {
    if (intervalMs === null) return { suspectMs: Infinity, staleMs: Infinity };
    return {
        suspectMs: Math.max(policy.suspectFactor * intervalMs, policy.minSuspectMs),
        staleMs: Math.max(policy.staleFactor * intervalMs, policy.minStaleMs),
    };
}

export class StreamHealth {
    constructor({ policy = {} } = {}) {
        this.policy = { ...DEFAULT_HEALTH_POLICY, ...policy };
        this.streams = new Map(); // key → stream record
    }

    static key(deviceId, channelId) { return `${deviceId}|${channelId}`; }

    /** Start tracking (or re-arm) the streams of an entry from host time `sinceMs`. */
    track(entry, sinceMs, included = true) {
        for (const ch of entry.channels) {
            const k = StreamHealth.key(entry.deviceId, ch.channelId);
            const prev = this.streams.get(k);
            this.streams.set(k, {
                key: k, deviceId: entry.deviceId, channelId: ch.channelId, handle: entry.handle,
                name: ch.name, unit: ch.unit, included,
                sinceMs, state: 'WAITING', lastValid: prev?.lastValid ?? null, lastPacketMs: null,
                firstValidMs: null,
            });
        }
    }

    has(deviceId, channelId) { return this.streams.has(StreamHealth.key(deviceId, channelId)); }

    /** Feed one reading (from the acquisition sink). */
    onReading(r, hostAbsMs) {
        const s = this.streams.get(StreamHealth.key(r.deviceId, r.channelId));
        if (!s) return;
        s.lastPacketMs = hostAbsMs;
        if (r.value !== null && r.value !== undefined) {
            s.lastValid = { value: r.value, relS: r.relS, hostMs: hostAbsMs, seq: r.seq };
            if (s.firstValidMs === null && hostAbsMs >= s.sinceMs) s.firstValidMs = hostAbsMs;
        }
    }

    markRemoved(deviceId) { for (const s of this.streams.values()) if (s.deviceId === deviceId) s.state = 'REMOVED'; }

    /**
     * Recompute every stream's state at host time `now`.
     * @param entries Map/iterable of acquisition entries (for connection state and expected interval)
     * @returns {Array<{stream, from, to, ageMs, intervalMs}>} state changes
     */
    evaluate(now, entries) {
        const byDevice = new Map();
        for (const e of entries) if (e.deviceId) byDevice.set(e.deviceId, e);
        const changes = [];
        for (const s of this.streams.values()) {
            if (s.state === 'REMOVED') continue;
            const e = byDevice.get(s.deviceId);
            let next;
            const { ms: intervalMs } = e ? expectedIntervalMs(e, this.policy) : { ms: null };
            const { suspectMs, staleMs } = thresholds(intervalMs, this.policy);
            // Freshness is re-established per connection: a sample from before the latest (re)subscription never counts.
            const connSince = Math.max(e?.conn.subscribedAtMs ?? -Infinity, s.sinceMs);
            const validSinceConnect = s.lastValid && s.lastValid.hostMs >= connSince;
            const ageMs = s.lastValid ? now - s.lastValid.hostMs : null;
            if (!e || e.conn.state === DEV.CLOSED) next = 'REMOVED';
            else if (e.conn.state === DEV.DEAD) next = 'DISCONNECTED';
            else if (RECONNECTING.includes(e.conn.state)) next = 'RECOVERING';
            else if (intervalMs === null && !validSinceConnect) next = 'IDLE_ON_CHANGE'; // on-change stream: silence is normal
            else if (!validSinceConnect) {
                // connected and subscribed, but no valid sample on this connection yet
                const packetsButInvalid = s.lastPacketMs !== null && s.lastPacketMs >= connSince && now - connSince >= staleMs;
                if (packetsButInvalid) next = 'INVALID';
                else if (connSince > s.sinceMs && s.firstValidMs !== null) next = 'RECOVERING'; // reconnected, awaiting fresh data
                else next = now - connSince >= staleMs ? 'STALE' : 'WAITING';
            } else if (ageMs >= staleMs) {
                next = s.lastPacketMs !== null && now - s.lastPacketMs < suspectMs ? 'INVALID' : 'STALE';
            } else if (ageMs >= suspectMs) next = 'SUSPECT';
            else next = 'FRESH';
            if (next !== s.state) {
                changes.push({ stream: s, from: s.state, to: next, ageMs, intervalMs });
                s.state = next;
            }
        }
        return changes;
    }

    list() { return [...this.streams.values()]; }
    included() { return this.list().filter(s => s.included); }
}
