/** Add-device dialog (SLTP, legacy presets, custom UUID, scan & browse) and demo mode. */
import { h, $, clear, toast, log, openDialog, closeDialog, lsGet, lsSet } from './dom.js';
import { UUIDS, bytesToHex } from '../protocol/sltp.js';
import { LEGACY_FORMATS } from '../protocol/legacy.js';
import { MAX_PROFILE_BYTES, parseDeviceProfileJson, stringifyDeviceProfile } from '../protocol/device-profile.js';
import { WebBluetoothTransport } from '../transport/web-bluetooth.js';
import { SimulatedTransport, demoFleetSpecs } from '../transport/simulated.js';

export const LEGACY_PRESETS = [
    { name: 'SensorLab ESP32 (legacy text)', serviceUuid: '6e400001-b5a3-f393-e0a9-e50e24dcca9e', charUuid: 'beb5483e-36e1-4688-b7f5-ea07361b26a8', format: 'text-float', unit: 'Ω', label: 'Resistance', scaleFactor: 1, sentinels: [1000000],
        note: 'v1 firmware; 1e6 = open circuit (marked invalid)' },
    { name: 'Nordic UART (text number)', serviceUuid: '6e400001-b5a3-f393-e0a9-e50e24dcca9e', charUuid: '6e400003-b5a3-f393-e0a9-e50e24dcca9e', format: 'text-float', unit: '', label: 'Value', scaleFactor: 1 },
    { name: 'Heart Rate (GATT)', serviceUuid: 'heart_rate', charUuid: 'heart_rate_measurement', format: 'gatt-heart-rate', unit: 'bpm', label: 'Heart rate', scaleFactor: 1 },
    { name: 'Battery Level (GATT)', serviceUuid: 'battery_service', charUuid: 'battery_level', format: 'uint8', unit: '%', label: 'Battery', scaleFactor: 1, note: 'notify must be supported by the device' },
    { name: 'Temperature (Environmental Sensing)', serviceUuid: 'environmental_sensing', charUuid: 'temperature', format: 'int16-le', unit: '°C', label: 'Temperature', scaleFactor: 0.01 },
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_RE = /^0x[0-9a-f]{4}$/i;
const NAMED_RE = /^[a-z][a-z0-9_]*$/;
/** Normalize a user-entered UUID to what Web Bluetooth accepts, or null if invalid. */
export function normalizeUuid(s) {
    s = String(s || '').trim();
    if (UUID_RE.test(s)) return s.toLowerCase();
    if (SHORT_RE.test(s)) return parseInt(s, 16);
    if (NAMED_RE.test(s)) return s;
    return null;
}

const PROFILE_KEY = 'sensorlab_profiles'; // same key and shape as SensorLab 1.x, so saved profiles carry over
function loadProfiles() { try { const p = JSON.parse(lsGet(PROFILE_KEY, '[]')); return Array.isArray(p) ? p : []; } catch { return []; } }
function saveProfiles(p) { lsSet(PROFILE_KEY, JSON.stringify(p)); }
const DEVICE_PROFILE_KEY = 'sensorlab_device_profiles_v1';
function loadDeviceProfiles() {
    let text;
    try { text = localStorage.getItem(DEVICE_PROFILE_KEY); }
    catch (e) { return { ok: false, error: `Profile storage unavailable: ${e.message}` }; }
    if (text === null) return { ok: true, profiles: [] };
    let value;
    try { value = JSON.parse(text); } catch (e) { return { ok: false, error: `Saved device profiles are invalid JSON: ${e.message}` }; }
    if (!Array.isArray(value)) return { ok: false, error: 'Saved device profiles must be a JSON array.' };
    const profiles = [];
    for (const raw of value) {
        const checked = parseDeviceProfileJson(JSON.stringify(raw));
        if (!checked.ok) return { ok: false, error: `A saved profile is invalid: ${checked.error}` };
        profiles.push(checked.profile);
    }
    return { ok: true, profiles };
}
function saveDeviceProfiles(profiles) {
    try { localStorage.setItem(DEVICE_PROFILE_KEY, JSON.stringify(profiles)); return { ok: true }; }
    catch (e) { return { ok: false, error: `Could not save device profiles: ${e.message}` }; }
}
function profileRequestOptions(profile) {
    const services = [...new Set(profile.characteristics.map(c => c.serviceUuid))];
    const filter = {};
    if (profile.match?.namePrefix) filter.namePrefix = profile.match.namePrefix;
    if (services.length) filter.services = services;
    return {
        ...(Object.keys(filter).length ? { filters: [filter] } : { acceptAllDevices: true }),
        optionalServices: services,
    };
}
const profileToLegacy = (p) => ({
    name: p.name, serviceUuid: normalizeUuid(p.serviceUUID), charUuid: normalizeUuid(p.characteristicUUID),
    format: LEGACY_FORMATS.includes(p.dataFormat) ? p.dataFormat : 'text-float', unit: p.unit || '', label: p.yLabel || 'Value', scaleFactor: Number(p.scaleFactor) || 1,
});

export class ConnectView {
    constructor({ service, clock }) {
        this.service = service;
        this.clock = clock;
        this.dialog = $('addDialog');
        this.ble = new WebBluetoothTransport({ clock });
        this.sim = null;
        this._stormTimer = null;
        this._initTabs();
        this._initPresets();
        this._initCustom();
        this._initDeviceProfiles();
        $('connectSltp').addEventListener('click', () => this._connect(async () => {
            const dev = await this.ble.requestDevice({ filters: [{ services: [UUIDS.service] }, { namePrefix: 'SLab-' }], optionalServices: [UUIDS.service] });
            return [dev, { kind: 'sltp', name: dev.name }];
        }));
        $('scanBtn').addEventListener('click', () => this._scan());
        // A device connected for browsing but never subscribed must not stay GATT-connected.
        this._inspectorSubscriptions = new Map();
        this.dialog.addEventListener('close', async () => {
            for (const unsubscribe of this._inspectorSubscriptions.values()) { try { await unsubscribe(); } catch { /* disconnected during close */ } }
            this._inspectorSubscriptions.clear();
            if (this._scanDev && !this.service.get(this._scanDev.transportId)) this._scanDev.disconnect();
            this._scanDev = null;
        });
        this._initDemo();
    }

    open() {
        $('addError').textContent = '';
        if (!WebBluetoothTransport.isSupported()) $('addError').textContent = 'Web Bluetooth is not available in this browser. Use Chrome or Edge, or try Demo mode.';
        openDialog(this.dialog);
    }

    _initTabs() {
        const tabs = [...this.dialog.querySelectorAll('[role=tab]')];
        const select = (t) => {
            for (const x of tabs) { const on = x === t; x.setAttribute('aria-selected', String(on)); x.tabIndex = on ? 0 : -1; $(x.getAttribute('aria-controls')).hidden = !on; }
            t.focus();
        };
        tabs.forEach((t, i) => {
            t.addEventListener('click', () => select(t));
            t.addEventListener('keydown', (ev) => {
                if (ev.key === 'ArrowRight') select(tabs[(i + 1) % tabs.length]);
                if (ev.key === 'ArrowLeft') select(tabs[(i - 1 + tabs.length) % tabs.length]);
            });
        });
    }

    async _connect(fn) {
        $('addError').textContent = '';
        if (!WebBluetoothTransport.isSupported()) { $('addError').textContent = 'Web Bluetooth is not available here.'; return; }
        try {
            const [dev, profile] = await fn(); // requestDevice runs inside the click handler (user gesture)
            if (this.service.get(dev.transportId)) {
                $('addError').textContent = `${dev.name || 'This device'} is already added. Remove it first to connect it with a different profile.`;
                if (this.service.get(dev.transportId).conn.state === 'DEAD') this.service.retry(dev.transportId);
                return;
            }
            const e = this.service.addDevice(dev, profile);
            log('ble', `added ${dev.name || dev.transportId} (${profile.kind === 'sltp' ? 'SLTP v1' : profile.kind === 'generic' ? `profile ${profile.name}` : 'legacy ' + profile.format})`);
            closeDialog(this.dialog);
            return e;
        } catch (err) {
            if (err && err.name === 'NotFoundError') { $('addError').textContent = 'No device selected.'; return; }
            $('addError').textContent = (err?.name === 'NotAllowedError' || err?.name === 'SecurityError')
                ? `Bluetooth access was denied or blocked (${err.name}: ${err.message}). Allow Bluetooth for this page in the browser's site settings (or ask IT if a policy blocks it), make sure Bluetooth is switched on, then try again.`
                : 'Could not add device: ' + (err?.message || err);
            log('error', 'add device: ' + (err?.message || err));
        }
    }

    _initPresets() {
        const list = $('presetList');
        for (const p of LEGACY_PRESETS) {
            list.append(h('button', {
                type: 'button', class: 'btn',
                onclick: () => this._connect(async () => {
                    const dev = await this.ble.requestDevice({ filters: [{ services: [p.serviceUuid] }], optionalServices: [p.serviceUuid] });
                    return [dev, { kind: 'legacy', ...p }];
                }),
            }, p.name, h('small', {}, `${p.format}${p.unit ? ' · ' + p.unit : ''}${p.note ? ' · ' + p.note : ''}`)));
        }
    }

    _initCustom() {
        const sel = $('cFormat');
        for (const f of LEGACY_FORMATS) sel.append(h('option', { value: f }, f));
        const read = () => {
            const svc = normalizeUuid($('cService').value), chr = normalizeUuid($('cChar').value);
            if (svc === null || chr === null) { $('addError').textContent = 'Invalid UUID. Use a 128-bit UUID, 0xNNNN, or a standard name like heart_rate.'; return null; }
            const scale = Number($('cScale').value);
            if (!Number.isFinite(scale) || scale === 0) { $('addError').textContent = 'Scale factor must be a non-zero number.'; return null; }
            return { serviceUuid: svc, charUuid: chr, format: sel.value, unit: $('cUnit').value.trim().slice(0, 16), label: $('cLabel').value.trim().slice(0, 32) || 'Value', scaleFactor: scale };
        };
        $('customForm').addEventListener('submit', (ev) => {
            ev.preventDefault();
            const p = read();
            if (!p) return;
            this._connect(async () => {
                const dev = await this.ble.requestDevice({ filters: [{ services: [p.serviceUuid] }], optionalServices: [p.serviceUuid] });
                return [dev, { kind: 'legacy', name: p.label, ...p }];
            });
        });
        $('saveProfileBtn').addEventListener('click', () => {
            const p = read();
            if (!p) return;
            const name = (p.label + ' ' + String(p.charUuid).slice(0, 8)).trim();
            const all = loadProfiles();
            all.push({ name, serviceUUID: String($('cService').value.trim()), characteristicUUID: String($('cChar').value.trim()), dataFormat: p.format, unit: p.unit, yLabel: p.label, scaleFactor: p.scaleFactor });
            saveProfiles(all);
            this._renderProfiles();
            toast('Profile saved.');
        });
        this._renderProfiles();
    }

    _renderProfiles() {
        const ul = $('profileList');
        clear(ul);
        const all = loadProfiles();
        if (!all.length) { ul.append(h('li', { class: 'muted' }, 'No saved profiles.')); return; }
        all.forEach((raw, i) => {
            const p = profileToLegacy(raw);
            const valid = p.serviceUuid !== null && p.charUuid !== null;
            ul.append(h('li', {},
                h('span', { class: 'spacer' }, raw.name || '(unnamed)', h('small', { class: 'muted' }, ` ${p.format}${p.unit ? ' · ' + p.unit : ''}`)),
                h('button', { type: 'button', class: 'btn btn-sm', disabled: !valid, onclick: () => this._connect(async () => {
                    const dev = await this.ble.requestDevice({ filters: [{ services: [p.serviceUuid] }], optionalServices: [p.serviceUuid] });
                    return [dev, { kind: 'legacy', ...p }];
                }) }, 'Connect'),
                h('button', { type: 'button', class: 'btn btn-sm btn-danger', onclick: () => { const a = loadProfiles(); a.splice(i, 1); saveProfiles(a); this._renderProfiles(); } }, 'Delete')));
        });
    }

    _knownServices() {
        const s = new Set([UUIDS.service, ...LEGACY_PRESETS.map(p => p.serviceUuid), 'device_information', 'generic_access']);
        for (const p of loadProfiles()) { const u = normalizeUuid(p.serviceUUID); if (u !== null) s.add(u); }
        const profiles = loadDeviceProfiles();
        if (profiles.ok) for (const p of profiles.profiles) for (const c of p.characteristics) s.add(c.serviceUuid);
        return [...s];
    }

    _initDeviceProfiles() {
        const editor = $('deviceProfileJson');
        const reportError = message => { $('addError').textContent = message; };
        $('deviceProfileFile').addEventListener('change', async event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            if (file.size > MAX_PROFILE_BYTES) { reportError(`Profile file exceeds the ${MAX_PROFILE_BYTES}-byte limit.`); return; }
            try {
                editor.value = await file.text();
                const checked = parseDeviceProfileJson(editor.value);
                reportError(checked.ok ? '' : checked.error);
            } catch (e) { reportError(`Could not read profile file: ${e.message}`); }
        });
        $('saveDeviceProfile').addEventListener('click', () => {
            const checked = parseDeviceProfileJson(editor.value);
            if (!checked.ok) { reportError(checked.error); return; }
            const loaded = loadDeviceProfiles();
            if (!loaded.ok) { reportError(loaded.error); return; }
            const profiles = loaded.profiles.filter(profile => profile.id !== checked.profile.id);
            profiles.push(checked.profile);
            const saved = saveDeviceProfiles(profiles);
            if (!saved.ok) { reportError(saved.error); return; }
            editor.value = stringifyDeviceProfile(checked.profile);
            reportError('');
            this._renderDeviceProfiles();
            toast('Device profile saved.');
        });
        $('clearDeviceProfile').addEventListener('click', () => { editor.value = ''; reportError(''); });
        this._renderDeviceProfiles();
    }

    _renderDeviceProfiles() {
        const list = $('deviceProfileList');
        clear(list);
        const loaded = loadDeviceProfiles();
        if (!loaded.ok) {
            list.append(h('li', { class: 'error' }, loaded.error));
            $('addError').textContent = loaded.error;
            return;
        }
        if (!loaded.profiles.length) { list.append(h('li', { class: 'muted' }, 'No generic GATT profiles saved.')); return; }
        for (const profile of loaded.profiles) {
            list.append(h('li', {},
                h('span', { class: 'spacer' }, profile.name,
                    h('small', { class: 'muted' }, ` ${profile.characteristics.length} characteristic(s), ${profile.channels.length} channel(s)`)),
                h('button', { type: 'button', class: 'btn btn-sm', onclick: () => {
                    $('deviceProfileJson').value = stringifyDeviceProfile(profile);
                    $('addError').textContent = '';
                } }, 'Edit JSON'),
                h('button', { type: 'button', class: 'btn btn-sm', onclick: () => {
                    const blob = new Blob([stringifyDeviceProfile(profile)], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const anchor = h('a', { href: url, download: `${profile.id}.json` });
                    anchor.click();
                    setTimeout(() => URL.revokeObjectURL(url), 30_000);
                } }, 'Export'),
                h('button', { type: 'button', class: 'btn btn-sm', onclick: () => this._connect(async () => {
                    const dev = await this.ble.requestDevice(profileRequestOptions(profile));
                    return [dev, profile];
                }) }, 'Connect'),
                h('button', { type: 'button', class: 'btn btn-sm btn-danger', onclick: () => {
                    const current = loadDeviceProfiles();
                    if (!current.ok) { $('addError').textContent = current.error; return; }
                    const saved = saveDeviceProfiles(current.profiles.filter(item => item.id !== profile.id));
                    if (!saved.ok) { $('addError').textContent = saved.error; return; }
                    this._renderDeviceProfiles();
                } }, 'Delete')));
        }
    }

    async _scan() {
        $('addError').textContent = '';
        if (!WebBluetoothTransport.isSupported()) { $('addError').textContent = 'Web Bluetooth is not available here.'; return; }
        const out = $('scanResults');
        clear(out);
        let dev;
        try {
            const prefix = $('scanPrefix').value.trim();
            const enteredServices = $('scanServices').value.split(',').map(value => value.trim()).filter(Boolean).map(normalizeUuid);
            if (enteredServices.some(uuid => uuid === null)) {
                $('addError').textContent = 'Invalid additional service UUID. Use a 128-bit UUID, 0xNNNN, or a standard Bluetooth service name.';
                return;
            }
            const optionalServices = [...new Set([...this._knownServices(), ...enteredServices])];
            dev = await this.ble.requestDevice(prefix ? { filters: [{ namePrefix: prefix }], optionalServices } : { acceptAllDevices: true, optionalServices });
            out.append(h('p', {}, 'Connecting to ', h('strong', {}, dev.name || dev.transportId), '…'));
            this._scanDev = dev;
            await dev.connect();
            const services = await dev.listServices();
            clear(out);
            if (!services.length) out.append(h('p', { class: 'muted' }, 'No browsable services. The browser only allows services listed in presets/profiles; add the service UUID as a custom profile first.'));
            for (const s of services) {
                const box = h('div', { class: 'svc' }, h('div', {}, 'Service ', h('code', {}, String(s.serviceUuid))));
                for (const c of s.characteristics) {
                    const props = Object.entries(c.properties).filter(([, v]) => v).map(([k]) => k).join(', ');
                    const fmt = h('select', { 'aria-label': 'Format' }, ...LEGACY_FORMATS.map(f => h('option', { value: f }, f)));
                    const canSub = c.properties.notify || c.properties.indicate;
                    const output = h('pre', { class: 'muted', 'aria-live': 'polite' }, '');
                    const controls = [];
                    if (c.properties.read) controls.push(h('button', { type: 'button', class: 'btn btn-sm', onclick: () => this._inspectRead(dev, s.serviceUuid, c.uuid, output) }, 'Read'));
                    if (canSub) controls.push(h('button', { type: 'button', class: 'btn btn-sm', onclick: () => this._watchCharacteristic(dev, s.serviceUuid, c.uuid, output) }, 'Watch'));
                    if (c.properties.write || c.properties.writeWithoutResponse) controls.push(h('button', { type: 'button', class: 'btn btn-sm', onclick: () => this._inspectWrite(dev, s.serviceUuid, c.uuid, output) }, 'Write…'));
                    box.append(h('div', {}, h('code', {}, String(c.uuid)), ' ', h('small', { class: 'muted' }, props), ' ', ...controls, ' ',
                        canSub ? fmt : null,
                        canSub ? h('button', { type: 'button', class: 'btn btn-sm', onclick: () => {
                            if (this.service.get(dev.transportId)) { $('addError').textContent = 'This device is already subscribed (one stream per device). Remove it first to choose another characteristic.'; return; }
                            const e = this.service.addDevice(dev, { kind: 'legacy', name: dev.name || 'Scanned', serviceUuid: s.serviceUuid, charUuid: c.uuid, format: fmt.value, unit: '', label: 'value', scaleFactor: 1 });
                            log('ble', `subscribed ${e.displayName} ${c.uuid} as ${fmt.value}`);
                            closeDialog(this.dialog);
                        } }, 'Subscribe') : null));
                    if (c.properties.read || canSub || c.properties.write || c.properties.writeWithoutResponse) box.append(output);
                }
                out.append(box);
            }
        } catch (err) {
            dev?.disconnect();
            if (err?.name === 'NotFoundError') { $('addError').textContent = 'No device selected.'; return; }
            $('addError').textContent = 'Scan failed: ' + (err?.message || err);
        }
    }

    async _inspectRead(dev, serviceUuid, characteristicUuid, output) {
        try {
            const characteristic = await dev.getCharacteristic(serviceUuid, characteristicUuid);
            const bytes = await characteristic.read();
            output.textContent = `${bytes.length} bytes · ${bytesToHex(bytes, 128)}`;
        } catch (e) {
            output.textContent = `Read failed: ${e.message || e}`;
        }
    }

    async _inspectWrite(dev, serviceUuid, characteristicUuid, output) {
        const input = window.prompt('Enter the bytes to write as hexadecimal (for example: 01 02 FF). The device may perform an action.');
        if (input === null) return;
        const hex = input.replace(/[\s:-]/g, '');
        if (!hex || hex.length > 1024 || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) {
            output.textContent = 'Write cancelled: enter 1–512 bytes as an even-length hexadecimal string.';
            return;
        }
        const bytes = Uint8Array.from(hex.match(/.{2}/g), pair => Number.parseInt(pair, 16));
        if (!window.confirm(`Write ${bytes.length} byte(s) to ${characteristicUuid}? This is a user-initiated device command.`)) return;
        try {
            const characteristic = await dev.getCharacteristic(serviceUuid, characteristicUuid);
            await characteristic.write(bytes);
            output.textContent = `Wrote ${bytes.length} byte(s): ${bytesToHex(bytes, 512)}`;
        } catch (e) {
            output.textContent = `Write failed: ${e.message || e}`;
        }
    }

    async _watchCharacteristic(dev, serviceUuid, characteristicUuid, output) {
        const key = `${dev.transportId}:${serviceUuid}:${characteristicUuid}`;
        const active = this._inspectorSubscriptions.get(key);
        if (active) {
            try { await active(); } catch (e) { output.textContent = `Could not stop watch: ${e.message || e}`; }
            this._inspectorSubscriptions.delete(key);
            return;
        }
        try {
            const characteristic = await dev.getCharacteristic(serviceUuid, characteristicUuid);
            const rows = [];
            const unsubscribe = await characteristic.subscribe((bytes, hostMs) => {
                rows.push(`${Math.round(hostMs)} ms monotonic · ${bytes.length} B · ${bytesToHex(bytes, 96)}`);
                if (rows.length > 20) rows.shift();
                output.textContent = rows.join('\n');
            });
            this._inspectorSubscriptions.set(key, unsubscribe);
            output.textContent = 'Watching raw payloads…';
        } catch (e) {
            output.textContent = `Watch failed: ${e.message || e}`;
        }
    }

    // ── demo mode ──
    _initDemo() {
        $('demoBtn').addEventListener('click', () => openDialog($('demoDialog')));
        $('demoForm').addEventListener('submit', (ev) => {
            ev.preventDefault();
            const n = Math.min(8, Math.max(1, parseInt($('demoCount').value, 10) || 3));
            const rate = Math.min(200, Math.max(1, Number($('demoRate').value) || 10));
            const faults = {
                dropProb: $('fDrop').checked ? 0.02 : 0, duplicateProb: $('fDup').checked ? 0.01 : 0, reorderProb: $('fReorder').checked ? 0.01 : 0,
                malformedProb: $('fMalformed').checked ? 0.005 : 0, badVersionProb: $('fMalformed').checked ? 0.005 : 0, invalidChannelProb: $('fInvalid').checked ? 0.02 : 0,
            };
            this.startDemo(n, rate, faults, $('fStorm').checked);
            closeDialog($('demoDialog'));
        });
        $('demoStop').addEventListener('click', () => { this.stopDemo(); closeDialog($('demoDialog')); });
    }

    startDemo(n, rate, faults = {}, storm = false) {
        if (!this.sim) this.sim = new SimulatedTransport({ clock: this.clock, seed: Math.floor(Math.random() * 1e6) });
        for (const spec of demoFleetSpecs(n, rate)) {
            const dev = this.sim.addDevice({ ...spec, faults });
            dev.setFaults(faults);
            if (dev._off) dev.powerOn();
            this.service.addDevice(dev, { kind: 'sltp' });
        }
        clearInterval(this._stormTimer);
        if (storm) {
            this._stormTimer = setInterval(() => {
                const devs = [...this.sim.devices.values()].filter(d => d.connected);
                if (devs.length) { const d = devs[Math.floor(Math.random() * devs.length)]; d.forceDisconnect(); log('demo', `storm: forced disconnect of ${d.name}`); }
            }, 20_000);
        }
        log('demo', `started ${n} simulated device(s) at ${rate} Hz`);
        toast(`Demo: ${n} SIMULATED device(s) at ${rate} Hz.`, 'warning');
    }

    async stopDemo() {
        clearInterval(this._stormTimer);
        for (const e of this.service.list().filter(x => x.simulated)) await this.service.removeDevice(e.handle);
        this.sim?.stopAll();
        this.sim = null;
        log('demo', 'demo devices removed');
    }
}
