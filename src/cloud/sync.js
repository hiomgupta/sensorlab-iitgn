import { utf8Length } from '../export/export.js';

export const MAX_CLOUD_PART_BYTES = 180_000;

/** Split JSON without breaking surrogate pairs; each Firestore document stays well below 1 MiB. */
export function* splitCloudText(text, maxBytes = MAX_CLOUD_PART_BYTES) {
    if (!Number.isInteger(maxBytes) || maxBytes < 4) throw new RangeError('Cloud part limit must be at least four bytes.');
    let offset = 0;
    while (offset < text.length) {
        let lo = 1, hi = Math.min(text.length - offset, maxBytes);
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (utf8Length(text.slice(offset, offset + mid)) <= maxBytes) lo = mid;
            else hi = mid - 1;
        }
        let end = offset + lo;
        const last = text.charCodeAt(end - 1), next = text.charCodeAt(end);
        if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
        if (end === offset) throw new RangeError('Cloud part limit cannot fit the next character.');
        yield text.slice(offset, end);
        offset = end;
    }
}

export function* cloudDocuments(snapshot) {
    const { cloudOwnerUid, cloudUploadedAt, ...session } = snapshot.session;
    const records = [
        { kind: 'session', sourceId: 'header', value: session },
        ...snapshot.chunks.map(chunk => ({ kind: 'chunk', sourceId: String(chunk.chunkNo), value: chunk })),
        { kind: 'annotations', sourceId: 'all', value: snapshot.annotations },
    ];
    for (const record of records) {
        const parts = [...splitCloudText(JSON.stringify(record.value))];
        for (let partNo = 0; partNo < parts.length; partNo++) {
            yield {
                id: `${record.kind}-${record.sourceId}-${partNo}`,
                data: { kind: record.kind, sourceId: record.sourceId, partNo, partCount: parts.length, payload: parts[partNo] },
            };
        }
    }
}

export class CloudSync {
    constructor({ repo, backend, online = () => navigator.onLine, busy = () => false, now = () => Date.now(), onStatus = () => {}, requestTimeoutMs = 30_000 }) {
        this.repo = repo;
        this.backend = backend;
        this.online = online;
        this.busy = busy;
        this.now = now;
        this.onStatus = onStatus;
        this.requestTimeoutMs = requestTimeoutMs;
        this.user = null;
        this.account = null;
        this.epoch = 0;
        this.profileSaved = false;
        this.running = null;
        this.status = { phase: 'waiting', message: 'Sign in to enable cloud backup.', pending: 0 };
        this.accountWrites = Promise.resolve();
        this.accountError = null;
    }

    async init() { this.account = await this.repo.getMeta('cloud-account') ?? null; }
    getAccount() { return this.account; }

    setUser(user) {
        const epoch = ++this.epoch;
        this.user = user;
        this.profileSaved = false;
        const write = this.accountWrites.then(async () => {
            if (epoch !== this.epoch || !user) return;
            const account = { uid: user.uid, email: user.email ?? null, displayName: user.displayName ?? null };
            await this.repo.setMeta('cloud-account', account);
            if (epoch === this.epoch) { this.account = account; this.accountError = null; }
        });
        this.accountWrites = write.then(() => {}, error => {
            if (epoch === this.epoch) {
                this.accountError = error;
                this._status('error', 'Could not remember the cloud account: ' + error.message, this.status.pending);
            }
        });
        return write;
    }

    async forgetAccount() {
        ++this.epoch;
        this.user = null;
        this.account = null;
        this.profileSaved = false;
        await this.accountWrites;
        await this.repo.setMeta('cloud-account', null);
        this.accountError = null;
        this._status('waiting', 'Signed out. New recordings stay local until you sign in again.', 0);
    }

    async queueSession(id, uid) {
        await this.accountWrites;
        if (this.accountError) throw this.accountError;
        await this.repo.assignCloudOwner(id, uid);
    }

    _status(phase, message, pending) {
        this.status = { phase, message, pending };
        this.onStatus(this.status);
    }

    async _request(promise) {
        let timer;
        try {
            return await Promise.race([
                promise,
                new Promise((resolve, reject) => {
                    timer = setTimeout(() => reject(new Error('Firebase request timed out without acknowledgement')), this.requestTimeoutMs);
                }),
            ]);
        } finally { clearTimeout(timer); }
    }

    syncNow() {
        if (this.running) return this.running;
        this.running = this._sync().catch(error => {
            this._status('error', `Cloud backup failed: ${error.message}. Local data is safe; pending uploads will retry.`, this.status.pending);
            throw error;
        }).finally(() => { this.running = null; });
        return this.running;
    }

    async _sync() {
        await this.accountWrites;
        if (this.accountError && this.user) await this.setUser(this.user);
        if (this.accountError) throw this.accountError;
        const epoch = this.epoch, user = this.user, account = this.account;
        const sessions = await this.repo.listSessions();
        const pending = sessions.filter(s => s.cloudOwnerUid === account?.uid && !s.cloudUploadedAt);
        const eligible = pending.filter(s => s.state !== 'open');
        const valid = () => epoch === this.epoch && this.user?.uid === user?.uid && !!user && this.online() && !this.busy();
        if (!valid()) {
            const message = this.busy() ? 'Cloud backup paused while recording; local saving continues.'
                : !this.online() ? 'Offline. Recordings stay local and will upload when internet returns.'
                    : 'Sign in to the owner account to upload pending recordings.';
            this._status('waiting', message, pending.length);
            return;
        }
        if (account?.uid !== user.uid) throw new Error('The remembered account does not match the authenticated account.');
        if (!eligible.length && this.profileSaved) {
            this._status('idle', pending.length ? 'Open recordings will back up after Stop or recovery.' : 'Cloud backup is up to date.', pending.length);
            return;
        }
        this._status('syncing', 'Checking account and uploading cloud backup...', pending.length);
        await this._request(this.backend.verifyUser(user.uid));
        if (!valid()) return;
        if (!this.profileSaved) {
            await this._request(this.backend.saveProfile(user));
            if (!valid()) return;
            this.profileSaved = true;
        }
        let remaining = pending.length;
        for (const session of eligible) {
            if (!valid()) return;
            const snapshot = await this.repo.readSnapshot(session.sessionId);
            if (!snapshot) continue;
            if (snapshot.session.cloudOwnerUid !== user.uid || snapshot.session.state === 'open') continue;
            if (snapshot.corruptChunks.length || snapshot.missingChunkNos.length) throw new Error(`"${session.name}" has corrupt or missing local chunks. Export and review it before cloud backup.`);
            let documentCount = 0;
            for (const part of cloudDocuments(snapshot)) {
                if (!valid()) return;
                await this._request(this.backend.savePart(user.uid, session.sessionId, part));
                documentCount++;
            }
            if (!valid()) return;
            const current = await this.repo.getSession(session.sessionId);
            if (!current || current.cloudOwnerUid !== user.uid || current.state === 'open') continue;
            await this._request(this.backend.completeSession(user.uid, session.sessionId, {
                schema: 'sensorlab.cloud-session/1',
                sessionId: session.sessionId,
                name: session.name,
                state: session.state,
                startedWall: session.startedWall ?? null,
                documentCount,
                readingCount: snapshot.chunks.reduce((n, ch) => n + ch.n, 0),
                annotationCount: snapshot.annotations.length,
            }));
            if (!valid()) return;
            await this.repo.markCloudUploaded(session.sessionId, user.uid, new Date(this.now()).toISOString());
            remaining--;
            this._status('syncing', `Backed up "${session.name}".`, remaining);
        }
        if (valid()) this._status('idle', remaining ? 'Open recordings will back up after Stop or recovery.' : 'Cloud backup is up to date.', remaining);
    }
}
