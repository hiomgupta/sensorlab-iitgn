/**
 * Project lint (no third-party linter needed):
 *  1. syntax check of every JS file (node --check)
 *  2. forbidden patterns in shipped source: HTML injection sinks, eval, remote URLs,
 *     and wall-clock use inside the acquisition/protocol layers
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
(function walk(d) {
    for (const f of readdirSync(d)) {
        if (['node_modules', 'dist', 'build', '.git', 'release', 'vendor'].includes(f)) continue;
        const p = path.join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(m?js)$/.test(f)) files.push(p);
    }
})(root);

let problems = 0;
const fail = (file, msg) => { problems++; console.log(`✖ ${path.relative(root, file)}: ${msg}`); };

for (const f of files) {
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
    catch (e) { fail(f, 'syntax error\n' + e.stderr.toString()); }
}

const RULES = [
    { re: /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\(/, msg: 'HTML injection sink (use textContent / h())', scope: /^src\// },
    { re: /\beval\s*\(|new Function\s*\(/, msg: 'dynamic code evaluation', scope: /^src\// },
    { re: /https?:\/\//, msg: 'remote URL in shipped code (offline-only product)', scope: /^(src\/|sw\.template\.js|index\.html|css\/)/ },
    { re: /Date\.now\(\)|new Date\(\)\.getTime\(\)/, msg: 'wall clock in acquisition/protocol layer (use injected monotonic clock)', scope: /^src\/(acquisition|protocol|transport)\// },
    { re: /\bfetch\s*\(|XMLHttpRequest|new WebSocket|EventSource|sendBeacon/, msg: 'network API in app code', scope: /^src\// },
];
const shipped = [...files, path.join(root, 'index.html'), path.join(root, 'css/styles.css')];
for (const f of shipped) {
    const rel = path.relative(root, f).replace(/\\/g, '/');
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
        for (const r of RULES) if (r.scope.test(rel) && r.re.test(line)) fail(f, `line ${i + 1}: ${r.msg}: ${line.trim().slice(0, 100)}`);
    });
}

console.log(problems ? `lint: ${problems} problem(s) in ${files.length} JS files` : `lint: OK (${files.length} JS files syntax-checked; security/offline rules clean)`);
process.exit(problems ? 1 : 0);
