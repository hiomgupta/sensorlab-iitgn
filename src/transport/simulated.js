/**
 * Deterministic simulated transport. It is a demo-mode product feature and the test harness.
 * Virtual devices speak real SLTP v1 bytes (or a legacy text format) through the same parser
 * and pipeline as real hardware. Every reading from here is flagged SIMULATED downstream.
 *
 * It validates APPLICATION LOGIC ONLY. It says nothing about RF or OS BLE-stack behaviour.
 */
import { encodeDataPacket, encodeDeviceInfo, decodeControl, UUIDS, OPCODES } from '../protocol/sltp.js';
import { seededRandom } from '../util/clock.js';

const U32 = 2 ** 32;

export const SIGNALS = ['sine', 'square', 'ramp', 'constant', 'step', 'noise'];

function signalValue(sig, tS, rnd) {
    const { type = 'sine', amplitude = 1, freqHz = 0.5, offset = 0, stepAtS = 5 } = sig;
    const ph = tS * freqHz;
    switch (type) {
        case 'square': return offset + (ph % 1 < 0.5 ? amplitude : -amplitude);
        case 'ramp': return offset + amplitude * (2 * (ph % 1) - 1);
        case 'constant': return offset;
        case 'step': return offset + (tS >= stepAtS ? amplitude : 0);
        case 'noise': return offset + amplitude * (rnd() * 2 - 1);
        default: return offset + amplitude * Math.sin(2 * Math.PI * ph);
    }
}

export const DEFAULT_FAULTS = Object.freeze({
    dropProb: 0,            // notification lost in transit (sequence still advances → host gap)
    duplicateProb: 0,       // notification delivered twice
    reorderProb: 0,         // notification held back and delivered after the next one
    malformedProb: 0,       // truncated packet
    badVersionProb: 0,      // unsupported protocol version byte
    invalidChannelProb: 0,  // channel valid bit cleared
    deliveryJitterMs: 0,    // extra random delivery delay (host receipt jitter)
    silent: false,          // connected but no notifications (stalled stream)
    connectFailures: 0,     // number of upcoming connect() calls that fail
    connectHang: false,     // connect() never resolves (exercises the watchdog)
    infoMalformed: false,   // INFO returns invalid JSON
});

export class SimulatedDevice {
    /**
     * @param spec {serial, name, periodUs, channels:[{name,unit,scale,offset,signal}], clockDriftPpm,
     *              startDeviceTimeUs, legacyFormat?, faults?}
     */
    constructor(spec, clock, seed = 1) {
        this.spec = spec;
        this.clock = clock;
        this.kind = 'simulated';
        this.transportId = 'sim:' + spec.serial;
        this.name = spec.name || ('SIM-' + spec.serial);
        this.rnd = seededRandom(seed);
        this.faults = { ...DEFAULT_FAULTS, ...(spec.faults || {}) };
        this.periodUs = spec.periodUs || 100_000;
        this.streaming = true;
        this.lastCtrlErr = 0;
        this.bootId = Math.floor(this.rnd() * U32);
        this._connected = false;
        this._subs = new Set();
        this._discCbs = new Set();
        this._held = null;
        this.stats = { sent: 0, dropped: 0, duplicated: 0, reordered: 0, malformed: 0, sampled: 0 };
        this._powerOn();
    }

    _powerOn() {
        this.sequence = 0;
        this.bootPending = true;
        this.bootMonoMs = this.clock.now();
        this._nextSlotMs = this.clock.now() + this.periodUs / 1000;
        this._schedule();
    }

    _deviceTimeUs() {
        const elapsedUs = (this.clock.now() - this.bootMonoMs) * 1000 * (1 + (this.spec.clockDriftPpm || 0) / 1e6);
        return Math.floor((this.spec.startDeviceTimeUs || 0) + elapsedUs) % U32;
    }

    _schedule() {
        if (this._off) return;
        const delay = Math.max(0, this._nextSlotMs - this.clock.now());
        this._timer = this.clock.setTimeout(() => this._sample(), delay);
    }

    _sample() {
        this._nextSlotMs += this.periodUs / 1000;
        const seq = this.sequence;
        this.sequence = (this.sequence + 1) % U32;
        this.stats.sampled++;
        const tS = (this.clock.now() - this.bootMonoMs) / 1000;
        const chans = this.spec.channels;
        const eng = chans.map(c => signalValue(c.signal || {}, tS, this.rnd));
        if (this._connected && this.streaming && !this.faults.silent && this._subs.size > 0) {
            this._emit(seq, eng);
        }
        this._schedule();
    }

    _emit(seq, eng) {
        const f = this.faults, r = this.rnd;
        let bytes;
        if (this.spec.legacyFormat === 'text-float') {
            bytes = new TextEncoder().encode(eng[0].toFixed(4));
        } else if (this.spec.legacyFormat === 'text-csv') {
            bytes = new TextEncoder().encode(eng.map(v => v.toFixed(4)).join(','));
        } else {
            const chans = this.spec.channels;
            const values = eng.map((v, i) => Math.round((v - (chans[i].offset || 0)) / chans[i].scale));
            const valid = values.map(() => !(r() < f.invalidChannelProb));
            bytes = encodeDataPacket({
                sequence: seq, deviceTimeUs: this._deviceTimeUs(),
                flags: this.bootPending ? 0x01 : 0, values, valid,
            });
            this.bootPending = false;
        }
        // Fault decisions are mutually exclusive so injected counts are exact test oracles.
        if (r() < f.dropProb) { this.stats.dropped++; return; }
        let bad = false;
        if (!this.spec.legacyFormat) {
            if (r() < f.malformedProb) { bytes = bytes.slice(0, bytes.length - 3); bad = true; }
            else if (r() < f.badVersionProb) { bytes[0] = 9; bad = true; }
        }
        if (bad) { this.stats.malformed++; this._deliver(bytes); this._releaseHeld(); return; }
        if (!this._held && r() < f.reorderProb) { this._held = bytes; this.stats.reordered++; return; }
        const copies = r() < f.duplicateProb ? 2 : 1;
        if (copies === 2) this.stats.duplicated++;
        for (let k = 0; k < copies; k++) this._deliver(bytes);
        this._releaseHeld();
    }

    _releaseHeld() { if (this._held) { const h = this._held; this._held = null; this._deliver(h); } }

    _deliver(bytes) {
        const jitter = this.faults.deliveryJitterMs ? this.rnd() * this.faults.deliveryJitterMs : 0;
        const doIt = () => {
            if (!this._connected) return;
            const host = this.clock.now();
            for (const s of [...this._subs]) s(bytes.slice(), host);
            this.stats.sent++;
        };
        if (jitter > 0) this.clock.setTimeout(doIt, jitter); else doIt();
    }

    // ── transport device interface ──
    get connected() { return this._connected; }

    async connect() {
        if (this._off) throw new Error('device not advertising (powered off)');
        if (this.faults.connectHang) return new Promise(() => {});
        if (this.faults.connectFailures > 0) { this.faults.connectFailures--; throw new Error('simulated connect failure'); }
        this._connected = true;
    }

    async getCharacteristic(serviceUuid, charUuid) {
        if (!this._connected) throw new Error('GATT not connected');
        const dev = this;
        if (this.spec.legacyFormat) {
            return { uuid: charUuid, read: async () => new Uint8Array(0), write: async () => {}, subscribe: (cb) => dev._subscribe(cb) };
        }
        if (serviceUuid !== UUIDS.service) throw new Error('service not found');
        if (charUuid === UUIDS.data) return { uuid: charUuid, subscribe: (cb) => dev._subscribe(cb) };
        if (charUuid === UUIDS.info) {
            return {
                uuid: charUuid,
                read: async () => {
                    if (!dev._connected) throw new Error('GATT not connected');
                    if (dev.faults.infoMalformed) return new TextEncoder().encode('{"p":1,');
                    return encodeDeviceInfo({
                        firmware: 'sim-1.0', serial: dev.spec.serial, model: 'SIMULATOR', periodUs: dev.periodUs,
                        streaming: dev.streaming, lastError: dev.lastCtrlErr, bootId: dev.bootId,
                        channels: dev.spec.channels.map(c => ({ name: c.name, unit: c.unit, scale: c.scale, offset: c.offset || 0 })),
                    });
                },
            };
        }
        if (charUuid === UUIDS.control) {
            return {
                uuid: charUuid,
                write: async (bytes) => {
                    if (!dev._connected) throw new Error('GATT not connected');
                    const c = decodeControl(bytes);
                    dev.lastCtrlErr = c.err;
                    if (c.err) return;
                    if (c.op === OPCODES.STREAM_START) dev.streaming = true;
                    else if (c.op === OPCODES.STREAM_STOP) dev.streaming = false;
                    else if (c.op === OPCODES.SET_PERIOD) dev.periodUs = c.periodUs;
                },
            };
        }
        throw new Error('characteristic not found');
    }

    async _subscribe(cb) {
        if (!this._connected) throw new Error('GATT not connected');
        this._subs.add(cb);
        return async () => { this._subs.delete(cb); };
    }

    async listServices() {
        if (this.spec.legacyFormat) return [];
        return [{ serviceUuid: UUIDS.service, characteristics: [
            { uuid: UUIDS.data, properties: { notify: true } },
            { uuid: UUIDS.info, properties: { read: true } },
            { uuid: UUIDS.control, properties: { write: true } },
        ] }];
    }

    disconnect() { this._drop(); }

    onDisconnect(cb) { this._discCbs.add(cb); return () => this._discCbs.delete(cb); }

    dispose() { this._discCbs.clear(); }

    _drop() {
        if (!this._connected) return;
        this._connected = false;
        this._subs.clear();
        this._held = null;
        for (const cb of [...this._discCbs]) { try { cb(); } catch { /* isolate */ } }
    }

    // ── fault injection ──
    /** Link loss initiated by the "radio" side. */
    forceDisconnect() { this._drop(); }
    /** Reboot: sequence and clock restart, new boot nonce. */
    reboot() {
        this._drop();
        this.clock.clearTimeout(this._timer);
        this.bootId = Math.floor(this.rnd() * U32);
        this._powerOn();
    }
    powerOff() { this._drop(); this._off = true; this.clock.clearTimeout(this._timer); }
    powerOn() { if (!this._off) return; this._off = false; this.bootId = Math.floor(this.rnd() * U32); this._powerOn(); }
    setFaults(f) { Object.assign(this.faults, f); }
}

export class SimulatedTransport {
    constructor({ clock, seed = 7 } = {}) {
        this.clock = clock;
        this.kind = 'simulated';
        this._seed = seed;
        this.devices = new Map();
    }

    /** Create or return a virtual device (no chooser). */
    addDevice(spec) {
        if (!this.devices.has(spec.serial)) this.devices.set(spec.serial, new SimulatedDevice(spec, this.clock, this._seed + this.devices.size * 101));
        return this.devices.get(spec.serial);
    }

    async requestDevice({ serial } = {}) {
        const d = serial ? this.devices.get(serial) : [...this.devices.values()].find(x => !x.connected);
        if (!d) throw new Error('no simulated device available');
        return d;
    }

    stopAll() { for (const d of this.devices.values()) d.powerOff(); }
}

/** A ready-made demo fleet: varied signals, units and rates. */
export function demoFleetSpecs(count = 3, rateHz = 10) {
    const presets = [
        { name: 'strain', unit: 'µε', scale: 0.1, signal: { type: 'sine', amplitude: 250, freqHz: 0.2 } },
        { name: 'temperature', unit: '°C', scale: 0.01, signal: { type: 'ramp', amplitude: 2, freqHz: 0.02, offset: 24 } },
        { name: 'resistance', unit: 'Ω', scale: 0.01, signal: { type: 'step', amplitude: 120, offset: 4520, stepAtS: 8 } },
        { name: 'voltage', unit: 'V', scale: 0.001, signal: { type: 'square', amplitude: 1.2, freqHz: 0.25, offset: 1.65 } },
    ];
    const out = [];
    for (let i = 0; i < count; i++) {
        const a = presets[i % presets.length], b = presets[(i + 1) % presets.length];
        out.push({
            serial: `SIM${String(i + 1).padStart(4, '0')}`,
            name: `SIM-${String(i + 1).padStart(2, '0')}`,
            periodUs: Math.round(1e6 / rateHz),
            clockDriftPpm: (i - 1) * 20,
            channels: [a, b].map(c => ({ name: c.name, unit: c.unit, scale: c.scale, offset: 0, signal: c.signal })),
        });
    }
    return out;
}
