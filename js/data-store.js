/**
 * DataStore — In-memory buffer + IndexedDB persistence for sensor recordings.
 * Supports session/experiment metadata, annotations, per-device export, and
 * automatic periodic flush to IndexedDB to avoid memory cap issues.
 */
class DataStore {
    constructor() {
        this.readings = [];               // in-memory ring buffer
        this.maxMemoryReadings = 100000;  // flush older data to IDB when exceeded
        this.isRecording = false;
        this.session = null;              // { name, group, startTime }
        this.annotations = [];            // [{ timestamp, text, deviceId? }]
        this.db = null;
        this._deviceData = new Map();     // deviceId -> count
        this._initDB();
        this._setupBeforeUnload();
    }

    _initDB() {
        const req = indexedDB.open('SensorLabDB', 4);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('recordings')) {
                const store = db.createObjectStore('recordings', { keyPath: 'id', autoIncrement: true });
                store.createIndex('session', 'session', { unique: false });
                store.createIndex('deviceId', 'deviceId', { unique: false });
            }
            if (!db.objectStoreNames.contains('sessions')) {
                db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
            }
            if (!db.objectStoreNames.contains('annotations')) {
                const annStore = db.createObjectStore('annotations', { keyPath: 'id', autoIncrement: true });
                annStore.createIndex('session', 'session', { unique: false });
            } else if (e.oldVersion < 4) {
                const annStore = e.currentTarget.transaction.objectStore('annotations');
                if (!annStore.indexNames.contains('session')) {
                    annStore.createIndex('session', 'session', { unique: false });
                }
            }
        };
        req.onsuccess = (e) => { this.db = e.target.result; };
        req.onerror = (e) => console.error('IndexedDB error', e);
    }

    _setupBeforeUnload() {
        window.addEventListener('beforeunload', (e) => {
            if (this.isRecording || this.readings.length > 0) {
                e.preventDefault();
                e.returnValue = 'You have unsaved sensor data. Are you sure you want to leave?';
                return e.returnValue;
            }
        });
    }

    // ── Session management ──
    startSession(name, group) {
        this.session = { name: name || 'Untitled', group: group || '', startTime: Date.now() };
        this.annotations = [];
        this.readings = [];
        this._deviceData.clear();
        this.isRecording = true;
        if (this.db) {
            const tx = this.db.transaction('sessions', 'readwrite');
            tx.objectStore('sessions').add({ ...this.session });
        }
    }

    stopSession() {
        this.isRecording = false;
        this._flushToIDB();
        const summary = {
            session: this.session,
            totalReadings: this.readings.length,
            annotations: [...this.annotations],
        };
        return summary;
    }

    // ── Data ingestion ──
    addReading(reading) {
        if (!this.isRecording) return;
        const r = {
            ...reading,
            session: this.session?.name || '',
            group: this.session?.group || '',
        };
        this.readings.push(r);
        const cnt = (this._deviceData.get(r.deviceId) || 0) + 1;
        this._deviceData.set(r.deviceId, cnt);

        // When memory cap exceeded, flush older half to IndexedDB
        if (this.readings.length > this.maxMemoryReadings) {
            this._flushHalf();
        }
    }

    _flushHalf() {
        if (!this.db) return;
        const half = Math.floor(this.readings.length / 2);
        const toFlush = this.readings.splice(0, half);
        const tx = this.db.transaction('recordings', 'readwrite');
        const store = tx.objectStore('recordings');
        for (const r of toFlush) store.add(r);
        tx.onerror = (e) => console.error('IDB flush-half error', e);
    }

    _flushToIDB() {
        if (!this.db || this.readings.length === 0) return;
        const tx = this.db.transaction('recordings', 'readwrite');
        const store = tx.objectStore('recordings');
        for (const r of this.readings) store.add(r);
        tx.onerror = (e) => console.error('IDB flush error', e);
    }

    // ── Annotations ──
    addAnnotation(text, deviceId) {
        const a = { timestamp: Date.now(), text, deviceId: deviceId || null, session: this.session?.name || '' };
        this.annotations.push(a);
        if (this.db) {
            const tx = this.db.transaction('annotations', 'readwrite');
            tx.objectStore('annotations').add(a);
            tx.onerror = (e) => console.error('IDB annotation write error', e);
        }
        return a;
    }

    // ── Export helpers ──
    exportCSV(deviceIdFilter) {
        const data = deviceIdFilter
            ? this.readings.filter(r => r.deviceId === deviceIdFilter)
            : this.readings;
        if (data.length === 0) return '';
        const header = 'timestamp,device,value,unit,session,group\n';
        const body = data.map(r =>
            `${r.timestamp},"${r.name || r.deviceId}",${r.value},"${r.unit || ''}","${r.session || ''}","${r.group || ''}"`
        ).join('\n');
        return header + body;
    }

    exportJSON(deviceIdFilter) {
        const data = deviceIdFilter
            ? this.readings.filter(r => r.deviceId === deviceIdFilter)
            : this.readings;
        return JSON.stringify({
            session: this.session,
            annotations: this.annotations,
            readings: data,
        }, null, 2);
    }

    downloadFile(content, filename, mime) {
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    getDeviceIds() {
        const ids = new Set();
        this.readings.forEach(r => ids.add(r.deviceId));
        return [...ids];
    }

    clearMemory() {
        this.readings = [];
        this._deviceData.clear();
        this.annotations = [];
    }

    async clearAllData() {
        this.clearMemory();
        if (!this.db) return;
        const stores = ['recordings', 'sessions', 'annotations'];
        const tx = this.db.transaction(stores, 'readwrite');
        for (const s of stores) tx.objectStore(s).clear();
    }

    // ── Load saved sessions from IDB ──
    async getSavedSessions() {
        if (!this.db) return [];
        return new Promise((resolve) => {
            const tx = this.db.transaction('sessions', 'readonly');
            const req = tx.objectStore('sessions').getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve([]);
        });
    }

    async getSessionRecordings(sessionName) {
        if (!this.db) return [];
        return new Promise((resolve) => {
            const tx = this.db.transaction('recordings', 'readonly');
            const idx = tx.objectStore('recordings').index('session');
            const req = idx.getAll(sessionName);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve([]);
        });
    }

    async getSessionAnnotations(sessionName) {
        if (!this.db) return [];
        return new Promise((resolve) => {
            const tx = this.db.transaction('annotations', 'readonly');
            const store = tx.objectStore('annotations');
            if (store.indexNames.contains('session')) {
                const idx = store.index('session');
                const req = idx.getAll(sessionName);
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => resolve([]);
            } else {
                const req = store.getAll();
                req.onsuccess = () => {
                    resolve((req.result || []).filter(a => a.session === sessionName));
                };
                req.onerror = () => resolve([]);
            }
        });
    }

    async deleteSession(sessionName) {
        if (!this.db) return;
        // Delete recordings for this session
        const recordings = await this.getSessionRecordings(sessionName);
        const tx1 = this.db.transaction('recordings', 'readwrite');
        const store1 = tx1.objectStore('recordings');
        for (const r of recordings) store1.delete(r.id);
        // Delete annotations for this session
        const annots = await this.getSessionAnnotations(sessionName);
        const tx2 = this.db.transaction('annotations', 'readwrite');
        const store2 = tx2.objectStore('annotations');
        for (const a of annots) store2.delete(a.id);
        // Delete session entry
        const allSessions = await this.getSavedSessions();
        const tx3 = this.db.transaction('sessions', 'readwrite');
        const store3 = tx3.objectStore('sessions');
        for (const s of allSessions) {
            if (s.name === sessionName) store3.delete(s.id);
        }
    }

    exportCSVFromData(data) {
        if (data.length === 0) return '';
        const header = 'timestamp,device,value,unit,session,group\n';
        const body = data.map(r =>
            `${r.timestamp},"${r.name || r.deviceId}",${r.value},"${r.unit || ''}","${r.session || ''}","${r.group || ''}"`
        ).join('\n');
        return header + body;
    }

    exportJSONFromData(data, session, annotations) {
        return JSON.stringify({ session, annotations, readings: data }, null, 2);
    }
}
