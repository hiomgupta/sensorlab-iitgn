#include "sltp.h"
#include <stdio.h>

static void put_u32le(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)(v & 0xffu);
    p[1] = (uint8_t)((v >> 8) & 0xffu);
    p[2] = (uint8_t)((v >> 16) & 0xffu);
    p[3] = (uint8_t)((v >> 24) & 0xffu);
}

static uint32_t get_u32le(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

size_t sltp_encode_data(const sltp_sample_t *s, uint8_t *out, size_t out_len) {
    size_t n, need, i;
    if (!s || !out) return 0;
    n = s->channel_count;
    if (n < 1u || n > SLTP_MAX_CHANNELS) return 0;
    if (s->flags & ~(SLTP_FLAG_BOOT | SLTP_FLAG_DEVICE_OVERRUN | SLTP_FLAG_SENSOR_FAULT)) return 0;
    if (n < 8u && (s->valid_mask >> n) != 0u) return 0;
    need = SLTP_HEADER_LEN + 4u * n;
    if (out_len < need) return 0;
    out[0] = (uint8_t)SLTP_VERSION;
    out[1] = (uint8_t)n;
    put_u32le(out + 2, s->sequence);
    put_u32le(out + 6, s->device_time_us);
    out[10] = s->flags;
    out[11] = s->valid_mask;
    for (i = 0; i < n; i++) put_u32le(out + SLTP_HEADER_LEN + 4u * i, (uint32_t)s->values[i]);
    return need;
}

int sltp_decode_control(const uint8_t *in, size_t len, sltp_control_t *cmd) {
    uint32_t p;
    if (!in || len < 2u) return SLTP_ERR_LENGTH;
    if (in[0] != SLTP_VERSION) return SLTP_ERR_VERSION;
    switch (in[1]) {
        case SLTP_OP_STREAM_START:
        case SLTP_OP_STREAM_STOP:
            if (len != 2u) return SLTP_ERR_LENGTH;
            cmd->opcode = in[1];
            cmd->period_us = 0;
            return SLTP_OK;
        case SLTP_OP_SET_PERIOD:
            if (len != 6u) return SLTP_ERR_LENGTH;
            p = get_u32le(in + 2);
            if (p < SLTP_PERIOD_MIN_US || p > SLTP_PERIOD_MAX_US) return SLTP_ERR_RANGE;
            cmd->opcode = in[1];
            cmd->period_us = p;
            return SLTP_OK;
        default:
            return SLTP_ERR_OPCODE;
    }
}

uint32_t sltp_advance_slot(int64_t now_us, int64_t *next_slot_us, uint32_t period_us) {
    int64_t late;
    uint32_t missed;
    if (period_us < SLTP_PERIOD_MIN_US) period_us = SLTP_PERIOD_MIN_US;
    late = now_us - *next_slot_us;
    if (late < 0) return 0;
    missed = (uint32_t)(late / (int64_t)period_us);
    *next_slot_us += ((int64_t)missed + 1) * (int64_t)period_us;
    return missed;
}

int sltp_build_info(char *buf, size_t len, const sltp_info_t *info) {
    size_t used = 0;
    int n, i;
    if (!buf || !info || len == 0) return -1;
    if (info->channel_count < 1u || info->channel_count > SLTP_MAX_CHANNELS || !info->channels) { buf[0] = '\0'; return -1; }
#define SLTP_APPEND(...) do { n = snprintf(buf + used, len - used, __VA_ARGS__); if (n < 0 || (size_t)n >= len - used) { buf[0] = '\0'; return -1; } used += (size_t)n; } while (0)
    SLTP_APPEND("{\"p\":%u,\"fw\":\"%s\",\"id\":\"%s\",\"model\":\"%s\",\"period_us\":%lu,\"st\":%d,\"err\":%d,\"b\":%lu,\"ch\":[",
                SLTP_VERSION, info->fw, info->id, info->model, (unsigned long)info->period_us, info->streaming ? 1 : 0, info->err, (unsigned long)info->boot);
    for (i = 0; i < info->channel_count; i++) {
        const sltp_channel_info_t *c = &info->channels[i];
        SLTP_APPEND("%s{\"n\":\"%s\",\"u\":\"%s\",\"s\":%s,\"o\":%s}", i ? "," : "", c->name, c->unit, c->scale, c->offset);
    }
    SLTP_APPEND("]}");
#undef SLTP_APPEND
    return (int)used;
}
