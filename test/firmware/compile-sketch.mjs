/**
 * Compiles the real Arduino sketch (firmware/sensorlab_node) for the documented target with arduino-cli.
 * Evidence class: BUILD (compiles). This is NOT flashing and NOT a hardware test.
 *
 * Toolchain: ARDUINO_CLI / ARDUINO_CONFIG env vars, or the local install under build/arduino
 * (see docs/HARDWARE_TEST_PLAN.md). Exits 2 with "NOT RUN" if no toolchain is present.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = process.env.ARDUINO_CLI || path.join(root, 'build/arduino/cli', process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli');
const cfg = process.env.ARDUINO_CONFIG || path.join(root, 'build/arduino/arduino-cli.yaml');
const FQBN = process.env.FQBN || 'esp32:esp32:esp32c3';
if (!existsSync(cli)) { console.error(`NOT RUN: arduino-cli not found at ${cli}. Firmware compile is unverified on this machine.`); process.exit(2); }
const args = existsSync(cfg) ? ['--config-file', cfg] : [];
const run = (a) => execFileSync(cli, [...args, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
console.log(run(['version']).trim());
console.log(run(['core', 'list']).trim());
try {
    const out = execFileSync(cli, [...args, 'compile', '--fqbn', FQBN, '--warnings', 'all', '--output-dir', path.join(root, 'build/fw-out'), path.join(root, 'firmware/sensorlab_node')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(out.trim());
    console.log(`COMPILED: ${FQBN}`);
} catch (e) {
    console.log((e.stdout || '') + (e.stderr || ''));
    console.error(`COMPILE FAILED: ${FQBN}`);
    process.exit(1);
}
