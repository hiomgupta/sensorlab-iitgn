/**
 * AcquisitionService (Layer 3). It owns devices, stable identity, parsing, stream accounting,
 * calibration and the recording hand-off.
 *
 * Order of operations for each packet: parse → account → build readings → recorder.append
 * (synchronous push) → visualization sinks (isolated with try/catch). A failing chart or UI sink
 * can never stop a reading from reaching the recorder (baseline defect D5).
 */
import { bytesToHex } from '../protocol/sltp.js';
import { createProtocolAdapter } from '../protocol/adapters.js';
import { validateDeviceProfile } from '../protocol/device-profile.js';
import { StreamTracker } from './stream-tracker.js';
import { DeviceConnection, ConnectQueue, STATES } from './device-connection.js';
import { Q } from './quality.js';
import {
    identityCalibration, toEngineering, applyCalibration, computeTare, validateCalibration, CALIBRATION_MODEL,
} from './calibration.js';
import { expectedIntervalMs, DEFAULT_HEALTH_POLICY } from './stream-health.js';

const RECENT_PER_CHANNEL = 64;
const MAX_VISIBILITY_LOG = 100;

export class AcquisitionService {
    constructor({ clock, connectionConfig = {}, appInfo = {} }) {
        this.clock = clock;
        this.connectionConfig = connectionConfig;
        this.appInfo = appInfo;
        this.queue = new ConnectQueue();
        this.entries = new Map();          // handle (transportId) → entry
        this.sinks = new Set();
        this.listeners = new Map();
        this.recorder = null;
        this.recording = false;
        this.timeZeroMs = clock.now();     // relative-time origin (live view; reset at recording start)
        this.sessionId = null;
        this.visibilityLog = [];
        this._hiddenAt = null;
        this.sinkErrors = 0;
        this.removedQuality = new Map();   // deviceId → final quality of devices removed during the recording
        this.recordSelection = null;       // Set of handles included in the current recording (null = not recording)
    }

    /** Is this device's data recorded in the current session? (devices added during a recording are included) */
    isRecorded(entry) { return this.recording && !!this.recordSelection && this.recordSelection.has(entry.handle); }

    on(ev, cb) { if (!this.listeners.has(ev)) this.listeners.set(ev, new Set()); this.listeners.get(ev).add(cb); return () => this.listeners.get(ev).delete(cb); }
    _emit(ev, data) { for (const cb of this.listeners.get(ev) || []) { try { cb(data); } catch (e) { console.error('[SensorLab] listener error', ev, e); } } }

    addSink(fn) { this.sinks.add(fn); return () => this.sinks.delete(fn); }

    /**
     * @param device transport device
     * @param profile {kind:'sltp'} | {kind:'legacy', serviceUuid, charUuid, format, unit, label, scaleFactor, sentinels, name}
     */
    addDevice(device, profile) {
        if (profile.kind === 'generic' || profile.adapter === 'generic-gatt') {
            const checked = validateDeviceProfile(profile);
            if (!checked.ok) throw new TypeError(`Invalid generic GATT profile: ${checked.error}`);
            profile = checked.profile;
        }
        if (this.entries.has(device.transportId)) {
            const e = this.entries.get(device.transportId);
            if (e.conn.state === STATES.DEAD) e.conn.retry();
            return e;
        }
        const simulated = device.kind === 'simulated';
        const entry = {
            handle: device.transportId,
            transport: device.kind,
            simulated,
            profile,
            adapter: createProtocolAdapter(profile),
            deviceId: null,
            advertisedName: device.name,
            displayName: device.name || (profile.name ?? 'Sensor'),
            info: null,
            bootId: null,
            channels: [],
            calibration: [],
            calLog: [],
            recent: [],
            tracker: new StreamTracker({ hostTimeOnly: profile.kind !== 'sltp' }),
            parse: { errors: {}, invalidPackets: 0, last: null },
            invalidSamples: 0,
            lastValidMs: null,
            lastPacketMs: null,
            legacyN: null,
            rateCommand: null,
        };
        if (profile.kind === 'generic') {
            this._setChannels(entry, profile.channels.map(channel => ({
                channelId: channel.channelId, name: channel.name, unit: channel.unit,
                scale: channel.scale, offset: channel.offset,
            })));
        } else if (profile.kind !== 'sltp') {
            entry.deviceId = device.transportId; // session-local fallback identity (no serial in legacy firmware)
            this._setChannels(entry, [{ channelId: 0, name: profile.label || 'value', unit: profile.unit || '', scale: profile.scaleFactor ?? 1, offset: 0 }]);
        }
        entry.conn = new DeviceConnection({
            device, profile, clock: this.clock, queue: this.queue, config: this.connectionConfig,
            hooks: {
                onInfo: (info) => this._onInfo(entry, info),
                onBytes: (bytes, hostMs, characteristicId) => this._onBytes(entry, bytes, hostMs, characteristicId),
                onState: () => { this._emit('device', entry); if (this.isRecorded(entry) && entry.deviceId) this.recorder?.upsertDevice(this.deviceMeta(entry)); },
                // link-level stall threshold scales with the stream's expected rate (5 intervals); on-change streams never stall
                staleAfterMs: () => { const { ms } = expectedIntervalMs(entry); return ms === null ? Infinity : DEFAULT_HEALTH_POLICY.staleFactor * ms; },
            },
        });
        this.entries.set(entry.handle, entry);
        if (this.recording && this.recordSelection) { this.recordSelection.add(entry.handle); entry.connBaseline = {}; this._emit('deviceAddedDuringRecording', entry); }
        this._emit('devices', this.list());
        entry.conn.start();
        return entry;
    }

    _setChannels(entry, channels) {
        entry.channels = channels;
        entry.calibration = channels.map(() => identityCalibration());
        entry.recent = channels.map(() => []);
    }

    _onInfo(entry, info) {
        const id = (entry.simulated ? 'sim:' : 'ble:') + info.serial;
        if (entry.deviceId === null) {
            for (const other of this.entries.values()) {
                if (other !== entry && other.deviceId === id) {
                    return { error: `another connected device already reports serial ${info.serial}`, code: 'IDENTITY_COLLISION' };
                }
            }
            entry.deviceId = id;
            this._setChannels(entry, info.channels.map(c => ({ ...c })));
        } else {
            if (entry.deviceId !== id) return { error: `device identity changed on reconnect (${entry.deviceId} → ${id})`, code: 'IDENTITY_CHANGED' };
            const same = info.channels.length === entry.channels.length &&
                info.channels.every((c, i) => c.unit === entry.channels[i].unit && c.scale === entry.channels[i].scale && c.offset === entry.channels[i].offset);
            if (!same) return { error: 'device channel map changed on reconnect; remove and re-add the device', code: 'CHANNEL_MAP_CHANGED' };
        }
        if (entry.bootId !== null && info.bootId !== null && info.bootId !== entry.bootId) entry.tracker.newEpoch();
        entry.bootId = info.bootId;
        entry.info = info;
        if (!entry.advertisedName) entry.displayName = info.model ? `${info.model} ${info.serial.slice(-4)}` : info.serial;
        if (this.isRecorded(entry)) this.recorder?.upsertDevice(this.deviceMeta(entry));
        this._emit('device', entry);
        return null;
    }

    _parseError(entry, code, detail, bytes, hostMs) {
        entry.parse.invalidPackets++;
        entry.parse.errors[code] = (entry.parse.errors[code] || 0) + 1;
        entry.parse.last = { code, detail, hex: bytesToHex(bytes, 48), hostMs };
        this._emit('parseError', { entry, code, detail });
        return false;
    }

    /** @returns {boolean} true if the packet was valid (drives the lifecycle "healthy" signal) */
    _onBytes(entry, bytes, hostMs, characteristicId = 'data') {
        entry.lastPacketMs = hostMs;
        let values, valid, obs, devFlags = 0;
        if (entry.profile.kind === 'sltp') {
            const r = entry.adapter.decode(bytes, entry.channels.length || null);
            if (!r.ok) return this._parseError(entry, r.error.code, r.error.detail, bytes, hostMs);
            obs = entry.tracker.observe(r.packet, hostMs);
            values = r.packet.values;
            valid = r.packet.valid;
            devFlags = r.packet.flags;
        } else if (entry.profile.kind === 'generic') {
            const result = entry.adapter.decode(bytes, characteristicId);
            if (!result.ok) return this._parseError(entry, result.error.code, result.error.detail, bytes, hostMs);
            if (!result.samples.length) return false;
            const channelIndices = new Map(entry.channels.map((channel, index) => [channel.channelId, index]));
            for (const sample of result.samples) {
                const indices = sample.channelIds.map(id => channelIndices.get(id));
                if (indices.some(index => index === undefined)) {
                    return this._parseError(entry, 'UNKNOWN_CHANNEL', 'decoded sample references an unmapped channel', bytes, hostMs);
                }
                const sampleObs = entry.tracker.observe({}, hostMs);
                this._storeSample(entry, sample.values, sample.valid, sampleObs, 0, hostMs, bytes, indices);
            }
            return true;
        } else {
            const r = entry.adapter.decode(bytes);
            if (!r.ok) return this._parseError(entry, r.error.code, r.error.detail, bytes, hostMs);
            if (entry.legacyN === null) {
                entry.legacyN = r.values.length;
                if (r.values.length !== entry.channels.length) {
                    const base = entry.channels[0];
                    this._setChannels(entry, r.values.map((_, i) => ({ ...base, channelId: i, name: r.values.length > 1 ? `${base.name}[${i}]` : base.name })));
                }
            } else if (r.values.length !== entry.legacyN) {
                return this._parseError(entry, 'CHANNEL_COUNT_MISMATCH', `${r.values.length} values, expected ${entry.legacyN}`, bytes, hostMs);
            }
            obs = entry.tracker.observe({}, hostMs);
            values = r.values;
            valid = values.map(() => true);
        }
        this._storeSample(entry, values, valid, obs, devFlags, hostMs, bytes);
        return true;
    }

    _storeSample(entry, values, valid, obs, devFlags, hostMs, bytes, channelIndices = null) {
        entry.lastValidMs = hostMs;
        if (!obs.accept) return; // duplicate / too old: counted, not stored

        const relS = entry.tracker.relativeTimeS(obs.devUs, hostMs, this.timeZeroMs);
        const baseFlags = obs.quality | (entry.simulated ? Q.SIMULATED : 0);
        const sentinels = entry.profile.sentinels || [];
        for (let i = 0; i < values.length; i++) {
            const channelIndex = channelIndices ? channelIndices[i] : i;
            const ch = entry.channels[channelIndex];
            const raw = values[i];
            let flags = baseFlags;
            let ok = valid[i] && !(devFlags & 0x04);
            if (ok && sentinels.includes(raw)) { ok = false; flags |= Q.SENTINEL; }
            const eng = toEngineering(raw, ch.scale, ch.offset);
            if (ok && !Number.isFinite(eng)) ok = false;
            let value = null;
            if (ok) {
                value = applyCalibration(eng, entry.calibration[channelIndex]);
                const rec = entry.recent[channelIndex];
                rec.push({ hostMs, eng });
                if (rec.length > RECENT_PER_CHANNEL) rec.shift();
            } else {
                flags |= Q.INVALID;
                entry.invalidSamples++;
            }
            const reading = {
                deviceId: entry.deviceId, channelId: channelIndex, seq: obs.seq, devUs: obs.devUs,
                hostMs: hostMs - this.timeZeroMs, relS, raw, value, flags,
            };
            if (this.recorder && this.isRecorded(entry)) this.recorder.append(reading);
            for (const sink of this.sinks) {
                try { sink(reading, entry); } catch (e) { this.sinkErrors++; if (this.sinkErrors < 5) console.error('[SensorLab] sink error (acquisition continues)', e); }
            }
        }
        return true;
    }

    list() { return [...this.entries.values()]; }
    get(handle) { return this.entries.get(handle); }

    async removeDevice(handle) {
        const e = this.entries.get(handle);
        if (!e) return;
        await e.conn.close();
        this.entries.delete(handle);
        if (this.isRecorded(e) && e.deviceId) {
            // Keep the removed device's final diagnostics in the session (otherwise the next flush would drop them).
            this.removedQuality.set(e.deviceId, this._entryQuality(e));
            this.recorder?.upsertDevice({ ...this.deviceMeta(e), removedAtRelS: this.relNow() });
        }
        this._emit('devices', this.list());
    }

    retry(handle) { return this.entries.get(handle)?.conn.retry(); }

    writeGattCharacteristic(handle, characteristicId, bytes) {
        const entry = this.entries.get(handle);
        if (!entry || entry.profile.kind !== 'generic') return { ok: false, error: 'unknown generic GATT device' };
        return entry.conn.writeCharacteristic(characteristicId, bytes);
    }

    rename(handle, name) {
        const e = this.entries.get(handle);
        if (!e) return;
        e.displayName = String(name).slice(0, 64);
        if (this.recording && e.deviceId) this.recorder?.upsertDevice(this.deviceMeta(e));
        this._emit('device', e);
    }

    relNow() { return (this.clock.now() - this.timeZeroMs) / 1000; }

    // ── calibration ──
    setCalibration(handle, channelId, { gain, offset }, reason = 'manual') {
        const e = this.entries.get(handle);
        if (!e || !e.calibration[channelId]) return { ok: false, error: 'unknown device/channel' };
        const err = validateCalibration({ gain, offset });
        if (err) return { ok: false, error: err };
        const cur = e.calibration[channelId];
        e.calibration[channelId] = { ...cur, gain, offset, version: cur.version + 1 };
        this._logCal(e, channelId, reason);
        return { ok: true };
    }

    tare(handle, channelId) {
        const e = this.entries.get(handle);
        if (!e || !e.calibration[channelId]) return { ok: false, error: 'unknown device/channel' };
        const r = computeTare(e.recent[channelId], e.calibration[channelId], this.clock.now());
        if (!r.ok) return r;
        const cur = e.calibration[channelId];
        e.calibration[channelId] = { ...cur, tare: r.tare, version: cur.version + 1 };
        this._logCal(e, channelId, `tare (mean of ${r.n} samples)`);
        return { ok: true, tare: r.tare };
    }

    resetCalibration(handle, channelId) {
        const e = this.entries.get(handle);
        if (!e || !e.calibration[channelId]) return { ok: false, error: 'unknown device/channel' };
        const v = e.calibration[channelId].version + 1;
        e.calibration[channelId] = { ...identityCalibration(), version: v };
        this._logCal(e, channelId, 'reset');
        return { ok: true };
    }

    _logCal(e, channelId, reason) {
        const entry = { channelId, ...e.calibration[channelId], reason, atRelS: this.recording ? this.relNow() : null, wall: new Date(this.clock.wallNow()).toISOString() };
        e.calLog.push(entry);
        if (this.recording && e.deviceId) this.recorder?.upsertDevice(this.deviceMeta(e));
        this._emit('device', e);
    }

    /** Set the device sample rate via SLTP CONTROL, confirmed by INFO readback. */
    async setRate(handle, hz) {
        const e = this.entries.get(handle);
        if (!e) return { ok: false, error: 'unknown device' };
        if (e.profile.kind !== 'sltp') return { ok: false, error: 'legacy devices have no rate control' };
        const periodUs = Math.round(1e6 / hz);
        let bytes;
        try { bytes = e.adapter.encodeSampleRate(periodUs); } catch { return { ok: false, error: 'rate out of range (0.1–1000 Hz)' }; }
        const r = await e.conn.sendControl(bytes, (info) => info.periodUs === periodUs);
        e.rateCommand = { requestedHz: hz, ok: r.ok, error: r.error || null, wall: new Date(this.clock.wallNow()).toISOString() };
        if (r.ok) e.info = r.info;
        if (this.recording) this.recorder?.upsertDevice(this.deviceMeta(e));
        this._emit('device', e);
        return r;
    }

    // ── recording ──
    deviceMeta(e) {
        return {
            deviceId: e.deviceId,
            displayName: e.displayName,
            advertisedName: e.advertisedName,
            transport: e.transport,
            simulated: e.simulated,
            protocol: e.profile.kind === 'sltp' ? 'sltp/1' : `legacy:${e.profile.format}`,
            firmware: e.info?.firmware ?? null,
            model: e.info?.model ?? null,
            serial: e.info?.serial ?? null,
            configuredRateHz: e.info?.periodUs ? 1e6 / e.info.periodUs : null,
            identity: e.profile.kind === 'sltp' ? 'device-serial' : 'browser-device-id (session-local fallback; legacy firmware has no serial)',
            channels: e.channels.map((c, i) => ({
                channelId: c.channelId, name: c.name, unit: c.unit, deviceScale: c.scale, deviceOffset: c.offset,
                calibration: { ...e.calibration[i], model: CALIBRATION_MODEL },
            })),
            calibrationLog: e.calLog.slice(),
            sentinels: e.profile.sentinels || [],
        };
    }

    /** Per-device data-quality snapshot (persisted with every flushed chunk), including devices removed mid-recording. */
    qualitySnapshot() {
        const out = Object.fromEntries(this.removedQuality);
        for (const e of this.entries.values()) if (e.deviceId && (!this.recordSelection || this.recordSelection.has(e.handle))) out[e.deviceId] = this._entryQuality(e);
        return out;
    }

    _entryQuality(e) {
        // Connection counters are reported relative to the recording start (baseline), so events that
        // happened before the session began are not attributed to it.
        const base = e.connBaseline || {};
        const connection = {};
        for (const [k, v] of Object.entries(e.conn.counters)) connection[k] = v - (base[k] || 0);
        return {
            state: e.conn.state,
            stream: e.tracker.snapshot(),
            parseErrors: { ...e.parse.errors },
            invalidPackets: e.parse.invalidPackets,
            lastParseError: e.parse.last,
            invalidSamples: e.invalidSamples,
            connection: { ...connection, lastError: e.conn.lastError },
        };
    }

    /**
     * Start recording. The session header is persisted BEFORE any reading is accepted;
     * if that write fails, recording does not start.
     */
    /**
     * @param include handles to record (default: every device). Only these devices' readings enter the session.
     * @param lifecycle initial lifecycle metadata persisted in the session header
     */
    async startRecording({ name, group, notes, include = null, lifecycle = null }) {
        if (this.recording || this._starting) throw new Error('already recording');
        if (!this.recorder) throw new Error('no recorder configured');
        this._starting = true;
        try {
            const now = this.clock.now();
            const selected = this.list().filter(e => !include || include.includes(e.handle));
            const devices = selected.filter(e => e.deviceId).map(e => this.deviceMeta(e));
            const sessionId = await this.recorder.start({
                name, group, notes, devices, lifecycle,
                simulated: selected.some(e => e.simulated),
                app: this.appInfo,
            }, () => this.qualitySnapshot(), () => this.visibilityLog.slice());
            this.recordSelection = new Set(selected.map(e => e.handle));
            return this._activate(sessionId, now);
        } finally { this._starting = false; }
    }

    /** Session header is persisted: initialise per-session counters, then activate the pipeline. */
    _activate(sessionId, now) {
        this.timeZeroMs = now;
        for (const e of this.entries.values()) {
            e.tracker.resetCounters(); e.tracker.reanchor();
            e.parse = { errors: {}, invalidPackets: 0, last: null }; e.invalidSamples = 0;
            e.connBaseline = { ...e.conn.counters };
        }
        this.removedQuality = new Map();
        this.visibilityLog = [];
        this.sessionId = sessionId;
        this.recording = true;
        this._emit('recording', { recording: true, sessionId });
        return sessionId;
    }

    async stopRecording(opts = {}) {
        if (!this.recording) return null;
        // Freeze diagnostics at the instant recording ends: packets that keep arriving during finalization are not
        // stored, so they must not be counted in the session's quality summary (defect D25).
        const frozen = this.qualitySnapshot();
        if (this.recorder) this.recorder.getQuality = () => frozen;
        this.recording = false;
        const sessionId = this.sessionId;
        this.sessionId = null;
        const summary = await this.recorder.stop(opts);
        this.recordSelection = null;
        this._emit('recording', { recording: false, sessionId, summary });
        return summary;
    }

    async addAnnotation(text, capturedHostMs, deviceId = null) {
        if (!this.recording) return { ok: false, error: 'annotations are stored with a recording; start recording first' };
        const relS = (capturedHostMs - this.timeZeroMs) / 1000;
        return this.recorder.addAnnotation({ relS, text: String(text).slice(0, 500), deviceId });
    }

    noteVisibility(hidden) {
        const rel = this.relNow();
        if (hidden) this._hiddenAt = rel;
        else if (this._hiddenAt !== null) {
            if (this.recording && this.visibilityLog.length < MAX_VISIBILITY_LOG) this.visibilityLog.push({ hiddenAtRelS: this._hiddenAt, visibleAtRelS: rel });
            this._hiddenAt = null;
        }
    }

    async shutdown() {
        for (const h of [...this.entries.keys()]) await this.removeDevice(h);
    }
}
