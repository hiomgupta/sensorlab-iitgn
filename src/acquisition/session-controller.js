/**
 * SessionController: the recording lifecycle.
 *
 * Startup order (each step must succeed before the next):
 *   1. user confirmed (caller)        → start()
 *   2. PREFLIGHT                      runPreflight(): fatal → back to IDLE, no session created
 *   3. STARTING: keep-awake           enable() if requested; a failure is a WARNING, never claimed active
 *   4. session header + device/channel metadata persisted (Recorder.start). Failure → START_FAILED, resources released
 *   5. per-session counters reset     (AcquisitionService._activate)
 *   6. pipeline activated             readings for selected devices now enter the session
 *   7. startup verification           every explicitly required channel must deliver fresh valid data
 *                                     within startupTimeoutMs; optional channels remain tracked
 *   8. RECORDING (or DEGRADED)        only after 7 succeeds. Timeout → session finalised as 'startup_failed',
 *                                     diagnostics kept, START_FAILED (retry or cancel)
 *
 * While recording, a health tick re-evaluates per-stream freshness (stream-health.js), derives the session
 * health state, and records timestamped lifecycle events. Events and state are persisted with the session.
 */
import { SessionStateMachine, SESSION, ACTIVE, deriveHealth } from './session-state.js';
import { StreamHealth, DEFAULT_HEALTH_POLICY, expectedIntervalMs } from './stream-health.js';
import { runPreflight } from './preflight.js';
import { STATES as DEV } from './device-connection.js';

const S = SESSION;
const MAX_EVENTS = 1000;

export const DEFAULT_SESSION_CONFIG = Object.freeze({
    startupTimeoutMs: 8000,     // per-session floor; raised to 5 expected intervals + 2 s for slow streams
    healthIntervalMs: 250,
    timerStallMs: 5000,         // a health tick delayed this long is logged as a lifecycle interruption
    clockJumpMs: 2000,          // wall clock advancing this much more than the monotonic clock (suspected sleep)
});

export class SessionController {
    constructor({ service, keepAwake, clock, storageStatus, config = {}, healthPolicy = {} }) {
        this.service = service;
        this.keepAwake = keepAwake;
        this.clock = clock;
        this.storageStatus = storageStatus || (async () => ({ ready: true }));
        this.cfg = { ...DEFAULT_SESSION_CONFIG, ...config };
        this.healthPolicy = { ...DEFAULT_HEALTH_POLICY, ...healthPolicy };
        this.listeners = new Set();
        this.sm = new SessionStateMachine({ onChange: (from, to, reason) => this._onState(from, to, reason) });
        this._reset();
        this._devState = new Map();
        service.addSink((r) => { if (this.health && this._tracking) this.health.onReading(r, r.hostMs + this.service.timeZeroMs); });
        service.on('device', (e) => this._onDevice(e));
        keepAwake?.onChange?.((st) => { if (ACTIVE.includes(this.sm.state)) { this._event('keep_awake', { state: st.state, reason: st.reason }); this._persist(); } this._emit(); });
    }

    _reset() {
        this.events = [];
        this.eventsDropped = 0;
        this.health = new StreamHealth({ policy: this.healthPolicy });
        this._tracking = false;
        this.sessionId = null;
        this.startup = null;
        this.preflightResult = null;
        this.lastSummary = this.lastSummary ?? null;
        this.failure = null;
        this._cancelRequested = false;
    }

    get state() { return this.sm.state; }
    onChange(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
    _emit() { for (const cb of [...this.listeners]) { try { cb(this); } catch { /* UI isolation */ } } }

    _event(type, detail = {}) {
        const rel = this._tracking ? this.service.relNow() : null;
        const ev = { t: rel, wall: new Date(this.clock.wallNow()).toISOString(), type, ...detail };
        this.events.push(ev);
        if (this.events.length > MAX_EVENTS) { const over = this.events.length - MAX_EVENTS; this.events.splice(0, over); this.eventsDropped += over; } // bounded log; drops are counted, never silent
        return ev;
    }

    _onState(from, to, reason) { this._event('session_state', { from, to, reason }); this._emit(); }

    lifecycle() {
        return {
            state: this.sm.state,
            events: this.events.slice(),
            eventsDropped: this.eventsDropped,
            eventLogLimit: MAX_EVENTS,
            keepAwake: this.keepAwake?.status() ?? { state: 'unavailable', reason: 'no keep-awake implementation' },
            startup: this.startup,
            healthPolicy: this.healthPolicy,
            streams: this.health.list().map(s => ({ deviceId: s.deviceId, channelId: s.channelId, name: s.name, unit: s.unit, state: s.state, lastValid: s.lastValid })),
        };
    }

    _persist() { if (this.service.recording) this.service.recorder?.setLifecycle?.(this.lifecycle()); }

    /** Preview preflight (no state change). Used by the confirmation dialog. */
    async preflight(include, { keepAwake = true } = {}) {
        let storage;
        try {
            storage = await this.storageStatus();
        } catch (e) {
            return {
                ok: false,
                fatal: [{
                    code: 'STORAGE_STATUS_FAILED',
                    message: `Could not check browser storage: ${e?.message || e}. Recording is blocked until storage can be checked.`,
                }],
                warnings: [],
                streams: [],
            };
        }
        return runPreflight({
            service: this.service, include, storage,
            keepAwake: { requested: keepAwake, supported: this.keepAwakeSupported() },
            visible: typeof document === 'undefined' || document.visibilityState !== 'hidden',
        });
    }

    keepAwakeSupported() { return !!this.keepAwake && this.keepAwake.mechanism !== 'none' && (this.keepAwake.constructor.supported ? this.keepAwake.constructor.supported() : true); }

    /**
     * Run the full startup sequence. Resolves { ok, stage, sessionId?, preflight?, error?, missing? }.
     * Concurrent calls are rejected (no double start).
     */
    start(opts) {
        if (this._startPromise) return Promise.resolve({ ok: false, stage: 'duplicate', error: 'A recording start is already in progress.' });
        if (this.sm.state !== S.IDLE) return Promise.resolve({ ok: false, stage: 'state', error: `Cannot start while ${this.sm.state}.` });
        this._startPromise = this._start(opts).finally(() => { this._startPromise = null; this._emit(); });
        return this._startPromise;
    }

    async _start({ name, group = '', notes = '', include, keepAwake = true }) {
        this._reset();
        this.sm.to(S.PREFLIGHT, 'user confirmed');
        const pf = await this.preflight(include, { keepAwake });
        this.preflightResult = pf;
        this._event('preflight', { fatal: pf.fatal.map(f => f.code), warnings: pf.warnings.map(w => w.code) });
        if (!pf.ok) {
            this.sm.to(S.IDLE, 'preflight failed');
            return { ok: false, stage: 'preflight', preflight: pf };
        }
        if (this._cancelRequested) return this._cancelBeforeSession(false, pf);
        this.sm.to(S.STARTING, 'preflight passed');

        // 3. keep-awake (best effort; failure is a warning)
        if (keepAwake && this.keepAwake) {
            try {
                const st = await this.keepAwake.enable();
                this._event('keep_awake', { state: st.state, reason: st.reason, requested: true });
            } catch (e) {
                this._event('keep_awake', { state: 'failed', reason: e?.message || String(e), requested: true });
            }
        } else this._event('keep_awake', { state: 'not_requested', requested: false });
        if (this._cancelRequested) return this._cancelBeforeSession(true, pf);

        // 4–6. header persisted → counters reset → pipeline active
        const requiredStreams = pf.streams.filter(s => s.requiredForStartup);
        const requiredDevices = [...new Set(requiredStreams.map(s => s.deviceId))];
        const maxInterval = Math.max(0, ...requiredStreams.filter(s => s.expectedIntervalMs !== null).map(s => s.expectedIntervalMs));
        const timeoutMs = Math.max(this.cfg.startupTimeoutMs, 5 * maxInterval + 2000);
        this.startup = {
            requestedStreams: pf.streams.map(s => `${s.deviceId}|${s.channelId}`),
            requiredStreams: requiredStreams.map(s => `${s.deviceId}|${s.channelId}`),
            requiredDevices,
            verifiedStreams: [],
            verifiedDevices: [],
            timeoutMs,
            verifiedAtRelS: null,
            unverifiedOnChange: pf.streams.filter(s => s.expectedIntervalMs === null).map(s => `${s.deviceId}|${s.channelId}`),
        };
        try {
            this.sessionId = await this.service.startRecording({ name, group, notes, include, lifecycle: this.lifecycle() });
        } catch (e) {
            this.failure = { stage: 'header', error: e.message };
            this._event('startup_failed', { stage: 'header', error: e.message });
            await this.keepAwake?.disable();
            this.sm.to(S.START_FAILED, 'session header could not be persisted');
            return { ok: false, stage: 'header', error: e.message };
        }
        const t0 = this.clock.now();
        for (const e of this.service.list()) if (this.service.isRecorded(e) && e.deviceId) this.health.track(e, t0, true);
        this._tracking = true;
        this._event('pipeline_active', { sessionId: this.sessionId, streams: this.startup.requestedStreams.length });
        this._persist();
        this._startTicks();

        // 7. startup verification (a Cancel that arrived while the header was being written cancels it immediately)
        const outcome = this._cancelRequested ? { ok: false, reason: 'cancelled', missing: [] }
            : await new Promise((resolve) => { this._verify = { resolve, deadline: t0 + timeoutMs, requiredStreams: new Set(this.startup.requiredStreams) }; this._tick(); });
        this._verify = null;
        if (outcome.ok) {
            this.startup.verifiedAtRelS = this.service.relNow();
            this._event('startup_verified', { devices: this.startup.verifiedDevices.length, requiredChannels: this.startup.requiredStreams.length });
            this.sm.to(deriveHealth(this.health.included().map(s => s.state)) === S.RECORDING ? S.RECORDING : S.DEGRADED, 'valid acquisition data received on every required channel');
            this._persist();
            return { ok: true, stage: 'recording', sessionId: this.sessionId };
        }
        // timeout or cancel: finalize honestly, keep diagnostics
        const cancelled = outcome.reason === 'cancelled';
        const diag = this.health.included().map(s => ({ stream: s.key, name: s.name, state: s.state, gotValidSample: s.firstValidMs !== null, deviceState: this.service.list().find(e => e.deviceId === s.deviceId)?.conn.state ?? 'removed' }));
        this.failure = { stage: cancelled ? 'cancelled' : 'verification', missing: outcome.missing, diagnostics: diag };
        this._event(cancelled ? 'startup_cancelled' : 'startup_failed', { stage: 'verification', missing: outcome.missing, timeoutMs, diagnostics: diag });
        this._persist();
        this._stopTicks();
        const summary = await this.service.stopRecording({ finalState: cancelled ? 'startup_cancelled' : 'startup_failed' });
        this._tracking = false;
        await this.keepAwake?.disable();
        this.lastSummary = summary;
        if (cancelled) { this.sm.to(S.STOPPING, 'stopped during startup'); this.sm.to(summary?.ok ? S.COMPLETED : S.FINALIZE_FAILED, 'startup cancelled'); }
        else this.sm.to(S.START_FAILED, `no valid samples within ${timeoutMs} ms from: ${outcome.missing.join(', ')}`);
        return { ok: false, stage: cancelled ? 'cancelled' : 'verification', sessionId: this.sessionId, missing: outcome.missing, diagnostics: diag, summary };
    }

    /** Cancel requested before any session record exists: nothing to finalise; release keep-awake, back to IDLE. */
    async _cancelBeforeSession(inStarting, pf) {
        this._event('startup_cancelled', { stage: inStarting ? 'starting' : 'preflight', note: 'cancelled before the session was created' });
        if (inStarting) await this.keepAwake?.disable();
        this.sm.to(S.IDLE, 'cancelled before the session was created');
        return { ok: false, stage: 'cancelled', preflight: pf };
    }

    _startTicks() {
        this._stopTicks();
        this._lastTick = { mono: this.clock.now(), wall: this.clock.wallNow() };
        const loop = () => { this._timer = this.clock.setTimeout(() => { this._tick(); if (this._timer !== null) loop(); }, this.cfg.healthIntervalMs); };
        loop();
    }
    _stopTicks() { if (this._timer) this.clock.clearTimeout(this._timer); this._timer = null; }

    _tick() {
        if (!this._tracking) return;
        const eventsBefore = this.events.length;
        const now = this.clock.now(), wall = this.clock.wallNow();
        if (this._lastTick) {
            const dMono = now - this._lastTick.mono, dWall = wall - this._lastTick.wall;
            if (dMono >= this.cfg.timerStallMs) this._event('lifecycle_gap', { kind: 'timer_stall', monoGapMs: Math.round(dMono), note: 'timers did not run (tab throttled/frozen or system suspended); data in this interval may be missing' });
            else if (dWall - dMono >= this.cfg.clockJumpMs) this._event('lifecycle_gap', { kind: 'wall_clock_jump', wallGapMs: Math.round(dWall), monoGapMs: Math.round(dMono), note: 'suspected system sleep' });
        }
        this._lastTick = { mono: now, wall };
        // track devices added during the recording, and channels discovered later (legacy CSV)
        for (const e of this.service.list()) {
            if (!this.service.isRecorded(e) || !e.deviceId) continue;
            if (e.channels.some(ch => !this.health.has(e.deviceId, ch.channelId))) { this.health.track(e, now, true); this._event('streams_tracked', { deviceId: e.deviceId, channels: e.channels.length }); }
        }
        let changed = false;
        for (const c of this.health.evaluate(now, this.service.list())) {
            changed = true;
            const s = c.stream;
            this._event('stream_state', {
                deviceId: s.deviceId, channelId: s.channelId, name: s.name, from: c.from, to: c.to,
                ageMs: c.ageMs === null ? null : Math.round(c.ageMs), expectedIntervalMs: c.intervalMs,
                lastValid: s.lastValid ? { value: s.lastValid.value, relS: s.lastValid.relS } : null,
            });
        }
        if (this._verify) {
            const verifiedStreams = [...this._verify.requiredStreams].filter(key => {
                const s = this.health.streams.get(key);
                return s?.firstValidMs !== null && s?.state === 'FRESH';
            });
            const verifiedStreamSet = new Set(verifiedStreams);
            const verifiedDevices = this.startup.requiredDevices.filter(deviceId =>
                this.startup.requiredStreams.filter(key => key.startsWith(`${deviceId}|`)).every(key => verifiedStreamSet.has(key)));
            this.startup.verifiedStreams = verifiedStreams;
            this.startup.verifiedDevices = verifiedDevices;
            const missing = [...this._verify.requiredStreams].filter(key => !verifiedStreamSet.has(key));
            if (missing.length === 0) { this._verify.resolve({ ok: true }); return; }
            if (now >= this._verify.deadline) { this._verify.resolve({ ok: false, reason: 'timeout', missing }); return; }
        } else if ([S.RECORDING, S.DEGRADED, S.INTERRUPTED, S.RECOVERING].includes(this.sm.state)) {
            const next = deriveHealth(this.health.included().map(s => s.state));
            if (next !== this.sm.state) { this.sm.to(next, 'stream health changed'); changed = true; }
        }
        // Persist whenever any event was recorded in this tick (e.g. a lifecycle gap), not only on stream changes (defect D29).
        if (changed || this.events.length !== eventsBefore) { this._persist(); this._emit(); }
    }

    _onDevice(e) {
        const prev = this._devState.get(e.handle);
        const cur = e.conn.state;
        if (prev === cur) return;
        this._devState.set(e.handle, cur);
        if (!this._tracking || !this.service.isRecorded(e)) return;
        const base = { deviceId: e.deviceId, name: e.displayName, from: prev ?? null };
        const reconnected = e.conn.counters.reconnects - (e.connBaseline?.reconnects || 0) > 0;
        switch (cur) {
            case DEV.DISCONNECTED: this._event('device_disconnected', { ...base, missingSoFar: e.tracker.snapshot().missing }); break;
            case DEV.BACKOFF: this._event('device_reconnecting', { ...base, attempt: e.conn.detail?.attempt, maxAttempts: e.conn.detail?.maxAttempts, retryInMs: e.conn.detail?.retryInMs }); break;
            case DEV.WAITING_FOR_DATA: if (reconnected) this._event('device_reconnected', { ...base, note: 'link restored; stream counts as RECOVERING until a fresh valid sample arrives' }); break;
            case DEV.STREAMING: this._event('device_streaming', { ...base, afterReconnect: reconnected, gapSamplesSoFar: e.tracker.snapshot().missing }); break;
            case DEV.DEGRADED: this._event('device_degraded', { ...base, detail: e.conn.detail }); break;
            case DEV.DEAD: this._event('device_failed', { ...base, detail: e.conn.detail, action: 'manual Retry or remove the device' }); break;
            case DEV.CLOSED: this.health.markRemoved(e.deviceId); this._event('device_removed', base); break;
            default: break;
        }
        this._persist();
        this._emit();
    }

    noteVisibility(hidden) {
        if (!this._tracking) return;
        this._event(hidden ? 'app_hidden' : 'app_visible', {});
        this._persist();
    }

    noteLifecycle(kind, detail = {}) {
        if (!this._tracking) return;
        this._event('lifecycle', { kind, ...detail });
        this._persist();
    }

    /** Stop and finalize. Idempotent: concurrent/repeated calls share one finalization. */
    stop() {
        if (this._stopPromise) return this._stopPromise;
        if (this._startPromise && (this.sm.state === S.PREFLIGHT || this.sm.state === S.STARTING)) {
            // Cancel during startup. Verification in progress → resolve it now; otherwise the pending step checks the flag
            // as soon as it completes (preflight, keep-awake request or header write), so the recording never starts.
            this._cancelRequested = true;
            if (this._verify) this._verify.resolve({ ok: false, reason: 'cancelled', missing: [] });
            return this._startPromise;
        }
        if (![S.RECORDING, S.DEGRADED, S.INTERRUPTED, S.RECOVERING].includes(this.sm.state)) return Promise.resolve(null);
        this._stopPromise = this._stop().finally(() => { this._stopPromise = null; this._emit(); });
        return this._stopPromise;
    }

    async _stop() {
        this.sm.to(S.STOPPING, 'user stopped');
        this._stopTicks();
        this._event('finalizing', {});
        this._persist();
        let summary;
        try { summary = await this.service.stopRecording({ finalState: 'closed' }); }
        catch (e) { summary = { ok: false, closed: false, lastError: { message: e.message }, unsaved: null }; }
        this._tracking = false;
        await this.keepAwake?.disable();
        this.lastSummary = summary;
        if (summary && summary.ok) this.sm.to(S.COMPLETED, 'all readings persisted, session closed');
        else this.sm.to(S.FINALIZE_FAILED, summary?.lastError?.message || 'finalization incomplete');
        return { ...summary, state: this.sm.state };
    }

    /** Acknowledge a terminal state (COMPLETED / FINALIZE_FAILED / START_FAILED) → IDLE. */
    acknowledge() {
        if ([S.COMPLETED, S.FINALIZE_FAILED, S.START_FAILED].includes(this.sm.state)) this.sm.to(S.IDLE, 'acknowledged');
    }

    /** Stream rows for the UI. */
    streamView(now = this.clock.now()) {
        return this.health.list().map(s => {
            const e = this.service.list().find(x => x.deviceId === s.deviceId);
            const iv = e ? expectedIntervalMs(e, this.healthPolicy) : { ms: null, source: 'removed' };
            return { ...s, ageMs: s.lastValid ? now - s.lastValid.hostMs : null, expectedIntervalMs: iv.ms, intervalSource: iv.source, deviceName: e?.displayName ?? s.deviceId, deviceState: e?.conn.state ?? 'CLOSED', retry: e?.conn.detail ?? null };
        });
    }
}
