/**
 * Verifies docs/TRACEABILITY.md against the repository and the raw evidence logs:
 *  - every implementation path in backticks exists
 *  - every «test title» passed (✔) and never failed (✖) in docs/evidence/03-unit.txt or 07-e2e.txt
 *  - «fw:OK» «audit:OK» «lint:OK» «ci:OK» resolve to exit=0 in the matching evidence file
 *  - PASS rows have ≥1 verified test; PARTIAL/BLOCKED rows state what is NOT TESTED
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE = process.env.EVIDENCE_DIR ? path.resolve(process.env.EVIDENCE_DIR) : path.join(root, 'docs/evidence');
const ev = (f) => readFileSync(path.join(EVIDENCE, f), 'utf8');
const unit = ev('03-unit.txt').split(/\r?\n/), e2e = ev('07-e2e.txt').split(/\r?\n/);
const TOKENS = {
    'fw:OK': () => /OK: 0 failure\(s\)/.test(ev('04-firmware.txt')) && /exit=0/.test(ev('04-firmware.txt')),
    'audit:OK': () => /offline audit: OK/.test(ev('06-audit-offline.txt')) && /exit=0/.test(ev('06-audit-offline.txt')),
    'lint:OK': () => /lint: OK/.test(ev('02-lint.txt')) && /exit=0/.test(ev('02-lint.txt')),
    'ci:OK': () => /exit=0/.test(ev('01-npm-ci.txt')),
    'pkg:OK': () => /package smoke: OK/.test(ev('17-package-smoke.txt')) && /exit=0/.test(ev('17-package-smoke.txt')),
    'repo:OK': () => /repo audit: OK/.test(ev('18-audit-repo.txt')) && /exit=0/.test(ev('18-audit-repo.txt')),
    'auditpkg:OK': () => /offline audit: OK/.test(ev('20-audit-offline-package.txt')) && /exit=0/.test(ev('20-audit-offline-package.txt')),
    'auditself:OK': () => /offline audit self-test: OK/.test(ev('21-audit-offline-selftest.txt')) && /exit=0/.test(ev('21-audit-offline-selftest.txt')),
    'fwdoc:OK': () => /OK: docs\/PROTOCOL\.md INFO example equals firmware output/.test(ev('04-firmware.txt')) && /exit=0/.test(ev('04-firmware.txt')),
    'fwcompile:OK': () => /COMPILED: esp32:esp32:esp32c3/.test(ev('14-firmware-compile.txt')) && /exit=0/.test(ev('14-firmware-compile.txt')),
};
function testPassed(title) {
    const passU = unit.some(l => l.startsWith('✔ ' + title + ' ('));
    const passE = e2e.some(l => l === '  ✔ ' + title || l.startsWith('  ✔ ' + title + ' — '));
    const failed = [...unit, ...e2e].some(l => l.includes('✖ ' + title));
    return (passU || passE) && !failed;
}

const rows = readFileSync(path.join(root, 'docs/TRACEABILITY.md'), 'utf8').split(/\r?\n/).filter(l => /^\| [A-Z]\d+ \|/.test(l));
let problems = 0, tests = 0;
const counts = {};
for (const row of rows) {
    const cells = row.split(' | ');
    const id = cells[0].replace('| ', '').trim();
    const [impl, testsCell, , status, remaining] = [cells[2], cells[3], cells[4], cells[5].trim(), cells[6] || ''];
    counts[status] = (counts[status] || 0) + 1;
    const bad = [];
    for (const m of impl.matchAll(/`([^`\s]+\.[a-z]+)`/g)) if (!existsSync(path.join(root, m[1]))) bad.push(`missing file ${m[1]}`);
    let verified = 0;
    for (const m of testsCell.matchAll(/«([^»]+)»/g)) {
        tests++;
        const ok = TOKENS[m[1]] ? TOKENS[m[1]]() : testPassed(m[1]);
        if (ok) verified++; else bad.push(`not verified: «${m[1]}»`);
    }
    if (!['PASS', 'PARTIAL', 'BLOCKED', 'FAIL'].includes(status)) bad.push(`bad status ${status}`);
    if (status === 'PASS' && verified === 0) bad.push('PASS without a verified test');
    if ((status === 'PARTIAL' || status === 'BLOCKED') && !/NOT TESTED/.test(remaining)) bad.push(`${status} row must say what is NOT TESTED`);
    if (bad.length) { problems += bad.length; console.log(`✖ ${id}: ${bad.join('; ')}`); }
    else console.log(`✔ ${id} ${status.padEnd(7)} ${verified} evidence reference(s) verified`);
}
console.log(`\ntraceability: ${rows.length} requirements, ${tests} evidence references, ${problems} problem(s); statuses ${JSON.stringify(counts)}`);
process.exit(problems ? 1 : 0);
