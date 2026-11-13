/*
 * SensorLab node firmware — SLTP v1 reference implementation (docs/PROTOCOL.md).
 * Target: ESP32-C3, Arduino-ESP32 core (NimBLE BLE library). See firmware/README.md.
 *
 * STATUS: sltp.c is host-tested byte-for-byte. The sketch COMPILES for esp32:esp32:esp32c3 with arduino-cli 1.5.2-rc.1 +
 * esp32:esp32 3.3.12 (docs/evidence/readiness/firmware-compile.txt). It has NOT been flashed or run on hardware.
 *
 * Channels:
 *   ch0 "adc_sum16"  sum of 16 raw ADC counts (scale 0.0625 -> mean counts). Raw is preserved.
 *   ch1 "resistance" nominal divider resistance in centi-ohm (scale 0.01 -> ohm).
 *                    Invalid (valid bit clear) outside the calibrated ADC range; no sentinels.
 */
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <BLESecurity.h>
#include <esp_timer.h>
#include <esp_system.h>
#include <esp_mac.h>
#include <esp_adc/adc_oneshot.h>
#include <esp_adc/adc_cali.h>
#include <esp_adc/adc_cali_scheme.h>
#include "sltp.h"
#include "divider_measurement.h"

#define FW_VERSION      "2.0.2"
#define MODEL           "SLab-R1"
/* Seeed XIAO ESP32-C3: D2 = A2 = GPIO4 = ADC1_CH4. */
#define SENSOR_PIN      A2
#define ADC_SAMPLES     16
#define R_REF_OHM       10800.0f
#define V_SUPPLY        3.3f
/* ESP32-C3 / Arduino-ESP32 documented calibrated range at ADC_11db: 0..2500 mV. */
#define ADC_MAX_VALID_MV 2450u  /* 50 mV guard below the documented upper limit; validate physically. */
#define ADC_ABSOLUTE_MAX_MV 3300u
#define DEFAULT_PERIOD_US 100000u   /* 10 Hz; configurable via CONTROL */

#define SVC_UUID  "075e0001-9ad5-4c6a-96ae-ff1cbd6c71a6"
#define DATA_UUID "075e0002-9ad5-4c6a-96ae-ff1cbd6c71a6"
#define INFO_UUID "075e0003-9ad5-4c6a-96ae-ff1cbd6c71a6"
#define CTRL_UUID "075e0004-9ad5-4c6a-96ae-ff1cbd6c71a6"

static BLECharacteristic *dataChar;
static BLECharacteristic *infoChar;
static volatile bool connected = false;
static volatile bool streaming = true;
static volatile uint32_t periodUs = DEFAULT_PERIOD_US;
static volatile int lastCtrlErr = 0;
static uint32_t bootNonce = 0;
static char serial[13];

static uint32_t sequence = 0;
static int64_t nextSlotUs = 0;
static bool bootPending = true;      /* BOOT flag rides on the first *transmitted* packet */
static uint32_t pairingPasskey = 0;
static adc_oneshot_unit_handle_t adcHandle = NULL;
static adc_cali_handle_t adcCaliHandle = NULL;
static bool adcReady = false;

class PairingCb : public BLESecurityCallbacks {
    void onPassKeyNotify(uint32_t passkey) override {
        Serial.printf("BLE pairing passkey: %06lu\n", (unsigned long)passkey);
    }
};

static const sltp_channel_info_t CHANNELS[2] = {
    { "adc_sum16", "count", "0.0625", "0" },      /* sum of 16 raw ADC counts; x 0.0625 = mean counts */
    { "resistance", "\xCE\xA9", "0.01", "0" },     /* centi-ohm; UTF-8 "Ω" */
};

/* INFO JSON via sltp_build_info, which is host-tested and parsed by the app's real parser (npm run test:firmware). */
static void buildInfo(char *buf, size_t len) {
    sltp_info_t info = { FW_VERSION, serial, MODEL, periodUs, streaming ? 1 : 0, lastCtrlErr, bootNonce, 2, CHANNELS };
    if (sltp_build_info(buf, len, &info) < 0) snprintf(buf, len, "{\"p\":1,\"err\":255}"); /* cannot happen at 300 B (worst case 206 B); would fail loudly in the app */
}

/* One raw ADC conversion is calibrated from that same raw count. This avoids
 * pairing a raw aggregate with a second, unrelated batch of conversions. */
static bool initAdc() {
    adc_oneshot_unit_init_cfg_t unitCfg = { .unit_id = ADC_UNIT_1, .ulp_mode = ADC_ULP_MODE_DISABLE };
    adc_oneshot_chan_cfg_t channelCfg = { .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_12 };
    if (adc_oneshot_new_unit(&unitCfg, &adcHandle) != ESP_OK) return false;
    if (adc_oneshot_config_channel(adcHandle, ADC_CHANNEL_4, &channelCfg) != ESP_OK) return false;
#if ADC_CALI_SCHEME_CURVE_FITTING_SUPPORTED
    adc_cali_curve_fitting_config_t calCfg = { .unit_id = ADC_UNIT_1, .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_12 };
    if (adc_cali_create_scheme_curve_fitting(&calCfg, &adcCaliHandle) != ESP_OK) return false;
#elif ADC_CALI_SCHEME_LINE_FITTING_SUPPORTED
    adc_cali_line_fitting_config_t calCfg = { .unit_id = ADC_UNIT_1, .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_12 };
    if (adc_cali_create_scheme_line_fitting(&calCfg, &adcCaliHandle) != ESP_OK) return false;
#else
    return false;
#endif
    return true;
}

class ServerCb : public BLEServerCallbacks {
    void onConnect(BLEServer *) override { connected = true; }
    void onDisconnect(BLEServer *s) override { connected = false; s->getAdvertising()->start(); }
};

class InfoCb : public BLECharacteristicCallbacks {
    void onRead(BLECharacteristic *c) override {
        char buf[300];
        buildInfo(buf, sizeof buf);
        c->setValue((uint8_t *)buf, strlen(buf));
    }
};

class CtrlCb : public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *c) override {
        sltp_control_t cmd;
        uint8_t *d = c->getData();
        size_t n = c->getLength();
        int rc = sltp_decode_control(d, n, &cmd);
        lastCtrlErr = rc;
        if (rc != SLTP_OK) return;
        if (cmd.opcode == SLTP_OP_STREAM_START) streaming = true;
        else if (cmd.opcode == SLTP_OP_STREAM_STOP) streaming = false;
        else if (cmd.opcode == SLTP_OP_SET_PERIOD) periodUs = cmd.period_us;  /* sequence continues */
    }
};

void setup() {
    Serial.begin(115200);
    uint8_t mac[6];
    esp_efuse_mac_get_default(mac);
    snprintf(serial, sizeof serial, "%02X%02X%02X%02X%02X%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    bootNonce = esp_random();
    pairingPasskey = 100000u + (esp_random() % 900000u);
    char name[16];
    snprintf(name, sizeof name, "SLab-%02X%02X", mac[4], mac[5]);

    adcReady = initAdc();
    BLEDevice::init(name);
    BLESecurity::setPassKey(true, pairingPasskey);
    BLESecurity::setCapability(ESP_IO_CAP_OUT);
    BLESecurity::setAuthenticationMode(true, true, true);
    BLESecurity::setForceAuthentication(true);
    BLEDevice::setSecurityCallbacks(new PairingCb());
    Serial.printf("SensorLab BLE device: %s\n", name);
    Serial.printf("BLE pairing passkey: %06lu\n", (unsigned long)pairingPasskey);

    BLEServer *server = BLEDevice::createServer();
    server->setCallbacks(new ServerCb());
    BLEService *svc = server->createService(SVC_UUID);
    dataChar = svc->createCharacteristic(DATA_UUID,
        BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_READ_AUTHEN | BLECharacteristic::PROPERTY_NOTIFY);
#if !defined(CONFIG_NIMBLE_ENABLED)
    dataChar->addDescriptor(new BLE2902());   // Bluedroid (core 2.x / classic ESP32): CCCD must be added manually
    dataChar->setAccessPermissions(ESP_GATT_PERM_READ_ENC_MITM);
#endif                                        // NimBLE (core 3.x on ESP32-C3): CCCD is added automatically for NOTIFY
    infoChar = svc->createCharacteristic(INFO_UUID,
        BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_READ_AUTHEN);
#if !defined(CONFIG_NIMBLE_ENABLED)
    infoChar->setAccessPermissions(ESP_GATT_PERM_READ_ENC_MITM);
#endif
    infoChar->setCallbacks(new InfoCb());
    BLECharacteristic *ctrl = svc->createCharacteristic(CTRL_UUID,
        BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_AUTHEN);
#if !defined(CONFIG_NIMBLE_ENABLED)
    ctrl->setAccessPermissions(ESP_GATT_PERM_WRITE_ENC_MITM);
#endif
    ctrl->setCallbacks(new CtrlCb());
    svc->start();
    BLEAdvertising *adv = BLEDevice::getAdvertising();
    adv->addServiceUUID(SVC_UUID);
    adv->setScanResponse(true);
    BLEDevice::startAdvertising();
    nextSlotUs = esp_timer_get_time() + periodUs;
}

void loop() {
    int64_t now = esp_timer_get_time();
    if (now < nextSlotUs) return;   /* non-blocking: no delay() in the sampling path */

    uint32_t missed = sltp_advance_slot(now, &nextSlotUs, periodUs);   /* host-tested slot arithmetic */
    sequence += missed;   /* skipped slots are counted, never hidden */

    int32_t sum = 0;
    uint32_t sumMilliVolts = 0;
    bool adcFault = !adcReady;
    for (int i = 0; i < ADC_SAMPLES; i++) {
        int raw = 0;
        int millivolts = 0;
        /* ADC_CHANNEL_4 is D2/A2/GPIO4. Calibrate this exact conversion, not a
         * second sample, so adc_sum16 and resistance have the same provenance. */
        if (adcFault || adc_oneshot_read(adcHandle, ADC_CHANNEL_4, &raw) != ESP_OK ||
            adc_cali_raw_to_voltage(adcCaliHandle, raw, &millivolts) != ESP_OK) {
            adcFault = true;
            continue;
        }
        sum += raw;
        sumMilliVolts += millivolts;
        if (raw < 0 || raw > 4095 || millivolts < 0 || millivolts > ADC_ABSOLUTE_MAX_MV) adcFault = true;
    }
    uint32_t t = (uint32_t)esp_timer_get_time();   /* timestamp right after conversion; wraps every ~71.6 min */

    /* Do not infer OPEN_CIRCUIT from invalidity: an invalid result means only that
     * calibrated resistance cannot be reported under the current v1 protocol. */
    divider_measurement_t measurement = divider_measurement_from_mv(
        sumMilliVolts, ADC_SAMPLES, adcFault, ADC_MAX_VALID_MV, R_REF_OHM, V_SUPPLY);

    sltp_sample_t s;
    memset(&s, 0, sizeof s);
    s.sequence = sequence++;
    s.device_time_us = t;
    s.channel_count = 2;
    s.values[0] = sum;
    s.values[1] = measurement.resistance_centiohm;
    /* Raw ADC aggregate is retained even when the derived resistance is invalid. */
    s.valid_mask = (measurement.raw_valid ? 0x01 : 0x00) |
        (measurement.resistance_valid ? 0x02 : 0x00);

    if (connected && streaming) {
        s.flags = (bootPending ? SLTP_FLAG_BOOT : 0) |
            (missed > 0 ? SLTP_FLAG_DEVICE_OVERRUN : 0) |
            (measurement.sensor_fault ? SLTP_FLAG_SENSOR_FAULT : 0);
        uint8_t buf[SLTP_MAX_PACKET_LEN];
        size_t n = sltp_encode_data(&s, buf, sizeof buf);
        if (n > 0) {
            dataChar->setValue(buf, n);
            dataChar->notify();   /* Bluedroid notify() does not report queue-full; losses show as host-side gaps */
            bootPending = false;
        }
    }
}
