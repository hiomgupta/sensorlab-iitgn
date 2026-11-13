# SensorLab 2: Final software readiness report (before physical hardware testing)

Date: 2026-10-14 (UTC run times are in each evidence file). Scope: the software-only readiness audit requested before the
first hardware acceptance run. **No hardware was connected, no board was flashed, and nothing here is a Bluetooth,
timing, analog or crash-durability measurement on real equipment.**

Verdict: **READY WITH LIMITATIONS** (see §8).

## 1. What was inspected

* Repository state before any change: 7 staged deletions (`js/*`, legacy 1.x), modified `index.html` and `css/styles.css`,
  and the untracked SensorLab 2 tree. This state is preserved; nothing was committed, staged, stashed or discarded.
* Critical path: `src/acquisition/*` (session controller, state machine, preflight, stream health and tracker),
  `src/platform/keep-awake.js`, `src/storage/*`, `src/export/*`, `src/ui/*`, `src/main.js`.
* Firmware ↔ protocol ↔ parser: `firmware/sensorlab_node/*`, `docs/PROTOCOL.md`, `src/protocol/sltp.js`.
* Release package, offline behaviour, accessibility semantics, repository hygiene and secrets, and all evidence and claims.

Work was split into four parallel workstreams with exclusive file ownership: export, startup/stop races (tests only),
firmware/protocol, and read-only release QA. The lead integrated them and ran the final verification on the combined tree.

## 2. Baseline vs. final

| Check | Baseline (`docs/evidence/baseline-2026-10-14/`) | Final (`docs/evidence/`, one run 23:32:38–23:38:41 UTC; package sha256 `ffda0356…11876d4`) |
|---|---|---|
| Unit tests | 127 / 127 | 170 tests: 169 pass, 0 fail, 1 todo (R3, documented) |
| Firmware host tests | OK (3 data + 3 control vectors) | OK; INFO contract and PROTOCOL.md example check OK; overrun guard OK |
| Firmware compile (esp32c3) | COMPILED | COMPILED, 603,729 B flash (46 %) |
| Browser E2E (headless Chrome 154), 2 runs | 81 / 81, twice | 96 / 96, twice (scenarios 10 accessibility, 11 START_FAILED added) |
| Package smoke (network blocked) | OK, 13 checks | OK, 27 checks (proxy + DNS blocked, serve.ps1 run and killed, offline reload) |
| Offline audit: dist / package / self-test | OK / not run / not run | OK (9 files) / OK (21 files) / OK (8/8 planted violations caught) |
| Software pipeline benchmark | OK | OK: up to 2,590 readings/s stored = received, 0 app-side gaps, max event-loop lag 24 ms |
| Large session (verify-all step: 1 M, packaged app) | OK (single files) | OK (1 M, single files, record-by-record verified) |
| Coverage of `src/` (lines / branches) | 96.93 % / 82.13 % | 95.20 % / 83.52 % |
| Repository audit | OK | OK, 177 files; negative controls in readiness/security-hygiene.txt |
| Traceability verified against logs | OK | OK: 64 requirements, 203 evidence references, 0 problems (PASS 38, PARTIAL 18, BLOCKED 7, FAIL 1) |

Further evidence from this audit is in `docs/evidence/readiness/`:

| File | Content |
|---|---|
| `large-session-final.txt` | 1 M / 3 M / 6 M readings on the packaged app, with record-by-record integrity |
| `blob-download-probe.txt` | browser download limits |
| `a11y-mutation-check.txt` | accessibility checks shown to fail when defects A1/A2 are reintroduced |
| `s1-start-failed-mutation-check.txt` | S1 unfixed vs. fixed |
| `security-hygiene.txt` | repo audit with negative controls, history scan, package scan, `npm ls` |
| `npm-audit.txt` | online advisory check |
| `firmware-compile.txt`, `firmware-tests.txt` | firmware evidence |

## 3. Defects found and fixed (each with a regression test)

| # | Defect (demonstrated) | Fix | Regression test(s) |
|---|---|---|---|
| A1–A4 | Accessibility: duplicate control names; per-second live-region chatter; stale warning repeated; charts without text alternative | Unique labels, one polite announcer for state changes, chart descriptions and per-series table | E2E scenario 10 (mutation-verified, `a11y-mutation-check.txt`) |
| O1 | Release ZIP referenced a non-shipped source map (vendored Chart.js) | Stripped at vendoring; the audit rejects source maps | `audit:offline --package`, `--self-test` (8 planted violations) |
| E1 | 6 M-reading CSV: Chrome cancelled the download at 0 bytes (blob URL revoked after 10 s) while the app said "Exported" | URL kept max(60 s, 1 s/MB) and released on page exit; message now says "handed to the browser" | «download blob URL stays valid long enough …», «history export uses bounded builders …» |
| E2 | 6 M ZIP: "Invalid string length"; JSON held several full copies | Bounded parts (`buildJsonParts`, `buildZipParts`), no whole-file strings | «bounded export: …» (3 tests) |
| E3 | Single downloads above ~500 MB cancelled by the browser (520/600 MB at 0 bytes; overlapping or immediately consecutive parts also cancelled) | CSV/ZIP above 256 MB saved in parts, one click per part; JSON above 256 MB refused with an explanation | «large export split …», «history export guards the single-download limit …», 6 M benchmark |
| E4 | Stale "Save part" panel stayed visible when another export started | Panel cleared at export start | «history export clears a previous parts panel …» |
| R1 | Cancel during preflight / keep-awake request / header write was ignored and recording started | Cancel flag checked after each startup step; STARTING → IDLE before a session exists | «Cancel during PREFLIGHT or before verification begins is honoured …», 26 cleanup tests |
| R2 | Overlapping wake-lock requests leaked a sentinel (screen kept awake after recording) | A late duplicate is released | «BrowserWakeLock: overlapping acquisitions …» (fails without the fix) |
| S1 | After a failed start, Cancel/Escape left START_FAILED; every later Record refused until reload | Terminal state acknowledged on dialog cancel/open | E2E scenario 11 (fails without the fix: `s1-start-failed-mutation-check.txt`) |
| P1 | PROTOCOL.md INFO example named `adc_mean`; firmware sends `adc_sum16` | INFO JSON built by tested `sltp_build_info`; doc corrected | firmware test requires the doc example to equal the firmware output (mutation-verified) |
| F1 | Firmware latched DEVICE_OVERRUN until the next transmitted packet (a link gap could be attributed to the device) | Flag computed per sample | guard in `run-c-tests.mjs`. **Not demonstrated on a board** |
| F2 | `sltp_build_info` emitted INFO the app rejects for 0 or > 8 channels | Refuses (returns −1) | C tests in `test_sltp.c` |

Test-harness defects were also fixed: the benchmark clicked stale part buttons, and the E2E scenario left a required field empty.

## 4. Known and not fixed

* **R3:** if a `start()` dependency threw, the controller would stay in PREFLIGHT/STARTING until reload. No production
  dependency throws; this is recorded as a `todo` test. It was not fixed because the audit fixes demonstrated defects only.
* Suspected UI edge cases with no demonstrated user path (S2: Record button during STARTING behind the modal; S3: Cancel
  during a preflight that turns out fatal keeps the dialog open with the fatal list). Recorded in the regression report, not changed.
* BOOT flag: the firmware clears `bootPending` after `notify()` even if the client has not subscribed yet. The boot nonce
  `b` in INFO is the documented fallback. This can only be checked on hardware (checklist A8).
* Export memory: a 6 M-reading export peaks at about 2.8 GB of JS heap (the whole session is read into memory). Beyond 6 M is untested.
* The download limit (256 MB per file) is derived from headless Chrome on this PC. Lab PCs may differ (UNMEASURED).

## 5. NOT VERIFIED / BLOCKED (software-only gaps)

| Item | Status | Where it gets settled |
|---|---|---|
| Real screen-reader session (NVDA/Narrator) | NOT VERIFIED | `docs/ACCESSIBILITY.md` manual procedure |
| Never-online PC install | NOT VERIFIED (same PC, network blocked at the browser) | checklist C5, `docs/OFFLINE_VALIDATION.md` |
| Headed (non-headless) browser download limits, and saving parts by hand | NOT VERIFIED | checklist A11 on the lab PC |
| Online `npm audit` | Done once (0 vulnerabilities), `npm-audit.txt` | — |

## 6. Hardware-only gaps (BLOCKED until tomorrow's run)

Firmware on an ESP32 (flash, advertise, INFO long read, notify, CONTROL); real Web Bluetooth from `file://` and
localhost; reconnect and BOOT handling; wake lock on the lab PC; multi-device capacity; intra- and cross-device timing;
analog accuracy and calibration; crash and power-loss durability. Procedure and PASS/FAIL/BLOCKED fields:
`docs/HARDWARE_TEST_PLAN.md` (Part A one board, B multi-device, C calibrated equipment).

## 7. Commands (exact sequence used for the final evidence)

```bash
node scripts/verify-all.mjs docs/evidence
```

It runs, writing one raw log per step: `npm ci`, `npm run lint`, `npm test`, `npm run test:firmware`,
`npm run firmware:compile`, `npm run build`, `npm run audit:offline`, `npm run test:e2e` (twice), `npm run package`,
`npm run test:package`, `npm run audit:offline -- --package`, `npm run audit:offline -- --self-test`,
`node test/e2e/bench-pipeline.mjs 30`, `node test/e2e/bench-large-session.mjs 1000000 --package`, coverage,
`npm run audit:repo`, and `npm run verify:trace`.

These were run separately:

* `node test/e2e/bench-large-session.mjs 1000000,3000000,6000000 --package`
* `node test/e2e/diag-blob-download.mjs 400,500,520,600 --overlap=256x4`
* `npm audit`

## 8. Verdict

**READY WITH LIMITATIONS** for the hardware acceptance run. Every software-only check that can run on this PC passes on the
final combined tree (§2). Every fixed defect has a regression test; for A1/A2, R2, S1 and P1 the test was also run against
the unfixed code and failed (mutation evidence in `docs/evidence/readiness/`). R3 is documented, not fixed. The limitations are the items in §4–§6. No hardware claim is made.
