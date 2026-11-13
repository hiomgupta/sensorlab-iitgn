/**
 * Static offline audit of the shipped product.
 *   node scripts/audit-offline.mjs              audit dist/
 *   node scripts/audit-offline.mjs --package    extract release/sensorlab-<v>.zip (independent unzip: Python zipfile) and audit it
 *   node scripts/audit-offline.mjs --self-test  plant known violations in a copy of dist/ and REQUIRE the audit to catch each one
 *
 * Fails on: remote URLs outside known license comments (loopback allowed only in the documented launchers);
 * remote <script>/<link>; CSS @import/url(); network APIs (fetch/XHR/WebSocket/EventSource/sendBeacon/WebTransport/
 * RTCPeerConnection/importScripts/dynamic import()) in app code; source maps; references to node_modules;
 * files referenced by index.html or the service-worker precache list that are missing; missing/weak CSP.
 */
import { readdirSync, readFileSync, statSync, mkdtempSync, cpSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMENT_URL_ALLOW = new Set(['https://www.chartjs.org', 'https://github.com/kurkle/color#readme']); // verified: Chart.js /*! */ license banners
const LAUNCHERS = new Set(['serve.ps1', 'tools/serve.mjs']); // may mention http://localhost / 127.0.0.1 only
const NON_RUNTIME = /\.(md|txt|ino|c|h)$/; // docs and firmware sources shipped for reference; not executed by the browser

export function audit(dir) {
    const files = [];
    (function walk(d) { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(p); } })(dir);
    const problems = [];
    const fail = (f, m) => problems.push(`${path.relative(dir, f).replace(/\\/g, '/')}: ${m}`);
    for (const f of files) {
        const rel = path.relative(dir, f).replace(/\\/g, '/');
        if (NON_RUNTIME.test(rel)) continue;
        const text = readFileSync(f, 'utf8');
        for (const m of text.matchAll(/https?:\/\/[^\s"'`<>)\]]+/g)) {
            const u = m[0].replace(/[.,;]+$/, '');
            if (COMMENT_URL_ALLOW.has(u) || u === 'http://x') continue;
            if (LAUNCHERS.has(rel) && /^http:\/\/(localhost|127\.0\.0\.1)([:/$]|$)/.test(u)) continue;
            fail(f, `remote URL ${u}`);
        }
        if (/\.map$/.test(rel) || /sourceMappingURL=/.test(text)) fail(f, 'source map shipped/referenced');
        if (/node_modules/.test(text) && !LAUNCHERS.has(rel)) fail(f, 'references node_modules');
        if (/\.html$/.test(rel)) {
            if (/<(script|link|img|iframe)[^>]+(src|href)=["']?(https?:)?\/\//i.test(text)) fail(f, 'remote script/stylesheet/resource');
            for (const m of text.matchAll(/<(?:script|link)[^>]+(?:src|href)=["']([^"':]+)["']/gi)) {
                if (!existsSync(path.join(path.dirname(f), m[1]))) fail(f, `referenced asset missing: ${m[1]}`);
            }
        }
        if (/\.css$/.test(rel) && /@import|url\((?!["']?data:)/.test(text)) fail(f, 'CSS import/url()');
        if (/\.(m?js)$/.test(rel) && rel !== 'sw.js' && !LAUNCHERS.has(rel)) {
            for (const api of ['XMLHttpRequest', 'new WebSocket', 'EventSource', 'sendBeacon', 'importScripts', 'WebTransport', 'RTCPeerConnection']) if (text.includes(api)) fail(f, `network API ${api}`);
            if (/\bfetch\s*\(/.test(text)) fail(f, 'fetch() in app code');
            if (/\bimport\s*\(/.test(text)) fail(f, 'dynamic import()');
        }
    }
    const indexPath = path.join(dir, 'index.html');
    const html = readFileSync(indexPath, 'utf8');
    const csp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1];
    if (!csp) fail(indexPath, 'no Content-Security-Policy');
    else {
        if (!/connect-src 'none'/.test(csp)) fail(indexPath, "CSP must contain connect-src 'none'");
        if (/https?:|\*/.test(csp)) fail(indexPath, 'CSP allows remote origins');
    }
    const swPath = path.join(dir, 'sw.js');
    if (!existsSync(swPath)) fail(indexPath, 'sw.js missing');
    else {
        const sw = readFileSync(swPath, 'utf8');
        if (!/url\.origin !== self\.location\.origin/.test(sw)) fail(swPath, 'service worker must ignore cross-origin requests');
        const assets = JSON.parse((sw.match(/const ASSETS = (\[[^\]]*\]);/) || [])[1] || '[]');
        if (!assets.length) fail(swPath, 'precache list not found');
        for (const a of assets) if (a !== './' && !existsSync(path.join(dir, a))) fail(swPath, `precached asset missing: ${a}`);
    }
    return { files: files.length, csp, problems };
}

function extractPackage() {
    const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const zip = path.join(root, 'release', `sensorlab-${version}.zip`);
    if (!existsSync(zip)) { console.error('release zip missing: run npm run build && npm run package'); process.exit(2); }
    const out = mkdtempSync(path.join(tmpdir(), 'sl-audit-pkg-'));
    const py = ['python', 'py', 'python3'].find(c => { try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } });
    execFileSync(py, ['-I', '-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;z.extractall(sys.argv[2])', zip, out]);
    return { dir: path.join(out, `sensorlab-${version}`), label: path.basename(zip) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const mode = process.argv.includes('--package') ? 'package' : process.argv.includes('--self-test') ? 'self-test' : 'dist';
    if (mode === 'self-test') {
        const copy = mkdtempSync(path.join(tmpdir(), 'sl-audit-self-'));
        cpSync(path.join(root, 'dist'), copy, { recursive: true });
        // [file, mutation, label, the SPECIFIC finding that must be reported (not merely "some problem")]
        const plants = [
            ['index.html', (t) => t.replace('</head>', '<script src="https://cdn.example.com/lib.js"></script></head>'), 'remote script', /^index\.html: remote (URL https:\/\/cdn\.example\.com|script)/],
            ['sensorlab.js', (t) => t + '\nfetch("/api/telemetry");', 'fetch() (same-origin path, no URL)', /^sensorlab\.js: fetch\(\) in app code/],
            ['sensorlab.js', (t) => t + '\nimport("./late.js");', 'dynamic import()', /^sensorlab\.js: dynamic import\(\)/],
            ['css/styles.css', (t) => t + '\n@import url("fonts.css");', 'CSS import (relative)', /^css\/styles\.css: CSS import/],
            ['sensorlab.js', (t) => t + '\n//# sourceMappingURL=sensorlab.js.map', 'source map', /^sensorlab\.js: source map/],
            ['index.html', (t) => t.replace(/(http-equiv="Content-Security-Policy" content="[^"]*?)connect-src 'none'/, "$1connect-src 'self'"), 'weakened CSP (in the meta tag, not the comment)', /CSP must contain connect-src 'none'/],
            ['sw.js', (t) => t.replace('"css/styles.css"', '"css/missing.css"'), 'missing precached asset', /precached asset missing: css\/missing\.css/],
            ['index.html', (t) => t.replace('src="sensorlab.js"', 'src="sensorlab-missing.js"'), 'missing referenced asset', /referenced asset missing: sensorlab-missing\.js/],
        ];
        let caught = 0;
        for (const [file, mutate, what, expect] of plants) {
            const dir = mkdtempSync(path.join(tmpdir(), 'sl-audit-plant-'));
            cpSync(copy, dir, { recursive: true });
            const before = readFileSync(path.join(dir, file), 'utf8');
            const after = mutate(before);
            if (after === before) { console.log(`  ✖ plant did not apply: ${what}`); continue; }
            writeFileSync(path.join(dir, file), after);
            const r = audit(dir);
            const hit = r.problems.find(p => expect.test(p));
            if (hit) caught++;
            console.log(`${hit ? '  ✔ caught' : '  ✖ MISSED'} planted ${what} → ${hit || 'expected finding not reported (' + r.problems.length + ' other problems)'}`);
        }
        const clean = audit(copy);
        console.log(`  ${clean.problems.length === 0 ? '✔' : '✖'} unmodified copy passes (${clean.problems.length} problems)`);
        const pass = caught === plants.length && clean.problems.length === 0;
        console.log(pass ? `offline audit self-test: OK (${caught}/${plants.length} planted violations caught)` : 'offline audit self-test: FAILED');
        process.exit(pass ? 0 : 1);
    }
    const target = mode === 'package' ? extractPackage() : { dir: path.join(root, 'dist'), label: 'dist/' };
    const r = audit(target.dir);
    console.log(r.problems.map(p => '✖ ' + p).join('\n'));
    console.log(r.problems.length ? `offline audit: ${r.problems.length} problem(s)` : `offline audit: OK (${r.files} files in ${target.label}; CSP: ${r.csp})`);
    process.exit(r.problems.length ? 1 : 0);
}
