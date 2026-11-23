import { CloudSync } from './sync.js';
import { createFirebaseBackend } from './firebase.js';
import { $, toast, log } from '../ui/dom.js';

/* global __SL_FIREBASE_CONFIG__ */
async function bootCloud() {
    const app = window.__sensorlab;
    $('offlineChip').textContent = 'Local-first + optional cloud';
    $('offlineChip').title = 'Recording works offline. Google sign-in enables account-scoped cloud backup when online.';
    $('dataPolicy').textContent = 'Saved locally first. Signed-in recordings are backed up when online.';
    if (!app.storageOk || !window.isSecureContext || !['https:', 'http:'].includes(location.protocol)) {
        app.profile.setCloudUnavailable(app.storageOk ? 'Cloud sign-in requires the HTTPS-hosted app (or localhost). Local file recording still works offline.'
            : 'Cloud backup is disabled because local storage is unavailable.');
        return;
    }
    const backend = createFirebaseBackend(__SL_FIREBASE_CONFIG__);
    let syncing = false, authBusy = false, lastError = '', retryDelay = 30_000;
    const sync = new CloudSync({
        repo: app.repo, backend,
        busy: () => app.recorder.state !== 'idle',
        onStatus(status) {
            app.profile.setSyncStatus(status);
        },
    });
    app.cloud = sync;
    app.history.cloud = sync;
    await sync.init();
    app.profile.setCloud(sync);

    function renderAccount() {
        app.profile.updateCloud({ authBusy, syncing });
    }
    function reportError(error) {
        const message = error.message || String(error);
        app.profile.setSyncStatus({ phase: 'error', message: `Cloud backup error: ${message}. Local recording is unaffected.`, pending: sync.status.pending });
        if (message !== lastError) { toast('Cloud backup: ' + message, 'warning', 9000); log('error', 'cloud: ' + message); }
        lastError = message;
    }
    let timer = null;
    function schedule(delay = retryDelay) {
        clearTimeout(timer);
        timer = setTimeout(runSync, delay);
    }
    async function runSync() {
        if (syncing || authBusy) return;
        syncing = true;
        renderAccount();
        try {
            await sync.syncNow();
            retryDelay = 30_000;
            lastError = '';
        } catch (error) {
            reportError(error);
            retryDelay = Math.min(300_000, retryDelay * 2);
        } finally {
            syncing = false;
            renderAccount();
            schedule();
        }
    }
    backend.observeUser(user => {
        sync.setUser(user).then(() => { renderAccount(); schedule(0); }).catch(reportError);
    });
    $('cloudSignIn').addEventListener('click', async () => {
        authBusy = true; renderAccount();
        try { await backend.signIn(); }
        catch (error) { reportError(error); }
        finally { authBusy = false; renderAccount(); schedule(0); }
    });
    $('cloudSignOut').addEventListener('click', async () => {
        authBusy = true; renderAccount();
        try { await sync.forgetAccount(); await backend.signOut(); }
        catch (error) { reportError(error); }
        finally { authBusy = false; renderAccount(); schedule(0); }
    });
    $('cloudSyncNow').addEventListener('click', runSync);
    window.addEventListener('online', () => { renderAccount(); schedule(0); });
    window.addEventListener('offline', () => { renderAccount(); schedule(0); });
    app.controller.onChange(() => schedule(0));
    window.addEventListener('pagehide', () => clearTimeout(timer));
    window.addEventListener('pageshow', () => schedule(0));
    renderAccount();
    schedule(0);
}

function start() {
    bootCloud().catch(error => {
        window.__sensorlab.profile.setCloudUnavailable('Cloud initialization failed: ' + error.message + '. Local recording is unaffected.');
        log('error', 'cloud initialization: ' + error.message);
    });
}
if (window.__sensorlab) start();
else window.addEventListener('sensorlab-ready', start, { once: true });
