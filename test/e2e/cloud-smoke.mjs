/**
 * Offline smoke test of the opt-in Firebase bundle, without contacting Firebase.
 * Uses an isolated test build; never replaces the user's configured dist/ edition.
 */
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'build', 'test-app');
const chrome = process.env.CHROME_PATH || [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(file => existsSync(file));
if (!chrome) throw new Error('Chrome/Edge is required; set CHROME_PATH.');
const profile = mkdtempSync(path.join(tmpdir(), 'sl-cloud-smoke-'));
const build = path.join(root, 'scripts', 'build.mjs');
let browser, server;
try {
    execFileSync(process.execPath, [build, '--test-output', '--cloud-config', path.join(root, 'test', 'fixtures', 'firebase-config.json')], { cwd: root, stdio: 'inherit' });
    const sw = await readFile(path.join(dist, 'sw.js'), 'utf8');
    assert.ok(sw.includes('"cloud.js"'), 'Firebase bundle must be precached');
    server = http.createServer(async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        let file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname);
        if ((await stat(file).catch(() => null))?.isDirectory()) file = path.join(file, 'index.html');
        try {
            const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.webmanifest') ? 'application/manifest+json' : 'text/html';
            response.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' }).end(await readFile(file));
        } catch { response.writeHead(404).end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: profile });
    const page = await browser.newPage();
    const errors = [], remote = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
        if (/^https?:/.test(request.url()) && !request.url().startsWith(url)) {
            remote.push(request.url());
            request.abort();
        } else request.continue();
    });
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__sensorlab?.cloud && document.getElementById('profileAuthState').textContent === 'Signed out');
    await page.click('#profileBtn');
    await page.waitForSelector('#profileDialog[open]');
    assert.equal(await page.$eval('#cloudSignIn', el => el.disabled), false);
    await page.waitForFunction(() => document.getElementById('profileTotal').textContent === '0');
    assert.ok(await page.$eval('#profileHistoryState', el => el.textContent.includes('No recordings yet')));
    const accountStates = await page.evaluate(() => {
        const view = window.__sensorlab.profile;
        const account = { uid: 'ui-only-account', displayName: 'Test <b>Researcher</b>', email: 'researcher@example.test' };
        const cloud = { user: account, getAccount: () => account, status: { phase: 'idle', message: 'Cloud backup is up to date.', pending: 0 } };
        view.setCloud(cloud);
        const signedIn = {
            header: document.getElementById('profileAuthState').textContent,
            name: document.getElementById('profileName').textContent,
            injectedMarkup: !!document.getElementById('profileName').querySelector('b'),
            signInAction: document.getElementById('cloudSignIn').textContent,
        };
        cloud.user = null;
        view.updateCloud({ authBusy: false, syncing: false });
        const remembered = document.getElementById('profileAuthState').textContent;
        view.setSyncStatus({ phase: 'error', message: 'Test backup failure.', pending: 1 });
        const failure = document.getElementById('profileBackupState').textContent;
        view.setCloud(window.__sensorlab.cloud);
        return { signedIn, remembered, failure };
    });
    assert.deepEqual(accountStates, {
        signedIn: { header: 'Signed in', name: 'Test <b>Researcher</b>', injectedMarkup: false, signInAction: 'Switch Google account' },
        remembered: 'Sign-in needed', failure: 'Needs attention',
    });
    await page.keyboard.press('Escape');
    await page.evaluate(async () => {
        await window.__sensorlab.repo.setMeta('cloud-account', { uid: 'offline-test-owner', displayName: 'Offline test owner' });
        await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__sensorlab?.cloud && document.getElementById('profileName').textContent === 'Offline test owner');
    await page.click('#profileBtn');
    assert.equal(await page.$eval('#profileAuthState', el => el.textContent), 'Sign-in needed');
    assert.equal(await page.$eval('#profileBackupState', el => el.textContent), 'Offline');
    assert.equal(await page.$eval('#cloudSignIn', el => el.disabled), true);
    assert.equal(await page.$eval('#cloudSignOut', el => el.disabled), false, 'sign-out remains available offline');
    await page.keyboard.press('Escape');
    await page.click('#demoBtn');
    await page.$eval('#demoCount', el => { el.value = '1'; });
    await page.click('#demoForm button[type=submit]');
    await page.waitForFunction(() => window.__sensorlab.service.list().some(entry => entry.conn.state === 'STREAMING'));
    await page.click('#recordBtn');
    await page.waitForSelector('#sessionDialog[open]');
    await page.$eval('#sName', el => { el.value = 'cloud edition offline recording'; });
    await page.waitForFunction(() => !document.getElementById('sessionStart').disabled);
    await page.click('#sessionStart');
    await page.waitForFunction(() => window.__sensorlab.controller.state === 'RECORDING');
    await page.waitForFunction(() => window.__sensorlab.recorder.status().persisted > 0);
    await page.click('#recordBtn');
    await page.waitForFunction(() => window.__sensorlab.recorder.state === 'idle');
    const stored = await page.evaluate(async () => (await window.__sensorlab.repo.listSessions())[0]);
    assert.equal(stored.state, 'closed');
    assert.equal(stored.cloudOwnerUid, 'offline-test-owner');
    assert.equal(stored.cloudUploadedAt, null);
    assert.ok(stored.storage.readingsPersisted > 0);
    await page.click('#historyBtn');
    await page.waitForSelector('#histTable:not([hidden])');
    assert.ok(await page.$eval('#histBody', el => el.textContent.includes('Pending backup')));
    await page.keyboard.press('Escape');
    await page.click('#profileBtn');
    await page.waitForFunction(() => document.getElementById('profileTotal').textContent === '1' && document.getElementById('profilePending').textContent === '1');
    assert.equal(await page.$eval('#profileLocal', el => el.textContent), '0');
    assert.equal(await page.$$eval('#profileRecent button', buttons => buttons.length), 1);
    await page.click('#profileRecent button');
    await page.waitForSelector('#histDetail:not([hidden])');
    assert.equal(await page.$eval('#detailTitle', el => el.textContent), 'cloud edition offline recording');
    assert.equal(await page.$eval('#profileDialog', el => el.open), false);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'profileBtn', 'recent-history navigation returns focus to visible Profile trigger');
    await page.click('#profileBtn');
    await page.click('#profileHistoryBtn');
    await page.waitForSelector('#histTable:not([hidden])');
    assert.equal(await page.$eval('#profileDialog', el => el.open), false);
    await page.keyboard.press('Escape');
    await page.click('#profileBtn');
    await page.click('#cloudSignOut');
    await page.waitForFunction(() => document.getElementById('profileAuthState').textContent === 'Signed out');
    assert.equal(await page.evaluate(() => window.__sensorlab.repo.getMeta('cloud-account')), null);
    await page.keyboard.press('Escape');
    await page.setViewport({ width: 390, height: 844 });
    await page.click('#profileBtn');
    const mobile = await page.evaluate(() => {
        const view = window.__sensorlab.profile;
        const account = { uid: 'ui-only-mobile', displayName: 'LongName'.repeat(35), email: 'verylong'.repeat(20) + '@example.test' };
        view.setCloud({ user: account, getAccount: () => account, status: { phase: 'idle', message: 'Up to date.', pending: 0 } });
        const dialog = document.getElementById('profileDialog');
        const result = { pageOverflow: document.documentElement.scrollWidth - innerWidth, dialogOverflow: dialog.scrollWidth - dialog.clientWidth };
        view.setCloud(window.__sensorlab.cloud);
        return result;
    });
    assert.ok(mobile.pageOverflow <= 1 && mobile.dialogOverflow <= 1, 'long profile names/emails must not overflow at 390px');
    assert.equal(remote.length, 0, 'signed-out/offline cloud edition must not contact remote services');
    assert.deepEqual(errors, []);
    const local = await browser.newPage();
    await local.goto(pathToFileURL(path.join(dist, 'index.html')).href, { waitUntil: 'load' });
    await local.waitForFunction(() => window.__sensorlab && document.getElementById('cloudStatus').textContent.includes('HTTPS-hosted'));
    assert.equal(await local.$eval('#cloudSignIn', el => el.disabled), true);
    console.log('cloud smoke: OK (profile account states, connected history/focus, mobile layout, offline recording/sign-out, zero remote requests, file:// fallback)');
} finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    rmSync(profile, { recursive: true, force: true });
    rmSync(dist, { recursive: true, force: true });
}
