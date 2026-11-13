# Hardware acceptance checklist (NOT YET PERFORMED)

No step in this document has been run. Before this run, everything about SensorLab 2 on real hardware is **NOT VERIFIED**:
the firmware on an ESP32, real Web Bluetooth, multiple devices, timing accuracy, analog accuracy and crash durability.
Software-only evidence for everything else is in `docs/FINAL_SOFTWARE_READINESS_REPORT.md`.

Run it in three parts, in order:

* **Part A, one board.** One ESP32-C3, one PC, about 90 minutes. It answers the go/no-go question.
* **Part B, multi-device.** 3–5 boards. Run it only after A passes.
* **Part C, calibrated equipment.** Oscilloscope, reference resistors and a never-online PC. It can run on another day.

## How to record results

Copy this file to `docs/evidence/hw-<YYYY-MM-DD>/CHECKLIST.md` and fill in every **Observed** and **Result** cell. Save the
evidence (screenshots, exported files, Log → Copy text) in the same folder under the file names given in each step.

| Result | Meaning |
|---|---|
| **PASS** | The step ran and every item in *Expected* was observed |
| **FAIL** | The step ran and something differed. Write what you saw, keep the Log and the export, and open a defect |
| **BLOCKED** | The step could not run (missing equipment, an earlier step failed). Write the reason. This is **not** a pass |

Never mark a step PASS from memory or by inference: an observation or a file must back it up. If one sub-item fails, the
whole step is a FAIL.

## Prerequisites (check the day before)

| # | Item | How to check | ☐ |
|---|---|---|---|
| P1 | Windows PC with Bluetooth LE and Chrome or Edge ≥ 120 | `chrome://version`; Device Manager → Bluetooth lists an adapter | ☐ |
| P2 | Repository at the audited state, with `npm ci` done | `git status` shows the expected tree; `node --version` ≥ 20 | ☐ |
| P3 | Software checks green **on this PC** | `node scripts/verify-all.mjs docs/evidence/hw-<date>/preflight --skip-ci` → every step PASS; `01-npm-ci` shows SKIPPED because of `--skip-ci` (`summary.txt`) | ☐ |
| P4 | Arduino toolchain present (gitignored, under `build/arduino`) | `npm run firmware:compile` → `COMPILED: esp32:esp32:esp32c3` | ☐ |
| P5 | XIAO ESP32-C3 board(s), **data-capable** USB-C cable, divider wired `3V3 → 10.8 kΩ reference → D2/A2/GPIO4 → JST pin 1`, with JST pin 2 → GND | visual check; photograph the wiring and measure the actual resistor and 3V3 rail → `wiring.jpg` | ☐ |
| P6 | At least 2 known resistors (e.g. 1 kΩ and 10 kΩ, any tolerance) for the step stimulus in A10 | multimeter reading noted | ☐ |
| P7 | Android/iOS phone with **nRF Connect** (troubleshooting only) | app installed | ☐ |
| P8 | Release package built | `npm run build` then `npm run package` → `release/sensorlab-2.0.0-dev.zip` and its `.sha256` | ☐ |
| P9 | Stopwatch / phone clock for the crash and out-of-range steps | — | ☐ |

The commands below run in **PowerShell from the repository root**. Set these up once per terminal:

```powershell
$cli = "build\arduino\cli\arduino-cli.exe"
$cfg = @("--config-file", "build\arduino\arduino-cli.yaml")
$fqbn = "esp32:esp32:esp32c3"
New-Item -ItemType Directory -Force docs\evidence\hw-$(Get-Date -Format yyyy-MM-dd) | Out-Null
```

---

## Part A: one board (go/no-go)

Pass criterion for Part A: steps A1–A12 are all **PASS**. A13 and A14 must be PASS or carry a written explanation.

| # | Step and command | Expected | Observed | Result |
|---|---|---|---|---|
| A0 | **Configuration.** Record the PC model, `winver` build, `chrome://version`, the Bluetooth adapter and driver version (Device Manager), the exact board module, the cable, the sensor wiring, and the app build id (Log panel, first line) | everything written down → `config.md` | | ☐ PASS ☐ FAIL ☐ BLOCKED |
| A1 | **Toolchain.** `& $cli @cfg version` and `& $cli @cfg core list` | arduino-cli 1.5.x and `esp32:esp32 3.3.12` (the versions compiled during the audit) | | ☐ PASS ☐ FAIL ☐ BLOCKED |
| A2 | **Compile.** `& $cli @cfg compile --fqbn $fqbn --warnings all firmware/sensorlab_node` | exit 0; sketch size printed; no warnings from `sensorlab_node.ino` or `sltp.c` | | ☐ PASS ☐ FAIL ☐ BLOCKED |
| A3 | **Flash.** Plug the board in, then run `& $cli @cfg board list` and note the COM port. Then `& $cli @cfg upload -p COMx --fqbn $fqbn firmware/sensorlab_node` | upload reaches 100 % and the board resets. In nRF Connect: scan shows `SLab-XXXX` (last 2 MAC bytes) advertising service `075e0001-…` | | ☐ PASS ☐ FAIL ☐ BLOCKED |
| A4 | **Connect from `file://`.** Open `dist\index.html` by double-clicking it (Chrome/Edge). Add device → SensorLab v2 → pick `SLab-XXXX` | card: ID `ble:<12 hex>` matching the board MAC, fw `2.0.2`, model `SLab-R1`, configured 10 Hz, state **Streaming**, measured rate ≈ 10 Hz within 10 s. Screenshot → `A4-card.png` | | ☐ PASS ☐ FAIL ☐ BLOCKED |
| A4b | Only if A4 fails with a Bluetooth/permission error: run `powershell -ExecutionPolicy Bypass -File tools\serve.ps1` and repeat A4 at `http://localhost:8080/index.html` | records which launch modes work on this PC: file:// ☐ localhost ☐ | | ☐ PASS ☐ FAIL ☐ BLOCKED |
| A5 | **Divider validity.** Measure the actual reference resistor and D2/A2/GPIO4-to-GND voltage at rest and under stimulus; then short the JST pins and finally leave them open | channels `adc_sum16` (count) and `resistance` (Ω); freshness *fresh*; sequence increases by 1. Record the measured reference value and node voltages. Under the current 2.45 V validity limit and 10.8 kΩ reference, resistance is reportable only up to about 31.13 kΩ; above that, raw ADC remains valid but resistance is **invalid**. Short: resistance is valid and approximately 0 Ω. Open: resistance is invalid, never 1 000 000 Ω and never labelled open circuit by inference. Do not change the limit until the sensor range and ADC voltage are characterized. Restore the known resistor before continuing. | | ☐ PASS ☐ FAIL ☐ BLOCKED |
| A6 | **Start recording.** Record → the dialog lists the device and 2 channels, keep-awake ☑ → Start | preflight has no fatal items. Every explicitly required channel must deliver fresh valid data; for SLab-R1 this is `adc_sum16`, while `resistance` may be invalid. All channels stay tracked. The strip shows "● recording (all streams fresh)" for a fully healthy device and *Screen awake: active*. Startup verification passes within 8 s | | ☐ PASS ☐ FAIL ☐ BLOCKED |
| A7 | **Keep-awake.** Do not touch the PC for longer than its screen-off timeout (set it to 2 min beforehand) | the screen stays on; the strip still shows *active* | | ☐ PASS ☐ FAIL ☐ BLOCKED |
| A8 | **Power cycle.** Unplug the board for 10 s, then plug it back in (note the times) | strip → RECOVERING/INTERRUPTED, banner names the device, auto-reconnect → RECORDING. Card counters: disconnects +1, reconnects +1, restarts +1 (BOOT flag) | | ☐ PASS ☐ FAIL ☐ BLOCKED |
| A9 | **Out of range.** Shield the board (metal tin) or carry it out of range for 20 s | stream SUSPECT → STALE → RECOVERING → FRESH; *missing* increases; the stale message is announced once (not every second) | | ☐ PASS ☐ FAIL ☐ BLOCKED |
| A10 | **Known stimulus.** Swap the 1 kΩ and 10 kΩ resistors every 10 s, 6 times (note the times) | the chart steps between two levels. Values are near nominal (uncalibrated; within ~10 % is plausible, not a spec) | | ☐ PASS ☐ FAIL ☐ BLOCKED |
| A11 | **Stop and export.** Stop → "Recording stopped and finalized. N channel readings saved." Then History → View → CSV, JSON and ZIP | three files download (the browser's download list shows **Completed**, not Cancelled). Integrity warnings list the A8/A9 lifecycle events; no "startup failed". Save them as `A11-session.csv/.json/.zip` | | ☐ PASS ☐ FAIL ☐ BLOCKED |
| A12 | **Check the export.** `node tools/check-export.mjs docs\evidence\hw-<date>\A11-session.csv docs\evidence\hw-<date>\A11-session.json` → save the output as `A12-check.txt` | prints `check-export: PASS`. Per device/channel, `sequence` strictly increases within each epoch (a new epoch starts at the A8 power cycle); the gap total equals `quality.stream.missing` in the JSON; no duplicates; resistance steps line up with the A10 times (inspect manually) | | ☐ PASS ☐ FAIL ☐ BLOCKED |
| A13 | **Browser crash.** Record again; after 30 s end *all* Chrome processes in Task Manager (note the time); relaunch Chrome and open the app | "interrupted session" banner → Recover works. Loss window = kill time − last stored `relative_time_s` + start wall time, written down (expected ≲ 0.3 s; one run is an observation, not a guarantee) | | ☐ PASS ☐ FAIL ☐ BLOCKED |
| A14 | **Startup failure.** Power the board off, then press Record | either preflight is fatal (device not connected), or verification fails with Retry/Cancel after ≈ 8 s. No session appears as *completed*. Cancel during "checking…" returns to idle with "No session was created." | | ☐ PASS ☐ FAIL ☐ BLOCKED |

## Part B: multi-device (3–5 boards)

Prerequisites: Part A passed; every board has been flashed (A3) and is labelled with its `SLab-XXXX` name.

| # | Step | Expected | Observed | Result |
|---|---|---|---|---|
| B1 | Connect 3 boards one after another | 3 cards, all *Streaming*, distinct IDs | | ☐ PASS ☐ FAIL ☐ BLOCKED |
| B2 | Record for 30 min at 10 Hz with the page visible. Every 10 min, note CPU and memory from Chrome's Task Manager (Shift+Esc) | 0 disconnects; per-device measured rate ≈ configured; missing samples recorded per device | | ☐ PASS ☐ FAIL ☐ BLOCKED |
| B3 | Power off one board for 10 s | the other streams stay FRESH (no gap in their sequence); the board that was off recovers; the recovery time is noted | | ☐ PASS ☐ FAIL ☐ BLOCKED |
| B4 | Power off all boards together for 10 s | each recovers independently; the recovery time per board is noted | | ☐ PASS ☐ FAIL ☐ BLOCKED |
| B5 | Export CSV + JSON; run `node tools/check-export.mjs <csv> <json>` | no reading under the wrong `device_id`; per-device sequence monotonic | | ☐ PASS ☐ FAIL ☐ BLOCKED |
| B6 | Repeat B2 with 5 boards, then at 20 Hz | the **supported configuration** is the largest (devices × rate) that ran 30 min with 0 disconnects and acceptable missing samples. **Declare only what was measured** in `OPERATING_LIMITS.md` | | ☐ PASS ☐ FAIL ☐ BLOCKED |

## Part C: calibrated equipment

| # | Step | Expected | Observed | Result |
|---|---|---|---|---|
| C1 | **Intra-device timing.** Add a GPIO toggle per sample in a *test build only* (do not ship it); measure it with an oscilloscope; compare it with `device_time_us` deltas | report mean, sd and max error. The ≤ 1 ms target (proposed in the engineering handoff; see PROTOCOL.md) is unverified until this is done | | ☐ PASS ☐ FAIL ☐ BLOCKED |
| C2 | **Cross-device timing.** Apply one physical step to 2 boards at once, ≥ 20 times; compare the transition times in `relative_time_s` | report the offset and spread. The ≤ 10 ms target (proposed in the engineering handoff) is unverified | | ☐ PASS ☐ FAIL ☐ BLOCKED |
| C3 | **Analog accuracy.** Reference resistors within the provisional guarded divider range (100 Ω … 30 kΩ, ≤ 0.1 %), 60 s each, 3 sessions; measure the actual 10.8 kΩ reference and supply rail first | mean, noise sd, linearity, repeatability. Enter the fitted gain/offset in Device settings → Calibration | | ☐ PASS ☐ FAIL ☐ BLOCKED |
| C4 | **Crash durability, repeated.** A13 × 10, plus a lid-close/sleep test and (if acceptable) a power pull | max and median loss window; power-loss behaviour noted | | ☐ PASS ☐ FAIL ☐ BLOCKED |
| C5 | **Never-online PC.** On a PC that has never opened SensorLab: copy the release ZIP and `.sha256` by USB, check `Get-FileHash -Algorithm SHA256`, unzip, disable networking (airplane mode **and** unplug Ethernet), open `index.html`, then connect, record and export. Repeat with `serve.ps1` | works fully offline. This is the only test that can settle "never-online PC" (the audit tested the same machine with networking blocked) | | ☐ PASS ☐ FAIL ☐ BLOCKED |

## Troubleshooting

| Symptom | Likely cause → action |
|---|---|
| `board list` shows no port | charge-only cable, or a driver is missing → use a data cable; C3 boards use native USB-CDC (no driver on Windows 10/11). Hold BOOT while plugging in to force download mode |
| Upload fails with "Failed to connect" | hold BOOT, tap RESET, release BOOT, retry the upload; close any serial monitor holding the port |
| Chooser is empty | board not advertising → check in nRF Connect. If nRF Connect sees it but Chrome does not: Bluetooth is off in Windows, or Chrome lacks permission (Windows Settings → Privacy → Bluetooth). Check `chrome://bluetooth-internals` |
| "Bluetooth not available" on `file://` | use `tools\serve.ps1` (A4b). Record which mode works |
| Connects, then "INFO invalid" / protocol error | firmware does not match the app → reflash from this tree (A2–A3). Read INFO in nRF Connect (characteristic `075e0003-…`) and compare it with `docs/PROTOCOL.md` §3 |
| Stays *Waiting for data* | notifications not enabled, or the device is not streaming → read INFO `st`. Power-cycle the board. Remove and re-add the device |
| Frequent disconnects | distance, interference (Wi-Fi 2.4 GHz, USB 3 hubs near the adapter) or power saving → move closer, disable *Allow the computer to turn off this device* for the adapter, try a USB BT dongle on an extension cable |
| Values stuck at the ADC limit or invalid | check the divider and D2/A2/GPIO4 wiring with a multimeter; an open circuit is expected to make only the derived resistance invalid above the 2.5 V calibrated range |
| Keep-awake shows *unavailable/failed* | the Wake Lock API was refused (battery saver, policy) → plug in the power, disable battery saver; otherwise set the screen timeout to *Never* manually and note it |
| Download shows *Cancelled* / a 0-byte file | report it as a FAIL with the session size; the browser's download list and the app Log are evidence |
| Anything else | Log panel → Copy; save as `log-<step>.txt`; mark the step FAIL |

## Sign-off

| Part | Result | Tester | Date | Evidence folder |
|---|---|---|---|---|
| A, one board | ☐ PASS ☐ FAIL ☐ BLOCKED | | | |
| B, multi-device | ☐ PASS ☐ FAIL ☐ BLOCKED | | | |
| C, calibrated | ☐ PASS ☐ FAIL ☐ BLOCKED | | | |

Hardware claims are allowed only after the matching part is signed off. Update `docs/VALIDATION_REPORT.md`
§11–13 and `docs/OPERATING_LIMITS.md` with the measured values, using the evidence classes `REAL BLE INTEGRATION` / `PHYSICAL MEASUREMENT`.
