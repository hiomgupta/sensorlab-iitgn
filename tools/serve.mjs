/**
 * Minimal static file server bound to 127.0.0.1 only (never the LAN).
 * A fallback for machines where policy blocks Web Bluetooth on file:// pages.
 * Usage: node tools/serve.mjs [dir=dist] [port=8080]
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || 'dist');
const port = Number(process.argv[3] || 8080);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
    try {
        const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        let p = path.resolve(dir, '.' + urlPath);
        if (p !== dir && !p.startsWith(dir + path.sep)) { res.writeHead(403).end(); return; } // no escaping the served folder
        if ((await stat(p).catch(() => null))?.isDirectory()) p = path.join(p, 'index.html');
        const body = await readFile(p);
        res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
        res.end(body);
    } catch {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
});
server.listen(port, '127.0.0.1', () => console.log(`SensorLab serving ${dir} at http://localhost:${port}/ (local only). Press Ctrl+C to stop.`));
