# SensorLab node firmware (SLTP v1)

| File | Status |
|---|---|
| `sensorlab_node/sltp.h`, `sltp.c` | Portable C99 serialization. **UNIT TESTED on the host** (`npm run test:firmware`). It matches `src/protocol/sltp.js` byte for byte on the shared vectors. |
| `sensorlab_node/sensorlab_node.ino` | Arduino-ESP32 sketch. **COMPILES** for `esp32:esp32:esp32c3` with arduino-cli 1.5.2-rc.1 and esp32:esp32 **3.3.12** (0 warnings with `--warnings all`; `npm run firmware:compile`). BLE requires Secure Connections bonding with MITM/passkey pairing; passkey is printed over USB serial. **NOT FLASHED and NOT RUN on hardware.** Core 3.x uses NimBLE on the C3; pairing, notification and browser behavior still need physical testing. |
| `test/test_sltp.c` | Host test. `vectors.h` is generated from `test/fixtures/sltp-v1-vectors.json`. |

## Build (to be performed and recorded by the owner)

1. Arduino IDE 2.x or `arduino-cli` with the **esp32 by Espressif** core. Record the exact version used.
2. Board: *ESP32C3 Dev Module* (or the lab's board). USB CDC On Boot: Enabled.
3. Open `firmware/sensorlab_node/sensorlab_node.ino`. `sltp.c` and `sltp.h` in the same folder are compiled automatically.
4. The reference XIAO ESP32-C3 sketch uses `SENSOR_PIN A2`: D2/A2/GPIO4/ADC1_CH4. Check this and `R_REF_OHM` against **the actual circuit** before relying on the `resistance` channel.
5. Flash, open the USB serial monitor at **115200 baud**, reset the board, and note the current boot's BLE pairing passkey printed by the board (startup output may have occurred before the monitor was opened).
6. In Chrome/Edge use the SensorLab app's *SensorLab v2 (SLTP)* connect option and complete the OS/browser pairing prompt with that passkey. The device advertises as `SLab-XXXX`. Existing bonds survive reboot; a new passkey is needed only if the bond is deleted or pairing is reset.

`arduino-cli` example (versions intentionally not pinned here, because none have been tested):

```bash
arduino-cli compile --fqbn esp32:esp32:esp32c3 firmware/sensorlab_node
```

## Design notes

* Sampling is deadline-scheduled in `loop()` and does not use `delay()`. If the loop runs late, the skipped slots still
  advance the sequence and set `DEVICE_OVERRUN`, so the host counts them as device-attributed gaps.
* Samples are taken while disconnected too. The sequence keeps counting, so a disconnection appears
  as a measured gap after reconnect.
* `notify()` in the Bluedroid Arduino library does not report a full transmit queue. Such losses
  appear as host-side gaps without `DEVICE_OVERRUN`.
* The raw ADC sum (ch0) remains the sum of 16 12-bit readings. Each is acquired once through ESP-IDF's
  `adc_oneshot_read()` and calibrated through `adc_cali_raw_to_voltage()` using that same raw count. The C3 uses
  the 12 dB enum corresponding to Arduino's `ADC_11db` setting. The firmware uses a provisional 0-2.45 V valid
  range, leaving 50 mV below the C3's documented 2.5 V limit until physical validation establishes a measured range.
  A derived resistance outside that range is transmitted as invalid, while the raw aggregate is retained.
  It is not labelled open-circuit. ADC driver/calibration API errors and impossible values set the device-level
  `SENSOR_FAULT` flag. Actual resistor value, rail voltage, offset, nonlinearity and uncertainty remain
  hardware-validation work.
* The legacy text-float firmware described in the course report is still supported by the app as the
  "SensorLab ESP32 (legacy text)" preset. Its source is not in this repository.
