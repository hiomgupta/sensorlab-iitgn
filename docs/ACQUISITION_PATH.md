# Acquisition path: code walk-through and what has exercised each step

"Exercised by" columns:
**Mock-API** = `test/unit/pipeline.test.js` drives the real `web-bluetooth.js` driver against a W3C Web Bluetooth API mock
(`test/helpers/fake-web-bluetooth.js`). **Sim** = SimulatedTransport (unit tests and browser E2E demo mode).
**Real GATT** = a physical BLE peripheral in Chrome/Edge. **No step has been exercised with a real GATT device.**

| # | Step | Code | Mock-API | Sim | Real GATT |
|---|---|---|---|---|---|
| 1 | User clicks *SensorLab v2 → Choose device*; `requestDevice` filtered by the SLTP service or the `SLab-` name prefix | `src/ui/connect-view.js:49` | — (the UI button path needs a chooser and a device; the mock calls the transport directly) | — | **NOT TESTED** |
| 2 | Transport wraps `BluetoothDevice`, registers `gattserverdisconnected` | `src/transport/web-bluetooth.js:30` | ✔ | n/a | **NOT TESTED** |
| 3 | Service creates the per-device entry (tracker, parser state, calibration) and the `DeviceConnection` | `src/acquisition/acquisition-service.js:49` | ✔ | ✔ | **NOT TESTED** |
| 4 | Attempt (serialized by `ConnectQueue`), state CONNECTING, `gatt.connect()` with 10 s watchdog | `src/acquisition/device-connection.js:107`, `src/transport/web-bluetooth.js:87` | ✔ (incl. failure, then BACKOFF) | ✔ (incl. hang, then timeout) | **NOT TESTED** |
| 5 | DISCOVERING: fresh `getPrimaryService`/`getCharacteristic` on every connection; INFO read and strict validation | `src/acquisition/device-connection.js:148`, `:154`; `src/transport/web-bluetooth.js:89` | ✔ (fresh objects after reconnect asserted) | ✔ | **NOT TESTED** |
| 6 | Identity from INFO serial; collision, identity-change and channel-map-change refusal; boot nonce gives a new epoch | `src/acquisition/acquisition-service.js:102` | ✔ | ✔ | **NOT TESTED** |
| 7 | SUBSCRIBING: listener attached, then `startNotifications()`; cleanup removes the listener and stops notifications | `src/transport/web-bluetooth.js:51` | ✔ (exactly one active subscription after reconnect) | ✔ | **NOT TESTED** |
| 8 | Notification: host monotonic receipt time taken first; bytes copied out of the (reusable) DataView | `src/transport/web-bluetooth.js:53` | ✔ (buffer overwritten after dispatch; values still correct) | n/a | **NOT TESTED** |
| 9 | Generation check drops stale-connection events; first valid packet gives STREAMING; watchdog gives DEGRADED / missed-disconnect detection | `src/acquisition/device-connection.js:164`, `:179`, `:199` | ✔ | ✔ | **NOT TESTED** |
| 10 | Parse SLTP v1 (length, version, flags, mask, channel count), never throws | `src/acquisition/acquisition-service.js:136`, `src/protocol/sltp.js:56` | ✔ | ✔ (fuzz + injected malformed) | **NOT TESTED** (no on-air packets) |
| 11 | Per-device sequence and timestamp accounting (gaps, duplicates, late, wrap, epochs, intervals, drift) | `src/acquisition/stream-tracker.js:78` | ✔ (disconnect gap equals missing sequences in the CSV) | ✔ | **NOT TESTED** |
| 12 | Per-channel readings (raw kept; engineering value; calibration; INVALID instead of sentinels); `recorder.append` **before** visualization sinks; sink errors isolated | `src/acquisition/acquisition-service.js:190`, `:191` | ✔ | ✔ (throwing sink test) | **NOT TESTED** |
| 13 | Visualization: O(1) ring-buffer push; rAF-throttled render with decimation; units on separate axes | `src/viz/charts.js:111`, `:146` | ring buffer only | ✔ (browser E2E) | **NOT TESTED** |
| 14 | Recording: columnar batch append, then one atomic chunk-plus-metadata write every 250 ms (`durability: 'strict'`); idempotent retries | `src/storage/recorder.js:116`, `:172`; `src/storage/idb-repository.js:114` | ✔ (fake-indexeddb) | ✔ (real Chrome IndexedDB) | **NOT TESTED** |
| 15 | Crash: Web Lock released or stale heartbeat gives "interrupted"; idempotent recovery counts persisted data and never fabricates | `src/storage/recorder.js:274`, `src/storage/idb-repository.js:191` | ✔ | ✔ (Chrome SIGKILL) | **NOT TESTED**; OS crash / power loss **NOT TESTED** |
| 16 | Export from a consistent single-transaction snapshot: CSV/JSON/ZIP with integrity warnings | `src/storage/idb-repository.js:140`, `src/export/export.js:90`, `src/ui/history-view.js:184` | ✔ (CSV parsed back; every value checked against the known signal) | ✔ (downloads in Chrome) | **NOT TESTED** |

Firmware side (packet producer): `firmware/sensorlab_node/sensorlab_node.ino` has **never been compiled or run**.
Its serializer `sltp.c` is host-tested byte for byte (`npm run test:firmware`).

Re-run this path:

```bash
node --test test/unit/pipeline.test.js
```

## Recording lifecycle (added 2026-10-13)

"Exercised by": **Lifecycle-U** = `test/unit/session-lifecycle.test.js` (real Web Bluetooth driver over the W3C API mock, real Recorder,
fake-indexeddb). **E2E-8** = browser E2E scenario 8 (Chrome 154, simulated devices, real IndexedDB, real Screen Wake Lock API).
**No step has been exercised with a real GATT device or a physical screen.**

| # | Step | Code | Lifecycle-U | E2E-8 | Real device |
|---|---|---|---|---|---|
| L1 | Record → confirmation dialog: devices, channels (units), stream state, keep-awake ☑ by default, live preflight | `src/main.js:136` | — | ✔ | **NOT TESTED** |
| L2 | Submit, with a duplicate-submission guard (UI, controller and recorder levels) | `src/main.js:169`, `src/acquisition/session-controller.js:103`, `src/storage/recorder.js:66` | ✔ | ✔ | **NOT TESTED** |
| L3 | PREFLIGHT: fatal vs warning (connected, discovered, subscribed, metadata, storage, keep-awake support, visibility) | `src/acquisition/preflight.js:21` | ✔ | ✔ | **NOT TESTED** |
| L4 | Keep-awake acquired (best effort; status honest; reacquired when visible) | `src/acquisition/session-controller.js:124`, `src/platform/keep-awake.js:71` | ✔ (fake) | ✔ (real API, headless) | **NOT TESTED** on a physical screen |
| L5 | Session header + device/channel metadata persisted, then counters reset, then pipeline active (selected devices only) | `src/acquisition/acquisition-service.js:344`, `:363` | ✔ | ✔ | **NOT TESTED** |
| L6 | Startup verification: fresh valid sample on every rated stream within the timeout; otherwise `startup_failed` + Retry/Cancel | `src/acquisition/session-controller.js:149` | ✔ | ✔ | **NOT TESTED** |
| L7 | Health tick: rate-relative freshness, session health derivation, lifecycle-gap detection, events persisted | `src/acquisition/session-controller.js:183`, `src/acquisition/stream-health.js:91`, `src/acquisition/session-state.js:62` | ✔ | ✔ | **NOT TESTED** |
| L8 | Device-scoped events: disconnect / reconnecting / reconnected / streaming / failed / removed | `src/acquisition/session-controller.js:218`, `src/acquisition/device-connection.js:204` | ✔ | partly | **NOT TESTED** |
| L9 | Stop: idempotent, diagnostics frozen at stop, flush, final state, keep-awake released, COMPLETED or FINALIZE_FAILED | `src/acquisition/session-controller.js:253`, `src/acquisition/acquisition-service.js:378`, `src/storage/recorder.js:242` | ✔ | ✔ | **NOT TESTED** |
