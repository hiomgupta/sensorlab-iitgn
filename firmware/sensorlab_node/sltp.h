/*
 * SLTP v1 serialization (docs/PROTOCOL.md). Portable C99, no packed structs:
 * every field is written byte by byte in little-endian order.
 * Host-tested against test/fixtures/sltp-v1-vectors.json (npm run test:firmware).
 */
#ifndef SLTP_H
#define SLTP_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SLTP_VERSION        1u
#define SLTP_HEADER_LEN     12u
#define SLTP_MAX_CHANNELS   8u
#define SLTP_MAX_PACKET_LEN (SLTP_HEADER_LEN + 4u * SLTP_MAX_CHANNELS)

#define SLTP_FLAG_BOOT            0x01u
#define SLTP_FLAG_DEVICE_OVERRUN  0x02u
#define SLTP_FLAG_SENSOR_FAULT    0x04u

#define SLTP_OP_STREAM_START 0x01u
#define SLTP_OP_STREAM_STOP  0x02u
#define SLTP_OP_SET_PERIOD   0x03u

#define SLTP_PERIOD_MIN_US 1000u
#define SLTP_PERIOD_MAX_US 10000000u

enum sltp_ctrl_err { SLTP_OK = 0, SLTP_ERR_VERSION = 1, SLTP_ERR_OPCODE = 2, SLTP_ERR_LENGTH = 3, SLTP_ERR_RANGE = 4 };

typedef struct {
    uint32_t sequence;
    uint32_t device_time_us;
    uint8_t flags;
    uint8_t channel_count;        /* 1..8 */
    uint8_t valid_mask;           /* bit i = channel i valid */
    int32_t values[SLTP_MAX_CHANNELS];
} sltp_sample_t;

typedef struct {
    uint8_t opcode;
    uint32_t period_us;           /* SET_PERIOD only */
} sltp_control_t;

/* INFO characteristic (docs/PROTOCOL.md §3). Scale/offset are given as JSON number literals (strings) so the
 * output never depends on the platform's float formatting. */
typedef struct { const char *name; const char *unit; const char *scale; const char *offset; } sltp_channel_info_t;
typedef struct {
    const char *fw; const char *id; const char *model;
    uint32_t period_us; int streaming; int err; uint32_t boot;
    uint8_t channel_count; const sltp_channel_info_t *channels;
} sltp_info_t;

/* Writes the INFO JSON (NUL-terminated). Returns its length, or -1 if it does not fit in len (never truncates
 * silently: a truncated INFO would be rejected by the app as invalid and the device could not be used). */
int sltp_build_info(char *buf, size_t len, const sltp_info_t *info);

/* Sample-slot scheduler (pure arithmetic, host-tested). Precondition: now_us >= *next_slot_us.
 * Returns the number of whole slots that were skipped (0 when on time) and moves *next_slot_us to the first slot
 * strictly after the one being taken now. The caller adds the return value to its sequence counter (mod 2^32) and
 * sets DEVICE_OVERRUN on THIS sample only. All times are 64-bit, so the 32-bit device_time_us wrap does not matter here. */
uint32_t sltp_advance_slot(int64_t now_us, int64_t *next_slot_us, uint32_t period_us);

/* Returns bytes written (12 + 4N) or 0 if the sample is invalid or the buffer is too small. */
size_t sltp_encode_data(const sltp_sample_t *s, uint8_t *out, size_t out_len);

/* Returns enum sltp_ctrl_err; fills *cmd on SLTP_OK. */
int sltp_decode_control(const uint8_t *in, size_t len, sltp_control_t *cmd);

#ifdef __cplusplus
}
#endif

/* Compile-time layout checks (header size is protocol-defined, not compiler-defined). */
typedef char sltp_assert_header_len[(SLTP_HEADER_LEN == 12u) ? 1 : -1];
typedef char sltp_assert_default_mtu[(SLTP_HEADER_LEN + 4u * 2u <= 20u) ? 1 : -1];

#endif
