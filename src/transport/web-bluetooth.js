/**
 * Web Bluetooth transport driver (Layer 1).
 * It exposes raw bytes, host receipt times and lifecycle events only. It does no parsing, no unit
 * conversion and no storage, and it keeps no state that outlives a connection: every
 * getCharacteristic() call after a reconnect rediscovers fresh GATT objects (baseline defect D8).
 *
 * Transport device interface (implemented here and by SimulatedDevice):
 *   transportId, name, kind
 *   connected: boolean
 *   connect(): Promise<void>
 *   getCharacteristic(serviceUuid, charUuid): Promise<{read(), write(bytes), subscribe(onBytes) -> Promise<unsubscribe>}>
 *   listServices(): Promise<[{serviceUuid, characteristics:[{uuid, properties}]}]>
 *   disconnect(): void
 *   onDisconnect(cb): () => void   (returns an unsubscribe function)
 *   dispose(): void
 */
import { realClock } from '../util/clock.js';

export class WebBluetoothTransport {
    constructor({ clock = realClock } = {}) { this.clock = clock; this.kind = 'webbluetooth'; }

    static isSupported() { return typeof navigator !== 'undefined' && !!navigator.bluetooth; }

    static async isAvailable() {
        if (!WebBluetoothTransport.isSupported()) return false;
        try { return await navigator.bluetooth.getAvailability(); } catch { return false; }
    }

    /** Must be called from a user gesture. Opens the browser's device chooser. */
    async requestDevice(options) {
        const d = await navigator.bluetooth.requestDevice(options);
        return new WebBluetoothDevice(d, this.clock);
    }
}

function copyBytes(dv) {
    // Copy exactly this DataView's bytes. Chrome may reuse or detach the underlying buffer.
    return new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
}

class WebBluetoothCharacteristic {
    constructor(c, clock) { this._c = c; this._clock = clock; this.uuid = c.uuid; this.properties = c.properties; }

    async read() { return copyBytes(await this._c.readValue()); }

    async write(bytes) {
        if (this._c.writeValueWithResponse) await this._c.writeValueWithResponse(bytes);
        else if (this._c.writeValueWithoutResponse) await this._c.writeValueWithoutResponse(bytes);
        else await this._c.writeValue(bytes);
    }

    async subscribe(onBytes) {
        const handler = (ev) => {
            const hostMs = this._clock.now(); // receipt time, taken before any processing
            onBytes(copyBytes(ev.target.value), hostMs);
        };
        this._c.addEventListener('characteristicvaluechanged', handler);
        try {
            await this._c.startNotifications();
        } catch (e) {
            this._c.removeEventListener('characteristicvaluechanged', handler);
            throw e;
        }
        let active = true;
        return async () => {
            if (!active) return;
            active = false;
            this._c.removeEventListener('characteristicvaluechanged', handler);
            try { await this._c.stopNotifications(); } catch { /* already disconnected */ }
        };
    }
}

export class WebBluetoothDevice {
    constructor(device, clock) {
        this._d = device;
        this._clock = clock;
        this.kind = 'webbluetooth';
        this.transportId = 'webbt:' + device.id;
        this.name = device.name || null;
        this._cbs = new Set();
        this._onDisc = () => { for (const cb of [...this._cbs]) { try { cb(); } catch { /* isolate listeners */ } } };
        device.addEventListener('gattserverdisconnected', this._onDisc);
    }

    get connected() { return !!this._d.gatt?.connected; }

    async connect() { await this._d.gatt.connect(); }

    async getCharacteristic(serviceUuid, charUuid) {
        const svc = await this._d.gatt.getPrimaryService(serviceUuid);
        const c = await svc.getCharacteristic(charUuid);
        return new WebBluetoothCharacteristic(c, this._clock);
    }

    async listServices() {
        for (let attempt = 0; attempt < 2; attempt++) {
            if (!this.connected) await this.connect();
            try {
                return await this._listServices();
            } catch (error) {
                if (attempt || this.connected) throw error;
            }
        }
        throw new Error('Could not reconnect to the GATT server to list services.');
    }

    async _listServices() {
        const out = [];
        const services = await this._d.gatt.getPrimaryServices();
        for (const s of services) {
            let chars = [];
            try { chars = await s.getCharacteristics(); } catch { /* service without accessible characteristics */ }
            out.push({
                serviceUuid: s.uuid,
                characteristics: chars.map(c => ({
                    uuid: c.uuid,
                    properties: {
                        read: !!c.properties.read, write: !!c.properties.write,
                        writeWithoutResponse: !!c.properties.writeWithoutResponse,
                        notify: !!c.properties.notify, indicate: !!c.properties.indicate,
                    },
                })),
            });
        }
        return out;
    }

    disconnect() { try { if (this._d.gatt?.connected) this._d.gatt.disconnect(); } catch { /* ignore */ } }

    onDisconnect(cb) { this._cbs.add(cb); return () => this._cbs.delete(cb); }

    dispose() {
        this._d.removeEventListener('gattserverdisconnected', this._onDisc);
        this._cbs.clear();
    }
}
