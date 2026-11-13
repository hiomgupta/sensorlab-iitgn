# Export formats

Exports are produced from **stored data**: a single read-only IndexedDB transaction gives a consistent
snapshot. They are never produced from the live chart. Implementation: `src/export/export.js`, `src/export/zip.js`.
Tests: `test/unit/export.test.js`, plus the E2E downloads in `test/e2e/run-e2e.mjs`.

## CSV — `sensorlab-csv/1`

* Encoding: **UTF-8 with BOM**. The BOM is there so Excel shows `Ω`, `°C`, `µε` correctly. Python reads it with `encoding="utf-8-sig"`.
* Line endings: CRLF. Quoting follows RFC 4180: fields containing `,` `"` CR LF, or leading/trailing spaces, are quoted, and `"` is doubled.
* **Formula-injection guard on text columns only** (`device_id`, `device_name`, `parameter`, `unit`, `session_id`):
  a value starting with `=`, `+`, `-`, `@`, TAB or CR gets a leading `'`. Numeric columns are **never** altered,
  because a negative number legitimately starts with `-`.
* Numbers use JavaScript's shortest exact round-trip representation. No rounding is applied.
* Rows are in persisted (arrival) order, one row per (sample, channel). A packet with two channels can therefore produce two CSV rows. The quality `received` counter is packet-level, while storage status counts channel rows; during recording, the device card and storage status refresh on different schedules. Compare counters from the same observation time, or use the finalized export/JSON for reconciliation.

| column | meaning |
|---|---|
| `session_id` | immutable session UUID |
| `device_id` | stable identity: `ble:<serial>` (SLTP), `sim:<serial>` (simulated), `webbt:<id>` (legacy, session-local fallback), `legacy:<id>` (imported from 1.x) |
| `device_name` | display name at export time (may be renamed, so it is not an identity) |
| `channel_id` | channel index on that device |
| `parameter` | channel name |
| `sequence` | device sequence number (SLTP). For legacy devices it is a host-assigned arrival counter. Empty for imports. |
| `device_time_us` | device clock in µs, unwrapped across the 2³² rollover. Empty for legacy devices. |
| `relative_time_s` | seconds since recording start. SLTP: device clock anchored at the first sample. Legacy: host receipt time. |
| `host_receive_ms` | host monotonic (`performance.now`) receipt time, in ms since recording start |
| `raw_value` | raw value as received (SLTP int32 counts; legacy decoded number). Never calibrated. |
| `value` | calibrated engineering value. **Empty when invalid.** No sentinel numbers. |
| `unit` | channel unit |
| `valid` | `1` or `0` |
| `quality_flags` | `|`-separated names: `invalid`, `gap_before`, `out_of_order`, `device_overrun`, `boot`, `host_time_only`, `simulated`, `sensor_fault`, `timebase_reset`, `sentinel`, `clock_anomaly` |

## Metadata / JSON — `sensorlab-export/1`

`metadata.json` (inside the ZIP) and the full `.json` export share these sections:

```
schema, csvSchema, exportedWall, exportedBy
session      { sessionId, name, group, notes, state, createdWall, startedWall, endedWall, simulated, app, storage, recovery, visibility, provenance }
devices      [ { deviceId, displayName, transport, simulated, protocol, firmware, model, serial, configuredRateHz, identity,
                 channels[ { channelId, name, unit, deviceScale, deviceOffset, calibration{gain,offset,tare,version,model} } ],
                 calibrationLog[], sentinels[] } ]
quality      { <deviceId>: { state, stream{received, missing, missingDeviceAttributed, duplicates, outOfOrder, gapCount, longestGap, gaps[],
                 restarts, deviceIntervalUs{n,mean,std,min,max}, hostIntervalMs{…}, excessReceiptLatencyMs{…}, measuredRateHz, driftPpmEstimate},
                 parseErrors{code:count}, invalidPackets, invalidSamples, connection{connects, disconnects, reconnects, failedAttempts, timeouts} } }
qualityFlagLegend, timeDefinitions
annotations  [ { annotationId, relS, text, deviceId, wall } ]
integrity    { readingCount, chunkCount, corruptChunks[], missingChunkNos[], sessionState, complete, warnings[] }
readings     { columns: [device_id, channel_id, sequence, device_time_us, relative_time_s, host_receive_ms, raw_value, value, quality_flags(bitmask)], rows: [[…], …] }   (full JSON only)
```

Definitions used in `quality`:

* **Jitter** (`deviceIntervalUs.std`): sample standard deviation of the device-clock intervals between
  *consecutive* sequence numbers. Intervals that span a gap or a clock anomaly are excluded.
  `hostIntervalMs` is the same statistic on host receipt times. It includes BLE connection-interval
  batching and OS scheduling, so it is **not** the sampling jitter.
* **Measured rate**: (n−1)/span over the most recent ≤256 samples on the device clock.
* **Missing**: sequence numbers never received. It says nothing about *where* the loss occurred.

**Round trip guarantee:** `parseExportJson(buildJson(s))` reproduces identical readings, devices and
annotations (semantic equality, tested). Imported sessions get `state: "imported"` and a `provenance` block.

**Import limits and validation:** the browser accepts JSON files up to 64 MiB and 500,000 reading rows
(at most 256 devices and 100,000 annotations). Imports validate the schema, session timestamps and
metadata bounds, device/channel references, sequence/time/value/quality fields, and annotation references
before writing. The session header, chunks, and annotations are committed in one IndexedDB transaction;
a failed import leaves no partial imported session.

## ZIP bundle

`readings.csv` + `metadata.json` + `annotations.csv`, stored uncompressed. Its validity is checked with Python's
`zipfile` in unit and E2E tests.

## Integrity warnings

An export always succeeds if the data can be read, but it is **flagged** (UI toast + `integrity.warnings`) when
the session is open or recovered, chunks are corrupt or missing, readings were unsaved or dropped, the data is
simulated, or the session contains legacy streams in which loss cannot be detected.
