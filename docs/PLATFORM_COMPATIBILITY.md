# Platform compatibility (laptops, Android, iPhone/iPad)

Three kinds of claim are kept apart:
**TESTED** means exercised here, and the evidence class says how. **DOCUMENTED** means platform/vendor data only, not tested here
(source: MDN browser-compat-data `api/Bluetooth.json` and `api/WakeLock.json`, fetched 2026-10-13). **NOT IMPLEMENTED** means no code exists.
No row has been tested with a physical BLE sensor.
Bluefy is a separate candidate browser, described below; it is not covered by the mainstream iOS browser column.

## Matrix

| Capability | Chrome / Edge on laptop (Windows/macOS/ChromeOS) | Android browser (Chrome) | Installed Android app | Mainstream iPhone/iPad browser (Safari, ordinary iOS Chrome/Edge) | Native iOS app |
|---|---|---|---|---|---|
| App runs offline | **TESTED** (SIMULATED INTEGRATION): Chrome 154 / Windows 11, `file://` and HTTP+SW, network emulated offline | DOCUMENTED (same engine); NOT TESTED | NOT IMPLEMENTED (no native project). "Add to Home Screen" PWA is still Chrome; NOT TESTED | UI/IndexedDB expected to load; NOT TESTED | NOT IMPLEMENTED |
| Bluetooth sensor connection | DOCUMENTED: Web Bluetooth Chrome ≥ 70 (Linux off by default), Edge mirrors Chrome. Driver **unit-tested against a W3C API mock only**; **real BLE NOT TESTED** | DOCUMENTED: Chrome Android ≥ 56; NOT TESTED | NOT IMPLEMENTED. Android **WebView has no Web Bluetooth** (BCD: not implemented), so a WebView wrapper needs a native BLE plugin | **NOT AVAILABLE** in these browsers: no Web Bluetooth. Demo mode, history and export only; see Bluefy below | NOT IMPLEMENTED (would need CoreBluetooth via a native plugin) |
| Bluetooth permission flow | Browser chooser per device, each time a device is added (user gesture). OS Bluetooth must be on. Policy `DefaultWebBluetoothGuardSetting` can block it | Expected: chooser plus Android runtime Bluetooth/location permissions granted to Chrome (not verified against a source here); NOT TESTED | — | — | — |
| Automatic reconnection | Implemented: `gatt.connect()` on the **same** `BluetoothDevice` with no new chooser (bounded backoff, Retry); service browsing retries once after a transient disconnect. **TESTED** against the mock only. Whether a specific OS/adapter re-establishes the link: NOT TESTED. After a **page reload** the user must pick the device again (no `getDevices()` persistence implemented) | Same code path; NOT TESTED | — | — | — |
| Keep screen awake | Implemented: Screen Wake Lock API (Chrome ≥ 84). **TESTED**: unit tests with a fake API; E2E in headless Chrome 154 returned `active` (headless has no physical screen, so this only proves the API accepted the request) | DOCUMENTED: Chrome Android mirrors ≥ 84; NOT TESTED | NOT IMPLEMENTED. `NativeKeepAwakeAdapter` interface exists (would set `FLAG_KEEP_SCREEN_ON`) | DOCUMENTED: Safari iOS ≥ 18.4 (16.4–18.4 broken in Home Screen apps). This does not add Bluetooth support | NOT IMPLEMENTED (`isIdleTimerDisabled` via the adapter) |
| Recording with screen locked / page hidden | **Not supported or claimed.** Wake lock is released when the page is hidden; timers and BLE events may be throttled or suspended. Hidden periods, timer stalls and clock jumps are logged as lifecycle events | Same; screen-off typically suspends the page. NOT TESTED | Needs an Android **foreground service** with native BLE: NOT IMPLEMENTED | — | Needs the `bluetooth-central` background mode: NOT IMPLEMENTED |
| Offline installation | Zip opened from disk (`file://`) or `serve.ps1`; **TESTED** with simulated devices. Clean never-online PC: NOT TESTED | No `file://` launcher on Android. Needs one online visit to a hosted HTTPS copy (service worker), or a local server | APK sideload would satisfy it: NOT IMPLEMENTED | — | Would need App Store/TestFlight/enterprise signing: NOT IMPLEMENTED |

## Conclusions

1. **Laptops (Chrome/Edge on Windows):** the supported target today. Lab use is plausible once one real-device test (HARDWARE_TEST_PLAN §1) passes.
2. **Android phones/tablets:** the same web app should work in Chrome on Android (documented support for Web Bluetooth and Wake Lock), with the page kept visible.
   Smallest next step: run HARDWARE_TEST_PLAN §1 on one Android phone in Chrome. No code change is expected.
3. **iPhone/iPad:** ordinary Safari and iOS Chrome/Edge cannot acquire sensors. Bluefy is a possible way to reuse this
   web app and BLE protocol without a SensorLab native shell, but requires installing that browser and physical qualification.
   If only mainstream browsers are allowed, sensor acquisition is not achievable with the current approach.
4. **Background or screen-off acquisition:** this browser architecture does not guarantee it on any platform.
   Reliable background acquisition would be separate native work and is not part of this qualification.

## Bluefy candidate (DOCUMENTED platform capability, SensorLab NOT TESTED)

The [official Bluefy listing](https://apps.apple.com/us/app/bluefy-web-ble-browser/id1492822055)
(checked 2026-11-14) describes Web Bluetooth/GATT support on iPhone and iPad and requires HTTPS.
This corrects the earlier overbroad claim that no iOS browser can expose Web Bluetooth.

- Use the same built HTTPS-hosted app; no new backend, cloud data path, transport protocol or framework is introduced.
- The optional `getAvailability()` query is not required for Add device. Its absence is reported as unknown availability,
  not as an off adapter; query errors are logged without disabling the chooser.
- BLE writes use the characteristic's advertised write capabilities, with the older `writeValue()` API used only
  when supported. A rejected write is not retried through another mode because device commands may have side effects.
- Do not infer offline support from Web Bluetooth support: verify service-worker caching, a fully offline reload,
  IndexedDB recording/recovery, and completed CSV/JSON/ZIP downloads in Bluefy itself.
- Check foreground wake-lock behavior and simultaneous device connections. Do not promise screen-off recording,
  PWA Bluetooth support outside Bluefy, or equivalence to Chrome's radio/OS behavior.
- If any required offline, timing, accuracy, quality or multi-device criterion fails, that configuration is not qualified.

## Common qualification gate

Follow [HARDWARE_TEST_PLAN.md](HARDWARE_TEST_PLAN.md), including Part D, for each Windows, macOS, Android,
iPhone/Bluefy and iPad/Bluefy configuration. Keep a separate evidence record for each OS/browser/adapter/firmware/build.
Write down target rates, device count, timing and analog tolerances, permitted loss and duration before the run.
Missing thresholds, missing equipment or a simulation-only result cannot establish physical qualification.
