# ADR-001 — Platform and architecture for SensorLab 2 (offline, Bluetooth-only)

* Status: **Accepted (pending hardware confirmation of item V1 below)**
* Date: 2026-10-12
* Inputs: `docs/AUDIT.md`, the engineering handoff (§3), course report `sensorlab report.pdf`

## Context

The existing product is a plain-JavaScript Web Bluetooth app (`docs/AUDIT.md` §1). Its hard
constraints are: offline runtime, Bluetooth-only sensor data, no cloud or auth, multi-device
operation, simulator/demo mode, and honest data-quality reporting. Its users work on lab
Windows PCs where **apps cannot be installed** (report, pain point P5). Nothing shows that
unattended screen-off recording is required.

## Options considered

| Option | Satisfies "no install on lab PC" | Offline runtime | Offline install | Background recording | Reuse | Cost / risk |
|---|---|---|---|---|---|---|
| **A. Browser + Web Bluetooth** | **Yes**: runs in the existing Chrome/Edge | Yes (local files or SW cache) | Yes, via a zip opened from disk (V1) or a localhost launcher | No guarantee (page must stay visible) | High | Low |
| B. Capacitor + native BLE (Android) | n/a (Android APK) | Yes | Yes (sideloaded APK) | Possible, unproven | Medium | Needs Android toolchain, plugin validation, devices. The lab PC is not the target. |
| C. Tauri/Electron desktop + native BLE | **No**: needs installation, which P5 rules out | Yes | Yes | Yes | Medium | Native BLE crate per OS. Blocked by IT policy. |
| D. Native Android | n/a | Yes | Yes | Yes | Low | Full rewrite |
| E. Device-side logging | complements any of the above | – | – | Yes | – | Firmware storage and transfer protocol. Out of scope for v2. |

## Decision

**Option A: a browser application using Web Bluetooth.** It ships as a static bundle that
needs no network at runtime.

Delivery modes, in order of preference:

1. **Offline zip opened from disk (`file://`), with no server and no install.** `npm run build`
   produces `dist/`: one classic-script bundle, a vendored Chart.js and the CSS. ES modules are not
   used in `dist/` because Chrome blocks module imports on `file://` (ENV PROBE, AUDIT §5).
2. **Static HTTPS hosting plus a service worker** for labs that prefer a URL. After the first
   load it runs offline. This does *not* satisfy offline *installation*.
3. **Localhost launcher (`tools/serve.mjs`, `tools/serve.ps1`)**. This is a fallback for
   machines where policy blocks Web Bluetooth on `file://`. `serve.ps1` uses Windows PowerShell,
   which is preinstalled, so nothing has to be installed.

No backend, cloud, CDN, remote font, analytics or Wi-Fi data path is used. Sensor data
travels only over BLE GATT notifications.

### Why this is the least complex option that meets the hard requirements

* It is the only option that runs on the stated target (locked-down lab PCs) without installing anything.
* Offline runtime and offline installation are both achievable with a static bundle.
* The acquisition, parser, repository and export layers are written as platform-independent
  ES modules behind a `Transport` interface and an async `Repository` interface. A future
  Capacitor/Android driver (option B) can be added without rewriting them.

### Accepted limitations (stated in the UI and README)

* Web Bluetooth works only in Chromium browsers. Vendors document Chrome/Edge on Windows 10+, macOS, ChromeOS and
  Android; only Chrome 154 on Windows 11 was exercised here, and only with simulated devices. It does not work in Firefox or Safari. On Linux a browser flag is needed. Enterprise policy
  `DefaultWebBluetoothGuardSetting` can disable it.
* **The page must stay visible during acquisition.** Hidden or locked-screen recording is not
  claimed. The app records `visibilitychange` events in the session diagnostics.
* Web Bluetooth does not expose connection interval, PHY or MTU. Throughput limits must be
  measured per host.
* `file://` pages in Chrome share one storage origin. Other local HTML files opened in the same
  browser profile could read SensorLab's IndexedDB (see `docs/SECURITY.md`).

### Rejected

* **C (Tauri/Electron)**: rejected because installation conflicts with P5. Reconsider only if IT allows installs AND background recording becomes a requirement.
* **B (Capacitor/Android)**: not the identified target. The `Transport` seam leaves room for it later.
* **Wi-Fi / ESP32 AP / MQTT / local network server as a data path**: rejected by the Bluetooth-only constraint.
* **Moving to a framework (React/Vite)**: not needed. The rewrite keeps vanilla JS, adds ES modules for testability, and uses esbuild only to make the `file://` bundle.

## Verification items

| ID | Item | Status |
|---|---|---|
| V1 | Real BLE connect + stream from a `file://`-opened bundle in Chrome/Edge on a lab Windows PC | **NOT TESTED** (no SensorLab hardware). ENV PROBE: secure context, `navigator.bluetooth` present, no SecurityError from `requestDevice`. A Chrome CDP `BluetoothEmulation` attempt could not complete a GATT connection (see VALIDATION_REPORT §11). |
| V2 | Same via `http://localhost` launcher | **NOT TESTED** with hardware. The launcher itself serves the app correctly and blocks path traversal (ENV PROBE, `serve.ps1`). |
| V3 | Offline launch with networking disabled, zero remote requests | **PASS** (SIMULATED INTEGRATION, Chrome 154, headless): `file://` with network emulated offline; 0 non-local requests |
| V4 | Service-worker offline reload over HTTP(S) | **PASS** (SIMULATED INTEGRATION): reload with network offline and the server stopped |

## Consequences

* A build step now exists (`npm run build`) for the `file://` bundle. Over HTTP(S), the root
  `index.html` loads `src/` ES modules directly, so a plain static host still needs no build.
* esbuild, puppeteer-core, fake-indexeddb and chart.js are **dev** dependencies, pinned in
  `package-lock.json`. Chart.js is vendored into `vendor/` so the app has no runtime package fetch.

---

# ADR-002 — Vanilla JavaScript ES modules instead of the earlier React/TypeScript direction

* Status: Accepted. Date: 2026-10-12.

## Facts
* Earlier project notes describe React + TypeScript + Vite + React Query. **The repository never contained that stack.**
  Commit `25dbe42` is plain HTML/CSS/JS with no build (`docs/AUDIT.md` §1), and the course report describes the same
  plain-JS app. So the rebuild did not *replace* a React codebase. It chose not to *migrate to* one.
* Handoff rule 10 says to avoid unnecessary framework migration or rewrites, and to add dependencies only for a real requirement.

## Why vanilla ES modules
1. **Where the requirements are actually met:** offline, Bluetooth-only and multi-device correctness are properties of the
   transport/parser/tracker/recorder/export layers. Those are framework-independent pure modules, unit-tested in Node
   (86 tests). A UI framework would not improve them.
2. **`file://` delivery:** the no-server path needs one classic script (ES modules are blocked on `file://`, per the ENV PROBE).
   esbuild bundles the modules into that script. React would add a runtime and JSX/TS compilation, but still the same bundling.
3. **Offline supply chain:** the runtime has one third-party library (vendored Chart.js). A React/Vite stack adds a larger
   dependency tree to audit and vendor. Runtime size today: about 173 KB app bundle (unminified) plus 206 KB Chart.js.
4. **Continuity:** students and maintainers already know the plain-JS app and its CSS tokens.

## Trade-offs accepted
* **No static types.** This is mitigated by small pure modules, JSDoc, strict runtime validation at every trust boundary,
  86 unit tests and 47 browser checks. *Migration path:* add `// @ts-check` and run `tsc --noEmit` as a dev check. No restructuring is needed.
* **Manual DOM rendering** means more UI code. The XSS risk is mitigated by the `h()`/`textContent` helper and a lint rule that bans `innerHTML`.
* **No component ecosystem or React tooling.** The UI is small: about 6 views.

## What would change the decision
A product requirement for a large, multi-page UI, or a team standardising on React/TypeScript. Since the UI does not reach
into acquisition (it only consumes service events), a React UI could be placed on the same `src/` layers later.

## Why browser + Web Bluetooth remains the best fit, and the caveat
It is the only option that runs on locked-down lab PCs without installation, offline, using BLE only. The open caveat is
**V1**: real BLE from `file://` on the lab PCs is **NOT TESTED**. If that fails, the localhost launcher is the fallback. If both fail
under IT policy, or hidden-tab recording becomes a requirement, the Transport interface allows a native (Capacitor/Tauri) driver
to be added without changing the parser, tracker, storage or export layers.

---

# ADR-003 — Recording lifecycle, stream health and keep-awake

* Status: Accepted. Date: 2026-10-13.

## Decisions
1. **An explicit session state machine** (`src/acquisition/session-state.js`) is kept separate from the device connection states
   (`device-connection.js`) and the per-stream freshness states (`stream-health.js`). Illegal transitions throw.
   Session health is *derived* from stream states: all fresh → RECORDING, some → DEGRADED, none + reconnecting → RECOVERING, none → INTERRUPTED.
   So one device failing never marks the others disconnected.
2. **Verified startup** (`session-controller.js`): confirmation → preflight → keep-awake → header persisted → counters reset →
   pipeline active → **every rated stream must deliver a fresh valid sample** before RECORDING. Samples accepted during
   STARTING belong to a session whose header and counters already exist. A startup timeout finalises that session as
   `startup_failed` (kept for diagnosis, never shown as a completed recording).
3. **Freshness is rate-relative:** suspect at 3 and stale at 5 expected intervals, with 500 ms / 1000 ms floors for BLE connection-interval
   batching. The interval comes from the device INFO period, a profile override, or the measured host interval (legacy), with a 1 s fallback
   that is flagged in preflight. On-change streams are never stale from silence. The link-level stall threshold in `DeviceConnection`
   is also raised to 5 intervals for slow streams (it was a fixed 3 s, which would have flagged a 0.2 Hz sensor as stalled).
4. **Keep-awake behind an interface** (`src/platform/keep-awake.js`): Screen Wake Lock in browsers, with a native adapter interface for future
   apps. Its status is reported honestly (active / released / failed / unavailable / not requested). A failure is a warning, not a blocker.
   It is on by default and can be switched off per recording.
5. **Lifecycle events** (preflight, keep-awake, pipeline, stream transitions, device disconnect/reconnect/fail/remove, visibility,
   timer stalls, wall-clock jumps, finalization) are persisted in `session.lifecycle` with each flush, and exported in metadata.
   Their durability is the same as samples: up to one flush interval may be lost in a crash.

## Rejected for now
* **Capacitor/native migration** for keep-awake or background acquisition: out of scope for the lifecycle work, and it would not help laptops.
  Required for iPhone and for screen-off recording (see `docs/PLATFORM_COMPATIBILITY.md`).
* **Fabricating, interpolating or holding values for stale streams:** never. The last valid sample is shown with its age as "last …".
