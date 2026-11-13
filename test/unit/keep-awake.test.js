import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserWakeLock, NativeKeepAwakeAdapter, UnavailableKeepAwake, createKeepAwake } from '../../src/platform/keep-awake.js';

/** Fake W3C Screen Wake Lock API + document visibility. */
function fakeEnv({ reject = null } = {}) {
    const doc = new EventTarget();
    doc.visibilityState = 'visible';
    const sentinels = [];
    const nav = {
        wakeLock: {
            requests: 0,
            async request(type) {
                nav.wakeLock.requests++;
                assert.equal(type, 'screen');
                if (reject) throw Object.assign(new Error(reject.message), { name: reject.name });
                const s = new EventTarget();
                s.released = false;
                s.release = async () => { if (!s.released) { s.released = true; s.dispatchEvent(new Event('release')); } };
                sentinels.push(s);
                return s;
            },
        },
    };
    const hide = () => { doc.visibilityState = 'hidden'; for (const s of sentinels) if (!s.released) { s.released = true; s.dispatchEvent(new Event('release')); } doc.dispatchEvent(new Event('visibilitychange')); };
    const show = () => { doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')); };
    return { nav, doc, sentinels, hide, show };
}
const flush = () => new Promise(r => setImmediate(r));

test('initial status is not_requested; enable → active; disable releases the lock', async () => {
    const env = fakeEnv();
    const k = new BrowserWakeLock({ nav: env.nav, doc: env.doc });
    assert.equal(k.status().state, 'not_requested');
    assert.equal((await k.enable()).state, 'active');
    assert.equal(env.sentinels.length, 1);
    assert.equal((await k.disable()).state, 'not_requested');
    assert.equal(env.sentinels[0].released, true);
});

test('API absent → unavailable (never claimed active)', async () => {
    const env = fakeEnv();
    const k = new BrowserWakeLock({ nav: {}, doc: env.doc });
    const st = await k.enable();
    assert.equal(st.state, 'unavailable');
    assert.match(st.reason, /not available/);
});

test('request rejected (e.g. NotAllowedError / power saver) → failed with reason', async () => {
    const env = fakeEnv({ reject: { name: 'NotAllowedError', message: 'Wake Lock permission request denied' } });
    const k = new BrowserWakeLock({ nav: env.nav, doc: env.doc });
    const st = await k.enable();
    assert.equal(st.state, 'failed');
    assert.match(st.reason, /NotAllowedError/);
});

test('system release on hide → released (honest), reacquired when visible again while still wanted', async () => {
    const env = fakeEnv();
    const k = new BrowserWakeLock({ nav: env.nav, doc: env.doc });
    const seen = [];
    k.onChange(s => seen.push(s.state));
    await k.enable();
    env.hide();
    await flush();
    assert.equal(k.status().state, 'released');
    env.show();
    await flush();
    assert.equal(k.status().state, 'active');
    assert.equal(env.nav.wakeLock.requests, 2);
    assert.equal(k.reacquisitions, 1);
    assert.deepEqual(seen, ['active', 'released', 'active']);
});

test('no reacquisition after disable (recording ended)', async () => {
    const env = fakeEnv();
    const k = new BrowserWakeLock({ nav: env.nav, doc: env.doc });
    await k.enable();
    await k.disable();
    env.hide(); env.show();
    await flush();
    assert.equal(k.status().state, 'not_requested');
    assert.equal(env.nav.wakeLock.requests, 1);
});

test('enable while hidden does not pretend: released, acquired on visibility', async () => {
    const env = fakeEnv();
    env.doc.visibilityState = 'hidden';
    const k = new BrowserWakeLock({ nav: env.nav, doc: env.doc });
    assert.equal((await k.enable()).state, 'released');
    env.show();
    await flush();
    assert.equal(k.status().state, 'active');
});

test('native adapter interface and selection', async () => {
    const calls = [];
    const n = new NativeKeepAwakeAdapter({ isSupported: async () => true, keepAwake: async () => calls.push('on'), allowSleep: async () => calls.push('off') });
    assert.equal((await n.enable()).state, 'active');
    assert.equal((await n.disable()).state, 'not_requested');
    assert.deepEqual(calls, ['on', 'off']);
    assert.equal((await new NativeKeepAwakeAdapter({ isSupported: async () => false }).enable()).state, 'unavailable');
    assert.equal((await new UnavailableKeepAwake().enable()).state, 'unavailable');
    assert.ok(createKeepAwake({ SensorLabNative: { keepAwake: {} } }) instanceof NativeKeepAwakeAdapter);
    assert.ok(createKeepAwake({}) instanceof UnavailableKeepAwake);
    const env = fakeEnv();
    assert.ok(createKeepAwake({ navigator: env.nav, document: env.doc }) instanceof BrowserWakeLock);
});
