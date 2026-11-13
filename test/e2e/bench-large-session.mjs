/**
 * Large-session limits and integrity (SIMULATED readings written directly to IndexedDB, headless Chrome).
 * For each N: history view time; CSV, JSON and ZIP export time, size, peak JS heap (sampled every 100 ms via CDP),
 * and FULL integrity of every exported record (count, per-series order, device/channel identity, values, no
 * duplicates or missing sequence numbers).
 *
 * Usage: node test/e2e/bench-large-session.mjs [N[,N2,…]=1000000] [--package]
 *   --package  run against the extracted release zip (the shipped app) instead of dist/
 */
import puppeteer from 'puppeteer-core';
import { mkdtempSync, readdirSync, statSync, existsSync, readFileSync, createReadStream, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const SIZES = (argv.find(a => !a.startsWith('--')) || '1000000').split(',').map(Number);
const ONLY = (argv.find(a => a.startsWith("--only=")) || "").slice(7) || null; // e.g. --only=csv (diagnosis)
const PART_GAP_MS = Number((argv.find(a => a.startsWith('--gap=')) || '').slice(6) || 3000); // pause between part saves
const usePackage = argv.includes('--package');
const CHROME = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find(p => existsSync(p));
const py = ['python', 'py', 'python3'].find(c => { try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } });

let appIndex = path.join(root, 'dist/index.html'), appLabel = 'dist/';
if (usePackage) {
    const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const zip = path.join(root, 'release', `sensorlab-${version}.zip`);
    const out = mkdtempSync(path.join(tmpdir(), 'sl-big-pkg-'));
    execFileSync(py, ['-I', '-c', 'import sys,zipfile;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, out]);
    appIndex = path.join(out, `sensorlab-${version}`, 'index.html');
    appLabel = path.basename(zip) + ' (extracted)';
}
console.log(JSON.stringify({ app: appLabel, chrome: CHROME, sizes: SIZES }));

// The generator: reading k → series (k % 2), seq = k >> 1, raw = k, value = sin(k/500), device time = k*5000 µs.
// Several files = the parts of one export, in order; each starts with its own header.
async function verifyCsv(filesIn, N) {
    const files = Array.isArray(filesIn) ? filesIn : [filesIn];
    let rows = 0, bad = 0, firstBad = null;
    const lastSeq = [-1, -1];
    for (const file of files) {
        const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
        let header = null;
        for await (const lineRaw of rl) {
            const line = lineRaw.replace(/^\uFEFF/, '');
            if (!header) { header = line.split(','); continue; }
            if (!line) continue;
            const c = line.split(',');
            const k = rows++;
            const ch = Number(c[3]), seq = Number(c[5]);
            const ok = c[1] === 'sim:A' && ch === k % 2 && seq === (k >> 1) && Number(c[6]) === k * 5000 && Number(c[9]) === k
                && Math.abs(Number(c[10]) - Math.sin(k / 500)) < 1e-12 && seq === lastSeq[ch] + 1;
            lastSeq[ch] = seq;
            if (!ok) { bad++; if (!firstBad) firstBad = line.slice(0, 120); }
        }
    }
    return { rows, bad, firstBad, complete: rows === N && bad === 0 };
}
function verifyJson(file, N) {
    const o = JSON.parse(readFileSync(file, 'utf8'));
    const rows = o.readings.rows;
    let bad = 0;
    for (let k = 0; k < rows.length; k++) {
        const r = rows[k];
        if (!(r[0] === 'sim:A' && r[1] === k % 2 && r[2] === (k >> 1) && r[3] === k * 5000 && r[6] === k && Math.abs(r[7] - Math.sin(k / 500)) < 1e-12)) bad++;
    }
    return { rows: rows.length, bad, complete: rows.length === N && bad === 0 };
}
async function verifyZip(filesIn, N) {
    const files = Array.isArray(filesIn) ? filesIn : [filesIn];
    const out = mkdtempSync(path.join(tmpdir(), 'sl-big-unzip-'));
    const csvs = files.map((file, i) => {
        const dest = path.join(out, `r${i}.csv`);
        execFileSync(py, ['-I', '-c', 'import sys,zipfile,shutil;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;n=[x for x in z.namelist() if x.startswith("readings")];assert len(n)==1 and "metadata.json" in z.namelist();shutil.copyfileobj(z.open(n[0]),open(sys.argv[2],"wb"))', file, dest]);
        return dest;
    });
    const r = await verifyCsv(csvs, N);
    rmSync(out, { recursive: true, force: true });
    return r;
}

const results = [];
let allOk = true;
for (const N of SIZES) {
    const dl = mkdtempSync(path.join(tmpdir(), 'sl-big-dl-'));
    const b = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 1_800_000, args: ['--js-flags=--max-old-space-size=8192'] });
    const bcdp = await b.target().createCDPSession();
    await bcdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl, eventsEnabled: true });
    let lastDl = null; // Chrome's own view of the download (state + bytes), so a failure says WHY no file appeared
    bcdp.on('Browser.downloadWillBegin', e => { lastDl = { file: e.suggestedFilename, state: 'begun', receivedMB: 0, totalMB: null }; });
    bcdp.on('Browser.downloadProgress', e => { if (lastDl) Object.assign(lastDl, { state: e.state, receivedMB: +(e.receivedBytes / 1048576).toFixed(1), totalMB: +(e.totalBytes / 1048576).toFixed(1) }); });
    const p = await b.newPage();
    const pageErrors = [];
    p.on('pageerror', e => pageErrors.push(e.message));
    p.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text()); });
    const cdp = await p.createCDPSession();
    await cdp.send('Performance.enable');
    let peak = 0, sampling = true;
    (async () => { while (sampling) { try { const m = (await cdp.send('Performance.getMetrics')).metrics.find(x => x.name === 'JSHeapUsedSize'); if (m && m.value > peak) peak = m.value; } catch { /* page busy/closed */ } await new Promise(r => setTimeout(r, 100)); } })();
    const resetPeak = async () => { peak = 0; await p.evaluate(() => { if (window.gc) window.gc(); }).catch(() => {}); };
    await p.goto(pathToFileURL(appIndex).href);
    await p.waitForFunction(() => !!window.__sensorlab);
    const writeMs = await p.evaluate(async (N) => {
        const { repo } = window.__sensorlab;
        await repo.createSession({ sessionId: 'big', name: 'big export', state: 'closed', startedWall: new Date().toISOString(), simulated: true,
            devices: { 'sim:A': { deviceId: 'sim:A', displayName: 'A', protocol: 'sltp/1', channels: [{ channelId: 0, name: 'a', unit: 'V' }, { channelId: 1, name: 'b', unit: '°C' }] } }, quality: {}, storage: { readingsPersisted: N } });
        const t = performance.now();
        for (let c = 0; c * 5000 < N; c++) {
            const n = Math.min(5000, N - c * 5000);
            const cols = { d: [], c: [], q: [], t: [], h: [], r: [], raw: [], v: [], f: [] };
            for (let i = 0; i < n; i++) { const k = c * 5000 + i; cols.d.push(0); cols.c.push(k % 2); cols.q.push(k >> 1); cols.t.push(k * 5000); cols.h.push(k * 5); cols.r.push(k * 0.005); cols.raw.push(k); cols.v.push(Math.sin(k / 500)); cols.f.push(64); }
            await repo.appendChunk('big', { chunkNo: c, n, wall: '', dict: ['sim:A'], cols }, {});
        }
        return Math.round(performance.now() - t);
    }, N);
    const res = { N, idbWriteMs: writeMs };
    await resetPeak();
    await p.click('#historyBtn');
    await p.waitForSelector('#histBody tr');
    let t0 = Date.now();
    await p.evaluate(() => [...document.querySelectorAll('#histBody tr')].find(tr => tr.textContent.includes('big export')).querySelector('button[aria-label^="View"]').click());
    await p.waitForFunction(() => document.getElementById('detailChartNote').textContent.length > 0, { timeout: 1_800_000 }).catch(() => null);
    res.history = { ms: Date.now() - t0, peakHeapMB: Math.round(peak / 1048576), note: (await p.evaluate(() => document.getElementById('detailChartNote').textContent).catch(() => '')).slice(0, 70) };
    // Wait for Chrome's own verdict on the next download (completed / canceled) and the file on disk.
    const waitDownload = async (ext, before) => {
        let f = null;
        for (let i = 0; i < 3000; i++) {
            await new Promise(r => setTimeout(r, 200));
            f = readdirSync(dl).find(x => x.endsWith(ext) && !before.has(x));
            if (lastDl?.state === 'canceled') return { file: null, state: lastDl };
            if (f && lastDl?.state === 'completed') return { file: f, state: lastDl };
            const err = await p.evaluate(() => [...document.querySelectorAll('.toast.error')].map(t => t.textContent).join(' ')).catch(() => '');
            if (err) return { file: null, state: lastDl, err };
        }
        return { file: f, state: lastDl };
    };
    for (const [btn, ext] of [['#exCsv', '.csv'], ['#exJson', '.json'], ['#exZip', '.zip']].filter(([, e]) => !ONLY || ONLY === e.slice(1))) {
        await resetPeak();
        const errBefore = pageErrors.length;
        t0 = Date.now();
        const before = new Set(readdirSync(dl));
        lastDl = null;
        // Start from a clean slate so only what THIS click produces is detected: no stale panel, toast or download state.
        await p.evaluate(() => { document.querySelectorAll('.toast').forEach(t => t.remove()); const e = document.getElementById('exportParts'); if (e) { e.replaceChildren(); e.hidden = true; } });
        const partButtons = `#exportParts button[aria-label$=", ${ext.slice(1).toUpperCase()}"]`;
        await p.click(btn);
        // Either a single download starts, the parts panel for THIS kind appears, or (JSON above the limit) an explanatory refusal.
        let mode = null;
        for (let i = 0; i < 3000 && !mode; i++) {
            await new Promise(r => setTimeout(r, 200));
            if (lastDl) mode = 'single';
            else if (await p.evaluate((sel) => !document.getElementById('exportParts').hidden && document.querySelectorAll(sel).length > 0, partButtons).catch(() => false)) mode = 'parts';
            else if (await p.evaluate(() => [...document.querySelectorAll('.toast.error')].some(t => /not started/.test(t.textContent))).catch(() => false)) mode = 'refused';
        }
        const files = [], downloads = [];
        if (mode === 'single') {
            const d = await waitDownload(ext, before);
            downloads.push(d.state);
            if (d.file) files.push(path.join(dl, d.file));
        } else if (mode === 'parts') {
            const n = await p.evaluate((sel) => document.querySelectorAll(sel).length, partButtons);
            for (let k = 0; k < n; k++) {
                if (k > 0) await new Promise(r => setTimeout(r, PART_GAP_MS)); // a person needs seconds between two clicks
                const seen = new Set(readdirSync(dl));
                lastDl = null;
                await p.evaluate((sel, k) => document.querySelectorAll(sel)[k].click(), partButtons, k);
                const d = await waitDownload(ext, seen); // one part at a time, as the app instructs the user
                downloads.push(d.state);
                if (!d.file) break;
                files.push(path.join(dl, d.file));
            }
            if (files.length !== n) downloads.push({ error: `only ${files.length} of ${n} parts saved` });
        }
        const ms = Date.now() - t0;
        const toast = await p.evaluate(() => [...document.querySelectorAll('.toast.error')].map(t => t.textContent).join(' ')).catch(() => '');
        const size = files.reduce((a, f) => a + statSync(f).size, 0);
        let integrity;
        if (mode === 'refused') {
            // Correct only for JSON, and only when the size named in the message really exceeds 256 MB.
            const m = /would be ([0-9.]+) (B|KB|MB|GB|TB)/.exec(toast);
            const mb = m ? Number(m[1]) * { B: 1 / 1048576, KB: 1 / 1024, MB: 1, GB: 1024, TB: 1048576 }[m[2]] : 0;
            integrity = { complete: false, refusedAsDesigned: ext === '.json' && mb > 256, refusedSizeMB: +mb.toFixed(1) };
        }
        else if (!files.length) integrity = { complete: false, error: 'no file written' };
        else {
            try { integrity = ext === '.csv' ? await verifyCsv(files, N) : ext === '.json' ? verifyJson(files[0], N) : await verifyZip(files, N); }
            catch (e) { integrity = { complete: false, error: e.message.slice(0, 160) }; }
        }
        res[ext.slice(1)] = { mode, parts: files.length, ms, MB: +(size / 1048576).toFixed(1), peakHeapMB: Math.round(peak / 1048576), ...integrity,
            userMessage: toast.slice(0, 220) || null, browserDownloads: downloads, pageErrors: pageErrors.slice(errBefore).slice(0, 2) };
        // A JSON refusal counts only when the size named in the message is above the 256 MB single-download limit.
        if (!(integrity.complete || integrity.refusedAsDesigned)) allOk = false;
        for (const f of files) rmSync(f, { force: true });
        await p.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove())).catch(() => {});
    }

    sampling = false;
    results.push(res);
    console.log(JSON.stringify(res));
    await b.close();
}
console.log(allOk ? 'large session: OK (every export complete and verified record-by-record)' : 'large session: INCOMPLETE OR FAILED EXPORT (see records above)');
process.exit(allOk ? 0 : 1);
