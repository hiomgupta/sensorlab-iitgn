/**
 * Recording preflight. It checks the preconditions of a recording and separates FATAL failures (recording must
 * not start) from WARNINGS (risk explained; the user may continue). Connection alone is never taken as
 * proof of a working stream: STREAMING requires a valid packet on the current subscription
 * (device-connection.js), and startup verification later requires fresh valid samples from explicitly
 * required channels. Unknown device profiles require all channels; SLab-R1 requires its raw ADC channel.
 */
import { STATES as DEV } from './device-connection.js';
import { expectedIntervalMs } from './stream-health.js';

const CONNECTED = [DEV.WAITING_FOR_DATA, DEV.STREAMING, DEV.DEGRADED];

function startupRequired(e, ch) {
    if (e.profile.kind === 'sltp' && e.info?.model === 'SLab-R1') return ch.name === 'adc_sum16';
    return true;
}

/**
 * @param o.service AcquisitionService
 * @param o.include handles selected in the confirmation dialog
 * @param o.storage { ready: boolean, error?: string, usage?: number|null, quota?: number|null }
 * @param o.keepAwake { requested: boolean, supported: boolean }
 * @param o.visible document visible?
 * @returns {{ ok: boolean, fatal: Item[], warnings: Item[], streams: StreamPlan[] }}
 *   Item = { code, message, deviceId?, handle? }
 */
export function runPreflight({ service, include, storage, keepAwake = { requested: false, supported: false }, visible = true }) {
    const fatal = [], warnings = [], streams = [];
    const F = (code, message, extra = {}) => fatal.push({ code, message, ...extra });
    const W = (code, message, extra = {}) => warnings.push({ code, message, ...extra });

    if (!service.recorder) F('NO_RECORDER', 'The recording pipeline is not initialised.');
    if (service.recording || service._starting) F('ALREADY_RECORDING', 'A recording is already in progress.');
    if (!storage?.ready) F('STORAGE_UNAVAILABLE', `Local storage is unavailable${storage?.error ? ': ' + storage.error : ''}. Nothing could be saved.`);
    else if (Number.isFinite(storage.usage) && Number.isFinite(storage.quota) && storage.quota > 0) {
        const free = storage.quota - storage.usage;
        if (free < 50 * 1024 * 1024) W('STORAGE_LOW', `Only about ${(free / 1048576).toFixed(0)} MB of browser storage remain. A long recording may fail.`);
    }

    const selected = service.list().filter(e => include.includes(e.handle));
    if (selected.length === 0) F('NO_DEVICES', 'No device is selected for recording.');
    for (const e of selected) {
        const who = { deviceId: e.deviceId, handle: e.handle };
        const name = e.displayName;
        const st = e.conn.state;
        if (!CONNECTED.includes(st)) { F('DEVICE_NOT_CONNECTED', `${name} is not connected (${st}). Reconnect it, or untick it.`, who); continue; }
        if (!e.conn.discovered) { F('NOT_DISCOVERED', `${name}: required Bluetooth services/characteristics are not discovered.`, who); continue; }
        if (!e.conn.subscriptionActive) { F('NOT_SUBSCRIBED', `${name}: no active notification or configured GATT-read data source.`, who); continue; }
        if (!e.deviceId) { F('NO_IDENTITY', `${name}: device identity unknown.`, who); continue; }
        if (!e.channels.length) { F('NO_CHANNELS', `${name}: no sensor channels are defined.`, who); continue; }
        if (st === DEV.WAITING_FOR_DATA) W('NO_DATA_YET', `${name} is connected but has not produced a valid sample yet. Startup will wait for it and fail if it stays silent.`, who);
        if (st === DEV.DEGRADED) W('STREAM_STALLED', `${name} is connected but its data has stalled. Startup will fail unless it resumes.`, who);
        if (e.profile.kind !== 'sltp') W('LEGACY_STREAM', `${name} uses a legacy format with no sequence numbers or device timestamps. Lost samples cannot be detected.`, who);
        if (e.simulated) W('SIMULATED', `${name} is a SIMULATED demo device. Its data is not a physical measurement.`, who);
        const iv = expectedIntervalMs(e);
        if (iv.source.startsWith('fallback')) W('RATE_UNKNOWN', `${name}: the sample rate is unknown, so stale-data detection uses a 1 s default until the rate is measured.`, who);
        let requiredCount = 0;
        for (const ch of e.channels) {
            if (!ch.name) F('CHANNEL_METADATA', `${name}: channel ${ch.channelId} has no name.`, who);
            else if (!ch.unit) W('NO_UNIT', `${name} · ${ch.name}: no unit is defined. Values will be exported without a unit.`, who);
            const requiredForStartup = startupRequired(e, ch);
            if (requiredForStartup) requiredCount++;
            streams.push({ handle: e.handle, deviceId: e.deviceId, deviceName: name, channelId: ch.channelId, name: ch.name, unit: ch.unit, requiredForStartup, deviceState: st, expectedIntervalMs: iv.ms, intervalSource: iv.source });
        }
        if (requiredCount === 0) F('STARTUP_CHANNELS', `${name}: no required acquisition channel is defined for this device profile.`, who);
    }
    const notSelected = service.list().filter(e => !include.includes(e.handle));
    for (const e of notSelected) W('DEVICE_EXCLUDED', `${e.displayName} is connected but will NOT be recorded (unticked).`, { handle: e.handle, deviceId: e.deviceId });

    if (keepAwake.requested && !keepAwake.supported) W('KEEP_AWAKE_UNAVAILABLE', 'Keep screen awake is not available in this browser. The screen may sleep and interrupt the recording. Keep the device active manually.');
    if (!visible) W('PAGE_HIDDEN', 'The page is not visible. Browsers may throttle Bluetooth in background tabs.');
    return { ok: fatal.length === 0, fatal, warnings, streams };
}
