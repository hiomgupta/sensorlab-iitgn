import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLegacy } from '../../src/protocol/legacy.js';

const txt = (s) => new TextEncoder().encode(s);

test('text-float: strict numbers only', () => {
    assert.deepEqual(parseLegacy(txt('4523.17'), 'text-float').values, [4523.17]);
    assert.deepEqual(parseLegacy(txt(' -1.5e3\r\n'), 'text-float').values, [-1500]);
    assert.equal(parseLegacy(txt('12abc'), 'text-float').error.code, 'NOT_A_NUMBER'); // parseFloat would accept this
    assert.equal(parseLegacy(txt('NaN'), 'text-float').error.code, 'NOT_A_NUMBER');
    assert.equal(parseLegacy(txt('Infinity'), 'text-float').error.code, 'NOT_A_NUMBER');
    assert.equal(parseLegacy(new Uint8Array(0), 'text-float').error.code, 'EMPTY');
});

test('text-csv: all fields must parse; no silent filtering', () => {
    assert.deepEqual(parseLegacy(txt('1,2.5,-3'), 'text-csv').values, [1, 2.5, -3]);
    assert.equal(parseLegacy(txt('1,,3'), 'text-csv').error.code, 'NOT_A_NUMBER');
    assert.equal(parseLegacy(txt('1,x,3'), 'text-csv').error.code, 'NOT_A_NUMBER');
});

test('text-json shapes; ambiguous objects rejected', () => {
    assert.deepEqual(parseLegacy(txt('3.5'), 'text-json').values, [3.5]);
    assert.deepEqual(parseLegacy(txt('{"value":2}'), 'text-json').values, [2]);
    assert.deepEqual(parseLegacy(txt('{"v":2}'), 'text-json').values, [2]);
    assert.deepEqual(parseLegacy(txt('{"values":[1,2]}'), 'text-json').values, [1, 2]);
    assert.deepEqual(parseLegacy(txt('[1,2,3]'), 'text-json').values, [1, 2, 3]);
    assert.equal(parseLegacy(txt('{"temp":2,"hum":3}'), 'text-json').error.code, 'UNRECOGNIZED_JSON_SHAPE');
    assert.equal(parseLegacy(txt('[1,"a"]'), 'text-json').error.code, 'NOT_A_NUMBER');
    assert.equal(parseLegacy(txt('{bad'), 'text-json').error.code, 'BAD_JSON');
});

test('binary formats: exact length, endianness, signedness', () => {
    assert.deepEqual(parseLegacy(Uint8Array.of(0x34, 0x12), 'uint16-le').values, [0x1234]);
    assert.deepEqual(parseLegacy(Uint8Array.of(0x12, 0x34), 'uint16-be').values, [0x1234]);
    assert.deepEqual(parseLegacy(Uint8Array.of(0xff, 0xff), 'int16-le').values, [-1]);
    assert.deepEqual(parseLegacy(Uint8Array.of(0x00, 0x00, 0x80, 0x3f), 'float32-le').values, [1]);
    assert.deepEqual(parseLegacy(Uint8Array.of(87), 'uint8').values, [87]);
    // Baseline bug: Battery Level (1 byte) parsed as uint16 threw RangeError inside the BLE handler.
    assert.equal(parseLegacy(Uint8Array.of(87), 'uint16-le').error.code, 'LENGTH_MISMATCH');
    assert.equal(parseLegacy(Uint8Array.of(0, 0, 0xc0, 0x7f), 'float32-le').error.code, 'NON_FINITE');
});

test('GATT heart rate measurement: uint8 and uint16 forms', () => {
    assert.deepEqual(parseLegacy(Uint8Array.of(0x00, 72), 'gatt-heart-rate').values, [72]);
    assert.deepEqual(parseLegacy(Uint8Array.of(0x01, 0x2c, 0x01), 'gatt-heart-rate').values, [300]);
    assert.equal(parseLegacy(Uint8Array.of(0x01, 0x2c), 'gatt-heart-rate').error.code, 'TOO_SHORT');
});

test('unknown format and non-bytes are explicit errors', () => {
    assert.equal(parseLegacy(txt('1'), 'bogus').error.code, 'UNKNOWN_FORMAT');
    assert.equal(parseLegacy('1', 'text-float').error.code, 'NOT_BYTES');
});
