/**
 * One-time import of sessions recorded by SensorLab 1.x (IndexedDB "SensorLabDB", keyed by
 * session NAME). The old database is opened read-only and never modified or deleted.
 *
 * Old sessions sharing a display name were merged by the old app. Here their readings are split
 * by start-time ranges, and the result is flagged as a heuristic so it is never presented as
 * certain. All imported readings are HOST_TIME_ONLY: the old app had no sequence numbers or
 * device timestamps.
 */
import { Q } from '../acquisition/quality.js';

export const LEGACY_DB = 'SensorLabDB';

function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

/** Open the legacy DB only if it exists (never create it). */
export async function openLegacyDb(idb = globalThis.indexedDB) {
    if (!idb) return null;
    if (idb.databases) {
        try {
            const dbs = await idb.databases();
            if (!dbs.some(d => d.name === LEGACY_DB)) return null;
        } catch { /* fall through to guarded open */ }
    }
    return new Promise((resolve) => {
        let created = false;
        const r = idb.open(LEGACY_DB);
        r.onupgradeneeded = () => { created = true; r.transaction.abort(); }; // it did not exist: undo creation
        r.onsuccess = () => resolve(created ? null : r.result);
        r.onerror = () => resolve(null);
        r.onblocked = () => resolve(null);
    });
}

export async function readLegacy(db) {
    const names = [...db.objectStoreNames];
    const tx = db.transaction(names.filter(n => ['sessions', 'recordings', 'annotations'].includes(n)), 'readonly');
    const get = (s) => names.includes(s) ? req(tx.objectStore(s).getAll()) : Promise.resolve([]);
    const [sessions, recordings, annotations] = await Promise.all([get('sessions'), get('recordings'), get('annotations')]);
    return { sessions, recordings, annotations };
}

/**
 * Pure conversion of legacy rows into new-format snapshots.
 * @returns {Array<{session, chunks, annotations}>}
 */
export function convertLegacy({ sessions, recordings, annotations }, { newId, importedWall }) {
    const byName = new Map();
    for (const s of sessions) {
        const k = s.name ?? '';
        if (!byName.has(k)) byName.set(k, []);
        byName.get(k).push(s);
    }
    const out = [];
    for (const [name, group] of byName) {
        group.sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
        const recs = recordings.filter(r => (r.session ?? '') === name).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        const anns = annotations.filter(a => (a.session ?? '') === name);
        group.forEach((s, gi) => {
            const lo = s.startTime || 0;
            const hi = gi + 1 < group.length ? (group[gi + 1].startTime || Infinity) : Infinity;
            const mine = recs.filter(r => (r.timestamp || 0) >= lo && (r.timestamp || 0) < hi);
            const myAnns = anns.filter(a => (a.timestamp || 0) >= lo && (a.timestamp || 0) < hi);
            const sessionId = newId();
            const dict = [], idx = new Map(), devices = {};
            const cols = { d: [], c: [], q: [], t: [], h: [], r: [], raw: [], v: [], f: [] };
            for (const r of mine) {
                const devId = 'legacy:' + (r.deviceId || r.name || 'unknown');
                let di = idx.get(devId);
                if (di === undefined) {
                    di = dict.length; dict.push(devId); idx.set(devId, di);
                    devices[devId] = {
                        deviceId: devId, displayName: r.name || r.deviceId || 'legacy device', transport: 'webbluetooth', simulated: false,
                        protocol: 'legacy:v1-import', identity: 'browser-device-id from SensorLab 1.x', channels: [], calibrationLog: [],
                    };
                }
                const ch = Number.isInteger(r.channelIndex) ? r.channelIndex : 0;
                if (!devices[devId].channels.some(c => c.channelId === ch)) {
                    devices[devId].channels.push({ channelId: ch, name: r.yLabel || 'value', unit: r.unit || '', deviceScale: null, deviceOffset: null,
                        calibration: { note: 'SensorLab 1.x applied an undocumented calibration offset before storage; raw values were not kept' } });
                }
                const value = typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : null;
                cols.d.push(di); cols.c.push(ch); cols.q.push(null); cols.t.push(null); cols.h.push(null);
                cols.r.push(((r.timestamp || lo) - lo) / 1000); cols.raw.push(null); cols.v.push(value);
                cols.f.push(Q.HOST_TIME_ONLY | (value === null ? Q.INVALID : 0));
            }
            const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
            out.push({
                session: {
                    sessionId, name: name || 'Untitled (imported)', group: s.group || '', notes: '', state: 'imported',
                    createdWall: iso(lo), startedWall: iso(lo), endedWall: iso(mine.length ? mine[mine.length - 1].timestamp : lo),
                    simulated: false, app: { version: '1.x' }, devices, quality: {}, visibility: [],
                    storage: { chunks: mine.length ? 1 : 0, readingsPersisted: mine.length },
                    provenance: {
                        importedFrom: 'SensorLab 1.x IndexedDB "SensorLabDB"', importedWall,
                        legacySessionKey: s.id ?? null,
                        nameCollision: group.length > 1
                            ? `${group.length} legacy sessions shared this name; readings were assigned by start-time ranges (heuristic)`
                            : null,
                        limitations: 'No sequence numbers or device timestamps; times are host wall-clock receipt times; any loss is undetectable; v1 kept readings in memory until Stop, so crashed v1 sessions may be incomplete.',
                    },
                    recovery: null,
                },
                chunks: mine.length ? [{ chunkNo: 0, n: mine.length, wall: importedWall, dict, cols }] : [],
                annotations: myAnns.map(a => ({ sessionId, annotationId: newId(), relS: ((a.timestamp || lo) - lo) / 1000, text: String(a.text ?? ''), deviceId: null, wall: iso(a.timestamp) })),
            });
        });
    }
    return out;
}

/** Write converted snapshots into the new repository (idempotent via meta flag). */
export async function importLegacyIfPresent(repo, { idb = globalThis.indexedDB, newId = () => crypto.randomUUID(), wallIso = new Date().toISOString() } = {}) {
    const done = await repo.getMeta('legacyImport');
    if (done) return { status: 'already-imported', ...done };
    const db = await openLegacyDb(idb);
    if (!db) return { status: 'none' };
    try {
        const raw = await readLegacy(db);
        const converted = convertLegacy(raw, { newId, importedWall: wallIso });
        let readings = 0;
        for (const snap of converted) {
            await repo.createSession(snap.session);
            for (const ch of snap.chunks) await repo.appendChunk(snap.session.sessionId, ch, {});
            for (const a of snap.annotations) await repo.putAnnotation(a);
            readings += snap.chunks.reduce((x, c) => x + c.n, 0);
        }
        const result = { sessions: converted.length, readings, at: wallIso };
        await repo.setMeta('legacyImport', result);
        return { status: 'imported', ...result };
    } finally {
        db.close();
    }
}
