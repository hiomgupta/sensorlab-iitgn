/**
 * SensorLab App — Main application controller
 */
(function () {
    'use strict';

    if (!BLEManager.isSupported()) {
        document.body.innerHTML = '<div style="text-align:center;padding:60px;color:#f87171;font-size:1.1em;font-family:Inter,system-ui,sans-serif">Web Bluetooth is not supported.<br>Use Chrome or Edge on desktop.</div>';
        return;
    }

    const ble = new BLEManager();
    const dataStore = new DataStore();
    const chart = new ChartManager('mainChart');

    // ── BLE Presets ──
    const PRESETS = [
        { name: 'SensorLab ESP32', serviceUUID: '6e400001-b5a3-f393-e0a9-e50e24dcca9e', characteristicUUID: 'beb5483e-36e1-4688-b7f5-ea07361b26a8', dataFormat: 'text-float', unit: 'Ω', yLabel: 'Resistance' },
        { name: 'Heart Rate', serviceUUID: 'heart_rate', characteristicUUID: 'heart_rate_measurement', dataFormat: 'uint16-le', unit: 'bpm', yLabel: 'Heart Rate' },
        { name: 'Battery Level', serviceUUID: 'battery_service', characteristicUUID: 'battery_level', dataFormat: 'uint16-le', unit: '%', yLabel: 'Battery' },
        { name: 'Environment Sensing', serviceUUID: 'environmental_sensing', characteristicUUID: 'temperature', dataFormat: 'int16-le', unit: '°C', yLabel: 'Temperature', scaleFactor: 0.01 },
        { name: 'Nordic UART', serviceUUID: '6e400001-b5a3-f393-e0a9-e50e24dcca9e', characteristicUUID: '6e400003-b5a3-f393-e0a9-e50e24dcca9e', dataFormat: 'text-float', unit: '', yLabel: 'Value' },
    ];

    let startTimestamp = null;

    // Extend BLEManager's known service list with all preset + profile UUIDs
    // so Scan Any → Browse Services can discover them.
    const knownUUIDs = new Set(BLEManager.KNOWN_SERVICE_UUIDS || []);
    PRESETS.forEach(p => knownUUIDs.add(p.serviceUUID));
    try {
        JSON.parse(localStorage.getItem('sensorlab_profiles') || '[]')
            .forEach(p => { if (p.serviceUUID) knownUUIDs.add(p.serviceUUID); });
    } catch { }
    BLEManager.KNOWN_SERVICE_UUIDS = [...knownUUIDs];

    // ── DOM cache ──
    const el = {
        connectBtn:      document.getElementById('connectBtn'),
        connectionModal: document.getElementById('connectionModal'),
        devicesPanel:    document.getElementById('devicesPanel'),
        dataBody:        document.getElementById('dataBody'),
        statusText:      document.getElementById('statusText'),
        readingCount:    document.getElementById('readingCount'),
        sessionInfo:     document.getElementById('sessionInfo'),
        presetGrid:      document.getElementById('presetGrid'),
        profileList:     document.getElementById('profileList'),
        serviceBrowser:  document.getElementById('serviceBrowser'),
        toastContainer:  document.getElementById('toastContainer'),
        timeWindowSel:   document.getElementById('timeWindow'),
        chartTypeSel:    document.getElementById('chartType'),
        exportCSVBtn:    document.getElementById('exportCSV'),
        exportJSONBtn:   document.getElementById('exportJSON'),
        pauseBtn:        document.getElementById('pauseBtn'),
        annotateBtn:     document.getElementById('annotateBtn'),
        recordBtn:       document.getElementById('recordBtn'),
        tabWarning:      document.getElementById('tabWarning'),
        guideBanner:     document.getElementById('guideBanner'),
        guideClose:      document.getElementById('guideClose'),
        sessionModal:    document.getElementById('sessionModal'),
        sessionForm:     document.getElementById('sessionForm'),
        exportDeviceSel: document.getElementById('exportDeviceSelect'),
        historyBtn:      document.getElementById('historyBtn'),
        historyModal:    document.getElementById('historyModal'),
        historyList:     document.getElementById('historyList'),
        historyViewer:   document.getElementById('historyViewer'),
        historyBack:     document.getElementById('historyBack'),
        historyViewerTitle: document.getElementById('historyViewerTitle'),
        historyMeta:     document.getElementById('historyMeta'),
        historyTableBody: document.getElementById('historyTableBody'),
        historyExportCSV: document.getElementById('historyExportCSV'),
        historyExportJSON: document.getElementById('historyExportJSON'),
        // Connection modal tabs
        tabBtns:         document.querySelectorAll('.tab-btn'),
        tabPanes:        document.querySelectorAll('.tab-pane'),
        // Custom UUID fields
        customService:   document.getElementById('customService'),
        customChar:      document.getElementById('customChar'),
        customFormat:    document.getElementById('customDataFormat'),
        customUnit:      document.getElementById('customUnit'),
        customLabel:     document.getElementById('customYLabel'),
        customScale:     document.getElementById('customScale'),
        customConnBtn:   document.getElementById('customConnectBtn'),
        // Scan
        scanNameFilter:  document.getElementById('scanNameFilter'),
        scanBtn:         document.getElementById('scanBtn'),
        scanBrowseBtn:   document.getElementById('scanBrowseBtn'),
        // Profile
        saveProfileBtn:  document.getElementById('saveProfileBtn'),
        // Help & Log
        helpBtn:         document.getElementById('helpBtn'),
        helpModal:       document.getElementById('helpModal'),
        logToggleBtn:    document.getElementById('logToggleBtn'),
        logPanel:        document.getElementById('logPanel'),
        logBody:         document.getElementById('logBody'),
        logClearBtn:     document.getElementById('logClearBtn'),
        logCopyBtn:      document.getElementById('logCopyBtn'),
        logCloseBtn:     document.getElementById('logCloseBtn'),
        // Theme
        themeToggleBtn:  document.getElementById('themeToggleBtn'),
        themeIconSun:    document.getElementById('themeIconSun'),
        themeIconMoon:   document.getElementById('themeIconMoon'),
        // Auth
        signInBtn:       document.getElementById('signInBtn'),
        signOutBtn:      document.getElementById('signOutBtn'),
        userInfo:        document.getElementById('userInfo'),
        userAvatar:      document.getElementById('userAvatar'),
        userName:        document.getElementById('userName'),
        cloudBanner:     document.getElementById('cloudBanner'),
        cloudBannerSignIn: document.getElementById('cloudBannerSignIn'),
        cloudBannerDismiss: document.getElementById('cloudBannerDismiss'),
    };

    // ── First-time guide ──
    if (!localStorage.getItem('sensorlab_guided')) {
        el.guideBanner.style.display = 'flex';
    }
    el.guideClose?.addEventListener('click', () => {
        el.guideBanner.style.display = 'none';
        localStorage.setItem('sensorlab_guided', '1');
    });

    // ── Theme Toggle ──
    function getTheme() {
        return localStorage.getItem('sensorlab_theme') || 'dark';
    }
    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('sensorlab_theme', theme);
        el.themeIconSun.style.display = theme === 'dark' ? 'none' : 'block';
        el.themeIconMoon.style.display = theme === 'dark' ? 'block' : 'none';
        // Update chart colors to match theme
        updateChartTheme(theme);
    }
    function updateChartTheme(theme) {
        const styles = getComputedStyle(document.documentElement);
        const gridColor = styles.getPropertyValue('--chart-grid').trim();
        const tickColor = styles.getPropertyValue('--chart-tick').trim();
        const titleColor = styles.getPropertyValue('--chart-title').trim();
        const legendColor = styles.getPropertyValue('--chart-legend').trim();
        if (chart && chart.chart) {
            const c = chart.chart;
            c.options.scales.x.grid.color = gridColor;
            c.options.scales.x.ticks.color = tickColor;
            c.options.scales.x.title.color = titleColor;
            c.options.scales.y.grid.color = gridColor;
            c.options.scales.y.ticks.color = tickColor;
            c.options.scales.y.title.color = titleColor;
            c.options.plugins.legend.labels.color = legendColor;
            c.update('none');
        }
    }
    el.themeToggleBtn.addEventListener('click', () => {
        const current = getTheme();
        applyTheme(current === 'dark' ? 'light' : 'dark');
    });
    applyTheme(getTheme());

    // ── Auth & Cloud ──
    const auth = new AuthManager();
    let cloudStore = null;

    auth.onAuthChange((user, mode) => {
        if (mode === 'signed-in' && user) {
            // Show user info, hide sign-in button
            el.signInBtn.style.display = 'none';
            el.userInfo.style.display = 'flex';
            el.userAvatar.src = user.photoURL || '';
            el.userAvatar.style.display = user.photoURL ? 'block' : 'none';
            el.userName.textContent = user.displayName || user.email || 'User';
            el.cloudBanner.classList.remove('visible');
            // Create cloud store
            cloudStore = new CloudStore(user.uid);
            appLog('info', `Signed in as ${user.displayName || user.email}`);
            // Offer migration if local data exists
            offerMigration();
        } else {
            // Guest mode
            el.signInBtn.style.display = auth.isAvailable ? 'inline-flex' : 'none';
            el.userInfo.style.display = 'none';
            cloudStore = null;
            // Show cloud banner for guests if Firebase is configured
            if (auth.isAvailable && !sessionStorage.getItem('sensorlab_banner_dismissed')) {
                el.cloudBanner.classList.add('visible');
            }
        }
    });

    el.signInBtn.addEventListener('click', async () => {
        try { await auth.signInWithGoogle(); }
        catch (err) { toast('Sign-in failed: ' + err.message, 'error'); }
    });
    el.signOutBtn.addEventListener('click', async () => {
        try { await auth.signOut(); toast('Signed out'); }
        catch (err) { toast('Sign-out failed: ' + err.message, 'error'); }
    });
    el.cloudBannerSignIn?.addEventListener('click', async () => {
        try { await auth.signInWithGoogle(); }
        catch (err) { toast('Sign-in failed: ' + err.message, 'error'); }
    });
    el.cloudBannerDismiss?.addEventListener('click', () => {
        el.cloudBanner.classList.remove('visible');
        sessionStorage.setItem('sensorlab_banner_dismissed', '1');
    });

    async function offerMigration() {
        if (!cloudStore) return;
        if (localStorage.getItem('sensorlab_migrated_' + auth.uid)) return;
        const localSessions = await dataStore.getSavedSessions();
        if (localSessions.length === 0) return;
        const doMigrate = confirm(`Found ${localSessions.length} local experiment(s). Migrate to cloud?`);
        if (doMigrate) {
            try {
                toast('Migrating data to cloud...');
                const count = await cloudStore.migrateFromLocal(dataStore);
                localStorage.setItem('sensorlab_migrated_' + auth.uid, '1');
                toast(`Migrated ${count} experiment(s) to cloud`, 'success');
                appLog('info', `Migrated ${count} experiments to cloud`);
            } catch (err) {
                toast('Migration failed: ' + err.message, 'error');
                appLog('error', `Migration failed: ${err.message}`);
            }
        } else {
            localStorage.setItem('sensorlab_migrated_' + auth.uid, '1');
        }
    }

    // ── Help Modal ──
    el.helpBtn.addEventListener('click', () => toggleModal(el.helpModal, true));

    // ── Log System ──
    const MAX_LOG_ENTRIES = 500;
    function appLog(tag, msg) {
        const now = new Date();
        const ts = now.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(now.getMilliseconds()).padStart(3, '0');
        const entry = document.createElement('div');
        entry.className = 'log-entry';
        entry.innerHTML = `<span class="log-time">${ts}</span><span class="log-tag ${tag}">${tag.toUpperCase()}</span><span class="log-msg">${sanitizeLog(msg)}</span>`;
        el.logBody.appendChild(entry);
        // Auto-scroll to bottom
        el.logBody.scrollTop = el.logBody.scrollHeight;
        // Trim old entries
        while (el.logBody.children.length > MAX_LOG_ENTRIES) el.logBody.firstChild.remove();
    }
    function sanitizeLog(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
    el.logToggleBtn.addEventListener('click', () => {
        el.logPanel.classList.toggle('open');
        el.logToggleBtn.classList.toggle('active');
    });
    el.logCloseBtn.addEventListener('click', () => {
        el.logPanel.classList.remove('open');
        el.logToggleBtn.classList.remove('active');
    });
    el.logClearBtn.addEventListener('click', () => { el.logBody.innerHTML = ''; });
    el.logCopyBtn.addEventListener('click', () => {
        const text = Array.from(el.logBody.querySelectorAll('.log-entry')).map(e =>
            e.querySelector('.log-time').textContent + ' [' + e.querySelector('.log-tag').textContent + '] ' + e.querySelector('.log-msg').textContent
        ).join('\n');
        navigator.clipboard.writeText(text).then(() => toast('Log copied to clipboard'));
    });
    appLog('info', 'SensorLab initialized');

    // ── Tab warning (visibility change) ──
    ble.on('tabHidden', () => {
        el.tabWarning.classList.add('visible');
        setTimeout(() => el.tabWarning.classList.remove('visible'), 8000);
    });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) el.tabWarning.classList.remove('visible');
    });

    // ── Connection modal ──
    el.connectBtn.addEventListener('click', () => toggleModal(el.connectionModal, true));
    document.querySelectorAll('.modal-close, .modal-overlay').forEach(x =>
        x.addEventListener('click', (e) => {
            e.currentTarget.closest('.modal-wrapper').classList.remove('open');
        })
    );
    el.tabBtns.forEach(btn => btn.addEventListener('click', () => {
        el.tabBtns.forEach(b => b.classList.remove('active'));
        el.tabPanes.forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab).classList.add('active');
    }));

    // ── Presets ──
    PRESETS.forEach(p => {
        const card = document.createElement('div');
        card.className = 'preset-card';
        const strong = document.createElement('strong');
        strong.textContent = p.name;
        const small = document.createElement('small');
        small.textContent = p.unit || 'Generic';
        card.appendChild(strong);
        card.appendChild(small);
        card.addEventListener('click', () => connectPreset(p));
        el.presetGrid.appendChild(card);
    });

    async function connectPreset(p) {
        try {
            toast('Scanning for ' + p.name + '...');
            appLog('ble', `Scanning for preset: ${p.name}`);
            const id = await ble.connectWithUUIDs({
                serviceUUID: p.serviceUUID,
                characteristicUUID: p.characteristicUUID,
                dataFormat: p.dataFormat,
                unit: p.unit, yLabel: p.yLabel,
                scaleFactor: p.scaleFactor ?? 1,
            });
            toggleModal(el.connectionModal, false);
        } catch (err) {
            toast('Connection failed: ' + err.message, 'error');
            appLog('error', `Preset connect failed: ${err.message}`);
        }
    }

    // ── Custom UUID connect ──
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const SHORT_UUID_RE = /^0x[0-9a-f]{4}$/i;
    const NAMED_UUID_RE = /^[a-z_][a-z0-9_]*$/i;
    function isValidUUID(s) { return UUID_RE.test(s) || SHORT_UUID_RE.test(s) || NAMED_UUID_RE.test(s); }
    el.customConnBtn.addEventListener('click', async () => {
        const svc = el.customService.value.trim();
        const chr = el.customChar.value.trim();
        if (!svc || !chr) { toast('Service and Characteristic UUIDs required', 'error'); return; }
        if (!isValidUUID(svc)) { toast('Invalid Service UUID format', 'error'); return; }
        if (!isValidUUID(chr)) { toast('Invalid Characteristic UUID format', 'error'); return; }
        try {
            toast('Connecting...');
            await ble.connectWithUUIDs({
                serviceUUID: svc, characteristicUUID: chr,
                dataFormat: el.customFormat.value,
                unit: el.customUnit.value.trim(),
                yLabel: el.customLabel.value.trim() || 'Value',
                scaleFactor: parseFloat(el.customScale.value) || 1,
            });
            toggleModal(el.connectionModal, false);
        } catch (err) { toast('Failed: ' + err.message, 'error'); }
    });

    // ── Scan Any ──
    let lastScanId = null;
    el.scanBtn.addEventListener('click', async () => {
        try {
            toast('Scanning...');
            appLog('ble', 'Scan Any started');
            lastScanId = await ble.scanAnyDevice({ nameFilter: el.scanNameFilter.value.trim() || undefined });
            el.scanBrowseBtn.disabled = false;
            toast('Connected — Browse services to subscribe');
            appLog('ble', `Scan Any connected: ${lastScanId}`);
        } catch (err) {
            toast('Scan failed: ' + err.message, 'error');
            appLog('error', `Scan Any failed: ${err.message}`);
        }
    });
    el.scanBrowseBtn.addEventListener('click', async () => {
        if (!lastScanId) return;
        try {
            const services = await ble.browseServices(lastScanId);
            renderServiceBrowser(services, lastScanId);
        } catch (err) { toast('Browse failed: ' + err.message, 'error'); }
    });

    function renderServiceBrowser(services, deviceId) {
        el.serviceBrowser.innerHTML = '';
        el.serviceBrowser.style.display = 'block';
        services.forEach(svc => {
            const div = document.createElement('div');
            div.className = 'svc-group';
            let html = `<div class="svc-uuid">Service: ${svc.serviceUUID}</div>`;
            svc.characteristics.forEach(c => {
                const props = Object.entries(c.properties).filter(([, v]) => v).map(([k]) => k).join(', ');
                html += `<div class="char-row">
                    <code>${c.uuid}</code> <span class="char-props">${props}</span>
                    ${c.properties.notify || c.properties.indicate
                        ? `<button class="btn-sm" data-svc="${svc.serviceUUID}" data-char="${c.uuid}">Subscribe</button>`
                        : ''}
                </div>`;
            });
            div.innerHTML = html;
            el.serviceBrowser.appendChild(div);
        });
        el.serviceBrowser.querySelectorAll('.btn-sm').forEach(btn => {
            btn.addEventListener('click', async () => {
                try {
                    await ble.subscribeToCharacteristic(deviceId, btn.dataset.svc, btn.dataset.char);
                    toggleModal(el.connectionModal, false);
                    toast('Subscribed!');
                } catch (err) { toast('Subscribe failed: ' + err.message, 'error'); }
            });
        });
    }

    // ── Profiles ──
    function loadProfiles() { return JSON.parse(localStorage.getItem('sensorlab_profiles') || '[]'); }
    function saveProfiles(p) { localStorage.setItem('sensorlab_profiles', JSON.stringify(p)); }
    function renderProfiles() {
        const profiles = loadProfiles();
        if (profiles.length === 0) {
            el.profileList.innerHTML = '<p class="muted">No saved profiles yet.</p>';
            return;
        }
        el.profileList.innerHTML = '';
        profiles.forEach((p, i) => {
            const card = document.createElement('div');
            card.className = 'profile-card';
            const strong = document.createElement('strong');
            strong.textContent = p.name;
            const small = document.createElement('small');
            small.textContent = p.unit || '';
            const actions = document.createElement('div');
            actions.className = 'profile-actions';
            const connBtn = document.createElement('button');
            connBtn.className = 'btn-sm';
            connBtn.textContent = 'Connect';
            connBtn.addEventListener('click', () => connectPreset(loadProfiles()[i]));
            const delBtn = document.createElement('button');
            delBtn.className = 'btn-sm btn-danger';
            delBtn.textContent = 'Delete';
            delBtn.addEventListener('click', () => { const ps = loadProfiles(); ps.splice(i, 1); saveProfiles(ps); renderProfiles(); });
            actions.appendChild(connBtn);
            actions.appendChild(delBtn);
            card.appendChild(strong);
            card.appendChild(small);
            card.appendChild(actions);
            el.profileList.appendChild(card);
        });
    }
    el.saveProfileBtn.addEventListener('click', () => {
        const svc = el.customService.value.trim();
        const chr = el.customChar.value.trim();
        if (!svc || !chr) { toast('Fill in UUIDs first', 'error'); return; }
        const name = prompt('Profile name:');
        if (!name) return;
        const profiles = loadProfiles();
        profiles.push({
            name, serviceUUID: svc, characteristicUUID: chr,
            dataFormat: el.customFormat.value,
            unit: el.customUnit.value.trim(),
            yLabel: el.customLabel.value.trim() || 'Value',
            scaleFactor: parseFloat(el.customScale.value) || 1,
        });
        saveProfiles(profiles);
        renderProfiles();
        toast('Profile saved');
    });
    renderProfiles();

    // ── BLE Events → App ──
    ble.on('connected', (info) => {
        chart.addDevice(info.deviceId, info.name, info.color);
        chart.setYAxis(info.yLabel || 'Value', info.unit || '');
        addDeviceCard(info);
        updateStatus();
        toast(`${info.name} connected`, 'success');
        appLog('ble', `Connected: ${info.name} (${info.deviceId})`);
    });
    ble.on('scanConnected', (info) => {
        addDeviceCard(info);
        updateStatus();
        appLog('ble', `Scan connected: ${info.name} (${info.deviceId})`);
    });
    ble.on('data', (d) => {
        if (!startTimestamp) startTimestamp = d.timestamp;
        const relTime = (d.timestamp - startTimestamp) / 1000;
        chart.addDataPoint(d.deviceId, d.timestamp, d.value);
        dataStore.addReading({ ...d, relTime });
        addTableRow(d, relTime);
        el.readingCount.textContent = dataStore.readings.length;
    });
    ble.on('disconnected', (info) => {
        updateStatus();
        toast(`${info.name} disconnected — reconnecting...`, 'warning');
        appLog('ble', `Disconnected: ${info.name} — attempting reconnect`);
    });
    ble.on('reconnectFailed', (info) => {
        toast(`${info.name}: reconnect failed`, 'error');
        appLog('error', `Reconnect failed: ${info.name}`);
    });
    ble.on('removed', (info) => {
        chart.removeDevice(info.deviceId);
        removeDeviceCard(info.deviceId);
        updateStatus();
        appLog('ble', `Removed: ${info.name}`);
    });
    ble.on('status', (s) => { el.statusText.textContent = s.message; });
    ble.on('error', (e) => {
        toast(e.error, 'error');
        appLog('error', e.error);
    });
    ble.on('renamed', (info) => {
        chart.renameDevice(info.deviceId, info.name);
        const card = document.querySelector(`.device-card[data-id="${info.deviceId}"] .dev-name`);
        if (card) card.textContent = info.name;
        appLog('info', `Renamed device to: ${info.name}`);
    });

    // ── Device Cards ──
    function addDeviceCard(info) {
        const existing = el.devicesPanel.querySelector(`.device-card[data-id="${info.deviceId}"]`);
        if (existing) return;
        const card = document.createElement('div');
        card.className = 'device-card';
        card.dataset.id = info.deviceId;
        card.innerHTML = `
            <div class="dev-header">
                <span class="dev-dot" style="background:${info.color}"></span>
                <span class="dev-name">${info.name}</span>
                <span class="dev-status connected">●</span>
            </div>
            <div class="dev-actions">
                <button class="btn-sm" title="Rename" data-action="rename">✏️</button>
                <button class="btn-sm" title="Zero / Calibrate" data-action="zero">⚖️ Zero</button>
                <button class="btn-sm btn-danger" title="Disconnect" data-action="disconnect">✕</button>
            </div>
            <div class="dev-calibration" style="display:none">
                <label>Offset: <input type="number" step="any" value="0" class="cal-offset"></label>
                <button class="btn-sm" data-action="applyOffset">Apply</button>
            </div>`;
        card.querySelector('[data-action="rename"]').addEventListener('click', () => {
            const n = prompt('New name:', info.name);
            if (n) ble.renameDevice(info.deviceId, n);
        });
        card.querySelector('[data-action="disconnect"]').addEventListener('click', () => {
            ble.disconnect(info.deviceId);
        });
        card.querySelector('[data-action="zero"]').addEventListener('click', () => {
            const calDiv = card.querySelector('.dev-calibration');
            calDiv.style.display = calDiv.style.display === 'none' ? 'block' : 'none';
        });
        card.querySelector('[data-action="applyOffset"]').addEventListener('click', () => {
            const offset = parseFloat(card.querySelector('.cal-offset').value) || 0;
            ble.setCalibrationOffset(info.deviceId, offset);
            toast(`Calibration offset set to ${offset}`);
        });
        el.devicesPanel.appendChild(card);
        updateExportDeviceList();
    }

    function removeDeviceCard(deviceId) {
        el.devicesPanel.querySelector(`.device-card[data-id="${deviceId}"]`)?.remove();
        updateExportDeviceList();
    }

    function updateExportDeviceList() {
        const devices = ble.getDevices();
        el.exportDeviceSel.innerHTML = '<option value="">All devices</option>';
        devices.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.id;
            opt.textContent = d.name;
            el.exportDeviceSel.appendChild(opt);
        });
    }

    // ── Data Table ──
    const MAX_TABLE_ROWS = 200;
    function addTableRow(d, relTime) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${relTime.toFixed(2)}</td><td>${d.name}</td><td>${d.value.toFixed(4)}</td><td>${d.unit || ''}</td>`;
        el.dataBody.prepend(tr);
        while (el.dataBody.children.length > MAX_TABLE_ROWS) el.dataBody.lastChild.remove();
    }

    // ── Toolbar ──
    el.timeWindowSel.addEventListener('change', () => chart.setTimeWindow(parseInt(el.timeWindowSel.value)));
    el.chartTypeSel.addEventListener('change', () => chart.setChartType(el.chartTypeSel.value));

    // Pause
    el.pauseBtn.addEventListener('click', () => {
        const paused = chart.togglePause();
        el.pauseBtn.textContent = paused ? 'Resume' : 'Pause';
        el.pauseBtn.classList.toggle('active', paused);
    });

    // Annotate
    el.annotateBtn.addEventListener('click', () => {
        const text = prompt('Annotation label:');
        if (!text) return;
        const now = Date.now() / 1000;   // epoch seconds — matches chart X axis
        chart.addAnnotation(now, text);
        dataStore.addAnnotation(text);
        toast('Annotation added');
        appLog('annotation', `"${text}" at ${now.toFixed(1)}s`);
    });

    // Record (session modal)
    el.recordBtn.addEventListener('click', () => {
        if (dataStore.isRecording) {
            const summary = dataStore.stopSession();
            el.recordBtn.textContent = 'Record';
            el.recordBtn.classList.remove('recording');
            el.sessionInfo.textContent = '';
            toast(`Session "${summary.session.name}" stopped — ${summary.totalReadings} readings`);
            appLog('session', `Stopped: "${summary.session.name}" — ${summary.totalReadings} readings`);
            // Save to cloud if signed in
            if (cloudStore && summary.totalReadings > 0) {
                saveSessionToCloud(summary);
            }
        } else {
            toggleModal(el.sessionModal, true);
        }
    });
    el.sessionForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = document.getElementById('sessionName').value.trim() || 'Untitled';
        const group = document.getElementById('sessionGroup').value.trim();
        startTimestamp = null;
        chart.reset();
        dataStore.startSession(name, group);
        el.recordBtn.textContent = 'Stop';
        el.recordBtn.classList.add('recording');
        el.sessionInfo.textContent = `Session: ${name}`;
        toggleModal(el.sessionModal, false);
        toast('Recording started: ' + name, 'success');
        appLog('session', `Started: "${name}"${group ? ' (' + group + ')' : ''}`);
    });

    // Export
    el.exportCSVBtn.addEventListener('click', () => {
        const deviceFilter = el.exportDeviceSel.value || undefined;
        const csv = dataStore.exportCSV(deviceFilter);
        if (!csv) { toast('No data to export', 'error'); return; }
        const suffix = deviceFilter ? '_' + (ble.getDevices().find(d => d.id === deviceFilter)?.name || 'device') : '';
        dataStore.downloadFile(csv, `sensorlab${suffix}_${Date.now()}.csv`, 'text/csv');
    });
    el.exportJSONBtn.addEventListener('click', () => {
        const deviceFilter = el.exportDeviceSel.value || undefined;
        const json = dataStore.exportJSON(deviceFilter);
        const suffix = deviceFilter ? '_' + (ble.getDevices().find(d => d.id === deviceFilter)?.name || 'device') : '';
        dataStore.downloadFile(json, `sensorlab${suffix}_${Date.now()}.json`, 'application/json');
    });

    // ── Helpers ──
    // Update connection dot in header
    function updateStatus() {
        const n = ble.connectedCount;
        el.statusText.textContent = n > 0 ? `${n} device${n > 1 ? 's' : ''} connected` : 'No devices';
        const dot = document.getElementById('connectionDot');
        if (dot) {
            dot.className = 'connection-dot ' + (n > 0 ? 'connected' : 'disconnected');
        }
        // Toggle sidebar empty state
        const empty = document.getElementById('sidebarEmpty');
        if (empty) empty.style.display = n > 0 ? 'none' : 'flex';
    }
    function toggleModal(modal, open) {
        if (open) modal.classList.add('open');
        else modal.classList.remove('open');
    }
    function toast(msg, type) {
        const t = document.createElement('div');
        t.className = 'toast ' + (type || 'info');
        t.textContent = msg;
        el.toastContainer.appendChild(t);
        setTimeout(() => t.classList.add('show'), 10);
        setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 4000);
    }

    // ── Cloud Save Helper ──
    async function saveSessionToCloud(summary) {
        try {
            const sessionId = await cloudStore.saveSession(summary.session);
            // Combine in-memory readings with any already flushed to IDB for completeness
            let recordings = dataStore.readings.filter(r => r.session === summary.session.name);
            try {
                const idbRecordings = await dataStore.getSessionRecordings(summary.session.name);
                if (idbRecordings.length > recordings.length) {
                    recordings = idbRecordings;
                }
            } catch { /* fallback to in-memory only */ }
            if (recordings.length > 0) {
                await cloudStore.saveRecordings(sessionId, recordings);
            }
            if (summary.annotations && summary.annotations.length > 0) {
                await cloudStore.saveAnnotations(sessionId, summary.annotations);
            }
            toast('Saved to cloud', 'success');
            appLog('info', `Session "${summary.session.name}" saved to cloud (${recordings.length} readings)`);
        } catch (err) {
            toast('Cloud save failed: ' + err.message, 'error');
            appLog('error', `Cloud save failed: ${err.message}`);
        }
    }

    // ── Past Experiments / History ──
    el.historyBtn.addEventListener('click', () => {
        toggleModal(el.historyModal, true);
        loadHistory();
    });

    let historyChart = null;
    let historySessionData = null;
    let historySessionMeta = null;
    let historyAnnotations = [];

    async function loadHistory() {
        el.historyList.innerHTML = '<p class="muted">Loading...</p>';
        el.historyViewer.style.display = 'none';
        el.historyList.style.display = 'block';

        // Fetch local sessions
        let sessions = await dataStore.getSavedSessions();

        // Also fetch cloud sessions if signed in
        let cloudSessions = [];
        if (cloudStore) {
            try {
                cloudSessions = await cloudStore.getSavedSessions();
                // Mark cloud sessions with source and id
                cloudSessions = cloudSessions.map(s => ({ ...s, _source: 'cloud', _cloudId: s.id }));
            } catch (err) {
                appLog('error', `Cloud history load failed: ${err.message}`);
            }
        }

        // Mark local sessions
        sessions = sessions.map(s => ({ ...s, _source: 'local' }));

        // Merge (cloud first, then local)
        const allSessions = [...cloudSessions, ...sessions];

        if (allSessions.length === 0) {
            el.historyList.innerHTML = '<p class="muted">No past experiments found.</p>';
            return;
        }
        // Sort newest first
        allSessions.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
        el.historyList.innerHTML = allSessions.map((s, i) => {
            const date = s.startTime ? new Date(s.startTime).toLocaleString() : 'Unknown date';
            const group = s.group ? ` · ${sanitize(s.group)}` : '';
            const badge = s._source === 'cloud' ? ' <span style="color:var(--accent-blue);font-size:.625rem">☁</span>' : '';
            return `<div class="history-session" data-idx="${i}">
                <div class="hs-info">
                    <span class="hs-name">${sanitize(s.name)}${badge}</span>
                    <span class="hs-meta">${date}${group}</span>
                </div>
                <div class="hs-actions">
                    <button class="btn-sm" data-action="view" data-idx="${i}">View</button>
                    <button class="btn-sm btn-danger" data-action="delete" data-idx="${i}">Delete</button>
                </div>
            </div>`;
        }).join('');

        el.historyList.querySelectorAll('[data-action="view"]').forEach(btn => {
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const s = allSessions[parseInt(btn.dataset.idx)];
                viewSession(s);
            });
        });
        el.historyList.querySelectorAll('[data-action="delete"]').forEach(btn => {
            btn.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                const s = allSessions[parseInt(btn.dataset.idx)];
                if (!confirm(`Delete experiment "${s.name}" and all its data?`)) return;
                if (s._source === 'cloud' && cloudStore) {
                    await cloudStore.deleteSession(s._cloudId);
                } else {
                    await dataStore.deleteSession(s.name);
                }
                toast('Experiment deleted');
                loadHistory();
            });
        });
    }

    async function viewSession(session) {
        el.historyList.style.display = 'none';
        el.historyViewer.style.display = 'block';
        el.historyViewerTitle.textContent = session.name;

        historySessionMeta = session;
        const date = session.startTime ? new Date(session.startTime).toLocaleString() : '';
        const group = session.group || '';
        el.historyMeta.textContent = [date, group].filter(Boolean).join(' · ');

        // Load recordings from correct source
        let recordings, annotations;
        if (session._source === 'cloud' && cloudStore) {
            recordings = await cloudStore.getSessionRecordings(session._cloudId);
            annotations = await cloudStore.getSessionAnnotations(session._cloudId);
        } else {
            recordings = await dataStore.getSessionRecordings(session.name);
            annotations = await dataStore.getSessionAnnotations(session.name);
        }
        historySessionData = recordings;
        historyAnnotations = annotations;

        // Build chart
        if (historyChart) { historyChart.destroy(); historyChart = null; }
        const canvas = document.getElementById('historyChart');
        const deviceMap = new Map();
        const colors = ['#60a5fa','#4ade80','#fbbf24','#f87171','#c084fc','#22d3ee','#fb923c','#a1a1aa'];
        let ci = 0;
        const baseTime = recordings.length > 0 ? recordings[0].timestamp : 0;
        recordings.forEach(r => {
            const key = r.name || r.deviceId || 'sensor';
            if (!deviceMap.has(key)) {
                deviceMap.set(key, { label: key, data: [], borderColor: colors[ci % colors.length], borderWidth: 1.5, pointRadius: 0, fill: false });
                ci++;
            }
            deviceMap.get(key).data.push({ x: (r.timestamp - baseTime) / 1000, y: r.value });
        });
        const cs = getComputedStyle(document.documentElement);
        const gridColor = cs.getPropertyValue('--chart-grid').trim();
        const tickColor = cs.getPropertyValue('--chart-tick').trim();
        const titleColor = cs.getPropertyValue('--chart-title').trim();
        const legendColor = cs.getPropertyValue('--chart-legend').trim();
        historyChart = new Chart(canvas, {
            type: 'line',
            data: { datasets: [...deviceMap.values()] },
            options: {
                responsive: true, maintainAspectRatio: false, animation: false,
                scales: {
                    x: { type: 'linear', title: { display: true, text: 'Time (s)', color: titleColor }, ticks: { color: tickColor }, grid: { color: gridColor } },
                    y: { title: { display: true, text: recordings[0]?.unit ? `Value (${recordings[0].unit})` : 'Value', color: titleColor }, ticks: { color: tickColor }, grid: { color: gridColor } }
                },
                plugins: { legend: { labels: { color: legendColor, font: { family: 'Inter, system-ui, sans-serif', size: 11 } } } }
            }
        });
        // Render annotations on the history chart
        const historyAnns = historyAnnotations.map(a => ({
            x: (a.timestamp - baseTime) / 1000,
            label: a.text || ''
        }));
        historyChart._slAnnotations = historyAnns;

        // Build table (show up to 500 rows)
        el.historyTableBody.innerHTML = '';
        const tableData = recordings.slice(0, 500);
        tableData.forEach(r => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${((r.timestamp - baseTime) / 1000).toFixed(2)}</td><td>${sanitize(r.name || r.deviceId || '')}</td><td>${r.value.toFixed(4)}</td><td>${sanitize(r.unit || '')}</td>`;
            el.historyTableBody.appendChild(tr);
        });
        if (recordings.length > 500) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td colspan="4" class="muted">Showing 500 of ${recordings.length} rows — export for full data</td>`;
            el.historyTableBody.appendChild(tr);
        }
    }

    el.historyBack.addEventListener('click', () => {
        el.historyViewer.style.display = 'none';
        el.historyList.style.display = 'block';
        if (historyChart) { historyChart.destroy(); historyChart = null; }
    });

    el.historyExportCSV.addEventListener('click', () => {
        if (!historySessionData || historySessionData.length === 0) { toast('No data', 'error'); return; }
        const csv = dataStore.exportCSVFromData(historySessionData);
        dataStore.downloadFile(csv, `${historySessionMeta?.name || 'session'}_${Date.now()}.csv`, 'text/csv');
    });
    el.historyExportJSON.addEventListener('click', () => {
        if (!historySessionData || historySessionData.length === 0) { toast('No data', 'error'); return; }
        const json = dataStore.exportJSONFromData(historySessionData, historySessionMeta, historyAnnotations);
        dataStore.downloadFile(json, `${historySessionMeta?.name || 'session'}_${Date.now()}.json`, 'application/json');
    });

    function sanitize(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    updateStatus();
})();
