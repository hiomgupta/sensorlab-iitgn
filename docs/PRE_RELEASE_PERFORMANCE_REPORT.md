# SensorLab 2 — Pre-Release Performance Report

## Current revalidation — 2026-11-11

**Release blocker remains open:** no real ESP32/BLE multi-device throughput, ADC accuracy or timing benchmark has been supplied. In addition, `npm.cmd test` currently reports **171 pass, 0 assertion failures, 1 TODO that fails its assertion**: `test/unit/startup-races.test.js:454` demonstrates that an exception thrown by `storageStatus()` escapes `SessionController.start()` and leaves the lifecycle state in PREFLIGHT (`src/acquisition/session-controller.js:107-118`). This is a recording-start robustness defect; it does not explain incorrect ADC values, but it prevents a clean full-test pass.

Commands re-run on this workstation: `npm.cmd test` (above failure), `npm.cmd run test:firmware` (PASS), `npm.cmd run lint` (PASS), `npm.cmd run build` (PASS), and `npm.cmd run audit:offline` (PASS). Browser E2E progressed through offline startup, simulator multi-device recording, storage-failure recovery, export and 150k-row history rendering; those are simulator/browser checks, not real BLE validation.

**Assessment date:** 2026-11-09  
**Scope:** performance/data-quality and acceptance review against the stated SensorLab requirements.  
**Changes:** no production source changed. Added one deterministic test in `test/unit/data-integrity.test.js`.  
**Physical hardware:** unavailable; real BLE, ADC, sensor accuracy, and radio capacity are unverified.

## Release decision

**Not demonstrated ready for production laboratory acquisition.** The software has useful offline controls, local persistence, data-quality counters, and extensive synthetic tests, but non-negotiable frequency, measurement accuracy, physical multi-device BLE capacity, long-duration durability, and clean offline-machine requirements lack physical acceptance evidence. The software simulator must not be treated as proof of sensor timing or RF capacity.

The user target of 1,000 intended / 100 simultaneous users on separate workstations does not imply a backend scale requirement: each installation uses its own browser profile and local storage. It does imply deployment, update, training, retention, support, and target-PC consistency work across 100 machines, none of which is yet operationally validated.

## Requirements assessment

| Requirement | Actual implementation | Evidence | Assessment |
|---|---|---|---|
| 1. Completely offline | Bundled static app, local Chart.js, restrictive CSP, same-origin service worker for HTTP(S), local IndexedDB, loopback-only launcher. | `npm.cmd run audit:offline` PASS on existing `dist/` (built 2026-11-06; not rebuilt in this audit); prior network-blocked package smoke PASS with simulator; no clean offline-PC restart test. | **PARTIAL** — design/runtime evidence exists; exact field acceptance BLOCKED. |
| 2. ESP32 communication BLE only | Web Bluetooth GATT transport; no runtime network/API data path. | Static checks and W3C mock integration. | **PARTIAL** — code path present; real ESP32 BLE and post-restart connection NOT RUN. |
| 3. Multiple simultaneous BLE connections | Per-device entries/trackers; connection setup serialized; independent notifications once subscribed; app has no explicit cap. | Two-device exact mock test, three-device simulated failure isolation, up to eight simulated devices in software benchmark. | **BLOCKED for physical capacity** — no actual supported number can be claimed. |
| 4. Acquisition frequency top priority | Firmware nominal default 10 Hz; configurable 0.1–1000 Hz; polling loop performs 16 ADC reads then computes and notifies. | Historical simulator reached 2,590 readings/s at nominal 3,200; device schedule C tests blocked in current environment; no hardware timestamp trace. | **FAIL TO DEMONSTRATE** — configured range is not validated frequency. |
| 5. Accuracy and data integrity top priorities | Raw packet fields, device timestamps, sequence/gap/duplicate/invalid flags; channel scaling and calibration; local atomic chunk persistence and export integrity warnings. Reference analog resistance calculation is nominal/uncalibrated. | Deterministic fixtures assert exact values/ordering/export; no calibrated sensor/reference measurement. | **PARTIAL** for software integrity; **BLOCKED** for measurement accuracy. |
| 6. Visualization must not interfere | Recorder append occurs before UI sinks; chart uses bounded ring buffers, rAF at 8 FPS, decimation; chart exceptions isolated. | Unit test throwing chart sink still records; benchmark recorded simulator pipeline; no physical high-rate test. | **PASS by design/synthetic test for separation**, physical event-loop impact still unmeasured. |
| 7. Local persistence and restart survival | IndexedDB; strict durability transactions; 250 ms recorder flush; chunk+metadata atomic; retries; recovery from open sessions. | Fake IndexedDB and Chrome simulated crash/reload evidence. Power loss and target-PC eviction/quota remain untested. | **PARTIAL** — app-restart/browser-crash evidence, not OS power-loss durability. |
| 8. ~1,000 intended / 100 simultaneous users, separate PCs | No server, cloud, tenant, or shared database; independent local deployments. | Architecture/source review only. | **No centralized scaling bottleneck**, but rollout/maintenance across 100 PCs and each machine's hardware capacity are unvalidated. |

## Measurement path and requirements trace

`GPIO0 → 16 sequential ADC reads → sum / nominal resistance formula → SLTP v1 little-endian DATA packet → BLE notify() → browser event and byte copy → parser → sequence/time tracker → engineering conversion and calibration → recorder append → periodic IndexedDB chunk transaction → snapshot → CSV/JSON/ZIP builder`.

Key transformation and integrity facts:

- The firmware's `adc_sum16` packet raw value is the sum of sixteen ADC counts. Host scale `0.0625` yields the mean; individual conversions are discarded.
- The firmware's `resistance` packet raw value is computed centi-ohms, not a raw ADC code. It assumes 3.3 V and a fixed 10.8 kΩ reference and is explicitly uncalibrated.
- The firmware marks resistance invalid at voltage rails and transmits a clear valid bit. JS retains packet raw and emits `value: null` with INVALID; it does not fabricate zero as a valid measurement.
- Sequence is per sample packet; gaps, duplicates, out-of-order arrival, restarts, invalids, overruns, clock anomalies and simulated source are represented.
- Recorder receives the reading before chart sinks; chart ring/decimator is separate from stored/exported readings.
- Recorder's in-memory pending queue is capped at 200,000 readings; excess is counted as dropped, not silently reported as persisted. Default flush is 250 ms. Database quota/eviction and real power loss are not measured.

## Test execution and classification

### Current audit commands

| Exact command | Result | Classification |
|---|---|---|
| `node --test test/unit/data-integrity.test.js` | 7 pass / 0 fail. | PASS, deterministic mock/synthetic data. |
| `npm.cmd test` | 172 total; 171 pass, 0 fail, 1 TODO. | PASS with existing TODO; fake BLE/IndexedDB and synthetic fixtures. |
| `npm.cmd run lint` | 63 JS files checked; lint OK. | PASS. |
| `npm.cmd run audit:offline` | Existing dist static audit OK, 9 files. | PASS, static only. |
| `npm.cmd run test:firmware` | Compiler produced executable; Windows Application Control blocked execution. | BLOCKED; host C assertions not run. |
| Physical BLE/ADC/sensor accuracy test | No hardware available. | BLOCKED. |
| 1 h / 8 h / 24 h recording | Not run in this audit. | NOT RUN. |
| Real offline install + OS restart + multiple boards | Not run. | NOT RUN / BLOCKED. |

PowerShell's `npm.ps1` execution policy prevented `npm` invocations; the same package scripts were run with `npm.cmd`. `npm run build`, packaging, benchmark, and browser E2E were not run for this report because build/bench commands overwrite generated distribution/evidence files. Existing committed/untracked evidence logs were read, not treated as freshly reproduced.

### Historical simulator measurements (not physical)

`docs/evidence/16-bench-pipeline.json` records a 30-second headless Chrome 154 run on Windows / AMD Ryzen 5 5600H:

| Simulator configuration | Readings/s | Persisted / received | App missing | Event-loop lag max |
|---|---:|---|---:|---:|
| 1 device × 10 Hz × 2 channels | 20 | equal | 0 | 6 ms |
| 5 × 20 Hz × 2 channels | 202 | equal | 0 | 12 ms |
| 8 × 50 Hz × 2 channels | 807 | equal | 0 | 19 ms |
| 8 × 100 Hz × 2 channels | 1,613 | equal | 0 | 24 ms |
| 8 × 200 Hz × 2 channels | 2,590 vs. 3,200 nominal | equal to received | 0 | 14 ms |

At the highest simulated case, simulator sample delivery was roughly 81% of nominal. That run establishes only a measured software-pipeline result under its simulator/browser/host conditions.

The historical 1M/3M/6M session report is also simulated. At 6M readings it reports ~4.55 s history load and export heap peaks up to ~2.85 GB; JSON ~502 MB was refused by design; CSV/ZIP split into three files. This is a serious low-memory workstation constraint, not a hardware acquisition benchmark.

## Storage sizing estimate

The persisted logical row schema is columnar across nine arrays: device dictionary index, channel ID, sequence, device time, host time, relative time, raw, value, and flags. IndexedDB/structured-clone on-disk overhead depends on browser and data and was **not measured on target lab PCs**.

The recorded 1-million-reading CSV export was 89.2 MB in the simulator benchmark (~89 bytes per exported channel-reading row). Using that empirical CSV size as a rough export-size estimate only:

| Example workload | Channel-reading rows/day | Approx CSV/day using 89.2 B/row |
|---|---:|---:|
| 1 device × 10 samples/s × 2 channels, 8 h | 576,000 | ~51 MB |
| Same workload, 24 h | 1,728,000 | ~154 MB |
| 5 devices × 20 samples/s × 2 channels, 8 h | 5,760,000 | ~514 MB |

This is not an IndexedDB consumption estimate or guarantee. Browser storage capacity, schema overhead, retention, and any metadata/export expansion need measurement on target devices. For 100 independent machines, do not multiply into a central storage requirement; each PC independently needs appropriate local capacity and a backup/export policy.

## Visualization and persistence assessment

- Live chart ring buffer default: capacity 20,000 points/series. It retains a moving display history; it is not the source of truth.
- Live chart redraw: at most 8 FPS by default; max 1,200 decimated points per series. History chart similarly decimates display points, while export iterates all persisted readings.
- Acquisition callback synchronously parses, tracks, applies conversion/calibration, appends to recorder, then calls sinks. Chart rendering uses a separate animation-frame loop. A synchronous slow sink could still consume callback time; current sink test covers thrown errors, not worst-case CPU load.
- Persistence is a local write every 250 ms by default. Delayed writes are serialized; failure retries are bounded, and stop reports unsaved readings. Repeated storage failures can eventually fill the pending cap.
- History loads all stored session rows and all chunks for a chosen session. At millions of readings, reported heap is large; no pagination for session list.
- Background tabs are unsupported for reliable acquisition. A wake lock is best effort and does not ensure OS/browser execution.

## Highest-priority release blockers

| Priority | Blocker | Required evidence to close |
|---|---|---|
| P0 | Real ADC/resistance accuracy absent | Calibrated reference measurements over range and temperature; stated uncertainty/acceptance criteria. |
| P0 | Frequency and jitter absent | Device timestamp trace and independent timing reference at required rate; mean/std/P95/P99, missed slots and gap totals. |
| P0 | Multi-device physical capacity unknown | 1–N board stress on target PC/adapter/browser; establish tested supported count and per-device rates. |
| P0 | BLE notification congestion unverified | Queue/loss behavior under bursts/congestion, sequence reconciliation, reconnect and stalled devices. |
| P1 | 1/8/24 h persistence not run on target machines | Long-duration records, RAM/storage growth, quota failure injection and recovery. |
| P1 | Exact offline acceptance absent | Clean never-online lab PC, OS restart, real BLE connect, record/export/reopen. |
| P1 | Workstation rollout for 100 users undefined | Version/update distribution, checksum verification, local retention/backup, support process and machine/browser inventory. |
| P1 | Historical Firebase disposition unknown | Owner verifies rules/data and disables/deletes or secures the legacy project. |

## Final recommendation

Do not declare SensorLab production-ready for scientific or laboratory-grade measurements based on passing automated tests. Keep the current software status as **software validated under simulation, hardware/measurement acceptance pending**. Complete `docs/HARDWARE_TEST_PLAN.md`, collect device-side timing and calibrated accuracy evidence, define a supported multi-device/rate matrix, and run offline restart/persistence tests on the actual lab PC fleet before release.

## Principal source references

- Reference firmware sampling and transmit path: `firmware/sensorlab_node/sensorlab_node.ino:26-30,141-176`.
- Device slot arithmetic and shared protocol: `firmware/sensorlab_node/sltp.c:57-66`; `docs/PROTOCOL.md`.
- Browser transport and connection manager: `src/transport/web-bluetooth.js`; `src/acquisition/device-connection.js`.
- Acquisition conversion/isolation/recorder handoff: `src/acquisition/acquisition-service.js:136-205`.
- Calibration: `src/acquisition/calibration.js`.
- Recorder/backpressure/flush/stop: `src/storage/recorder.js:20-25,134-159,190-247`.
- IndexedDB atomic persistence and strict durability: `src/storage/idb-repository.js:80-124`.
- Visualization separation and bounded display: `src/viz/charts.js:82-180`.
- Offline packaging/security checks: `index.html:1-14`; `sw.template.js`; `scripts/build.mjs`; `scripts/audit-offline.mjs`.
- Historical simulator results and explicit operating limits: `docs/evidence/16-bench-pipeline.json`; `docs/evidence/readiness/large-session-final.txt`; `docs/OPERATING_LIMITS.md`.
