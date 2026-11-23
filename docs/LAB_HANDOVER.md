# SensorLab 2 - One-Page Lab Handover

**Prepared:** 24 Nov 2026 | **App:** `2.0.0-dev` | **Firmware:** `2.0.2` / SLTP v1  
**Receiver:** ____________________ **Date:** __________ **Delivered commit/build:** ____________________

## Purpose and current status

SensorLab records BLE sensor experiments locally, shows data quality, and exports CSV/JSON/ZIP. Optional Google sign-in backs up owned completed sessions when online. **Software-tested; physical accuracy, real BLE limits and production cloud acceptance require lab sign-off.** No commit or GitHub push was made for this document preparation.

## Launch and daily workflow

From the repository root in PowerShell, install dependencies once with `npm.cmd ci`.

| Edition | Build and launch |
|---|---|
| Offline | `npm.cmd run build`; open `dist\index.html` in Chrome/Edge |
| Cloud | `npm.cmd run build -- --cloud-config .\firebase-config.local.json`; `npm.cmd run serve`; open `http://localhost:8080/` |

1. Check the correct browser profile/origin, storage, sensor wiring and intended Profile account.
2. Use **Demo** for training or **Add device** for a qualified real sensor; confirm identity, units and fresh data.
3. **Record**: name/group/notes, select devices, review preflight, Start; keep the app visible and annotate events.
4. **Stop** and wait for finalized saving. **History**: inspect warnings, export CSV plus JSON/ZIP, then verify downloads.
5. **Profile**: check account/backup state, recent recordings and View all history. Keep exports; sign out on shared machines.

## Hardware essentials

Reference board: XIAO ESP32-C3, **D2/A2/GPIO4 = ADC1 channel 4**, nominal 10.8 kohm divider reference and 3.3 V rail. Default output: **10 Hz**, channels `adc_sum16` and resistance. Pair using the current passkey printed at **115200 baud** after reset. Check actual wiring/reference/rail; invalid resistance is **not** proof of open circuit. The provisional valid voltage guard is **2.45 V**.

## Data, accounts and recovery

- Local data belongs to the **browser profile and origin**, not a portable cloud library. Clearing site data can erase it.
- Offline recordings use the last signed-in owner. Old/unassigned recordings require explicit History Upload; another account cannot simply take ownership.
- Backup needs the app open, internet and the owner login. Local Delete does **not** delete cloud copies. There is no cloud restore UI.
- On an interruption, **History -> Recover** preserves only persisted data; review loss warnings. Never present failed finalization as saved.
- Legacy/generic GATT has host receipt timing only; missing device samples cannot be inferred. Demo is not physical measurement.

## Receiving checklist and next actions

| Confirm before acceptance | Result / evidence |
|---|---|
| Demo -> Record -> Annotate -> Stop -> History -> verified exports | ________ |
| Complete firmware sources; physical pairing, voltage/accuracy and real BLE qualification | ________ |
| Google provider, authorized domain, owner-only Firestore rules and two-account/offline backup test | ________ |
| Archive/retention policy, responsible maintainer and delivered build/commit | ________ |

**Known release gap:** the ZIP packager omits `divider_measurement.h` and has outdated offline-only/documentation labeling. Use the complete repository firmware folder; update/revalidate packaging before a complete release. No project license has yet been selected.

**Keep private:** local Firebase config, keys/passwords, browser tokens and raw lab data. Latest local evidence: **31 focused unit tests, 116/116 browser checks**, plus cloud/Profile offline/mobile smoke and default offline audit. These do not certify hardware or live cloud rules.

**Details:** [Full project report](PROJECT_REPORT.md) · [Cloud setup](CLOUD_BACKUP.md) · [Hardware acceptance](HARDWARE_TEST_PLAN.md) · [Export schema](EXPORT_SCHEMA.md). For faults, preserve build/session/device IDs, Log and exports; record PASS/FAIL/BLOCKED with observations.
