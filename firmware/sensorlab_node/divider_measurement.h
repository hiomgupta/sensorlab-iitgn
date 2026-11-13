/* Pure divider-measurement helper. Kept independent of Arduino/BLE so the
 * firmware's validity behaviour can be tested with the host C test suite. */
#ifndef SENSORLAB_DIVIDER_MEASUREMENT_H
#define SENSORLAB_DIVIDER_MEASUREMENT_H

#include <stdint.h>
#include <limits.h>

typedef struct {
    uint8_t raw_valid;
    uint8_t resistance_valid;
    uint8_t sensor_fault;
    int32_t resistance_centiohm;
} divider_measurement_t;

static inline divider_measurement_t divider_measurement_from_mv(
    uint32_t sum_millivolts, uint8_t sample_count, uint8_t adc_fault,
    uint32_t max_valid_millivolts, float reference_ohm, float supply_volts) {
    divider_measurement_t out = { 0, 0, 1, 0 };
    float mean_mv, vout, resistance, centiohm;
    if (sample_count == 0u || adc_fault) return out;

    out.raw_valid = 1;
    out.sensor_fault = 0;
    mean_mv = (float)sum_millivolts / (float)sample_count;
    if (mean_mv > (float)max_valid_millivolts) return out;

    vout = mean_mv / 1000.0f;
    if (vout < 0.0f || vout >= supply_volts) return out;
    resistance = reference_ohm * (vout / (supply_volts - vout));
    centiohm = resistance * 100.0f;
    if (centiohm > (float)INT32_MAX) return out;
    out.resistance_centiohm = (int32_t)(centiohm + 0.5f); /* resistance is non-negative */
    out.resistance_valid = 1;
    return out;
}

#endif
