# Changelog

## Unreleased — 2026-10-14: final software readiness audit (before hardware testing)

### Fixed
- **Large-session export (demonstrated at 6 M readings):** the CSV download was cancelled by Chrome at 0 bytes (the blob URL was revoked after 10 s) while the app reported "Exported 6000000 readings"; ZIP export failed with "Invalid string length"; JSON held several full-size copies. Exports are now built as bounded parts (`buildJsonParts`, `buildZipParts`; no whole-file string), the blob URL lives max(60 s, 1 s/MB) and is released on page exit, and the message says the file was *handed to the browser to save* with its size.
- **Startup cancel race:** Cancel/Escape during preflight, or while the keep-awake request or session-header write was pending, was ignored and recording started anyway. It now cancels: no session is created before the header exists; after that, the session is finalised as `startup_cancelled`.
- **Accessibility A1–A4:** duplicate control names ("Settings", "Remove", "View") now name their device or session; per-second live-region chatter removed (one polite announcer for state changes only); the stale warning is announced once; charts have text alternatives (latest-values table, per-series summary table in History).
- **Offline portability:** the vendored Chart.js referenced a source map that is not shipped; it is stripped at vendoring and the audit rejects any sourcemap reference.
- **Protocol document:** the INFO example said channel `adc_mean`; the firmware sends `adc_sum16`. INFO JSON is now built by a tested C function (`sltp_build_info`, refuses to truncate), and the firmware test requires the document example to equal the firmware output.

- **Single downloads above ~500 MB were cancelled by the browser** (measured: 520 MB cancelled at 0 bytes, 500 MB completed). CSV/ZIP exports above 256 MB are now offered as parts ("Save part k of n", each a complete CSV with header, saved one at a time); JSON above 256 MB is refused with an explanation. A stale parts panel is cleared when a new export starts.
- **Wake-lock leak (R2):** overlapping wake-lock requests (start of recording plus a return to the page) stored two sentinels and released only one, so the screen could stay awake after recording. A late duplicate is now released.
- **Blocked recording after a failed start (S1):** closing the dialog with Cancel/Escape after a startup failure left the session in START_FAILED, and every later Record answered "Cannot start while START_FAILED" until reload. The terminal state is now acknowledged when the dialog is cancelled or reopened.
- **Firmware DEVICE_OVERRUN:** the flag was latched until the next *transmitted* packet, so after a disconnect the whole link gap could be attributed to the device. It now describes only the sample right after the skipped slots. Slot-scheduling arithmetic is host-tested (`sltp_advance_slot`); `sltp_build_info` refuses invalid channel counts. PROTOCOL.md clarifies parser limits, CONTROL error precedence, the advertised-name source and the INFO long-read.

### Known, not fixed
- R3: if a dependency of `start()` threw, the controller would stay in PREFLIGHT/STARTING. No production dependency throws (each catches its own errors). This is recorded as a `todo` test in `test/unit/startup-races.test.js`.

### Added
- `test/unit/startup-races.test.js`: 32 startup/stop race and cleanup tests (keep-awake released on every path, no timer/lock leaks, restart after every outcome).
- `tools/check-export.mjs`: independent export checker for the hardware run (epochs, gaps, duplicates, unflagged jumps, app-quality agreement).
- `npm run audit:offline -- --package` / `-- --self-test` (8 planted violations, each with its specific expected finding). The package smoke test now blocks the network at proxy and DNS level and runs the shipped `serve.ps1`.
- Large-session benchmark against the packaged app with record-by-record integrity verification of CSV/JSON/ZIP.
- `scripts/verify-all.mjs` (one command, raw logs per step), `scripts/redact-copy.mjs`.
- `docs/FINAL_SOFTWARE_READINESS_REPORT.md`, `docs/ACCESSIBILITY.md`, `docs/OFFLINE_VALIDATION.md`. The hardware acceptance checklist (`docs/HARDWARE_TEST_PLAN.md`) is rewritten with PASS/FAIL/BLOCKED fields.

## Unreleased — 2026-10-14: verification review

### Added
- Deterministic data-integrity suite (`test/unit/data-integrity.test.js`): 1,000 known samples, exact-total fault script, bursts, session isolation, reload, slow storage.
- Connection-failure tests (permission denied, missing service, failed subscription, listener leaks).
- Browser checks (headless Chrome): permission denial, IndexedDB unavailable, export failure, slow finalization, reload byte-identity, keyboard/focus, freeze/resume via the Page Lifecycle API, tab hide/return with Wake Lock release and reacquisition.
- `npm run audit:repo`, `npm run test:package`, software-pipeline and large-session benchmarks; `docs/TEST_REVIEW.md`, `docs/OPERATING_LIMITS.md`.

### Fixed
- D29: lifecycle-gap events (timer stall, clock jump) were not persisted until the next stream change.
- Bluetooth permission denial now shows an actionable message instead of the raw error.
- Lifecycle event-log overflow is now counted (`eventsDropped`) and reported in exports.
- The evidence diff no longer re-publishes the deleted Firebase config (generated with `git diff -D`).

## Unreleased — 2026-10-13: recording lifecycle

### Added
- Recording confirmation dialog: device/channel list with units and stream state, per-device include/exclude, live preflight (fatal vs warning), **Keep screen awake on by default**, best-effort explanation, cancel creates nothing.
- Explicit session state machine (IDLE → PREFLIGHT → STARTING → RECORDING ⇄ DEGRADED ⇄ INTERRUPTED ⇄ RECOVERING → STOPPING → COMPLETED / FINALIZE_FAILED; START_FAILED), with illegal transitions rejected.
- Verified startup: header persisted, then counters reset, then pipeline active, then a fresh valid sample required on every stream before RECORDING. On timeout the session is finalised as `startup_failed` (diagnostics kept), with Retry/Cancel.
- Per-stream, rate-relative freshness (suspect at 3, stale at 5 expected intervals, with floors; on-change streams supported). A non-blocking warning names the device and channel, and the last valid value is shown with its age.
- Keep-awake abstraction: Screen Wake Lock (handles absence, rejection, release, reacquisition) plus a native adapter interface. Status shown honestly.
- Lifecycle event trail persisted in `session.lifecycle` and exported: preflight, keep-awake, pipeline, stream transitions, device disconnect/reconnect/fail/remove, visibility, freeze/resume, timer stalls, wall-clock jumps, finalization.
- Session status strip (session state, screen awake, saving, finalization) and a per-stream freshness column.
- `docs/PLATFORM_COMPATIBILITY.md`, ADR-003, minimal single-ESP32 hardware procedure.

### Fixed
- D24: two concurrent Record starts created two sessions (recorder start is now guarded synchronously; the controller and UI also guard).
- D25: the final quality summary counted packets received during finalization that were never stored (diagnostics now frozen at stop).
- Device-level stall detection used a fixed 3 s threshold, which reported any sensor slower than ≈ 0.33 Hz (interval ≥ 3 s) as stalled between every pair of samples. It now uses max(3 s, 5 expected intervals).

## 2.0.0-dev — 2026-10-12 (unreleased)

Rebuild for offline-first, Bluetooth-only operation. See `docs/VALIDATION_REPORT.md` for what is and is not verified.

### Removed
- Firebase Auth, Firestore, cloud sync, sign-in UI, cloud banner and local→cloud migration (`js/auth-manager.js`, `js/cloud-store.js`, `js/firebase-config.js`).
- All CDN and remote font references (Chart.js is now vendored; system font stack).
- The single 873-line `js/app.js` and the other 1.x modules (replaced by layered `src/` modules).

### Added
- SLTP v1 binary telemetry protocol (sequence numbers, µs device timestamps with defined rollover, validity mask, flags, INFO + CONTROL characteristics) and reference ESP32 firmware.
- Per-device lifecycle state machine: watchdogs, idempotent disconnect handling, bounded jittered backoff, explicit Retry. STREAMING only after valid data.
- Sequence and timestamp accounting: missing, duplicate and late samples, gaps, rollover, device restart, drift estimate.
- Continuous batched persistence keyed by session UUID, interrupted-session detection (Web Locks + heartbeat) and idempotent recovery.
- Visible storage errors, quota handling, a persistent-storage request, storage usage display, delete-one and typed-confirm wipe-all.
- Versioned CSV (`sensorlab-csv/1`) and JSON (`sensorlab-export/1`) exports, ZIP bundle, JSON import, formula-injection guard, integrity warnings.
- Demo mode with deterministic simulated devices and fault injection, persistently labelled SIMULATED.
- Calibration model (raw preserved; gain/offset/tare, versioned, logged per session).
- Multi-axis live chart by unit, gap rendering, rAF throttling, decimated history view.
- Offline build (`file://`-capable bundle), service worker for HTTPS hosting, localhost launchers, release packaging.
- One-time read-only import of SensorLab 1.x local sessions.
- Unit, firmware-serialization and headless-Chrome E2E test suites, lint, offline audit, CI workflow.

### Fixed (baseline defects, `docs/AUDIT.md` §4)
- D1–D19, including: whole session lost on crash; sessions merged and deleted by name; channels mixed; silently incomplete exports;
  chart failure dropping data; XSS through BLE names; duplicate reconnect loops; stale characteristic after reconnect;
  silent parse failures; 1e6 open-circuit sentinel stored as data; unescaped CSV; annotation time taken after typing.
- Battery Level (1 byte) was parsed as uint16, which threw inside the BLE handler. Heart Rate ignored the format flags.
