# Offline deployment

Four meanings of "offline", tracked separately:

| Meaning | How SensorLab 2 meets it | Evidence |
|---|---|---|
| Offline **runtime** | No runtime network use (CSP `connect-src 'none'`, everything bundled) | E2E: `file://` run with network emulated offline; HTTP run reloaded offline from the service worker; zero non-local requests (SIMULATED INTEGRATION) |
| Offline **installation** | Zip of static files. Copy and open; nothing to install. | Package built and checksummed. **Clean-machine install NOT TESTED.** |
| **Bluetooth-only** sensor data | Web Bluetooth GATT notifications only. No Wi-Fi/MQTT/server path exists in the code. | Static review + lint (no network APIs in `src/`) |
| **No local server** | `index.html` opened from disk works (single classic-script bundle) | E2E on `file://` with demo devices. **Real BLE from `file://` NOT TESTED.** |

## Option A — open from disk (preferred: no server, no install)

1. Get `sensorlab-<version>.zip` (`npm run build && npm run package` produces `release/`). Check `*.sha256`.
2. Unzip anywhere. Double-click `index.html` and choose Chrome or Edge (or drag the file into the browser).
3. Browsers: Chrome or Edge. Vendors document Web Bluetooth on Windows 10+, macOS, ChromeOS and Android; only Chrome 154 on Windows 11 has been exercised here, and only with simulated devices. Firefox and Safari have no Web Bluetooth.
   On Linux, Chrome ships Web Bluetooth behind an experimental flag (not verified for this release; check Chrome's Web Bluetooth implementation status).

Notes: storage on `file://` is shared by all local files in that browser profile (see `SECURITY.md`). Moving the folder
does **not** move the data. Data belongs to the browser profile, so export before changing PCs.

## Option B — local launcher (if policy blocks Bluetooth on `file://`)

Windows, nothing to install: right-click `serve.ps1` → *Run with PowerShell* (or
`powershell -ExecutionPolicy Bypass -File serve.ps1`). It serves on `http://localhost:8080` (loopback only) and opens the browser.
With Node.js: `node tools/serve.mjs dist 8080`.
`localhost` is a secure context, so Web Bluetooth is allowed. Data saved at `http://localhost:8080` is separate from data saved
from `file://`, because they are different storage origins.

## Option C — static HTTPS hosting

Upload `dist/` to any static HTTPS host (e.g. GitHub Pages). On the first visit the service worker precaches the app,
and it then runs offline. This meets offline *runtime* only, not offline *installation*. Updating means uploading a new
`dist/`; clients pick it up on their next online visit (new cache name per build id).

## Policy notes for managed PCs

* Enterprise policy `DefaultWebBluetoothGuardSetting = 2` blocks Web Bluetooth entirely; ask IT to allow it for the origin used.
* The Windows Bluetooth radio must be on. The app shows "adapter off/unavailable" when `getAvailability()` is false.
* **Keep the page visible during recordings.** Background tabs may be throttled. Hidden periods are logged in the session.
