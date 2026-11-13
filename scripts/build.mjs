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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

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
writeFileSync(path.join(dist, 'index.html'), html);
copyFileSync(path.join(root, 'css/styles.css'), path.join(dist, 'css/styles.css'));
for (const f of ['chart.umd.min.js', 'chart.js.LICENSE.md', 'VENDOR.md']) copyFileSync(path.join(root, 'vendor', f), path.join(dist, 'vendor', f));
copyFileSync(path.join(root, 'manifest.webmanifest'), path.join(dist, 'manifest.webmanifest'));
for (const f of ['icon-192.png', 'icon-512.png']) copyFileSync(path.join(root, 'icons', f), path.join(dist, 'icons', f));

const assets = ['./', 'index.html', 'sensorlab.js', 'css/styles.css', 'vendor/chart.umd.min.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
const sw = readFileSync(path.join(root, 'sw.template.js'), 'utf8')
    .replace('__SL_CACHE__', JSON.stringify('sensorlab-' + buildId))
    .replace('__SL_ASSETS__', JSON.stringify(assets));
writeFileSync(path.join(dist, 'sw.js'), sw);
writeFileSync(path.join(dist, 'BUILD.txt'), `SensorLab ${buildId}\nBuilt ${new Date().toISOString()}\nOpen index.html in Chrome or Edge. No internet or server required.\n`);
console.log(`built dist/ (${buildId})`);
