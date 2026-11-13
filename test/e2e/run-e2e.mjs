/**
 * End-to-end tests of the BUILT app (dist/) in real Chrome/Edge (headless), using demo-mode
 * SIMULATED devices. Evidence class: SIMULATED INTEGRATION. No physical BLE is involved.
 *
 * Usage: npm run build && npm run test:e2e      (CHROME_PATH=... to choose the browser)
 * Writes test/e2e/results.json.
 */
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseCsv, CSV_COLUMNS } from '../../src/export/export.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'dist');
if (!existsSync(path.join(dist, 'index.html'))) { console.error('dist/ missing: run npm run build'); process.exit(2); }
const CHROME = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => existsSync(p));
if (!CHROME) { console.error('NOT RUN: no Chrome/Edge found (set CHROME_PATH)'); process.exit(2); }

const results = { browser: null, chromePath: CHROME, startedAt: new Date().toISOString(), checks: [], measurements: {} };
let failures = 0;
function check(name, ok, detail = '') {
    results.checks.push({ name, ok: !!ok, detail: String(detail) });
    if (!ok) failures++;
    console.log(`${ok ? '  ✔' : '  ✖'} ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 15000, step = 100) {
    const t0 = Date.now();
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); }
}

// ── static server (127.0.0.1 only) ──
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.md': 'text/plain', '.txt': 'text/plain' };
const server = http.createServer(async (req, res) => {
    let p = path.join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if ((await stat(p).catch(() => null))?.isDirectory()) p = path.join(p, 'index.html');
    try { res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-cache' }); res.end(await readFile(p)); }
    catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const HTTP_URL = `http://127.0.0.1:${PORT}/index.html`;
const FILE_URL = pathToFileURL(path.join(dist, 'index.html')).href;

const profileDir = mkdtempSync(path.join(tmpdir(), 'sl-e2e-profile-'));
const dlDir = mkdtempSync(path.join(tmpdir(), 'sl-e2e-dl-'));

async function launch() {
    const b = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profileDir, args: ['--no-first-run', '--no-default-browser-check'] });
    results.browser = await b.version();
    const cdp = await b.target().createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: true });
    return b;
}

/** Attach console/error/network auditing to a page. */
function audit(page, allowedPrefixes) {
    const a = { remote: [], errors: [], requests: 0 };
    page.on('request', (r) => {
        a.requests++;
        const u = r.url();
        if (!allowedPrefixes.some(p => u.startsWith(p))) a.remote.push(u);
    });
    page.on('pageerror', (e) => a.errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') a.errors.push('console: ' + m.text()); });
    return a;
}

async function setOffline(page, offline) {
    const c = await page.createCDPSession();
    await c.send('Network.enable');
    await c.send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
}

const st = (page, js, ...args) => page.evaluate(js, ...args);

async function startDemo(page, n, rate, faults = {}) {
    await page.click('#demoBtn');
    await page.$eval('#demoCount', (el, v) => { el.value = v; }, String(n));
    await page.$eval('#demoRate', (el, v) => { el.value = v; }, String(rate));
    for (const [id, on] of Object.entries(faults)) await page.$eval('#' + id, (el, v) => { el.checked = v; }, on);
    await page.click('#demoForm button[type=submit]');
    return waitFor(() => st(page, () => window.__sensorlab.service.list().filter(e => e.simulated && e.conn.state === 'STREAMING').length), 15000)
        .then(() => st(page, () => window.__sensorlab.service.list().filter(e => e.conn.state === 'STREAMING').length));
}

// Trusted (real input) clicks on Record/Stop: they fail if anything (e.g. a toast) covers the button.
async function startRecording(page, name) {
    await page.click('#recordBtn');
    await page.waitForSelector('#sessionDialog[open]');
    await page.$eval('#sName', (el, v) => { el.value = v; }, name);
    await page.waitForFunction(() => !document.getElementById('sessionStart').disabled, { timeout: 5000 });
    await page.click('#sessionStart');
    // verified start: RECORDING/DEGRADED only after fresh valid samples on every stream
    const ok = await waitFor(() => st(page, () => ['RECORDING', 'DEGRADED'].includes(window.__sensorlab.controller.state)), 15000);
    return ok ? st(page, () => window.__sensorlab.service.sessionId) : null;
}
const sessionCount = (page) => st(page, async () => (await window.__sensorlab.repo.listSessions()).length);

async function newestDownload(ext, sinceMs) {
    return waitFor(() => {
        const f = readdirSync(dlDir).filter(x => x.endsWith(ext) && !x.endsWith('.crdownload')).map(x => path.join(dlDir, x)).filter(p => readFileSync(p).length > 0 && statMtime(p) >= sinceMs);
        return f.length ? f.sort((a, b) => statMtime(b) - statMtime(a))[0] : null;
    }, 15000);
}
function statMtime(p) { try { return statSync(p).mtimeMs; } catch { return 0; } }

// ═════════════════════════════ Scenario 1: file:// with network emulated OFFLINE ═════════════════════════════
console.log(`\nChrome: ${CHROME}`);
let browser = await launch();
console.log(`Browser: ${results.browser}\n\n[1] file:// (no server), network offline`);
{
    const page = await browser.newPage();
    const a = audit(page, ['file://', 'data:', 'blob:']);
    await setOffline(page, true);
    const t0 = Date.now();
    await page.goto(FILE_URL, { waitUntil: 'load' });
    await waitFor(() => st(page, () => !!window.__sensorlab), 10000);
    results.measurements.fileLoadMs = Date.now() - t0;
    check('app boots from file:// with networking disabled', await st(page, () => !!window.__sensorlab && document.getElementById('appVersion').textContent.startsWith('v')));
    check('Web Bluetooth API present on file:// (secure context)', await st(page, () => isSecureContext && !!navigator.bluetooth), 'API presence only, NOT a radio test');
    check('SIMULATED banner hidden with no devices', await st(page, () => document.getElementById('simBanner').hidden));
    check('every [hidden] element is actually not displayed (log panel closed on load)', await st(page, () => [...document.querySelectorAll('[hidden]')].every(e => getComputedStyle(e).display === 'none')));

    await page.click('#installBtn');
    await page.waitForSelector('#installDialog[open]');
    const installGuide = await st(page, () => document.getElementById('installDialog').textContent);
    check('install dialog explains HTTPS and Android Chrome home-screen steps', /HTTPS/i.test(installGuide) && /Add to Home screen/i.test(installGuide) && /Chrome/i.test(installGuide));
    await page.keyboard.press('Escape');

    const promptEvent = await st(page, () => {
        let calls = 0;
        const event = new Event('beforeinstallprompt', { cancelable: true });
        event.prompt = () => { calls++; return Promise.resolve(); };
        event.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
        window.__installPromptCalls = () => calls;
        window.dispatchEvent(event);
        return { prevented: event.defaultPrevented, actionVisible: !document.getElementById('installAction').hidden };
    });
    check('native install option appears when Chrome provides beforeinstallprompt', promptEvent.prevented && promptEvent.actionVisible);
    await page.click('#installBtn');
    await page.click('#installAction');
    const installResult = await waitFor(() => st(page, () => /added to your home screen/i.test(document.getElementById('installStatus').textContent)));
    check('native install action invokes Chrome prompt and reports acceptance', !!installResult && await st(page, () => window.__installPromptCalls() === 1));
    await page.keyboard.press('Escape');

    await page.click('#addDeviceBtn');
    await page.click('#tabProfilesBtn');
    const genericProfile = {
        schema: 'sensorlab-device-profile/1', version: 1, id: 'e2e-profile', name: 'E2E GATT sensor',
        transport: 'web-bluetooth', adapter: 'generic-gatt',
        characteristics: [{ id: 'data', serviceUuid: '0x181a', characteristicUuid: '0x2a6e', mode: 'notify', decoder: 'uint16-le' }],
        channels: [{ channelId: 0, name: 'Value', unit: 'raw', characteristicId: 'data', valueIndex: 0, scale: 1, offset: 0 }],
    };
    await page.$eval('#deviceProfileJson', (el, json) => { el.value = json; }, JSON.stringify(genericProfile));
    await page.click('#saveDeviceProfile');
    const profileSaved = await st(page, () => {
        const profiles = JSON.parse(localStorage.getItem('sensorlab_device_profiles_v1') || '[]');
        return profiles.length === 1 && profiles[0].id === 'e2e-profile';
    });
    check('generic GATT profile validates and persists through the UI', profileSaved);
    await st(page, () => [...document.querySelectorAll('#deviceProfileList button')].find(button => button.textContent === 'Edit JSON')?.click());
    check('saved generic profile can be reopened for JSON editing', await st(page, () => JSON.parse(document.getElementById('deviceProfileJson').value).id === 'e2e-profile'));
    await st(page, () => [...document.querySelectorAll('#deviceProfileList button')].find(button => button.textContent === 'Delete')?.click());
    check('generic profile can be deleted from local storage', await st(page, () => JSON.parse(localStorage.getItem('sensorlab_device_profiles_v1') || '[]').length === 0));
    await page.click('#addDialog .dlg-x');

    const streaming = await startDemo(page, 3, 20);
    check('3 simulated devices reach STREAMING (only after first valid sample)', streaming === 3, `streaming=${streaming}`);
    check('persistent SIMULATED DATA banner shown', await st(page, () => !document.getElementById('simBanner').hidden));

    await st(page, () => {
        const orig = IDBDatabase.prototype.transaction;
        window.__dur = [];
        IDBDatabase.prototype.transaction = function (...a) { const tx = orig.apply(this, a); if (tx.mode === 'readwrite') window.__dur.push(tx.durability); return tx; };
    });
    const sid = await startRecording(page, '=Trial "1", Ω µε');
    check('recording starts after session header is persisted', !!sid);
    await sleep(3000);
    // annotation: capture time at click, type later
    await page.click('#annotateBtn');
    const capturedRel = await st(page, () => (performance.now() - window.__sensorlab.service.timeZeroMs) / 1000);
    await sleep(1500);
    await page.type('#annText', 'added 100 g, "load"');
    await page.click('#annotateForm button[type=submit]');
    // fault: link loss on one device, reconnect
    await st(page, () => [...window.__sensorlab.connectView.sim.devices.values()][0].forceDisconnect());
    const recovered = await waitFor(() => st(page, () => { const e = window.__sensorlab.service.list()[0]; return e.conn.counters.reconnects >= 1 && e.conn.state === 'STREAMING'; }), 15000);
    check('device reconnects automatically after link loss and resumes STREAMING', !!recovered);
    await sleep(1500);
    // Capture tracker counters in the same synchronous turn in which recording stops (no race with arriving samples).
    await st(page, () => {
        const svc = window.__sensorlab.service, orig = svc.stopRecording.bind(svc);
        svc.stopRecording = () => { window.__atStop = svc.list().map(e => ({ id: e.deviceId, s: e.tracker.snapshot(), ch: e.channels.length })); svc.stopRecording = orig; return orig(); };
    });
    await page.click('#recordBtn');
    const before = await waitFor(() => st(page, () => window.__atStop), 5000);
    const sum = await waitFor(() => st(page, () => window.__sensorlab.recorder.lastSummary), 10000);
    check('stop reports every appended reading persisted', sum && sum.ok && sum.unsaved === 0 && sum.persisted === sum.appended, JSON.stringify(sum && { persisted: sum.persisted, appended: sum.appended, unsaved: sum.unsaved }));
    const snapInfo = await st(page, async (id) => {
        const snap = await window.__sensorlab.repo.readSnapshot(id);
        const n = snap.chunks.reduce((a, c) => a + c.n, 0);
        return { n, state: snap.session.state, anns: snap.annotations, quality: snap.session.quality, simulated: snap.session.simulated, corrupt: snap.corruptChunks.length };
    }, sid);
    const expected = before.reduce((a, d) => a + d.s.received * d.ch, 0);
    check('stored readings == received samples × channels (no loss inside the app)', snapInfo.n === expected && snapInfo.n > 500, `stored=${snapInfo.n} expected=${expected}`);
    const dur = await st(page, () => window.__dur);
    check('every storage write transaction uses strict durability (as reported by Chrome)', dur.length > 5 && dur.every(d => d === 'strict'), `${dur.length} write transactions: ${[...new Set(dur)].join(',')}`);
    check('session closed, marked simulated, no corrupt chunks', snapInfo.state === 'closed' && snapInfo.simulated && snapInfo.corrupt === 0);
    const gapDev = before[0].s;
    check('link-loss gap counted for the disconnected device', gapDev.missing > 0 && gapDev.gapCount >= 1, `missing=${gapDev.missing} gaps=${gapDev.gapCount}`);
    check('annotation stored with press time (not completion time)', snapInfo.anns.length === 1 && Math.abs(snapInfo.anns[0].relS - capturedRel) < 0.3, `stored=${snapInfo.anns[0]?.relS?.toFixed(3)} captured≈${capturedRel.toFixed(3)}`);

    // export via the History UI
    await page.click('#historyBtn');
    await page.waitForSelector('#histBody tr');
    const viewBtn = await page.$$('#histBody tr button');
    for (const b of viewBtn) if ((await b.evaluate(x => x.textContent)) === 'View') { await b.click(); break; }
    await page.waitForSelector('#histDetail:not([hidden])');
    const histNote = await waitFor(() => st(page, () => document.getElementById('detailChartNote').textContent || null), 10000);
    check('history view reports the true stored-reading count (gap markers not counted)', histNote && histNote.includes(`from ${snapInfo.n} stored readings`), histNote);
    const tCsv = Date.now();
    await page.click('#exCsv');
    const csvPath = await newestDownload('.csv', tCsv - 2000);
    check('CSV export downloaded offline', !!csvPath, csvPath ? path.basename(csvPath) : 'none');
    if (csvPath) {
        const text = readFileSync(csvPath, 'utf8');
        const rows = parseCsv(text);
        check('CSV header matches schema sensorlab-csv/1', JSON.stringify(rows[0]) === JSON.stringify(CSV_COLUMNS));
        check('CSV has exactly one row per stored reading', rows.length - 1 === snapInfo.n, `rows=${rows.length - 1}`);
        const units = new Set(rows.slice(1).map(r => r[11]));
        check('Unicode units preserved in CSV', units.has('µε') && units.has('°C'), [...units].join(' '));
        check('CSV marks simulated readings', rows.slice(1).every(r => r[13].includes('simulated')));
        check('filename sanitized', !/[="]/.test(path.basename(csvPath)), path.basename(csvPath));
    }
    const tJson = Date.now();
    await page.click('#exJson');
    const jsonPath = await newestDownload('.json', tJson - 2000);
    if (jsonPath) {
        const o = JSON.parse(readFileSync(jsonPath, 'utf8'));
        check('JSON export: schema, readings and annotations complete', o.schema === 'sensorlab-export/1' && o.readings.rows.length === snapInfo.n && o.annotations[0].text === 'added 100 g, "load"' && o.session.name === '=Trial "1", Ω µε');
    } else check('JSON export downloaded', false);
    const tZip = Date.now();
    await page.click('#exZip');
    const zipPath = await newestDownload('.zip', tZip - 2000);
    let zipOk = false, zipDetail = 'not downloaded';
    if (zipPath) {
        try {
            const py = ['python', 'py', 'python3'].find(c => { try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } });
            zipDetail = execFileSync(py, ['-I', '-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(",".join(sorted(z.namelist())))', zipPath]).toString().trim();
            zipOk = zipDetail === 'annotations.csv,metadata.json,readings.csv';
        } catch (e) { zipDetail = e.message; }
    }
    check('ZIP bundle valid (independent python zipfile check)', zipOk, zipDetail);
    await page.keyboard.press('Escape');
    check('Escape closes the dialog', await st(page, () => !document.getElementById('historyDialog').open));

    // XSS: hostile device name rendered as text
    await st(page, () => {
        const sim = window.__sensorlab.connectView.sim;
        const d = sim.addDevice({ serial: 'XSS1', name: '<img src=x onerror="window.__pwned=1">', periodUs: 100000, channels: [{ name: '<b>c</b>', unit: '<i>u</i>', scale: 1, offset: 0, signal: { type: 'constant', offset: 1 } }] });
        window.__sensorlab.service.addDevice(d, { kind: 'sltp' });
    });
    await sleep(1500);
    check('hostile BLE name/unit rendered as text, no HTML injection', await st(page, () => !window.__pwned && !document.querySelector('#deviceList img, #latestBody img, #latestBody b') && document.body.textContent.includes('<img src=x')));

    check('zero requests to any non-local origin (file:// run)', a.remote.length === 0, a.remote.slice(0, 5).join(' '));
    check('no uncaught page errors (file:// run)', a.errors.filter(e => !/manifest/i.test(e)).length === 0, a.errors.slice(0, 5).join(' | '));
    results.measurements.fileRunRequests = a.requests;
    results.measurements.fileRunConsoleErrors = a.errors;
    await page.close();
}

// ═════════════════════════════ Scenario 2: forced termination during recording ═════════════════════════════
console.log('\n[2] forced browser kill during recording → interrupted-session recovery');
{
    const page = await browser.newPage();
    await page.goto(FILE_URL, { waitUntil: 'load' });
    await waitFor(() => st(page, () => !!window.__sensorlab), 10000);
    await startDemo(page, 2, 50);
    const sid = await startRecording(page, 'crash test');
    await sleep(4000);
    const atKill = await st(page, () => ({ rel: window.__sensorlab.service.relNow(), appended: window.__sensorlab.recorder.counters.appended }));
    browser.process().kill('SIGKILL'); // no beforeunload, no clean shutdown
    await sleep(1500);
    browser = await launch();
    const p2 = await browser.newPage();
    await p2.goto(FILE_URL, { waitUntil: 'load' });
    await waitFor(() => st(p2, () => !!window.__sensorlab), 10000);
    const banner = await waitFor(() => st(p2, () => !document.getElementById('recoveryBanner').hidden), 8000);
    check('interrupted session detected on next launch', !!banner);
    const rec = await st(p2, async (id) => {
        const r1 = await window.__sensorlab.repo.recoverSession(id, new Date().toISOString());
        const r2 = await window.__sensorlab.repo.recoverSession(id, new Date().toISOString());
        const snap = await window.__sensorlab.repo.readSnapshot(id);
        let lastRel = -1;
        for (const ch of snap.chunks) for (const r of ch.cols.r) if (r > lastRel) lastRel = r;
        return { state: r1.state, same: JSON.stringify(r1.recovery) === JSON.stringify(r2.recovery), persisted: snap.chunks.reduce((a, c) => a + c.n, 0), lastRel, corrupt: snap.corruptChunks.length };
    }, sid);
    check('recovery marks session "recovered" and is idempotent', rec.state === 'recovered' && rec.same);
    check('recovered data readable, no corrupt chunks, not more than was appended', rec.persisted > 0 && rec.persisted <= atKill.appended && rec.corrupt === 0, `persisted=${rec.persisted} appendedBeforeKill≥${atKill.appended}`);
    const lossS = atKill.rel - rec.lastRel;
    results.measurements.crashLossWindowS = { lossWindowS: lossS, killAtRelS: atKill.rel, lastPersistedRelS: rec.lastRel, note: 'single SIMULATED run on this host; flush interval 250 ms; includes up to one flush interval plus kill latency. Not a guarantee.' };
    check('measured loss window at kill (simulated, 1 run) recorded', Number.isFinite(lossS), `${lossS.toFixed(3)} s between last persisted sample and kill instant`);
    await p2.close();
}

// ═════════════════════════════ Scenario 3: storage failure is visible ═════════════════════════════
console.log('\n[3] storage write failure (quota) during recording');
{
    const page = await browser.newPage();
    await page.goto(FILE_URL, { waitUntil: 'load' });
    await waitFor(() => st(page, () => !!window.__sensorlab), 10000);
    await startDemo(page, 1, 20);
    const sid = await startRecording(page, 'quota test');
    await sleep(1000);
    await st(page, () => {
        const repo = window.__sensorlab.repo;
        repo.__orig = repo.appendChunk;
        repo.appendChunk = async () => { const e = new Error('appendChunk failed: QuotaExceededError'); e.causeName = 'QuotaExceededError'; e.quota = true; throw e; };
    });
    const shown = await waitFor(() => st(page, () => !document.getElementById('storageBanner').hidden && /NOT being saved/.test(document.getElementById('storageBanner').textContent) && /STORAGE ERROR/.test(document.getElementById('recStatus').textContent)), 8000);
    check('quota error shown prominently while recording (banner + status)', !!shown);
    await st(page, () => { const repo = window.__sensorlab.repo; repo.appendChunk = repo.__orig; });
    const cleared = await waitFor(() => st(page, () => document.getElementById('storageBanner').hidden), 15000);
    check('recording resumes saving after storage recovers; banner clears', !!cleared);
    const hit = await st(page, () => { const r = document.getElementById('recordBtn').getBoundingClientRect(); const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { toasts: document.querySelectorAll('.toast').length, isButton: el === document.getElementById('recordBtn') || el?.closest('#recordBtn') !== null }; });
    check('toasts never block the Record/Stop button (it is the hit target while toasts are shown)', hit.isButton, JSON.stringify(hit));
    await page.click('#recordBtn');
    const sum = await waitFor(() => st(page, () => window.__sensorlab.recorder.lastSummary), 10000);
    const n = await st(page, async (id) => (await window.__sensorlab.repo.readSnapshot(id)).chunks.reduce((a, c) => a + c.n, 0), sid);
    check('after transient failure: all appended readings persisted, write errors recorded', sum.ok && n === sum.appended && sum.writeErrors > 0, `stored=${n} appended=${sum.appended} writeErrors=${sum.writeErrors}`);
    // persistent failure → honest summary
    await startRecording(page, 'quota test 2');
    await sleep(800);
    await st(page, () => { window.__sensorlab.repo.appendChunk = async () => { const e = new Error('appendChunk failed: QuotaExceededError'); e.causeName = 'QuotaExceededError'; throw e; }; window.__sensorlab.repo.updateSession = window.__sensorlab.repo.appendChunk; });
    await sleep(800);
    await st(page, () => { window.__sensorlab.recorder.lastSummary = null; });
    await page.click('#recordBtn');
    const sum2 = await waitFor(() => st(page, () => window.__sensorlab.recorder.lastSummary), 20000);
    const errText = await st(page, () => document.getElementById('storageBanner').textContent);
    check('persistent failure: no false "saved"; unsaved count reported to user', sum2 && !sum2.ok && sum2.unsaved > 0 && /finalization FAILED/.test(errText) && errText.includes(String(sum2.unsaved)), `unsaved=${sum2?.unsaved}`);
    await page.close();
}

// ═════════════════════════════ Scenario 4: no Web Bluetooth ═════════════════════════════
console.log('\n[4] browser without Web Bluetooth');
{
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => { try { delete Navigator.prototype.bluetooth; } catch { /* ignore */ } Object.defineProperty(Navigator.prototype, 'bluetooth', { get: () => undefined, configurable: true }); });
    await page.goto(FILE_URL, { waitUntil: 'load' });
    await waitFor(() => st(page, () => !!window.__sensorlab), 10000);
    check('unsupported BLE: explanatory banner, app still usable', await st(page, () => !document.getElementById('bleBanner').hidden && /not available/.test(document.getElementById('bleBanner').textContent)));
    await page.click('#historyBtn');
    const listed = await waitFor(() => st(page, () => document.querySelectorAll('#histBody tr').length), 5000);
    check('history/export of local data reachable without Bluetooth', listed >= 3, `${listed} sessions listed`);
    await page.keyboard.press('Escape');
    check('demo mode works without Bluetooth', (await startDemo(page, 1, 10)) === 1);
    await page.close();
}

// ═════════════════════════════ Scenario 5: large session ═════════════════════════════
console.log('\n[5] large session (>100k readings): history render + export');
{
    const page = await browser.newPage();
    await page.goto(FILE_URL, { waitUntil: 'load' });
    await waitFor(() => st(page, () => !!window.__sensorlab), 10000);
    const m = await st(page, async () => {
        const { repo } = window.__sensorlab;
        const id = 'large-' + Date.now();
        await repo.createSession({ sessionId: id, name: 'large synthetic', group: '', notes: '', state: 'closed', startedWall: new Date().toISOString(), simulated: true,
            devices: { 'sim:BIG': { deviceId: 'sim:BIG', displayName: 'BIG', protocol: 'sltp/1', channels: [{ channelId: 0, name: 'a', unit: 'V' }, { channelId: 1, name: 'b', unit: '°C' }] } }, quality: {}, storage: { readingsPersisted: 150000 } });
        const t0 = performance.now();
        for (let c = 0; c < 30; c++) {
            const cols = { d: [], c: [], q: [], t: [], h: [], r: [], raw: [], v: [], f: [] };
            for (let i = 0; i < 5000; i++) { const k = c * 5000 + i; cols.d.push(0); cols.c.push(k % 2); cols.q.push(k >> 1); cols.t.push(k * 5000); cols.h.push(k * 5); cols.r.push(k * 0.005); cols.raw.push(k); cols.v.push(Math.sin(k / 500)); cols.f.push(64); }
            await repo.appendChunk(id, { chunkNo: c, n: 5000, wall: new Date().toISOString(), dict: ['sim:BIG'], cols }, {});
        }
        return { id, writeMs: performance.now() - t0 };
    });
    await page.click('#historyBtn');
    await page.waitForSelector('#histBody tr');
    const t0 = Date.now();
    await st(page, (id) => { const b = [...document.querySelectorAll('#histBody tr')].find(tr => tr.textContent.includes('large synthetic')).querySelector('button'); b.click(); }, m.id);
    const note = await waitFor(() => st(page, () => { const t = document.getElementById('detailChartNote').textContent; return t || null; }), 30000);
    const viewMs = Date.now() - t0;
    const tE = Date.now();
    await page.click('#exCsv');
    const p = await newestDownload('.csv', tE - 1000);
    const exportMs = Date.now() - tE;
    const lines = p ? readFileSync(p, 'utf8').split('\r\n').length - 2 : -1;
    check('150k-reading session: history view renders (decimated)', !!note && /150000 stored readings/.test(note), note);
    check('150k-reading session: CSV export complete', lines === 150000, `rows=${lines}`);
    results.measurements.largeSession = { readings: 150000, idbWriteMs: Math.round(m.writeMs), historyViewMs: viewMs, csvExportToFileMs: exportMs, note: 'headless Chrome on this host; indicative only' };
    await page.close();
}

// ═════════════════════════════ Scenario 6: HTTP + service worker, then offline reload ═════════════════════════════
console.log('\n[6] HTTP(S)-style hosting: first load online, then reload with network offline (service worker)');
{
    const page = await browser.newPage();
    const a = audit(page, [`http://127.0.0.1:${PORT}/`, 'data:', 'blob:']);
    await page.goto(HTTP_URL, { waitUntil: 'load' });
    await waitFor(() => st(page, () => !!window.__sensorlab), 10000);
    const manifest = JSON.parse(readFileSync(path.join(dist, 'manifest.webmanifest'), 'utf8'));
    const manifestPath = await st(page, () => {
        const link = document.querySelector('link[rel="manifest"]');
        return link ? new URL(link.href).pathname : null;
    });
    const iconSizes = manifest.icons.map(icon => icon.sizes);
    check('web app manifest contains standalone mode and Android icon sizes', manifestPath === '/manifest.webmanifest' && manifest.display === 'standalone' && manifest.theme_color === '#09090b' && iconSizes.includes('192x192') && iconSizes.includes('512x512'), JSON.stringify({ manifestPath, display: manifest.display, iconSizes }));
    const swReady = await waitFor(() => st(page, async () => !!(await navigator.serviceWorker.getRegistration())?.active), 10000);
    check('service worker installed and active', !!swReady);
    const precachedIcons = await st(page, async () => {
        const keys = await caches.keys();
        const cache = await caches.open(keys.find(k => k.startsWith('sensorlab-')));
        const paths = (await cache.keys()).map(request => new URL(request.url).pathname);
        return paths.includes('/icons/icon-192.png') && paths.includes('/icons/icon-512.png');
    });
    check('service worker precaches app icons for offline launches', precachedIcons);
    await setOffline(page, true);
    server.close();
    await page.reload({ waitUntil: 'load' });
    const ok = await waitFor(() => st(page, () => !!window.__sensorlab), 10000);
    check('app reloads and runs with network offline and server stopped (served from SW cache)', !!ok);
    check('zero requests to any non-local origin (HTTP run)', a.remote.length === 0, a.remote.slice(0, 5).join(' '));
    check('no uncaught page errors (HTTP run)', a.errors.filter(e => !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(e)).length === 0, a.errors.slice(0, 5).join(' | '));
    await page.close();
}

// ═════════════════════════════ Scenario 8: recording lifecycle UI ═════════════════════════════
console.log('\n[8] recording lifecycle: confirmation, keep-awake, preflight, verified startup, stale streams, startup failure');
{
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 720 });
    await page.goto(FILE_URL, { waitUntil: 'load' });
    await waitFor(() => st(page, () => !!window.__sensorlab), 10000);
    await startDemo(page, 2, 20);
    const before = await sessionCount(page);
    await page.click('#recordBtn');
    await page.waitForSelector('#sessionDialog[open]');
    const dlg = await st(page, () => ({
        keepAwakeChecked: document.getElementById('sKeepAwake').checked,
        rows: [...document.querySelectorAll('#recDevices tr')].map(tr => tr.textContent),
        explains: /does not keep the app running/i.test(document.getElementById('keepAwakeNote').textContent.replace(/\s+/g, ' ')),
    }));
    check('confirmation dialog lists devices and channels with units', dlg.rows.length === 2 && dlg.rows.every(r => /\(.+\)/.test(r)), dlg.rows.join(' | '));
    check('keep screen awake is enabled by default and explained as best-effort', dlg.keepAwakeChecked && dlg.explains);
    const clip = await st(page, () => { const d = document.getElementById('sessionDialog').getBoundingClientRect(); return [...document.querySelectorAll('#recDevices tr:first-child td')].map(td => { const r = td.getBoundingClientRect(); return r.right <= d.right + 0.5 && r.width > 0 && td.closest('.table-scroll').scrollWidth <= td.closest('.table-scroll').clientWidth + 1; }); });
    check('all dialog columns (incl. channels and rate) visible without clipping', clip.length === 5 && clip.every(Boolean), JSON.stringify(clip));
    const startHit = await st(page, () => { const b = document.getElementById('sessionStart'); const r = b.getBoundingClientRect(); return r.bottom <= innerHeight && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b; });
    check('Start/Cancel reachable without scrolling in a 1100×720 window', startHit);
    await waitFor(() => st(page, () => document.querySelectorAll('#pfWarn li').length > 0), 3000);
    check('preflight warnings shown before starting (simulated devices)', (await st(page, () => [...document.querySelectorAll('#pfWarn li')].map(l => l.textContent))).some(w => /SIMULATED/.test(w)));
    await page.click('#sessionCancel');
    check('cancelling the confirmation creates no session', !(await st(page, () => document.getElementById('sessionDialog').open)) && (await sessionCount(page)) === before);

    // fatal preflight: untick all devices
    await page.click('#recordBtn');
    await page.waitForSelector('#sessionDialog[open]');
    for (const cb of await page.$$('#recDevices input[type=checkbox]')) await cb.click();
    await waitFor(() => st(page, () => document.querySelectorAll('#pfFatal li').length > 0), 3000);
    check('fatal preflight (no device selected) disables Start', await st(page, () => document.getElementById('sessionStart').disabled && /No device/.test(document.getElementById('pfFatal').textContent)));
    for (const cb of await page.$$('#recDevices input[type=checkbox]')) await cb.click();
    await page.click('#sKeepAwake'); // user disables keep-awake
    await page.$eval('#sName', el => { el.value = 'lifecycle e2e'; });
    await page.waitForFunction(() => !document.getElementById('sessionStart').disabled);
    // duplicate submission: a trusted click plus an immediate extra form submission
    await page.click('#sessionStart');
    await page.$eval('#sessionForm', f => f.requestSubmit());
    const verified = await waitFor(() => st(page, () => window.__sensorlab.controller.state === 'RECORDING'), 15000);
    check('RECORDING only after verification; duplicate submissions create one session', !!verified && (await sessionCount(page)) === before + 1);
    const sid = await st(page, () => window.__sensorlab.service.sessionId);
    await sleep(500);
    const order8 = await st(page, () => [...window.__sensorlab.chart.series.values()].every(s => { let prev = -Infinity; for (let i = 0; i < s.ring.length; i++) { const x = s.ring.get(i)[0]; if (x < prev) return false; prev = x; } return true; }));
    check('live chart series are time-ordered after start (no joined pre-/post-reset points)', order8);
    const ka = await st(page, async (id) => ({ ui: document.getElementById('keepAwakeState').textContent, stored: (await window.__sensorlab.repo.getSession(id)).lifecycle.keepAwake.state }), sid);
    check('keep-awake disabled by the user: never requested, reported honestly', ka.ui === 'not requested' && ka.stored === 'not_requested', JSON.stringify(ka));
    // lifecycle events are persisted with the next flush (≤ 250 ms + write time), like samples
    const types = await waitFor(() => st(page, async (id) => { const t = (await window.__sensorlab.repo.getSession(id)).lifecycle.events.map(e => e.type); return t.includes('startup_verified') ? t : null; }, sid), 3000) || [];
    const order = ['preflight', 'keep_awake', 'pipeline_active', 'startup_verified'].map(t => types.indexOf(t));
    check('persisted startup order: preflight → keep_awake → pipeline_active → startup_verified', order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), order.join(','));

    // stale stream on one device; the other keeps recording; controls stay clickable under warnings
    await st(page, () => [...window.__sensorlab.connectView.sim.devices.values()][0].setFaults({ silent: true }));
    const degraded = await waitFor(() => st(page, () => window.__sensorlab.controller.state === 'DEGRADED' && !document.getElementById('staleBanner').hidden), 6000);
    check('silent device → session DEGRADED with a non-blocking warning naming device and channel', !!degraded, await st(page, () => document.getElementById('staleBanner').textContent.slice(0, 160)));
    const other = await st(page, () => window.__sensorlab.service.list()[1].tracker.snapshot().received);
    await sleep(1000);
    check('other device keeps recording while one is stale', (await st(page, () => window.__sensorlab.service.list()[1].tracker.snapshot().received)) > other + 10);
    check('stale value shown as "last …", not as current', await st(page, () => [...document.querySelectorAll('#latestBody tr')].some(tr => /stale|suspect/.test(tr.children[2].textContent) && /^last /.test(tr.children[3].textContent))));
    const hit = await st(page, () => { const r = document.getElementById('recordBtn').getBoundingClientRect(); const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!el && el.closest('#recordBtn') !== null; });
    check('Record/Stop is the hit target while stale warnings are visible', hit);
    await st(page, () => [...window.__sensorlab.connectView.sim.devices.values()][0].setFaults({ silent: false }));
    const back = await waitFor(() => st(page, () => window.__sensorlab.controller.state === 'RECORDING'), 6000);
    check('stream resumes → session back to RECORDING', !!back);
    await page.click('#recordBtn'); // trusted Stop
    const done = await waitFor(() => st(page, () => /Finalized ✓/.test(document.getElementById('finalState').textContent)), 10000);
    check('Stop finalizes and the UI reports successful finalization', !!done);
    const stored = await st(page, async (id) => { const s = await window.__sensorlab.repo.getSession(id); return { state: s.state, ev: s.lifecycle.events.filter(e => e.type === 'stream_state' && e.to === 'STALE').length }; }, sid);
    check('stale transitions persisted in the saved session', stored.state === 'closed' && stored.ev > 0, JSON.stringify(stored));

    // startup failure: one device silent; keep-awake left ON (real Screen Wake Lock API of headless Chrome)
    await st(page, () => [...window.__sensorlab.connectView.sim.devices.values()][1].setFaults({ silent: true }));
    await sleep(300);
    await page.click('#recordBtn');
    await page.waitForSelector('#sessionDialog[open]');
    await page.$eval('#sName', el => { el.value = 'startup failure e2e'; });
    await page.waitForFunction(() => !document.getElementById('sessionStart').disabled);
    await page.click('#sessionStart');
    const failed = await waitFor(() => st(page, () => !document.getElementById('startFailedActions').hidden), 20000);
    check('startup failure (silent device) shown with Retry/Cancel; not reported as recording', !!failed && (await st(page, () => window.__sensorlab.controller.state)) === 'START_FAILED',
        await st(page, () => document.getElementById('sessionError').textContent.slice(0, 140)));
    const fs8 = await st(page, async () => (await window.__sensorlab.repo.listSessions()).find(s => s.name === 'startup failure e2e'));
    const kaEvents = fs8 ? fs8.lifecycle.events.filter(e => e.type === 'keep_awake') : [];
    check('failed startup kept as "startup_failed"; keep-awake outcome of the real Wake Lock API recorded', !!fs8 && fs8.state === 'startup_failed' && kaEvents.length > 0 && kaEvents.every(e => ['active', 'failed', 'unavailable', 'released', 'not_requested'].includes(e.state)),
        JSON.stringify(kaEvents.map(e => e.state + (e.reason ? ' (' + e.reason + ')' : ''))));
    results.measurements.wakeLockHeadlessChrome = kaEvents.map(e => ({ state: e.state, reason: e.reason }));
    await page.click('#startDismiss');
    check('Cancel after a failed startup returns to idle', await st(page, () => window.__sensorlab.controller.state === 'IDLE' && !document.getElementById('sessionDialog').open));
    await page.close();
}

// ═════════════════════════════ Scenario 9: failure UX, reload, keyboard, browser lifecycle ═════════════════════════════
console.log('\n[9] permission denial, IndexedDB unavailable, export failure, slow finalization, reload, keyboard, freeze/resume');
{
    // 9a permission denied by the browser
    const pd = await browser.newPage();
    await pd.evaluateOnNewDocument(() => {
        Object.defineProperty(Navigator.prototype, 'bluetooth', { configurable: true, get: () => ({
            getAvailability: async () => true,
            requestDevice: async () => { throw new DOMException('User denied the browser permission to scan for Bluetooth devices.', 'NotAllowedError'); },
        }) });
    });
    await pd.goto(FILE_URL, { waitUntil: 'load' });
    await waitFor(() => st(pd, () => !!window.__sensorlab), 10000);
    await pd.click('#addDeviceBtn');
    await pd.click('#connectSltp');
    const permMsg = await waitFor(() => st(pd, () => document.getElementById('addError').textContent || null), 5000);
    check('Bluetooth permission denial gives an actionable message and adds nothing', /denied or blocked/.test(permMsg || '') && /site settings/.test(permMsg || '') && (await st(pd, () => window.__sensorlab.service.list().length)) === 0, (permMsg || '').slice(0, 90));
    await pd.close();

    // 9b IndexedDB unavailable
    const nodb = await browser.newPage();
    await nodb.evaluateOnNewDocument(() => { IDBFactory.prototype.open = function () { throw new DOMException('The user denied permission to access the database.', 'InvalidStateError'); }; });
    await nodb.goto(FILE_URL, { waitUntil: 'load' });
    await waitFor(() => st(nodb, () => !document.getElementById('storageBanner').hidden), 8000);
    const nodbState = await st(nodb, () => ({ banner: document.getElementById('storageBanner').textContent }));
    await nodb.click('#recordBtn');
    await sleep(500);
    const nodbAfter = await st(nodb, () => ({ dialogOpen: document.getElementById('sessionDialog').open, toast: [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' ') }));
    check('IndexedDB unavailable: prominent banner, Record refuses with an explanation, no dialog', /RECORDING IS DISABLED/.test(nodbState.banner) && !nodbAfter.dialogOpen && /disabled because local storage is unavailable/.test(nodbAfter.toast), nodbState.banner.slice(0, 90));
    await nodb.close();

    // main page for the remaining checks
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    const a9 = audit(page, ['file://', 'data:', 'blob:']);
    await page.goto(FILE_URL, { waitUntil: 'load' });
    await waitFor(() => st(page, () => !!window.__sensorlab), 10000);
    await startDemo(page, 1, 20);

    // 9c keyboard: Tab reaches Record with a visible focus ring; Enter opens; Escape closes; focus returns
    await st(page, () => { document.activeElement?.blur(); });
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) { await page.keyboard.press('Tab'); reached = await st(page, () => document.activeElement?.id === 'recordBtn'); }
    const ring = reached ? await st(page, () => { const cs = getComputedStyle(document.activeElement); return cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0; }) : false;
    check('keyboard: Tab reaches Record and the focus is visibly outlined', reached && ring);
    await page.keyboard.press('Enter');
    const kbOpen = await waitFor(() => st(page, () => document.getElementById('sessionDialog').open && document.activeElement?.id === 'sName'), 3000);
    await page.keyboard.press('Escape');
    const kbClosed = await waitFor(() => st(page, () => !document.getElementById('sessionDialog').open), 3000);
    const back = await st(page, () => document.activeElement?.id);
    check('keyboard: Enter opens the confirmation with focus in the name field; Escape closes it; focus returns to Record', !!kbOpen && !!kbClosed && back === 'recordBtn', `focus after close: ${back}`);

    // 9d real Page Lifecycle freeze/resume (CDP) on a DEDICATED page: headless Chrome does not resume rendering (rAF)
    //    after an emulated resume, which breaks later input on that page, so it is discarded afterwards.
    const fz = await browser.newPage();
    await fz.goto(FILE_URL, { waitUntil: 'load' });
    await waitFor(() => st(fz, () => !!window.__sensorlab), 10000);
    await startDemo(fz, 1, 20);
    const fzSid = await startRecording(fz, 'freeze 9');
    const cdp = await fz.createCDPSession();
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    await sleep(6000);
    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    const lifeEv = await waitFor(() => st(fz, async (id) => { await window.__sensorlab.recorder.flush(); const ev = (await window.__sensorlab.repo.getSession(id)).lifecycle.events; const k = ev.filter(e => e.type === 'lifecycle').map(e => e.kind); const g = ev.filter(e => e.type === 'lifecycle_gap').map(e => e.kind + ':' + (e.monoGapMs ?? '')); return k.includes('resume') && g.length ? { kinds: k, gaps: g } : null; }, fzSid), 8000);
    check('real browser freeze/resume (Page Lifecycle) recorded and the ≥5 s timer stall persisted in the session (defect D29)', !!lifeEv && lifeEv.kinds.includes('freeze') && lifeEv.gaps.some(g => g.startsWith('timer_stall')), JSON.stringify(lifeEv));
    await fz.close();

    // 9e slow finalization on the main page
    const sid = await startRecording(page, 'lifecycle 9');

    // 9e-bis real tab hide/return during recording (another tab brought to front), with the real Wake Lock API
    const other = await browser.newPage();
    await other.bringToFront();
    await sleep(2500);
    const hiddenState = await st(page, () => ({ vis: document.visibilityState, ka: window.__sensorlab.keepAwake.status().state }));
    await page.bringToFront();
    await sleep(1500);
    const visState = await st(page, async (id) => {
        await window.__sensorlab.recorder.flush();
        const ev = (await window.__sensorlab.repo.getSession(id)).lifecycle.events;
        return { types: ev.map(e => e.type), kaStates: ev.filter(e => e.type === 'keep_awake').map(e => e.state), banner: document.getElementById('visibilityBanner').textContent,
            ka: window.__sensorlab.keepAwake.status().state, reacq: window.__sensorlab.keepAwake.reacquisitions };
    }, sid);
    await other.close();
    check('tab hidden then shown during recording: app_hidden/app_visible persisted and a visibility warning shown', hiddenState.vis === 'hidden' && visState.types.includes('app_hidden') && visState.types.includes('app_visible') && /hidden for/.test(visState.banner), visState.banner.slice(0, 70));
    check('real Wake Lock: released by the browser while hidden, re-acquired when visible, both persisted', hiddenState.ka === 'released' && visState.ka === 'active' && visState.reacq >= 1 && visState.kaStates.includes('released'),
        JSON.stringify({ whileHidden: hiddenState.ka, afterReturn: visState.ka, reacquisitions: visState.reacq, persisted: visState.kaStates }));
    await st(page, () => {
        const repo = window.__sensorlab.repo;
        repo.__orig = repo.appendChunk;
        repo.appendChunk = async (...a) => { await new Promise(r => setTimeout(r, 3000)); return repo.__orig.apply(repo, a); };
    });
    await sleep(300);
    await page.click('#recordBtn'); // trusted Stop while writes are slow
    await sleep(400);
    const during = await st(page, () => ({ state: document.getElementById('sessState').textContent, disabled: document.getElementById('recordBtn').disabled }));
    check('slow finalization is shown as "stopping / finalizing" with Stop disabled (no premature success)', /stopping \/ finalizing/.test(during.state) && during.disabled, JSON.stringify(during));
    const fin = await waitFor(() => st(page, () => /Finalized ✓/.test(document.getElementById('finalState').textContent)), 20000);
    check('…then reports successful finalization once all writes completed', !!fin);
    await st(page, () => { const repo = window.__sensorlab.repo; repo.appendChunk = repo.__orig; });

    // 9f reload preserves the completed session exactly
    const digest = (id) => st(page, async (sid) => { const s = await window.__sensorlab.repo.readSnapshot(sid); const buf = new TextEncoder().encode(JSON.stringify(s)); const h = await crypto.subtle.digest('SHA-256', buf); return { hash: [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join(''), n: s.chunks.reduce((a, c) => a + c.n, 0), state: s.session.state }; }, id);
    const before = await digest(sid);
    await page.reload({ waitUntil: 'load' });
    await waitFor(() => st(page, () => !!window.__sensorlab), 10000);
    const after = await digest(sid);
    // This session must not be listed as interrupted. (The 'freeze 9' session on the discarded page WAS interrupted, so the banner may correctly show.)
    const flagged = await st(page, async (id) => { const s = await window.__sensorlab.repo.listSessions(); return s.filter(x => x.state === 'open').map(x => x.sessionId).includes(id); }, sid);
    const bannerText = await st(page, () => document.getElementById('recoveryBanner').hidden ? '' : document.getElementById('recoveryText').textContent);
    check('page reload: completed session is byte-identical (SHA-256 of the stored snapshot) and still "closed" (not open/interrupted)', before.hash === after.hash && after.state === 'closed' && after.n > 0 && !flagged, `hash before ${before.hash.slice(0, 12)} after ${after.hash.slice(0, 12)}, ${after.n} readings, state ${after.state}; banner: ${bannerText.slice(0, 60) || 'none'}`);

    // 9g export failure is explained and writes no file
    await page.click('#historyBtn');
    await page.waitForSelector('#histBody tr');
    await st(page, (id) => { const tr = [...document.querySelectorAll('#histBody tr')].find(t => t.textContent.includes('lifecycle 9')); [...tr.querySelectorAll('button')].find(b => b.textContent === 'View').click(); }, sid);
    await page.waitForSelector('#histDetail:not([hidden])');
    const filesBefore = readdirSync(dlDir).length;
    await st(page, () => { window.__sensorlab.repo.readSnapshot = async () => { throw new Error('readSnapshot failed: UnknownError — simulated disk read error'); }; });
    await page.click('#exCsv');
    const exToast = await waitFor(() => st(page, () => [...document.querySelectorAll('.toast.error')].map(t => t.textContent).join(' ') || null), 5000);
    await sleep(1000);
    check('export failure: explained to the user and no file is written', /Export failed/.test(exToast || '') && readdirSync(dlDir).length === filesBefore, (exToast || '').slice(0, 90));
    await page.keyboard.press('Escape');

    check('no uncaught page errors during scenario 9', a9.errors.length === 0, a9.errors.slice(0, 3).join(' | '));
    check('zero non-local requests during scenario 9', a9.remote.length === 0);
    await page.close();
}

// ═════════════════════════════ Scenario 10: accessibility (automated part; a real screen-reader session is separate) ═════════════════════════════
console.log('\n[10] accessibility: names, dialogs, focus, live regions, chart alternatives, contrast');
{
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 860 });
    await page.goto(FILE_URL, { waitUntil: 'load' });
    await waitFor(() => st(page, () => !!window.__sensorlab), 10000);
    await startDemo(page, 2, 20);
    const cdp = await page.createCDPSession();
    const ax = async () => (await cdp.send('Accessibility.getFullAXTree')).nodes.filter(n => !n.ignored);
    const ROLES = ['button', 'checkbox', 'textbox', 'combobox', 'tab', 'link', 'spinbutton', 'dialog', 'img', 'searchbox'];
    const nameIssues = (nodes) => {
        const unnamed = nodes.filter(n => ROLES.includes(n.role?.value) && !(n.name?.value || '').trim()).map(n => n.role.value);
        const counts = {};
        for (const n of nodes) if (n.role?.value === 'button') counts[n.name?.value] = (counts[n.name?.value] || 0) + 1;
        return { unnamed, duplicates: Object.entries(counts).filter(([, c]) => c > 1) };
    };
    const main = nameIssues(await ax());
    check('every control has an accessible name; no ambiguous duplicates with 2 devices (e.g. "Settings for SIM-01")', main.unnamed.length === 0 && main.duplicates.length === 0, JSON.stringify(main));

    // dialogs: focus enters, Escape closes, focus returns to the opener
    const dialogs = [['#addDeviceBtn', 'addDialog'], ['#demoBtn', 'demoDialog'], ['#historyBtn', 'historyDialog'], ['#installBtn', 'installDialog'], ['#helpBtn', 'helpDialog'], ['#recordBtn', 'sessionDialog']];
    const dres = [];
    for (const [btn, id] of dialogs) {
        await page.focus(btn);
        await page.keyboard.press('Enter');
        await waitFor(() => st(page, (i) => document.getElementById(i).open, id), 3000);
        const inside = await st(page, (i) => document.getElementById(i).contains(document.activeElement), id);
        const named = await st(page, (i) => { const d = document.getElementById(i); const l = d.getAttribute('aria-labelledby'); return !!(l && document.getElementById(l)?.textContent.trim()); }, id);
        await page.keyboard.press('Escape');
        await waitFor(() => st(page, (i) => !document.getElementById(i).open, id), 3000);
        const back = await st(page, () => '#' + document.activeElement?.id);
        dres.push({ id, inside, named, restored: back === btn });
    }
    check('all dialogs: labelled, focus moves inside, Escape closes, focus returns to the opener', dres.every(d => d.inside && d.named && d.restored), JSON.stringify(dres.filter(d => !(d.inside && d.named && d.restored))));
    const modal = await st(page, async () => { const d = document.getElementById('helpDialog'); d.showModal(); const outside = document.getElementById('recordBtn'); outside.focus(); const contained = d.contains(document.activeElement) || document.activeElement === document.body || document.activeElement !== outside; d.close(); return contained; });
    check('modal dialogs make the rest of the page inert (focus cannot land on background controls)', modal);

    // live regions: quiet during a steady healthy recording
    const a11ySessionId = await st(page, async () => {
        const { controller, service } = window.__sensorlab;
        await controller.start({ name: 'a11y', include: service.list().map(e => e.handle), keepAwake: false });
        return service.sessionId;
    });
    await waitFor(() => st(page, () => window.__sensorlab.controller.state === 'RECORDING'), 10000);
    await sleep(1500);
    const quiet = await st(page, async () => {
        const live = [...document.querySelectorAll('[aria-live]:not([aria-live=off]), [role=status], [role=alert], [role=log]')];
        const c = {};
        const obs = live.map(n => { const o = new MutationObserver(m => { const spoken = m.filter(x => x.type === 'characterData' || x.addedNodes.length).length; if (spoken) { const k = n.id || n.className; c[k] = (c[k] || 0) + spoken; } }); /* removals are not announced */ o.observe(n, { childList: true, subtree: true, characterData: true }); return o; });
        await new Promise(r => setTimeout(r, 5000));
        obs.forEach(o => o.disconnect());
        return c;
    });
    check('no live-region announcements during 5 s of steady healthy recording (no per-second chatter)', Object.keys(quiet).length === 0, JSON.stringify(quiet));
    // announcer speaks once per discrete change, naming device and channel, then stays quiet
    await st(page, () => [...window.__sensorlab.connectView.sim.devices.values()][0].setFaults({ silent: true }));
    await waitFor(() => st(page, () => window.__sensorlab.controller.streamView().some(s => s.state === 'STALE')), 6000);
    await sleep(600);
    const spoken = await st(page, () => document.getElementById('srAnnounce').textContent);
    const after = await st(page, async () => { const n = document.getElementById('srAnnounce'); let k = 0; const o = new MutationObserver(m => k += m.filter(x => x.type === 'characterData' || x.addedNodes.length).length); o.observe(n, { childList: true, subtree: true, characterData: true }); await new Promise(r => setTimeout(r, 4000)); o.disconnect(); return k; });
    check('stale stream announced once with device and channel; no repeats while unchanged', /SIM-01/.test(spoken) && /strain/.test(spoken) && /stale/.test(spoken) && after === 0, `"${spoken}" then ${after} repeats in 4 s`);
    await st(page, () => [...window.__sensorlab.connectView.sim.devices.values()][0].setFaults({ silent: false }));
    await waitFor(() => st(page, () => window.__sensorlab.controller.state === 'RECORDING'), 6000);
    await sleep(600);
    check('recovery announced', /fresh/i.test(await st(page, () => document.getElementById('srAnnounce').textContent)), await st(page, () => document.getElementById('srAnnounce').textContent));
    await page.click('#recordBtn');
    const fin = await waitFor(() => st(page, () => /finalized/i.test(document.getElementById('srAnnounce').textContent) ? document.getElementById('srAnnounce').textContent : null), 10000);
    check('finalization result announced with the saved-reading count', !!fin && /\d+ readings saved/.test(fin), fin);
    const finalizedA11ySession = await st(page, async (id) => {
        const sessions = await window.__sensorlab.repo.listSessions();
        const session = sessions.find(s => s.sessionId === id);
        return session ? { name: session.name, state: session.state } : null;
    }, a11ySessionId);
    check('accessibility test session is finalized in storage before History opens', finalizedA11ySession?.name === 'a11y' && finalizedA11ySession.state === 'closed', JSON.stringify(finalizedA11ySession));

    // chart text alternatives
    const alt = await st(page, () => [...document.querySelectorAll('canvas')].map(c => ({ id: c.id, ok: (c.getAttribute('aria-describedby') || '').split(' ').filter(Boolean).every(i => document.getElementById(i)) && !!c.getAttribute('aria-describedby') })));
    check('charts reference a textual/numerical alternative (aria-describedby targets exist)', alt.every(a => a.ok), JSON.stringify(alt));
    await page.click('#historyBtn');
    const a11yRowFound = await waitFor(() => st(page, () => [...document.querySelectorAll('#histBody tr')].some(tr => tr.textContent.includes('a11y'))), 5000);
    check('History eventually lists the accessibility test session', !!a11yRowFound, `session=${a11ySessionId}`);
    const names = nameIssues(await ax());
    check('History: View/Delete buttons have session-specific accessible names', names.duplicates.length === 0 && names.unnamed.length === 0, JSON.stringify(names));
    const openedA11ySession = a11yRowFound && await st(page, () => {
        const row = [...document.querySelectorAll('#histBody tr')].find(tr => tr.textContent.includes('a11y'));
        const view = row?.querySelector('button[aria-label^="View session"]');
        if (!view) return false;
        view.click();
        return true;
    });
    const detailReady = openedA11ySession && await waitFor(() => st(page, () => document.querySelectorAll('#detailSeriesBody tr').length > 0), 5000);
    const series = detailReady ? await st(page, () => [...document.querySelectorAll('#detailSeriesBody tr')].map(tr => tr.textContent)) : [];
    check('History: per-series numerical summary table (chart alternative) lists every series', !!detailReady && series.length === 4, series.join(' | ').slice(0, 120) || 'accessibility test session detail did not open');
    await page.keyboard.press('Escape');

    // WCAG AA text contrast, both themes
    const contrast = async () => st(page, () => {
        const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 }; };
        const lum = ({ r, g, b }) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
        const bgOf = (el) => { const layers = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } } let out = parse(getComputedStyle(document.body).backgroundColor); for (const l of layers.reverse()) out = { r: l.r * l.a + out.r * (1 - l.a), g: l.g * l.a + out.g * (1 - l.a), b: l.b * l.a + out.b * (1 - l.a) }; return out; };
        const bad = [];
        for (const el of document.querySelectorAll('body *')) {
            if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
            if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) || el.closest('[hidden]') || el.closest(':disabled')) continue;
            const cs = getComputedStyle(el); const fg = parse(cs.color); if (!fg) continue;
            const bg = bgOf(el); const ratio = (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05);
            const large = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && +cs.fontWeight >= 700);
            if (ratio < (large ? 3 : 4.5)) bad.push(`${el.tagName}:${ratio.toFixed(2)}:${el.textContent.trim().slice(0, 20)}`);
        }
        return bad;
    });
    const darkBad = await contrast();
    await st(page, () => { document.documentElement.dataset.theme = 'light'; });
    await sleep(300);
    const lightBad = await contrast();
    check('text contrast meets WCAG AA (4.5:1, large 3:1) in dark and light themes', darkBad.length === 0 && lightBad.length === 0, JSON.stringify({ darkBad: darkBad.slice(0, 3), lightBad: lightBad.slice(0, 3) }));
    await page.close();
}

// ═════════════════════════════ Scenario 11: startup failure, then Cancel, then record again (readiness defect S1) ═════════════════════════════
// After a failed start (START_FAILED), closing the dialog with Cancel or Escape left the controller in START_FAILED; the next
// Record click reopened the dialog with Retry/Dismiss hidden, and Start answered "Cannot start while START_FAILED" until reload.
{
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 720 });
    await page.goto(FILE_URL, { waitUntil: 'load' });
    await waitFor(() => st(page, () => !!window.__sensorlab), 10000);
    await startDemo(page, 1, 20);
    const failOnce = () => st(page, () => {
        const repo = window.__sensorlab.repo;
        repo.__origCreate = repo.__origCreate || repo.createSession;
        repo.createSession = async () => { const e = new Error('createSession failed: QuotaExceededError'); e.causeName = 'QuotaExceededError'; throw e; };
    });
    const restore = () => st(page, () => { const repo = window.__sensorlab.repo; repo.createSession = repo.__origCreate; });
    for (const how of ['Cancel button', 'Escape key']) {
        await failOnce();
        await page.click('#recordBtn');
        await page.waitForSelector('#sessionDialog[open]');
        await waitFor(() => st(page, () => document.querySelectorAll('#pfWarn li').length > 0), 3000); // preflight rendered (it re-enables Start)
        await page.$eval('#sName', (el, v) => { el.value = v; }, `failing start (${how})`); // the name is required (form validation)
        await page.waitForFunction(() => !document.getElementById('sessionStart').disabled, { timeout: 5000 });
        await page.click('#sessionStart');
        const failed = await waitFor(() => st(page, () => window.__sensorlab.controller.state === 'START_FAILED' && /could not be saved/.test(document.getElementById('sessionError').textContent)), 8000);
        check(`header write failure → START_FAILED shown in the dialog (${how} variant)`, !!failed,
            await st(page, () => `${window.__sensorlab.controller.state}: "${document.getElementById('sessionError').textContent}" fatal="${document.getElementById('pfFatal').textContent}" events=${window.__sensorlab.controller.events.slice(-4).map(e => e.type + (e.to ? '→' + e.to : '') + (e.fatal ? ':' + e.fatal : '')).join(',')} visible=${document.visibilityState}`));
        if (how === 'Cancel button') await page.click('#sessionCancel'); else await page.keyboard.press('Escape');
        await waitFor(() => st(page, () => !document.getElementById('sessionDialog').open), 3000);
        await restore();
        const sid = await startRecording(page, `after failure (${how})`);
        check(`after a failed start closed with the ${how}, the next Record starts normally`, !!sid, await st(page, () => `${window.__sensorlab.controller.state}: ${document.getElementById('sessionError').textContent}`));
        if (sid) {
            await sleep(400);
            await page.click('#recordBtn');
            await waitFor(() => st(page, () => ['COMPLETED', 'IDLE'].includes(window.__sensorlab.controller.state)), 10000);
            await st(page, () => { window.__sensorlab.controller.acknowledge(); document.querySelectorAll('.toast').forEach(t => t.remove()); });
        }
    }
    await page.close();
}

// ═════════════════════════════ Scenario 7: phone-width layout ═════════════════════════════
console.log('\n[7] narrow (390 px) layout');
{
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    await page.goto(FILE_URL, { waitUntil: 'load' });
    await waitFor(() => st(page, () => !!window.__sensorlab), 10000);
    await startDemo(page, 1, 10);
    const m = await st(page, () => ({ overflow: document.documentElement.scrollWidth - window.innerWidth, sidebar: document.querySelector('.sidebar').getBoundingClientRect().height }));
    check('no horizontal scroll at 390 px; device panel visible', m.overflow <= 0 && m.sidebar > 100, JSON.stringify(m));
    await page.click('.device .dev-actions .btn:nth-child(2)');
    check('device settings dialog reachable at 390 px', await st(page, () => document.getElementById('deviceDialog').open));
    await page.close();
}

await browser.close();
try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* locked on Windows sometimes */ }
results.finishedAt = new Date().toISOString();
results.passed = results.checks.filter(c => c.ok).length;
results.failed = failures;
writeFileSync(path.join(root, 'test/e2e/results.json'), JSON.stringify(results, null, 2));
console.log(`\nE2E: ${results.passed} passed, ${failures} failed (results in test/e2e/results.json)`);
process.exit(failures ? 1 : 0);
