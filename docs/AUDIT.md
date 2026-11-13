# Phase 0 — Repository and Requirements Audit

Audit date: 2026-10-12. Auditor: Claude (engineering owner per the handoff).
Evidence class for everything in this file: **STATIC REVIEW**, except where a line is
explicitly marked **ENV PROBE** (a scripted check run on this machine).

## 1. Repository baseline (facts)

| Item | Finding |
|---|---|
| Remote | `https://github.com/hiomgupta/sensorlab-iitgn.git` |
| Branch / commit | `main` @ `25dbe42` ("Add files via upload"), the only commit |
| Working tree | Clean, plus one untracked file, `sensorlab report.pdf` (the course report). It was left untouched and is not committed. |
| Stack | Plain HTML/CSS/JavaScript with no build step, no package manager, no lockfile |
| Files | `index.html` (365 lines), `css/styles.css` (840), `js/app.js` (873), `js/ble-manager.js` (314), `js/data-store.js` (258), `js/chart-manager.js` (178), `js/cloud-store.js` (181), `js/auth-manager.js` (88), `js/firebase-config.js` (36): 3,133 lines in total. This matches the handoff's description. |
| Tests / CI / lint | None |
| README / LICENSE / .gitignore | None |
| Firmware | **Not in the repository.** The course report (`sensorlab report.pdf`, §10.2–10.3) shows only snippets: ESP32-C3, service `6E400001-…`, characteristic `beb5483e-…`, READ+NOTIFY, about 10 Hz, ASCII float resistance, a 16-sample ADC average, a 10.8 kΩ divider, and `return 1e6` for open circuit / `0.0` for short circuit. |

The older notes about React, TypeScript, Vite, React Query and Express do **not** describe this
repository. The real codebase is the plain-JS application.

## 2. Network / cloud inventory (all runtime dependencies on remote hosts)

| Location | Remote reference | Consequence offline |
|---|---|---|
| `index.html:7-9` | Google Fonts (`fonts.googleapis.com`, `fonts.gstatic.com`) | Fonts fail. Cosmetic only. |
| `index.html:11` | Chart.js from `cdn.jsdelivr.net` | `Chart` is undefined, so `chart-manager.js:33` throws at load, `app.js` then fails, and **the whole app is dead offline** |
| `index.html:13-15` | Firebase compat SDKs from `www.gstatic.com` | Auth and cloud unavailable. `auth-manager.js` degrades to guest mode. |
| `js/firebase-config.js` | Firebase project `sensorlab-iitgn` (client API key, authDomain, appId) | Not an authorization secret on its own, but the setup comment tells users to "Start in test mode". **The deployed Firestore rules could not be checked from here** (no console access, and probing a live service was out of scope). This is a manual step for the owner. |
| `js/auth-manager.js` | Google sign-in popup | Network required |
| `js/cloud-store.js` | Firestore reads/writes, `enablePersistence` | Network required. Uploads happen only after Stop. |
| `js/app.js:159-226, 601-604, 665-689, 707-720` | Sign-in UI, cloud banner, `confirm()` migration, cloud save, cloud history merge | Network/cloud paths are part of the core flow |

## 3. BLE inventory

* `ble-manager.js` uses Web Bluetooth (`navigator.bluetooth.requestDevice`, filter by service UUID).
* It has five presets (`app.js:17-23`). The "SensorLab ESP32" preset reads text floats in Ω from `beb5483e-…`.
* It supports nine payload formats (`_parseData`): text-float, float32/int16/uint16 in LE/BE, text-csv and text-json.
* It has no sequence number and no device timestamp. Every value is stamped with `Date.now()` (wall clock) when it is received.
* "Scan Any" uses `acceptAllDevices` plus a service browser.

## 4. Defects found by static review of the baseline

Severity labels: **C** means the defect corrupts or loses data, **H** high, **M** medium.

| # | Sev | Defect | Where |
|---|---|---|---|
| D1 | C | Readings stay in RAM until Stop (or until 100k readings). A tab crash or kill loses the **whole session**. The report says `beforeunload` "auto-flushes", but the code only shows a prompt. | `data-store.js:45-53, 68-77` |
| D2 | C | Sessions, readings, annotations, deletion and history are keyed by **session name**. Two sessions with the same name are merged when viewed, and deleting one deletes both. | `data-store.js:84, 194-244`; `app.js:765,789` |
| D3 | C | Multi-value packets (text-csv/json) emit several channels, but the chart and exports key only by `deviceId`, and `channelIndex` is never exported. **Channels are mixed into one series** and cannot be told apart in the CSV. | `ble-manager.js:230`; `app.js:471`; `data-store.js:133` |
| D4 | C | Toolbar export reads only the in-memory array. After `_flushHalf` the export is **silently incomplete**. `stopSession().totalReadings` is under-reported for the same reason. | `data-store.js:92-105, 128-149` |
| D5 | C | Charting runs in the acquisition path. `chart.addDataPoint` runs before `dataStore.addReading` in the same synchronous emit, so if the chart throws, the reading is never stored. The chart also redraws once per sample. | `app.js:468-475`; `chart-manager.js:124-128` |
| D6 | H | **XSS**: device-provided BLE names, units and UUIDs are interpolated into `innerHTML` (the device card, live table rows and service browser). | `app.js:510-524, 565, 375-383` |
| D7 | H | Reconnect: `visibilitychange` and `gattserverdisconnected` can both start `_onDisconnected`, which gives two concurrent loops sharing one attempt counter. The backoff is linear (`2s·a`), not the documented exponential. There is no jitter, and `gattserverdisconnected` listeners are never removed. | `ble-manager.js:36-51, 240-257` |
| D8 | H | After a reconnect, `_attachHandler` "reactivates" the handler that was attached to the **old** characteristic object. If the stack returns a new object, no listener is attached, so the stream can stall with no error. | `ble-manager.js:145-160` |
| D9 | H | A device is reported "connected" as soon as `startNotifications` resolves, before any valid sample has arrived. | `ble-manager.js:171-175` |
| D10 | H | Parse failures return `[]` silently and are not counted. Empty notifications are only `console.warn`ed. | `ble-manager.js:205-212, 220-223` |
| D11 | H | Open-circuit sentinel `1e6` (from the firmware) is treated as a real 1 MΩ reading. It distorts autoscaling and exports. | report §10.3 |
| D12 | H | CSV: embedded quotes are not escaped, there is no formula-injection guard, and the time column is epoch ms with a header ("timestamp") that does not match the report's "Time (s)". Export filenames are not sanitized. | `data-store.js:128-138, 246-253`; `app.js:858` |
| D13 | M | Annotation time is taken **after** the blocking `prompt()` closes. Annotations made while not recording are stored with session `''` (orphans). | `app.js:582-590`; `data-store.js:116-125` |
| D14 | M | The calibration offset replaces the value. The raw value is not kept (`raw` is a text decode even for binary formats), and the offset is not stored in session metadata. | `ble-manager.js:226-233` |
| D15 | M | The single y-axis is relabelled with the unit of whichever device connected last. Mixed units share one axis. | `app.js:457`; `chart-manager.js:131-136` |
| D16 | M | Without Web Bluetooth the app replaces `<body>`, so history and export of existing local data become unreachable. | `app.js:7-10` |
| D17 | M | Text parsers decode `dv.buffer` and ignore the DataView's `byteOffset`/`byteLength`. | `ble-manager.js:192, 197, 209, 227` |
| D18 | M | Storage errors only reach `console.error`. `navigator.storage.persist()` is never requested, and usage is never shown. | `data-store.js` |
| D19 | M | Wipe-all (`clearAllData`) exists, but nothing in the UI calls it. | `data-store.js:175` |

Report claims that have **no evidence in the repository**, and so are treated as unverified:
"10 Hz stable, <50 ms jitter", "~4× noise reduction", "multi-device up to stack limit",
"52+ edge cases", "auto-flush on beforeunload" (contradicted by the code; see D1).

## 5. Environment probes (ENV PROBE, run on this machine on 2026-10-12)

Host: Windows 11 Home 10.0.26200, Chrome 154.0.8037.98 (headless via puppeteer-core), Node 26.1.0.

| Probe | Result |
|---|---|
| `file://` page: `isSecureContext` | `true` |
| `file://` page: `navigator.bluetooth.getAvailability()` | `true` |
| `file://` page: `requestDevice({acceptAllDevices:true})` after a click | Did **not** reject with SecurityError. It stayed pending (chooser shown), the same as on `http://localhost`. |
| `file://` page: `<script type="module">` import | **Blocked** by CORS (origin `null`) |
| `file://` page: IndexedDB write | Works |
| `navigator.storage.persist()` (headless) | `false` |

What this means: a file-opened bundle (classic script, no ES-module imports) is a candidate for
**"no local server, no install"** operation. This was **not** verified with a real BLE device, and
enterprise policy can disable Web Bluetooth.

## 6. Requirements derived (facts → assumptions)

| Question (handoff §3) | Evidence | Resolution |
|---|---|---|
| Target host | Report P5: "Lab computers often cannot have apps installed"; Objective 1: "operable on any Chrome/Edge device" | **Windows lab PCs with Chrome/Edge** are primary. Android Chrome is a possible secondary target that is not tested. |
| Unattended screen-off recording | The existing app warns users to keep the tab visible. Nothing says unattended recording is needed. | **Assumed not required.** The UI states that the page must stay visible. Owner to confirm. |
| Installation on a never-online device | The pivot calls for "distributable to other laboratories". | Treated as **desirable**. It is met by the `file://` zip (pending hardware confirmation) and by a localhost launcher fallback. |
| Firmware under project control | The report says "Updated ESP32 firmware", but the source is not in the repo. | A reference firmware implementing the new protocol is added. The legacy text-float stream remains supported. |

## 7. Blockers / owner decisions

1. **Physical hardware** (ESP32-C3 boards, the sensor circuit) is not available to this session. Every REAL BLE / PHYSICAL criterion is NOT TESTED.
2. **Firebase project**: the owner must check the deployed Firestore rules and then disable or delete the project (see `docs/SECURITY.md`).
3. **License**: no license is present. None was added, so this stays unresolved.
4. **Shared-machine retention policy**: the default is keep-on-bench plus explicit delete/wipe. Owner to confirm.
