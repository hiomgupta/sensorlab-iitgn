/**
 * Calibration model (per channel). Raw values are never modified.
 *
 *   engineering = raw · deviceScale + deviceOffset      (from SLTP INFO, or legacy scale factor)
 *   value       = engineering · gain + offset − tare    (user calibration, versioned)
 *
 * Tare is a defined operation: the mean of the most recent valid engineering values (after
 * gain/offset) over a bounded window, so that the current reading becomes zero.
 */
export const CALIBRATION_MODEL = 'linear-gain-offset-tare/1';

export function identityCalibration() {
    return { gain: 1, offset: 0, tare: 0, version: 0, model: CALIBRATION_MODEL };
}

export function toEngineering(raw, scale = 1, offset = 0) { return raw * scale + offset; }

export function applyCalibration(eng, cal) { return eng * cal.gain + cal.offset - cal.tare; }

export function validateCalibration({ gain, offset }) {
    if (typeof gain !== 'number' || !Number.isFinite(gain) || gain === 0) return 'gain must be a finite non-zero number';
    if (typeof offset !== 'number' || !Number.isFinite(offset)) return 'offset must be a finite number';
    return null;
}

/**
 * Compute a tare from recent samples.
 * @param {{hostMs:number, eng:number}[]} recent valid samples, oldest first
 * @param cal current calibration
 * @param nowMs host monotonic time
 * @returns {{ok:true, tare:number, n:number} | {ok:false, error:string}}
 */
export function computeTare(recent, cal, nowMs, { windowMs = 1000, minSamples = 3 } = {}) {
    const inWin = recent.filter(s => nowMs - s.hostMs <= windowMs && Number.isFinite(s.eng));
    if (inWin.length < minSamples) return { ok: false, error: `need ≥ ${minSamples} valid samples in the last ${windowMs / 1000} s (have ${inWin.length})` };
    const mean = inWin.reduce((a, s) => a + (s.eng * cal.gain + cal.offset), 0) / inWin.length;
    return { ok: true, tare: mean, n: inWin.length };
}

/** Two-point linear calibration from (engineering, reference) pairs. */
export function twoPointCalibration(e1, r1, e2, r2) {
    if (![e1, r1, e2, r2].every(Number.isFinite)) return { ok: false, error: 'all points must be finite numbers' };
    if (e1 === e2) return { ok: false, error: 'the two measured values must differ' };
    const gain = (r2 - r1) / (e2 - e1);
    if (gain === 0) return { ok: false, error: 'reference values must differ' };
    return { ok: true, gain, offset: r1 - gain * e1 };
}
