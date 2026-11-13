# Offline validation: what was tested, and how to repeat it

This covers the release ZIP as a lab PC receives it, not `dist/` in the development tree.
Deployment options are in `OFFLINE_DEPLOYMENT.md`.

## Automated checks (run on every `verify-all`)

| Check | Command | What it proves | Evidence file |
|---|---|---|---|
| Static offline audit of `dist/` | `npm run audit:offline` | No remote URLs or network APIs (fetch, XHR, WebSocket, EventSource, sendBeacon, importScripts, WebTransport, RTCPeerConnection, dynamic `import()`). No source maps or `node_modules` references. Every HTML/CSS-referenced asset exists. CSP has `connect-src 'none'`. The service worker has an origin guard and its precache list exists on disk | `06-audit-offline.txt` |
| Same audit on the **extracted release ZIP** | `npm run audit:offline -- --package` | The same checks on exactly the 21 shipped files. The launchers (`serve.ps1`, `tools/serve.mjs`) may contain loopback URLs only | `20-audit-offline-package.txt` |
| Audit self-test (negative control) | `npm run audit:offline -- --self-test` | 8 planted violations (remote script, same-origin `fetch()`, dynamic `import()`, CSS `@import`, sourcemap reference, weakened CSP, missing precached asset, missing referenced asset), each caught with its **specific** expected finding. An unmodified copy passes | `21-audit-offline-selftest.txt` |
| Package smoke test, network blocked | `npm run test:package` | 27 checks: checksum; extraction with Python `zipfile`; required files present; no `node_modules`. Then Chrome with `--proxy-server=http://127.0.0.1:9`, `--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"` **and** offline emulation: (1) `file://` boot → record → finalize → History CSV/JSON/ZIP with row counts → reload, data persists; (2) "no Bluetooth" is reported honestly; (3) `serve.ps1 -NoBrowser` on a random port → the service worker precaches 6 entries → the **launcher process is killed** → offline reload → record → finalize. Zero non-loopback requests | `17-package-smoke.txt` |

Defect found and fixed in this audit: the vendored Chart.js ended with `//# sourceMappingURL=chart.umd.min.js.map`, which
points to a file that is not shipped (DevTools tries to fetch it). `scripts/vendor.mjs` now strips it, and the audit
flags any sourcemap reference. See `vendor/VENDOR.md`.

## What was NOT verified

* **A PC that has never been online.** All runs used the development PC, with networking blocked at the browser
  (proxy, DNS and offline emulation). OS-level caches, certificate revocation and Windows SmartScreen prompts on a
  truly clean machine were not exercised. → Hardware checklist **C5**.
* **Real Bluetooth from `file://`** (vs `localhost`) → Hardware checklist **A4/A4b**.
* Managed-PC policies (Web Bluetooth guard, PowerShell execution policy) → see `OFFLINE_DEPLOYMENT.md`.

## Manual procedure (lab PC, about 15 minutes)

1. On a connected machine: `npm run build`, then `npm run package`. Copy `release\sensorlab-<v>.zip` **and** `.zip.sha256` to a USB stick.
2. On the lab PC, **disconnect the network first** (airplane mode and unplug Ethernet).
3. `Get-FileHash -Algorithm SHA256 sensorlab-<v>.zip` must equal the hash in the `.sha256` file.
4. Unzip (Explorer → Extract All). Double-click `index.html` → Chrome/Edge.
   Expected: the app loads with styles and icons, the status bar shows the build id, and no error appears in the Log.
5. Demo mode → Record → Stop. Expected: "Recording stopped and finalized." History → View → CSV, JSON and ZIP all download, and
   the browser's download list shows each one as completed.
6. F12 → Network tab → reload. Expected: only `file://` entries, none failed. (Console: a `SecurityError` about service workers on
   `file://` is normal and expected.)
7. Close the browser, reopen `index.html`. Expected: the session is still in History.
8. Launcher: right-click `serve.ps1` → *Run with PowerShell*. Repeat steps 4–7 at `http://localhost:8080/index.html`. Then close
   the PowerShell window and reload the page. Expected: it still loads from the service worker cache.
9. With real hardware: Part A of `HARDWARE_TEST_PLAN.md`, starting at A4.

Record the PC, OS build, browser version and every observation in `docs/evidence/hw-<date>/offline.md`.
