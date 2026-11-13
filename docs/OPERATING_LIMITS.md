# Operating limits and product decisions

Each limit is labelled **DESIGN** (enforced by code), **MEASURED-SIM** (measured on this PC with simulated devices in headless Chrome 154;
not a Bluetooth measurement), or **UNMEASURED** (needs hardware). Do not advertise any UNMEASURED item.

## Product decisions
| Topic | Decision |
|---|---|
| Storage | **Local-first.** Sessions live in the browser profile's IndexedDB and leave via CSV/JSON/ZIP export. There is no cloud, account or sync (removed per the engineering handoff). Backup = export. Removal = History → Delete / Delete all. |
| Sensor contract | `docs/PROTOCOL.md` (SLTP v1, own UUIDs `075e000x-…`). Legacy text/GATT formats are supported without loss detection. |
| Timestamps | SLTP: **device time** (`device_time_us`, unwrapped) + device-clock-anchored `relative_time_s`. Legacy: **browser receipt time** only. |
| Background acquisition | **Not supported** in the browser. The page must stay visible; hidden periods are logged. |

## Limits

| Limit | Value | Class / evidence |
|---|---|---|
| Channels per device | 1–8 (SLTP); packet = 12 + 4·N bytes; N ≤ 2 fits the default 20-byte payload | DESIGN (`src/protocol/sltp.js`) |
| Configurable device rate | 0.1–1000 Hz (period 1 ms–10 s) | DESIGN |
| Devices per session | no app limit; connections are serialized | DESIGN. **Real BLE ceiling UNMEASURED** (adapter/OS dependent) |
| App pipeline throughput (parse → record → IndexedDB → chart) | sustained **2,638 readings/s** with stored = received and 0 app-side gaps (8 devices × 200 Hz nominal × 2 ch; the in-page simulator itself reached only 82% of nominal). 8 × 100 Hz × 2 ch = 1,613 readings/s. Max event-loop lag 25 ms | MEASURED-SIM (`test/e2e/bench-pipeline.mjs`, `docs/evidence/16-bench-pipeline.json`) |
| BLE throughput / max reliable rate per device | — | **UNMEASURED** |
| Data loss on browser crash | ≤ about one flush interval (250 ms) + write time; observed 0.002–0.256 s across single-kill runs (0.164 s and 0.141 s in the 2026-10-14 evidence runs) | MEASURED-SIM. Power loss **UNMEASURED** |
| Unsaved readings held in memory if storage stalls | 200,000, then counted as dropped (never silent) | DESIGN (`Recorder.maxPending`) |
| Session size: history view | 1 M readings 0.67 s; 3 M 2.2 s; 6 M 4.6 s (peak JS heap 1.1 GB); chart decimated to 2,664 points | MEASURED-SIM, packaged app (`docs/evidence/readiness/large-session-final.txt`) |
| Session size: export | 1 M: CSV 2.5 s / 89 MB, JSON 1.6 s / 80 MB, ZIP 2.6 s, each one file. 3 M: CSV and ZIP in 2 parts (275 MB), JSON 4.2 s / 246 MB one file. 6 M: CSV and ZIP in 3 parts (559 MB), each complete. Every export was checked record by record against the generator (0 bad). Peak JS heap up to 2.8 GB at 6 M | MEASURED-SIM, packaged app, same file. Beyond 6 M: untested |
| Largest single download | **256 MB** per file (`MAX_SINGLE_DOWNLOAD_BYTES`). Larger CSV/ZIP exports are offered as parts, saved one at a time. JSON above 256 MB (≈ 3.1 M readings) is refused with an explanation. Reason: Chrome cancelled single blob downloads of 520 MB and 600 MB at 0 bytes (500 MB completed), and a part started while another was being written, or within ~0.2 s of the previous one completing, was also cancelled. The page cannot detect these cancellations | DESIGN, based on ENV PROBE (`docs/evidence/readiness/blob-download-probe.txt`, headless Chrome 154, 23 GB RAM). The limit on lab PCs is **UNMEASURED** |
| Practical duration (example) | 5 devices × 20 Hz × 2 ch = 200 readings/s → 1 M readings ≈ 83 min, 6 M ≈ 8.3 h | derived from the measured tests, not a guarantee |
| Storage quota | browser-managed (Chrome: a share of free disk); shown in the status bar and History; persistence requested | DESIGN; quota exhaustion tested by injection only |
| Lifecycle event log | last 1,000 events per session; older ones dropped **and counted** (`eventsDropped`, export warning) | DESIGN |
| Bursty delivery | samples are timed by the device clock; 20-packet bursts every 400 ms at 50 Hz store correctly and are not flagged stale | MEASURED-SIM (unit) |
| Stale detection | suspect at 3 intervals and stale at 5 (floors 0.5 s / 1 s); on-change streams exempt | DESIGN |
