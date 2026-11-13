/**
 * Regression suite: recording startup / shutdown races and cleanup gaps.
 * Real Web Bluetooth driver over the W3C-API mock, real Recorder + IdbRepository (fake-indexeddb), ManualClock.
 * Evidence class: SIMULATED INTEGRATION. Tests marked { todo: 'DEFECT Rn: ...' } reproduce a known defect and are
 * expected to fail until it is fixed.
 */
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../../src/util/clock.js';
import { WebBluetoothTransport } from '../../src/transport/web-bluetooth.js';
import { AcquisitionService } from '../../src/acquisition/acquisition-service.js';
import { SessionController } from '../../src/acquisition/session-controller.js';
import { SESSION } from '../../src/acquisition/session-state.js';
import { IdbRepository } from '../../src/storage/idb-repository.js';
import { Recorder, LOCK_PREFIX } from '../../src/storage/recorder.js';
import { BrowserWakeLock } from '../../src/platform/keep-awake.js';
import { FakePeripheral, installFakeNavigatorBluetooth } from '../helpers/fake-web-bluetooth.js';

// ── harness (copied from session-lifecycle.test.js, plus a fake Web Locks manager) ──
class FakeKeepAwake {
    constructor(result = 'active') { this.result = result; this.mechanism = 'fake'; this.calls = []; this._s = { state: 'not_requested' }; this._cbs = new Set(); }
    onChange(cb) { this._cbs.add(cb); }
    status() { return { ...this._s }; }
    async enable() { this.calls.push('enable'); this._s = { state: this.result, reason: this.result === 'active' ? null : 'denied' }; return this.status(); }
    async disable() { this.calls.push('disable'); this._s = { state: 'not_requested' }; return this.status(); }
}

class FaultyRepo {
    constructor(inner) { this.inner = inner; this.fail = new Set(); }
    _f(op) { if (this.fail.has(op)) { const e = new Error(`${op} failed: QuotaExceededError`); e.causeName = 'QuotaExceededError'; e.quota = true; throw e; } }
    async createSession(s) { this._f('createSession'); return this.inner.createSession(s); }
    async appendChunk(...a) { this._f('appendChunk'); return this.inner.appendChunk(...a); }
    async updateSession(...a) { this._f('updateSession'); return this.inner.updateSession(...a); }
    async putAnnotation(a) { return this.inner.putAnnotation(a); }
    async listSessions() { return this.inner.listSessions(); }
    async readSnapshot(id) { return this.inner.readSnapshot(id); }
    async getSession(id) { return this.inner.getSession(id); }
    async recoverSession(...a) { return this.inner.recoverSession(...a); }
}

/** Minimal Web Locks: exclusive, tracks what is held. */
class FakeLocks {
    constructor() { this.held = new Set(); }
    request(name, _opts, cb) {
        if (this.held.has(name)) return Promise.reject(new Error('lock already held: ' + name));
        this.held.add(name);
        return Promise.resolve().then(cb).finally(() => this.held.delete(name));
    }
    async query() { return { held: [...this.held].map(name => ({ name })) }; }
}

let n = 0;
async function rig({ peripherals = [{}], keepAwake = 'active', storage = { ready: true }, config = {} } = {}) {
    const clock = new ManualClock({ seed: 7 });
    const inner = new IdbRepository({ dbName: 'races-' + (++n) });
    const repo = new FaultyRepo(inner);
    const locks = new FakeLocks();
    let id = 0;
    const recorder = new Recorder({ repo, clock, locks, newId: () => `R${n}-${++id}`, persist: async () => null });
    const service = new AcquisitionService({ clock });
    service.recorder = recorder;
    const ka = new FakeKeepAwake(keepAwake);
    const ctl = new SessionController({ service, keepAwake: ka, clock, storageStatus: async () => storage, config });
    const ps = peripherals.map((o, i) => new FakePeripheral({ clock, id: `Q${i}`, serial: `RACE${i}`, ...o }));
    installFakeNavigatorBluetooth(ps);
    const t = new WebBluetoothTransport({ clock });
    const entries = [];
    for (let i = 0; i < ps.length; i++) entries.push(service.addDevice(await t.requestDevice({}), { kind: 'sltp' }));
    await clock.advance(300);
    return { clock, inner, repo, locks, recorder, service, ka, ctl, ps, entries, all: entries.map(e => e.handle) };
}

/** advance until promise settles (ManualClock drives all timers) */
async function run(clock, p, stepMs = 100, maxMs = 60_000) {
    let done = false, val, err;
    p.then(v => { done = true; val = v; }, e => { done = true; err = e; });
    for (let t = 0; t < maxMs && !done; t += stepMs) await clock.advance(stepMs);
    if (err) throw err;
    assert.ok(done, 'operation did not settle');
    return val;
}

const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };
const types = (ctl) => ctl.events.map(e => e.type);

/**
 * After an outcome has been acknowledged: no leaked controller/recorder/service state, no ticking health timer,
 * no held recorder lock, keep-awake not active; then a fresh start → RECORDING → Stop → COMPLETED works.
 */
async function assertCleanAndRestartable(r, label, { keepAwake = true } = {}) {
    const { ctl, service, recorder, locks, clock, ka } = r;
    ctl.acknowledge();
    assert.equal(ctl.state, SESSION.IDLE, `${label}: back to IDLE`);
    assert.equal(ctl._startPromise, null, `${label}: no start in progress`);
    assert.equal(ctl._stopPromise ?? null, null, `${label}: no stop in progress`);
    assert.equal(ctl._verify ?? null, null, `${label}: no pending verification`);
    assert.equal(ctl._timer ?? null, null, `${label}: health timer stopped`);
    assert.equal(ctl._tracking, false, `${label}: not tracking`);
    assert.equal(service.recording, false, `${label}: service not recording`);
    assert.ok(!service._starting, `${label}: service not starting`);
    assert.equal(recorder.state, 'idle', `${label}: recorder idle`);
    assert.equal(recorder._timer, null, `${label}: recorder flush timer stopped`);
    assert.deepEqual([...locks.held].filter(x => x.startsWith(LOCK_PREFIX)), [], `${label}: recorder lock released`);
    assert.notEqual(ka.status().state, 'active', `${label}: keep-awake not left active`);
    // the health tick must not run any more
    let ticks = 0;
    const orig = ctl._tick.bind(ctl);
    ctl._tick = () => { ticks++; return orig(); };
    await clock.advance(2000);
    ctl._tick = orig;
    assert.equal(ticks, 0, `${label}: health tick kept running after the outcome (timer leak)`);
    // a subsequent start succeeds cleanly
    const res = await run(clock, ctl.start({ name: "after " + label, include: r.all, keepAwake }));
    assert.equal(res.ok, true, `${label}: subsequent start succeeds: ${JSON.stringify({ stage: res.stage, error: res.error, fatal: res.preflight?.fatal })}`);
    assert.ok([SESSION.RECORDING, SESSION.DEGRADED].includes(ctl.state));
    assert.ok(locks.held.has(LOCK_PREFIX + res.sessionId), `${label}: new session holds its lock`);
    await clock.advance(500);
    const sum = await run(clock, ctl.stop());
    assert.equal(sum.ok, true, `${label}: subsequent stop finalizes`);
    assert.equal(ctl.state, SESSION.COMPLETED);
    assert.equal(ctl._timer ?? null, null);
    assert.deepEqual([...locks.held].filter(x => x.startsWith(LOCK_PREFIX)), []);
    ctl.acknowledge();
}

// ── (a)(b)(d)(e)(f) every failure / cancel path, with keep-awake ticked and unticked ───────────────────────
// Each scenario drives one path and returns the start outcome; `heal` removes the injected fault afterwards.
const SCENARIOS = [
    {
        name: 'preflight fatal (storage unavailable)', reachesKeepAwake: false,
        rig: { storage: { ready: false, error: 'blocked' } },
        async drive(r, o) { return run(r.clock, r.ctl.start(o)); },
        expect: { stage: 'preflight', sessions: 0 },
        heal(r) { r.ctl.storageStatus = async () => ({ ready: true }); },
    },
    {
        name: 'Cancel during PREFLIGHT', reachesKeepAwake: false,
        async drive(r, o) {
            const g = gate(); r.ctl.storageStatus = async () => { await g.p; return { ready: true }; };
            const p = r.ctl.start(o); await r.clock.advance(10);
            assert.equal(r.ctl.state, SESSION.PREFLIGHT);
            r.ctl.stop(); r.ctl.stop(); // repeated Cancel
            g.open(); return run(r.clock, p);
        },
        expect: { stage: 'cancelled', sessions: 0 },
        heal(r) { r.ctl.storageStatus = async () => ({ ready: true }); },
    },
    {
        name: 'Cancel during keep-awake request', reachesKeepAwake: true, onlyKeepAwake: true,
        async drive(r, o) {
            const g = gate(); const en = r.ka.enable.bind(r.ka);
            r.ka.enable = async () => { await g.p; return en(); };
            const p = r.ctl.start(o); await r.clock.advance(10);
            assert.equal(r.ctl.state, SESSION.STARTING);
            r.ctl.stop();
            g.open(); const res = await run(r.clock, p);
            r.ka.enable = en; return res;
        },
        expect: { stage: 'cancelled', sessions: 0 },
    },
    {
        name: 'Cancel during session-header write', reachesKeepAwake: true,
        async drive(r, o) {
            const g = gate(); const create = r.repo.createSession.bind(r.repo);
            r.repo.createSession = async (s) => { await g.p; return create(s); };
            const p = r.ctl.start(o); await r.clock.advance(10);
            assert.equal(r.ctl.state, SESSION.STARTING);
            r.ctl.stop();
            g.open(); const res = await run(r.clock, p);
            r.repo.createSession = create; return res;
        },
        expect: { stage: 'cancelled', sessions: 1, sessionState: 'startup_cancelled', ctlState: SESSION.COMPLETED },
    },
    {
        name: 'session-header write failure', reachesKeepAwake: true,
        async drive(r, o) { r.repo.fail.add('createSession'); return run(r.clock, r.ctl.start(o)); },
        expect: { stage: 'header', sessions: 0, ctlState: SESSION.START_FAILED },
        heal(r) { r.repo.fail.delete('createSession'); },
    },
    {
        // (d) Cancel arrives while the header write is pending, then the write rejects: header failure wins
        name: 'Cancel while the session-header write rejects', reachesKeepAwake: true,
        async drive(r, o) {
            const g = gate(); const create = r.repo.createSession.bind(r.repo);
            r.repo.createSession = async () => { await g.p; throw new Error('createSession failed: QuotaExceededError'); };
            const p = r.ctl.start(o); await r.clock.advance(10);
            r.ctl.stop();
            g.open(); const res = await run(r.clock, p);
            r.repo.createSession = create; return res;
        },
        expect: { stage: 'header', sessions: 0, ctlState: SESSION.START_FAILED },
    },
    {
        name: 'startup verification timeout', reachesKeepAwake: true,
        rig: { config: { startupTimeoutMs: 3000 } },
        async drive(r, o) { r.ps[0].silent = true; return run(r.clock, r.ctl.start(o)); },
        expect: { stage: 'verification', sessions: 1, sessionState: 'startup_failed', ctlState: SESSION.START_FAILED },
        heal(r) { r.ps[0].silent = false; },
    },
    {
        name: 'Cancel during startup verification', reachesKeepAwake: true,
        async drive(r, o) {
            r.ps[0].silent = true;
            const p = r.ctl.start(o); await r.clock.advance(600);
            assert.ok(r.ctl._verify, 'verification pending');
            r.ctl.stop(); r.ctl.stop();
            return run(r.clock, p);
        },
        expect: { stage: 'cancelled', sessions: 1, sessionState: 'startup_cancelled', ctlState: SESSION.COMPLETED },
        heal(r) { r.ps[0].silent = false; },
    },
    {
        name: 'Cancel during verification + finalization write fails', reachesKeepAwake: true,
        async drive(r, o) {
            r.ps[0].silent = true;
            const p = r.ctl.start(o); await r.clock.advance(600);
            r.repo.fail.add('updateSession'); r.repo.fail.add('appendChunk');
            r.ctl.stop();
            return run(r.clock, p);
        },
        expect: { stage: 'cancelled', sessions: 1, sessionState: 'open', ctlState: SESSION.FINALIZE_FAILED },
        heal(r) { r.repo.fail.clear(); r.ps[0].silent = false; },
    },
    {
        name: 'Stop with finalization failure', reachesKeepAwake: true,
        async drive(r, o) {
            const res = await run(r.clock, r.ctl.start(o));
            assert.equal(res.ok, true);
            await r.clock.advance(500);
            r.repo.fail.add('updateSession'); r.repo.fail.add('appendChunk');
            const sum = await run(r.clock, r.ctl.stop());
            assert.equal(sum.ok, false);
            return { ...res, stage: 'stopped', summary: sum };
        },
        expect: { stage: 'stopped', sessions: 1, sessionState: 'open', ctlState: SESSION.FINALIZE_FAILED },
        heal(r) { r.repo.fail.clear(); },
    },
    {
        // (f) device lost while preflight is pending → preflight sees it disconnected
        name: 'device disconnect during PREFLIGHT', reachesKeepAwake: false,
        async drive(r, o) {
            const g = gate(); r.ctl.storageStatus = async () => { await g.p; return { ready: true }; };
            const p = r.ctl.start(o); await r.clock.advance(10);
            r.ps[0].failConnects = 1e6; r.ps[0].linkLoss();
            await r.clock.advance(50);
            g.open(); return run(r.clock, p);
        },
        expect: { stage: 'preflight', sessions: 0 },
        async heal(r) { r.ctl.storageStatus = async () => ({ ready: true }); r.ps[0].failConnects = 0; await r.clock.advance(200_000); r.service.retry(r.all[0]); await r.clock.advance(3000); },
    },
    {
        // (f) device lost after preflight passed (during the header write) and never returns → verification timeout
        name: 'device disconnect during STARTING (header write), no reconnect', reachesKeepAwake: true,
        rig: { config: { startupTimeoutMs: 3000 } },
        async drive(r, o) {
            const g = gate(); const create = r.repo.createSession.bind(r.repo);
            r.repo.createSession = async (s) => { await g.p; return create(s); };
            const p = r.ctl.start(o); await r.clock.advance(10);
            assert.equal(r.ctl.state, SESSION.STARTING);
            r.ps[0].failConnects = 1e6; r.ps[0].linkLoss();
            g.open(); const res = await run(r.clock, p);
            r.repo.createSession = create; return res;
        },
        expect: { stage: 'verification', sessions: 1, sessionState: 'startup_failed', ctlState: SESSION.START_FAILED },
        async heal(r) { r.ps[0].failConnects = 0; await r.clock.advance(200_000); r.service.retry(r.all[0]); await r.clock.advance(3000); },
    },
    {
        // (f) device lost during verification but reconnects within the startup window → verified, recording starts
        name: 'device disconnect during verification, reconnects in time', reachesKeepAwake: true,
        async drive(r, o) {
            r.ps[0].silent = true;
            const p = r.ctl.start(o); await r.clock.advance(300);
            r.ps[0].linkLoss(); r.ps[0].silent = false;
            const res = await run(r.clock, p);
            assert.equal(res.ok, true, 'recovers within the startup window');
            assert.ok(types(r.ctl).includes('device_disconnected'));
            const sum = await run(r.clock, r.ctl.stop());
            assert.equal(sum.ok, true);
            return { ...res, stage: 'stopped' };
        },
        expect: { stage: 'stopped', sessions: 1, sessionState: 'closed', ctlState: SESSION.COMPLETED },
    },
];

for (const sc of SCENARIOS) {
    for (const keepAwake of [true, false]) {
        if (sc.onlyKeepAwake && !keepAwake) continue;
        test(`cleanup after "${sc.name}" (keep-awake ${keepAwake ? 'ticked' : 'unticked'}): keep-awake released/never requested, no leaks, restart works`, async () => {
            const r = await rig(sc.rig);
            const o = { name: sc.name, include: r.all, keepAwake };
            const res = await sc.drive(r, o);
            assert.equal(res.stage, sc.expect.stage, JSON.stringify({ stage: res.stage, error: res.error }));
            if (sc.expect.ctlState) assert.equal(r.ctl.state, sc.expect.ctlState);
            else assert.equal(r.ctl.state, SESSION.IDLE);
            const sessions = await r.inner.listSessions();
            assert.equal(sessions.length, sc.expect.sessions, 'sessions created');
            if (sc.expect.sessionState) assert.equal(sessions[0].state, sc.expect.sessionState);
            // no session claims to be a live recording unless finalization honestly failed (left recoverable)
            if (sc.expect.sessionState !== 'open') assert.ok(sessions.every(s => s.state !== 'open'), 'no session left open');
            // keep-awake
            if (!keepAwake) assert.ok(!r.ka.calls.includes('enable'), 'keep-awake never requested when unticked');
            else if (sc.reachesKeepAwake) { assert.equal(r.ka.calls[0], 'enable'); assert.equal(r.ka.calls.at(-1), 'disable', 'keep-awake released'); }
            else assert.deepEqual(r.ka.calls, [], 'keep-awake not requested before preflight passed');
            assert.notEqual(r.ka.status().state, 'active');
            await sc.heal?.(r);
            r.ka.calls.length = 0;
            await assertCleanAndRestartable(r, sc.name, { keepAwake });
            if (!keepAwake) assert.ok(!r.ka.calls.includes('enable'));
        });
    }
}

// ── (b) second start while a cancelled start is still unwinding ─────────────────────────────────────────
test('a second start() while a cancelled start is unwinding is rejected as duplicate (also from a synchronous state listener)', async () => {
    const r = await rig();
    const gEn = gate(), gDis = gate();
    const en = r.ka.enable.bind(r.ka), dis = r.ka.disable.bind(r.ka);
    r.ka.enable = async () => { await gEn.p; return en(); };
    r.ka.disable = async () => { await gDis.p; return dis(); };
    const p = r.ctl.start({ name: 'first', include: r.all });
    await r.clock.advance(10);
    r.ctl.stop();
    gEn.open();
    await r.clock.advance(10); // now unwinding: awaiting keep-awake release, still STARTING
    assert.equal(r.ctl.state, SESSION.STARTING);
    assert.equal((await r.ctl.start({ name: 'second', include: r.all })).stage, 'duplicate');
    assert.equal(r.ctl.stop(), p, 'Cancel again returns the same start promise');
    // a listener that restarts on the IDLE transition must not get a second start accepted mid-unwind
    const inListener = [];
    const off = r.ctl.onChange((c) => { if (c.state === SESSION.IDLE && inListener.length === 0) inListener.push(c.start({ name: 'listener', include: r.all })); });
    gDis.open();
    const res = await run(r.clock, p);
    off();
    r.ka.enable = en; r.ka.disable = dis;
    assert.equal(res.stage, 'cancelled');
    assert.equal((await inListener[0]).stage, 'duplicate');
    assert.equal((await r.inner.listSessions()).length, 0);
    await assertCleanAndRestartable(r, 'unwinding duplicate');
});

// ── (c) Stop twice / during STOPPING / after COMPLETED / in START_FAILED ───────────────────────────────
test('Stop pressed during STOPPING shares one finalization (one finalizing event, keep-awake released once)', async () => {
    const r = await rig();
    await run(r.clock, r.ctl.start({ name: 'stopping', include: r.all }));
    await r.clock.advance(500);
    const g = gate(); const upd = r.repo.updateSession.bind(r.repo);
    let closing = 0;
    r.repo.updateSession = async (id, patch) => { if (patch.state) { closing++; await g.p; } return upd(id, patch); };
    const a = r.ctl.stop();
    await r.clock.advance(300);
    assert.equal(r.ctl.state, SESSION.STOPPING);
    const b = r.ctl.stop(), c = r.ctl.stop();
    assert.equal(a, b); assert.equal(b, c);
    assert.equal((await r.ctl.start({ name: 'x', include: r.all })).stage, 'state', 'start rejected while STOPPING');
    g.open();
    const sum = await run(r.clock, a);
    r.repo.updateSession = upd;
    assert.equal(sum.ok, true);
    assert.equal(closing, 1, 'session closed once');
    assert.equal(types(r.ctl).filter(t => t === 'finalizing').length, 1);
    assert.deepEqual(r.ka.calls, ['enable', 'disable']);
    assert.equal(await r.ctl.stop(), null, 'Stop after COMPLETED is a no-op');
    assert.equal((await r.ctl.start({ name: 'x', include: r.all })).stage, 'state', 'start requires acknowledge after COMPLETED');
    assert.equal(r.ctl.state, SESSION.COMPLETED);
    await assertCleanAndRestartable(r, 'stop during STOPPING');
});

test('Stop in START_FAILED is a no-op; acknowledge outside terminal states is a no-op', async () => {
    const r = await rig({ config: { startupTimeoutMs: 3000 } });
    r.ctl.acknowledge(); // IDLE: no-op, no throw
    r.ps[0].silent = true;
    await run(r.clock, r.ctl.start({ name: 'sf', include: r.all }));
    assert.equal(r.ctl.state, SESSION.START_FAILED);
    assert.equal(await r.ctl.stop(), null);
    assert.equal((await r.ctl.start({ name: 'x', include: r.all })).stage, 'state');
    r.ps[0].silent = false;
    r.ctl.acknowledge();
    const res = await run(r.clock, r.ctl.start({ name: 'ok', include: r.all }));
    assert.equal(res.ok, true);
    r.ctl.acknowledge(); // RECORDING: no-op
    assert.ok([SESSION.RECORDING, SESSION.DEGRADED].includes(r.ctl.state));
    await run(r.clock, r.ctl.stop());
});

test('Stop pressed while a verification-timeout is being finalized: one outcome, START_FAILED, nothing open', async () => {
    const r = await rig({ config: { startupTimeoutMs: 3000 } });
    r.ps[0].silent = true;
    const g = gate(); const upd = r.repo.updateSession.bind(r.repo);
    r.repo.updateSession = async (id, patch) => { if (patch.state) await g.p; return upd(id, patch); };
    const p = r.ctl.start({ name: 'late cancel', include: r.all });
    await r.clock.advance(3500); // timed out; finalization blocked on the close write
    assert.equal(r.ctl.state, SESSION.STARTING);
    assert.equal(r.ctl._verify, null);
    const sp = r.ctl.stop();
    g.open();
    const [res, viaStop] = [await run(r.clock, p), await sp];
    r.repo.updateSession = upd;
    assert.equal(res.stage, 'verification');
    assert.deepEqual(viaStop, res, 'Stop returns the same start outcome');
    assert.equal(r.ctl.state, SESSION.START_FAILED);
    assert.equal((await r.inner.getSession(res.sessionId)).state, 'startup_failed');
    assert.deepEqual(r.ka.calls, ['enable', 'disable']);
    r.ps[0].silent = false;
    await assertCleanAndRestartable(r, 'stop during timeout finalization');
});

// ── keep-awake implementation: overlapping acquisitions ─────────────────────────────────────────────────
function wakeEnv() {
    const doc = new EventTarget(); doc.visibilityState = 'visible';
    const pending = [], sentinels = [];
    const nav = { wakeLock: { request() {
        return new Promise((resolve) => pending.push(() => {
            const s = new EventTarget(); s.released = false;
            s.release = async () => { if (!s.released) { s.released = true; s.dispatchEvent(new Event('release')); } };
            sentinels.push(s); resolve(s);
        }));
    } } };
    return { doc, nav, pending, sentinels };
}
const settle = () => new Promise(r => setImmediate(r));

test('BrowserWakeLock: disable() while a request is pending releases the late sentinel', async () => {
    const env = wakeEnv();
    const k = new BrowserWakeLock({ nav: env.nav, doc: env.doc });
    const p = k.enable();
    await settle();
    await k.disable();
    env.pending.shift()();
    await p; await settle();
    assert.equal(env.sentinels.length, 1);
    assert.equal(env.sentinels[0].released, true);
    assert.notEqual(k.status().state, 'active');
});

// Regression for defect R2 (fixed in keep-awake.js _acquire): before the fix this failed with
// "1 of 2 wake lock sentinel(s) still held after disable()".
test('BrowserWakeLock: overlapping acquisitions (enable + visibility reacquire) leave no wake lock held after disable()',
    async () => {
        const env = wakeEnv();
        const k = new BrowserWakeLock({ nav: env.nav, doc: env.doc });
        const p = k.enable();                                   // request #1 in flight (recording start)
        await settle();
        env.doc.dispatchEvent(new Event('visibilitychange'));   // page returns to the foreground meanwhile → request #2
        await settle();
        while (env.pending.length) { env.pending.shift()(); await settle(); }
        await p;
        await k.disable();                                      // recording stopped
        assert.deepEqual(env.sentinels.map(s => s.released), env.sentinels.map(() => true),
            `${env.sentinels.filter(s => !s.released).length} of ${env.sentinels.length} wake lock sentinel(s) still held after disable()`);
    });

// ── documented contract: start() resolves an outcome; a throwing dependency must not wedge the controller ──
test('start() resolves with a structured preflight error when storage status throws and can retry',
    async () => {
        const r = await rig();
        r.ctl.storageStatus = async () => { throw new Error('storage estimate exploded'); };
        let res, err;
        try { res = await run(r.clock, r.ctl.start({ name: 'throw-pf', include: r.all })); } catch (e) { err = e; }
        assert.equal(err, undefined, 'start() should resolve { ok:false }, not reject: ' + err?.message);
        assert.equal(res.ok, false);
        assert.equal(res.stage, 'preflight');
        assert.ok(res.preflight.fatal.some(f => f.code === 'STORAGE_STATUS_FAILED' && /storage estimate exploded/.test(f.message)));
        assert.equal(r.ctl.state, SESSION.IDLE, 'not stuck in PREFLIGHT');
        assert.equal((await r.inner.listSessions()).length, 0, 'preflight failure must not create a session');

        r.ctl.acknowledge();
        r.ctl.storageStatus = async () => ({ ready: true });
        const retry = await run(r.clock, r.ctl.start({ name: 'retry-after-storage-error', include: r.all }));
        assert.equal(retry.ok, true, 'recording can start after storage status recovers');
        assert.equal(r.ctl.state, SESSION.RECORDING);

        const r2 = await rig();
        r2.ka.enable = async () => { throw new Error('wake lock bridge crashed'); };
        let res2, err2;
        try { res2 = await run(r2.clock, r2.ctl.start({ name: 'throw-ka', include: r2.all })); } catch (e) { err2 = e; }
        assert.equal(err2, undefined, 'start() should resolve, not reject: ' + err2?.message);
        assert.equal(res2.ok, true, 'best-effort wake lock failure does not block recording');
        assert.equal(r2.ctl.state, SESSION.RECORDING);
        assert.ok(r2.ctl.events.some(e => e.type === 'keep_awake' && e.state === 'failed' && /wake lock bridge crashed/.test(e.reason)));
    });
