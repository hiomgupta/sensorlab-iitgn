# SensorLab Telemetry Protocol — SLTP v1

Status: **v1, frozen for implementation.** Reference implementations:
`src/protocol/sltp.js` (client) and `firmware/sensorlab_node/sltp.c` (device).
The two are checked byte-for-byte against `test/fixtures/sltp-v1-vectors.json`
by `npm test` (JS) and `npm run test:firmware` (C, host-compiled).
**That check is a UNIT TEST. It is not a radio test.**

All multi-byte integers are **little-endian**. Fields are serialized explicitly byte by byte.
The firmware does not use packed C structs.

## 1. GATT layout

| Item | UUID | Properties |
|---|---|---|
| Service | `075e0001-9ad5-4c6a-96ae-ff1cbd6c71a6` | primary |
| DATA characteristic | `075e0002-9ad5-4c6a-96ae-ff1cbd6c71a6` | notify; authenticated BLE link required |
| INFO characteristic | `075e0003-9ad5-4c6a-96ae-ff1cbd6c71a6` | authenticated read |
| CONTROL characteristic | `075e0004-9ad5-4c6a-96ae-ff1cbd6c71a6` | authenticated write (with response) |

Advertised name: `SLab-XXXX`, where XXXX is the last 2 bytes of the eFuse base MAC in upper-case hex (the last four characters of INFO `id`;
the BLE address itself may differ from the base MAC). This is for display only:
**the identity comes from INFO `id`**, never from the name.

The reference ESP32-C3 firmware requires BLE Secure Connections bonding with MITM/passkey authentication for DATA, INFO, and CONTROL access. On first pairing, open the board's USB serial monitor at 115200 baud, reset the board, and read the current boot's six-digit passkey; enter it in the operating-system pairing prompt opened by Chrome/Edge. The bonded link authenticates subsequent GATT access; the INFO serial by itself is not a cryptographic identity. If the bond is cleared, pair again using the current boot's passkey. This link security is not part of the SLTP packet format.

## 2. DATA packet (notification)

```
offset size type     field
0      1    uint8    version            = 0x01
1      1    uint8    channel_count N    1..8
2      4    uint32   sequence           per-sample counter, see §4
6      4    uint32   device_time_us     micros since boot, mod 2^32, see §5
10     1    uint8    flags              see below
11     1    uint8    valid_mask         bit i = channel i valid; bits >= N must be 0
12     4*N  int32[N] raw channel values
```

Packet length is **exactly `12 + 4·N`**. Any other length is rejected.

* N = 2 gives 20 bytes, which fits the default ATT payload (MTU 23 − 3).
* N > 2 needs a negotiated ATT MTU of at least `12 + 4·N + 3`. Web Bluetooth does not expose
  the MTU. If the stack truncates a notification, the client rejects it with
  `LENGTH_MISMATCH`. The rejection is counted and shown in diagnostics. Nothing is silently misread.

`flags`:

| bit | name | meaning |
|---|---|---|
| 0 | `BOOT` | Set on the first packet **transmitted** after device boot. Sequence and clock start a new epoch. |
| 1 | `DEVICE_OVERRUN` | The device missed one or more sample slots immediately before this sample (it describes this sample only; the firmware does not carry it over to a later packet). The skipped sequence numbers are attributed to the device. |
| 2 | `SENSOR_FAULT` | Device-level sensor fault (e.g. ADC read error) |
| 3–7 | reserved | **Must be 0.** Non-zero is rejected with `RESERVED_FLAGS`. |

Engineering value for channel *i* = `raw[i] · scale[i] + offset[i]`, using the scale and offset from INFO.
An invalid channel (`valid_mask` bit clear) is stored with `value = null`, the raw value kept,
and quality flag `INVALID`. It is never stored as a sentinel number.

For the reference XIAO ESP32-C3 divider firmware, channel 0 remains valid raw data (`adc_sum16`), while
channel 1 (`resistance`) is invalid when its calibrated ADC voltage is outside the
provisional `ADC_11db` 0-2.45 V range (a 50 mV guard below the documented 2.5 V limit), or when the firmware
detects an acquisition fault. SLTP v1 records
only channel validity and the device-level `SENSOR_FAULT` flag: it does **not** encode a per-channel reason
such as `OUT_OF_RANGE` or `OPEN_CIRCUIT`. An invalid resistance must not be interpreted as open circuit.

## 3. INFO characteristic (read)

UTF-8 JSON, at most 512 bytes (the ATT attribute maximum). Short keys keep it within limits:

```json
{"p":1,"fw":"2.0.2","id":"A1B2C3D4E5F6","model":"SLab-R1","period_us":100000,"st":1,"err":0,"b":3735928559,
 "ch":[{"n":"adc_sum16","u":"count","s":0.0625,"o":0},{"n":"resistance","u":"Ω","s":0.01,"o":0}]}
```

| key | type | meaning |
|---|---|---|
| `p` | int | protocol version. The client **refuses** anything other than `1`. |
| `fw` | string | firmware version |
| `id` | string | stable device serial (`[A-Za-z0-9_-]{1,32}`), e.g. the eFuse MAC |
| `model` | string | board/sensor model |
| `period_us` | int | currently configured sample period |
| `st` | 0/1 | streaming stopped/started |
| `err` | int | result of the last CONTROL write (0 = OK; see §6) |
| `b` | uint32 | random boot nonce, new on every boot. If it changes across a reconnect, the client starts a new epoch even when the `BOOT` packet was missed. |
| `ch` | array | channel map, length 1..8: `n` name (1..32 chars), `u` unit (≤ 16 chars), `s` scale (finite, ≠ 0), `o` offset (finite; the client treats a missing `o` as 0) |

This example is exactly what the reference firmware emits for that serial and boot nonce. `firmware/test/test_sltp.c` checks it
as a golden string (`sltp_build_info`), and `test/firmware/run-c-tests.mjs` feeds the firmware's output through the app's own
`parseDeviceInfo`. Worst case (serial `FFFFFFFFFFFF`, period 10 s, boot nonce 2^32−1) is 206 bytes, within the firmware's
300-byte buffer and the 512-byte limit. `adc_sum16` is the sum of 16 ADC reads; scale 0.0625 turns it into the mean count.

The client also rejects an INFO whose `period_us` is present but outside 1,000..10,000,000. The firmware's typical INFO (204 bytes) is far larger
than the 20-byte default ATT payload, so reading it relies on the ATT stack performing a long (blob) read; this has **not** been verified
on hardware.

The channel count in DATA packets must equal `ch.length`. A packet with a different N is rejected with
`CHANNEL_COUNT_MISMATCH`.

## 4. Sequence numbers

* `sequence` increments by 1 for **every scheduled sample slot**, whether or not a client is
  connected or subscribed. Samples taken while disconnected therefore show up as a counted gap.
* It wraps from `2^32−1` to `0`. The client compares modulo 2^32: a forward distance below 2^31 is a forward step,
  zero is a duplicate, and anything else is late (out of order).
* `BOOT` resets the client's tracking epoch. The old epoch's counters are kept, and `restarts` is incremented.
* A gap means sequence values were not received. On its own it **does not locate where the loss happened**.
  `DEVICE_OVERRUN` is the only attribution the protocol provides.

## 5. Device timestamps

* `device_time_us` is taken immediately after the ADC conversion of the slot, before any BLE work.
* It is microseconds mod 2^32, so it **wraps every 4,294.967296 s (≈ 71.58 min)**.
* The client unwraps it into a monotonically increasing 53-bit value: if `t < t_prev` and
  `t_prev − t > 2^31`, then `wraps += 1`.
* Unwrapping is ambiguous if two consecutive received packets are more than 2^31 µs (≈ 35.8 min)
  apart on the host monotonic clock. In that case the client starts a new timebase epoch and
  flags the sample `TIMEBASE_RESET`. It does not guess.
* Microsecond units were chosen because a 1 ms target for intra-device timing error cannot be
  evaluated with millisecond timestamps. **Meeting that target has not been measured.**

## 6. CONTROL characteristic (write with response)

```
offset size field
0      1    version = 0x01
1      1    opcode
2      ...  payload
```

| opcode | name | payload | effect |
|---|---|---|---|
| 0x01 | `STREAM_START` | none | notifications on (sampling never stops) |
| 0x02 | `STREAM_STOP` | none | notifications off |
| 0x03 | `SET_PERIOD` | uint32 period_us, 1,000..10,000,000 | new sample period, effective from the next slot. The sequence continues and `BOOT` is not set. |

Acknowledgement semantics: the GATT write response only confirms that the write was delivered.
After every write the client **reads INFO back** (timeout 2 s) and checks `err == 0` and the
expected `st` / `period_us`. On mismatch or timeout the command counts as **failed** and the
UI shows it. `err` codes: `0` OK, `1` bad version, `2` unknown opcode, `3` bad length, `4` out of range.
The device ignores invalid commands apart from setting `err`. Checks run in this order and the first failure wins: payload shorter than
2 bytes → `3`; version ≠ 1 → `1`; unknown opcode → `2`; payload length wrong for the opcode → `3`; `period_us` out of range → `4`.
A successful command resets `err` to 0.

Tare is **not** a device command. It is a host-side operation on the received engineering
value (see `src/acquisition/calibration.js`). Raw values are never modified.

## 7. Legacy streams (pre-v2 firmware)

The client still accepts the pre-v2 formats: text-float, text-csv, text-json, (u)int16, float32,
and the standard Heart Rate, Battery and Temperature characteristics. These carry **no sequence
number and no device timestamp**. Their readings are flagged `HOST_TIME_ONLY`, loss cannot
be detected, and the session report says so. The legacy "SensorLab ESP32 (text)" preset
treats the firmware's open-circuit value `1000000` as **invalid** (`SENTINEL`).
A reading of `0.0` (the firmware's short-circuit clamp) cannot be told apart from a real value.
This limitation is documented, not hidden.

## 8. Throughput

No throughput figure is claimed. Batching several samples per notification is **not** part of v1.
It would require a measured MTU and a reassembly design, and it should be added only after
baseline single-sample performance has been measured on real hardware (`docs/HARDWARE_TEST_PLAN.md`).
