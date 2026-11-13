/**
 * Explicit recording-session state machine. This is separate from the per-device connection states
 * (device-connection.js) and the per-stream freshness states (stream-health.js).
 *
 *   IDLE → PREFLIGHT → STARTING → RECORDING ⇄ DEGRADED ⇄ INTERRUPTED ⇄ RECOVERING → STOPPING → COMPLETED
 *                   ↘ IDLE (cancel / fatal preflight; cancel in STARTING before the session record exists)
 *                              ↘ START_FAILED → IDLE                         STOPPING → FINALIZE_FAILED → IDLE
 *
 * Illegal transitions throw, so a lifecycle bug cannot silently put a session in a misleading state.
 */
export const SESSION = Object.freeze({
    IDLE: 'IDLE', PREFLIGHT: 'PREFLIGHT', STARTING: 'STARTING', START_FAILED: 'START_FAILED',
    RECORDING: 'RECORDING', DEGRADED: 'DEGRADED', INTERRUPTED: 'INTERRUPTED', RECOVERING: 'RECOVERING',
    STOPPING: 'STOPPING', COMPLETED: 'COMPLETED', FINALIZE_FAILED: 'FINALIZE_FAILED',
});
const S = SESSION;
const HEALTH = [S.RECORDING, S.DEGRADED, S.INTERRUPTED, S.RECOVERING];

export const TRANSITIONS = Object.freeze({
    [S.IDLE]: [S.PREFLIGHT],
    [S.PREFLIGHT]: [S.STARTING, S.IDLE],
    [S.STARTING]: [S.RECORDING, S.DEGRADED, S.START_FAILED, S.STOPPING, S.IDLE], // IDLE: cancelled before the session record existed
    [S.START_FAILED]: [S.IDLE],
    [S.RECORDING]: [S.DEGRADED, S.INTERRUPTED, S.RECOVERING, S.STOPPING],
    [S.DEGRADED]: [S.RECORDING, S.INTERRUPTED, S.RECOVERING, S.STOPPING],
    [S.INTERRUPTED]: [S.RECORDING, S.DEGRADED, S.RECOVERING, S.STOPPING],
    [S.RECOVERING]: [S.RECORDING, S.DEGRADED, S.INTERRUPTED, S.STOPPING],
    [S.STOPPING]: [S.COMPLETED, S.FINALIZE_FAILED],
    [S.COMPLETED]: [S.IDLE],
    [S.FINALIZE_FAILED]: [S.IDLE],
});

export const ACTIVE = Object.freeze([S.STARTING, ...HEALTH]);
export const isActive = (s) => ACTIVE.includes(s);

export class IllegalTransition extends Error {
    constructor(from, to) { super(`illegal session transition ${from} → ${to}`); this.name = 'IllegalTransition'; this.from = from; this.to = to; }
}

export class SessionStateMachine {
    constructor({ onChange } = {}) { this.state = S.IDLE; this.onChange = onChange || (() => {}); this.history = []; }
    can(to) { return (TRANSITIONS[this.state] || []).includes(to); }
    to(next, reason = '') {
        if (next === this.state) return false;
        if (!this.can(next)) throw new IllegalTransition(this.state, next);
        const from = this.state;
        this.state = next;
        this.history.push({ from, to: next, reason });
        if (this.history.length > 200) this.history.shift();
        this.onChange(from, next, reason);
        return true;
    }
}

/**
 * Session health derived from per-stream states (stream-health.js):
 *  - every included stream FRESH                          → RECORDING
 *  - none FRESH, some device reconnecting / awaiting data → RECOVERING
 *  - none FRESH and nothing reconnecting                  → INTERRUPTED
 *  - otherwise (some FRESH, some not)                     → DEGRADED
 */
export function deriveHealth(streamStates) {
    const s = streamStates.filter(x => x !== 'REMOVED');
    if (s.length === 0) return S.INTERRUPTED;
    const fresh = s.filter(x => x === 'FRESH' || x === 'IDLE_ON_CHANGE').length;
    if (fresh === s.length) return S.RECORDING;
    if (fresh > 0) return S.DEGRADED;
    return s.some(x => x === 'RECOVERING') ? S.RECOVERING : S.INTERRUPTED;
}
