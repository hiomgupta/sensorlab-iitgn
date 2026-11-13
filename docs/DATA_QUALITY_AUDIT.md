# SensorLab 2 — Data Quality Audit

## Current revalidation — 2026-11-11

**P0 finding for the reported two-device wrong-value symptom:** both reference-firmware nodes apply the same *nominal, uncalibrated* voltage-to-resistance conversion. `sensorlab_node.ino:155-158` assumes a 3.3 V supply, a 4095-count full scale and an exactly 10.8 kΩ reference resistor. It neither configures nor characterizes ADC attenuation/calibration, and it transmits a derived resistance—not a raw ADC value—in channel 1. A common wiring, resistor-tolerance, supply, ADC non-linearity or divider-orientation error will make both devices report wrong resistance even though the browser keeps their streams separate. This is a firmware/measurement-model defect, not evidence of device-stream mixing.

Channel 0 is also easily misread: its packet `raw_value` is the **sum** of 16 ADC conversions (`:151-166`), while the displayed engineering value uses INFO scale 0.0625 and is their mean. The 16 individual conversions are not retained.

No physical hardware was available for this revalidation, so its magnitude and exact analog cause are **BLOCKED** pending the reference-resistor test in `HARDWARE_TEST_PLAN.md` C3.

**Status:** code-path and deterministic synthetic-data review completed. Physical sensor accuracy, calibration, analog range, noise, and environmental performance are **BLOCKED** pending hardware/reference instrumentation.  
**No production code was changed.**

## Executive result

The software preserves each parsed packet's raw integer value, device sequence number, device timestamp, host receipt time, relative time, and quality flags. Invalid channel values are represented as `null`, not silently substituted with zero; invalid raw values remain available. Duplicates are counted and not recorded, late packets are recorded with an out-of-order flag, gaps are counted, and malformed packets are rejected with diagnostics. Readings are appended to the recorder before visualization sinks run.

The reference firmware's values are **not calibrated laboratory measurements**. Channel 0 is the sum of sixteen ADC codes; the protocol scale divides that sum by 16 to yield a mean code. Channel 1 is a nominal resistance calculation using a fixed 3.3 V supply and 10.8 kΩ reference, rounded to centi-ohms. There is no ESP32 ADC calibration/linearity compensation or hardware-validated uncertainty budget in the sketch. No physical accuracy claim can be made from the code or simulator tests.

## One measurement: sensor input to export

1. **Physical input / ADC:** GPIO0 is read sixteen times sequentially with `analogRead()`. `analogReadResolution(12)` selects nominal 12-bit resolution. The sixteen integer results are summed.
2. **Firmware processing:** channel 0 value is the unaveraged integer sum (maximum nominal sum 16 × 4095 = 65,520). INFO scale `0.0625` converts it to the arithmetic mean of those sixteen ADC codes. Channel 1 derives `vout` from `sum / 16 / 4095 × 3.3 V`, computes `10,800 × vout / (3.3 − vout)`, and rounds `100 × resistance` to a signed integer centi-ohm packet value.
3. **Validity:** resistance is considered valid only when computed `vout` is greater than 0.01 V and less than 3.29 V and the centi-ohm value fits `int32`. If invalid, the channel valid bit is cleared and the packet's raw channel field is set to zero. The host stores `value: null` with INVALID while preserving that transmitted raw zero. This is an explicit invalid representation, not a claim that the physical reading was zero.
4. **Wire encoding:** SLTP v1 uses a 12-byte header followed by little-endian `int32` values. At two channels, the payload is 20 bytes. The sample sequence and 32-bit device time are encoded; device time is captured after the ADC burst.
5. **Transport/parser:** Web Bluetooth copies the received DataView bytes. The JS parser verifies exact length/version/channel count/flags/valid mask and decodes signed little-endian values. Structurally invalid packets are counted and rejected.
6. **Tracking/conversion:** sequence/time tracker classifies duplicate, late, gap, restart, overrun and clock anomalies. For each channel, engineering value is `raw × deviceScale + deviceOffset`; user calibration then applies `engineering × gain + offset − tare`. The original `raw` field is unchanged.
7. **Recording:** the complete reading object is synchronously appended to recorder columns before visualization sinks. Persisted chunks carry raw/value/sequence/times/flags. IndexedDB append of a chunk and matching session metadata is one read-write transaction.
8. **Export:** CSV `raw_value` is the packet's integer value (for channel 0, the sum of the 16 ADC results; for channel 1, the derived centi-ohm value), `value` is calibrated engineering value or empty if invalid, and quality flags are rendered by name. JSON retains equivalent raw values and bitmasks; ZIP packages CSV and metadata.

Thus, **individual ADC conversions are not retained**. Channel 0 preserves only their sum. Channel 1's `raw_value` is not a raw ADC code; it is the firmware-computed centi-ohm integer before host calibration. The export column name `raw_value` means raw packet field, not always raw physical sensor output.

## Data-quality checks

| Property | Implementation | Result / limitation |
|---|---|---|
| ADC resolution | `analogReadResolution(12)` | Nominal code width only. ADC attenuation/reference behavior and effective number of bits are not configured/verified here. |
| Signedness and endianness | Firmware serializes 32-bit values little-endian; JS reads `getInt32(..., true)`. | Boundary/vector unit tests cover positive/negative values and endianness; physical ADC range is nonnegative. |
| Sample averaging | Sixteen sequential reads are summed; host scale 1/16 produces mean counts. | No partial window: code loops all 16 calls before forming each sample. Conversion timing/aperture and noise reduction are unmeasured. There is no separate digital low-pass filter or documented anti-aliasing. |
| Channel 0 raw value | Sum of 16 ADC counts (nominal 0–65,520). | Sum is preserved; individual counts and within-window variance are lost. Mean-code increments can be fractional at 1/16-count steps after scaling. |
| Channel 1 raw value | Rounded centi-ohm integer from nominal divider formula. | Computed value, not ADC raw; float conversion, fixed reference/supply assumptions, and centi-ohm quantization. Accuracy is unverified. |
| Calibration order | `raw × device scale + device offset`, then user gain/offset/tare. | Order is explicit and code-tested. Raw packet value is not modified. |
| Tare | Mean of recent valid engineering readings after user gain/offset over a bounded recent window (default 1 s, minimum 3 samples). | Code/test behavior verified; physical stability, drift, and suitability for a particular instrument are not. |
| Invalids | Invalid mask/sentinel/fault/nonfinite paths produce `null` value and flags; raw field retained. | No zero fill of missing readings. Firmware sets invalid resistance raw field to zero but valid bit is clear, and host labels it invalid. |
| Gaps/duplicates | Sequence-based accounting; duplicate suppressed, late packets can be stored and flagged, gaps counted. | Synthetic tests assert behavior; real transport loss rates unmeasured. |
| Device/channel isolation | Composite identity uses device ID and channel; collisions on self-reported serial are refused. | Deterministic two-device tests check no stream mixing. Not a cryptographic identity check. |
| Display vs stored vs exported | Same processed reading goes to Recorder before chart sinks; export uses stored snapshots. Chart uses a separate ring buffer and decimator. | Code path and synthetic tests verified. Chart decimation changes only displayed points, not stored readings. No physical end-to-end comparison. |

## Numerical and physical accuracy

- The divider formula assumes a 3.3 V supply, 4095 full-scale code, and 10.8 kΩ reference resistor. Actual supply, resistor tolerance, wiring, ADC attenuation, ADC nonlinearity, temperature, sensor tolerance, and board revision are not compensated in the reference sketch.
- The code uses floating-point calculation and integer `lroundf()` to centi-ohm units. This representation has finite resolution; arithmetic consistency does not establish metrological accuracy.
- The averaging interval is the duration of sixteen sequential ADC calls. The implementation timestamps after those calls, so exported device time corresponds approximately to the end of the burst. The individual conversion times and time span are not logged.
- No sensor-level anti-aliasing or independently scheduled 16-sample window is present. Whether that matters depends on sensor dynamics and required bandwidth.
- No ADC calibration/attenuation API is configured in the sketch. Firmware README explicitly labels the resistance channel nominal and uncalibrated.
- No reference resistor measurements, oscilloscope data, multimeter comparison, error bars, linearity, repeatability, hysteresis, or temperature testing are available.

**Accuracy verdict:** **NOT DEMONSTRATED.** Treat the current sketch as a reference/sample implementation, not a calibrated instrument.

## Tests and results

| Test | Result | Classification |
|---|---|---|
| 1,000 known sequence/timestamp samples per each of two fake BLE devices, two channels; raw/value/export row comparisons | PASS | Deterministic synthetic integration. No physical measurement. |
| Duplicate, late, malformed, gap, invalid-mask and per-device fault injection | PASS | Unit/simulator fixtures. |
| New regression: malformed packet on one mock peripheral does not alter second device's stored samples, parsing errors, or gap count | PASS, 7 tests in `data-integrity.test.js`; full suite 171 pass, 0 fail, 1 existing TODO | Simulated W3C BLE API and fake IndexedDB. |
| Firmware C codec/slot executable | BLOCKED | Compiler emitted executable; Windows Application Control denied execution, so no assertions ran in this audit. |
| Board ADC or resistance accuracy | BLOCKED | No hardware or calibration instruments available. |
| CSV/JSON/ZIP historical round-trip | Prior evidence PASS | Existing simulated exports, not a new physical accuracy check. |

Commands executed:

```powershell
node --test test/unit/data-integrity.test.js
npm.cmd test
npm.cmd run test:firmware
npm.cmd run lint
```

`npm.cmd test` reports 172 tests total: 171 pass, 0 fail, 1 TODO. The TODO is a separate SessionController preflight dependency-exception issue documented in `docs/FINAL_SOFTWARE_READINESS_REPORT.md`.

## Prioritized quality actions

1. **P0 — sensor specification:** define the actual sensor transfer function, input range, required uncertainty, bandwidth, sampling aperture, and calibration procedure.
2. **P0 — calibrate analog chain:** configure/characterize ESP32 ADC attenuation and calibration; measure reference supply and resistor; compare to calibrated instruments across range/temperature.
3. **P0 — preserve measurement semantics:** consider exporting `adc_sum16` explicitly as a sum and document the derived mean; consider saving raw ADC burst or count variance if auditability/noise characterization is required.
4. **P1 — timing:** record or independently measure ADC burst duration and per-sample timing; characterize aliasing and whether the 16 conversions constitute a suitable average.
5. **P1 — acceptance corpus:** capture real packets and compare sequence, device timestamp, raw channel values, calibrated displayed values, persisted values, and all export formats byte/row for row.
6. **P1 — invalid cases:** verify open/short thresholds against actual wiring, disconnected sensor faults, ADC saturation, and any possible signed/overflow boundary on the physical board.

## Source references

- Firmware ADC, sum, conversion, packet timestamp, validity and notify: `firmware/sensorlab_node/sensorlab_node.ino:26-30,105,152-176`.
- Firmware byte serialization: `firmware/sensorlab_node/sltp.c:5-33`.
- SLTP signed little-endian decoder and validity checks: `src/protocol/sltp.js:56-94`.
- Device scale, user calibration and tare: `src/acquisition/calibration.js:16-39`.
- Data conversion, invalid flags, recorder-before-sink ordering: `src/acquisition/acquisition-service.js:148-205`.
- Persisted column schema and structural validation: `src/storage/idb-repository.js:36-50,114-124`.
- CSV value and quality-field mapping: `src/export/export.js:15-62,130-180`.
- Firmware calibration caveat: `firmware/README.md:14-34`; protocol channel description: `docs/PROTOCOL.md:60-91`.

## Conclusion

The protocol-to-storage/export path has strong synthetic integrity evidence and does not silently convert missing values to zero. Physical measurement accuracy and exact sampling-time semantics remain unproven. Product release as a laboratory-grade instrument should be blocked until requirements and calibrated hardware measurements are supplied.
