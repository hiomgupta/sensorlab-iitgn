# SensorLab Security Review Summary

**Scope:** static review of the current SensorLab 2 working tree and the security surface described in the project documentation. No application source was changed for this review. No physical device, deployed host, Firebase console, or live external service was tested.

## Findings

| # | Severity | File | Lines | Vulnerability | Confidence |
|---|----------|------|-------|---------------|------------|
| 1 | 🟡 MEDIUM | `src/storage/idb-repository.js`; `docs/OFFLINE_DEPLOYMENT.md`; `docs/SECURITY.md` | `idb-repository.js` 58–73; `OFFLINE_DEPLOYMENT.md` 12–20; `SECURITY.md` 14–17 | In `file://` mode, browser-profile IndexedDB is not isolated from other local HTML files in the same Chrome profile; another local page may access stored sessions. | 8/10 |
| 2 | 🟡 MEDIUM | `src/ui/connect-view.js`; `src/protocol/sltp.js`; `src/acquisition/acquisition-service.js`; `docs/SECURITY.md` | `connect-view.js` 49; `sltp.js` 116–160; `acquisition-service.js` 111–118, 148–151; `SECURITY.md` 18–23 | The app does not verify a signed device identity or signed telemetry. INFO serial is self-reported; an operator who trusts/selects or pairs an unintended SLTP-compatible peripheral could record fabricated readings. Reference-firmware BLE pairing mitigates but does not replace app-layer identity verification. | 8/10 |
| 3 | ⚪ LOW | `src/ui/history-view.js`; `src/export/export.js`; `src/storage/idb-repository.js` | `history-view.js` 316–335; `export.js` 236–264; `idb-repository.js` 36–50 | JSON import has no explicit size cap and validates only part of each reading schema. A large or malformed user-selected file can cause memory pressure or persist inconsistent local records. The path requires local file selection; no remote import path exists. | 7/10 |

Finding 3 is a verified validation gap; its impact beyond browser memory pressure or inconsistent records is inferred and was not demonstrated.

## Assessment and limits

- The current application has no backend, account login, REST/GraphQL API, remote database, payments, webhooks, or cloud synchronization. Server-side IDOR, SQL injection, SSRF, CSRF, and payment-integrity controls are therefore not applicable to the current runtime.
- The app uses a restrictive CSP, same-origin-only service-worker handling, text-oriented rendering, protocol validation, and CSV formula-trigger escaping. The reviewed security pass found no additional verified injection, CSP, service-worker, or export vulnerability.
- The reference ESP32-C3 firmware configures authenticated BLE pairing and protected characteristics. It has not been validated on physical hardware; trust still depends on pairing the intended board.
- The legacy Firebase project's live rules, authentication configuration, and retained data are unknown. The repository documents an owner action to verify and disable/delete or secure it. No credential value is reproduced here.
- No current online dependency-advisory scan, deployed-host review, or live-service review was performed for this summary.

## Recommended actions

1. For sensitive recordings, avoid `file://` on shared browser profiles; use separate OS/browser profiles or a distinct managed origin.
2. Decide whether controlled physical pairing is sufficient or whether signed device identity/telemetry is required.
3. Add a documented import size limit and strict JSON/schema validation before writing to IndexedDB.
4. Verify and secure, disable, or delete the historical Firebase project and check for retained data.
5. Complete physical BLE pairing, sensor, storage durability, and deployment acceptance tests before production use.
