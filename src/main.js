/**
 * SensorLab 2 application controller. Wires the layers together:
 *   transport → AcquisitionService → Recorder → IdbRepository
 *                                  ↘ LiveChart / latest-values table (isolated sinks)
 * No network access anywhere. Remote origins are also blocked by CSP (connect-src 'none').
 */
import { realClock } from './util/clock.js';
import { AcquisitionService } from './acquisition/acquisition-service.js';
import { STATES } from './acquisition/device-connection.js';
import { SessionController } from './acquisition/session-controller.js';
import { SESSION } from './acquisition/session-state.js';
import { expectedIntervalMs, thresholds } from './acquisition/stream-health.js';
import { createKeepAwake } from './platform/keep-awake.js';
import { flagNames } from './acquisition/quality.js';
import { IdbRepository, storageInfo } from './storage/idb-repository.js';
import { Recorder, findInterruptedSessions } from './storage/recorder.js';
import { importLegacyIfPresent } from './storage/legacy-import.js';
import { LiveChart } from './viz/charts.js';
import { WebBluetoothTransport } from './transport/web-bluetooth.js';
import { $, h, clear, toast, log, openDialog, closeDialog, fmtNum, fmtBytes, fmtDuration, lsGet, lsSet } from './ui/dom.js';
import { DevicesView } from './ui/devices-view.js';
import { HistoryView } from './ui/history-view.js';
import { ConnectView } from './ui/connect-view.js';
import { InstallView } from './ui/install-view.js';

/* global __SL_BUILD__ */
const APP = { name: 'SensorLab', version: '2.0.0-dev', build: typeof __SL_BUILD__ !== 'undefined' ? __SL_BUILD__ : 'dev-unbundled' };

async function boot() {
    $('appVersion').textContent = `v${APP.version}`;
    applyTheme(lsGet('sensorlab_theme', 'dark'));
    $('themeBtn').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
    const installView = new InstallView();
    initLog();
    log('info', `SensorLab ${APP.version} (${APP.build}) started from ${location.protocol}//${location.host || '(local file)'}`);

    const clock = realClock;
    const service = new AcquisitionService({ clock, appInfo: { ...APP, userAgent: navigator.userAgent, origin: location.protocol } });

    // ── storage ──
    const repo = new IdbRepository();
    let storageOk = true;
    try { await repo.open(); } catch (e) {
        storageOk = false;
        showStorageBanner(`Local storage is unavailable (${e.message}). Live view works, but RECORDING IS DISABLED because nothing could be saved.`);
        log('error', e.message);
    }
    const recorder = new Recorder({ repo, clock, onStatus: (s) => renderRecStatus(s) });
    service.recorder = recorder;

    if (storageOk) {
        try {
            const r = await importLegacyIfPresent(repo);
            if (r.status === 'imported') { toast(`Imported ${r.sessions} session(s) from SensorLab 1.x (marked "imported"; the old data was left untouched).`, 'success', 9000); log('session', `legacy import: ${r.sessions} sessions, ${r.readings} readings`); }
        } catch (e) { log('error', 'legacy import failed: ' + e.message); toast('Could not import SensorLab 1.x sessions: ' + e.message, 'warning'); }
        await checkInterrupted(repo);
        updateStorageStatus();
    }

    // ── Bluetooth availability ──
    const bleOk = WebBluetoothTransport.isSupported();
    $('bleChip').textContent = bleOk ? 'Bluetooth: available' : 'Bluetooth: unsupported';
    if (!bleOk) {
        const b = $('bleBanner');
        b.hidden = false;
        b.textContent = 'Web Bluetooth is not available in this browser or context. Use Chrome or Edge on Windows, macOS, ChromeOS or Android. You can still use Demo mode and view, export or recover stored sessions.';
    } else {
        WebBluetoothTransport.isAvailable().then(a => { if (!a) { $('bleChip').textContent = 'Bluetooth: adapter off/unavailable'; } });
    }

    // ── live view (isolated from acquisition) ──
    const chart = new LiveChart($('liveChart'), {
        onError: (e) => {
            const b = $('chartBanner'); b.hidden = false;
            b.textContent = `Live chart stopped (${e.message}). Acquisition and recording continue; check the device cards and History.`;
            log('error', 'chart: ' + e.message);
        },
    });
    service.addSink((r, entry) => chart.push(r, entry));
    service.on('devices', (list) => {
        const ids = new Set(list.map(e => e.deviceId));
        for (const s of [...chart.series.values()]) if (!ids.has(s.deviceId)) chart.removeDevice(s.deviceId);
    });
    setInterval(() => renderLatest(chart, window.__sensorlab?.controller), 500);
    $('windowSel').addEventListener('change', (e) => chart.setWindow(Number(e.target.value)));
    $('pauseBtn').addEventListener('click', () => {
        const p = !chart.paused;
        chart.setPaused(p);
        $('pauseBtn').textContent = p ? 'Resume chart' : 'Pause chart';
        $('pauseBtn').setAttribute('aria-pressed', String(p));
        $('pauseNote').hidden = !p;
    });

    // ── views ──
    const devicesView = new DevicesView({ service, clock, onSettings: (e) => openDeviceSettings(service, e) });
    devicesView.sync();
    const connectView = new ConnectView({ service, clock });
    $('addDeviceBtn').addEventListener('click', () => connectView.open());
    const history = new HistoryView({ repo, app: APP, getActiveSessionId: () => service.sessionId, onChanged: () => { checkInterrupted(repo); updateStorageStatus(); } });
    $('historyBtn').addEventListener('click', () => history.open());
    $('recoveryReview').addEventListener('click', () => history.open());
    $('helpBtn').addEventListener('click', () => openDialog($('helpDialog')));
    service.on('device', (e) => {
        if (e.conn.state === STATES.DEAD) log('error', `${e.displayName}: ${e.conn.detail?.message || e.conn.lastError?.message || 'failed'}`);
    });
    service.on('parseError', ({ entry, code }) => { if (entry.parse.invalidPackets <= 5 || entry.parse.invalidPackets % 100 === 0) log('error', `${entry.displayName}: invalid packet ${code} (total ${entry.parse.invalidPackets})`); });

    initDeviceSettings(service);

    // The chart restarts exactly when the session's time origin resets (pipeline activation), so points from
    // before and after the reset are never joined into one misleading line.
    service.on('recording', ({ recording }) => { if (recording) chart.reset(); });

    // ── recording lifecycle (confirmation → preflight → keep-awake → header → verify → record → stop) ──
    const keepAwake = createKeepAwake(window);
    const controller = new SessionController({
        service, keepAwake, clock,
        storageStatus: async () => { const s = await storageInfo(); return { ready: storageOk, error: storageOk ? null : 'IndexedDB could not be opened', usage: s.usage, quota: s.quota }; },
    });
    let recStartWall = 0;
    let lastFinal = null;
    const ACTIVE_STATES = [SESSION.STARTING, SESSION.RECORDING, SESSION.DEGRADED, SESSION.INTERRUPTED, SESSION.RECOVERING];
    const isRecordingActive = () => ACTIVE_STATES.includes(controller.state) || controller.state === SESSION.STOPPING;

    function renderPreflight(pf) {
        const fatal = $('pfFatal'), warn = $('pfWarn');
        clear(fatal); clear(warn);
        for (const f of pf.fatal) fatal.append(h('li', {}, 'Cannot start: ' + f.message));
        for (const w of pf.warnings) warn.append(h('li', {}, w.message));
        $('sessionStart').disabled = pf.fatal.length > 0 || !!controller._startPromise;
    }
    const selectedHandles = () => [...document.querySelectorAll('#recDevices input[type=checkbox]')].filter(c => c.checked).map(c => c.value);
    async function refreshPreflight() { renderPreflight(await controller.preflight(selectedHandles(), { keepAwake: $('sKeepAwake').checked })); }

    function deviceStateText(st) {
        if (st === 'STREAMING') return 'streaming';
        if (st === 'WAITING_FOR_DATA') return '⚠ connected, no data yet';
        if (st === 'DEGRADED') return '⚠ data stalled';
        return '✕ ' + st.toLowerCase();
    }

    function openRecordDialog() {
        controller.acknowledge(); // a previous terminal state (e.g. START_FAILED closed with Cancel/Escape) must not block a new start (defect S1)
        $('sessionError').textContent = '';
        $('sessionProgress').textContent = '';
        $('startFailedActions').hidden = true;
        $('sKeepAwake').checked = true; // keep-awake is ON by default for every recording
        const body = $('recDevices');
        clear(body);
        for (const e of service.list()) {
            const usable = ['WAITING_FOR_DATA', 'STREAMING', 'DEGRADED'].includes(e.conn.state);
            const iv = expectedIntervalMs(e);
            const cb = h('input', { type: 'checkbox', value: e.handle, 'aria-label': `Record ${e.displayName}` });
            cb.checked = usable;
            cb.addEventListener('change', refreshPreflight);
            body.append(h('tr', {},
                h('td', {}, cb),
                h('td', {}, e.displayName, e.simulated ? h('span', { class: 'badge tag-sim' }, ' SIMULATED') : null),
                h('td', {}, deviceStateText(e.conn.state)),
                h('td', {}, e.channels.map(c => `${c.name}${c.unit ? ' (' + c.unit + ')' : ' (no unit)'}`).join(', ') || '—'),
                h('td', {}, iv.ms === null ? 'on change' : `${fmtNum(1000 / iv.ms, 3)} Hz${iv.source.startsWith('fallback') ? ' (unknown)' : ''}`)));
        }
        if (!service.list().length) body.append(h('tr', {}, h('td', { colspan: '5', class: 'muted' }, 'No devices. Add a device or start Demo mode first.')));
        openDialog($('sessionDialog'));
        $('sName').focus();
        refreshPreflight();
    }
    $('sKeepAwake').addEventListener('change', refreshPreflight);
    $('sessionCancel').addEventListener('click', () => {
        if (controller._startPromise) { controller.stop(); return; } // cancels startup (preflight or starting); outcome shown by the submit handler
        controller.acknowledge();                                            // leaving a START_FAILED outcome (defect S1)
        closeDialog($('sessionDialog'));                                     // nothing was created
    });
    $('sessionDialog').addEventListener('cancel', (ev) => { if (controller._startPromise) { ev.preventDefault(); controller.stop(); } else controller.acknowledge(); });

    let startProgressTimer = null;
    async function submitStart() {
        if (controller._startPromise) return;                   // duplicate submission guard (UI level)
        const name = $('sName').value.trim() || 'Untitled';
        $('sessionStart').disabled = true;
        $('sessionError').textContent = '';
        $('startFailedActions').hidden = true;
        const include = selectedHandles();
        const p = controller.start({ name, group: $('sGroup').value.trim(), notes: $('sNotes').value.trim(), include, keepAwake: $('sKeepAwake').checked });
        startProgressTimer = setInterval(() => {
            if (controller.state !== SESSION.STARTING) return;
            const required = controller.startup?.requiredDevices || [];
            const verified = controller.startup?.verifiedDevices || [];
            $('sessionProgress').textContent = `Verifying devices: ${verified.length}/${required.length} have fresh valid acquisition data…`;
        }, 200);
        const res = await p;
        clearInterval(startProgressTimer);
        $('sessionProgress').textContent = '';
        if (res.ok) {
            closeDialog($('sessionDialog'));
            recStartWall = Date.now();
            lastFinal = null;
            setRecordingUi(true);
            log('session', `recording "${name}" (${res.sessionId}) verified`);
            const ka = keepAwake.status();
            if ($('sKeepAwake').checked && ka.state !== 'active') toast(`Screen keep-awake is ${ka.state.replace('_', ' ')}${ka.reason ? ' (' + ka.reason + ')' : ''}. Keep the device awake manually.`, 'warning', 9000);
            const s = await storageInfo();
            if (s.persisted === false) toast('The browser has not granted persistent storage; data could be evicted under storage pressure. Export important sessions.', 'warning', 9000);
            return;
        }
        if (res.stage === 'preflight') { renderPreflight(res.preflight); return; }
        if (res.stage === 'duplicate' || res.stage === 'state') { $('sessionError').textContent = res.error; return; }
        if (res.stage === 'cancelled') {
            controller.acknowledge();
            closeDialog($('sessionDialog'));
            toast(res.sessionId ? 'Recording start cancelled. The partial startup data is kept and labelled "startup cancelled".'
                : 'Recording start cancelled. No session was created.', 'warning');
            return;
        }
        // header or verification failure
        $('sessionError').textContent = res.stage === 'header'
            ? `Recording did not start: the session could not be saved (${res.error}). Nothing was recorded.`
            : `Recording did not start: no fresh valid data within the startup time from required channel(s) ${res.missing.join(', ')}. ` +
              'The partial data is kept in History, labelled "startup failed", for diagnosis. Check the device, untick it, or retry.';
        $('startFailedActions').hidden = false;
        log('error', $('sessionError').textContent);
    }
    $('sessionForm').addEventListener('submit', (ev) => { ev.preventDefault(); submitStart(); });
    $('startRetry').addEventListener('click', () => {
        controller.acknowledge();
        $('startFailedActions').hidden = true;
        refreshPreflight().then(() => { if (!$('sessionStart').disabled) submitStart(); });
    });
    $('startDismiss').addEventListener('click', () => { controller.acknowledge(); closeDialog($('sessionDialog')); });

    $('recordBtn').addEventListener('click', async () => {
        if (controller._stopPromise) return;                       // repeated Stop is harmless
        if (isRecordingActive()) {
            $('recordBtn').disabled = true;
            const sum = await controller.stop();
            $('recordBtn').disabled = false;
            if (sum && sum.ok) {
                lastFinal = { ok: true, text: `Finalized ✓ ${sum.persisted} readings saved (one per channel)` };
                announce(`Recording stopped and finalized. ${sum.persisted} readings saved (one per channel).`);
                toast(`Recording saved and finalized: ${sum.persisted} channel readings, ${sum.annotations} annotation(s).`, 'success', 7000);
                log('session', `stopped ${sum.sessionId}: ${sum.persisted} channel readings persisted, finalized`);
            } else if (sum) {
                const msg = `Recording stopped, but finalization FAILED: ${sum.unsaved ?? '?'} channel reading(s) unsaved${sum.lastError ? ' (' + sum.lastError.message + ')' : ''}. ${sum.persisted ?? 0} channel readings are stored; the session will appear as interrupted and can be recovered.`;
                lastFinal = { ok: false, text: 'Finalization FAILED (see History)' };
                announce(msg);
                showStorageBanner(msg);
                toast(msg, 'error', 15_000);
                log('error', msg);
            }
            controller.acknowledge();
            setRecordingUi(false);
            updateStorageStatus();
            return;
        }
        if (!storageOk) { toast('Recording is disabled because local storage is unavailable.', 'error'); return; }
        openRecordDialog();
    });

    function setRecordingUi(on) {
        $('recordBtn').textContent = on ? '■ Stop' : '● Record';
        $('recordBtn').classList.toggle('recording', on);
        $('recordBtn').setAttribute('aria-pressed', String(on));
        $('annotateBtn').disabled = !on;
        renderSession();
    }

    const STATE_LABEL = {
        IDLE: 'idle', PREFLIGHT: 'checking…',         STARTING: 'starting (verifying devices)', START_FAILED: 'startup FAILED',
        RECORDING: '● recording (all streams fresh)', DEGRADED: '▲ recording, DEGRADED', INTERRUPTED: '✕ recording, INTERRUPTED (no fresh data)',
        RECOVERING: '↻ recording, RECOVERING', STOPPING: 'stopping / finalizing…', COMPLETED: 'completed', FINALIZE_FAILED: 'finalization FAILED',
    };
    const KA_LABEL = { active: 'active', unavailable: 'unavailable', failed: 'FAILED', released: 'released (page hidden)', not_requested: 'not requested' };
    function streamProblem(s) {
        let t = `${s.deviceName} · ${s.name}: ${s.state.toLowerCase()}`;
        if (s.lastValid) t += ` (last valid ${fmtNum(s.lastValid.value)} at ${fmtNum(s.lastValid.relS, 1)} s, ${fmtNum(s.ageMs / 1000, 1)} s ago)`;
        if (s.state === 'RECOVERING' && s.retry?.attempt) t += ` attempt ${s.retry.attempt}/${s.retry.maxAttempts}`;
        if (s.state === 'DISCONNECTED') t += ' – press Retry on the device card or remove it';
        return t;
    }
    // Screen-reader announcements: only discrete changes are spoken (never the per-second counters).
    let lastAnnounced = '', prevState = controller.state, prevProblems = '', prevKa = keepAwake.status().state;
    function announce(msg) {
        if (!msg || msg === lastAnnounced) return;
        lastAnnounced = msg;
        $('srAnnounce').textContent = msg;
    }
    const SR_STATE = {
        STARTING: 'Starting recording. Verifying that each selected device delivers valid data.', RECORDING: 'Recording. All streams are fresh.',
        DEGRADED: 'Recording continues, degraded.', INTERRUPTED: 'Recording interrupted: no stream is delivering fresh data.',
        RECOVERING: 'Recording continues; reconnecting.', STOPPING: 'Stopping. Saving remaining data.', START_FAILED: 'Recording did not start.',
        FINALIZE_FAILED: 'Recording stopped but finalization failed. Not all data was saved.',
    };

    function renderSession() {
        const st = controller.state;
        const problemsNow = ACTIVE_STATES.includes(st) && st !== SESSION.STARTING
            ? controller.streamView().filter(s => s.included && !['FRESH', 'REMOVED', 'IDLE_ON_CHANGE'].includes(s.state)).map(s => `${s.deviceName} ${s.name} ${s.state.toLowerCase()}`).join('; ')
            : '';
        if (st !== prevState) { if (SR_STATE[st]) announce(SR_STATE[st] + (problemsNow ? ' Affected: ' + problemsNow + '.' : '')); prevState = st; prevProblems = problemsNow; }
        else if (problemsNow !== prevProblems) { announce(problemsNow ? 'Stream problems: ' + problemsNow + '.' : 'All streams fresh again.'); prevProblems = problemsNow; }
        const kaNow = keepAwake.status().state;
        if (kaNow !== prevKa) { if (ACTIVE_STATES.includes(st)) announce('Screen keep-awake ' + ({ active: 'active', released: 'released while the page was hidden', failed: 'failed', unavailable: 'unavailable', not_requested: 'off' }[kaNow] || kaNow) + '.'); prevKa = kaNow; }
        const el = $('sessState');
        el.textContent = STATE_LABEL[st] || st;
        el.className = [SESSION.DEGRADED, SESSION.RECOVERING].includes(st) ? 'warn' : [SESSION.INTERRUPTED, SESSION.START_FAILED, SESSION.FINALIZE_FAILED].includes(st) ? 'bad' : '';
        const ka = keepAwake.status();
        $('keepAwakeState').textContent = KA_LABEL[ka.state] || ka.state;
        $('keepAwakeState').className = ka.state === 'failed' || ka.state === 'unavailable' ? 'warn' : '';
        $('keepAwakeState').title = ka.reason || '';
        $('finalState').textContent = lastFinal ? lastFinal.text : '';
        $('finalState').className = lastFinal && !lastFinal.ok ? 'bad' : '';
        const banner = $('staleBanner');
        if (ACTIVE_STATES.includes(st) && st !== SESSION.STARTING) {
            const bad = controller.streamView().filter(s => s.included && !['FRESH', 'REMOVED', 'IDLE_ON_CHANGE'].includes(s.state));
            banner.hidden = bad.length === 0;
            banner.textContent = bad.length ? 'Stream problems (recording continues for the other streams): ' + bad.map(streamProblem).join('; ') : '';
        } else banner.hidden = true;
    }
    controller.onChange(renderSession);
    keepAwake.onChange(renderSession);
    setInterval(() => { renderSession(); renderRecStatus(recorder.status()); }, 1000);

    function renderRecStatus(s) {
        const el = $('recStatus');
        const ps = $('persistState');
        if (s.state === 'idle') {
            el.className = 'rec-status';
            el.textContent = recorder.lastSummary ? `Last: ${recorder.lastSummary.persisted} channel readings saved${recorder.lastSummary.unsaved ? ', ' + recorder.lastSummary.unsaved + ' UNSAVED' : ''}` : '';
            ps.textContent = '—'; ps.className = '';
            return;
        }
        const bad = !!s.lastError || s.droppedUnsaved > 0;
        el.className = 'rec-status' + (bad ? ' bad' : '');
        const elapsed = recStartWall ? fmtDuration((Date.now() - recStartWall) / 1000) : '';
        el.textContent = `REC ${elapsed} · channel readings saved ${s.persisted} · pending ${s.pending}` +
            (s.droppedUnsaved ? ` · DROPPED ${s.droppedUnsaved}` : '') +
            (s.lastError ? ` · STORAGE ERROR: ${s.lastError.quota ? 'disk/quota full' : s.lastError.name} (retrying)` : '');
        ps.textContent = s.lastError ? 'FAILING (retrying)' : s.droppedUnsaved ? `dropping (${s.droppedUnsaved})` : `ok (last write ${s.lastFlushWall ? new Date(s.lastFlushWall).toLocaleTimeString() : '—'})`;
        ps.className = bad ? 'bad' : '';
        if (s.lastError) showStorageBanner(`Recording is NOT being saved right now: ${s.lastError.message}. SensorLab keeps retrying; ${s.pending} channel reading(s) are waiting in memory.`);
        else if (!s.droppedUnsaved) $('storageBanner').hidden = true;
    }

    // ── annotations: time captured at button press, before typing ──
    let annCapturedMs = null;
    $('annotateBtn').addEventListener('click', () => {
        annCapturedMs = clock.now();
        $('annTime').textContent = `t = ${fmtNum((annCapturedMs - service.timeZeroMs) / 1000, 2)} s`;
        $('annText').value = '';
        openDialog($('annotateDialog'));
        $('annText').focus();
    });
    $('annotateForm').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const text = $('annText').value.trim();
        if (!text || annCapturedMs === null) return;
        const r = await service.addAnnotation(text, annCapturedMs);
        if (r.ok) { chart.addAnnotation((annCapturedMs - service.timeZeroMs) / 1000, text); toast('Annotation saved.'); }
        else toast('Annotation NOT saved: ' + r.error, 'error');
        closeDialog($('annotateDialog'));
    });

    // ── visibility (background tabs may throttle/disconnect BLE) ──
    let hiddenAt = null;
    document.addEventListener('visibilitychange', () => {
        service.noteVisibility(document.hidden);
        controller.noteVisibility(document.hidden);
        if (document.hidden) { hiddenAt = Date.now(); return; }
        if (hiddenAt && service.recording) {
            const secs = (Date.now() - hiddenAt) / 1000;
            const b = $('visibilityBanner');
            b.hidden = false;
            b.textContent = `This page was hidden for ${secs.toFixed(0)} s while recording. Browsers may throttle or drop Bluetooth in background tabs. Check the device cards for gaps. The hidden period is recorded in the session.`;
            log('warn', `page hidden ${secs.toFixed(1)} s during recording`);
        }
        hiddenAt = null;
    });
    for (const [target, ev] of [[document, 'freeze'], [document, 'resume'], [window, 'pagehide'], [window, 'pageshow']]) {
        target.addEventListener(ev, () => controller.noteLifecycle(ev));
    }
    window.addEventListener('beforeunload', (e) => {
        if (isRecordingActive()) { e.preventDefault(); e.returnValue = 'A recording is in progress. Leaving will interrupt it (saved data is kept and can be recovered).'; }
    });

    async function updateStorageStatus() {
        const s = await storageInfo();
        $('storageStatus').textContent = `Storage: ${s.usage === null ? '?' : fmtBytes(s.usage)} used${s.quota ? ' of ~' + fmtBytes(s.quota) : ''} · persistent: ${s.persisted === null ? 'unknown' : s.persisted ? 'yes' : 'no'}`;
    }

    registerServiceWorker();
    window.__sensorlab = { service, recorder, repo, chart, connectView, controller, keepAwake, installView, APP }; // debugging / automated tests
}

function applyTheme(t) {
    document.documentElement.dataset.theme = t === 'light' ? 'light' : 'dark';
    lsSet('sensorlab_theme', document.documentElement.dataset.theme);
    window.__sensorlab?.chart?.refreshTheme();
}

function showStorageBanner(msg) { const b = $('storageBanner'); b.hidden = false; b.textContent = msg; }

async function checkInterrupted(repo) {
    try {
        const list = await findInterruptedSessions(repo);
        $('recoveryBanner').hidden = list.length === 0;
        if (list.length) {
            $('recoveryText').textContent = `${list.length} recording(s) were interrupted (app closed or crashed while recording). Saved data can be recovered; data after the last save is lost.`;
            log('warn', `${list.length} interrupted session(s) found`);
        }
    } catch (e) { log('error', 'interrupted-session check failed: ' + e.message); }
}

function renderLatest(chart, controller) {
    const emptySeries = chart.emptySeries || [];
    $('liveChartEmpty').textContent = emptySeries.length
        ? `No valid ${emptySeries.map(s => s.label).join('; ')} samples in this chart window.`
        : chart.hasValidInWindow === false
            ? 'No valid sensor samples in this chart window.'
            : '';
    $('liveChartEmpty').hidden = emptySeries.length === 0 && chart.hasValidInWindow !== false;
    const body = $('latestBody');
    clear(body);
    const now = performance.now();
    const tracked = new Map((controller?.streamView() || []).map(v => [v.key, v]));
    for (const s of chart.series.values()) {
        const r = chart.latest.get(s.key);
        if (!r) continue;
        // Freshness: per stream while recording (stream-health.js); otherwise from the device's last valid packet.
        const v = tracked.get(s.key);
        let label, cls;
        if (v && v.state !== 'REMOVED') {
            label = v.state === 'FRESH' ? `fresh (${fmtNum((v.ageMs ?? 0) / 1000, 1)} s)` : `${v.state.toLowerCase()}${v.ageMs !== null ? ' ' + fmtNum(v.ageMs / 1000, 1) + ' s' : ''}`;
            cls = v.state === 'FRESH' || v.state === 'IDLE_ON_CHANGE' ? 'fresh-ok' : ['SUSPECT', 'RECOVERING', 'WAITING'].includes(v.state) ? 'fresh-warn' : 'fresh-bad';
        } else {
            const iv = expectedIntervalMs(s.entry);
            const age = s.entry.lastValidMs === null ? null : now - s.entry.lastValidMs;
            const { suspectMs, staleMs } = thresholds(iv.ms);
            const st = age === null ? 'no data' : age >= staleMs ? 'stale' : age >= suspectMs ? 'suspect' : 'fresh';
            label = `${st}${age === null ? '' : ' ' + fmtNum(age / 1000, 1) + ' s'}`;
            cls = st === 'fresh' ? 'fresh-ok' : st === 'suspect' ? 'fresh-warn' : 'fresh-bad';
        }
        const isFresh = cls === 'fresh-ok';
        // A value that is not fresh is shown as "last …", never as a current reading.
        const valueText = r.value === null ? 'invalid' : (isFresh ? fmtNum(r.value) : `last ${fmtNum(r.value)}`);
        body.append(h('tr', {},
            h('td', {}, s.entry.displayName), h('td', {}, s.name), h('td', { class: cls }, label),
            h('td', { class: 'num' }, valueText),
            h('td', {}, s.unit), h('td', { class: 'num' }, String(r.raw)), h('td', { class: 'num' }, r.seq === null ? '—' : String(r.seq)),
            h('td', {}, flagNames(r.flags).join(' ') || 'ok')));
    }
}

function initLog() {
    $('logBtn').addEventListener('click', () => {
        const p = $('logPanel'); p.hidden = !p.hidden; $('logBtn').setAttribute('aria-expanded', String(!p.hidden));
    });
    $('logClose').addEventListener('click', () => { $('logPanel').hidden = true; $('logBtn').setAttribute('aria-expanded', 'false'); $('logBtn').focus(); });
    $('logClear').addEventListener('click', () => clear($('logBody')));
    $('logCopy').addEventListener('click', () => {
        const text = [...$('logBody').children].map(li => li.textContent).join('\n');
        navigator.clipboard?.writeText(text).then(() => toast('Log copied.'), () => toast('Clipboard unavailable.', 'warning'));
    });
}

// ── device settings dialog ──
let settingsEntry = null;
function openDeviceSettings(service, e) {
    settingsEntry = e;
    $('devTitle').textContent = `Device settings: ${e.displayName}`;
    $('dName').value = e.displayName;
    const sltp = e.profile.kind === 'sltp';
    $('dRate').disabled = !sltp;
    $('dRate').value = e.info?.periodUs ? String(1e6 / e.info.periodUs) : '';
    $('rateNote').textContent = sltp ? 'The rate is confirmed by reading the device settings back. The measured rate is shown on the device card.' : 'Legacy devices do not support rate control.';
    const sel = $('calChannel');
    clear(sel);
    e.channels.forEach((c, i) => sel.append(h('option', { value: String(i) }, `${c.name}${c.unit ? ' [' + c.unit + ']' : ''}`)));
    renderCal();
    $('devMsg').textContent = '';
    openDialog($('deviceDialog'));
}
function renderCal() {
    const e = settingsEntry;
    if (!e) return;
    const i = Number($('calChannel').value || 0);
    const c = e.calibration[i];
    if (!c) return;
    $('calGain').value = String(c.gain);
    $('calOffset').value = String(c.offset);
    $('calCurrent').textContent = `Current: gain ${c.gain}, offset ${c.offset}, tare ${fmtNum(c.tare)} (version ${c.version})`;
}
function initDeviceSettings(service) {
    $('calChannel').addEventListener('change', renderCal);
    $('renameForm').addEventListener('submit', (ev) => { ev.preventDefault(); service.rename(settingsEntry.handle, $('dName').value.trim() || settingsEntry.displayName); $('devMsg').textContent = 'Renamed.'; });
    $('rateForm').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        $('devMsg').textContent = 'Sending…';
        const r = await service.setRate(settingsEntry.handle, Number($('dRate').value));
        $('devMsg').textContent = r.ok ? `Rate set and confirmed (${fmtNum(1e6 / r.info.periodUs, 3)} Hz).` : 'Rate NOT changed: ' + r.error;
        log(r.ok ? 'ble' : 'error', `${settingsEntry.displayName}: set rate → ${r.ok ? 'ok' : r.error}`);
    });
    $('calForm').addEventListener('submit', (ev) => {
        ev.preventDefault();
        const r = service.setCalibration(settingsEntry.handle, Number($('calChannel').value), { gain: Number($('calGain').value), offset: Number($('calOffset').value) });
        $('devMsg').textContent = r.ok ? 'Calibration applied (logged in the session).' : 'Not applied: ' + r.error;
        renderCal();
    });
    $('calTare').addEventListener('click', () => {
        const r = service.tare(settingsEntry.handle, Number($('calChannel').value));
        $('devMsg').textContent = r.ok ? `Tare set to ${fmtNum(r.tare)} (logged).` : 'Tare failed: ' + r.error;
        renderCal();
    });
    $('calReset').addEventListener('click', () => { service.resetCalibration(settingsEntry.handle, Number($('calChannel').value)); $('devMsg').textContent = 'Calibration reset (logged).'; renderCal(); });
}

function registerServiceWorker() {
    // file:// has no service workers (and needs none: the files are already local).
    if (!/^https?:$/.test(location.protocol)) return;
    // Web app manifest only over HTTP(S): on file:// Chrome blocks it (origin "null") and logs an error.
    document.head.append(h('link', { rel: 'manifest', href: 'manifest.webmanifest' }));
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').then(
        (reg) => log('info', `offline cache active (scope ${reg.scope})`),
        (e) => log('warn', 'service worker not registered: ' + e.message));
}

boot().catch((e) => {
    console.error(e);
    const b = document.getElementById('storageBanner');
    if (b) { b.hidden = false; b.textContent = 'SensorLab failed to start: ' + e.message; }
});
