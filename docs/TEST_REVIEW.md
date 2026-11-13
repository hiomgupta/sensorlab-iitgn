# Review of the suggested verification plan (2026-10-14)

Each suggestion is checked against the repository. **Covered** cites the test title (verified as passing in `docs/evidence/03-unit.txt` /
`07-e2e.txt` by `npm run verify:trace`). **Added** means the test did not exist and was written in this review. **Hardware** means it
cannot be verified without a physical ESP32/BLE device (see `HARDWARE_TEST_PLAN.md`). Bugs this review found are listed at the end.

## §2 Step 1 — commands
All nine exist in `package.json` and were re-run from a clean `npm ci`. Raw logs are in `docs/evidence/`. Three scripts were added:
`npm run audit:repo` (repository hygiene), `npm run test:package` (release-zip smoke test) and `node test/e2e/bench-pipeline.mjs` (software capacity).

## §2 Step 2 — are the tests meaningful?

| Suggested case | Status | Evidence |
|---|---|---|
| First session starts correctly | Covered | «header persisted before any sample; STARTING until valid samples on every stream; then RECORDING» |
| Repeated clicks: no duplicate sessions | Covered | «duplicate Record submissions create exactly one session …», «RECORDING only after verification; duplicate submissions create one session» |
| Only selected devices recorded | Covered | «preflight warnings (excluded device, keep-awake unsupported) do not block; excluded device not recorded» |
| Startup accepts partially valid devices without hiding bad channels | Covered | startup verification requires fresh valid data from each selected device; invalid channel rows remain null/flagged and charts omit all-invalid series |
| Stop loses no samples | Covered + **added** | «stop reports every appended reading persisted», «delayed storage writes (2 s each) …» |
| Failed startup saved and reported | Covered | «startup timeout: START_FAILED, session finalised as startup_failed …» |
| One disconnect doesn't mark others disconnected | Covered | «one device disconnects: its streams RECOVERING, other keeps recording …» |
| Old samples not shown as current | Covered | «stale value shown as "last …", not as current» |
| Export matches stored session | Covered + **added** row-by-row | «1000 known samples × 2 devices × 2 channels …» |
| Reload doesn't corrupt prior sessions | **Added** | «reload: a completed session reads back identically …» (unit), «page reload: completed session is byte-identical (SHA-256 …)» (browser) |

**Mutation checks** (does the test fail when the behaviour breaks?): duplicate suppression removed → the integrity suite fails. Fixed 3 s stall
threshold restored → «slow sensor (0.25 Hz) …» fails. D29 reintroduced → the lifecycle-gap test fails. A fabricated title in the matrix → `verify:trace` exits 1.

## §3 Deterministic data-integrity suite — **Added** (`test/unit/data-integrity.test.js`, 6 tests)

| Property | Test | Result |
|---|---|---|
| Sample count, values, timestamps, ordering, device identity, same parameter name on two devices, CSV row-by-row, JSON round trip, quality = persisted | «1000 known samples × 2 devices × 2 channels: …» | 4,000 readings exact |
| Duplicates suppressed, late packet stored and flagged, malformed rejected, gap counted (expected totals stated up front) | «known faults: …» | 990 stored; missing 10; dup 1; late 1; invalid 1 |
| Bursty delivery | «bursty BLE delivery (20 packets per 400 ms …)» | 500 stored; device-clock timing exact; never stale |
| Session isolation | «session isolation: consecutive sessions never share samples» | ✔ |
| Reload | «reload: a completed session reads back identically …» | byte-identical |
| Slow storage | «delayed storage writes (2 s each) …» | 1 write at a time; nothing lost or duplicated |

Evidence class: SIMULATED INTEGRATION with synthetic values, through the real Web Bluetooth driver over a W3C API mock.

## §4 Reliability and edge cases

| Area | Case | Status / evidence |
|---|---|---|
| A Connection | permission denied | **Added**: «permission denied / blocked by policy …» (unit); «Bluetooth permission denial gives an actionable message …» (browser) |
| | device unavailable / chooser cancelled | Covered: «driver: chooser cancelled → NotFoundError …» |
| | failed connection | Covered: «driver: connect failure surfaces as BACKOFF …» |
| | missing service / characteristic | **Added**: «missing GATT service: bounded retries, then DEAD …» |
| | failed subscription | **Added**: «failed notification subscription: listener removed (no leak) …» |
| | disconnect during recording / reconnect | Covered: «one device disconnects …», «repeated link loss: listeners never accumulate …» (**added**) |
| B Storage | IndexedDB unavailable | **Added** (browser): «IndexedDB unavailable: prominent banner, Record refuses …» |
| | quota exceeded, failed writes | Covered: «quota error shown prominently …», «transient storage error …» |
| | delayed writes | **Added**: «delayed storage writes …», «slow finalization is shown as "stopping / finalizing" …» |
| | finalization failure | Covered: «storage failure … FINALIZE_FAILED (no false success)» |
| C Timing / stream | delayed, bursty | **Added**: bursty test above |
| | malformed / duplicate / out-of-order | Covered + **added** exact-total test |
| | slow rates, on-change | Covered: «slow sensor (0.25 Hz) …», «on-change streams are not judged stale from silence» |
| | timer stalls / clock changes | Covered (unit) + **added** real browser freeze: «real browser freeze/resume (Page Lifecycle) recorded …» |
| D Browser lifecycle | hide/return | **Added** (real Chrome, another tab brought to front): «tab hidden then shown during recording: app_hidden/app_visible persisted and a visibility warning shown» |
| | wake-lock rejection / release | Rejection: covered (unit, fake API). Release/reacquire: **added in real Chrome**: «real Wake Lock: released by the browser while hidden, re-acquired when visible, both persisted». The screen physically staying on = **hardware** |
| | reload | **Added** (above) |
| | browser termination | Covered: SIGKILL test (scenario 2) |
| E Multi-device | same parameter on two devices | **Added** (integrity test) + covered in browser (two demo devices both have `temperature`) |
| | one fails, other continues; different rates; removal | Covered: «retry exhaustion …», «stale detection scales … (50 Hz vs 1 Hz)», «device removed during recording …» |

## §5 Product decisions
* **Local vs cloud:** decided **local-first**, per the engineering handoff (cloud/Firebase removed; see `SECURITY.md`). Cloud sync would be a new, separate decision.
* **Sensor-data contract:** `docs/PROTOCOL.md` (SLTP v1). Its UUIDs (`075e000x-…`) are SensorLab's own; they are not the planning document's sample UUIDs.
  Firmware and app agree byte for byte (vectors), and the sketch compiles. **Decoding of real on-air packets is unverified (hardware).**
* **Operating limits:** `docs/OPERATING_LIMITS.md`.
* **Platforms:** `docs/PLATFORM_COMPATIBILITY.md`. iPhone needs a different (native) transport; the browser BLE code is not the place to fix it.

## §6 UI checks

| Check | Status |
|---|---|
| Connect without reading source | Help dialog and README. No usability study done (**manual**) |
| Preflight blocks invalid start | Covered: «fatal preflight (no device selected) disables Start» |
| Choose devices | Covered |
| Disconnected vs connected-but-silent | Covered: device states (WAITING_FOR_DATA/DEGRADED vs DISCONNECTED/BACKOFF/DEAD) shown in text; stream states RECOVERING/DISCONNECTED vs SUSPECT/STALE |
| Live vs stale value | Covered |
| Cancel creates no session | Covered |
| Startup failure visible and recoverable | Covered |
| "Still saving" while finalizing | **Added**: «slow finalization is shown as "stopping / finalizing" with Stop disabled …» |
| Failed finalization not shown as success | Covered |
| Export failure explained | **Added**: «export failure: explained to the user and no file is written» |
| Small viewports, keyboard | Covered (390 px, 1100×720) + **added**: «keyboard: Tab reaches Record and the focus is visibly outlined», «keyboard: Enter opens … Escape closes it; focus returns to Record» |
| Screen reader | **Not done** (manual audit with NVDA/TalkBack needed) |

## §7 Release readiness

| Item | Status |
|---|---|
| Review diff, staged/unstaged/untracked | Done: `npm run audit:repo` (108 files; 7 staged deletions are the 1.x files replaced by `src/`, content kept in `25dbe42`) |
| No secrets or generated artifacts | `audit:repo` passes. **It caught one:** the evidence diff contained the old Firebase key from the deleted file. That diff is now generated with `git diff -D` (deletions without content) |
| Lockfile and clean install | `npm ci`, 0 vulnerabilities |
| Packaged app works in deployment mode | **Added**: `npm run test:package` (checksum, independent unzip, offline `file://` boot, record, finalize) |
| Commit and release | **Not done: awaiting your explicit instruction.** Nothing has been staged or committed |

## Verification tracker (the 26 items)

| # | Item | Verified by |
|---|---|---|
| 1 | Loads without console errors | E2E «no uncaught page errors» (file://, HTTP, scenario 9), package smoke |
| 2 | Demo vs real clearly distinguished | «persistent SIMULATED DATA banner shown», «CSV marks simulated readings» |
| 3 | Permission denial / connection failure messages | **added** tests above |
| 4 | Preflight blocks invalid start | ✔ |
| 5 | Cancel creates nothing; no duplicate start | ✔ |
| 6 | Known samples give expected values and units | **added** integrity suite |
| 7 | Charts keep time order | «live chart series are time-ordered after start …» |
| 8 | Device/channel identities kept | ✔ (integrity + browser) |
| 9 | Slow/silent stream freshness | ✔ |
| 10 | One disconnect doesn't corrupt others | ✔ |
| 11 | Only selected devices recorded | ✔ |
| 12 | Recording only after verification | ✔ |
| 13 | Samples and lifecycle events persisted | ✔ (+ D29 fix) |
| 14 | Stop freezes the quality summary | ✔ (D25) |
| 15 | Reload preserves completed sessions | **added** |
| 16 | History/export match persisted data | ✔ |
| 17 | Storage errors visible, no false success | ✔ |
| 18 | Startup timeout recorded | ✔ |
| 19 | Interrupted vs completed distinguishable | ✔ |
| 20 | Wake-lock failure/release honest | ✔ unit (rejection, absence) + real Chrome (release on hide, re-acquire on return); physical screen = **hardware** |
| 21 | Finalization failures visible, unsaved reported | ✔ |
| 22 | Fresh logs saved | `docs/evidence/` (2026-10-14 run) |
| 23 | Keyboard and visible focus | **added** (screen reader: not done) |
| 24 | No secrets / artifacts committed | `audit:repo` |
| 25 | Clean install and build reproducible | `npm ci` + build logs |
| 26 | Docs match implementation | traceability verifier against fresh logs |

Hardware level (real BLE, measurements, timing, Android, durability under power loss): **not performed**. No board was available.

Correction made during this review: I first assumed headless Chrome could not hide a tab. A probe showed it can (`visible → hidden → visible`), so the real-browser test above was added instead.

## Bugs this review found (all fixed, each with a regression test)

| # | Bug | Found by |
|---|---|---|
| D29 | Lifecycle-gap events (timer stall, clock jump) recorded in the health tick were only persisted on the next *stream* change, so a crash could lose them | the real-browser freeze check; reproduced in a strengthened unit test (fails on the old code) |
| — | The evidence diff re-published the old Firebase API key from the deleted `js/firebase-config.js` | the new `audit:repo` |
| — | A Bluetooth permission denial showed only the raw browser error, with no next step | the new browser check |
