# SensorLab 2 — Data Frequency Audit

## Current revalidation — 2026-11-11

The firmware does not isolate acquisition from transport: after the 16 `analogRead()` calls, the same Arduino `loop()` immediately calls `dataChar->notify()` (`firmware/sensorlab_node/sensorlab_node.ino:144-176`). There is no hardware-timer/ADC-DMA producer, transmit queue, queue-full result, completion callback or measured connection interval. Thus two active devices can have correct identities while still show late, gapped or irregular physical sampling under BLE congestion. The configurable 0.1–1000 Hz range is a command range—not an established supported rate.

Capture `sequence` and `device_time_us` separately for each real device; host callback timing cannot prove ADC cadence. Record mean, standard deviation, P95/P99 interval error, sequence gaps and duplicate count at 10 Hz before trying higher rates.

**Status:** source/static review and software-only test review completed. Physical sampling and BLE timing are **BLOCKED** because no ESP32/sensor hardware was available.  
**Test date:** 2026-11-09 for commands run in this audit. Historical simulator evidence is dated 2026-10-13/14.  
**No production code was changed.** One deterministic unit regression was added in `test/unit/data-integrity.test.js`.

## Executive result

The firmware configures a default device measurement cadence of **10 Hz** and accepts CONTROL periods corresponding to **0.1–1000 Hz**. This is a requested schedule, not a measured physical sample rate. Each due slot executes sixteen sequential `analogRead()` calls, computes a two-channel packet, then calls BLE `notify()` synchronously from the Arduino `loop()`. The scheduler advances from an absolute `esp_timer_get_time()` deadline and counts skipped slots. There is no independent hardware timer/ADC DMA acquisition path, explicit notification queue, transmit-completion check, or on-board timing telemetry.

The browser and software pipeline have useful sequence, timestamp, loss, and overload accounting. **No actual physical sampling frequency, BLE delivery frequency, end-to-end latency, P95/P99 timing deviation, or hardware throughput was measured.** The 0.1–1000 Hz setting is not evidence that the hardware supports that range.

## Frequency layers — do not conflate

| Layer | Implementation / configured value | Evidence and result |
|---|---|---|
| ADC conversion | Sixteen sequential `analogRead(GPIO0)` calls per due firmware loop iteration. `analogReadResolution(12)` selects a nominal 12-bit result. | Source verified; conversion times, ADC configuration accuracy, and per-conversion timing are unmeasured. |
| Device measurement | `DEFAULT_PERIOD_US = 100000` (10 Hz); CONTROL allows 1,000–10,000,000 µs (1,000–0.1 Hz). The nominal resistance and averaged-count values are computed once after the sixteen reads. | Design/configuration only. No board measurement. At 1 ms periods, sixteen conversions plus calculation and BLE work may exceed the period. |
| BLE notification | One 20-byte DATA packet for two channels is offered with `dataChar->notify()` for a connected, streaming device at a sampled slot. | No explicit app queue or notification-completion/queue-full signal. Firmware comments note Bluedroid `notify()` does not report queue-full; loss is expected to appear as a later sequence gap. Real stack behavior unmeasured. |
| Browser receive | `characteristicvaluechanged` captures `performance.now()`-based receipt time, copies the notification bytes, then calls the acquisition callback synchronously. | W3C API mock and simulator covered. Browser/OS batching and real radio cadence unmeasured. Host receipt time is not the physical sample time. |
| Chart redraw | `LiveChart` accepts each reading into bounded ring buffers; the render loop is capped at 8 FPS by default and uses min/max decimation to at most 1,200 points per live series. | Source verified. This is intentionally independent from the acquisition count; it does not establish a hardware throughput limit. |

## Firmware schedule and determinism

In `firmware/sensorlab_node/sensorlab_node.ino`:

1. `setup()` sets `nextSlotUs` to current `esp_timer_get_time()` plus the selected period.
2. `loop()` returns until the deadline.
3. `sltp_advance_slot()` advances the scheduled deadline by whole periods. If execution is late, it returns the number of skipped slots; the sequence is advanced for those slots.
4. The code performs sixteen ADC reads, then captures `device_time_us` immediately after conversion.
5. It builds one sample and, when connected and streaming, encodes it and calls `setValue()` then `notify()`.
6. Sequence increments for the emitted sample. Thus, skipped slots are visible as sequence gaps rather than fabricated readings.

The deadline arithmetic is deterministic for its inputs and has host C unit cases for on-time, late, and wrap-scale schedule arithmetic. The acquisition loop itself is **not hard real-time**: it is a polling Arduino `loop()`, not an interrupt/DMA-timed sample engine. Actual slot timing is affected by sixteen ADC conversions, floating-point work, BLE library calls, runtime scheduling, and any prior loop delay. `notify()` is called inline; whether it blocks long enough to make later slots late is unknown. The device timestamp is taken after the ADC burst, so it timestamps the end of the effective averaging window, not a documented midpoint or the start of the slot.

`bootPending` clears after `notify()` is called, not after confirmed delivery. A first-packet BOOT flag can therefore be missed; the INFO boot nonce is the documented fallback. This has not been checked on a board.

## Measured values and test classification

| Measurement/test | Result | Classification |
|---|---|---|
| Physical device rate and device-clock interval mean/std | **NOT RUN** | BLOCKED: no board/sensor and no physical device timestamp trace. |
| Physical P95/P99 absolute interval deviation | **NOT RUN** | BLOCKED: no device-side timestamp series. Host receipt timestamps would not be an acceptable substitute. |
| Physical BLE packets/s, packet loss, duplicates, end-to-end latency | **NOT RUN** | BLOCKED: no real GATT/radio capture; firmware notification completion is not reported. |
| 1,000 scripted samples/device, two mock devices, two channels, 100,000 µs fixture interval | All exact sample counts, raw/value identities, timestamps and per-device separation asserted. Mean device interval 100,000 µs; sample standard deviation 0 for the deliberately constant fixture. | PASS as deterministic simulated integration; **not a sensor measurement**. `test/unit/data-integrity.test.js`. |
| Simulated 20-packet bursts per 400 ms at nominal 50 Hz | Existing unit test asserts all samples stored and device-time intervals preserved without false stale state. | PASS for scripted delivery; not a BLE timing test. |
| Software pipeline benchmark, 8 devices × nominal 200 Hz × 2 channels | Historical 30 s run: 2,590 readings/s persisted = received; 0 app-reported missing; 0 unsaved; 14 ms max measured event-loop lag. Simulator delivered 38,855 samples vs 48,012 nominal (~81%). | PASS for recorded simulator run, but **not a BLE benchmark** and simulator did not meet its nominal schedule. `docs/evidence/16-bench-pipeline.json`. |
| Software pipeline benchmark, 8 devices × nominal 100 Hz × 2 channels | Historical run: 1,613 readings/s, 0 app-reported missing, persisted equals received, 24 ms maximum event-loop lag. | SIMULATED only. |
| C schedule/codec unit test | C compiler produced a test executable, but Windows Application Control blocked execution during this audit. No assertions ran. | BLOCKED, not PASS/FAIL of codec behavior. |

The benchmark numbers above are retained historical results, not measurements rerun for this audit. The historical benchmark's simulator only reached 82% of nominal at its highest setting; that indicates a simulator/host ceiling in that run, not the BLE ceiling or the app's proven maximum.

## Reproducible commands

From the repository root in Windows PowerShell:

```powershell
node --test test/unit/data-integrity.test.js
npm.cmd test
npm.cmd run test:firmware
npm.cmd run firmware:compile
node test/e2e/bench-pipeline.mjs 30
```

The firmware compile and simulator benchmark were **not** run in this audit: the former creates/replaces build output and cannot confirm hardware behavior; the latter writes `test/e2e/bench-results.json`. The host firmware C test was attempted with `npm.cmd run test:firmware`; its generated executable was blocked by Application Control. Exact command output is reflected in the audit record for this task.

## Delay/loss/corruption points

| Stage | Possible effect | Existing protection / observability |
|---|---|---|
| Polling loop / ADC burst | Late slot; 16-read burst extends past deadline; missed samples | Slot scheduler skips rather than catches up; skipped slots advance sequence and set per-sample overrun flag when a connected notification is sent. No measured bounds. |
| Resistance calculation | Conversion/rounding changes engineering result | Nominal float formula, centi-ohm integer rounding; no ADC calibration or validated sensor transfer function. |
| BLE library / connection event | Notification delayed, dropped, queue full, or batched | Sequence gaps and DEVICE_OVERRUN attribution; no explicit retry/acknowledgement queue. |
| OS/browser notification dispatch | Delivery jitter/batching; callbacks may be delayed when page is throttled | Device timestamp retained; hidden page periods logged. Background acquisition is unsupported. |
| Parser/tracker | Malformed/repeated data could be rejected or classified | Strict version/length/channel/flag checks; duplicates suppressed; late arrivals within window retained and flagged; gap/invalid counters. |
| Recorder/IndexedDB | Write delay/failure or storage exhaustion | 250 ms default flush cadence; serialized in-flight chunk; same chunk number/content retried; pending limit 200,000; dropped/unsaved counts surfaced. |
| Chart | Rendering delay or chart exception | Chart push is bounded; requestAnimationFrame render is throttled/decimated; recorder hand-off precedes visualization; chart sink exceptions isolated. |

## Release blockers and recommendations

1. **BLOCKER — physical frequency evidence:** run the hardware plan with device-side `device_time_us` over at least the intended minimum and maximum rates; report mean/std/P95/P99 interval deviation, sequence gaps, and overrun flags. Include independent oscilloscope/logic analyzer timing if a hard cadence is required.
2. **BLOCKER — define achievable rate:** document required rate per channel/device and whether frequency means ADC bursts, packet rate, or per-channel readings. The present 1,000 Hz config ceiling is not a validated capability.
3. **BLOCKER — notification congestion:** test slow/absent subscribers and simultaneous devices; measure actual queue/backpressure and confirm sequence gaps accurately account for lost notifications.
4. If strict timing is required, move sampling to a hardware timer/ADC continuous/DMA design and decouple BLE transport from sampling; do not infer that the present loop is deterministic enough.
5. Validate clock drift/wrap and reconnect boot handling for long runs, including the ~71.6 minute 32-bit device-clock wrap documented by SLTP.

## Source references

- Firmware configuration and loop: `firmware/sensorlab_node/sensorlab_node.ino:26-30,105,141-176`.
- Slot arithmetic: `firmware/sensorlab_node/sltp.c:57-66`; unit cases: `firmware/test/test_sltp.c:80-96`.
- Protocol timestamps and sequence semantics: `docs/PROTOCOL.md:34-84,98-120`.
- Device-side interval tracking: `src/acquisition/stream-tracker.js:78-190`.
- Host receive timestamp and byte copy: `src/transport/web-bluetooth.js:30-72`.
- Chart render cadence and decimation: `src/viz/charts.js:82-180`.
- Benchmark configuration and limitations: `test/e2e/bench-pipeline.mjs:1-58`; historical result `docs/evidence/16-bench-pipeline.json`.

**Current conclusion:** frequency requirements are **not yet demonstrated on hardware**. The application software processes synthetic traffic successfully within the reported range, but no real BLE frequency, timing quality, or end-to-end latency claim is justified.
