# SensorLab 2 — Validation Report

Date: 2026-10-12. Author: Claude (engineering owner per the handoff). Raw command outputs: `docs/evidence/`.

Evidence classes used: `STATIC REVIEW` · `UNIT TEST` · `SIMULATED INTEGRATION` · `REAL BLE INTEGRATION` ·
`PHYSICAL MEASUREMENT` · `NOT TESTED`. An `ENV PROBE` is a scripted check of the browser or OS environment on this machine.

> **Headline:** application logic, storage, recovery, export and offline operation pass every automated check
> (unit tests, firmware serialization vectors, browser E2E checks in headless Chrome 154, and a traceability matrix machine-checked against the raw logs).
> **Current counts and results are in `docs/FINAL_SOFTWARE_READINESS_REPORT.md` and `docs/evidence/summary.txt`.** Dated sections below keep the numbers of their own run.
> **No physical Bluetooth device was available. Nothing in this report is a REAL BLE INTEGRATION or a PHYSICAL MEASUREMENT.**

---

## Update 2026-10-14 — verification review (supersedes earlier counts)

The suggested verification plan was reviewed item by item in `docs/TEST_REVIEW.md`. Authoritative run from a clean `npm ci` on 2026-10-14
(raw logs in `docs/evidence/`):

| Check | Result | Log |
|---|---|---|
| `npm test` | **127 passed / 0 failed / 0 skipped** | `03-unit.txt` |
| Coverage of `src/` (non-UI) | 96.93 % lines / 82.24 % branches | `10-coverage.txt` |
| `npm run test:e2e` (Chrome 154 headless, simulated devices) | **81 passed / 0 failed**, on two consecutive runs | `07-e2e.txt`, `08-e2e-repeat.txt` |
| `npm run test:firmware` / `npm run firmware:compile` | OK / COMPILED esp32c3 (603,229 B) | `04`, `14-*.txt` |
| `npm run audit:offline`, `lint`, `build`, `package` | exit 0 | `06`, `02`, `05`, `09-*.txt` |
| `npm run test:package` (release zip: checksum, independent unzip, offline boot, record, finalize) | OK | `17-package-smoke.txt` |
| `npm run audit:repo` (secrets, generated artifacts, required files) | OK: 115 files, no secrets or generated artifacts | `18-audit-repo.txt` |
| Software-pipeline benchmark (SIMULATED) | up to 2,638 readings/s stored = received, 0 app-side gaps | `16-bench-pipeline.*` |
| 1,000,000-reading session (SIMULATED) | view 0.47 s; CSV 2.9 s / 89 MB complete; JSON 2.3 s complete | `19-large-session.txt` |
| `npm run verify:trace` | 54 requirements, 173 references, 0 problems (PASS 30 / PARTIAL 16 / BLOCKED 7 / FAIL 1); the negative control rejects a fabricated title (exit 1) | `13-traceability.txt`, `15-traceability-negative-control.txt` |

New findings fixed this round: **D29** (lifecycle gaps not persisted until the next stream change), the raw permission-denied message,
silent event-log overflow, and re-publication of the old Firebase key inside the evidence diff (found by the new repo audit).
A wrong assumption was also corrected: headless Chrome *can* hide a tab, so real hide/return and Wake Lock release/reacquire are now tested in-browser.
Simulated crash loss in this run: 0.164 s and 0.141 s. **Physical hardware: still none.** Nothing has been committed.

## Update 2026-10-13 — recording lifecycle (supersedes the counts below where they differ)

Authoritative run from a clean `npm ci` on 2026-10-13. Raw logs are in `docs/evidence/` (each starts with the UTC timestamp and command and ends with `exit=`).

| Check | Command | Result | Evidence class | Log |
|---|---|---|---|---|
| Unit | `npm test` | **116 passed / 0 failed / 0 skipped** (13 files) | UNIT / SIMULATED INTEGRATION (W3C Web Bluetooth mock, fake-indexeddb) | `03-unit.txt` |
| Coverage of `src/` (non-UI) | `node --test --experimental-test-coverage …` | 96.84 % lines, 81.68 % branches. session-controller, session-state and stream-health 100 % lines; preflight 95 %; keep-awake 100 % | — | `10-coverage.txt` |
| Browser E2E | `npm run test:e2e` | **68 passed / 0 failed**, on two consecutive runs | SIMULATED INTEGRATION (Chrome 154 headless, demo devices) | `07-e2e.txt`, `08-e2e-repeat.txt` |
| Firmware serialization | `npm run test:firmware` | OK (3 data + 3 control vectors) | UNIT | `04-firmware.txt` |
| **Firmware sketch compile** | `npm run firmware:compile` | **COMPILED** `esp32:esp32:esp32c3`, arduino-cli 1.5.2-rc.1, esp32:esp32 3.3.12, 0 warnings (`--warnings all`), 603,229 B flash / 17,828 B RAM | BUILD (not flashed) | `14-firmware-compile.txt` |
| Lint, offline audit, build, package | `npm run lint`, `npm run audit:offline`, `npm run build`, `npm run package` | all exit 0 | STATIC | `02`, `06`, `05`, `09-*.txt` |
| Traceability | `npm run verify:trace` | 47 requirements, 150 references, 0 problems. Negative control (fabricated title) gives exit 1 | — | `13-traceability.txt`, `15-traceability-negative-control.txt` |

**Defects found this round (each reproduced, then fixed):**

| # | Defect | How it was found | Regression test |
|---|---|---|---|
| D24 | Two concurrent Record starts created **two sessions** | script reproduced 2 sessions | «duplicate Record submissions create exactly one session …» |
| D25 | The final quality summary counted packets received *during finalization* that were never stored | lifecycle test failed (92 received vs 90 stored) | «export agrees with stored samples, units, session id, and quality counters» |
| D26 | Fixed 3 s link-stall threshold: sensors slower than ≈ 0.33 Hz were flagged as stalled between every pair of samples | code review; the new test fails on the old code (mutation check) | «slow sensor (0.25 Hz) is not reported as stalled …» |
| D27 | Chart joined pre- and post-start points into long false lines (chart reset before the async preflight) | screenshot | «live chart series are time-ordered after start …» |
| D28 | Confirmation table clipped (channels/rate hidden) by an inherited 2-column fieldset grid | screenshot + geometry check | «all dialog columns (incl. channels and rate) visible without clipping» |
| — | Test harness: the manual clock could go backwards when jumped; fixed so the lifecycle-gap test is meaningful | test failure | «visibility changes, timer stalls and wall-clock jumps …» |

**Observed, not fixed:** in 1 of about 8 E2E executions this round, headless Chrome closed its DevTools connection during the 150 k-row CSV export
(scenario 5). It was not reproducible in the following runs. This looks like a test-infrastructure or memory issue, but the cause is not established.

**Wake Lock:** in headless Chrome 154 the real Screen Wake Lock API returned `active`. There is no physical display, so a screen actually staying on is **NOT TESTED**.
**Crash loss window (SIMULATED):** 7 single-kill runs this round (logs `07`, `08`, `dev-runs/e2e-dev*.txt`; dev runs kept unedited, including ones that failed during development): 0.002, 0.018, 0.059, 0.220, 0.239, 0.250 and 0.256 s. That is up to about one 250 ms flush interval plus write time. It is not a guarantee, and power loss is NOT TESTED.
**Physical hardware: none.** No ESP32 is attached (Device Manager shows only Bluetooth serial links COM3–COM6). Nothing was flashed, connected, recorded or measured.
See `docs/HARDWARE_TEST_PLAN.md` → *Part A: one board* and `docs/PLATFORM_COMPATIBILITY.md`.


## 1. Repository and commit inspected

`https://github.com/hiomgupta/sensorlab-iitgn`, branch `main`, base commit `25dbe42` ("Add files via upload"), the only commit.
The baseline was plain HTML/CSS/JS in 9 files (3,133 lines), with no build, tests, firmware, README or license. Full audit, including 19 baseline
defects found by static review: `docs/AUDIT.md`. The changes in this report are **uncommitted** in the working tree. Committing was left to the owner.

**Baseline measured** (`ENV PROBE`, commit `25dbe42` loaded in Chrome 154 from `file://`):

| Network | Result |
|---|---|
| offline | `Uncaught ReferenceError: Chart is not defined`; 0 UI preset cards rendered, so **the app is unusable offline** |
| online | contacts `fonts.googleapis.com`, `fonts.gstatic.com`, `cdn.jsdelivr.net`, `www.gstatic.com` |

## 2. Architecture chosen and why

**Browser app using Web Bluetooth, shipped as an offline static bundle** (`docs/architecture-decision-record.md`).
The deciding evidence is that the target is lab Windows PCs where apps cannot be installed (course report, pain point P5). The ENV PROBE also showed that
Chrome 154 treats `file://` as a secure context with `navigator.bluetooth` available (and blocks ES modules there), so a
single-bundle `dist/` can run **from disk with no server and no install**. A localhost launcher (`serve.ps1`, built-in PowerShell) and
HTTPS + service worker are fallbacks. Tauri/Electron were rejected because they need installation. Capacitor/Android was rejected because
Android is not the identified target. A transport interface keeps a native driver possible later. Wi-Fi, MQTT and cloud were rejected by constraint.

## 3. Requirements met (with evidence class)

| Req | Requirement | Evidence |
|---|---|---|
| A1 | Zero runtime internet dependency | `SIMULATED INTEGRATION`: E2E on `file://` with network emulated offline. Full workflow; **0 requests to non-local origins**; 0 console errors. HTTP run: reload with network offline and server stopped works from the service worker. `STATIC REVIEW`: CSP `connect-src 'none'`; `npm run audit:offline` clean; lint forbids network APIs and remote URLs in `src/`. |
| A4 | Detect missing samples (application side) | `UNIT TEST`: gaps, duplicates, late arrivals, sequence wrap 2³²→0, BOOT epochs, device-attributed overruns. Exact accounting under injected faults: `received + missing == sequence span`, every duplicate and malformed packet counted. `SIMULATED INTEGRATION`: a forced link loss produced a counted gap. **Physical stream: NOT TESTED.** |
| A7 | Interrupted-session recovery (application side) | `SIMULATED INTEGRATION`: Chrome process **SIGKILLed** mid-recording. Next launch shows the interrupted banner; recovery is idempotent; persisted data readable; 0 corrupt chunks; stored ≤ appended (nothing fabricated). `UNIT TEST`: Web Locks and heartbeat detection, corrupt and missing chunk detection. |
| A8 | Bounded, visible storage | `UNIT TEST` + `SIMULATED INTEGRATION`: an injected `QuotaExceededError` shows a red banner and "STORAGE ERROR" status while recording. Retries are idempotent (same chunk number, no duplicates). Persistent failure gives an honest "NOT everything was saved: N unsaved" with no false success. Backpressure drops are counted. Usage and persistence are shown; persistence can be requested. Every write uses `durability: 'strict'`, confirmed by Chrome on 29/29 write transactions. |
| A9 | No silent acquisition failures | `UNIT TEST`: malformed, unknown-version and reserved-flag packets are counted per error code and never stored. Connected-but-silent is DEGRADED; stalls are DEGRADED; retries are bounded and end in DEAD plus an explicit Retry; non-retryable protocol and identity errors are surfaced. A throwing chart sink cannot stop recording. |
| A10 | Testable without hardware | Deterministic simulator speaking real SLTP bytes, with fault injection (drop, duplicate, reorder, malformed, bad version, invalid channel, silent, connect hang/fail, reboot, power off, storms). Demo mode is labelled SIMULATED in the UI, sessions and exports. |
| A12 | Reproducible project setup | `npm ci` from the lockfile (0 vulnerabilities), README, `npm run check`, CI workflow file. **The CI workflow has not been executed on GitHub.** |
| — | Stable identity; no mixing of streams | `UNIT TEST`: identity is the device serial; same-serial collisions are refused; identity or channel-map changes on reconnect are refused. Series are keyed by (device, channel). `SIMULATED INTEGRATION`: 3 devices each have strictly increasing per-device sequences; stored readings equal received × channels exactly. |
| — | Durable continuous recording | Header written before samples; flush every 250 ms in one atomic chunk-plus-metadata transaction; session closed on Stop. |
| — | Export contract | See §14. |
| — | Security hygiene | No `innerHTML` with data (lint); hostile BLE name `<img onerror>` rendered as text (E2E); Firebase code and config removed; CSV formula guard. |

## 4. Requirements partially met

| Req | Status |
|---|---|
| A2 Offline installation | Release zip built and checksummed (`release/sensorlab-2.0.0-dev.zip`; the current sha256 is in `docs/evidence/09-package.txt` and the `.sha256` file next to the zip). The app runs from the unzipped `dist/` on `file://` (E2E). **A clean, never-online machine install has NOT been tested.** |
| A11 Reproducible firmware/protocol | Protocol spec and C serialization are `UNIT TEST`-verified byte-for-byte against JS on shared hand-computed vectors. A mutation check confirms the test can fail. The Arduino sketch compiles with arduino-cli for esp32:esp32:esp32c3 (BUILD evidence: `docs/evidence/14-firmware-compile.txt`). It has **never been flashed or run on a board (`NOT TESTED`)**. |
| Calibration and provenance | Raw values are always preserved. A versioned gain/offset/tare model is logged per session. Two-point helper (`UNIT TEST`). **The analog chain was not inspected (no circuit available); the firmware resistance conversion is nominal and uncalibrated.** |
| Multi-device | Lifecycle isolation is `UNIT TEST`-verified (simultaneous disconnects, one DEAD device does not affect others) and runs with 3 simulated devices in E2E. **Real concurrency limits: NOT TESTED.** |
| Accessibility | Native `<dialog>` (Escape and focus, E2E-checked for Escape), labelled controls, tabs with arrow keys, state text plus symbols (not colour only), `aria-live` regions, a 390 px layout with no horizontal scroll (E2E). **No screen-reader or full keyboard audit was performed.** |

## 5. Requirements not met / blocked

| Req | Reason |
|---|---|
| A3 Multi-device support on real hardware | **Blocked: no ESP32 nodes.** Procedure: `docs/HARDWARE_TEST_PLAN.md` Part B |
| A5 Honest timing claims (measured) | **Blocked.** No timing figure is claimed anywhere. Procedure: `docs/HARDWARE_TEST_PLAN.md` C1–C2. |
| A6 Valid physical measurement | **Blocked: no circuit or reference standards.** Procedure: `docs/HARDWARE_TEST_PLAN.md` C3 |
| Real Web Bluetooth driver | `src/transport/web-bluetooth.js` was **not exercised against any GATT stack** (see §11) |
| Owner decisions | License (none added); shared-machine retention policy (default: keep + explicit delete/wipe); Firebase project rules check and cleanup (`docs/SECURITY.md`) |

## 6. Build results

| Command | Exit | Output |
|---|---|---|
| `npm ci` | 0 | 0 vulnerabilities (`evidence/01-npm-ci.txt`) |
| `npm run build` | 0 | `dist/` build id `2.0.0-dev+a967b9012296` (`evidence/05-build.txt`) |
| `npm run package` | 0 | 21 files, 446 KB, verified by Python `zipfile.testzip()` (`evidence/09-package.txt`) |

## 7. Automated test results

| Suite | Command | Result |
|---|---|---|
| Unit (Node 26.1.0 test runner) | `npm test` | **86 passed, 0 failed, 0 skipped** across 10 files, including `pipeline.test.js`, which drives the real Web Bluetooth driver against a W3C API mock (`evidence/03-unit.txt`; coverage in `evidence/10-coverage.txt`, 96% of `src/` lines excluding UI) |
| Firmware serialization (MinGW gcc 6.3.0, `-std=c99 -Wall -Wextra -Werror -pedantic`) | `npm run test:firmware` | **OK**: 3 data and 3 control vectors plus negative cases, 0 failures (`evidence/04-firmware.txt`) |
| Browser E2E (Chrome 154.0.8037.98 headless, Windows 11) | `npm run test:e2e` | **47 passed, 0 failed** on two consecutive runs (`evidence/07-e2e.txt`, `evidence/08-e2e-repeat.txt`, `evidence/e2e-results.json`) |

Failures found by these suites during development, and fixed: a simulator accounting bug (overlapping fault decisions);
`[hidden]` overridden by CSS (log panel open on load); a reading count inflated by gap markers in the history view; the mobile
sidebar collapsing to zero height; a `file://` manifest CORS error; filename sanitizer gaps; and test-harness races
(argument passing, snapshot timing, layout-shift misclicks).

### Second audit (2026-10-12): defects reproduced by a failing test, then fixed

| # | Defect | Reproduced by | Fix |
|---|---|---|---|
| D20 | Quality diagnostics of a device removed mid-recording vanished from the saved session at the next flush | «REGRESSION: quality of a device removed mid-recording is kept in the saved session» (failed: `undefined`) | `acquisition-service.js` keeps a final quality snapshot for removed devices |
| D21 | Disconnects and reconnects that happened before Record leaked into the session statistics | «REGRESSION: connection events before recording do not leak into the session statistics» (failed: 1 ≠ 0) | Counters are baselined at recording start |
| D22 | Toast notifications covered the Record/Stop button at ~800×600, so a trusted click on Stop did nothing for up to 15 s | E2E trusted click: Stop had no effect; `elementFromPoint` returned the toast | Toasts are `pointer-events: none`. The E2E asserts the button is the hit target while toasts are shown. |
| D23 | Re-adding an already-connected device (e.g. subscribing to a second characteristic) silently did nothing | Code inspection | An explicit message in the add/scan dialogs |
| — | The real Web Bluetooth driver had 0% test coverage | coverage report | `test/unit/pipeline.test.js` + `test/helpers/fake-web-bluetooth.js` (now 94% of lines, against a mock API only) |

Correction to an earlier claim: a previous E2E misclick was attributed to banner layout shift. The real cause was toast occlusion (D22).

## 8. Static analysis / type / lint results

`npm run lint`, exit 0. All 40 JS files syntax-checked. No HTML-injection sinks, `eval`, remote URLs or network APIs in `src/`.
No wall-clock use in the acquisition, protocol or transport layers. `npm run audit:offline`, exit 0: 9 files, CSP verified, the service worker ignores
cross-origin requests. The only URLs in `dist/` are two inside Chart.js `/*! */` licence banners, verified by hand. No TypeScript, so no type check.

## 9. Offline network test results

| Scenario | Class | Result |
|---|---|---|
| `dist/index.html` from `file://`, Chrome network emulation **offline**, full workflow (demo, record, annotate, reconnect, export CSV/JSON/ZIP) | SIMULATED INTEGRATION | Works; **0 non-local requests**; 0 console errors; boot to ready 575 ms in the evidence run |
| Served over HTTP, then service worker active, then **network offline and server stopped**, then reload | SIMULATED INTEGRATION | App reloads from cache; 0 non-local requests |
| Baseline 1.x offline | ENV PROBE | Broken (see §1) |
| Real network adapter physically disabled | NOT TESTED | Emulation only |

## 10. Fake-transport / simulator results

All `UNIT TEST` / `SIMULATED INTEGRATION`. The lifecycle reaches STREAMING only after the first valid sample. Silent and stalled devices go to DEGRADED.
The connect watchdog fires (10 s). Repeated disconnect events trigger one reconnect task; after reconnect there is exactly one live subscription.
Backoff is capped and jittered in [d/2, d]. Exhaustion gives DEAD, and there is no further timer activity until Retry. A reboot while away is detected by the boot nonce,
so the sequence reset is not misread as late packets. Non-retryable INFO errors go straight to DEAD. Rate control is confirmed by INFO readback. Under 30 s
of mixed faults (5% drop, 5% duplicate, 5% reorder, 3% truncated, 2% bad version) the accounting is exact.

## 11. Physical BLE test results

**NOT TESTED.** No SensorLab or ESP32 node was available. The host has a Realtek BLE adapter (`ENV PROBE`), but there was nothing to connect to.
What was attempted: Chrome's experimental CDP `BluetoothEmulation` domain. The device chooser could be driven and an emulated device
selected, but the GATT connection never completed (Chrome then reported "BluetoothEmulation not enabled"). The domain also has
no notification-injection command. Result: **the Web Bluetooth driver is unverified against any GATT stack, real or emulated.**
`ENV PROBE` only: on `file://` and `localhost`, `requestDevice` opens the chooser without a SecurityError.

## 12. Multi-device results

**Physical: NOT TESTED.** Simulated: 3 devices × 2 channels × 20 Hz in Chrome for about 7 s, with one forced link loss. Streams stayed separate,
per-device sequences were monotonic, and stored readings exactly matched received × channels in every run (790 = 790 in `evidence/07-e2e.txt`, 818 = 818 in `evidence/08-e2e-repeat.txt`). This says nothing about RF or OS-stack limits.
The proposed "5 devices at 20 Hz" target remains **unverified**.

## 13. Timing and data-loss measurements

* **Timing accuracy: NOT MEASURED.** No jitter, rate or alignment figure is claimed. The app measures and reports device-clock interval
  mean, sd, min and max, measured rate and drift estimate per session. Definitions: `docs/EXPORT_SCHEMA.md`.
* **Crash loss window (SIMULATED, not a guarantee).** Method: simulated devices at 50 Hz; Chrome SIGKILLed about 4 s into a recording; loss window =
  (relative time at kill) − (last persisted `relative_time_s`). Observed in 6 separate E2E executions: **0.18–0.21 s**
  (0.201, 0.207, 0.198, 0.190, 0.211, 0.177), consistent with the 250 ms flush interval. This was a browser-process kill only. **OS crash and power loss: NOT TESTED**,
  although writes now request strict durability.
* Indicative performance (headless Chrome, this host): 150,000-reading session written in about 0.3 s, history view (decimated to 2,664 points) in about 0.2 s,
  full CSV export to file in about 0.9 s. In Node: 120k-row CSV build about 0.5 s.

## 14. Export validation results

`UNIT TEST`: RFC 4180 quoting of quotes, commas and newlines; a formula guard on text fields only (negative numbers untouched); exact numeric round-trip;
Unicode units (Ω, °C, µε); empty session; 120k-row session; flags; integrity warnings (open, recovered, corrupt, missing, unsaved, simulated); JSON
`sensorlab-export/1` semantic round trip; filename sanitization (path traversal, reserved names); ZIP verified by Python `zipfile`.
`SIMULATED INTEGRATION` (downloads from the real UI, offline): the CSV header matches the schema; **rows = stored readings exactly**; units preserved; simulated
flag present; a hostile session name (`=Trial "1", Ω µε`) is preserved in JSON and sanitized in the filename; the ZIP is valid; 150k-row CSV complete.
Two sessions with the same display name are kept and deleted independently (`UNIT TEST`).

## 15. Known defects and limitations

1. Physical BLE, multi-device capacity, timing, analog accuracy and OS-crash durability are all unverified (§11–13).
2. The firmware sketch was never compiled. The `resistance` channel is a nominal, uncalibrated conversion. Bluedroid `notify()` failures are invisible to the device and show only as host gaps.
3. Cross-device alignment uses host receipt of each device's first sample, so the offset is roughly the difference in BLE latencies (expected to be milliseconds to tens of milliseconds; **unmeasured**). Drift is estimated, not corrected.
4. Legacy streams cannot detect loss. Their identity is Chrome's per-origin device ID, which differs between `file://` and `localhost`.
5. Background or hidden-tab recording is not supported or claimed. Hidden periods are logged.
6. `file://` storage is shared by all local pages in the browser profile. Data is per browser profile and origin, so it does not move with the folder.
7. Status banners appearing or disappearing shift the layout (a possible misclick; it was observed in automation).
8. Device display names and calibrations are not persisted across app restarts (they are recorded in each session).
9. The Battery Level preset needs a device that supports notify; many devices offer read only, so the device shows DEGRADED.
10. Very large sessions are loaded into memory for view and export. Measured on the packaged app up to 6,000,000 readings (`docs/evidence/readiness/large-session-final.txt`). Exports above 256 MB are saved in parts (CSV/ZIP) or refused (JSON), because the browser cancels larger single downloads.
11. Real quota exhaustion was only injected, not reproduced.

## 16. Security / dependency review

See `docs/SECURITY.md`. Firebase code and config were removed. The **live Firebase project's rules are unverified (owner action required)**; the client key remains in
git history (it is not a secret by itself). Threat model documented. Runtime dependency: Chart.js 4.4.7, vendored, sha256 in `vendor/VENDOR.md`. Dev dependencies
are pinned; `npm audit`: 0 vulnerabilities (see `docs/evidence/readiness/npm-audit.txt` for the latest online run) after upgrading puppeteer-core 24.43.1 to 25.13.0 (the old version pulled in basic-ftp and extract-zip advisories).
No secrets or personal paths in committable files (scripted scan, with negative controls in `docs/evidence/readiness/security-hygiene.txt`). The only key material is the 8-character prefix `AIzaSyA8…` of the legacy public Firebase web key, quoted in `SECURITY.md` to identify it.

## 17. Reproduction instructions

```bash
npm ci
```

```bash
npm run check
```

```bash
npm run package
```

Requires Node ≥ 20, Chrome or Edge (or `CHROME_PATH`), and a C compiler (`CC`, or MinGW at `C:/MinGW/bin/gcc.exe`). Python is used only to cross-check ZIPs.

## 18. Remaining manual steps

1. Run `docs/HARDWARE_TEST_PLAN.md` Part A first: single device from `file://`. This settles ADR item V1. Then Parts B and C.
2. Compile and flash the firmware, and record the toolchain versions.
3. Firebase: check the rules, export or delete student data, delete or lock the project (`docs/SECURITY.md`).
4. Owner decisions: license; shared-PC retention policy; confirm that hidden-tab recording is not required.
5. Clean-machine offline install test (A2). Run the CI workflow on GitHub.
6. Review and commit the working tree. `sensorlab report.pdf` remains untracked by choice.

## 19. Changed-file summary and rationale

| Change | Rationale |
|---|---|
| Deleted `js/*.js` (7 files) | Monolithic 1.x code with cloud/auth paths and defects D1–D19. Replaced by layered modules. |
| `index.html`, `css/styles.css` rewritten | No remote assets; CSP; native dialogs; health cards; banners for simulated, storage, recovery, visibility and BLE states |
| `src/protocol/` | SLTP v1 and strict legacy parsers (pure, non-throwing) |
| `src/acquisition/` | Lifecycle state machine, stream accounting, calibration, orchestration |
| `src/transport/` | Web Bluetooth driver and deterministic simulator behind one interface |
| `src/storage/` | IndexedDB repository (atomic chunks, strict durability), recorder, recovery, 1.x import |
| `src/export/` | Versioned CSV/JSON/ZIP and import |
| `src/viz/`, `src/ui/`, `src/main.js` | Throttled charts isolated from acquisition; UI |
| `firmware/` | SLTP v1 reference firmware, C serialization and host test |
| `test/` | Unit, firmware and E2E suites; shared protocol vectors |
| `scripts/`, `tools/`, `sw.template.js`, `manifest.webmanifest` | Build, vendor, lint, offline audit, packaging, launchers, service worker |
| `vendor/` | Chart.js 4.4.7 + licence + checksum |
| `docs/` | Audit, ADR, protocol, export schema, security, deployment, hardware plan, this report, evidence |
| `README.md`, `CHANGELOG.md`, `.gitignore`, `package*.json`, `.github/workflows/ci.yml` | Project hygiene and reproducibility |
