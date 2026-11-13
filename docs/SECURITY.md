# Security, privacy and threat model

## What offline mode protects against

* **Network exfiltration and remote dependencies:** the app makes no network requests. This is enforced by
  a CSP (`connect-src 'none'`, scripts and styles `'self'` only), a static audit of `dist/`
  (`npm run audit:offline`) and a dynamic E2E network audit (zero non-local requests). There are no
  analytics, fonts, CDNs or cloud services.
* **Supply chain at runtime:** the only third-party runtime code is Chart.js 4.4.7, vendored with a
  SHA-256 recorded in `vendor/VENDOR.md`.

## What it does NOT protect against

* **Other users of the same OS account and browser profile.** Sessions are stored in that profile's IndexedDB,
  and anyone who can open the browser can read and export them. When the app is opened from `file://`, Chrome gives all
  local files one shared storage origin, so other local HTML pages opened in the same profile could read
  SensorLab's data.
* **Malicious or spoofed BLE devices.** BLE names and payloads are untrusted. They are rendered only as text
  (no `innerHTML`; checked by lint and an E2E XSS test). Packets are length- and version-checked, and identity
  collisions are refused. The reference ESP32-C3 firmware now requires an authenticated BLE bond for telemetry
  and control; first pairing uses a random passkey printed over USB serial. The app still has no application-layer
  device certificate or signed INFO record, so identity authenticity depends on securely pairing the intended
  physical board. Do not use SensorLab where that pairing process or physical-device trust cannot be assured.
* **Physical access, malware, browser compromise.**

## Shared lab machines: retention policy

Default (pending owner confirmation): **keep-on-bench with explicit deletion**.
* History → *Delete* removes one session, keyed by session ID. Sessions with the same name are not affected.
* History → *Delete all…* wipes everything after a typed `DELETE` confirmation.
* Recommended practice for shared PCs: separate OS accounts or browser profiles per group, and export and delete
  at the end of each lab. Session forms ask users not to enter personal information.

Alternatives that need an owner decision: wipe-on-exit, or per-operator browser profiles.

## Spreadsheet formula injection

CSV text columns are guarded (see `docs/EXPORT_SCHEMA.md`). Numeric columns are never altered.

## Legacy Firebase project (`sensorlab-iitgn`) — ACTION REQUIRED BY OWNER

The old code included a Firebase web config (`js/firebase-config.js`, API key `AIzaSyA8…`, project
`sensorlab-iitgn`). A Firebase web API key identifies the project and is **not** an authorization secret
by itself. Access is governed by Firestore Security Rules and Auth settings. The setup comment in that file
told users to start Firestore **"in test mode"**, which allows open reads and writes until an expiry date.

**Not verified:** this session had no access to the Firebase console and did not probe the live project.
It is unknown whether per-user rules were ever deployed. Owner checklist:

1. In the Firebase console, check *Firestore → Rules*. They must not be test-mode or `allow read, write: if true`.
2. Check *Authentication → Users* and Firestore data for student data that is still stored.
3. Export anything that should be kept, then either **delete the project** or set rules to deny all, and
   disable Google sign-in.
4. Optionally restrict or delete the API key in Google Cloud console (*APIs & Services → Credentials*).
   The key stays in git history (commit `25dbe42`). Rewriting history is not recommended for a non-secret key,
   but deleting the key is.

SensorLab 2 ships **no** Firebase code, configuration, sign-in, or cloud banner.

## Dependency review

Runtime: Chart.js 4.4.7 (MIT, vendored). Dev-only, pinned in `package-lock.json`: puppeteer-core 25.13.0,
esbuild 0.28.2, fake-indexeddb 6.2.5, chart.js 4.4.7. `npm audit` reported **0 vulnerabilities** on
2026-10-12, after upgrading puppeteer-core from 24.43.1, which pulled in advisories for basic-ftp and extract-zip.
puppeteer-core 25.13.0 was published 2026-10-08. It is a recent dev-only tool and never ships to users.
