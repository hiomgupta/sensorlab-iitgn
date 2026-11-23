/**
 * Build dist/: a self-contained offline bundle that runs from file:// (no server, no install)
 * and from any static HTTPS host (service worker precaches everything).
 *
 * ES modules cannot be imported on file:// in Chrome (CORS, origin "null"), so the app is
 * bundled into one classic script.
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCloudConfig, cloudCsp } from './cloud-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = process.argv.includes('--test-output') ? path.join(root, 'build', 'test-app') : path.join(root, 'dist');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const cloudFlag = process.argv.indexOf('--cloud-config');
if (cloudFlag !== -1 && !process.argv[cloudFlag + 1]) throw new Error('--cloud-config requires a path to public Firebase web configuration.');
const cloudConfig = cloudFlag === -1 ? null : validateCloudConfig(JSON.parse(readFileSync(path.resolve(process.argv[cloudFlag + 1]), 'utf8')));

rmSync(dist, { recursive: true, force: true });
mkdirSync(path.join(dist, 'css'), { recursive: true });
mkdirSync(path.join(dist, 'vendor'), { recursive: true });
mkdirSync(path.join(dist, 'icons'), { recursive: true });

const srcHash = createHash('sha256');
(function walk(d) {
    for (const f of readdirSync(d).sort()) {
        const p = path.join(d, f);
        if (statSync(p).isDirectory()) walk(p); else srcHash.update(f).update(readFileSync(p));
    }
})(path.join(root, 'src'));
if (cloudConfig) srcHash.update(JSON.stringify(cloudConfig)).update(readFileSync(path.join(root, 'package-lock.json')));
for (const f of ['index.html', 'css/styles.css', 'vendor/chart.umd.min.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'sw.template.js']) {
    srcHash.update(f).update(readFileSync(path.join(root, f)));
}
const buildId = `${pkg.version}+${srcHash.digest('hex').slice(0, 12)}`;

await build({
    entryPoints: [path.join(root, 'src/main.js')],
    bundle: true,
    format: 'iife',
    target: ['chrome100', 'edge100'],
    outfile: path.join(dist, 'sensorlab.js'),
    define: { __SL_BUILD__: JSON.stringify(buildId) },
    legalComments: 'none',
    sourcemap: false,
    minify: false, // readable for lab audits; size is small
    logLevel: 'warning',
});

let html = readFileSync(path.join(root, 'index.html'), 'utf8');
const entry = /<!--SL:ENTRY-->[\s\S]*?<!--\/SL:ENTRY-->/;
if (!entry.test(html)) throw new Error('index.html entry marker not found');
html = html.replace(entry, '<script src="sensorlab.js" defer></script>');
if (cloudConfig) {
    await build({
        entryPoints: [path.join(root, 'src/cloud/main.js')],
        bundle: true, format: 'iife', target: ['chrome100', 'edge100'],
        outfile: path.join(dist, 'cloud.js'),
        define: { __SL_FIREBASE_CONFIG__: JSON.stringify(cloudConfig) },
        legalComments: 'eof', sourcemap: false, minify: true, logLevel: 'warning',
    });
    html = html.replace(/http-equiv="Content-Security-Policy" content="[^"]+"/, `http-equiv="Content-Security-Policy" content="${cloudCsp(cloudConfig)}"`);
    html = html.replace('</head>', '<script src="cloud.js" defer></script>\n</head>');
    html = html.replace('<!-- Offline by construction: no remote origins may be contacted. connect-src \'none\' blocks fetch/XHR/WebSocket to anywhere. -->',
        '<!-- Optional cloud build: only Firebase Auth, Firestore, and the Google sign-in helper are allowed. -->');
}
writeFileSync(path.join(dist, 'index.html'), html);
copyFileSync(path.join(root, 'css/styles.css'), path.join(dist, 'css/styles.css'));
for (const f of ['chart.umd.min.js', 'chart.js.LICENSE.md', 'VENDOR.md']) copyFileSync(path.join(root, 'vendor', f), path.join(dist, 'vendor', f));
copyFileSync(path.join(root, 'manifest.webmanifest'), path.join(dist, 'manifest.webmanifest'));
for (const f of ['icon-192.png', 'icon-512.png']) copyFileSync(path.join(root, 'icons', f), path.join(dist, 'icons', f));

const assets = ['./', 'index.html', 'sensorlab.js', 'css/styles.css', 'vendor/chart.umd.min.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
if (cloudConfig) assets.push('cloud.js');
const sw = readFileSync(path.join(root, 'sw.template.js'), 'utf8')
    .replace('__SL_CACHE__', JSON.stringify('sensorlab-' + buildId))
    .replace('__SL_ASSETS__', JSON.stringify(assets));
writeFileSync(path.join(dist, 'sw.js'), sw);
writeFileSync(path.join(dist, 'BUILD.txt'), `SensorLab ${buildId}\nBuilt ${new Date().toISOString()}\n${cloudConfig ? 'Optional Firebase backup enabled. Host over HTTPS for Google sign-in; recording still works offline.' : 'Open index.html in Chrome or Edge. No internet or server required.'}\n`);
if (cloudConfig) writeFileSync(path.join(dist, 'CLOUD.txt'), `Optional cloud build for ${cloudConfig.projectId}.\nStrict offline audit applies to the default build, not this opt-in network-enabled build.\n`);
console.log(`built ${path.relative(root, dist)} (${buildId}${cloudConfig ? '; optional Firebase cloud backup' : '; offline-only'})`);
