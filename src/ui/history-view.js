/** History: list, recover, view, export, delete, wipe and import sessions. All keyed by sessionId. */
import { h, $, clear, toast, log, openDialog, confirmAction, downloadBlob, fmtNum, fmtBytes } from './dom.js';
import { findInterruptedSessions } from '../storage/recorder.js';
import { storageInfo, requestPersistence } from '../storage/idb-repository.js';
import {
    buildCsvParts, buildJsonParts, splitCsvFiles, utf8Length, MAX_SINGLE_DOWNLOAD_BYTES, MAX_JSON_IMPORT_BYTES, buildMetadataJson, buildAnnotationsCsv, integrityReport, safeFilename, parseExportJson, iterateReadings,
} from '../export/export.js';
import { buildZipParts } from '../export/zip.js';
import { renderHistoryChart } from '../viz/charts.js';

const STATE_LABEL = {
    open: 'recording', closed: 'complete', recovered: '⚠ recovered (interrupted)', imported: 'imported', interrupted: '⚠ interrupted – needs recovery',
    startup_failed: '✕ startup failed (diagnostic, not a recording)', startup_cancelled: 'startup cancelled',
};

export class HistoryView {
    constructor({ repo, app, getActiveSessionId, onChanged }) {
        this.repo = repo;
        this.app = app;
        this.getActiveSessionId = getActiveSessionId;
        this.onChanged = onChanged || (() => {});
        this.dialog = $('historyDialog');
        this.chart = null;
        this.current = null;
        $('histBack').addEventListener('click', () => this.showList());
        $('exCsv').addEventListener('click', () => this.export('csv'));
        $('exJson').addEventListener('click', () => this.export('json'));
        $('exZip').addEventListener('click', () => this.export('zip'));
        $('wipeBtn').addEventListener('click', () => this.wipeAll());
        $('persistBtn').addEventListener('click', async () => {
            const r = await requestPersistence();
            toast(r === true ? 'Persistent storage granted.' : r === false ? 'Browser declined persistent storage; data may be evicted under storage pressure. Export important sessions.' : 'Persistent storage API not available.', r ? 'success' : 'warning', 7000);
            this.refreshStorage();
        });
        $('importFile').addEventListener('change', (ev) => this.importFile(ev.target.files[0]).finally(() => { ev.target.value = ''; }));
        this.dialog.addEventListener('close', () => { this.chart?.destroy(); this.chart = null; });
    }

    async open() {
        openDialog(this.dialog);
        await this.showList();
    }

    async refreshStorage() {
        const s = await storageInfo();
        const txt = `Storage used: ${s.usage === null ? '?' : fmtBytes(s.usage)}${s.quota ? ' of ~' + fmtBytes(s.quota) : ''} · persistent: ${s.persisted === null ? 'unknown' : s.persisted ? 'yes' : 'no (may be evicted)'}`;
        $('histStorage').textContent = txt;
        return s;
    }

    async showList() {
        this.chart?.destroy(); this.chart = null; this.current = null;
        this._clearExportParts();
        $('histDetail').hidden = true;
        $('histListView').hidden = false;
        $('histMsg').textContent = '';
        const state = $('histState'), table = $('histTable'), body = $('histBody');
        state.textContent = 'Loading…';
        table.hidden = true;
        this.refreshStorage();
        let sessions, interrupted;
        try {
            sessions = await this.repo.listSessions();
            interrupted = new Set((await findInterruptedSessions(this.repo)).map(s => s.sessionId));
        } catch (e) {
            state.textContent = 'Could not read stored sessions: ' + e.message;
            log('error', e.message);
            return;
        }
        if (!sessions.length) { state.textContent = 'No recorded sessions yet.'; return; }
        state.textContent = `${sessions.length} session(s).`;
        sessions.sort((a, b) => String(b.startedWall).localeCompare(String(a.startedWall)));
        clear(body);
        const active = this.getActiveSessionId();
        for (const s of sessions) {
            const isInterrupted = interrupted.has(s.sessionId);
            const st = isInterrupted ? 'interrupted' : s.state;
            const devs = Object.values(s.devices || {});
            const label = `${s.name}, started ${s.startedWall ? new Date(s.startedWall).toLocaleString() : 'unknown'}`; // distinguishes same-name sessions
            const actions = h('td', {},
                isInterrupted ? h('button', { type: 'button', class: 'btn btn-sm', 'aria-label': `Recover session ${label}`, onclick: () => this.recover(s.sessionId) }, 'Recover') : null,
                h('button', { type: 'button', class: 'btn btn-sm', 'aria-label': `View session ${label}`, onclick: () => this.view(s.sessionId) }, 'View'),
                s.sessionId === active ? null : h('button', { type: 'button', class: 'btn btn-sm btn-danger', 'aria-label': `Delete session ${label}`, onclick: () => this.remove(s) }, 'Delete'));
            body.append(h('tr', {},
                h('td', {}, s.name, s.simulated ? h('span', { class: 'badge tag-sim' }, ' SIMULATED') : null),
                h('td', {}, s.startedWall ? new Date(s.startedWall).toLocaleString() : '—'),
                h('td', {}, s.sessionId === active ? 'recording now' : (STATE_LABEL[st] || st)),
                h('td', { class: 'num' }, String(s.storage?.readingsPersisted ?? '?')),
                h('td', {}, devs.map(d => d.displayName).join(', ') || '—'),
                actions));
        }
        table.hidden = false;
    }

    async recover(id) {
        try {
            const s = await this.repo.recoverSession(id, new Date().toISOString());
            toast(`Recovered "${s.name}": ${s.recovery.persistedReadings} channel readings were saved before the interruption. Later data was lost.`, 'warning', 8000);
            log('session', `recovered ${id}`);
            this.onChanged();
            await this.showList();
        } catch (e) { toast('Recovery failed: ' + e.message, 'error'); }
    }

    async remove(s) {
        const ok = await confirmAction(`Delete session "${s.name}" (${s.storage?.readingsPersisted ?? '?'} channel readings, started ${s.startedWall ? new Date(s.startedWall).toLocaleString() : '?'})? This cannot be undone. Other sessions with the same name are not affected.`, { okLabel: 'Delete' });
        if (!ok) return;
        try { await this.repo.deleteSession(s.sessionId); toast('Session deleted.'); log('session', `deleted ${s.sessionId}`); }
        catch (e) { toast('Delete failed: ' + e.message, 'error'); }
        await this.showList();
        this.onChanged();
    }

    async wipeAll() {
        if (this.getActiveSessionId()) { toast('Stop the current recording first.', 'warning'); return; }
        const ok = await confirmAction('Delete ALL recorded sessions stored in this browser profile? Export anything you need first. This cannot be undone.', { typed: true, okLabel: 'Delete all' });
        if (!ok) return;
        try { await this.repo.wipeAll(); toast('All sessions deleted.'); log('session', 'wiped all sessions'); }
        catch (e) { toast('Wipe failed: ' + e.message, 'error'); }
        await this.showList();
        this.onChanged();
    }

    async view(id) {
        $('histMsg').textContent = '';
        let snap;
        try { snap = await this.repo.readSnapshot(id); } catch (e) { $('histMsg').textContent = 'Could not load session: ' + e.message; return; }
        if (!snap) { $('histMsg').textContent = 'Session not found.'; return; }
        this.current = snap;
        this._clearExportParts();
        $('histListView').hidden = true;
        $('histDetail').hidden = false;
        const s = snap.session;
        $('detailTitle').textContent = s.name;
        const integ = integrityReport(snap);
        const warn = $('detailWarnings');
        clear(warn);
        for (const w of integ.warnings) warn.append(h('li', {}, w));
        if (s.recovery?.note) warn.append(h('li', {}, s.recovery.note));
        if (s.provenance?.nameCollision) warn.append(h('li', {}, s.provenance.nameCollision));
        const meta = $('detailMeta');
        clear(meta);
        const add = (k, v) => meta.append(h('dt', {}, k), h('dd', {}, v ?? '—'));
        add('Session ID', s.sessionId);
        add('Group', s.group);
        add('Notes', s.notes);
        add('Started', s.startedWall && new Date(s.startedWall).toLocaleString());
        add('Ended', s.endedWall && new Date(s.endedWall).toLocaleString());
        add('State', s.state);
        add('Readings stored', String(integ.readingCount));
        add('Storage', s.storage ? `${s.storage.chunks ?? '?'} chunks, ${s.storage.writeErrors ?? 0} write errors, persistent storage: ${s.storage.persistGranted ?? 'unknown'}` : '—');
        add('Page hidden during recording', (s.visibility || []).length ? (s.visibility || []).map(v => `${fmtNum(v.hiddenAtRelS, 1)}–${fmtNum(v.visibleAtRelS, 1)} s`).join(', ') : 'never');
        add('App', `${s.app?.version ?? '?'} (${s.app?.build ?? '?'})`);
        add('Keep screen awake', s.lifecycle?.keepAwake ? `${s.lifecycle.keepAwake.state}${s.lifecycle.keepAwake.reason ? ' (' + s.lifecycle.keepAwake.reason + ')' : ''}` : '—');
        const lev = s.lifecycle?.events || [];
        add('Lifecycle events', lev.length ? lev.filter(e => !['session_state'].includes(e.type)).slice(-12).map(e => `${e.t === null ? '' : fmtNum(e.t, 1) + ' s '}${e.type}${e.name ? ' ' + e.name : ''}${e.to ? ' → ' + e.to : ''}`).join(' · ') : 'none recorded');
        const q = $('detailQuality');
        clear(q);
        for (const d of Object.values(s.devices || {})) {
            const qq = s.quality?.[d.deviceId];
            const st = qq?.stream;
            const legacy = String(d.protocol).startsWith('legacy');
            const iv = st?.deviceIntervalUs?.n ? `${fmtNum(st.deviceIntervalUs.mean / 1000, 3)} ± ${fmtNum((st.deviceIntervalUs.std ?? 0) / 1000, 3)}` : (st?.hostIntervalMs?.n ? `${fmtNum(st.hostIntervalMs.mean, 2)} ± ${fmtNum(st.hostIntervalMs.std ?? 0, 2)} (host)` : '—');
            q.append(h('tr', {},
                h('td', {}, d.displayName, h('div', { class: 'dev-id' }, d.deviceId)),
                h('td', {}, d.protocol), h('td', { class: 'num' }, String(st?.received ?? '—')),
                h('td', { class: 'num' }, legacy ? 'n/a' : String(st?.missing ?? '—')),
                h('td', { class: 'num' }, legacy ? 'n/a' : `${st?.gapCount ?? '—'} (${st?.longestGap ?? '—'})`),
                h('td', { class: 'num' }, legacy ? 'n/a' : `${st?.duplicates ?? '—'} / ${st?.outOfOrder ?? '—'}`),
                h('td', { class: 'num' }, String(qq?.invalidPackets ?? '—')),
                h('td', { class: 'num' }, String(qq?.invalidSamples ?? '—')),
                h('td', { class: 'num' }, iv),
                h('td', { class: 'num' }, st?.measuredRateHz ? fmtNum(st.measuredRateHz, 2) : '—'),
                h('td', { class: 'num' }, String(qq?.connection?.disconnects ?? '—'))));
        }
        // Text alternative for the chart: per-series numerical summary
        const sb = $('detailSeriesBody');
        clear(sb);
        const per = new Map();
        for (const r of iterateReadings(snap)) {
            const k = r.deviceId + '|' + r.channelId;
            let a = per.get(k);
            if (!a) { a = { n: 0, invalid: 0, min: Infinity, max: -Infinity, first: Infinity, last: -Infinity, deviceId: r.deviceId, channelId: r.channelId }; per.set(k, a); }
            a.n++;
            if (r.value === null) a.invalid++; else { if (r.value < a.min) a.min = r.value; if (r.value > a.max) a.max = r.value; }
            if (r.relS < a.first) a.first = r.relS;
            if (r.relS > a.last) a.last = r.relS;
        }
        for (const a of per.values()) {
            const d = s.devices?.[a.deviceId] || {};
            const ch = (d.channels || []).find(c => c.channelId === a.channelId) || {};
            sb.append(h('tr', {}, h('td', {}, `${d.displayName || a.deviceId} · ${ch.name || 'ch' + a.channelId}`), h('td', {}, ch.unit || ''),
                h('td', { class: 'num' }, String(a.n)), h('td', { class: 'num' }, String(a.invalid)),
                h('td', { class: 'num' }, a.min === Infinity ? '—' : fmtNum(a.min)), h('td', { class: 'num' }, a.max === -Infinity ? '—' : fmtNum(a.max)),
                h('td', { class: 'num' }, fmtNum(a.first, 3)), h('td', { class: 'num' }, fmtNum(a.last, 3))));
        }
        const anns = $('detailAnnotations');
        clear(anns);
        if (!snap.annotations.length) anns.append(h('li', { class: 'muted' }, 'None'));
        for (const a of snap.annotations) anns.append(h('li', {}, h('strong', {}, `${fmtNum(a.relS, 2)} s`), a.text));
        this.chart?.destroy();
        try {
            const t0 = performance.now();
            const { chart, stats } = renderHistoryChart($('historyChart'), snap);
            this.chart = chart;
            const omitted = stats.emptySeries.length
                ? ` No valid samples for ${stats.emptySeries.join('; ')}; those series are omitted from the chart.`
                : '';
            const empty = stats.series === 0 && stats.emptySeries.length === 0 ? ' No valid channel samples are available to plot.' : '';
            $('detailChartNote').textContent = `Chart shows ${stats.renderedPoints} decimated points (min/max per bucket, gaps preserved) from ${stats.storedReadings} stored readings (one row per channel) across ${stats.series} plotted series, rendered in ${Math.round(performance.now() - t0)} ms.${omitted}${empty} Exports always contain every stored reading.`;
        } catch (e) {
            $('detailChartNote').textContent = 'Chart could not be drawn (' + e.message + '). Stored data and exports are unaffected.';
        }
    }

    async export(kind) {
        if (!this.current) return;
        // A new export replaces any parts panel left by a previous one (stale "Save part" buttons of another format).
        this._clearExportParts();
        // Re-read a consistent snapshot from storage at export time (not the chart, not a cached copy).
        let snap;
        try { snap = await this.repo.readSnapshot(this.current.session.sessionId); } catch (e) { toast('Export failed: ' + e.message, 'error'); return; }
        const s = snap.session;
        const base = `${safeFilename(s.name)}_${(s.startedWall || '').slice(0, 19).replace(/[:T]/g, '-')}_${s.sessionId.slice(0, 8)}`;
        const integ = integrityReport(snap);
        try {
            // Exports are built as bounded parts (never one giant string; see export.js/zip.js) and handed to the browser.
            // Files above MAX_SINGLE_DOWNLOAD_BYTES are not handed over as one download: the browser cancels them silently.
            const limit = MAX_SINGLE_DOWNLOAD_BYTES;
            let blob, name, csv = null;
            if (kind === 'csv' || kind === 'zip') {
                csv = buildCsvParts(snap).parts;
                const csvBytes = csv.reduce((a, p) => a + utf8Length(p), 0);
                if (csvBytes > limit) { this._offerParts(kind, snap, base, csv, csvBytes, integ); return; }
            }
            if (kind === 'csv') {
                blob = new Blob(csv, { type: 'text/csv;charset=utf-8' }); name = base + '.csv';
            } else if (kind === 'json') {
                const { parts } = buildJsonParts(snap, { app: this.app });
                const bytes = parts.reduce((a, p) => a + utf8Length(p), 0);
                if (bytes > limit) {
                    const msg = `JSON export not started: it would be ${fmtBytes(bytes)}, above the ${fmtBytes(limit)} the browser reliably saves as one file, and JSON cannot be split. Use CSV or ZIP, which are saved in parts. The session is safe in local storage.`;
                    toast(msg, 'error', 15_000);
                    log('error', msg);
                    return;
                }
                blob = new Blob(parts, { type: 'application/json;charset=utf-8' }); name = base + '.json';
            } else {
                const parts = buildZipParts([
                    { name: 'readings.csv', data: csv },
                    { name: 'metadata.json', data: buildMetadataJson(snap, { app: this.app }) },
                    { name: 'annotations.csv', data: buildAnnotationsCsv(snap) },
                ]);
                blob = new Blob(parts, { type: 'application/zip' }); name = base + '.zip';
            }
            downloadBlob(blob, name);
            log('export', `${kind.toUpperCase()} ${integ.readingCount} readings, ${fmtBytes(blob.size)} handed to the browser (${name})`);
            // The page can only START a download; the browser saves the file. Say exactly that (a cancelled or failed
            // browser download cannot be observed from the page).
            const what = `${integ.readingCount} readings (${fmtBytes(blob.size)}) handed to the browser to save as ${name}. Check the browser's downloads.`;
            if (!integ.complete) toast('Export prepared, with warnings: ' + integ.warnings.filter(w => !/SIMULATED|legacy protocol/.test(w)).join(' ') + ' ' + what, 'warning', 12_000);
            else toast('Export prepared: ' + what, 'success', 8000);
        } catch (e) {
            toast('Export failed (no file written): ' + e.message, 'error', 10_000);
            log('error', 'export failed: ' + e.message);
        }
    }

    _clearExportParts() { const el = $('exportParts'); if (el) { clear(el); el.hidden = true; } }

    /**
     * Large export: offer the parts one at a time. Each part is built and handed to the browser only when its button is
     * clicked, so only one large download is in flight (overlapping large downloads were cancelled by the browser), and
     * each save is a user gesture (no "multiple downloads" prompt).
     */
    _offerParts(kind, snap, base, csvParts, csvBytes, integ) {
        const files = splitCsvFiles(csvParts, MAX_SINGLE_DOWNLOAD_BYTES);
        const n = files.length;
        const width = Math.max(2, String(n).length);
        const pad = (k) => String(k).padStart(width, '0');
        const el = $('exportParts');
        clear(el);
        el.append(h('p', {}, `This ${kind.toUpperCase()} export is ${fmtBytes(csvBytes)} (${integ.readingCount} readings), more than the browser reliably saves as one file, so it is split into ${n} parts. ` +
            'Each part is a complete CSV with the header; rows are in order and together they are the whole session. ' +
            "Save one part at a time: wait until each shows as completed in the browser's downloads, then a few more seconds, before saving the next."));
        const row = h('div', { class: 'export-parts-buttons' });
        files.forEach((f, i) => {
            const tag = `part${pad(i + 1)}of${pad(n)}`;
            const label = `Save part ${i + 1} of ${n} (${f.rows} rows, ${fmtBytes(f.bytes)})`;
            const btn = h('button', { type: 'button', class: 'btn btn-sm', 'aria-label': `${label}, ${kind.toUpperCase()}` }, label);
            btn.addEventListener('click', () => {
                try {
                    let blob, name;
                    if (kind === 'csv') {
                        blob = new Blob(f.parts, { type: 'text/csv;charset=utf-8' });
                        name = `${base}_${tag}.csv`;
                    } else {
                        blob = new Blob(buildZipParts([
                            { name: `readings_${tag}.csv`, data: f.parts },
                            { name: 'metadata.json', data: buildMetadataJson(snap, { app: this.app }) },
                            { name: 'annotations.csv', data: buildAnnotationsCsv(snap) },
                        ]), { type: 'application/zip' });
                        name = `${base}_${tag}.zip`;
                    }
                    downloadBlob(blob, name);
                    btn.textContent = `Part ${i + 1} of ${n} handed to the browser ✓ (save again)`;
                    log('export', `${kind.toUpperCase()} part ${i + 1}/${n}: ${f.rows} rows, ${fmtBytes(blob.size)} handed to the browser (${name})`);
                    toast(`Part ${i + 1} of ${n} (${fmtBytes(blob.size)}) handed to the browser to save as ${name}. Wait for it to complete before saving the next part.`, 'success', 8000);
                } catch (e) { toast('Export part failed (no file written): ' + e.message, 'error', 10_000); }
            });
            row.append(btn);
        });
        el.append(row);
        el.hidden = false;
        log('export', `${kind.toUpperCase()} export of ${fmtBytes(csvBytes)} offered in ${n} parts`);
        toast(`Large export: saved in ${n} parts. Use the "Save part" buttons below the session title, one at a time.`, 'warning', 12_000);
        row.firstChild?.focus();
    }

    async importFile(file) {
        if (!file) return;
        if (!Number.isFinite(file.size) || file.size > MAX_JSON_IMPORT_BYTES) {
            toast(`Import failed: JSON session files are limited to ${fmtBytes(MAX_JSON_IMPORT_BYTES)}.`, 'error', 8000);
            return;
        }
        let text;
        try { text = await file.text(); }
        catch (e) { toast('Import failed: could not read the selected file: ' + e.message, 'error', 8000); return; }
        const r = parseExportJson(text);
        if (!r.ok) { toast('Import failed: ' + r.error, 'error', 8000); return; }
        const snap = r.snapshot;
        try {
            const existing = await this.repo.getSession(snap.session.sessionId);
            if (existing) { toast('That session is already stored (same session ID). Nothing imported.', 'warning'); return; }
            const originalState = snap.session.state;
            snap.session.state = 'imported';
            snap.session.provenance = {
                ...(snap.session.provenance || {}),
                importedFrom: `JSON export file "${file.name}"`,
                importedWall: new Date().toISOString(),
                originalState,
            };
            await this.repo.importSnapshot(snap);
            toast(`Imported "${snap.session.name}" (${snap.chunks.reduce((x, c) => x + c.n, 0)} readings).`, 'success');
        } catch (e) { toast('Import failed (no partial session was stored): ' + e.message, 'error', 10_000); }
        await this.showList();
    }
}
