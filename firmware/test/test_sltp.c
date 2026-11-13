/* Host test for firmware SLTP serialization. vectors.h is generated from
 * test/fixtures/sltp-v1-vectors.json by test/firmware/run-c-tests.mjs. */
#include <stdio.h>
#include <string.h>
#include "../sensorlab_node/sltp.h"
#include "../sensorlab_node/divider_measurement.h"
#include "vectors.h"

static int failures = 0;
#define CHECK(cond, msg) do { if (!(cond)) { printf("FAIL: %s\n", msg); failures++; } } while (0)

int main(void) {
    size_t i, j;
    uint8_t buf[SLTP_MAX_PACKET_LEN + 4];
    for (i = 0; i < DATA_VECTOR_COUNT; i++) {
        const data_vector_t *v = &DATA_VECTORS[i];
        sltp_sample_t s;
        size_t n;
        memset(&s, 0, sizeof s);
        s.sequence = v->sequence;
        s.device_time_us = v->device_time_us;
        s.flags = v->flags;
        s.channel_count = v->channel_count;
        s.valid_mask = v->valid_mask;
        for (j = 0; j < v->channel_count; j++) s.values[j] = v->values[j];
        n = sltp_encode_data(&s, buf, sizeof buf);
        CHECK(n == v->len, v->name);
        CHECK(n == v->len && memcmp(buf, v->bytes, n) == 0, v->name);
        /* buffer too small must fail cleanly */
        CHECK(sltp_encode_data(&s, buf, v->len - 1) == 0, "short buffer rejected");
    }
    for (i = 0; i < CONTROL_VECTOR_COUNT; i++) {
        const control_vector_t *c = &CONTROL_VECTORS[i];
        sltp_control_t cmd;
        int rc = sltp_decode_control(c->bytes, c->len, &cmd);
        CHECK(rc == SLTP_OK, c->name);
        CHECK(cmd.opcode == c->opcode, c->name);
        if (c->opcode == SLTP_OP_SET_PERIOD) CHECK(cmd.period_us == c->arg, c->name);
    }
    {
        sltp_control_t cmd;
        const uint8_t bad_ver[] = {2, 1};
        const uint8_t bad_op[] = {1, 9};
        const uint8_t bad_len[] = {1, 3, 0xa0, 0x86};
        const uint8_t bad_range[] = {1, 3, 1, 0, 0, 0};
        CHECK(sltp_decode_control(bad_ver, 2, &cmd) == SLTP_ERR_VERSION, "bad version");
        CHECK(sltp_decode_control(bad_op, 2, &cmd) == SLTP_ERR_OPCODE, "bad opcode");
        CHECK(sltp_decode_control(bad_len, 4, &cmd) == SLTP_ERR_LENGTH, "bad length");
        CHECK(sltp_decode_control(bad_range, 6, &cmd) == SLTP_ERR_RANGE, "out of range");
    }
    {
        divider_measurement_t m;
        /* 16 calibrated readings at 0 mV: a genuine short is valid and is 0 ohm. */
        m = divider_measurement_from_mv(0u, 16u, 0u, 2500u, 10800.0f, 3.3f);
        CHECK(m.raw_valid && m.resistance_valid && !m.sensor_fault && m.resistance_centiohm == 0,
              "divider short: valid 0 ohm");
        /* 1.65 V with a 10.8 kOhm upper leg produces 10.8 kOhm. */
        m = divider_measurement_from_mv(26400u, 16u, 0u, 2500u, 10800.0f, 3.3f);
        CHECK(m.raw_valid && m.resistance_valid && !m.sensor_fault && m.resistance_centiohm == 1080000,
              "divider known resistor: calibrated resistance");
        /* 2.451 V is beyond the provisional 2.450 V guarded range: raw stays available, derived value is invalid. */
        m = divider_measurement_from_mv(39216u, 16u, 0u, 2450u, 10800.0f, 3.3f);
        CHECK(m.raw_valid && !m.resistance_valid && !m.sensor_fault && m.resistance_centiohm == 0,
              "divider out of range: raw valid, resistance invalid");
        m = divider_measurement_from_mv(26400u, 16u, 1u, 2500u, 10800.0f, 3.3f);
        CHECK(!m.raw_valid && !m.resistance_valid && m.sensor_fault && m.resistance_centiohm == 0,
              "divider ADC fault: both channels invalid and sensor fault");
    }
    {
        sltp_sample_t s;
        memset(&s, 0, sizeof s);
        s.channel_count = 0;
        CHECK(sltp_encode_data(&s, buf, sizeof buf) == 0, "zero channels rejected");
        s.channel_count = 2; s.valid_mask = 0x04;
        CHECK(sltp_encode_data(&s, buf, sizeof buf) == 0, "valid mask beyond N rejected");
        s.valid_mask = 0x03; s.flags = 0x08;
        CHECK(sltp_encode_data(&s, buf, sizeof buf) == 0, "reserved flag rejected");
    }
    {
        /* INFO JSON: golden output equal to the pre-refactor sketch format, worst case, and truncation refusal */
        static const sltp_channel_info_t ch[2] = { { "adc_sum16", "count", "0.0625", "0" }, { "resistance", "\xCE\xA9", "0.01", "0" } };
        sltp_info_t typ = { "2.0.2", "A1B2C3D4E5F6", "SLab-R1", 100000u, 1, 0, 3735928559u, 2, ch };
        sltp_info_t worst = { "2.0.2", "FFFFFFFFFFFF", "SLab-R1", 10000000u, 1, 4, 4294967295u, 2, ch };
        char buf[300], tiny[50];
        const char *golden = "{\"p\":1,\"fw\":\"2.0.2\",\"id\":\"A1B2C3D4E5F6\",\"model\":\"SLab-R1\",\"period_us\":100000,\"st\":1,\"err\":0,\"b\":3735928559,"
                             "\"ch\":[{\"n\":\"adc_sum16\",\"u\":\"count\",\"s\":0.0625,\"o\":0},{\"n\":\"resistance\",\"u\":\"\xCE\xA9\",\"s\":0.01,\"o\":0}]}";
        int n = sltp_build_info(buf, sizeof buf, &typ);
        CHECK(n == (int)strlen(golden) && strcmp(buf, golden) == 0, "INFO typical == golden (pre-refactor format)");
        printf("INFO_JSON_TYPICAL:%s\n", buf);
        n = sltp_build_info(buf, sizeof buf, &worst);
        CHECK(n > 0 && n < 300, "INFO worst case fits the 300-byte firmware buffer");
        printf("INFO_JSON_WORST:%s\n", buf);
        printf("INFO_WORST_BYTES:%d\n", n);
        CHECK(sltp_build_info(tiny, sizeof tiny, &worst) == -1 && tiny[0] == '\0', "INFO refuses to truncate (returns -1, empty buffer)");
    }
    {
        /* Slot scheduler: on time, late by fractions and whole periods, 64-bit times beyond the 32-bit device clock wrap,
         * and the 32-bit sequence wrap. */
        int64_t next = 1000000;
        uint32_t seq;
        CHECK(sltp_advance_slot(999999, &next, 100000u) == 0 && next == 1000000, "slot not yet due: no change");
        CHECK(sltp_advance_slot(1000000, &next, 100000u) == 0 && next == 1100000, "slot on time: 0 missed, next += period");
        CHECK(sltp_advance_slot(1100000 + 99999, &next, 100000u) == 0 && next == 1200000, "slot <1 period late: 0 missed");
        CHECK(sltp_advance_slot(1200000 + 250000, &next, 100000u) == 2 && next == 1500000, "2.5 periods late: 2 missed, next after now");
        next = 4294967296LL * 3 + 10; /* well past the 32-bit microsecond clock wrap (71.6 min x 3) */
        CHECK(sltp_advance_slot(next + 1000000, &next, 10000000u) == 0 && next == 4294967296LL * 3 + 10 + 10000000LL, "64-bit slot time beyond 2^32 us");
        next = 4294967296LL * 5;
        CHECK(sltp_advance_slot(next + 7 * 1000 + 1, &next, 1000u) == 7 && next == 4294967296LL * 5 + 8000, "1 ms period, 7 missed past 2^32 us");
        CHECK((uint32_t)(4294967296LL * 5 + 5) == 5u, "device_time_us cast wraps mod 2^32");
        seq = 0xFFFFFFFEu; seq += 3u;
        CHECK(seq == 1u, "sequence wraps mod 2^32 when adding missed slots");
        next = 0;
        CHECK(sltp_advance_slot(5000, &next, 0u) == 5 && next == 6000, "period 0 is clamped to the 1 ms minimum (no division by zero)");
    }
    {
        /* INFO builder must refuse channel counts the app rejects (ch must have 1..8 entries). */
        static const sltp_channel_info_t ch[1] = { { "x", "u", "1", "0" } };
        sltp_info_t bad = { "2.0.2", "A", "M", 100000u, 1, 0, 1u, 0, ch };
        char b[300];
        CHECK(sltp_build_info(b, sizeof b, &bad) == -1, "INFO with 0 channels refused");
        bad.channel_count = 9;
        CHECK(sltp_build_info(b, sizeof b, &bad) == -1, "INFO with 9 channels refused");
        bad.channel_count = 1; bad.channels = NULL;
        CHECK(sltp_build_info(b, sizeof b, &bad) == -1, "INFO with NULL channels refused");
    }
    printf("%s: %d failure(s), %u data vectors, %u control vectors\n",
           failures ? "FAILED" : "OK", failures, (unsigned)DATA_VECTOR_COUNT, (unsigned)CONTROL_VECTOR_COUNT);
    return failures ? 1 : 0;
}
