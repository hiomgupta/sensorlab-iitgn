/**
 * Full software verification run. Executes every check in order (continuing after failures) and writes raw
 * outputs to an evidence directory:  NN-name.txt  =  "# <UTC> $ <command>" + output + "exit=<code>".
 * The only transformation applied is replacing the user's home directory path with "~" (privacy); nothing else
 * is filtered. Ends with summary.txt / summary.json.
 *
 * Usage: node scripts/verify-all.mjs [evidenceDir=docs/evidence] [--skip-ci] [--no-bench] [--baseline]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dir = path.resolve(root, args.find(a => !a.startsWith('--')) || 'docs/evidence');
const skipCi = args.includes('--skip-ci'), noBench = args.includes('--no-bench');
const baseline = args.includes('--baseline'); // only commands that existed before the 2026-10-14 readiness audit
mkdirSync(dir, { recursive: true });
const home = homedir();
const redact = (s) => s.split(home).join('~').split(home.replace(/\\/g, '/')).join('~');

const STEPS = [
    ['01-npm-ci', 'npm ci', !skipCi],
    ['02-lint', 'npm run lint'],
    ['03-unit', 'npm test'],
    ['04-firmware', 'npm run test:firmware'],
    ['14-firmware-compile', 'npm run firmware:compile', 'optional'],
    ['05-build', 'npm run build'],
    ['06-audit-offline', 'npm run audit:offline'],
    ['07-e2e', 'npm run test:e2e'],
    ['08-e2e-repeat', 'npm run test:e2e'],
    ['09-package', 'npm run package'],
    ['17-package-smoke', 'npm run test:package'],
    ['20-audit-offline-package', 'npm run audit:offline -- --package', !baseline],
    ['21-audit-offline-selftest', 'npm run audit:offline -- --self-test', !baseline],
    ['16-bench-pipeline', 'node test/e2e/bench-pipeline.mjs 30', !noBench],
    ['19-large-session', baseline ? 'node test/e2e/bench-large-session.mjs 1000000' : 'node test/e2e/bench-large-session.mjs 1000000 --package', !noBench],
    ['10-coverage', 'node --test --experimental-test-coverage "--test-coverage-include=src/**" "test/unit/**/*.test.js"'],
    ['18-audit-repo', 'npm run audit:repo'],
    ['13-traceability', 'npm run verify:trace'],
];

const summary = [];
for (const [name, cmd, enabled = true] of STEPS) {
    if (enabled === false) { summary.push({ name, cmd, status: 'SKIPPED' }); continue; }
    const started = new Date().toISOString();
    const t0 = Date.now();
    const r = spawnSync(cmd, { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, EVIDENCE_DIR: dir, FORCE_COLOR: '0' } });
    const out = redact(`# ${started} $ ${cmd}\n${r.stdout || ''}${r.stderr || ''}exit=${r.status}\n`);
    writeFileSync(path.join(dir, name + '.txt'), out);
    if (name === '07-e2e' && existsSync(path.join(root, 'test/e2e/results.json'))) copyFileSync(path.join(root, 'test/e2e/results.json'), path.join(dir, 'e2e-results.json'));
    if (name === '16-bench-pipeline' && existsSync(path.join(root, 'test/e2e/bench-results.json'))) copyFileSync(path.join(root, 'test/e2e/bench-results.json'), path.join(dir, '16-bench-pipeline.json'));
    const status = r.status === 0 ? 'PASS' : (enabled === 'optional' && r.status === 2 ? 'NOT RUN (toolchain absent)' : 'FAIL');
    summary.push({ name, cmd, status, exit: r.status, seconds: Math.round((Date.now() - t0) / 1000) });
    console.log(`${status.padEnd(28)} ${name.padEnd(26)} ${cmd}`);
}
const text = summary.map(s => `${s.status.padEnd(28)} ${s.name.padEnd(26)} exit=${s.exit ?? '-'} ${s.seconds ?? '-'}s  ${s.cmd}`).join('\n');
writeFileSync(path.join(dir, 'summary.txt'), `# ${new Date().toISOString()} verify-all → ${path.relative(root, dir)}\n${text}\n`);
writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
const failed = summary.filter(s => s.status === 'FAIL');
console.log(failed.length ? `\nverify-all: ${failed.length} FAILED` : '\nverify-all: all executed steps passed');
process.exit(failed.length ? 1 : 0);
