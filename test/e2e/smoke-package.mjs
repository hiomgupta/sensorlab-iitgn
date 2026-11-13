/**
 * Offline-portability test of the RELEASE ARTIFACT, used the way a lab would use it.
 *  1. checksum + independent extraction (Python zipfile) into a new directory
 *  2. Chrome with a fresh profile and the network blocked AT THE BROWSER PROCESS (dead proxy + DNS mapped to
 *     nothing, loopback only), plus DevTools offline emulation for the file:// run
 *  3. file:// (documented primary mode): boot, record, finalize, History, CSV/JSON/ZIP export (row counts), reload
 *  4. capability honesty: Web Bluetooth absent → explanatory banner, history/export still available
 *  5. documented launcher serve.ps1 (Windows) from the extracted folder: service-worker precache verified, then the
 *     launcher is killed and the app reloads and records with no server and no network
 * Evidence class: SIMULATED INTEGRATION (demo devices). Same machine as the build: NOT a never-online-PC test.
 */
import puppeteer from 'puppeteer-core';
import { readFileSync, existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const zip = path.join(root, 'release', `sensorlab-${version}.zip`);
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '  ✔' : '  ✖'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
if (!existsSync(zip)) { console.error('NOT RUN: release zip missing (npm run build && npm run package)'); process.exit(2); }

// 1. checksum + extraction
const sha = createHash('sha256').update(readFileSync(zip)).digest('hex');
check('release zip matches its recorded SHA-256', sha === readFileSync(zip + '.sha256', 'utf8').split(/\s+/)[0], sha.slice(0, 16) + '…');
const dir = mkdtempSync(path.join(tmpdir(), 'sl-pkg-'));
const py = ['python', 'py', 'python3'].find(c => { try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } });
execFileSync(py, ['-I', '-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;z.extractall(sys.argv[2])', zip, dir]);
const top = path.join(dir, `sensorlab-${version}`);
for (const f of ['index.html', 'sensorlab.js', 'css/styles.css', 'vendor/chart.umd.min.js', 'sw.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'serve.ps1', 'START-HERE.txt', 'firmware/sensorlab_node/sensorlab_node.ino', 'docs/OFFLINE_DEPLOYMENT.md']) check(`package contains ${f}`, existsSync(path.join(top, f)));
const manifest = JSON.parse(readFileSync(path.join(top, 'manifest.webmanifest'), 'utf8'));
check('package manifest is installable with standalone mode and required icon sizes', manifest.display === 'standalone' && manifest.icons.some(i => i.sizes === '192x192') && manifest.icons.some(i => i.sizes === '512x512'));
check('package needs no node_modules / dev server (none shipped, none referenced by index.html)', !existsSync(path.join(top, 'node_modules')) && !/node_modules|src\/main\.js|type="module"/.test(readFileSync(path.join(top, 'index.html'), 'utf8')));

// 2. browser with process-level network block
const CHROME = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find(p => existsSync(p));
const dl = mkdtempSync(path.join(tmpdir(), 'sl-pkg-dl-'));
const b = await puppeteer.launch({
    executablePath: CHROME, headless: true, userDataDir: mkdtempSync(path.join(tmpdir(), 'sl-pkg-prof-')),
    args: ['--proxy-server=http://127.0.0.1:9', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1', '--no-first-run', '--no-default-browser-check'],
});
await (await b.target().createCDPSession()).send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl, eventsEnabled: true });
const nonLocal = [];
const watch = (page) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('request', r => { if (!/^(file|data|blob|chrome-extension):|^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(r.url())) nonLocal.push(r.url()); });
    return errors;
};
const until = async (page, fn, ms = 15000, arg) => { const t0 = Date.now(); for (;;) { const v = await page.evaluate(fn, arg).catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(100); } };
const download = async (page, sel, ext) => {
    const before = new Set(readdirSync(dl));
    await page.click(sel);
    for (let i = 0; i < 150; i++) {
        await sleep(100);
        const f = readdirSync(dl).find(x => x.endsWith(ext) && !before.has(x));
        if (f) { let s = -1; for (let k = 0; k < 30; k++) { await sleep(100); const n = statSync(path.join(dl, f)).size; if (n === s && n > 0) break; s = n; } return path.join(dl, f); }
    }
    return null;
};
async function recordDemo(page, name) {
    await page.evaluate(() => window.__sensorlab.connectView.startDemo(2, 20, {}, false));
    await until(page, () => window.__sensorlab.service.list().every(e => e.conn.state === 'STREAMING'));
    await page.click('#recordBtn');
    await page.waitForSelector('#sessionDialog[open]');
    await page.type('#sName', name);
    await page.waitForFunction(() => !document.getElementById('sessionStart').disabled);
    await page.click('#sessionStart');
    const started = await until(page, () => window.__sensorlab.controller.state === 'RECORDING');
    await sleep(2500);
    await page.click('#recordBtn');
    const fin = await until(page, () => /Finalized ✓/.test(document.getElementById('finalState').textContent));
    const stored = await page.evaluate(async (n) => { const s = (await window.__sensorlab.repo.listSessions()).find(x => x.name === n); return s ? { id: s.sessionId, n: s.storage.readingsPersisted, state: s.state } : null; }, name);
    return { started: !!started, fin: !!fin, stored };
}

// 3. file:// mode
console.log('[file://] extracted package, fresh profile, network blocked');
const page = await b.newPage();
await page.setViewport({ width: 1280, height: 860 });
const errs = watch(page);
const cdp = await page.createCDPSession();
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
const fileUrl = pathToFileURL(path.join(top, 'index.html')).href;
await page.goto(fileUrl, { waitUntil: 'load' });
check('boots from the extracted folder (file://) with no network', !!(await until(page, () => !!window.__sensorlab)));
const swOnFile = await page.evaluate(async () => {
    if (!navigator.serviceWorker) return 'no API';
    try { return `registrations: ${(await navigator.serviceWorker.getRegistrations()).length}`; } catch (e) { return `${e.name}: ${e.message.slice(0, 60)}`; }
});
check('no service worker on file:// (unsupported there by the browser; the app does not need one)', /SecurityError|no API|registrations: 0/.test(swOnFile), swOnFile);
const r1 = await recordDemo(page, 'portable file');
check('record → verified RECORDING → stop → finalized', r1.started && r1.fin && r1.stored?.state === 'closed' && r1.stored.n > 0, JSON.stringify(r1.stored));
await page.click('#historyBtn');
await page.waitForSelector('#histBody tr');
await page.evaluate(() => [...document.querySelectorAll('#histBody tr')].find(tr => tr.textContent.includes('portable file')).querySelector('button[aria-label^="View"]').click());
await page.waitForSelector('#histDetail:not([hidden])');
const csv = await download(page, '#exCsv', '.csv');
const csvRows = csv ? readFileSync(csv, 'utf8').split('\r\n').length - 2 : -1;
check('History → CSV export offline: one row per stored reading', csvRows === r1.stored.n, `${csvRows} rows / ${r1.stored.n} stored`);
const json = await download(page, '#exJson', '.json');
const jrows = json ? JSON.parse(readFileSync(json, 'utf8')).readings.rows.length : -1;
check('History → JSON export offline: complete', jrows === r1.stored.n, `${jrows} rows`);
const zipOut = await download(page, '#exZip', '.zip');
let zipOk = '';
try { zipOk = execFileSync(py, ['-I', '-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(",".join(sorted(z.namelist())))', zipOut]).toString().trim(); } catch (e) { zipOk = 'invalid: ' + e.message; }
check('History → ZIP bundle export offline: valid archive', zipOk === 'annotations.csv,metadata.json,readings.csv', zipOk);
await page.keyboard.press('Escape');
await page.reload({ waitUntil: 'load' });
await until(page, () => !!window.__sensorlab);
const afterReload = await page.evaluate(async (id) => { const s = await window.__sensorlab.repo.getSession(id); return s ? { state: s.state, n: s.storage.readingsPersisted } : null; }, r1.stored.id);
check('reload: session persisted in IndexedDB, still closed', afterReload?.state === 'closed' && afterReload.n === r1.stored.n, JSON.stringify(afterReload));
check('file:// run: no uncaught errors', errs.length === 0, errs.slice(0, 3).join(' | '));

// 4. capability honesty without Web Bluetooth
const nob = await b.newPage();
watch(nob);
await nob.evaluateOnNewDocument(() => { Object.defineProperty(Navigator.prototype, 'bluetooth', { get: () => undefined, configurable: true }); });
await nob.goto(fileUrl, { waitUntil: 'load' });
await until(nob, () => !!window.__sensorlab);
const honest = await nob.evaluate(() => ({ banner: !document.getElementById('bleBanner').hidden && /not available/.test(document.getElementById('bleBanner').textContent), chip: document.getElementById('bleChip').textContent }));
check('no Web Bluetooth: reported honestly (banner + chip); local data still accessible', honest.banner && /unsupported/.test(honest.chip), honest.chip);
await nob.close();

// 5. documented launcher serve.ps1 (Windows only) + service worker, then server killed
if (process.platform === 'win32') {
    console.log('[serve.ps1] documented launcher from the extracted folder');
    const port = 18000 + Math.floor(Math.random() * 1000);
    const srv = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(top, 'serve.ps1'), '-Port', String(port), '-NoBrowser'], { stdio: 'ignore' });
    const url = `http://localhost:${port}/index.html`;
    const p2 = await b.newPage();
    const errs2 = watch(p2);
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { await sleep(250); try { await p2.goto(url, { waitUntil: 'load', timeout: 3000 }); up = true; } catch { /* launcher starting */ } }
    check('serve.ps1 serves the extracted package on localhost', up);
    const sw = up ? await until(p2, async () => { const r = await navigator.serviceWorker.getRegistration(); if (!r?.active) return null; const keys = await caches.keys(); const c = await caches.open(keys.find(k => k.startsWith('sensorlab-'))); return { cache: keys, entries: (await c.keys()).map(q => new URL(q.url).pathname) }; }, 15000) : null;
    check('service worker active; precache holds the complete app shell', !!sw && ['/index.html', '/sensorlab.js', '/css/styles.css', '/vendor/chart.umd.min.js'].every(p => sw.entries.includes(p)), sw ? `${sw.cache.join(',')}: ${sw.entries.length} entries` : 'no SW');
    srv.kill();
    try { execFileSync('taskkill', ['/PID', String(srv.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
    await sleep(800);
    const c2 = await p2.createCDPSession();
    await c2.send('Network.enable');
    await c2.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await p2.reload({ waitUntil: 'load' });
    check('launcher killed + network offline: app reloads from the service-worker cache', !!(await until(p2, () => !!window.__sensorlab)));
    const r2 = await recordDemo(p2, 'portable sw');
    check('record → finalize works with no server and no network', r2.fin && r2.stored?.n > 0, JSON.stringify(r2.stored));
    check('launcher/SW run: no uncaught errors', errs2.filter(e => !/ERR_(CONNECTION_REFUSED|INTERNET_DISCONNECTED|PROXY_CONNECTION_FAILED)/.test(e)).length === 0, errs2.slice(0, 3).join(' | '));
} else console.log('  - serve.ps1 launcher test skipped (not Windows)');

check('zero requests to any non-loopback host across all runs', nonLocal.length === 0, nonLocal.slice(0, 3).join(' '));
const build = readFileSync(path.join(top, 'BUILD.txt'), 'utf8').split('\n')[0];
console.log(`package: ${path.basename(zip)} (${build})`);
await b.close();
console.log(fails ? `package smoke: ${fails} failure(s)` : 'package smoke: OK');
process.exit(fails ? 1 : 0);
