/**
 * BLEManager — Universal multi-device BLE manager
 * With auto-reconnect, visibility-change detection, and calibration support.
 */
class BLEManager {
    constructor() {
        this.devices = new Map();
        this.listeners = new Map();
        this._handlers = new Map();  // deviceId -> { fn, active } — one handler per device, never duplicated
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 2000;
        this.colorPalette = [
            '#60a5fa','#4ade80','#fbbf24','#f87171',
            '#c084fc','#22d3ee','#fb923c','#a1a1aa',
            '#818cf8','#f472b6'
        ];
        this.colorIndex = 0;
        this._setupVisibilityWatch();
    }

    static isSupported() { return !!(navigator.bluetooth); }

    on(event, cb) {
        if (!this.listeners.has(event)) this.listeners.set(event, []);
        this.listeners.get(event).push(cb);
    }
    _emit(event, data) { (this.listeners.get(event) || []).forEach(cb => cb(data)); }

    _nextColor() {
        const c = this.colorPalette[this.colorIndex % this.colorPalette.length];
        this.colorIndex++;
        return c;
    }

    // ── Tab visibility / sleep detection ──
    _setupVisibilityWatch() {
        document.addEventListener('visibilitychange', () => {
            if (document.hidden && this.connectedCount > 0) {
                this._emit('tabHidden', { count: this.connectedCount });
            }
            if (!document.hidden) {
                // Check if any devices silently disconnected while hidden
                for (const [id, entry] of this.devices) {
                    if (entry.characteristic && !entry.server?.connected) {
                        this._emit('disconnected', { deviceId: id, name: entry.name });
                        this._onDisconnected(id);
                    }
                }
            }
        });
    }

    async connectWithUUIDs(config) {
        const { serviceUUID, characteristicUUID, dataFormat, unit, yLabel, scaleFactor } = config;
        const device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [serviceUUID] }],
            optionalServices: [serviceUUID]
        });
        return this._setupDevice(device, {
            serviceUUID, characteristicUUID,
            dataFormat: dataFormat || 'text-float',
            unit: unit || '', yLabel: yLabel || 'Value',
            scaleFactor: scaleFactor ?? 1,
            calibrationOffset: 0,
        });
    }

    async scanAnyDevice(config) {
        const { nameFilter, dataFormat, unit, yLabel, scaleFactor, optionalServices } = config || {};

        // Collect known service UUIDs so Chrome grants access to browse them.
        // Without optionalServices, getPrimaryServices() returns empty on acceptAllDevices.
        const knownServices = optionalServices || BLEManager.KNOWN_SERVICE_UUIDS || [];

        const requestOptions = nameFilter
            ? { filters: [{ namePrefix: nameFilter }], optionalServices: knownServices }
            : { acceptAllDevices: true, optionalServices: knownServices };

        const device = await navigator.bluetooth.requestDevice(requestOptions);
        const color = this._nextColor();
        const deviceId = device.id;
        const entry = {
            device, server: null, characteristic: null, color,
            name: device.name || `Device-${this.devices.size + 1}`,
            reconnectAttempts: 0, serviceUUID: null, characteristicUUID: null,
            dataFormat: dataFormat || 'text-float', unit: unit || '',
            yLabel: yLabel || 'Value', scaleFactor: scaleFactor ?? 1,
            calibrationOffset: 0,
        };
        this.devices.set(deviceId, entry);
        device.addEventListener('gattserverdisconnected', () => this._onDisconnected(deviceId));
        entry.server = await device.gatt.connect();
        this._emit('scanConnected', { deviceId, name: entry.name, color: entry.color });
        return deviceId;
    }

    async browseServices(deviceId) {
        const entry = this.devices.get(deviceId);
        if (!entry?.server?.connected) throw new Error('Device not connected');
        const services = await entry.server.getPrimaryServices();
        const result = [];
        for (const svc of services) {
            const chars = await svc.getCharacteristics();
            result.push({
                serviceUUID: svc.uuid,
                characteristics: chars.map(c => ({
                    uuid: c.uuid,
                    properties: { read: c.properties.read, write: c.properties.write, notify: c.properties.notify, indicate: c.properties.indicate }
                }))
            });
        }
        return result;
    }

    async subscribeToCharacteristic(deviceId, serviceUUID, characteristicUUID) {
        const entry = this.devices.get(deviceId);
        if (!entry?.server?.connected) throw new Error('Device not connected');
        entry.serviceUUID = serviceUUID;
        entry.characteristicUUID = characteristicUUID;
        const svc = await entry.server.getPrimaryService(serviceUUID);
        const char = await svc.getCharacteristic(characteristicUUID);
        entry.characteristic = char;
        await char.startNotifications();
        this._attachHandler(deviceId, char);
        entry.reconnectAttempts = 0;
        this._emit('connected', { deviceId, name: entry.name, color: entry.color, unit: entry.unit, yLabel: entry.yLabel });
    }

    async _setupDevice(device, config) {
        const deviceId = device.id;
        if (this.devices.has(deviceId) && this.devices.get(deviceId).server?.connected) {
            this._emit('status', { deviceId, message: 'Already connected' });
            return deviceId;
        }
        const color = this._nextColor();
        const entry = { device, server: null, characteristic: null, color,
            name: device.name || `Sensor-${this.devices.size + 1}`, reconnectAttempts: 0, ...config };
        this.devices.set(deviceId, entry);
        device.addEventListener('gattserverdisconnected', () => this._onDisconnected(deviceId));
        await this._connectToDevice(deviceId);
        return deviceId;
    }

    // Attach exactly ONE handler per device. On reconnect, reactivate instead of adding another.
    _attachHandler(deviceId, characteristic) {
        if (this._handlers.has(deviceId)) {
            // Handler already exists — just reactivate it
            this._handlers.get(deviceId).active = true;
            console.debug('[BLE] Reactivated handler for', deviceId);
            return;
        }
        const handler = (ev) => {
            const h = this._handlers.get(deviceId);
            if (!h || !h.active) return;
            this._onDataReceived(deviceId, ev);
        };
        characteristic.addEventListener('characteristicvaluechanged', handler);
        this._handlers.set(deviceId, { fn: handler, active: true });
        console.debug('[BLE] Attached NEW handler for', deviceId);
    }

    async _connectToDevice(deviceId) {
        const entry = this.devices.get(deviceId);
        if (!entry) return;
        try {
            this._emit('status', { deviceId, message: 'Connecting...' });
            entry.server = await entry.device.gatt.connect();
            const svc = await entry.server.getPrimaryService(entry.serviceUUID);
            const char = await svc.getCharacteristic(entry.characteristicUUID);
            entry.characteristic = char;
            await char.startNotifications();
            this._attachHandler(deviceId, char);
            entry.reconnectAttempts = 0;
            this._emit('connected', { deviceId, name: entry.name, color: entry.color, unit: entry.unit, yLabel: entry.yLabel });
            this._emit('status', { deviceId, message: 'Connected' });
        } catch (err) {
            this._emit('error', { deviceId, error: err.message });
            throw err;
        }
    }

    _parseData(dv, format, scaleFactor) {
        const s = scaleFactor ?? 1;
        switch (format) {
            case 'float32-le': return [dv.getFloat32(0, true) * s];
            case 'float32-be': return [dv.getFloat32(0, false) * s];
            case 'int16-le':   return [dv.getInt16(0, true) * s];
            case 'int16-be':   return [dv.getInt16(0, false) * s];
            case 'uint16-le':  return [dv.getUint16(0, true) * s];
            case 'uint16-be':  return [dv.getUint16(0, false) * s];
            case 'text-csv': {
                const t = new TextDecoder().decode(dv.buffer).trim();
                return t.split(',').map(v => parseFloat(v.trim()) * s).filter(n => !isNaN(n));
            }
            case 'text-json': {
                try {
                    const t = new TextDecoder().decode(dv.buffer).trim();
                    const o = JSON.parse(t);
                    if (typeof o === 'number') return [o * s];
                    if (o.value !== undefined) return [o.value * s];
                    if (o.v !== undefined) return [o.v * s];
                    if (Array.isArray(o.values)) return o.values.map(v => v * s);
                    if (Array.isArray(o)) return o.map(v => Number(v) * s);
                    for (const k of Object.keys(o)) { const n = Number(o[k]); if (!isNaN(n)) return [n * s]; }
                } catch { }
                return [];
            }
            default: {
                const t = new TextDecoder().decode(dv.buffer).trim();
                const n = parseFloat(t);
                return isNaN(n) ? [] : [n * s];
            }
        }
    }

    _onDataReceived(deviceId, event) {
        const entry = this.devices.get(deviceId);
        if (!entry) return;
        const dv = event.target.value;
        if (!dv || dv.byteLength === 0) {
            console.warn('[BLE] Empty notification from', deviceId);
            return;
        }
        console.debug('[BLE] Raw bytes:', new Uint8Array(dv.buffer), 'len:', dv.byteLength, 'format:', entry.dataFormat);
        const values = this._parseData(dv, entry.dataFormat, entry.scaleFactor);
        // Use slice to avoid detached ArrayBuffer issues on some Chrome versions
        const raw = new TextDecoder().decode(dv.buffer.slice(0)).trim();
        console.debug('[BLE] Parsed values:', values, 'raw text:', raw);
        const now = Date.now();
        values.forEach((value, index) => {
            const calibrated = value + (entry.calibrationOffset || 0);
            this._emit('data', {
                deviceId, name: entry.name, value: calibrated, raw,
                timestamp: now, color: entry.color, unit: entry.unit,
                yLabel: entry.yLabel, channelIndex: index,
            });
        });
    }

    async _onDisconnected(deviceId) {
        const entry = this.devices.get(deviceId);
        if (!entry) return;
        this._emit('disconnected', { deviceId, name: entry.name });
        this._emit('status', { deviceId, message: 'Disconnected — attempting reconnect...' });
        while (entry.reconnectAttempts < this.maxReconnectAttempts) {
            entry.reconnectAttempts++;
            const a = entry.reconnectAttempts;
            this._emit('status', { deviceId, message: `Reconnect ${a}/${this.maxReconnectAttempts}...` });
            try {
                await this._sleep(this.reconnectDelay * a);
                if (!this.devices.has(deviceId)) return;
                await this._connectToDevice(deviceId);
                return;
            } catch { this._emit('status', { deviceId, message: `Reconnect ${a} failed` }); }
        }
        this._emit('reconnectFailed', { deviceId, name: entry.name });
    }

    async disconnect(deviceId) {
        const entry = this.devices.get(deviceId);
        if (!entry) return;
        entry.reconnectAttempts = this.maxReconnectAttempts;
        // Deactivate handler so stale events are ignored
        const h = this._handlers.get(deviceId);
        if (h) h.active = false;
        this._handlers.delete(deviceId);
        if (entry.server?.connected) entry.device.gatt.disconnect();
        this.devices.delete(deviceId);
        this._emit('removed', { deviceId, name: entry.name });
    }

    async retryConnect(deviceId) {
        const entry = this.devices.get(deviceId);
        if (!entry) return;
        entry.reconnectAttempts = 0;
        try { await this._connectToDevice(deviceId); } catch { this._onDisconnected(deviceId); }
    }

    renameDevice(deviceId, name) {
        const e = this.devices.get(deviceId);
        if (e) { e.name = name; this._emit('renamed', { deviceId, name }); }
    }

    setCalibrationOffset(deviceId, offset) {
        const e = this.devices.get(deviceId);
        if (e) e.calibrationOffset = offset;
    }

    getDevices() {
        return [...this.devices].map(([id, e]) => ({
            id, name: e.name, color: e.color, unit: e.unit,
            connected: e.server?.connected || false,
        }));
    }

    get connectedCount() {
        let c = 0;
        for (const e of this.devices.values()) if (e.server?.connected) c++;
        return c;
    }

    _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

// Known service UUIDs for Browse Services to work with Scan Any.
// Populated by app.js from presets + profiles. Add common standard services too.
BLEManager.KNOWN_SERVICE_UUIDS = [
    '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART / SensorLab
    'heart_rate',
    'battery_service',
    'environmental_sensing',
    'device_information',
    'generic_access',
];
