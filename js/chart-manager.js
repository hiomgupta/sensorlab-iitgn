/**
 * Annotation plugin — registered ONCE globally as a singleton.
 * Each ChartManager instance stores its own annotations array;
 * the plugin reads from the instance attached to each chart via chart._slAnnotations.
 */
const _slAnnotationPlugin = {
    id: 'sensorlabAnnotations',
    afterDraw(chart) {
        const annotations = chart._slAnnotations;
        if (!annotations || annotations.length === 0) return;
        const { ctx, chartArea: { top, bottom }, scales: { x } } = chart;
        const annColor = getComputedStyle(document.documentElement).getPropertyValue('--annotation').trim() || '#fbbf24';
        ctx.save();
        annotations.forEach(ann => {
            const px = x.getPixelForValue(ann.x);
            if (px < x.left || px > x.right) return;
            ctx.strokeStyle = annColor;
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(px, top);
            ctx.lineTo(px, bottom);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = annColor;
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(ann.label, px, top - 4);
        });
        ctx.restore();
    }
};
Chart.register(_slAnnotationPlugin);  // ONE global registration

/**
 * ChartManager — Real-time Chart.js wrapper with pause, annotations, and calibration display.
 */
class ChartManager {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.datasets = new Map();
        this.timeWindow = 60;      // seconds visible
        this.chartType = 'line';
        this.isPaused = false;
        this.pauseOffset = 0;      // timestamp when paused
        this.annotations = [];     // [{ x, label }]
        this.yLabel = 'Value';
        this.yUnit = '';
        const cs = getComputedStyle(document.documentElement);
        const gridColor = cs.getPropertyValue('--chart-grid').trim() || 'rgba(255,255,255,0.04)';
        const tickColor = cs.getPropertyValue('--chart-tick').trim() || '#a1a1aa';
        const titleColor = cs.getPropertyValue('--chart-title').trim() || '#71717a';
        const legendColor = cs.getPropertyValue('--chart-legend').trim() || '#a1a1aa';
        this.chart = new Chart(this.canvas, {
            type: 'line',
            data: { datasets: [] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: { mode: 'nearest', intersect: false },
                scales: {
                    x: {
                        type: 'linear',
                        title: { display: true, text: 'Time (s)', color: titleColor },
                        ticks: { color: tickColor },
                        grid: { color: gridColor },
                    },
                    y: {
                        title: { display: true, text: 'Value', color: titleColor },
                        ticks: { color: tickColor },
                        grid: { color: gridColor },
                    }
                },
                plugins: {
                    legend: { labels: { color: legendColor, usePointStyle: true, pointStyle: 'circle', font: { family: 'Inter, system-ui, sans-serif', size: 11 } } },
                    tooltip: { enabled: true },
                }
            }
        });
        // Link this instance's annotations to the chart so the global plugin can read them
        this.chart._slAnnotations = this.annotations;
    }

    addDevice(deviceId, name, color) {
        if (this.datasets.has(deviceId)) return;
        const ds = {
            label: name,
            data: [],
            borderColor: color,
            backgroundColor: color + '33',
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.1,
            fill: false,
        };
        this.datasets.set(deviceId, ds);
        this.chart.data.datasets.push(ds);
        this.chart.update('none');
    }

    removeDevice(deviceId) {
        const ds = this.datasets.get(deviceId);
        if (!ds) return;
        const i = this.chart.data.datasets.indexOf(ds);
        if (i !== -1) this.chart.data.datasets.splice(i, 1);
        this.datasets.delete(deviceId);
        this.chart.update('none');
    }

    renameDevice(deviceId, name) {
        const ds = this.datasets.get(deviceId);
        if (ds) { ds.label = name; this.chart.update('none'); }
    }

    addDataPoint(deviceId, timestamp, value) {
        const ds = this.datasets.get(deviceId);
        if (!ds) return;
        const t = timestamp / 1000;
        ds.data.push({ x: t, y: value });
        // Trim data older than 5x the time window to save memory
        const cutoff = t - this.timeWindow * 5;
        while (ds.data.length > 0 && ds.data[0].x < cutoff) ds.data.shift();
        if (!this.isPaused) {
            this.chart.options.scales.x.min = t - this.timeWindow;
            this.chart.options.scales.x.max = t;
            this.chart.update('none');
        }
    }

    setYAxis(label, unit) {
        this.yLabel = label;
        this.yUnit = unit;
        this.chart.options.scales.y.title.text = unit ? `${label} (${unit})` : label;
        this.chart.update('none');
    }

    setTimeWindow(seconds) {
        this.timeWindow = seconds;
        this.chart.update('none');
    }

    setChartType(type) {
        this.chartType = type;
        this.chart.config.type = type;
        for (const ds of this.chart.data.datasets) {
            ds.pointRadius = type === 'scatter' ? 2 : 0;
        }
        this.chart.update();
    }

    // ── Pause: freeze the visible viewport ──
    togglePause() {
        this.isPaused = !this.isPaused;
        if (this.isPaused) {
            this.pauseOffset = this.chart.options.scales.x.max || (Date.now() / 1000);
        }
        return this.isPaused;
    }

    // ── Annotation markers ──
    addAnnotation(relativeTimeSec, label) {
        this.annotations.push({ x: relativeTimeSec, label: label || '' });
        this.chart.update('none');
    }

    clearAnnotations() {
        this.annotations.length = 0;
        this.chart.update('none');
    }

    reset() {
        this.chart.data.datasets.forEach(ds => ds.data = []);
        this.annotations.length = 0;
        this.isPaused = false;
        this.chart.update('none');
    }
}
