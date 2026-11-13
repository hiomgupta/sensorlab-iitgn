# SensorLab 2 — Multi-Device Stress Test

## Current revalidation — 2026-11-11

Software isolation is present: browser transport handles use `webbt:<browser-device-id>` and confirmed SLTP streams are keyed by the device eFuse serial plus channel (`src/transport/web-bluetooth.js:73-93`, `src/viz/series.js:1-8`). A duplicate self-reported serial is explicitly rejected. The simulated two-device data-integrity test passes, so there is no source evidence that chart/persistence keys merge two distinct SLTP nodes.

This does **not** prove a two-board radio test. Physical two-device acquisition remains **BLOCKED**: run B1–B5 using differently labelled reference-resistor stimuli, then inspect exported `device_id`, raw ADC sum, derived resistance, sequence and device timestamps per node.

**Status:** deterministic mock/simulator coverage reviewed and selectively run. Real BLE multi-device stress is **BLOCKED**: no physical boards, radio adapter matrix, or BLE analyzer were available.  
**No production code was changed.** Added one test-only regression in `test/unit/data-integrity.test.js`.

## Executive result

The application has no explicit maximum device count. Initial GATT connection/discovery/subscription attempts are serialized through `ConnectQueue`; after connections are established, device notification callbacks are independently routed by transport handle and device/channel identity. This is a conservative scheduling policy, not evidence of a particular concurrent BLE connection capacity.

Existing software tests cover two-device exact data separation, three-device simulated disconnect isolation, reconnect behavior, and simulator pipeline runs up to eight devices. **Eight simulated devices is not a supported-hardware maximum.** The maximum simultaneous physical BLE connections for a chosen PC, adapter, OS, browser, firmware, notification rate, and channel count is unknown.

## Implementation and isolation

- `AcquisitionService.entries` is keyed by transport ID. Each entry owns its `DeviceConnection`, parser counters, `StreamTracker`, channel definitions, calibration, and recent samples.
- SLTP stable identity comes from INFO's serial (`ble:<serial>`). Two connected devices reporting the same serial are rejected to avoid merged channels. This guards accidental identity collision but is not cryptographic device authentication.
- `ConnectQueue` serializes connect/discover/subscribe sequences. It does not serialize all incoming samples after subscription.
- On every packet, parser/tracker state is entry-local; readings include device ID and channel ID. The recorder dictionary and columns store that identity with every row.
- A malformed packet increments only its device's parse diagnostics. It is not appended. A valid packet from another entry can still flow through the recorder.
- Device errors/reconnects are managed per `DeviceConnection`; the browser/OS BLE controller is shared infrastructure and may still impose global limits.
- No explicit app-level notification queue or per-device rate limiter exists. Notification delivery is owned by BLE stack/browser event dispatch. Firmware has no acknowledged delivery queue.

## Executed deterministic coverage

| Scenario | Result | Evidence class |
|---|---|---|
| Two mock peripherals, 1,000 samples each, two channels; exact raw/value/time/sequence/export identity | PASS | W3C Web Bluetooth mock + fake IndexedDB, `test/unit/data-integrity.test.js`. |
| Three simulated devices lose connection together; two recover while one powers off and exhausts retries; the surviving stream continues | Existing test PASS | Simulated transport, `test/unit/connection.test.js`. |
| Two different transports advertise the same SLTP serial; second is refused | Existing test PASS | Simulator, identity-collision unit test. |
| A malformed packet on one mock device while the second device sends valid values | PASS, newly added | `test/unit/data-integrity.test.js`; test verifies first device's parse/gap counters are local and second device remains complete. |
| Simulated pipeline at 1×10, 5×20, 8×50, 8×100, 8×200 Hz with two channels | Historical PASS as software pipeline; highest nominal case simulator reached ~81% of 3,200 readings/s expected and delivered 2,590 readings/s, no app gaps, stored=received | Headless Chrome 154, Windows AMD Ryzen 5 5600H; not physical BLE. |
| Four physical devices / all simultaneous notifications / maximum physical device count | NOT RUN | BLOCKED: no hardware. |

Commands run in this audit:

```powershell
node --test test/unit/data-integrity.test.js
npm.cmd test
```

Results: targeted file 7/7 passing. Full suite: 172 tests, 171 passed, 0 failed, 1 TODO. The additional test does not claim that multiple radio links operate concurrently; it tests app-layer isolation with deterministic mocks.

## Requested scale matrix

| Device count | Software evidence | Physical stress status |
|---:|---|---|
| 1 | Unit, end-to-end mock, simulator and browser scenarios exist | NOT RUN |
| 2 | Exact multi-device integrity and same-label separation covered | NOT RUN |
| 3 | Simulated disconnect/recovery isolation covered | NOT RUN |
| 4 | No dedicated 4-peripheral physical or simulator acceptance result located | NOT RUN |
| 5 | Historical pipeline profile has 5 simulated devices at 20 Hz; hardware plan proposes 3–5 boards | NOT RUN |
| 8 | Historical simulator benchmark at multiple rates; app can instantiate 8 simulator devices in the benchmark | NOT RUN; not a device limit or claim |
| Maximum supported | No app constant/cap; hardware/OS/browser limit depends on target stack | UNKNOWN |

## Stress cases and expected outcomes

The following are acceptance criteria for a target hardware matrix, not completed tests:

1. Two, three, four, and then increasing device counts at the required per-device rate; record negotiated/observed connection state, packet intervals, sequence gaps, event-loop lag, and storage results.
2. Identical channel labels across devices; prove exported device IDs and channels remain separate.
3. One device emits malformed lengths/flags/INFO while others remain clean; malformed device's counters rise, valid peers continue recording without cross-contamination.
4. One device silently stalls, disconnects, reboots, or loses range during a session; verify only its state/quality changes and others continue.
5. Simultaneous notification bursts across all connected devices, while rendering and IndexedDB writes run; account for per-device packet loss and host callback lag.
6. Reconnect under load and ensure no stale notification listeners or duplicate subscriptions.
7. Repeat at required max sampling rate and then above it to establish a documented failure boundary.

## Bottlenecks and limitations

- **Unknown radio ceiling:** browser Web Bluetooth does not expose a uniform connection/notification capacity. Device count and throughput depend on adapter, OS BLE host, browser, connection interval, packet length/MTU, and peripheral implementation.
- **Startup serialization:** adding multiple devices incurs serial connection setup latency; it avoids concurrent setup races but can lengthen onboarding.
- **Shared browser main thread:** parser and tracker run in notification event callbacks. The current callback does only synchronous parsing/accounting/append and simple sink work, but high-rate callbacks compete with UI and browser work.
- **Firmware transmit path:** no transmit queue acknowledgment/completion is checked. Queue congestion may cause lost notifications; sequence gaps expose loss only after a later valid packet arrives.
- **Storage pressure:** recorder holds in-memory pending readings during writes/retries, up to 200,000 pending entries; beyond this it counts dropped readings and reports incomplete stop. No physical load test confirms this threshold's memory cost on lab PCs.
- **No maximum:** the app's lack of a cap must not be interpreted as unlimited or tested support.

## Physical test status and release actions

`docs/HARDWARE_TEST_PLAN.md` Part B proposes a 3–5-board test after Part A passes. No Part A/Part B observations exist in this audit.

Priorities:

1. **P0:** obtain target PC/adapter/browser and board list; run 1→2→3→4→5-board stepped acceptance at product-required rates.
2. **P0:** define a product-supported device count and frequency only after the hardware matrix passes with measured sequence and device-time data.
3. **P1:** capture simultaneous device fault cases and verify unaffected streams through stop, recovery, and export.
4. **P1:** test the required maximum count under slow IndexedDB writes and chart updates; compare received/persisted/dropped counters.
5. **P1:** document permitted radio/firmware configuration, per-device rate ceilings, connection setup time, and failure indicators.

## Source and test references

- Connection serialization and retry state: `src/acquisition/device-connection.js:31-48,107-145`.
- Device-local identity, tracker, channel setup and packet processing: `src/acquisition/acquisition-service.js:39-115,136-205`.
- Mocked multi-device data integrity and new fault-isolation regression: `test/unit/data-integrity.test.js:96-192`.
- Three-device reconnect/failure isolation: `test/unit/connection.test.js:133-153`.
- Simulated performance profiles: `test/e2e/bench-pipeline.mjs:18-58`; historical results `docs/evidence/16-bench-pipeline.json`.
- Proposed physical 3–5 board acceptance: `docs/HARDWARE_TEST_PLAN.md:75-96`.

**Conclusion:** multi-device software identity/fault isolation has useful synthetic coverage. Real simultaneous BLE support and maximum connection count are **unverified**; do not advertise a numerical hardware limit.
