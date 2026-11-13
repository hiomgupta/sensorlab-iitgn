/**
 * Copy a raw log into the evidence tree, replacing ONLY the user's home-directory path with "~".
 * Usage: node scripts/redact-copy.mjs <src> <dest> ["header line"]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const [src, dest, header] = process.argv.slice(2);
if (!src || !dest) { console.error('usage: redact-copy <src> <dest> [header]'); process.exit(2); }
const h = homedir();
const text = readFileSync(src, 'utf8').split(h).join('~').split(h.replace(/\\/g, '/')).join('~');
mkdirSync(path.dirname(dest), { recursive: true });
writeFileSync(dest, (header ? `# ${new Date().toISOString()} ${header}\n` : '') + text);
console.log(`${dest} (${text.length} bytes)`);
