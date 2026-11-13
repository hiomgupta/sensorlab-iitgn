/** Per-device health cards: identity, lifecycle state, rates and quality counters. */
import { h, $, clear, fmtNum } from './dom.js';
import { STATES } from '../acquisition/device-connection.js';

const STATE_TEXT = {
    IDLE: '○ Idle', CONNECTING: '◌ Connecting', DISCOVERING: '◌ Discovering', SUBSCRIBING: '◌ Subscribing',
    WAITING_FOR_DATA: '◔ Waiting for data', STREAMING: '● Streaming', DEGRADED: '▲ Degraded',
    DISCONNECTED: '✕ Disconnected', BACKOFF: '↻ Reconnecting', DEAD: '✕ Failed', CLOSED: '✕ Closed',
};

export class DevicesView {
    constructor({ service, clock, onSettings }) {
        this.service = service;
        this.clock = clock;
        this.onSettings = onSettings;
        this.cards = new Map();
        this.list = $('deviceList');
        service.on('devices', () => this.sync());
        service.on('device', (e) => this.update(e));
        setInterval(() => { for (const e of service.list()) this.update(e); }, 1000);
    }

    sync() {
        const live = new Set(this.service.list().map(e => e.handle));
        for (const [k, c] of this.cards) if (!live.has(k)) { c.root.remove(); this.cards.delete(k); }
        for (const e of this.service.list()) if (!this.cards.has(e.handle)) this._create(e);
        $('noDevices').hidden = this.cards.size > 0;
        $('simBanner').hidden = !this.service.list().some(e => e.simulated);
    }

    _create(e) {
        const name = h('span', { class: 'dev-name' });
        const badge = h('span', { class: 'badge' });
        const sim = e.simulated ? h('span', { class: 'badge tag-sim', title: 'Simulated device' }, 'SIMULATED') : null;
        const id = h('div', { class: 'dev-id' });
        const metrics = h('dl', { class: 'metrics' });
        const err = h('div', { class: 'dev-err', hidden: true });
        const retry = h('button', { type: 'button', class: 'btn btn-sm', hidden: true, onclick: () => this.service.retry(e.handle) }, 'Retry');
        const settings = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => this.onSettings(e) }, 'Settings');
        const remove = h('button', { type: 'button', class: 'btn btn-sm btn-danger', onclick: () => this.service.removeDevice(e.handle) }, 'Remove');
        const root = h('li', { class: 'device' + (e.simulated ? ' sim' : '') },
            h('div', { class: 'dev-head' }, name, h('span', { class: 'spacer' }), sim, badge),
            id, metrics, err, h('div', { class: 'dev-actions' }, retry, settings, remove));
        this.list.append(root);
        const c = { root, name, badge, id, metrics, err, retry, settings, remove };
        this.cards.set(e.handle, c);
        this.update(e);
    }

    update(e) {
        const c = this.cards.get(e.handle);
        if (!c) { this.sync(); return; }
        const st = e.conn.state;
        c.name.textContent = e.displayName;
        // device-specific accessible names: several cards each have Retry/Settings/Remove buttons
        c.retry.setAttribute('aria-label', `Retry connecting ${e.displayName}`);
        c.settings.setAttribute('aria-label', `Settings for ${e.displayName}`);
        c.remove.setAttribute('aria-label', `Remove ${e.displayName}`);
        c.root.setAttribute('aria-label', `Device ${e.displayName}`);
        c.name.title = e.displayName;
        c.badge.textContent = STATE_TEXT[st] || st;
        c.badge.className = 'badge st-' + st;
        c.id.textContent = (e.deviceId || e.handle) + (e.profile.kind === 'sltp' ? ` · fw ${e.info?.firmware ?? '?'}` : ` · legacy ${e.profile.format}`);
        const s = e.tracker.snapshot();
        const now = this.clock.now();
        const age = e.lastValidMs === null ? null : (now - e.lastValidMs) / 1000;
        const cfgRate = e.info?.periodUs ? 1e6 / e.info.periodUs : null;
        const legacy = e.profile.kind !== 'sltp';
        const rows = [
            ['Last valid data', age === null ? 'never' : `${age.toFixed(1)} s ago`, age !== null && age > 3],
            ['Configured rate', cfgRate ? `${fmtNum(cfgRate, 2)} Hz` : (legacy ? 'unknown (legacy)' : '—')],
            ['Measured rate', s.measuredRateHz ? `${fmtNum(s.measuredRateHz, 2)} Hz` + (legacy ? ' (host clock)' : '') : '—'],
            ['Packets received', String(s.received)],
            ['Missing', legacy ? 'not detectable' : `${s.missing} in ${s.gapCount} gap(s)`, s.missing > 0],
            ['Dup / late', legacy ? '—' : `${s.duplicates} / ${s.outOfOrder}`],
            ['Invalid packets', String(e.parse.invalidPackets), e.parse.invalidPackets > 0],
            ['Invalid samples', String(e.invalidSamples), e.invalidSamples > 0],
            ['Disconnects / reconnects', `${e.conn.counters.disconnects} / ${e.conn.counters.reconnects}`],
        ];
        if (st === STATES.BACKOFF && e.conn.nextRetryAtMs) rows.push(['Next retry', `in ${Math.max(0, (e.conn.nextRetryAtMs - now) / 1000).toFixed(1)} s (attempt ${e.conn.detail?.attempt}/${e.conn.detail?.maxAttempts})`]);
        clear(c.metrics);
        for (const [k, v, bad] of rows) c.metrics.append(h('dt', {}, k), h('dd', { class: bad ? 'bad' : '' }, v));
        const errText = st === STATES.DEAD || st === STATES.DEGRADED || st === STATES.BACKOFF
            ? (e.conn.detail?.message || e.conn.lastError?.message || '')
            : (e.parse.last ? `Last parse error: ${e.parse.last.code}` : '');
        c.err.hidden = !errText;
        c.err.textContent = errText;
        c.retry.hidden = !(st === STATES.DEAD || st === STATES.BACKOFF);
    }
}
