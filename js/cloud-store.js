/**
 * CloudStore — Firestore-backed storage for SensorLab
 * Mirrors DataStore's API for sessions, recordings, annotations, and profiles.
 * Data is stored under users/{uid}/...
 */
class CloudStore {
    constructor(uid) {
        this._uid = uid;
        this._db = firebase.firestore();
        // Enable offline persistence (cache data locally for flaky lab WiFi)
        this._db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
    }

    _userRef() {
        return this._db.collection('users').doc(this._uid);
    }

    // ── Sessions ──
    async saveSession(session) {
        const ref = this._userRef().collection('sessions').doc();
        const data = {
            name: session.name || 'Untitled',
            group: session.group || '',
            startTime: session.startTime || Date.now(),
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        };
        await ref.set(data);
        return ref.id;
    }

    async getSavedSessions() {
        const snap = await this._userRef().collection('sessions')
            .orderBy('startTime', 'desc').get();
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }

    async deleteSession(sessionId) {
        const sessRef = this._userRef().collection('sessions').doc(sessionId);
        // Delete recordings sub-collection
        const recs = await sessRef.collection('recordings').get();
        const batch1 = this._db.batch();
        recs.docs.forEach(d => batch1.delete(d.ref));
        await batch1.commit();
        // Delete annotations sub-collection
        const anns = await sessRef.collection('annotations').get();
        const batch2 = this._db.batch();
        anns.docs.forEach(d => batch2.delete(d.ref));
        await batch2.commit();
        // Delete session doc
        await sessRef.delete();
    }

    // ── Recordings ──
    // Batch-write recordings for performance (Firestore max 500 per batch)
    async saveRecordings(sessionId, recordings) {
        const sessRef = this._userRef().collection('sessions').doc(sessionId);
        const recCol = sessRef.collection('recordings');
        const BATCH_SIZE = 450;
        for (let i = 0; i < recordings.length; i += BATCH_SIZE) {
            const batch = this._db.batch();
            const slice = recordings.slice(i, i + BATCH_SIZE);
            slice.forEach(r => {
                const ref = recCol.doc();
                batch.set(ref, {
                    timestamp: r.timestamp,
                    deviceId: r.deviceId || '',
                    name: r.name || '',
                    value: r.value,
                    unit: r.unit || '',
                    relTime: r.relTime || 0,
                });
            });
            await batch.commit();
        }
    }

    async getSessionRecordings(sessionId) {
        const snap = await this._userRef().collection('sessions').doc(sessionId)
            .collection('recordings').orderBy('timestamp').get();
        return snap.docs.map(d => d.data());
    }

    // ── Annotations ──
    async saveAnnotations(sessionId, annotations) {
        const sessRef = this._userRef().collection('sessions').doc(sessionId);
        const annCol = sessRef.collection('annotations');
        const batch = this._db.batch();
        annotations.forEach(a => {
            batch.set(annCol.doc(), {
                timestamp: a.timestamp,
                text: a.text || '',
                deviceId: a.deviceId || null,
            });
        });
        await batch.commit();
    }

    async getSessionAnnotations(sessionId) {
        const snap = await this._userRef().collection('sessions').doc(sessionId)
            .collection('annotations').orderBy('timestamp').get();
        return snap.docs.map(d => d.data());
    }

    // ── Profiles (BLE device profiles) ──
    async getProfiles() {
        const snap = await this._userRef().collection('profiles')
            .orderBy('name').get();
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }

    async saveProfile(profile) {
        const ref = this._userRef().collection('profiles').doc();
        await ref.set({
            name: profile.name,
            serviceUUID: profile.serviceUUID,
            characteristicUUID: profile.characteristicUUID,
            dataFormat: profile.dataFormat || 'text-float',
            unit: profile.unit || '',
            yLabel: profile.yLabel || 'Value',
            scaleFactor: profile.scaleFactor ?? 1,
        });
        return ref.id;
    }

    async deleteProfile(profileId) {
        await this._userRef().collection('profiles').doc(profileId).delete();
    }

    // ── Preferences ──
    async getPreferences() {
        const doc = await this._userRef().collection('meta').doc('preferences').get();
        return doc.exists ? doc.data() : {};
    }

    async savePreferences(prefs) {
        await this._userRef().collection('meta').doc('preferences').set(prefs, { merge: true });
    }

    // ── Recent Devices ──
    async addRecentDevice(deviceInfo) {
        const ref = this._userRef().collection('recentDevices');
        // Upsert by name
        const existing = await ref.where('name', '==', deviceInfo.name).limit(1).get();
        if (!existing.empty) {
            await existing.docs[0].ref.update({ lastUsed: Date.now(), ...deviceInfo });
        } else {
            await ref.add({ ...deviceInfo, lastUsed: Date.now() });
        }
    }

    async getRecentDevices() {
        const snap = await this._userRef().collection('recentDevices')
            .orderBy('lastUsed', 'desc').limit(10).get();
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }

    // ── Migration: Import local IDB data into cloud ──
    async migrateFromLocal(dataStore) {
        // Migrate sessions
        const sessions = await dataStore.getSavedSessions();
        for (const session of sessions) {
            const sessionId = await this.saveSession(session);
            // Migrate recordings for this session
            const recordings = await dataStore.getSessionRecordings(session.name);
            if (recordings.length > 0) {
                await this.saveRecordings(sessionId, recordings);
            }
            // Migrate annotations
            const annotations = await dataStore.getSessionAnnotations(session.name);
            if (annotations.length > 0) {
                await this.saveAnnotations(sessionId, annotations);
            }
        }
        // Migrate profiles
        const profiles = JSON.parse(localStorage.getItem('sensorlab_profiles') || '[]');
        for (const p of profiles) {
            await this.saveProfile(p);
        }
        return sessions.length;
    }
}
