# Accessibility review (2026-10-14)

## Automated / semantic checks (browser E2E scenario 10 + earlier scenarios, Chrome 154 headless)

| Area | Check | Result |
|---|---|---|
| Accessible names | Chrome's accessibility tree (CDP `Accessibility.getFullAXTree`): no unnamed button/checkbox/textbox/combobox/tab/dialog/img; **no duplicate button names** with 2 devices or several sessions | PASS (after fix) |
| Dialogs | add device, demo, history, help, recording confirmation: labelled (`aria-labelledby`), focus moves inside on open, Escape closes, **focus returns to the opener**; modal = background inert | PASS |
| Keyboard | Tab reaches Record with a visible focus outline; Enter opens the confirmation with focus in the name field; device tabs use arrow keys | PASS |
| Live regions | **zero announcements during 5 s of steady healthy recording**; a stale stream is announced once, naming device and channel; recovery and finalization (with reading count) are announced | PASS (after fix) |
| Errors | `#addError`, `#sessionError`, `#storageBanner` are `role=alert`; preflight list is `aria-live=polite`; toasts container polite, error toasts `role=alert` | PASS (inspection + existing E2E) |
| Status not by colour alone | device/stream/session states carry text and symbols (✕ ▲ ● ↻) | PASS (inspection) |
| Charts | both canvases `role=img` + `aria-describedby` → numerical alternatives (Latest values table; History per-series summary table with count/invalid/min/max/first/last) | PASS (after fix) |
| Contrast | every visible text node ≥ 4.5:1 (large ≥ 3:1), dark and light themes | PASS |
| Small screens | 390 px: no horizontal scroll; dialogs reachable; 1100×720: Start/Cancel visible | PASS |

## Defects found and fixed (each has a regression check that fails when the defect is reintroduced)

| # | Defect | Fix | Regression check (mutation-verified) |
|---|---|---|---|
| A1 | "Settings", "Remove" (and "Retry") repeated once per device card; History "View"/"Delete" repeated per session. Screen-reader users could not tell targets apart | device/session-specific `aria-label`s (e.g. "Settings for SIM-01", "Delete session Trial 3, started …") | «every control has an accessible name; no ambiguous duplicates …» (failed with `["Settings",2]` when reverted) |
| A2 | `#recStatus` and the session strip were live regions updated every second: 25 and 35 announcements per 5 s | made non-live; a single `#srAnnounce` (polite, atomic) speaks only discrete changes | «no live-region announcements during 5 s of steady healthy recording» (failed with `{"recStatus":25}` when reverted) |
| A3 | Stale-stream banner was a live region whose text (ages) changed every second | banner non-live; the announcer speaks when the *set* of affected streams/states changes | «stale stream announced once with device and channel; no repeats while unchanged» |
| A4 | Charts had no linked text alternative | `aria-describedby` + per-series summary table in History | «charts reference a textual/numerical alternative …», «History: per-series numerical summary table …» |

Mutation evidence: `docs/evidence/readiness/a11y-mutation-check.txt`.

## NOT VERIFIED: a real screen-reader session
No NVDA or JAWS is installed. Windows Narrator is present, but its speech could not be observed from this environment. The checks above test the semantics a screen reader consumes, not the spoken experience.

### Manual procedure (about 20 minutes, NVDA 2024+ or Windows Narrator, Chrome/Edge)
1. Start NVDA (or Narrator: Ctrl+Win+Enter). Open `index.html` from the release folder. Press Demo → Start demo using the keyboard only.
2. Tab through the header and device cards. **Expect:** each button names its target ("Settings for SIM-01", "Remove SIM-02").
3. Tab to Record and press Enter. **Expect:** "Confirm recording, dialog", then the name field is announced. Tab through the device checkboxes ("Record SIM-01, checked") and the "Keep screen awake…" checkbox with its explanation.
4. Press Start recording. **Expect:** "Starting recording…", then "Recording. All streams are fresh." No further speech for 10 s while recording runs.
5. In the Demo dialog, stop one device (or use a real device and move it out of range). **Expect:** one announcement naming the device and channel as suspect/stale, and **no repetition** every second.
6. Restore it. **Expect:** "All streams fresh again" / "Recording. All streams are fresh."
7. Press Stop. **Expect:** "Stopping…", then "Recording stopped and finalized. N readings saved."
8. History → View a session. Arrow into the per-series summary table. **Expect:** headers and values read as a table.
9. Press Escape in every dialog. **Expect:** focus returns to the button that opened it.

Record for each step: PASS/FAIL, the exact speech heard, screen reader and version, browser and version.
