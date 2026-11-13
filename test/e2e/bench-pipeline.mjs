/**
 * SOFTWARE-PIPELINE capacity benchmark (SIMULATED). Demo devices generate SLTP packets inside the page, so this
 * measures the app's own parse → track → record → IndexedDB → chart path in headless Chrome on THIS machine,
 * plus the simulator's own cost. It says NOTHING about Bluetooth radio throughput, real devices, or other hosts.
 * Usage: npm run build && node test/e2e/bench-pipeline.mjs [seconds=30]
 */
import puppeteer from 'puppeteer-core';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SECONDS = Number(process.argv[2] || 30);
const CONFIGS = [{ devices: 1, hz: 10 }, { devices: 5, hz: 20 }, { devices: 8, hz: 50 }, { devices: 8, hz: 100 }, { devices: 8, hz: 200 }];
const CHROME = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find(p => existsSync(p));
const b = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 600_000 });
const results = [];
for (const cfg of CONFIGS) {
    const page = await b.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(pathToFileURL(path.join(root, 'dist/index.html')).href, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__sensorlab);
    const r = await page.evaluate(async ({ devices, hz, seconds }) => {
        const { connectView, service, controller, recorder } = window.__sensorlab;
        connectView.startDemo(devices, hz, {}, false);
        const sleep = (ms) => new Promise(res => setTimeout(res, ms));
        for (let i = 0; i < 100 && !service.list().every(e => e.conn.state === 'STREAMING'); i++) await sleep(100);
        const res = await controller.start({ name: `bench ${devices}x${hz}`, include: service.list().map(e => e.handle), keepAwake: false });
        if (!res.ok) return { error: res.stage };
        let maxLag = 0, last = performance.now();
        const lagTimer = setInterval(() => { const now = performance.now(); maxLag = Math.max(maxLag, now - last - 50); last = now; }, 50);
        const t0 = performance.now();
        await sleep(seconds * 1000);
        clearInterval(lagTimer);
        const atStop = service.list().map(e => ({ received: e.tracker.snapshot().received, missing: e.tracker.snapshot().missing, ch: e.channels.length }));
        const pendingMax = recorder.status().pending;
        const sum = await controller.stop();
        const elapsed = (performance.now() - t0) / 1000;
        const expectedSamples = devices * hz * elapsed;
        const received = atStop.reduce((a, d) => a + d.received, 0);
        return {
            ok: sum.ok, persisted: sum.persisted, unsaved: sum.unsaved, receivedSamples: received, expectedSamples: Math.round(expectedSamples),
            receivedReadingsPerS: Math.round(atStop.reduce((a, d) => a + d.received * d.ch, 0) / elapsed),
            appMissing: atStop.reduce((a, d) => a + d.missing, 0),
            storedEqualsReceived: sum.persisted === atStop.reduce((a, d) => a + d.received * d.ch, 0),
            maxEventLoopLagMs: Math.round(maxLag), pendingAtStop: pendingMax, sessionState: controller.state,
        };
    }, { ...cfg, seconds: SECONDS });
    results.push({ ...cfg, ...r });
    console.log(JSON.stringify({ ...cfg, ...r }));
    await page.close();
}
await b.close();
const out = { evidenceClass: 'SIMULATED (software pipeline only; demo devices in-page)', host: { cpus: cpus()[0]?.model, cores: cpus().length, platform: process.platform }, browser: CHROME, seconds: SECONDS, results, at: new Date().toISOString() };
writeFileSync(path.join(root, 'test/e2e/bench-results.json'), JSON.stringify(out, null, 2));
