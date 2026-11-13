/**
 * Diagnosis: how large a single blob download does this Chrome complete, and do overlapping large downloads survive?
 * This measures the BROWSER (no SensorLab code), and it is what sets MAX_SINGLE_DOWNLOAD_BYTES in src/export/export.js.
 * Evidence class: ENV PROBE (headless Chrome on this PC; a headed browser on another PC may differ).
 *
 *   node test/e2e/diag-blob-download.mjs [sizesMB=400,500,520,600] [--overlap=256x4]
 */
import puppeteer from 'puppeteer-core';
import { mkdtempSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, totalmem } from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find(p => existsSync(p));
const argv = process.argv.slice(2);
const sizes = (argv.find(a => !a.startsWith('--')) || '400,500,520,600').split(',').map(Number);
const overlap = (argv.find(a => a.startsWith('--overlap=')) || '--overlap=256x4').slice(10).split('x').map(Number);

async function session() {
    const dl = mkdtempSync(path.join(tmpdir(), 'sl-blobdiag-'));
    const b = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 900_000, args: ['--js-flags=--max-old-space-size=8192'] });
    const bc = await b.target().createCDPSession();
    await bc.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl, eventsEnabled: true });
    const states = {};
    bc.on('Browser.downloadWillBegin', e => { states[e.guid] = { file: e.suggestedFilename, state: 'begun', MB: 0 }; });
    bc.on('Browser.downloadProgress', e => { if (states[e.guid]) Object.assign(states[e.guid], { state: e.state, MB: Math.round(e.receivedBytes / 1048576) }); });
    const p = await b.newPage();
    await p.goto('data:text/html,<p>blob download probe</p>');
    return { dl, b, p, states, version: await b.version() };
}
const makeAndClick = (p, mb, name) => p.evaluate((mb, name) => {
    const line = 'S1,sim:A,A,0,a,123456,617280000,617.28,1234567,123456,0.123456789,V,1,simulated\r\n';
    const chunk = line.repeat(Math.ceil(1048576 / line.length)).slice(0, 1048576);
    const parts = [];
    for (let i = 0; i < mb; i++) parts.push(chunk.slice(0));
    const blob = new Blob(parts, { type: 'text/csv' });
    (window.__keep ||= []).push(blob); // keep alive, as an un-revoked object URL would
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click();
}, mb, name);
const settled = async (states, n) => { for (let i = 0; i < 900; i++) { if (Object.values(states).filter(s => s.state === 'completed' || s.state === 'canceled').length >= n) return; await new Promise(r => setTimeout(r, 200)); } };

console.log(JSON.stringify({ probe: 'blob-download', ramGB: +(totalmem() / 2 ** 30).toFixed(1), chrome: CHROME }));
for (const mb of sizes) {
    const s = await session();
    await makeAndClick(s.p, mb, `single-${mb}.csv`);
    await settled(s.states, 1);
    const files = readdirSync(s.dl).map(f => `${f}:${Math.round(statSync(path.join(s.dl, f)).size / 1048576)}MB`);
    console.log(JSON.stringify({ test: 'single', mb, browser: s.version, download: Object.values(s.states)[0] || null, files }));
    await s.b.close(); rmSync(s.dl, { recursive: true, force: true });
}
{
    const [mb, count] = overlap;
    const s = await session();
    for (let k = 0; k < count; k++) { await makeAndClick(s.p, mb, `overlap-${k}.csv`); await new Promise(r => setTimeout(r, 1500)); }
    await settled(s.states, count);
    console.log(JSON.stringify({ test: 'overlapping (1.5 s apart)', mb, count, downloads: Object.values(s.states) }));
    await s.b.close(); rmSync(s.dl, { recursive: true, force: true });
}
{
    const [mb, count] = overlap;
    const s = await session();
    for (let k = 0; k < count; k++) { await makeAndClick(s.p, mb, `sequential-${k}.csv`); await settled(s.states, k + 1); }
    console.log(JSON.stringify({ test: 'sequential (each waits for the previous to complete; the app instructs this)', mb, count, downloads: Object.values(s.states) }));
    await s.b.close(); rmSync(s.dl, { recursive: true, force: true });
}
