/**
 * Repository hygiene audit over the files that WOULD be committed (tracked + untracked, honouring .gitignore).
 * Fails on: credential-like content, private keys, env files, generated/build output, large binaries,
 * required ignore rules missing, or files needed to build/test that are ignored. Read-only: never stages anything.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
const candidates = [...new Set([...git('ls-files').split('\n'), ...git('ls-files', '--others', '--exclude-standard').split('\n')])]
    .filter(Boolean).filter(f => existsSync(path.join(root, f)));

const problems = [], notes = [];
const SECRET_RES = [
    [/AIza[0-9A-Za-z_-]{30,}/, 'Google API key'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
    [/\b(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/, 'GitHub token'],
    [/\bsk-[A-Za-z0-9]{32,}/, 'API secret key'],
    [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
    [/(password|passwd|secret|api[_-]?key)\s*[:=]\s*['"][^'"\s]{8,}['"]/i, 'hard-coded credential'],
];
const GENERATED = [/^node_modules\//, /^dist\//, /^build\//, /^release\//, /\.log$/, /^firmware\/test\/vectors\.h$/, /^test\/e2e\/results\.json$/, /(^|\/)\.env(\.|$)/];
const BINARY_OK = new Set(['icons/icon-192.png', 'icons/icon-512.png']);
for (const f of candidates) {
    if (GENERATED.some(re => re.test(f))) problems.push(`generated/local file would be committed: ${f}`);
    const size = statSync(path.join(root, f)).size;
    if (BINARY_OK.has(f)) { notes.push(`app icon: ${f} (${(size / 1024).toFixed(0)} KB)`); continue; }
    if (size > 1_000_000 && !/^docs\/evidence\//.test(f)) problems.push(`large file (${(size / 1e6).toFixed(1)} MB): ${f}`);
    if (/\.(png|jpg|zip|exe|bin|elf|pdf)$/i.test(f)) problems.push(`binary artifact: ${f}`);
    if (size > 5_000_000) continue;
    const text = readFileSync(path.join(root, f), 'utf8');
    for (const [re, what] of SECRET_RES) if (re.test(text)) problems.push(`${what} pattern in ${f}`);
}
const ignore = readFileSync(path.join(root, '.gitignore'), 'utf8');
for (const rule of ['node_modules/', 'dist/', 'build/', 'release/', '.env']) if (!ignore.split(/\r?\n/).some(l => l.trim() === rule)) problems.push(`.gitignore lacks ${rule}`);
const REQUIRED = ['package.json', 'package-lock.json', 'index.html', 'css/styles.css', 'src/main.js', 'vendor/chart.umd.min.js', 'sw.template.js', 'manifest.webmanifest',
    'icons/sensorlab.svg', 'icons/icon-192.png', 'icons/icon-512.png',
    'scripts/build.mjs', 'scripts/lint.mjs', 'scripts/audit-offline.mjs', 'scripts/verify-traceability.mjs', 'scripts/package.mjs', 'scripts/vendor.mjs',
    'test/e2e/run-e2e.mjs', 'test/firmware/run-c-tests.mjs', 'test/firmware/compile-sketch.mjs', 'test/fixtures/sltp-v1-vectors.json',
    'firmware/sensorlab_node/sensorlab_node.ino', 'firmware/sensorlab_node/sltp.c', 'firmware/sensorlab_node/sltp.h', 'firmware/test/test_sltp.c',
    'tools/serve.ps1', 'tools/serve.mjs', '.github/workflows/ci.yml', 'README.md'];
for (const r of REQUIRED) if (!candidates.includes(r)) problems.push(`required file missing or ignored: ${r}`);
const staged = git('diff', '--cached', '--name-status').trim();
const deletedStaged = staged.split('\n').filter(l => l.startsWith('D\t')).map(l => l.slice(2));
for (const d of deletedStaged) if (!d.startsWith('js/')) problems.push(`unexpected staged deletion: ${d}`);
notes.push(`staged deletions: ${deletedStaged.length} (${deletedStaged.join(', ') || 'none'}); legacy 1.x files replaced by src/ (content preserved in commit 25dbe42)`);
notes.push(`${candidates.length} files would be part of a commit of this tree`);
console.log(notes.map(n => 'ℹ ' + n).join('\n'));
console.log(problems.map(p => '✖ ' + p).join('\n'));
console.log(problems.length ? `repo audit: ${problems.length} problem(s)` : 'repo audit: OK (no secrets, no generated artifacts, required files present, ignore rules present)');
process.exit(problems.length ? 1 : 0);
