/**
 * Keep-awake abstraction. The UI and the session controller depend only on this interface:
 *
 *   enable(): Promise<status>   request keep-awake (idempotent)
 *   disable(): Promise<status>  release it and stop reacquiring
 *   status(): { state, reason, since, mechanism }
 *       state ∈ 'not_requested' | 'active' | 'unavailable' | 'failed' | 'released'
 *   onChange(cb)
 *
 * Keep-awake is BEST EFFORT. An active screen wake lock prevents the screen from dimming or locking while the
 * page is visible. It does NOT keep the page running when hidden, minimised, or when the OS suspends the browser.
 *
 * Implementations:
 *  - BrowserWakeLock: W3C Screen Wake Lock API (navigator.wakeLock). It handles absence, rejection,
 *    system release (e.g. tab hidden, battery saver) and reacquisition when the page becomes visible again.
 *  - NativeKeepAwakeAdapter: bridge interface for an installed Android/iOS app. No native project exists
 *    in this repository, so createKeepAwake() never selects it; see docs/PLATFORM_COMPATIBILITY.md.
 */

export class BrowserWakeLock {
    constructor({ nav = globalThis.navigator, doc = globalThis.document, now = () => Date.now() } = {}) {
        this.nav = nav; this.doc = doc; this.now = now;
        this.mechanism = 'screen-wake-lock-api';
        this.wanted = false;
        this.sentinel = null;
        this._s = { state: 'not_requested', reason: null, since: now() };
        this._cbs = new Set();
        this._onVis = () => this._visibilityChanged();
        this.doc?.addEventListener?.('visibilitychange', this._onVis);
        this.reacquisitions = 0;
    }

    static supported(nav = globalThis.navigator) { return !!(nav && nav.wakeLock && typeof nav.wakeLock.request === 'function'); }

    onChange(cb) { this._cbs.add(cb); return () => this._cbs.delete(cb); }
    status() { return { ...this._s, mechanism: this.mechanism }; }
    _set(state, reason = null) {
        if (state === this._s.state && reason === this._s.reason) return;
        this._s = { state, reason, since: this.now() };
        for (const cb of [...this._cbs]) { try { cb(this.status()); } catch { /* isolate */ } }
    }

    async enable() {
        this.wanted = true;
        return this._acquire('requested');
    }

    async _acquire(why) {
        if (!BrowserWakeLock.supported(this.nav)) { this._set('unavailable', 'Screen Wake Lock API not available in this browser'); return this.status(); }
        if (this.sentinel && !this.sentinel.released) { this._set('active', why); return this.status(); }
        if (this.doc && this.doc.visibilityState && this.doc.visibilityState !== 'visible') {
            this._set('released', 'page hidden; will retry when visible');
            return this.status();
        }
        try {
            const s = await this.nav.wakeLock.request('screen');
            if (!this.wanted) { try { await s.release(); } catch { /* ignore */ } return this.status(); }
            // Two acquisitions can overlap (enable() and a visibility re-acquire while the first request is pending).
            // Keep exactly one sentinel: a late duplicate is released, never stored over the held one (defect R2).
            if (this.sentinel && !this.sentinel.released) { try { await s.release(); } catch { /* ignore */ } this._set('active', why); return this.status(); }
            this.sentinel = s;
            s.addEventListener?.('release', () => {
                if (this.sentinel !== s) return;
                this.sentinel = null;
                if (this.wanted) this._set('released', 'released by the browser/OS (e.g. page hidden or power saving); will retry when visible');
            });
            this._set('active', why);
        } catch (e) {
            this._set('failed', `${e?.name || 'Error'}: ${e?.message || e}`);
        }
        return this.status();
    }

    _visibilityChanged() {
        if (!this.wanted || !this.doc || this.doc.visibilityState !== 'visible') return;
        if (this.sentinel && !this.sentinel.released) return;
        this.reacquisitions++;
        this._acquire('reacquired after page became visible');
    }

    async disable() {
        this.wanted = false;
        const s = this.sentinel;
        this.sentinel = null;
        if (s && !s.released) { try { await s.release(); } catch { /* already released */ } }
        this._set('not_requested', 'keep-awake not requested');
        return this.status();
    }

    dispose() { this.doc?.removeEventListener?.('visibilitychange', this._onVis); }
}

/**
 * Bridge for a future installed mobile app (Capacitor/Cordova plugin, or a native shell).
 * `bridge` must provide: keepAwake(): Promise<void>, allowSleep(): Promise<void>, isSupported(): Promise<boolean>.
 * On Android this would typically set FLAG_KEEP_SCREEN_ON on the activity window; on iOS,
 * UIApplication.shared.isIdleTimerDisabled = true. Neither keeps BLE alive in the background. Background
 * acquisition needs a foreground service (Android) or a bluetooth-central background mode (iOS), which are
 * separate native work. NOT IMPLEMENTED in this repository: there is no native project.
 */
export class NativeKeepAwakeAdapter {
    constructor(bridge, { now = () => Date.now() } = {}) {
        this.bridge = bridge; this.now = now; this.mechanism = 'native-bridge';
        this._s = { state: 'not_requested', reason: null, since: now() }; this._cbs = new Set();
    }
    onChange(cb) { this._cbs.add(cb); return () => this._cbs.delete(cb); }
    status() { return { ...this._s, mechanism: this.mechanism }; }
    _set(state, reason) { this._s = { state, reason, since: this.now() }; for (const cb of [...this._cbs]) { try { cb(this.status()); } catch { /* isolate */ } } }
    async enable() {
        try {
            if (!(await this.bridge.isSupported())) { this._set('unavailable', 'native keep-awake not supported'); return this.status(); }
            await this.bridge.keepAwake();
            this._set('active', 'native');
        } catch (e) { this._set('failed', String(e?.message || e)); }
        return this.status();
    }
    async disable() { try { await this.bridge.allowSleep(); } catch { /* ignore */ } this._set('not_requested', null); return this.status(); }
    dispose() {}
}

/** Keep-awake that is explicitly unavailable (non-browser contexts, tests). */
export class UnavailableKeepAwake {
    constructor(reason = 'no keep-awake mechanism on this platform') { this.reason = reason; this.mechanism = 'none'; this._s = { state: 'not_requested', reason: null, since: Date.now() }; this._cbs = new Set(); }
    onChange(cb) { this._cbs.add(cb); return () => this._cbs.delete(cb); }
    status() { return { ...this._s, mechanism: this.mechanism }; }
    async enable() { this._s = { state: 'unavailable', reason: this.reason, since: Date.now() }; for (const cb of this._cbs) cb(this.status()); return this.status(); }
    async disable() { this._s = { state: 'not_requested', reason: null, since: Date.now() }; for (const cb of this._cbs) cb(this.status()); return this.status(); }
    dispose() {}
}

/** Choose the keep-awake implementation for the current runtime. */
export function createKeepAwake(env = globalThis) {
    if (env.SensorLabNative?.keepAwake) return new NativeKeepAwakeAdapter(env.SensorLabNative.keepAwake);
    if (env.navigator && env.document) return new BrowserWakeLock({ nav: env.navigator, doc: env.document });
    return new UnavailableKeepAwake();
}
