import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RingBuffer, decimateMinMax, axisPlan, seriesKey } from '../../src/viz/series.js';

test('ring buffer is bounded and keeps the newest points', () => {
    const r = new RingBuffer(5);
    for (let i = 0; i < 12; i++) r.push(i, i * 10);
    assert.equal(r.length, 5);
    assert.deepEqual(r.get(0), [7, 70]);
    assert.equal(r.lastX(), 11);
    r.push(12, null);
    assert.ok(Number.isNaN(r.get(4)[1]));
    assert.deepEqual(r.window(9, 10).xs, [9, 10]);
});

test('decimation preserves extremes and is bounded', () => {
    const xs = [], ys = [];
    for (let i = 0; i < 100_000; i++) { xs.push(i); ys.push(Math.sin(i / 1000)); }
    ys[54321] = 50; ys[777] = -50; // spikes must survive
    const d = decimateMinMax(xs, ys, 900);
    assert.ok(d.length <= 900 + 3);
    assert.ok(d.some(p => p.y === 50));
    assert.ok(d.some(p => p.y === -50));
    for (let i = 1; i < d.length; i++) assert.ok(d[i].x >= d[i - 1].x, 'x order preserved');
});

test('decimation keeps gaps as null points (lines never bridge missing data)', () => {
    const xs = [], ys = [];
    for (let i = 0; i < 10_000; i++) { xs.push(i); ys.push(i >= 5000 && i < 5010 ? NaN : 1); }
    const d = decimateMinMax(xs, ys, 300);
    assert.ok(d.some(p => p.y === null && p.x >= 5000 && p.x < 5010));
    const small = decimateMinMax([0, 1, 2], [1, NaN, 3], 10);
    assert.deepEqual(small, [{ x: 0, y: 1 }, { x: 1, y: null }, { x: 2, y: 3 }]);
});

test('series are keyed by device AND channel; units get separate axes', () => {
    assert.notEqual(seriesKey('ble:A', 0), seriesKey('ble:B', 0));
    assert.notEqual(seriesKey('ble:A', 0), seriesKey('ble:A', 1));
    const plan = axisPlan([{ unit: 'Ω' }, { unit: '°C' }, { unit: 'Ω' }]);
    assert.deepEqual(plan.map(p => p.unit), ['Ω', '°C']);
    assert.deepEqual(plan.map(p => p.position), ['left', 'right']);
});
