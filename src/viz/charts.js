/**
 * Chart.js adapters (Layer 5). Chart.js is vendored (vendor/chart.umd.min.js) and read from the
 * global `Chart`. There is no CDN and no network.
 *
 * LiveChart pulls from bounded ring buffers on a throttled requestAnimationFrame loop. Incoming
 * samples never trigger a redraw directly. A chart failure is reported through onError and
 * never propagates into acquisition.
 */
import { RingBuffer, decimateMinMax, axisPlan, seriesKey } from './series.js';
import { Q } from '../acquisition/quality.js';
import { iterateReadings } from '../export/export.js';

const PALETTE = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#9333ea', '#0891b2', '#ea580c', '#4b5563', '#4f46e5', '#db2777'];
const DASHES = [[], [6, 3], [2, 2], [8, 3, 2, 3]]; // second, non-colour cue per channel

let pluginRegistered = false;
function registerAnnotationPlugin() {
    if (pluginRegistered || typeof Chart === 'undefined') return;
    Chart.register({
        id: 'slAnnotations',
        afterDraw(chart, _args, opts) {
            const anns = opts?.items || [];
            if (!anns.length) return;
            const { ctx, chartArea, scales: { x } } = chart;
            const color = cssVar('--annotation') || '#b45309';
            ctx.save();
            ctx.font = '11px system-ui, sans-serif';
            ctx.textAlign = 'left';
            for (const a of anns) {
                const px = x.getPixelForValue(a.x);
                if (px < chartArea.left || px > chartArea.right) continue;
                ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
                ctx.beginPath(); ctx.moveTo(px, chartArea.top); ctx.lineTo(px, chartArea.bottom); ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = color;
                ctx.fillText(String(a.label).slice(0, 40), px + 3, chartArea.top + 12); // canvas text: never parsed as HTML
            }
            ctx.restore();
        },
    });
    pluginRegistered = true;
}

export function cssVar(name) {
    try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); } catch { return ''; }
}

function themeColors() {
    return { grid: cssVar('--chart-grid') || 'rgba(0,0,0,.08)', tick: cssVar('--chart-tick') || '#555', title: cssVar('--chart-title') || '#333' };
}

function baseOptions() {
    const c = themeColors();
    return {
        responsive: true, maintainAspectRatio: false, animation: false, normalized: true,
        interaction: { mode: 'nearest', intersect: false },
        scales: { x: { type: 'linear', title: { display: true, text: 'Time since recording/view start (s)', color: c.title }, ticks: { color: c.tick }, grid: { color: c.grid } } },
        plugins: {
            legend: { labels: { color: c.tick, usePointStyle: false, boxWidth: 24 } },
            tooltip: { enabled: true },
            slAnnotations: { items: [] },
            decimation: { enabled: false },
        },
        spanGaps: false,
    };
}

function buildScales(plan, existing) {
    const c = themeColors();
    const scales = { x: existing.x };
    for (const ax of plan) {
        scales[ax.id] = {
            type: 'linear', position: ax.position,
            title: { display: true, text: ax.unit ? `[${ax.unit}]` : '(no unit)', color: c.title },
            ticks: { color: c.tick }, grid: { color: c.grid, drawOnChartArea: ax.position === 'left' },
        };
    }
    return scales;
}

export class LiveChart {
    constructor(canvas, { capacity = 20_000, maxPointsPerSeries = 1200, fps = 8, onError } = {}) {
        registerAnnotationPlugin();
        this.canvas = canvas;
        this.capacity = capacity;
        this.maxPoints = maxPointsPerSeries;
        this.minFrameMs = 1000 / fps;
        this.onError = onError || (() => {});
        this.series = new Map();
        this.windowS = 60;
        this.paused = false;
        this.annotations = [];
        this.failed = false;
        this.dirty = false;
        this._lastFrame = 0;
        this._colorIdx = 0;
        this.latest = new Map();
        this.hasValidInWindow = false;
        try {
            this.chart = new Chart(canvas, { type: 'line', data: { datasets: [] }, options: baseOptions() });
        } catch (e) { this._fail(e); }
        this._loop = this._loop.bind(this);
        requestAnimationFrame(this._loop);
    }

    _fail(e) {
        this.failed = true;
        this.onError(e);
    }

    /** Called from the acquisition sink. O(1): it only pushes into a ring buffer. */
    push(r, entry) {
        const k = seriesKey(r.deviceId, r.channelId);
        let s = this.series.get(k);
        if (!s) {
            const ch = entry.channels[r.channelId] || {};
            const color = PALETTE[this._colorIdx++ % PALETTE.length];
            s = { key: k, deviceId: r.deviceId, channelId: r.channelId, entry, unit: ch.unit || '', name: ch.name || `ch${r.channelId}`, color, dash: DASHES[r.channelId % DASHES.length], ring: new RingBuffer(this.capacity), invalid: 0, gaps: 0 };
            this.series.set(k, s);
            this._structureChanged = true;
        }
        if (r.flags & Q.GAP_BEFORE) { s.ring.push(r.relS - 1e-9, null); s.gaps++; }
        s.ring.push(r.relS, r.value);
        if (r.value === null) s.invalid++;
        this.latest.set(k, r);
        this.dirty = true;
    }

    removeDevice(deviceId) {
        for (const [k, s] of this.series) if (s.deviceId === deviceId) { this.series.delete(k); this.latest.delete(k); }
        this._structureChanged = true;
        this.dirty = true;
    }

    reset() {
        for (const s of this.series.values()) { s.ring.clear(); s.invalid = 0; s.gaps = 0; }
        this.latest.clear();
        this.annotations = [];
        this.dirty = true;
    }

    setWindow(s) { this.windowS = s; this.dirty = true; }
    setPaused(p) { this.paused = p; this.dirty = true; }
    addAnnotation(x, label) { this.annotations.push({ x, label }); this.dirty = true; }
    refreshTheme() { this._structureChanged = true; this.dirty = true; }

    _loop(ts) {
        requestAnimationFrame(this._loop);
        if (this.failed || this.paused || !this.dirty || ts - this._lastFrame < this.minFrameMs) return;
        if (typeof document !== 'undefined' && document.hidden) return;
        this._lastFrame = ts;
        this.dirty = false;
        try { this._render(); } catch (e) { this._fail(e); }
    }

    _render() {
        const list = [...this.series.values()];
        let xmax = -Infinity;
        for (const s of list) { const lx = s.ring.lastX(); if (lx !== null && lx > xmax) xmax = lx; }
        if (!Number.isFinite(xmax)) xmax = 0;
        const x0 = Math.max(0, xmax - this.windowS);
        const windows = list.map(s => ({ series: s, ...s.ring.window(x0, xmax) }));
        const visible = windows.filter(({ ys }) => ys.some(Number.isFinite)).map(({ series }) => series);
        this.hasValidInWindow = visible.length > 0;
        this.emptySeries = windows.filter(({ ys }) => !ys.some(Number.isFinite)).map(({ series }) => ({
            key: series.key,
            label: `${series.entry.displayName} · ${series.name}${series.unit ? ' [' + series.unit + ']' : ''}`,
        }));
        const visibleKeys = visible.map(s => s.key);
        const structureChanged = this._structureChanged || !this._visibleKeys ||
            visibleKeys.length !== this._visibleKeys.length || visibleKeys.some((key, i) => key !== this._visibleKeys[i]);
        const plan = axisPlan(visible);
        const axisOf = new Map(plan.map(p => [p.unit, p.id]));
        const c = this.chart;
        if (structureChanged) {
            const opts = baseOptions();
            opts.scales = buildScales(plan, opts.scales);
            c.options = opts;
            c.data.datasets = visible.map(s => ({
                label: `${s.entry.displayName} · ${s.name}${s.unit ? ' [' + s.unit + ']' : ''}`,
                data: [], borderColor: s.color, backgroundColor: s.color, borderWidth: 1.5, borderDash: s.dash,
                pointRadius: 0, tension: 0, yAxisID: axisOf.get(s.unit), _key: s.key,
            }));
            this._structureChanged = false;
            this._visibleKeys = visibleKeys;
        }
        c.data.datasets.forEach((ds) => {
            const s = this.series.get(ds._key);
            if (!s) return;
            const { xs, ys } = windows.find(w => w.series.key === ds._key);
            ds.data = decimateMinMax(xs, ys, this.maxPoints);
        });
        c.options.scales.x.min = x0;
        c.options.scales.x.max = Math.max(xmax, x0 + 1);
        c.options.plugins.slAnnotations.items = this.annotations;
        c.update('none');
    }

    destroy() { this.failed = true; try { this.chart?.destroy(); } catch { /* ignore */ } }
}

/** Render a stored session (decimated per series). Returns { chart, stats }. */
export function renderHistoryChart(canvas, snapshot, { maxPointsPerSeries = 2000 } = {}) {
    registerAnnotationPlugin();
    const devices = snapshot.session.devices || {};
    const per = new Map();
    for (const r of iterateReadings(snapshot)) {
        const k = seriesKey(r.deviceId, r.channelId);
        let s = per.get(k);
        if (!s) {
            const d = devices[r.deviceId] || {};
            const ch = (d.channels || []).find(c => c.channelId === r.channelId) || {};
            s = { key: k, n: 0, unit: ch.unit || '', label: `${d.displayName || r.deviceId} · ${ch.name || 'ch' + r.channelId}${ch.unit ? ' [' + ch.unit + ']' : ''}`, xs: [], ys: [], channelId: r.channelId };
            per.set(k, s);
        }
        if (r.flags & Q.GAP_BEFORE) { s.xs.push(r.relS - 1e-9); s.ys.push(NaN); }
        s.xs.push(r.relS);
        s.ys.push(r.value === null ? NaN : r.value);
        s.n++;
    }
    const allSeries = [...per.values()];
    for (const s of allSeries) { // stored order is arrival order; sort per series by time for plotting
        const idx = s.xs.map((_, i) => i).sort((a, b) => s.xs[a] - s.xs[b]);
        s.xs = idx.map(i => s.xs[i]); s.ys = idx.map(i => s.ys[i]);
    }
    const list = allSeries.filter(s => s.ys.some(Number.isFinite));
    const emptySeries = allSeries.filter(s => !s.ys.some(Number.isFinite)).map(s => s.label);
    const plan = axisPlan(list);
    const axisOf = new Map(plan.map(p => [p.unit, p.id]));
    const opts = baseOptions();
    opts.scales = buildScales(plan, opts.scales);
    opts.scales.x.title.text = 'Time since recording start (s)';
    opts.plugins.slAnnotations.items = snapshot.annotations.map(a => ({ x: a.relS, label: a.text }));
    let points = 0;
    const datasets = list.map((s, i) => {
        const data = decimateMinMax(s.xs, s.ys, maxPointsPerSeries);
        points += data.length;
        return { label: s.label, data, borderColor: PALETTE[i % PALETTE.length], borderDash: DASHES[s.channelId % DASHES.length], borderWidth: 1.5, pointRadius: 0, tension: 0, yAxisID: axisOf.get(s.unit) };
    });
    const chart = new Chart(canvas, { type: 'line', data: { datasets }, options: opts });
    return { chart, stats: { series: list.length, emptySeries, renderedPoints: points, storedReadings: allSeries.reduce((a, s) => a + s.n, 0) } };
}
