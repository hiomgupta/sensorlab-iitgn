# SensorLab 2 — Offline Acceptance Test

## Current revalidation — 2026-11-11

The local bundle/offline checks pass (`npm.cmd run build`, `npm.cmd run audit:offline`): the build audit reports nine local files and CSP `connect-src 'none'`. The browser E2E also booted from `file://` with networking disabled and exercised local IndexedDB/export using simulated devices. Real BLE while offline remains **NOT RUN** because no physical ESP32 devices were attached; complete `HARDWARE_TEST_PLAN.md` C5 before offline laboratory acceptance is claimed.

**Status:** existing distribution static offline audit PASS; historical network-blocked package smoke PASS. The requested clean-computer, OS-restart, real-multiple-ESP32 acceptance sequence is **NOT RUN / BLOCKED**.  
**No production code was changed.**

## Acceptance verdict

The current application is designed for fully local execution: dependencies are bundled, runtime code has no network API, CSP blocks connections, and the optional service worker caches same-origin assets. Two launch modes are provided:

- `file://`: bundled classic script; no service worker; browser IndexedDB stores app data for that origin/profile.
- `http://localhost`: loopback static launcher; secure context for Web Bluetooth and service worker caching.
- Static HTTPS hosting is an optional static distribution model, not required for local/offline use.

Static and browser-simulated offline evidence exists. It does **not** establish that a never-online, restarted lab PC can connect to real BLE devices, acquire/record, export, and reopen real sessions.

## Dependency and network review

| Item | Finding |
|---|---|
| Runtime JavaScript | App source is bundled into `dist/sensorlab.js`; Chart.js 4.4.7 is vendored locally. No runtime CDN is needed. |
| Fonts/images/styles | CSS and styles are local; no remote font or analytics integration is identified. |
| Network APIs | App lint/offline audit reject `fetch`, XHR, WebSocket, EventSource, sendBeacon, WebTransport, dynamic import and related network APIs in runtime code. |
| CSP | `index.html` CSP includes `connect-src 'none'`, same-origin scripts/styles, no objects, no base URI, and no form actions. |
| Service worker | `sw.template.js` installs by precaching generated same-origin app assets; fetch handler ignores cross-origin and non-GET requests. It is registered only for supported HTTP(S) origins; `file://` uses the bundle without a service worker. |
| Local launcher | `tools/serve.mjs` binds `127.0.0.1`; PowerShell launcher listens on localhost. These are static file servers, not data backends. |
| Web Bluetooth secure context | Intended from `file://`, localhost, or HTTPS. Policy/browser support can still block BLE; actual radio access was not tested here. |
| Offline updates | Static build ID changes cache name; a later online visit to an HTTPS deployment can receive updates. No centralized service is needed. Offline machines require physical bundle replacement and checksum verification. |
| Data storage | IndexedDB remains local to browser origin/profile; `file://` and localhost data are separate. Browser storage eviction/quota is possible and persistence grant is best effort. |

## Test results and exact commands

### Executed in this audit

| Command | Result | Classification |
|---|---|---|
| `npm.cmd run audit:offline` | PASS: existing `dist/` had 9 files and met the static CSP/offline checks. `dist/BUILD.txt` says it was built 2026-11-06; this audit did not rebuild it or verify that it exactly matches the current source tree. | Static audit of existing build; does not execute hardware/BLE. |
| `npm.cmd run lint` | PASS: 63 JavaScript files syntax-checked and repository offline/security patterns clean. | Current source check. |
| `npm.cmd test` | PASS: 171 passed, 0 failed, 1 TODO. | Current unit suite; fake BLE/fake IndexedDB for relevant integration cases. |
| Network physically disabled, computer restarted, real ESP32 reconnect, export, close/reopen | NOT RUN | BLOCKED: no dedicated clean lab machine, physical network-isolation/restart session, or ESP32 hardware in this audit. |

### Prior repository evidence (not rerun for this audit)

- `docs/evidence/17-package-smoke.txt` reports package checksum/extraction and Chrome runs with proxy/DNS blocked and offline emulation. It exercised `file://` simulated recording, offline CSV/JSON/ZIP export and reload, and localhost service-worker cache reload after the launcher was stopped. It reports zero requests to non-loopback hosts.
- `docs/evidence/07-e2e.txt` reports `file://` network-offline run and HTTP service-worker offline reload, with zero non-local requests.
- `docs/evidence/06-audit-offline.txt` reports a static dist audit PASS.
- `docs/OFFLINE_VALIDATION.md` explicitly says a never-online PC and real Bluetooth from `file://` were not verified.

These are browser-network-blocked tests on a development host, with simulated devices. They are **not** evidence of successful BLE acquisition after a physical computer restart.

## Requested 10-step offline acceptance

| Step | Result | Evidence/limitation |
|---|---|---|
| 1. Install application bundle | Prior package extraction smoke PASS; clean never-online installation NOT RUN. | Historical `17-package-smoke.txt`; clean PC evidence absent. |
| 2. Disable Wi-Fi and Ethernet | NOT RUN at OS level. | Existing tests block network at browser/proxy/DNS layer. |
| 3. Restart computer | NOT RUN. | No system restart test. |
| 4. Launch app | Simulated `file://` and localhost launch PASS in prior browser smoke. | No clean-machine real-world launch. |
| 5. Connect multiple ESP32s | NOT RUN. | No physical BLE hardware. |
| 6. Acquire/record | Simulated package recording PASS historically; physical acquisition NOT RUN. | Fake/simulated only. |
| 7. Export | Simulated offline CSV/JSON/ZIP package smoke PASS historically. | No physical-run export. |
| 8. Close/reopen | Simulated IndexedDB persistence/reload PASS historically. | No OS-restart persistence check on a never-online machine. |
| 9. Verify old recordings | Simulated browser-profile history PASS historically. | Real hardware-recorded dataset not available. |
| 10. Verify no remote requests | Static audit PASS and browser network-blocked smoke reports zero non-loopback requests. | Not a packet capture from a physically disconnected/restarted PC. |

## Reproducible acceptance procedure

Follow `docs/OFFLINE_VALIDATION.md` and `docs/HARDWARE_TEST_PLAN.md`. Minimum release evidence:

1. On a connected build machine, run `npm ci`, `npm run build`, `npm run package`; move ZIP and SHA-256 sidecar to removable media.
2. On the target PC, physically disconnect Wi-Fi and Ethernet, verify network is unavailable, and record OS/browser/build/adapter details.
3. Verify SHA-256, extract package, launch from approved mode, and verify app startup without internet.
4. Close/reopen app and verify previous local session. Repeat after OS restart.
5. Test at least two real paired ESP32 devices; record acquisition quality and device-side sequence/time.
6. Record, stop, export CSV/JSON/ZIP, validate counts and integrity warnings, close/reopen, then inspect prior session.
7. On localhost mode, stop the static launcher and confirm cached shell behavior. This does not substitute for file mode or physical BLE test.
8. Save screenshots, network trace/blocked network state, app log, exported files/checksum, device firmware IDs, and a signed PASS/FAIL/BLOCKED checklist.

## Offline/privacy caveats

- Offline-only is not equivalent to encrypted or access-controlled local data. Browser profile users can access IndexedDB; Chrome's `file://` shared origin is a documented concern. Use separate OS/browser profiles on shared lab computers.
- No backend means no central account, remote backup, or centralized update mechanism. Local operator procedures must cover data export, retention, update, and deletion.
- A CSP or static scan cannot prove the OS/browser never attempts background network activity outside the app; validate the shipped package on the target machine.
- Browser/device policies can disable Web Bluetooth even when the network is offline.

## Source references

- CSP and local app shell: `index.html:1-14`.
- Service-worker installation, cache list and same-origin GET handling: `sw.template.js:1-25`; registration: `src/main.js:513`.
- Local Node launcher binding: `tools/serve.mjs:1-30`; PowerShell launcher: `tools/serve.ps1:1-31`.
- Offline static-audit checks: `scripts/audit-offline.mjs:1-90`.
- Network-blocked historical package test: `docs/evidence/17-package-smoke.txt`; limits of that evidence: `docs/OFFLINE_VALIDATION.md:25-56`.
- Actual BLE/browser support caveats: `docs/OFFLINE_DEPLOYMENT.md:12-42`.

**Release verdict:** offline design/software evidence is promising; the exact required offline acceptance on a restarted, never-online PC with multiple real devices is **BLOCKED** and remains a release gate.
