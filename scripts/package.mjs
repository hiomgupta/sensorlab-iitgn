/**
 * Create the offline distribution zip for other laboratories:
 *   release/sensorlab-<version>.zip  =  dist/ + launchers + firmware + key docs
 * Uses the project's own dependency-free ZIP writer.
 */
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZip } from '../src/export/zip.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(path.join(root, 'dist/index.html'))) { console.error('run npm run build first'); process.exit(1); }
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const top = `sensorlab-${version}`;
const entries = [];
const add = (src, dest) => entries.push({ name: `${top}/${dest}`, data: readFileSync(path.join(root, src)) });
(function walk(d, base) {
    for (const f of readdirSync(path.join(root, d)).sort()) {
        const rel = path.join(d, f);
        if (statSync(path.join(root, rel)).isDirectory()) walk(rel, `${base}${f}/`); else add(rel, base + f);
    }
})('dist', '');
add('tools/serve.ps1', 'serve.ps1');
add('tools/serve.mjs', 'tools/serve.mjs');
for (const f of ['sensorlab_node.ino', 'sltp.c', 'sltp.h']) add(`firmware/sensorlab_node/${f}`, `firmware/sensorlab_node/${f}`);
add('firmware/README.md', 'firmware/README.md');
for (const d of ['OFFLINE_DEPLOYMENT.md', 'PROTOCOL.md', 'EXPORT_SCHEMA.md', 'SECURITY.md', 'HARDWARE_TEST_PLAN.md']) add(`docs/${d}`, `docs/${d}`);
entries.push({ name: `${top}/START-HERE.txt`, data: [
    'SensorLab — offline Bluetooth sensor acquisition',
    '',
    '1. Unzip this folder anywhere (USB stick, Documents). No installation is needed.',
    '2. Open index.html in Google Chrome or Microsoft Edge (double-click, or drag it into the browser).',
    '3. If the browser blocks Bluetooth for files opened from disk (some managed PCs), right-click',
    '   serve.ps1 → "Run with PowerShell" instead. It serves the app on http://localhost only.',
    '',
    'No internet connection is used. Data is stored in this browser profile. Export it from History.',
    'See docs/OFFLINE_DEPLOYMENT.md for details and known limitations.',
    '',
].join('\r\n') });

const zip = buildZip(entries);
mkdirSync(path.join(root, 'release'), { recursive: true });
const out = path.join(root, 'release', `${top}.zip`);
writeFileSync(out, zip);
const sha = createHash('sha256').update(zip).digest('hex');
writeFileSync(out + '.sha256', `${sha}  ${top}.zip\n`);
console.log(`release/${top}.zip  ${(zip.length / 1024).toFixed(0)} KB  sha256 ${sha}  (${entries.length} files)`);
