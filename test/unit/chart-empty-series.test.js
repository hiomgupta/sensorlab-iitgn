import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveChart, renderHistoryChart } from '../../src/viz/charts.js';
import { RingBuffer } from '../../src/viz/series.js';
import { Q } from '../../src/acquisition/quality.js';

class ChartStub {
    static register() {}
    constructor(_canvas, config) {
        this.data = config.data;
        this.options = config.options;
    }
    update() {}
    destroy() {}
}

test('live and history charts omit all-invalid series and retain explicit empty-series diagnostics', () => {
    const priorChart = globalThis.Chart;
    globalThis.Chart = ChartStub;
    try {
        const entry = { displayName: 'Node A' };
        const signal = {
            key: 'ble:DEV0|0', deviceId: 'ble:DEV0', channelId: 0, entry,
            unit: 'count', name: 'adc_sum16', color: '#2563eb', dash: [],
            ring: new RingBuffer(8),
        };
        signal.ring.push(0.2, 20);
        signal.ring.push(1, 21);
        const derived = {
            key: 'ble:DEV0|1', deviceId: 'ble:DEV0', channelId: 1, entry,
            unit: 'Ω', name: 'resistance', color: '#16a34a', dash: [],
            ring: new RingBuffer(8),
        };
        derived.ring.push(0.2, 100);
        derived.ring.push(1, null);

        const liveChart = Object.create(LiveChart.prototype);
        liveChart.chart = new ChartStub(null, { data: { datasets: [] }, options: {} });
        liveChart.series = new Map([[signal.key, signal], [derived.key, derived]]);
        liveChart.windowS = 0.5;
        liveChart.annotations = [];
        liveChart.maxPoints = 20;
        liveChart._structureChanged = true;
        liveChart._render();
        assert.deepEqual(liveChart.chart.data.datasets.map(s => s.label), ['Node A · adc_sum16 [count]']);
        assert.equal(Object.hasOwn(liveChart.chart.options.scales, 'y1'), false);
        assert.deepEqual(liveChart.emptySeries.map(s => s.label), ['Node A · resistance [Ω]']);

        const snapshot = {
            session: {
                devices: {
                    'ble:DEV0': {
                        deviceId: 'ble:DEV0',
                        displayName: 'Node A',
                        channels: [
                            { channelId: 0, name: 'adc_sum16', unit: 'count' },
                            { channelId: 1, name: 'resistance', unit: 'Ω' },
                        ],
                    },
                },
            },
            chunks: [{
                n: 4,
                dict: ['ble:DEV0'],
                cols: {
                    d: [0, 0, 0, 0], c: [0, 0, 1, 1], q: [0, 1, 0, 1],
                    t: [0, 1, 0, 1], h: [0, 1, 0, 1], r: [0, 1, 0, 1],
                    raw: [20, 21, 0, 0], v: [20, 21, null, null],
                    f: [0, 0, Q.INVALID, Q.INVALID],
                },
            }],
            annotations: [],
        };
        const history = renderHistoryChart(null, snapshot);
        assert.deepEqual(history.chart.data.datasets.map(s => s.label), ['Node A · adc_sum16 [count]']);
        assert.equal(Object.hasOwn(history.chart.options.scales, 'y1'), false);
        assert.deepEqual(history.stats.emptySeries, ['Node A · resistance [Ω]']);
        assert.equal(history.stats.storedReadings, 4);
    } finally {
        if (priorChart === undefined) delete globalThis.Chart;
        else globalThis.Chart = priorChart;
    }
});
