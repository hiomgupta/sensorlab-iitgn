# SensorLab 2

Offline, Bluetooth-only data acquisition for laboratory sensors (ESP32 BLE nodes), running in Chrome or Edge.
It is an IIT Gandhinagar project (Prof. Biswajit Saha, Smart Sense Lab).

SensorLab is built as a **local-first measurement instrument**. Readings are saved continuously while recording.
Every stream is keyed by stable device and channel identity. Lost, duplicated and invalid samples are counted
and shown. Interrupted recordings are detected and can be recovered. Exports contain the full stored session in a
documented, versioned format. Nothing is sent over the network.

> **Validation status (2026-10-12):** application logic, storage, export and offline behaviour are verified with
> automated tests and simulated devices. **No physical BLE test, multi-device test, timing measurement or hardware crash test
> has been performed yet.** See [`docs/VALIDATION_REPORT.md`](docs/VALIDATION_REPORT.md) and
> [`docs/HARDWARE_TEST_PLAN.md`](docs/HARDWARE_TEST_PLAN.md). No rate, device-count, jitter or data-loss figure is a guarantee.

## Use it (no install, no internet)

1. Download or build `release/sensorlab-<version>.zip` and unzip it anywhere.
2. Open `index.html` in **Chrome or Edge**. If a managed PC blocks Bluetooth for local files, run `serve.ps1` instead.
3. **+ Add device**:
   * *SensorLab v2*: nodes running `firmware/sensorlab_node` (SLTP v1 protocol, which provides sequence numbers and device timestamps).
   * *Legacy & standard*: the old text-float firmware, Nordic UART, Heart Rate, Battery and Temperature profiles.
   * *Custom UUID*, *Scan & browse*: other devices. Legacy streams cannot report sample loss.
4. **Demo** starts simulated devices (clearly labelled **SIMULATED**), with optional fault injection.
5. **● Record** opens a confirmation dialog. Choose the devices and check the channels and units. **Keep screen awake** is on by default (best effort).
   Preflight lists blocking problems and warnings. Recording becomes *recording* only after **every stream has sent a fresh valid sample**.
   During recording, the session strip shows the session state (recording / degraded / recovering / interrupted), screen-awake status and saving status. Stale streams
   are named in a non-blocking warning, and their last value is shown with its age. **■ Stop** flushes, finalizes and reports whether finalization succeeded.
6. **History** shows sessions with recovery, a data-quality table, the lifecycle event trail, CSV/JSON/ZIP export, and delete.

**Platforms:** Chrome/Edge on laptops; Chrome on Android (documented, not yet tested). **iPhone/iPad cannot connect to sensors**, because no iOS browser supports Web Bluetooth.
See [`docs/PLATFORM_COMPATIBILITY.md`](docs/PLATFORM_COMPATIBILITY.md).

Keep the page visible while recording. Data lives in this browser profile, so export what you need to keep.
More detail: [`docs/OFFLINE_DEPLOYMENT.md`](docs/OFFLINE_DEPLOYMENT.md).

On Android, open the HTTPS-hosted app in Chrome and use **Install** or Chrome’s **⋮ → Install app / Add to Home screen** to create a launcher icon. The installed app can reopen offline after its first successful load; Android may pause Bluetooth when the app is backgrounded.

## Develop

Requirements: Node.js ≥ 20 (tested with 26.1.0), Chrome or Edge, and a C compiler for the firmware serialization test
(tested with MinGW gcc 6.3).

```bash
npm ci
```

```bash
npm run check
```

`check` runs `lint`, `test` (unit), `test:firmware` (C), `build`, `audit:offline`, `test:e2e` (headless Chrome) and `verify:trace`. The full evidence run is `node scripts/verify-all.mjs docs/evidence`.

| Command | Purpose |
|---|---|
| `npm test` | Unit tests (protocol, tracking, lifecycle, storage, recovery, export, visualization) |
| `npm run test:firmware` | Compiles `firmware/sensorlab_node/sltp.c` on the host and checks it byte-for-byte against the shared vectors |
| `npm run build` | Writes `dist/` (single-file bundle that works from `file://`, plus a service worker for HTTPS hosting) |
| `npm run audit:offline` | Static scan of `dist/` for remote URLs, network APIs and the CSP |
| `npm run test:e2e` | Built app in headless Chrome: `file://` offline, crash/recovery, storage faults, exports, no-Bluetooth path, HTTP+service worker offline reload. Set `CHROME_PATH` if Chrome is elsewhere. |
| `npm run package` | `release/sensorlab-<version>.zip` + `.sha256` |
| `npm run serve` | Serves `dist/` on `http://localhost:8080` (loopback only) |

During development, the root `index.html` loads the ES modules in `src/` directly, so any localhost server works without a build step.

## Architecture

```
transport (Web Bluetooth | simulated)  →  protocol parser (SLTP v1 | legacy)  →  StreamTracker (seq/time accounting)
        → AcquisitionService (identity, lifecycle, calibration)  →  Recorder (batched, idempotent chunks)  →  IndexedDB repository
                                                                  ↘  LiveChart / tables (isolated sinks, rAF-throttled)
```

| Path | Layer |
|---|---|
| `src/transport/` | Web Bluetooth driver and deterministic simulator (shared interface) |
| `src/protocol/` | SLTP v1 and legacy parsers. Pure; never throw. |
| `src/acquisition/` | Per-device lifecycle state machine, stream accounting, calibration, service |
| `src/storage/` | IndexedDB repository, recorder, interrupted-session detection, SensorLab 1.x import |
| `src/export/` | CSV/JSON/ZIP builders and import |
| `src/viz/` | Ring buffers, min/max decimation, Chart.js adapters |
| `src/ui/`, `src/main.js`, `index.html`, `css/` | User interface |
| `firmware/` | ESP32 reference firmware for SLTP v1 |
| `docs/` | [ADR](docs/architecture-decision-record.md), [protocol](docs/PROTOCOL.md), [export schema](docs/EXPORT_SCHEMA.md), [security](docs/SECURITY.md), [audit](docs/AUDIT.md), [validation report](docs/VALIDATION_REPORT.md) |

## Licence

No licence has been chosen. The project owner must decide. Until then, all rights are reserved by the authors.
Vendored Chart.js is MIT-licensed (`vendor/chart.js.LICENSE.md`).
