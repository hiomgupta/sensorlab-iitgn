/*
 * SensorLab legacy firmware (v1 text-float protocol).
 *
 * This preserves the laboratory's earlier acquisition model for comparison with
 * the SLTP v2 firmware. It is intentionally a separate sketch: it advertises
 * the legacy Nordic-UART-style UUIDs and sends one UTF-8 text resistance value.
 *
 * Connect this firmware in SensorLab with:
 *   Legacy & standard -> SensorLab ESP32 (legacy text)
 * Do NOT select SensorLab v2 (SLTP); its UUIDs and binary packet format differ.
 *
 * Hardware wiring (fixed for this sketch): 3V3 -- 10.8kΩ -- D2/A2 -- JST pin 1,
 * and JST pin 2 -- GND. The external resistance is therefore the lower leg:
 * R_external = R_FIXED × Vout / (V_IN - Vout).
 */
#include <Arduino.h>
#include <Wire.h>
#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEServer.h>
#include <BLE2902.h>

// XIAO ESP32-C3 D2 is A2 / GPIO4 / ADC1_CH4. The sensor output is wired to D2.
#define SENSOR_PIN A2
#define R_FIXED_OHM 10800.0f
#define V_IN_VOLTS 3.3f
#define ADC_SAMPLES 16
// ESP32-C3 calibrated ADC range at 11 dB attenuation is approximately 0–2.5 V.
// Above this, report the legacy open-circuit sentinel rather than a false resistance.
#define ADC_MAX_VALID_MV 2450u

#define SERVICE_UUID        "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"

BLEServer* pServer = NULL;
BLECharacteristic* pCharacteristic = NULL;
bool deviceConnected = false;

class MyServerCallbacks : public BLEServerCallbacks {
    void onConnect(BLEServer*) override {
        deviceConnected = true;
        Serial.println("BLE Client Connected.");
    }

    void onDisconnect(BLEServer* pServer) override {
        deviceConnected = false;
        Serial.println("BLE Client Disconnected. Restarting Advertisement...");
        pServer->getAdvertising()->start();
    }
};

void setup() {
    Serial.begin(115200);
    analogReadResolution(12);
    analogSetPinAttenuation(SENSOR_PIN, ADC_11db);
    Serial.println("Starting legacy BLE firmware: D2/A2 divider input.");

    BLEDevice::init("Phyphox");
    pServer = BLEDevice::createServer();
    pServer->setCallbacks(new MyServerCallbacks());

    BLEService* pService = pServer->createService(SERVICE_UUID);
    pCharacteristic = pService->createCharacteristic(
        CHARACTERISTIC_UUID,
        BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
    );
    pCharacteristic->addDescriptor(new BLE2902());
    pService->start();

    BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
    pAdvertising->addServiceUUID(SERVICE_UUID);
    pServer->getAdvertising()->start();
    Serial.println("Legacy BLE service started. Waiting for connection...");
}

void loop() {
    if (deviceConnected) {
        uint32_t sumMilliVolts = 0;
        for (int i = 0; i < ADC_SAMPLES; i++) {
            sumMilliVolts += analogReadMilliVolts(SENSOR_PIN);
        }
        const uint32_t meanMilliVolts = sumMilliVolts / ADC_SAMPLES;
        const float V_out = meanMilliVolts / 1000.0f;

        float R_s;
        if (meanMilliVolts > ADC_MAX_VALID_MV || V_out >= (V_IN_VOLTS - 0.01f)) {
            R_s = 1e6f;
        } else {
            R_s = R_FIXED_OHM * (V_out / (V_IN_VOLTS - V_out));
        }

        Serial.print("D2/A2 mean input: ");
        Serial.print(meanMilliVolts);
        Serial.print(" mV | Measured Resistance: ");
        Serial.print(R_s);
        Serial.println(" ohms");

        // 16 bytes safely holds the historical 1,000,000.00 sentinel plus NUL.
        char resistanceStr[16];
        dtostrf(R_s, 8, 2, resistanceStr);
        pCharacteristic->setValue(resistanceStr);
        pCharacteristic->notify();
        delay(200);
    }
}
