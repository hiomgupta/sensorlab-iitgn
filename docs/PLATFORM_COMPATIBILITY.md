# Platform compatibility (laptops, Android, iPhone)

Three kinds of claim are kept apart:
**TESTED** means exercised here, and the evidence class says how. **DOCUMENTED** means platform/vendor data only, not tested here
(source: MDN browser-compat-data `api/Bluetooth.json` and `api/WakeLock.json`, fetched 2026-10-13). **NOT IMPLEMENTED** means no code exists.
No row has been tested with a physical BLE sensor.

## Matrix

| Capability | Chrome / Edge on laptop (Windows/macOS/ChromeOS) | Android browser (Chrome) | Installed Android app | iPhone browser (Safari, and every iOS browser, which all use WebKit) | Installed iOS app |
|---|---|---|---|---|---|
| App runs offline | **TESTED** (SIMULATED INTEGRATION): Chrome 154 / Windows 11, `file://` and HTTP+SW, network emulated offline | DOCUMENTED (same engine); NOT TESTED | NOT IMPLEMENTED (no native project). "Add to Home Screen" PWA is still Chrome; NOT TESTED | UI/IndexedDB expected to load; NOT TESTED | NOT IMPLEMENTED |
| Bluetooth sensor connection | DOCUMENTED: Web Bluetooth Chrome ≥ 70 (Linux off by default), Edge mirrors Chrome. Driver **unit-tested against a W3C API mock only**; **real BLE NOT TESTED** | DOCUMENTED: Chrome Android ≥ 56; NOT TESTED | NOT IMPLEMENTED. Android **WebView has no Web Bluetooth** (BCD: not implemented), so a WebView wrapper needs a native BLE plugin | **NOT AVAILABLE**: Safari has no Web Bluetooth (BCD: not implemented, webkit.org/b/101034). SensorLab cannot connect to sensors on iPhone. Demo mode, history and export only | NOT IMPLEMENTED (would need CoreBluetooth via a native plugin) |
| Bluetooth permission flow | Browser chooser per device, each time a device is added (user gesture). OS Bluetooth must be on. Policy `DefaultWebBluetoothGuardSetting` can block it | Expected: chooser plus Android runtime Bluetooth/location permissions granted to Chrome (not verified against a source here); NOT TESTED | — | — | — |
| Automatic reconnection | Implemented: `gatt.connect()` on the **same** `BluetoothDevice` with no new chooser (bounded backoff, Retry); service browsing retries once after a transient disconnect. **TESTED** against the mock only. Whether a specific OS/adapter re-establishes the link: NOT TESTED. After a **page reload** the user must pick the device again (no `getDevices()` persistence implemented) | Same code path; NOT TESTED | — | — | — |
| Keep screen awake | Implemented: Screen Wake Lock API (Chrome ≥ 84). **TESTED**: unit tests with a fake API; E2E in headless Chrome 154 returned `active` (headless has no physical screen, so this only proves the API accepted the request) | DOCUMENTED: Chrome Android mirrors ≥ 84; NOT TESTED | NOT IMPLEMENTED. `NativeKeepAwakeAdapter` interface exists (would set `FLAG_KEEP_SCREEN_ON`) | DOCUMENTED: Safari iOS ≥ 18.4 (16.4–18.4 broken in Home Screen apps). Irrelevant for acquisition because there is no Bluetooth | NOT IMPLEMENTED (`isIdleTimerDisabled` via the adapter) |
| Recording with screen locked / page hidden | **Not supported or claimed.** Wake lock is released when the page is hidden; timers and BLE events may be throttled or suspended. Hidden periods, timer stalls and clock jumps are logged as lifecycle events | Same; screen-off typically suspends the page. NOT TESTED | Needs an Android **foreground service** with native BLE: NOT IMPLEMENTED | — | Needs the `bluetooth-central` background mode: NOT IMPLEMENTED |
| Offline installation | Zip opened from disk (`file://`) or `serve.ps1`; **TESTED** with simulated devices. Clean never-online PC: NOT TESTED | No `file://` launcher on Android. Needs one online visit to a hosted HTTPS copy (service worker), or a local server | APK sideload would satisfy it: NOT IMPLEMENTED | — | Would need App Store/TestFlight/enterprise signing: NOT IMPLEMENTED |

## Conclusions

1. **Laptops (Chrome/Edge on Windows):** the supported target today. Lab use is plausible once one real-device test (HARDWARE_TEST_PLAN §1) passes.
2. **Android phones/tablets:** the same web app should work in Chrome on Android (documented support for Web Bluetooth and Wake Lock), with the page kept visible.
   Smallest next step: run HARDWARE_TEST_PLAN §1 on one Android phone in Chrome. No code change is expected.
3. **iPhone:** **not supported for sensor acquisition.** No iOS browser exposes Web Bluetooth. The smallest justified step is a native shell
   (e.g. Capacitor) that reuses `src/protocol`, `src/acquisition`, `src/storage`, `src/export` and the UI. It needs only a new `Transport` implementing the
   interface documented in `src/transport/web-bluetooth.js`, on top of a CoreBluetooth plugin, plus `NativeKeepAwakeAdapter` wired to the plugin.
   Its scope is a separate project decision (signing, distribution, App Store review). It was deliberately **not** started here, per the instruction not to
   force a platform migration during the lifecycle work.
4. **Background or screen-off acquisition** on any platform requires native code (Android foreground service, iOS background mode). A browser cannot provide it.
