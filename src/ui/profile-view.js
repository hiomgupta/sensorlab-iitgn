import { $, h, clear, openDialog, closeDialog, toast, log } from './dom.js';

export function sessionBackupLabel(session, accountUid) {
    if (!session.cloudOwnerUid) return 'Local only';
    const anotherAccount = accountUid && session.cloudOwnerUid !== accountUid;
    if (session.cloudUploadedAt) return anotherAccount ? 'Backed up (another account)' : 'Backed up';
    if (!accountUid) return 'Pending backup - owner sign-in needed';
    if (anotherAccount) return 'Pending backup - another account';
    if (session.state === 'open') return 'Backup after Stop or recovery';
    return 'Pending backup';
}

export function summarizeProfileSessions(sessions) {
    const summary = { total: sessions.length, localOnly: 0, pending: 0, backedUp: 0 };
    for (const session of sessions) {
        if (!session.cloudOwnerUid) summary.localOnly++;
        else if (session.cloudUploadedAt) summary.backedUp++;
        else summary.pending++;
    }
    return {
        ...summary,
        recent: [...sessions].sort((a, b) => String(b.startedWall ?? b.createdWall ?? '').localeCompare(String(a.startedWall ?? a.createdWall ?? ''))).slice(0, 3),
    };
}

export class ProfileView {
    constructor({ repo, history, storageReady }) {
        this.repo = repo;
        this.history = history;
        this.storageReady = storageReady;
        this.dialog = $('profileDialog');
        this.trigger = $('profileBtn');
        this.cloud = null;
        this.unavailable = null;
        this.authBusy = false;
        this.syncing = false;
        this.backupStatus = null;
        this.refreshId = 0;
        this.trigger.addEventListener('click', () => this.open());
        $('profileHistoryBtn').addEventListener('click', () => this.openHistory());
        window.addEventListener('online', () => this.renderAccount());
        window.addEventListener('offline', () => this.renderAccount());
        this.renderAccount();
    }

    setCloud(cloud) {
        this.cloud = cloud;
        this.unavailable = null;
        this.backupStatus = cloud.status;
        this.renderAccount();
    }

    setCloudUnavailable(message) {
        this.unavailable = message;
        this.renderAccount();
    }

    updateCloud({ authBusy, syncing }) {
        this.authBusy = authBusy;
        this.syncing = syncing;
        this.renderAccount();
    }

    setSyncStatus(status) {
        this.backupStatus = status;
        this.renderAccount();
        this.refreshIfOpen();
    }

    renderAccount() {
        const account = this.cloud?.getAccount(), user = this.cloud?.user;
        const identity = user || account;
        const online = navigator.onLine;
        const label = user ? online ? 'Signed in' : 'Signed in offline'
            : account ? 'Sign-in needed' : this.cloud ? 'Signed out' : 'Local mode';
        const tone = user ? 'good' : account ? 'warning' : 'neutral';
        for (const id of ['profileAuthState', 'profileSessionState']) {
            $(id).textContent = label;
            $(id).dataset.tone = tone;
        }
        this.trigger.setAttribute('aria-label', `Profile (${label.toLowerCase()})`);
        const initials = identity?.displayName?.trim().split(/\s+/).slice(0, 2).map(word => [...word][0]).join('').toUpperCase()
            || (identity?.email ? [...identity.email][0].toUpperCase() : 'SL');
        $('profileAvatar').textContent = initials;
        $('profileAvatarLarge').textContent = initials;
        $('profileName').textContent = identity?.displayName || identity?.email || 'Local workspace';
        $('profileEmail').textContent = identity?.email || (identity ? 'Google account' : 'Not signed in');
        $('profileAccountNote').textContent = this.unavailable
            || (!this.cloud ? 'Cloud backup is not configured. Your recordings stay in this browser.'
                : user ? 'New recordings belong to this account and back up after Stop. Your local history is below.'
                    : account ? 'This is your last account, not an active sign-in. Offline recordings stay associated with it; sign in again to upload.'
                        : 'Sign in to back up new recordings. Existing local recordings upload only when you select them in History.');
        $('cloudSignIn').textContent = user ? 'Switch Google account' : 'Sign in with Google';
        $('cloudSignIn').disabled = !this.cloud || this.authBusy || !online;
        $('cloudSignOut').hidden = !account;
        $('cloudSignOut').disabled = this.authBusy || !account;
        $('cloudSyncNow').disabled = !user || this.syncing || this.authBusy || !online;
        this.renderBackup();
    }

    renderBackup() {
        const status = this.backupStatus;
        let label = 'Local only', tone = 'neutral', message = 'Recording and local storage work without internet.';
        if (this.unavailable) { label = 'Unavailable'; tone = 'warning'; message = this.unavailable; }
        else if (this.cloud) {
            if (status?.phase === 'error') { label = 'Needs attention'; tone = 'error'; message = status.message; }
            else if (!navigator.onLine) { label = 'Offline'; tone = 'warning'; message = 'Saved locally. Pending backups wait for internet and the owner account.'; }
            else if (!this.cloud.user) { label = 'Sign-in needed'; message = 'Sign in to the recording owner account to upload pending backups.'; }
            else if (status?.phase === 'syncing') { label = 'Backing up'; tone = 'info'; message = status.message; }
            else if (status?.phase === 'idle' && status.pending === 0) { label = 'Up to date'; tone = 'good'; message = status.message; }
            else { label = 'Waiting'; message = status?.message || 'Checking for pending backups.'; }
        }
        $('profileBackupState').textContent = label;
        $('profileBackupState').dataset.tone = tone;
        $('cloudStatus').textContent = message + (this.cloud ? ` Pending for this account: ${status?.pending ?? 0}.` : '');
    }

    async open() {
        this.renderAccount();
        openDialog(this.dialog);
        await this.refresh();
    }

    refreshIfOpen() {
        if (this.dialog.open) this.refresh();
    }

    async refresh() {
        const refreshId = ++this.refreshId;
        if (!this.storageReady) {
            $('profileHistoryState').textContent = 'Local history is unavailable because browser storage could not be opened.';
            return;
        }
        try {
            const sessions = await this.repo.listSessions();
            if (refreshId !== this.refreshId) return;
            const summary = summarizeProfileSessions(sessions);
            for (const [id, count] of [
                ['profileTotal', summary.total], ['profileLocal', summary.localOnly],
                ['profilePending', summary.pending], ['profileBackedUp', summary.backedUp],
            ]) $(id).textContent = String(count);
            $('profileHistoryState').textContent = summary.total ? 'Select a recording to view its readings and exports.' : 'No recordings yet. Start a Demo or connect a device, then Record.';
            clear($('profileRecent'));
            for (const session of summary.recent) {
                const started = session.startedWall ? new Date(session.startedWall).toLocaleString() : 'unknown start';
                const backup = sessionBackupLabel(session, this.cloud?.getAccount()?.uid);
                const label = `Open recording ${session.name}, started ${started}, ${session.sessionId.slice(0, 8)}`;
                $('profileRecent').append(h('li', {}, h('button', {
                    class: 'btn', type: 'button', 'aria-label': label, onclick: () => this.openHistory(session.sessionId),
                }, h('span', {}, h('strong', {}, session.name), h('small', {}, `${started} · ${session.storage?.readingsPersisted ?? '?'} readings · ${backup}`)),
                h('span', { class: 'profile-open', 'aria-hidden': 'true' }, 'View'))));
            }
        } catch (error) {
            if (refreshId !== this.refreshId) return;
            for (const id of ['profileTotal', 'profileLocal', 'profilePending', 'profileBackedUp']) $(id).textContent = '—';
            clear($('profileRecent'));
            $('profileHistoryState').textContent = 'Could not read local history: ' + error.message;
            log('error', 'profile history: ' + error.message);
        }
    }

    async openHistory(sessionId) {
        closeDialog(this.dialog);
        this.trigger.focus();
        try {
            await this.history.open();
            if (sessionId) await this.history.view(sessionId);
        } catch (error) {
            toast('Could not open history: ' + error.message, 'error');
            log('error', 'profile navigation: ' + error.message);
        }
    }
}
