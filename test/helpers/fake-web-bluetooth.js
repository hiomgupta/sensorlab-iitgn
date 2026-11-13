/**
 * Mock of the W3C Web Bluetooth API surface used by src/transport/web-bluetooth.js
 * (BluetoothDevice, BluetoothRemoteGATTServer/Service/Characteristic, events).
 * It exercises the real driver code. It is NOT a radio or OS-stack test.
 *
 * Mimics behaviours relevant to the driver:
 *  - every connection yields NEW service/characteristic objects; objects from a previous
 *    connection never fire again (Chrome invalidates attributes on disconnect)
 *  - notification values are DataViews into a LARGER buffer at a non-zero offset
 *  - 'gattserverdisconnected' fires on the device on link loss and on gatt.disconnect()
 */
import { encodeDataPacket, encodeDeviceInfo, decodeControl, UUIDS } from '../../src/protocol/sltp.js';

class FakeCharacteristic extends EventTarget {
    constructor(peripheral, uuid, properties, gen) {
        super();
        this.peripheral = peripheral; this.uuid = uuid; this.properties = properties; this._gen = gen;
        this.value = null; this.notifying = false; this.listenerCount = 0;
    }
    addEventListener(t, fn, o) { if (t === 'characteristicvaluechanged') this.listenerCount++; return super.addEventListener(t, fn, o); }
    removeEventListener(t, fn, o) { if (t === 'characteristicvaluechanged') this.listenerCount--; return super.removeEventListener(t, fn, o); }
    _alive() { return this.peripheral.connected && this._gen === this.peripheral.gen; }
    async readValue() {
        if (!this._alive()) throw new DOMException('GATT Server is disconnected.', 'NetworkError');
        const bytes = this.peripheral.readHandler(this.uuid);
        return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    async writeValueWithResponse(bytes) {
        if (!this._alive()) throw new DOMException('GATT Server is disconnected.', 'NetworkError');
        this.peripheral.writeHandler(this.uuid, new Uint8Array(bytes));
    }
    async startNotifications() {
        if (!this._alive()) throw new DOMException('GATT Server is disconnected.', 'NetworkError');
        if (!this.properties.notify) throw new DOMException('not supported', 'NotSupportedError');
        if (this.peripheral.failSubscribe) throw new DOMException('GATT operation failed for unknown reason.', 'NetworkError');
        this.notifying = true; this.peripheral.subscribed.add(this); return this;
    }
    async stopNotifications() { this.notifying = false; this.peripheral.subscribed.delete(this); return this; }
    _notify(bytes) {
        if (!this._alive() || !this.notifying) return;
        const big = new Uint8Array(bytes.length + 9);   // value is a view into a larger buffer
        big.set(bytes, 5);
        this.value = new DataView(big.buffer, 5, bytes.length);
        this.dispatchEvent(new Event('characteristicvaluechanged'));
        big.fill(0xee); // Chrome may reuse the buffer afterwards: the driver must have copied it
    }
}

class FakeService {
    constructor(peripheral, uuid, gen) { this.peripheral = peripheral; this.uuid = uuid; this._gen = gen; }
    async getCharacteristic(uuid) {
        const props = this.peripheral.chars[uuid];
        if (!props) throw new DOMException('No Characteristics matching UUID', 'NotFoundError');
        const c = new FakeCharacteristic(this.peripheral, uuid, props, this._gen);
        this.peripheral.liveChars.push(c);
        return c;
    }
    async getCharacteristics() { return Promise.all(Object.keys(this.peripheral.chars).map(u => this.getCharacteristic(u))); }
}

export class FakePeripheral {
    /** SLTP v1 peripheral with 2 channels. */
    constructor({ id = 'FAKEID==', name = 'SLab-FAKE', serial = 'FAKE0001', model = 'FAKE', clock, periodUs = 50_000 }) {
        this.clock = clock; this.periodUs = periodUs; this.serial = serial; this.model = model;
        this.connected = false; this.gen = 0; this.sequence = 0; this.bootId = 77; this.subscribed = new Set();
        this.liveChars = []; this.connectCalls = 0; this.failConnects = 0; this.silent = false; this.invalid = false; this.invalidChannels = null;
        this.chars = { [UUIDS.data]: { notify: true }, [UUIDS.info]: { read: true }, [UUIDS.control]: { write: true } };
        this.device = new FakeBluetoothDevice(this, id, name);
        this._tick();
    }
    readHandler(uuid) {
        if (uuid !== UUIDS.info) return new Uint8Array(0);
        return encodeDeviceInfo({ firmware: 'fake-1', serial: this.serial, model: this.model, periodUs: this.periodUs, streaming: true, lastError: 0, bootId: this.bootId,
            channels: this.model === 'SLab-R1'
                ? [{ name: 'adc_sum16', unit: 'count', scale: 0.0625, offset: 0 }, { name: 'resistance', unit: 'Ω', scale: 0.01, offset: 0 }]
                : [{ name: 'strain', unit: 'µε', scale: 0.1, offset: 0 }, { name: 'temp', unit: '°C', scale: 0.01, offset: 0 }] });
    }
    writeHandler(uuid, bytes) { const c = decodeControl(bytes); if (c.err === 0 && c.periodUs) this.periodUs = c.periodUs; }
    /** sample continuously (sequence advances whether or not connected), notify subscribers */
    _tick() {
        this.clock.setTimeout(() => {
            const seq = this.sequence++;
            const valid = this.invalid ? [false, false] : (this.invalidChannels || [true, true]);
            const pkt = encodeDataPacket({ sequence: seq, deviceTimeUs: (seq * this.periodUs) % 2 ** 32, flags: 0, values: [seq, 2500 + seq], valid });
            if (!this.silent) for (const c of [...this.subscribed]) c._notify(pkt); // silent: samples (and sequence) continue, nothing is sent
            this._tick();
        }, this.periodUs / 1000);
    }
    /** Deliver raw packets now (scripted streams). Several calls in one tick model a BLE connection-event burst. */
    sendRaw(bytes) { for (const c of [...this.subscribed]) c._notify(bytes); }
    totalListeners() { return this.liveChars.reduce((a, c) => a + c.listenerCount, 0); }

    linkLoss() { if (!this.connected) return; this.connected = false; this.subscribed.clear(); this.device.dispatchEvent(new Event('gattserverdisconnected')); }
}

class FakeGattServer {
    constructor(p) { this.p = p; this.device = p.device; }
    get connected() { return this.p.connected; }
    async connect() {
        this.p.connectCalls++;
        if (this.p.failConnects > 0) { this.p.failConnects--; throw new DOMException('Connection failed for unknown reason.', 'NetworkError'); }
        if (!this.p.connected) { this.p.connected = true; this.p.gen++; }
        return this;
    }
    disconnect() { this.p.linkLoss(); }
    async getPrimaryService(uuid) {
        if (!this.p.connected) throw new DOMException('GATT Server is disconnected.', 'NetworkError');
        if (uuid !== UUIDS.service || this.p.noService) throw new DOMException(`No Services matching UUID ${uuid} found in Device.`, 'NotFoundError');
        return new FakeService(this.p, uuid, this.p.gen);
    }
    async getPrimaryServices() { return [await this.getPrimaryService(UUIDS.service)]; }
}

class FakeBluetoothDevice extends EventTarget {
    constructor(p, id, name) { super(); this.id = id; this.name = name; this.gatt = new FakeGattServer(p); }
}

/** Install navigator.bluetooth whose requestDevice resolves to the given peripheral's device. */
export function installFakeNavigatorBluetooth(peripherals, { denyWith = null } = {}) {
    const queue = [...peripherals];
    const bt = {
        lastOptions: null,
        async getAvailability() { return true; },
        async requestDevice(opts) {
            bt.lastOptions = opts;
            if (denyWith) throw new DOMException(denyWith.message, denyWith.name);
            const p = queue.shift();
            if (!p) throw new DOMException('User cancelled the requestDevice() chooser.', 'NotFoundError');
            return p.device;
        },
    };
    Object.defineProperty(globalThis, 'navigator', { value: { ...(globalThis.navigator || {}), bluetooth: bt }, configurable: true, writable: true });
    return bt;
}
