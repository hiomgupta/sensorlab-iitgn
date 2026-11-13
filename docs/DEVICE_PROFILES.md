# Generic BLE device profiles

SensorLab device profiles describe GATT services and characteristics as data; they do not contain
JavaScript or execute profile-supplied commands. Profiles use the
`sensorlab-device-profile/1` JSON schema, are validated before saving and again before connection,
and are stored in browser `localStorage` under `sensorlab_device_profiles_v1`.

## Profile shape

```json
{
  "schema": "sensorlab-device-profile/1",
  "version": 1,
  "id": "example-sensor",
  "name": "Example sensor",
  "transport": "web-bluetooth",
  "adapter": "generic-gatt",
  "match": { "namePrefix": "Sensor" },
  "sampling": { "intervalMs": 1000 },
  "characteristics": [
    {
      "id": "measurement",
      "serviceUuid": "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
      "characteristicUuid": "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
      "mode": "notify",
      "decoder": "text-float",
      "framing": { "type": "newline" }
    }
  ],
  "channels": [
    {
      "channelId": 0,
      "name": "Value",
      "unit": "",
      "characteristicId": "measurement",
      "valueIndex": 0,
      "scale": 1,
      "offset": 0
    }
  ]
}
```

`mode` is `read`, `notify`, `indicate`, or `write`. Read sources are polled at the configured
interval (default 1 second); notification and indication sources are subscribed independently.
`sampling.intervalMs` also declares the expected update cadence for stale-data and startup checks.
Write-only characteristics can be included alongside data sources. The app does not send writes
automatically. A user-initiated write is available in the read-only GATT browser, where it requires
hex input and a separate confirmation; payloads are limited to 512 bytes.

Supported `decoder` formats are the strict parsers in `src/protocol/legacy.js`: text float, CSV,
JSON, IEEE-754 float32, signed/unsigned 16-bit integers, uint8, and the standard GATT heart-rate
measurement. `framing` may be `none`, `newline`, `delimiter`, or `length-prefixed`. The UART framing
adapter retains partial frames between notifications, supports multiple frames in one notification,
and bounds frame sizes and buffered input.

Each channel ID is a contiguous zero-based index. `valueIndex` selects a value from the decoded
payload; `scale` and `offset` are applied by the normal acquisition pipeline. Channels sourced from
different characteristics are recorded as separate host-timestamped events. Generic GATT data does
not include SensorLab sequence numbers, device timestamps, or SLTP validity flags, so loss detection
and device-clock timing are unavailable.

The browser chooser is subject to Web Bluetooth permissions and service authorization. A profile
must request the service UUIDs it uses; this does not enable unrestricted scanning or bypass device
pairing and access controls.

The JSON import limit is 256 KiB; a profile can describe at most 32 characteristics and 256
zero-based contiguous channels. Individual frames are capped at 4 KiB and buffered UART input is
bounded. Unknown fields (including command/initialization fields) are rejected.
