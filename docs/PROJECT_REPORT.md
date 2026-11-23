# SensorLab 2: Complete Project Report

**Technical architecture, laboratory operations, use cases, limitations and maintenance**

**Prepared:** 24 November 2026  
**Application version:** `2.0.0-dev`  
**Reference firmware:** `2.0.2`, SLTP v1, XIAO ESP32-C3 / `SLab-R1`  
**Project:** SensorLab, IIT Gandhinagar / Smart Sense Lab  
**Repository:** [hiomgupta/sensorlab-iitgn](https://github.com/hiomgupta/sensorlab-iitgn)

This report describes the current development worktree, including the optional Firebase backup and unified Profile interface. It is not a claim that every feature has been physically qualified or released. The cloud/Profile changes and these documents were not committed or pushed as part of preparing this report.

**Reader shortcuts:** [One-page handover](LAB_HANDOVER.md) · [Printable handover](LAB_HANDOVER.pdf) · [Printable full report](PROJECT_REPORT.pdf) · [Cloud setup](CLOUD_BACKUP.md) · [Hardware acceptance](HARDWARE_TEST_PLAN.md)

## Executive summary

SensorLab is a browser-based, local-first laboratory data-acquisition application. It connects to Bluetooth Low Energy sensors, displays their readings, records experiments continuously into browser storage, reports data-quality problems, and exports the stored results. A reference ESP32-C3 firmware supplies a versioned telemetry protocol with device identity, sequence numbers, device timestamps and channel validity.

The application has two delivery modes:

1. **Strict offline edition:** the complete runtime is local. The built application can run from a local file or static host without contacting remote services.
2. **Optional cloud edition:** the same acquisition and local storage remain independent of internet access. Google sign-in associates new recordings with an account; completed sessions and the Google profile can be backed up to Cloud Firestore when internet and the authenticated owner account are available.

The central engineering principle is that a smooth chart is not proof of correct measurement. SensorLab preserves raw values, device/channel identity and quality information; distinguishes connection, stream and session health; saves before drawing; and refuses to label failed finalization as success. Missing data is reported, not interpolated into apparently complete experiments.

For lab users, the main workflow is **connect or Demo -> Record -> observe status and annotate -> Stop -> review History -> export and verify**. Profile connects account identity, cloud state and recent local history. For maintainers, the project is a modular JavaScript application plus portable C protocol code and an Arduino-ESP32 sketch.

**Readiness assessment:** automated application tests and simulated browser workflows are strong evidence for the software paths they exercise. They do not establish real BLE capacity, analog accuracy, synchronized timing, physical power-loss durability or production Firebase security. Those require the explicit acceptance work described later.

## Contents

1. Project purpose and scope
2. Users and laboratory use cases
3. End-to-end architecture
4. Reference hardware and firmware
5. Bluetooth and telemetry protocols
6. Acquisition, identity, timing and quality
7. Recording lifecycle and recovery
8. Calibration and interpretation
9. Local storage and data ownership
10. User interface and Profile hub
11. Optional Google login and Firebase backup
12. Export, import and downstream analysis
13. Laboratory operating procedure
14. Example experiment plans
15. Installation, deployment and platform support
16. Testing and evidence
17. Limits, risks and outstanding work
18. Troubleshooting
19. Developer and maintenance guide
20. Source-code map
21. Handover and acceptance
22. Glossary and supporting documentation

## 1. Project purpose and scope

### 1.1 The problem SensorLab addresses

Small laboratory experiments often collect readings through a serial monitor, an ad-hoc Bluetooth terminal, screenshots, or a custom program written for one sensor. These approaches make it difficult to reproduce experiments, separate devices with similar names, retain units and calibration, identify dropped packets, or recover a recording after an interruption.

SensorLab provides a common acquisition and recording workflow. A lab member can connect supported BLE sensors, inspect live values, record named trials, annotate events, compare channels, review the recorded session and pass standard files to an analysis tool. The application also exposes when data quality is insufficient for a conclusion.

It reduces the need for a separate dashboard for every device. The versioned SLTP protocol gives SensorLab-specific devices a stronger data contract, while legacy and generic GATT profiles support devices that cannot provide that contract.

### 1.2 What it includes

- Browser BLE connection, discovery, subscriptions and configured GATT reads.
- Multiple independent device/channel streams.
- Reference ADC/divider firmware for an ESP32-C3 board.
- Strict packet and profile validation.
- Device-clock and sequence accounting for SLTP streams.
- Live plots and numerical alternatives.
- Named recordings with device selection, metadata and event annotations.
- Continuous local persistence, storage error reporting and interruption recovery.
- CSV, JSON and ZIP export, plus bounded and validated JSON import.
- Optional Google authentication, profile backup and owner-scoped recording backup.
- A Profile hub, History, installation guidance, event logs and responsive themes.
- Unit, simulated integration, firmware host and browser tests.

### 1.3 What it does not include

SensorLab is not a general-purpose laboratory information management system. It has no experiment approval workflow, institutional roster, team sharing, administrator dashboard, inventory management or cloud restore interface. It does not automatically derive arbitrary scientific models from sensor readings.

It is also not a safety controller, medical instrument, hard-real-time control system or certified metrology product. The UI can reveal problems, but it cannot establish the correctness of an unknown analog circuit or replace a calibrated reference instrument.

Current transport integration is BLE, not USB serial, Wi-Fi telemetry or a desktop-native device driver. Installing the PWA does not create a native background-acquisition service or add Web Bluetooth to browsers that lack it.

## 2. Users and laboratory use cases

### 2.1 Intended users

| User | Primary needs | Relevant features |
|---|---|---|
| Student or experiment operator | Connect a sensor, record a trial and submit usable data | Guided recording, annotations, History and exports |
| Researcher | Compare repeated trials, examine timing and assess data quality | Stable identities, quality counters, raw values, metadata and JSON |
| Teaching assistant | Demonstrate acquisition without hardware and diagnose lab failures | Demo, simulated faults, device states and event Log |
| Firmware/sensor developer | Integrate a board or an existing GATT device | SLTP, INFO/CONTROL, generic profiles and GATT browsing |
| Lab maintainer | Preserve data, provision machines and support users | Offline bundles, installation instructions, Profile, backup and tests |

### 2.2 Use cases the current design can support

**Resistive sensor characterization.** The reference divider firmware can record raw ADC aggregates and nominal resistance. After appropriate circuit validation, this supports comparing known resistors, studying a resistive sensor response or observing repeatability. It does not automatically identify the sensor type or calibrate resistance into force, displacement or strain.

**Repeated experimental trials.** Named sessions, groups, notes and annotations provide a consistent record of conditions and interventions. Exported raw and calibrated values let the analysis be repeated outside the application.

**Simultaneous sensor observation.** Multiple BLE devices can be observed without merging their channels. Different units use different chart axes. Physical limits on simultaneous devices and rates still need qualification on the lab's adapters.

**Existing BLE instrument integration.** Standard GATT presets and declarative profiles can connect compatible battery, heart-rate, temperature or vendor-specific data characteristics. This is acquisition support, not certification of those instruments.

**Offline benches and field-style work.** A provisioned offline edition can record without internet. A provisioned cloud edition can continue locally during an outage and back up later while the app is open.

**Teaching acquisition quality.** Demo signals and injected faults illustrate the difference between sampling, delivery, packet loss, duplicated notifications and visualization. Demo outputs are explicitly simulated.

**Prototype reliability testing.** Sequence gaps, parser errors, reconnect counters and lifecycle events can help investigate a device or adapter. They do not, by themselves, pinpoint every loss to firmware, radio, operating system or browser.

### 2.3 Uses that need additional work

High-precision synchronized experiments need a measured common-stimulus timing protocol. High-rate or long-duration experiments need measured BLE and memory limits. Collaborative cloud experiments need new authorization, sharing and retention designs. Closed-loop actuation needs a separate safety and real-time architecture.

These are possible directions, not implemented or validated promises.

## 3. End-to-end architecture

### 3.1 Data flow

```text
Physical sensor and analog circuit
           |
ESP32 acquisition, validity checks and SLTP serialization
           |
BLE GATT -> Web Bluetooth transport
           |
Protocol adapter -> decoded packet or sample
           |
AcquisitionService
  identity -> sequence/time accounting -> engineering conversion
  -> calibration -> quality flags -> per-channel reading
           |
           +--> Recorder -> IndexedDB session/chunk transaction
           |
           +--> isolated visualization and freshness observers
                          |
                    chart / values / status

Persisted IndexedDB snapshot
           +--> History -> CSV / JSON / ZIP / recovery
           +--> optional CloudSync -> owner-only Firestore backup
```

The important ordering is **recording hand-off before visualization**. A throwing chart sink cannot prevent the acquisition service from handing the reading to the recorder. Network backup reads persisted sessions later; it is not inserted into the sample acquisition path.

### 3.2 Layers and responsibilities

| Layer | Responsibility | Deliberately not responsible for |
|---|---|---|
| Transport | Bytes, host receipt time and connection events | Units, scientific interpretation or storage |
| Protocol | Payload validation, framing and decoded values | UI or experiment state |
| Acquisition | Identity, quality, timing, conversion and recording selection | Drawing every sample |
| Session control | Confirmation, startup verification, health and finalization | Pretending a connected device is healthy |
| Storage | Durable local sessions, chunks, annotations and snapshots | Depending on a cloud connection |
| Visualization | Bounded live history, decimation and numerical presentation | Being the authoritative recording |
| Export/import | Versioned, validated interchange | Exporting only what is visible on the chart |
| Cloud | Authentication and backup of persisted, owned data | Live acquisition or cloud-to-local restore |
| UI | Operator actions and explicit status | Silently repairing bad data |

### 3.3 Technology choices

The frontend uses JavaScript ES modules and browser APIs rather than a React/Vue application framework. Chart.js is vendored locally. esbuild produces a self-contained classic-script edition because importing ES modules directly from `file://` is problematic in Chrome.

IndexedDB stores experiment data. `localStorage` is used for lightweight preferences and saved generic device profiles. Firebase Auth and Firestore Lite are bundled only in an explicitly configured cloud build. There is no custom server-side application in the repository.

The reference firmware is Arduino C++ around portable C99 serialization and measurement helpers. Tests use Node's test runner, `fake-indexeddb`, simulated transports, mocked Web Bluetooth APIs, host C compilation and real Chrome automation through Puppeteer.

## 4. Reference hardware and firmware

### 4.1 Current target and signal path

The reference sketch targets the XIAO ESP32-C3 configuration documented in [firmware/README.md](../firmware/README.md). The sensing node is D2/A2/GPIO4, configured as ADC1 channel 4.

The documented divider is:

```text
3V3 rail -> reference resistor -> ADC sensing node -> unknown resistance -> GND
                                D2 / A2 / GPIO4
```

The firmware's nominal reference resistor is **10,800 ohms** and nominal supply is **3.3 V**. These constants must be checked against the physical board and circuit. Use low-voltage, appropriately supervised lab equipment; do not connect hazardous voltages or assume the board provides input protection.

**Maintainer detail:** ADC channel 4 is explicitly used in ADC configuration and read calls. Changing the `SENSOR_PIN` macro alone is not a complete pin migration. Review both ADC calls and the actual board pin map.

### 4.2 One scheduled sample

At each scheduled slot, the firmware acquires **16 raw 12-bit ADC conversions**. It calibrates each exact raw conversion to millivolts using ESP-IDF ADC calibration, rather than performing a second unrelated voltage batch.

It computes two published channels:

| Channel | Transmitted raw value | INFO scale | Displayed engineering quantity |
|---|---|---|---|
| `adc_sum16` | Sum of the 16 raw ADC counts | `0.0625` | Mean ADC count |
| `resistance` | Nominal resistance rounded to centi-ohms | `0.01` | Ohms |

The output sample rate is not multiplied by 16. The default period is **100,000 microseconds**, or **10 output packets/s**. Two channels produce approximately 20 channel readings/s when all packets are received. The 16 conversions are internal to each scheduled sample.

### 4.3 Resistance calculation and validity

The measurement helper computes:

```text
mean_mV = sum_of_calibrated_mV / sample_count
Vout    = mean_mV / 1000
Runknown = Rreference * Vout / (Vsupply - Vout)
```

The C3 uses the 12 dB ADC enum corresponding to the Arduino `ADC_11db` setting. The firmware applies a **provisional 2,450 mV maximum valid voltage**, leaving a 50 mV guard below the documented 2,500 mV calibrated limit. This is a design guard, not a measured accuracy specification.

With the nominal 10.8 kohm reference and 3.3 V rail, that guard corresponds to roughly **31.13 kohm**. Changing the reference, supply or validity limit changes the derived range and requires physical characterization.

When voltage is beyond the valid resistance range but acquisition itself succeeded, the raw ADC aggregate remains available and the resistance validity bit is clear. If acquisition/calibration fails or impossible values are detected, `SENSOR_FAULT` is set and raw validity can also be clear. Retained raw fields are not automatically valid measurements.

**Invalid resistance does not mean open circuit.** SLTP v1 does not carry a per-channel open-circuit/out-of-range reason. The app must not turn an invalid bit into a diagnosis.

### 4.4 Sampling and timing

The loop uses deadline scheduling, not `delay()`. If the loop misses sample slots, it advances the sequence for the missed slots and sets `DEVICE_OVERRUN` on the next relevant sample.

Sampling and sequence counting continue when a client is disconnected or notifications are stopped. On reconnect, missed sequences can therefore expose the interval without received notifications. The device timestamp is taken after the conversions and before BLE notification work.

The BLE library's notification call does not provide universal queue-full delivery proof. A sequence gap without device-attributed overrun cannot be assigned exclusively to the radio or application.

### 4.5 BLE pairing and firmware setup

The reference sketch advertises `SLab-XXXX`, derives a stable serial from the eFuse MAC, creates a fresh boot nonce and prints a six-digit pairing passkey over USB serial at **115200 baud**. DATA, INFO and CONTROL access require authenticated BLE bonding.

The normal first-pairing procedure is to open the serial monitor, reset the board and enter the printed passkey in the OS/browser pairing prompt. Existing bonds can survive reboot; clearing a bond requires pairing again with the current passkey.

The sketch is documented as compiled for `esp32:esp32:esp32c3`. Neither compilation nor host serialization tests prove that pairing, long INFO reads, notifications or ADC calibration have worked on a physical board in this validation session.

## 5. Bluetooth and telemetry protocols

### 5.1 SLTP v1 GATT service

| Item | UUID ending / full identity | Purpose |
|---|---|---|
| Service | `075e0001-9ad5-4c6a-96ae-ff1cbd6c71a6` | SensorLab primary service |
| DATA | `075e0002-9ad5-4c6a-96ae-ff1cbd6c71a6` | Notifications |
| INFO | `075e0003-9ad5-4c6a-96ae-ff1cbd6c71a6` | Protocol, identity, channels, rate and status |
| CONTROL | `075e0004-9ad5-4c6a-96ae-ff1cbd6c71a6` | Streaming/rate protocol commands |

The advertised name helps operators select a board; it is not the authoritative identity. The acquisition service uses the INFO serial and rejects an identity collision or unexpected identity change.

### 5.2 DATA contract

| Offset | Size | Field |
|---|---|---|
| 0 | 1 byte | Version, exactly 1 |
| 1 | 1 byte | Channel count, 1 to 8 |
| 2 | 4 bytes | Unsigned sample sequence |
| 6 | 4 bytes | Unsigned device timestamp in microseconds |
| 10 | 1 byte | BOOT / DEVICE_OVERRUN / SENSOR_FAULT flags |
| 11 | 1 byte | Per-channel validity bit mask |
| 12 | 4 bytes per channel | Signed raw channel values |

Multi-byte values are little-endian. The exact packet size is `12 + 4*N`. Two channels fit the default 20-byte ATT payload. More channels require an adequate negotiated MTU; Web Bluetooth does not expose that negotiation as a portable application control. Truncated packets are rejected, not guessed.

The parser rejects wrong versions, lengths, masks, reserved flags and incompatible channel counts. The portable C serializer and JavaScript parser share test vectors so byte order and signedness can be compared directly.

### 5.3 INFO and CONTROL

INFO contains protocol version, firmware, serial, model, sample period, stream status, last command error, boot nonce and channel names/units/scales/offsets. INFO is bounded to 512 bytes; the reference payload is substantially larger than 20 bytes and relies on a proper GATT long read.

CONTROL defines stream start, stream stop and sample-period changes. The current UI exposes SLTP sample-rate control in Device settings. A rate write is followed by an INFO readback; a transport write acknowledgement alone is not treated as confirmation that the rate changed.

The protocol accepts periods from **1,000 to 10,000,000 microseconds**: 1,000 to 0.1 Hz. This is a command range, not demonstrated reliable sampling or BLE throughput. Record/Stop in the app defines a local recording boundary; it should not be confused with every protocol-level stream command.

### 5.4 Legacy and standard GATT formats

Strict decoders support text float, CSV, JSON, integer and floating-point binary values and standard GATT formats. Such payloads usually lack SensorLab sequence numbers, device timestamps and validity masks.

Their timing is browser receipt timing. A host-assigned arrival counter is not proof of device continuity. The quality flag `host_time_only` makes this distinction available in exports.

For the legacy SensorLab text preset, a configured open-circuit sentinel such as `1000000` is treated as invalid rather than a real measurement. This legacy convention must not be transferred to the SLTP divider firmware.

### 5.5 Generic profiles

A `sensorlab-device-profile/1` JSON profile describes services, characteristic modes, decoders, framing and channel mappings. Profiles are data, not executable JavaScript or automatic command sequences.

They support read polling, notify and indicate sources. Framing can retain incomplete UART messages between notifications and decode several complete messages from one notification. Teardown resets framing so a previous connection's partial data cannot contaminate a new connection.

Profiles are validated before save and connection. Current bounds include **256 KiB** of input, at most **32 characteristics**, **256 contiguous channels**, and individual frames capped at **4 KiB**. Explicit writes in the GATT browser require user action, hex input and confirmation; they are not automatic profile initialization.

## 6. Acquisition, identity, timing and quality

### 6.1 Connection is not measurement health

The transport captures host monotonic receipt time before processing and copies the received bytes. This protects decoding from reusable or detached browser buffers.

The connection lifecycle discovers fresh GATT objects after reconnect and uses a generation identifier to ignore callbacks from old subscriptions. Devices are connected conservatively through a serialized queue.

Default watchdogs are 10 seconds for connection and discovery, 5 seconds for subscription/first data and 2 seconds for control acknowledgement. Reconnection uses capped exponential equal-jitter delays, up to a 30-second cap, with six configured attempts before explicit operator Retry is needed.

`STREAMING` at the connection layer means a valid decoded packet has arrived on the current connection. Individual measurement channels can still be invalid; the stream/session health layer evaluates those separately.

### 6.2 Stable stream identity

SLTP devices use `ble:<serial>`; simulated devices use `sim:<serial>`. Legacy and generic GATT devices use their browser transport identity as a session-local fallback, rather than the profile name or advertised name.

The stream key combines **device ID and channel ID**. Two boards sharing a profile or display name do not automatically share a chart series or storage stream. A second SLTP board claiming an already connected serial is refused.

The firmware boot nonce and BOOT packet indicate a new acquisition epoch. Sequence reset after reboot is not silently interpreted as a large late-packet run.

### 6.3 Sequence accounting

The tracker compares unsigned 32-bit sequences modulo `2^32`. A zero forward distance is a duplicate; a small positive distance is a forward step; the opposite direction is late data.

Forward gaps increase missing counters. Duplicate notifications are counted but not stored as duplicate readings. A bounded recent window recognizes recoverable late arrivals, marks them out-of-order and can reduce a previously counted missing total. Very old arrivals are classified separately.

An important distinction is between **missing packets** and **missing channel readings**. A two-channel missing packet represents two missing channel values. The storage counters and CSV rows are channel-level, while the stream received counter is packet-level.

### 6.4 Device and host clocks

Device time is unwrapped across a rollover of approximately **71.58 minutes**. An excessively long host gap, approximately **35.8 minutes**, makes the nearest unwrap ambiguous; the tracker starts a new timebase and flags the reset rather than guessing.

SLTP relative time is derived from device time anchored to host receipt near the start of a timebase. This avoids inserting ordinary host delivery jitter into every device sampling interval. Legacy/generic relative time uses host receipt time.

This is not a precision shared clock. Independent devices have separate oscillators and initial transport delays. Drift estimates and excess receipt-latency statistics are diagnostics, not certification of synchronization or absolute latency.

### 6.5 Quality flags and freshness

The core flags describe invalid readings, gaps, out-of-order arrivals, device overrun, boot, host-only timing, simulated data, sensor fault, timebase reset, legacy sentinel and clock anomaly.

Freshness uses the expected update interval: the device period, profile interval or measured host interval, with a fallback when the rate is unknown. Default suspect/stale thresholds are three/five intervals with floors of **500/1,000 ms**. On-change streams are not automatically considered stale merely because they are silent.

The last valid value is retained with its age when a stream becomes stale. It is not presented as a newly acquired value. Invalid channels and actual link recovery are distinguishable from ordinary fresh samples.

## 7. Recording lifecycle and recovery

### 7.1 Three state models

| Model | Examples | Question it answers |
|---|---|---|
| Device connection | CONNECTING, STREAMING, BACKOFF, DEAD | Can this device deliver data? |
| Stream freshness | WAITING, FRESH, SUSPECT, STALE, INVALID, RECOVERING | Is this channel's last value fresh and valid? |
| Session lifecycle | PREFLIGHT, STARTING, RECORDING, DEGRADED, STOPPING | What stage is this experiment recording in? |

Conflating these models would make a connected-but-silent sensor look healthy or a single disconnected board appear to stop every other device.

### 7.2 Startup order

1. The operator confirms the name, group, notes, selected devices and keep-awake preference.
2. Preflight separates blocking failures from warnings.
3. Keep-awake is requested, if selected, as a best-effort feature.
4. The local session header and metadata are saved.
5. Per-session counters and time origin are reset; the selected acquisition pipeline becomes active.
6. Fresh valid data is required from the explicitly required channels.
7. The session becomes RECORDING or DEGRADED according to all included channel health.

The startup timeout floor is **8 seconds**, raised to at least five expected intervals plus two seconds for slower required streams. For unknown/general profiles, all channels are required. For `SLab-R1`, `adc_sum16` is the startup-required acquisition channel; invalid derived resistance can remain recorded as invalid. That session can still be DEGRADED rather than fully healthy.

Preflight blocks recording without a recorder, ready local storage, selected devices, valid identity/channel metadata or active data sources. Low free storage, simulation, legacy timing, missing units, uncertain rate and unavailable wake lock are explicit warnings.

### 7.3 Running and stopping

During a recording, per-stream health is reevaluated, timestamped state transitions are retained, and healthy devices continue even when another device fails. Removal is recorded and the removed device's quality history is preserved.

Annotations use the time when the operator presses Annotate, not the later time at which typing finishes. Pausing the chart does not pause recording.

Stop freezes the relevant diagnostics, flushes pending data with bounded retries, finalizes local state and releases resources. Repeated Stop requests share a finalization rather than creating duplicate sessions. COMPLETED and FINALIZE_FAILED are different outcomes.

Failed startup data is marked `startup_failed` or `startup_cancelled`, not a completed scientific recording. The retained partial data is useful for diagnosis.

### 7.4 Crash recovery

The recorder holds a Web Lock for a live session where supported and updates a heartbeat. A released lock or suitably stale heartbeat lets the app identify an open session as interrupted.

Recovery counts the chunks that actually exist, records missing/corrupt information and marks the session recovered. It is idempotent and does not recreate the readings that were only in memory when the app stopped.

The default flush interval is 250 ms, but that is not a guaranteed maximum loss window under every disk, browser or power failure. A successfully recovered session still needs its warnings reviewed.

### 7.5 Visibility and screen behavior

Browsers can throttle or disconnect acquisition when hidden or suspended. SensorLab logs hidden periods, freeze/resume, timer stalls and wall/monotonic-clock discrepancies. The lifecycle event log is bounded to 1,000 events; dropped old events are counted.

Keep-awake can be unavailable, refused or released by the system. The app reports those states and attempts reacquisition where appropriate. A PWA icon does not guarantee uninterrupted background BLE operation.

## 8. Calibration and interpretation

There are two conversion stages:

```text
engineering = raw * deviceScale + deviceOffset
displayed_value = engineering * userGain + userOffset - tare
```

The device conversion comes from SLTP INFO or a profile. The user calibration is the versioned `linear-gain-offset-tare/1` model. Raw values are not rewritten.

Device settings lets the operator select a channel and apply gain/offset, tare or reset. Tare uses a bounded recent window: at least three valid recent samples in the default one-second window. It removes a baseline; it is not proof of absolute calibration.

A two-point helper computes a linear calibration from distinct measured/reference points. The current UI exposes gain and offset entry, not an unrestricted curve-fitting laboratory wizard.

Calibration changes are logged in metadata. This supports reconstruction of what was applied during an experiment, but does not automatically prove traceability to a certified standard. Record the physical reference, fitted range, date and procedure in lab notes.

For a resistance-to-strain, force or displacement experiment, the appropriate scientific transfer model must be implemented/validated separately. Do not relabel a raw divider reading as a fully calibrated physical quantity without that work.

## 9. Local storage and data ownership

### 9.1 What is persisted

The `sensorlab-v2` IndexedDB contains:

| Store | Contents |
|---|---|
| `sessions` | Session header, devices, quality, lifecycle, storage status and cloud ownership/acknowledgement when applicable |
| `chunks` | Columnar batches keyed by session and chunk number |
| `annotations` | Timestamped notes keyed by session and annotation ID |
| `meta` | Application flags, legacy import status and remembered cloud account |

Chunks use a device dictionary and aligned columns for device index, channel, sequence, device time, host time, relative time, raw value, calibrated value and flags. This avoids repeating a complete object for every reading.

### 9.2 Continuous writes and failures

Appending a reading is a cheap in-memory operation; flush writes are asynchronous. A chunk and its updated session counters share one transaction so the saved values and saved metadata cannot represent two unrelated commits.

Writes request strict IndexedDB durability. That improves the meaning of an acknowledged commit on supported browsers, but it is not a physical power-loss qualification.

A failed chunk is retried with the same chunk number. Storage pressure is not hidden by a memory-only fallback. The recorder has a default **200,000 pending-reading limit**; overflow is counted as dropped unsaved data. This limit is not the total maximum experiment size.

### 9.3 Browser storage is not an archive

Storage is scoped to a browser profile and origin. Changing browser, profile, host, scheme or port can make the previous local history appear absent. `localhost` and `127.0.0.1` are different web origins.

The browser controls quota and eviction. Persistent storage is requested and its status is visible, but permission can be refused. Clearing site data or using another machine does not migrate experiments.

Use independently verified exports as an archive. Never delete local data only because a download hand-off toast appeared.

### 9.4 Shared machines

Local history is not isolated by Google login. Anyone with access to the same browser profile can potentially inspect those local sessions. Profile counts intentionally include all locally stored accounts.

The last signed-in account associates new offline recordings with an owner. Therefore sign out before a different operator starts work, and use separate OS/browser profiles when confidentiality matters. Cloud owner rules do not solve local workstation privacy.

## 10. User interface and Profile hub

### 10.1 Main screen

The top bar provides Add device, Demo, History, Profile, Install, Help, Log and theme controls. The device sidebar displays connection state and diagnostics. The chart area contains the observation window, pause control, annotation and Record/Stop, along with session, wake-lock and saving status.

The latest-values table is both a numerical view and an accessibility alternative to the chart. Warning banners identify simulated data, unavailable BLE/storage, interruptions and chart failures.

### 10.2 What Profile connects

Profile replaces the former separate Cloud entry. Its header label shows Signed in, Signed out, Signed in offline, Sign-in needed or Local mode. A remembered account is not presented as an authenticated user.

The panel groups:

- Account name/email and local initials, without remote profile-image loading.
- Google sign-in, account switching and sign-out.
- Cloud backup state, errors and Sync now.
- Counts of total local sessions, local-only sessions, pending backups and completed backups.
- The three most recent local recordings.
- A direct route to a recording's readings/exports and a View all history action.

The main History shortcut remains available. Per-recording labels distinguish another account's pending/completed backup rather than implying that all local data belongs to the current login.

### 10.3 History

History lists recordings and lets users inspect the stored data, quality, lifecycle events, channel summaries and annotations; export files; recover an interrupted session; import supported JSON; and delete local sessions.

Profile is an overview, not a replacement for that detailed session review. Recent-recording navigation opens the existing detail view and returns focus to a visible Profile trigger when the dialog closes.

### 10.4 Visualization

Live series have bounded buffers, with a default 20,000 points per stream. Rendering is throttled to an 8 fps target and uses min/max decimation with a default 1,200 points per series. Missing/invalid values break the line rather than being bridged.

Different units are separated onto axes; channels have colors and dash patterns. Empty/invalid-only series are described explicitly instead of leaving a misleading flat line.

The live buffer is intentionally not the complete recording. Changing the chart window, pausing drawing or decimating the view does not redefine the persisted experiment or export row count.

## 11. Optional Google login and Firebase backup

### 11.1 Setup and delivery boundary

A cloud build requires the owner's Firebase project, enabled Google authentication, an appropriate Firestore database, authorized hosting domains and published owner-only rules.

Only four public web values are needed locally: `apiKey`, `authDomain`, `projectId` and `appId`. They belong in the gitignored `firebase-config.local.json`. No service-account key, private key, password or administrator credential belongs in the browser.

Analytics, Cloud Storage buckets and messaging are not used by this implementation. Firebase SDK modules are bundled locally; Google authentication helpers still need the allowed online sign-in endpoints.

The default build retains `connect-src 'none'`. The opt-in build expands CSP only for the relevant Firebase Auth/Firestore and Google helper origins. Both modes retain local acquisition, and the service worker does not proxy cross-origin cloud traffic.

### 11.2 Login and profile

Firebase Auth uses Google popup sign-in and persistent browser authentication. Before a sync pass, the implementation forces an ID-token refresh and checks the expected account. The profile record stores UID, email, name, photo URL, verification, provider, creation-time metadata and a server-timestamped cloud sign-in update.

The profile's photo URL can be stored in Firestore, but SensorLab does not fetch that image into the UI. This preserves the local/offline visual experience.

### 11.3 Owner assignment

The remembered account is stored in local metadata. When a new session header is created, the account read and session creation happen in the same local transaction; the session receives `cloudOwnerUid` and a null acknowledgement.

If the operator records offline, this owner persists. Upload requires the same account online, not whichever account signs in later.

Sessions created before sign-in and imported sessions remain unassigned. History's Upload action requests explicit confirmation before associating an unassigned recording with the current account. Existing ownership cannot simply be reassigned to a different account. Import does not carry an exported ownership/acknowledgement into a new local import.

### 11.4 Sync algorithm

The pending queue is derived from persisted sessions with ownership but no `cloudUploadedAt`; it is not a replacement cloud database hidden inside the browser SDK.

The algorithm:

1. Wait for remembered-account writes to settle.
2. Read local sessions and select pending sessions for the account.
3. Skip network work if offline, not authenticated or recording is active.
4. Verify the expected user online and save the profile when needed.
5. Read a consistent local snapshot of a non-open session.
6. Refuse a corrupt or missing-chunk snapshot rather than silently completing an incomplete backup.
7. Upload deterministic JSON fragment documents.
8. Write the completion manifest last.
9. Mark the local acknowledgement only after Firebase acknowledges that manifest.

Recording pauses new backup requests. An already in-flight request can still finish. Internet restoration, lifecycle changes and the periodic retry timer can resume pending work while the application is open.

Requests without an acknowledgement time out after 30 seconds. The retry scheduler backs off from its ordinary 30-second interval up to five minutes. Timed-out SDK requests cannot necessarily be retracted; deterministic paths make retry overwrite the same data rather than duplicate readings.

### 11.5 Firestore layout

```text
users/{uid}
  Google profile

users/{uid}/sessions/{sessionId}
  completed manifest, row/annotation/document counts, upload time

users/{uid}/sessions/{sessionId}/parts/{partId}
  kind, sourceId, partNo, partCount, JSON payload
```

Session metadata, original columnar chunks and annotations are serialized in grouped fragments. Each payload is at most **180,000 UTF-8 bytes**, well below the Firestore document limit. For reconstruction, sort each group by part number, concatenate payload strings, parse JSON and then place chunks in their numeric chunk order.

Parts without a manifest are not a confirmed complete backup. A failed local acknowledgement after successful remote writing remains pending locally and is retried idempotently.

### 11.6 Cloud boundaries and obligations

The supplied rules authorize the UID owner and deny unrelated database paths. They do not provide institutional collaboration, quotas, rate limiting, automatic retention or administrator oversight.

The application has no cloud-library browsing, cloud restore/download or cloud delete UI. Deleting History deletes local copies only and does not retract a completed or in-flight cloud copy.

The app must remain open for uploads. There is no closed-app background-sync service. A blocked/corrupt pending snapshot can stop that sync pass and needs review; exporting and diagnosing it is preferable to hiding corruption.

Basic local login was reported working by the operator. Automated cloud tests use a fake backend or block remote requests. Live multi-account authorization, deployed rules, complete cloud reassembly, billing/retention and disaster recovery still require owner acceptance.

## 12. Export, import and downstream analysis

### 12.1 Source of exported truth

Exports come from a consistent read-only IndexedDB snapshot, not the chart or a cached visible series. They include every valid stored chunk reading and report known integrity problems.

| Format | Best use | Contents |
|---|---|---|
| CSV | Spreadsheet or numerical analysis | One row per stored channel reading |
| JSON | Complete interchange and structured review | Session, devices, quality, lifecycle, annotations and reading columns/rows |
| ZIP | Complete handoff of one experiment | `readings.csv`, `metadata.json`, `annotations.csv`, stored uncompressed |

CSV uses UTF-8 BOM and CRLF so common spreadsheet tools preserve units such as ohms and degrees Celsius. Text columns guard formula-trigger characters; legitimate negative numeric values are not altered.

### 12.2 CSV fields

The `sensorlab-csv/1` columns are:

```text
session_id, device_id, device_name, channel_id, parameter,
sequence, device_time_us, relative_time_s, host_receive_ms,
raw_value, value, unit, valid, quality_flags
```

Always analyze identity by device/channel, not a display name that may have been changed. Blank engineering values and `valid=0` represent invalidity, not a measured zero. Host-only arrival counters must not be interpreted as device sequences.

Rows follow persisted arrival order. Accepted late samples can be out of time order. For time-series analysis, group by device/channel and inspect sequence epochs and flags before deciding how to sort.

### 12.3 JSON and integrity

The `sensorlab-export/1` document preserves device conversion and user calibration, configured/measured rates, parser and connection counters, interval statistics, lifecycle events and annotations. Its integrity block warns about open/recovered sessions, missing/corrupt chunks, unsaved/dropped readings and relevant lifecycle failures.

Semantic round trips are tested, but import is deliberately bounded: **64 MiB**, **500,000 reading rows**, **256 devices** and **100,000 annotations**. A large JSON file that can be exported is not necessarily accepted by the import limit.

Imports validate structure, timestamps, references and values before an atomic storage transaction. A failed import must not leave half a session.

### 12.4 Large-file behavior

The single-download limit is **256 MiB**. Larger CSV/ZIP exports are offered as parts to save sequentially. Oversized JSON is refused with an explicit recommendation to use a splittable format.

This reflects observed browser download failures, not an assertion that every lab PC can comfortably analyze a 256 MiB file. Export construction uses bounded parts, but reading large snapshots and drawing History still consume memory.

The application can start a download, not prove that the browser wrote the final file. Check the browser's download list, file size, opening/parsing and row count.

### 12.5 An analysis discipline

For a routine trial:

1. Keep CSV and full JSON/ZIP together.
2. Confirm the session ID, device IDs, channel units and recording state.
3. Inspect `invalid`, `gap_before`, `out_of_order` and `host_time_only`.
4. Reconcile channel-row counts with packet/channel semantics.
5. Review calibration and annotation history.
6. Do not fill gaps or remove invalid intervals without documenting the analysis decision.

The independent checker can be run with:

```powershell
node tools\check-export.mjs .\trial.csv .\trial.json
```

The inputs are local analysis files, not files to commit to GitHub. Scientific plotting, statistics and model fitting remain work for the downstream analysis environment.

## 13. Laboratory operating procedure

### 13.1 Before the session

- Choose a qualified browser/device configuration, normally desktop Chrome or Edge.
- Confirm the approved firmware, wiring, actual reference resistor, supply and sensor range.
- Use the correct browser profile and exact app origin containing the intended local history.
- Provision the offline bundle or cached HTTPS app before disconnecting internet.
- Confirm adequate storage, power and a visible screen.
- In cloud mode, inspect Profile and sign in to the intended owner before creating new recordings.
- On a shared bench, sign out the previous operator; separate profiles are preferable for confidentiality.

### 13.2 Prove the workflow with Demo first

Select Demo, create simulated devices and confirm that they stream. Record a short named session, add an annotation, Stop, open it through Profile/History and complete an export.

This checks software familiarity and browser operation without risking an experiment. It is not a sensor acceptance test. Never include Demo data in a report as physical measurement; the application labels it simulated.

### 13.3 Connect a real sensor

Select Add device and the appropriate SLTP, preset or custom profile. Pick the correct advertising board and complete pairing. Confirm the INFO identity, expected units and a changing raw acquisition channel.

For the reference board, reset with the USB serial monitor open if a new passkey is needed. Do not disable bonding or adopt open permissions simply to bypass a connection problem.

If the card says Waiting for data or Degraded, resolve that condition or deliberately document it before proceeding. A successful browser chooser does not verify a complete stream.

### 13.4 Create and run the experiment

1. Apply only validated calibration; note any tare.
2. Press Record before the stimulus whose timing matters.
3. Use a meaningful session name, group and notes.
4. Verify the selected devices and units in the confirmation.
5. Review blocking items and warnings, then Start.
6. Wait for startup verification and inspect session, saving and channel freshness status.
7. Keep the app visible; add annotations when conditions change.
8. If a channel fails, healthy streams may continue. Record what happened instead of assuming a complete trial.

New devices added during recording can be included by the acquisition service; their addition is tracked. Treat that as an experiment event and verify that the intended channels actually appear in the final metadata.

### 13.5 Finish and archive

Press Stop and wait for the finalization result. Open History, review warnings, counts and annotations, and export CSV plus JSON or ZIP. Verify the browser downloads and open the files.

If cloud backup is enabled, keep the app open until Profile reports the appropriate backup state. Internet presence alone is not proof of upload. Retain independent exports even after a backup.

Do not wipe history until the archive is confirmed. Sign out at the end of shared-machine work. Record unresolved faults and the app/firmware/browser versions for the next operator.

## 14. Example experiment plans

### 14.1 Known-resistor validation

**Goal:** establish whether the reference circuit behaves plausibly within its guarded range.

Use measured reference resistors and measure the actual reference resistor and rail. Begin at the default 10 Hz. Record intervals with two or more known resistances and annotate each change. Export raw count and resistance, compare averages/noise/repeatability and identify invalid intervals.

**Outcome:** evidence for that physical board and range. It is not general accuracy certification or evidence that the same calibration transfers to every board.

### 14.2 Resistive transducer trial

**Goal:** investigate a resistive sensor's response to a controlled stimulus.

First qualify the circuit and sensor range. Record repeatable baseline/stimulus/recovery periods with annotations. If an engineering conversion beyond resistance is needed, retain raw/resistance data and document the validated transfer model separately.

**Outcome:** time-aligned local observations and traceable trial files, not an automatically calculated strain/force result.

### 14.3 Multi-device comparison

**Goal:** observe several independently identified sensors under comparable conditions.

Qualify one board first, then run three/five boards at declared rates for a measured duration. Intentionally disconnect one during a non-critical validation trial and verify that other streams remain separate and their saved data continues.

**Outcome:** an evidenced operating combination of host, adapter, number of boards and rate. Common-stimulus timing offsets must be measured before claiming synchronization.

### 14.4 Offline collection followed by backup

**Goal:** collect during an internet outage without losing account ownership.

Sign in to the correct account while online, provision the hosted app cache and start a recording offline using the same origin/profile. Stop locally, reopen offline to inspect History, then reconnect internet with the same account. Keep the app open until upload acknowledgement and independently verify the Firestore manifest/counts.

**Outcome:** confirmation of local-first and deferred-backup behavior for that deployment, subject to quota and retention policies.

### 14.5 Teaching error diagnosis

**Goal:** show why acquisition quality matters.

Use Demo faults to create missing, duplicate, invalid, reordered or malformed packets. Compare device counters, chart gaps and exported flags. Ask students to distinguish host receipt jitter from sampling intervals and packet totals from channel-row totals.

**Outcome:** a reproducible software exercise without representing synthetic signals as sensor measurements.

## 15. Installation, deployment and platform support

### 15.1 Developer prerequisites

Node.js **20 or newer**, a supported Chrome/Edge installation and dependency installation are needed to build/test the frontend. Firmware host tests need a compatible C compiler; sketch compilation requires the Arduino toolchain and appropriate ESP32 core.

On this Windows environment, use `.cmd` npm/npx entry points in PowerShell when execution policy blocks the `.ps1` shims.

```powershell
npm.cmd ci
npm.cmd run build
```

End users of a complete built offline bundle do not need npm, Firebase or internet to view/record locally. Provisioning/building the bundle and Google sign-in are separate operations that can need internet.

### 15.2 Offline launch

Open the **built** `dist\index.html` in Chrome/Edge. Do not confuse it with the repository's unbundled root entry, whose ES modules are intended for server-based development.

If file-mode BLE is blocked by policy, serve the built folder locally:

```powershell
npm.cmd run serve
```

Open `http://localhost:8080/`. Keep the exact origin consistent between sessions.

### 15.3 Cloud launch

Follow [CLOUD_BACKUP.md](CLOUD_BACKUP.md): create the project, enable Google authentication, authorize the host, create Firestore in production mode and publish [firestore.rules](../firestore.rules).

```powershell
npx.cmd firebase-tools login
npx.cmd firebase-tools deploy --only firestore:rules --project YOUR_PROJECT_ID
npm.cmd run build -- --cloud-config .\firebase-config.local.json
npm.cmd run serve
```

These are owner operations. Use public web configuration only; do not publish administrator credentials. The configured browser login requires HTTPS or secure localhost, not `file://`.

For phones or other machines, deploy the built app to an authorized HTTPS static host. The development server listens on loopback: a phone's `localhost` is not the laptop's server. A plain HTTP LAN address is not an equivalent secure deployment.

### 15.4 PWA and cache

The built app includes a manifest, icons and service worker. The worker precaches the same-origin app shell, including the local Firebase bundle in cloud mode. It ignores cross-origin requests rather than caching or proxying authenticated cloud APIs.

Install appears when the browser supports the relevant prompt. The installed app remains a web application. Its first successful provisioning and subsequent offline reload should be verified on the target machine.

After updates, an old worker or open tab can temporarily show an older UI. Update/refresh the app only when no recording is active; preserve exports and never clear storage casually to fix a missing button.

### 15.5 Browser support

Desktop Chrome/Edge and Android Chrome are the main intended configurations. Real sensor behavior still needs qualification per host and adapter.

Ordinary Safari/iOS Chrome do not expose Web Bluetooth. Bluefy on iPhone/iPad is a candidate path documented by the project, not validated SensorLab support. Firefox is not a primary acquisition target here. Unsupported BLE environments can still use appropriate local History/export/Demo paths.

### 15.6 Release packaging caveat

The packager copies the current `dist` into a ZIP and adds selected launchers, firmware and documentation. It does not recreate the build mode; choose the correct build first.

**Current handover gap:** [scripts/package.mjs](../scripts/package.mjs) copies `sensorlab_node.ino`, `sltp.c` and `sltp.h`, but omits the required `divider_measurement.h`. It also has an offline-only START-HERE message and does not yet include the new cloud/report/handover documentation list.

Consequently, do not describe a generated release ZIP as a self-contained current firmware build or a fully documented cloud release. Hand over the complete firmware directory from the repository. Updating/revalidating the packaging manifest is an explicit outstanding task, not silently fixed by this report.

## 16. Testing and evidence

### 16.1 Evidence levels

| Level | What it establishes | What it does not establish |
|---|---|---|
| Static/code review | Implemented structure and intended guards | Runtime success or hardware behavior |
| Unit / fake IndexedDB | Logic on controlled inputs | Actual disk power-loss durability |
| Mock Web Bluetooth | Driver/parser/lifecycle interaction against an API model | Real OS/radio interoperability |
| Simulated browser integration | Real Chrome UI/storage/download behavior with controlled signals | Physical measurement accuracy |
| Host firmware tests | C serialization/helper behavior and shared vectors | Successful flashing or BLE operation |
| Sketch compile evidence | Build compatibility for the recorded toolchain | A running instrument |
| Physical acceptance | Observed behavior of a declared bench configuration | Untested boards, rates or platforms |

### 16.2 Latest local software checks

The preceding implementation/UX work ran:

- **31 focused unit tests**, covering Profile summaries/ownership labels, cloud sync/configuration/error behavior and exports.
- Source lint/syntax checks: passed.
- An isolated configured-cloud browser smoke test: passed account display states, remembered-versus-active distinction, safe text rendering, history navigation/focus, 390 px layout, offline recording/sign-out, zero remote requests in that controlled test and file-mode fallback.
- Strict offline audit of an isolated default build: passed.
- **116 existing browser checks: 116 passed, 0 failed**, recorded with **Chrome 157.0.8103.79**. The run started at `2026-11-23T22:24:28.653Z` (24 November in the operator's local timezone).
- The real configured Firebase edition was rebuilt and its Profile hub inspected locally.

This is not a claim that the entire unit/firmware/CI matrix was freshly rerun for this documentation-only preparation. Browser result JSON is a local generated file; controlled test results are not a production Firebase acceptance record.

### 16.3 What the browser suite exercises

It covers local-file offline startup; simulation and reconnection; recording, annotations and exports; injected quota errors; forced browser termination and recovery; unsupported/missing BLE availability paths; a 150,000-reading History/export case; HTTP service-worker offline reload; startup and keep-awake behavior; stale streams; permission/storage/export failures; freeze/resume and visibility; keyboard/dialog/focus behavior; contrast; and narrow layout.

Successful tests remain bounded by their fixtures and environment. A forced browser-process termination differs from a real OS crash or sudden power loss. An emulated offline connection differs from every managed lab network configuration.

### 16.4 Physical and production acceptance

[HARDWARE_TEST_PLAN.md](HARDWARE_TEST_PLAN.md) defines one-board, multi-board, calibrated-equipment and platform acceptance. Record actual hardware, browser, adapter, firmware, app build, rates and agreed accuracy/timing/loss limits before testing.

For cloud acceptance, use two real test accounts to verify unauthenticated/cross-UID denial, offline/reopen/reconnect behavior, complete fragment reconstruction and row/annotation counts. Confirm billing alerts, retention and ownership independently in the project console.

The operator's report that login works is useful operational feedback, but does not replace those controlled sign-offs.

## 17. Limits, risks and outstanding work

### 17.1 Current design limits

| Item | Current value/behavior | Interpretation |
|---|---|---|
| SLTP channels | 1-8 | More than two needs adequate MTU |
| Commanded rate range | 0.1-1,000 Hz | Not a measured achievable BLE range |
| Default reference output | 10 Hz, two channels | Approximately 20 channel rows/s when received |
| Recorder flush | 250 ms | Not a universal maximum crash-loss promise |
| Pending buffer | 200,000 readings | Overflow counted as dropped unsaved |
| Live series buffer | 20,000 points | Display history, not stored-session capacity |
| Live chart target | 8 fps, 1,200 decimated points/series | Not device sample rate |
| Lifecycle event limit | 1,000 events | Old event drops counted |
| Single download | 256 MiB | Larger CSV/ZIP split; oversized JSON refused |
| JSON import | 64 MiB / 500,000 rows | Smaller than some possible exports |
| Cloud payload | 180,000 UTF-8 bytes/part | Bounded per-document payload |
| Cloud request timeout | 30 seconds | No local acknowledgement on timeout |
| Cloud retry | Ordinary 30 s interval, backs off to 5 min | Open app and owner authentication required |

Historical benchmark documents contain large simulated-throughput and million-reading measurements. Those are useful environment-specific evidence, not a guarantee for a real BLE bench, phone or every export size. This report does not promote them into operating specifications.

### 17.2 Outstanding items, ordered for handover

1. **Physical go/no-go:** flash the exact board and verify pairing, INFO reads, channel validity and notifications.
2. **Analog chain:** measure reference resistor/rail, characterize the guarded ADC range, uncertainty, repeatability and calibration.
3. **Multi-device/rate/platform limits:** qualify the required bench configurations with saved evidence.
4. **Timing:** measure intra-device and common-stimulus cross-device error; do not assume synchronized microsecond timestamps.
5. **Crash/visibility:** test actual screen behavior, sleep/lid close, repeated interruptions and approved power-loss scenarios.
6. **Cloud acceptance:** validate production rules, two-account isolation, complete backups, retention and billing.
7. **Packaging:** include the required firmware header and appropriate current documentation/build-mode labeling.
8. **Historical documentation:** reconcile older audit/traceability statements that predate sketch compilation, generic profiles, optional cloud and the Profile hub.
9. **Release/legal:** choose project licensing and release criteria; the README currently records no selected project license.

### 17.3 Security and privacy

Untrusted BLE names, session text and profiles are rendered as text; CSV text is guarded against formula injection. The default edition avoids remote dependencies and enforces a strict CSP. Optional cloud mode intentionally changes the network boundary.

Remaining risks include access by other users of the same browser/OS account, malicious BLE peripherals, incorrectly authorized cloud rules, browser compromise and unreviewed lab data being committed as files. Bonding does not turn the INFO serial into a device certificate.

Never commit local Firebase configuration, credentials, recordings or raw evidence containing personal data. Keep independent backups and obtain the lab's retention/consent decisions before collecting identifying information.

### 17.4 What cannot be inferred

No gaps does not prove analog accuracy. An attractive chart does not prove no loss. A passed mock transport test is not a successful radio test. A PWA installation is not native background BLE support. A successful local save is not a verified cloud backup. A cloud backup is not an independently tested restore capability.

## 18. Troubleshooting

| Symptom | Inspect first | Safe next action |
|---|---|---|
| No Profile or new UI | Exact URL, app build and service-worker state | Refresh/update when idle; do not clear experiment storage as a first step |
| No sensors in chooser | Advertising, power, BLE adapter and permissions | Check the board/serial and correct profile/service authorization |
| Pairing fails | Current boot passkey and old bond | Reset with serial open; pair through the approved OS/browser flow |
| Waiting for data | Subscription, INFO stream state and raw channel | Reconnect/power-cycle and inspect Log; do not label it healthy |
| Invalid resistance | ADC node voltage, guarded range and sensor circuit | Use a known in-range resistor; invalidity is not open-circuit diagnosis |
| Start disabled/fails | Preflight, selected required channels and storage | Resolve the named blocking issue; keep diagnostic partial data |
| Stale/degraded channel | Last valid age, link state and expected rate | Let unaffected streams continue if appropriate; annotate the event |
| Saving error | Storage quota/error banner and unsaved count | Preserve pending data and wait for supported retry; do not claim finalization |
| Interrupted session | Open session/heartbeat/lock and persisted count | Recover in History, then export and retain the loss warning |
| Empty or cancelled export | Browser download list and file size | Retry appropriate format/parts; check the file outside the app |
| Cloud sign-in unavailable | Configured build, secure context and internet | Use the built localhost/authorized HTTPS edition |
| Google login rejected | Enabled provider and authorized exact domain | Correct Firebase project settings; inspect the reported error |
| Cloud backup pending | Owner account, active recording, internet, rules and errors | Stop/recover locally, authenticate owner and retry; never reassign to another user silently |
| History seems missing | Browser profile/origin/port and import provenance | Return to the original origin/profile; examine exports before deletion |
| Phone cannot reach localhost | Hosting mode | Provision the authorized HTTPS app; loopback is not a LAN server |

Always retain the app build, session ID, relevant device ID, browser/OS, firmware, error text, Log and exported metadata. Redact private data before sharing diagnostics or opening a public issue.

## 19. Developer and maintenance guide

### 19.1 Working safely

Read the source and current docs before changing behavior. Keep acquisition, rendering and network work separate. Preserve unrelated worktree changes and do not commit local data/configuration.

When a sensor integration changes, test the decoder, identity, validity, framing, lifecycle, persisted rows and export semantics together. When a cloud/UI change is made, verify offline/default behavior and owner association as well as the new screen.

Changing protocol units, fields, masks or byte layout requires coordinated firmware/client changes and shared vectors. A firmware model/pin/range migration requires physical requalification.

### 19.2 Main commands

| Command | Purpose / caution |
|---|---|
| `npm.cmd ci` | Reproduce pinned dependencies |
| `npm.cmd run lint` | Syntax and forbidden-pattern checks |
| `npm.cmd test` | Current unit suite |
| `npm.cmd run test:firmware` | Host C serializer/measurement tests |
| `npm.cmd run firmware:compile` | Documented sketch compilation |
| `npm.cmd run build` | Replace `dist` with strict offline edition |
| `npm.cmd run build -- --cloud-config .\firebase-config.local.json` | Replace `dist` with the configured cloud edition |
| `npm.cmd run audit:offline` | Default edition only, not intentionally network-enabled cloud |
| `npm.cmd run test:e2e` | Built default edition browser suite |
| `node test\e2e\cloud-smoke.mjs` | Isolated fake-config cloud/Profile UI smoke |
| `npm.cmd run verify:trace` | Historical evidence/file/test-title traceability checks |
| `npm.cmd run package` | Current ZIP packager; outstanding manifest caveats apply |
| `npm.cmd run check` | Combined pipeline; rebuilds default `dist`, so plan around a running configured app |

### 19.3 Isolate validation from a running app

The build supports a fixed test output under `build\test-app`. Cloud smoke uses it and removes that test edition; it does not replace the user's configured `dist`.

For isolated default validation:

```powershell
node scripts\build.mjs --test-output
$env:SL_E2E_DIST = Join-Path (Get-Location) 'build\test-app'
node test\e2e\run-e2e.mjs
Remove-Item Env:\SL_E2E_DIST
```

The static auditor exports `audit(directory)` for validating that isolated directory. Do not run test builders against a live configured edition while another operator might reload or authenticate.

### 19.4 CI and evidence maintenance

The GitHub workflow defines dependency installation, lint, unit and host firmware tests, default build, offline audit and browser E2E. Its presence is not proof that a particular unpushed worktree has passed GitHub Actions.

The traceability verifier references dated evidence logs. Rerun/update the appropriate evidence when making release claims; do not simply change a status to PASS without matching observations.

This documentation request explicitly stops before commit/push. The local no-mistakes CLI reported that the repository gate is not initialized; no publishing pipeline, PR or CI approval was performed for this report.

### 19.5 Git and document policy

The intended public deliverables are this report and the one-page handover in Markdown/PDF. Their explicit `.gitignore` exceptions keep them eligible for tracking.

Existing exclusions remain for build artifacts, dependencies, releases, local Firebase configuration, credentials, raw CSV/trial data, editor settings and selected archived evidence. The four documents are not a reason to remove those safeguards.

Before a future publication, review the working tree and decide whether to publish the related cloud/Profile code alongside the documentation so GitHub does not describe features absent from its code. Commit only the agreed scope.

## 20. Source-code map

This map explains the responsibilities of the application modules without reproducing every line. It is the starting point for a deeper code-level handover.

### 20.1 Entry, transport and protocol

| Module | Main responsibility |
|---|---|
| [src/main.js](../src/main.js) | Boot, storage/BLE availability, views, recording actions, annotations, settings, banners, lifecycle and service-worker registration |
| [src/util/clock.js](../src/util/clock.js) | Real/manual clocks, timeout helpers and seeded randomness for testable timing |
| [src/transport/web-bluetooth.js](../src/transport/web-bluetooth.js) | Browser device/characteristic wrappers, byte copies, reads/writes/subscriptions and disconnect cleanup |
| [src/transport/simulated.js](../src/transport/simulated.js) | Deterministic devices/signals, real protocol bytes and controlled transport faults |
| [src/protocol/sltp.js](../src/protocol/sltp.js) | SLTP constants, UUIDs, packet/INFO/CONTROL encode/decode and validation |
| [src/protocol/legacy.js](../src/protocol/legacy.js) | Strict legacy/binary/standard GATT decoders |
| [src/protocol/device-profile.js](../src/protocol/device-profile.js) | Generic profile schema, validation, portability and chooser configuration |
| [src/protocol/adapters.js](../src/protocol/adapters.js) | SLTP/legacy/generic discovery and decoding, bounded UART framing and control readback |

### 20.2 Acquisition and session management

| Module | Main responsibility |
|---|---|
| [acquisition-service.js](../src/acquisition/acquisition-service.js) | Device entries, identity, decoding, per-channel conversion, calibration, selected recording hand-off and isolated observers |
| [device-connection.js](../src/acquisition/device-connection.js) | Connection queue/state, watchdogs, fresh discovery, GATT polling and bounded reconnect |
| [stream-tracker.js](../src/acquisition/stream-tracker.js) | Sequences, gaps, duplicates, late data, epochs, timestamp unwrap and diagnostics |
| [stream-health.js](../src/acquisition/stream-health.js) | Rate-relative per-channel freshness and last-valid state |
| [quality.js](../src/acquisition/quality.js) | Quality bit flags, names and running statistics |
| [calibration.js](../src/acquisition/calibration.js) | Linear conversion, calibration validation, tare and two-point helper |
| [preflight.js](../src/acquisition/preflight.js) | Recording preconditions, warnings and required startup channel plan |
| [session-state.js](../src/acquisition/session-state.js) | Legal lifecycle transitions and aggregate health derivation |
| [session-controller.js](../src/acquisition/session-controller.js) | Startup verification, lifecycle trail, health ticks, cancellation and finalization |
| [keep-awake.js](../src/platform/keep-awake.js) | Best-effort Screen Wake Lock, honest status, release/reacquisition and adapter behavior |

### 20.3 Persistence, exports and cloud

| Module | Main responsibility |
|---|---|
| [idb-repository.js](../src/storage/idb-repository.js) | Transactions, schemas, snapshots, recovery, atomic import and cloud ownership/acknowledgement |
| [recorder.js](../src/storage/recorder.js) | Header-first recording, bounded column batches, flush/retry/counters, annotations, locks and interruption detection |
| [legacy-import.js](../src/storage/legacy-import.js) | One-time read-only migration from old browser data, heuristic collision splitting and provenance |
| [export.js](../src/export/export.js) | CSV/JSON/metadata/annotation builders, integrity warnings, filenames, bounded exports and validated import |
| [zip.js](../src/export/zip.js) | Dependency-free ZIP writing and bounded parts/ZIP32 safeguards |
| [cloud/firebase.js](../src/cloud/firebase.js) | Firebase app/Auth initialization, popup login, expected-user verification, profile/part/manifest writes |
| [cloud/sync.js](../src/cloud/sync.js) | Local owner-aware pending scan, account epochs, request timeout, document splitting and acknowledgement ordering |
| [cloud/main.js](../src/cloud/main.js) | Optional cloud boot, UI integration, retries and online/auth/lifecycle scheduling |
| [firestore.rules](../firestore.rules) / [firebase.json](../firebase.json) | Owner-scoped database permissions and rules deployment configuration |

### 20.4 Presentation and UI

| Module | Main responsibility |
|---|---|
| [viz/series.js](../src/viz/series.js) | Ring buffer, min/max gap-preserving decimation and unit-axis grouping |
| [viz/charts.js](../src/viz/charts.js) | Chart.js rendering, annotation markers, bounded live refresh, History plot and text-related summaries |
| [ui/dom.js](../src/ui/dom.js) | Safe element/text helpers, dialogs, confirmations, notifications, logs, formatting, downloads and preferences |
| [ui/connect-view.js](../src/ui/connect-view.js) | Chooser/presets/custom profiles, GATT browsing, explicit writes and Demo configuration |
| [ui/devices-view.js](../src/ui/devices-view.js) | Device cards, states, latest metrics and device actions |
| [ui/history-view.js](../src/ui/history-view.js) | Lists/details, recover/delete/import/export, bounded-download offers and explicit cloud selection |
| [ui/profile-view.js](../src/ui/profile-view.js) | Account/sync overview, local summary, recent history, ownership labels and connected navigation |
| [ui/install-view.js](../src/ui/install-view.js) | Browser install prompt and standalone-state guidance |
| [index.html](../index.html) / [styles.css](../css/styles.css) | Semantic page/dialog layout, responsive themes, warnings, focus and accessible alternatives |

### 20.5 Firmware and build/support files

| File/group | Main responsibility |
|---|---|
| [sensorlab_node.ino](../firmware/sensorlab_node/sensorlab_node.ino) | Board ADC, calibrated conversions, scheduler, BLE security, GATT callbacks and notification production |
| [divider_measurement.h](../firmware/sensorlab_node/divider_measurement.h) | Pure host-testable divider validity and centi-ohm calculation |
| [sltp.h](../firmware/sensorlab_node/sltp.h) / [sltp.c](../firmware/sensorlab_node/sltp.c) | Portable packet, INFO, CONTROL and scheduling serialization logic |
| [build.mjs](../scripts/build.mjs) / [cloud-config.mjs](../scripts/cloud-config.mjs) | Default/optional/test builds, content build ID, scoped configuration/CSP and precache generation |
| [vendor.mjs](../scripts/vendor.mjs) / [VENDOR.md](../vendor/VENDOR.md) | Pinned local Chart.js copy and integrity/license metadata |
| [sw.template.js](../sw.template.js) / [manifest.webmanifest](../manifest.webmanifest) | Same-origin offline shell and install metadata |
| [serve.mjs](../tools/serve.mjs) / [serve.ps1](../tools/serve.ps1) | Loopback-only development/offline launchers |
| [package.mjs](../scripts/package.mjs) | ZIP/release checksum generation, with the documented current manifest gap |
| [lint.mjs](../scripts/lint.mjs), [audit-offline.mjs](../scripts/audit-offline.mjs), [verify-all.mjs](../scripts/verify-all.mjs) | Source/offline checks and evidence orchestration |
| [verify-traceability.mjs](../scripts/verify-traceability.mjs) / [audit-repo.mjs](../scripts/audit-repo.mjs) | Evidence mapping and repository auditing |
| [check-export.mjs](../tools/check-export.mjs) | Independent exported identity/sequence/flag/quality checks |
| [test/](../test/) / [CI workflow](../.github/workflows/ci.yml) | Fixtures, unit/firmware/browser/integration/benchmark tests and automated default-build checks |

## 21. Handover and acceptance

### 21.1 Deliver the right materials

Provide the repository at an agreed commit, this report, the one-page sheet, the complete firmware source folder, the selected built application edition, required public configuration through the approved channel, and sanitized validation evidence.

Do not include private keys, passwords, browser token stores or raw student recordings in the repository bundle. Project-owner access to Firebase must be granted through the platform's authorization process, not by passing a service-account secret in chat.

If a release ZIP is used, first address the packaging limitations. Record which build mode was delivered and its build ID. Old ZIPs can have the same broad development version name without containing the newest Profile/cloud implementation.

### 21.2 Transfer responsibilities

| Responsibility | Receiving owner must confirm |
|---|---|
| Software maintenance | Can install/build, run focused/default tests and identify the delivered commit |
| Hardware | Has complete firmware sources, pin/circuit map, known references and a recorded qualification plan |
| Lab operation | Can demonstrate connect/Demo, Record/Stop, annotation, History and verified export |
| Data stewardship | Understands browser-origin storage, account association, local/cloud deletion difference and retention |
| Firebase | Owns authorized domains, Google provider, production rules, access, billing and recovery acceptance |
| Release/legal | Has reviewed known limitations, package completeness and project license decision |

### 21.3 Minimum receiving demonstration

The receiver should independently create a Demo recording, annotate, Stop, inspect History and open CSV/JSON/ZIP. They should find Profile and explain its logged-in/remembered/offline states.

Then demonstrate the approved physical setup, or explicitly mark physical acceptance BLOCKED. If cloud is part of the handover, demonstrate offline owner association and later complete backup under the same account; test denial to a different account.

Acceptance should record **PASS**, **FAIL** or **BLOCKED** with observations and evidence, not inferred success. The one-page sheet is the operational starting point; this report and the hardware/cloud guides supply the detail.

## 22. Glossary and supporting documentation

| Term | Meaning in this project |
|---|---|
| BLE / GATT | Bluetooth Low Energy and its services/characteristics data model |
| SLTP | SensorLab Telemetry Protocol, currently v1 |
| Packet/sample slot | One scheduled device observation, possibly carrying multiple channel values |
| Reading | One channel value stored/exported from a received sample |
| Raw | The transmitted decoded field before engineering/user calibration |
| Engineering value | Raw converted by device/profile scale and offset |
| Tare | Recent-baseline subtraction in the host calibration model |
| Epoch | A device boot/tracking generation |
| Timebase | A device-to-host timing mapping, reset when necessary |
| Freshness | Age/validity of the last good channel observation |
| Chunk | An atomic columnar journal batch in IndexedDB |
| Snapshot | A consistent stored view used for History/export/backup |
| Local-first | Local acquisition and saving do not depend on cloud success |
| Cloud manifest | The final document indicating that a backup's parts were acknowledged |
| PWA | Installable web app shell, not a native BLE background service |

Use these references alongside the code:

- [Protocol contract](PROTOCOL.md) and [generic device profiles](DEVICE_PROFILES.md).
- [Export schema](EXPORT_SCHEMA.md), [cloud setup/Profile behavior](CLOUD_BACKUP.md) and [security model](SECURITY.md).
- [Firmware guide](../firmware/README.md) and [hardware acceptance plan](HARDWARE_TEST_PLAN.md).
- [Platform compatibility](PLATFORM_COMPATIBILITY.md) and [offline deployment](OFFLINE_DEPLOYMENT.md).
- [Architecture decision record](architecture-decision-record.md), [historical acquisition walk-through](ACQUISITION_PATH.md), [operating limits](OPERATING_LIMITS.md) and [traceability matrix](TRACEABILITY.md).

Some older audit documents describe an earlier offline-only implementation or pre-compile firmware state. Treat those as dated evidence, not overriding the current source and the qualified statements in this report.

**Final handover position:** the project provides a substantial, testable acquisition and experiment-recording platform with optional deferred backup. It is ready for structured software handover and controlled lab qualification, not for unqualified claims of measurement accuracy, universal BLE compatibility or complete cloud disaster recovery.
