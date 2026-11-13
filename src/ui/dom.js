/**
 * DOM helpers. Untrusted strings (BLE names, units, UUIDs, session names) are only ever set via
 * textContent or attributes, never via innerHTML (baseline defect D6).
 */
export const $ = (id) => document.getElementById(id);

/** h('div', {class:'x', onclick: fn, 'aria-label': 'y'}, 'text', childNode, ...) */
export function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v === null || v === undefined || v === false) continue;
        if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'class') el.className = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'hidden') el.hidden = !!v;
        else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

export function toast(msg, type = 'info', ms = 4500) {
    const t = h('div', { class: 'toast ' + type, role: type === 'error' ? 'alert' : 'status' }, msg);
    $('toasts').append(t);
    setTimeout(() => t.remove(), ms);
}

const MAX_LOG = 500;
export function log(kind, msg) {
    const body = $('logBody');
    if (!body) return;
    const now = new Date();
    const ts = now.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(now.getMilliseconds()).padStart(3, '0');
    body.append(h('li', { class: kind }, h('span', { class: 't' }, ts), h('span', { class: 'k' }, kind.toUpperCase()), String(msg)));
    while (body.children.length > MAX_LOG) body.firstChild.remove();
    body.scrollTop = body.scrollHeight;
}

export function openDialog(d) { if (!d.open) d.showModal(); }
export function closeDialog(d) { if (d.open) d.close(); }

/** Promise-based confirmation with optional typed confirmation ("DELETE"). */
export function confirmAction(text, { typed = false, okLabel = 'Confirm' } = {}) {
    const d = $('confirmDialog');
    $('confirmText').textContent = text;
    $('confirmTypedWrap').hidden = !typed;
    $('confirmTyped').value = '';
    $('confirmOk').textContent = okLabel;
    openDialog(d);
    (typed ? $('confirmTyped') : $('confirmCancel')).focus();
    return new Promise((resolve) => {
        const done = (v) => { cleanup(); closeDialog(d); resolve(v); };
        const ok = () => { if (typed && $('confirmTyped').value !== 'DELETE') { $('confirmTyped').focus(); return; } done(true); };
        const cancel = () => done(false);
        const onClose = () => { cleanup(); resolve(false); };
        function cleanup() {
            $('confirmOk').removeEventListener('click', ok);
            $('confirmCancel').removeEventListener('click', cancel);
            d.removeEventListener('cancel', onClose);
        }
        $('confirmOk').addEventListener('click', ok);
        $('confirmCancel').addEventListener('click', cancel);
        d.addEventListener('cancel', onClose, { once: true });
    });
}

/**
 * How long a download's blob URL must stay valid. Chrome reads the blob asynchronously; revoking too early cancels
 * the download (observed: a 575 MB CSV was cancelled at 0 bytes when revoked after 10 s). Keep at least 60 s, plus
 * 1 s per MB. URLs are also released when the page is hidden for good (pagehide).
 */
export function revokeDelayMs(bytes) { return Math.max(60_000, Math.ceil(bytes / 1048576) * 1000); }
const pendingUrls = new Set();
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { for (const u of pendingUrls) URL.revokeObjectURL(u); pendingUrls.clear(); });

export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    pendingUrls.add(url);
    const a = h('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => { URL.revokeObjectURL(url); pendingUrls.delete(url); }, revokeDelayMs(blob.size));
}

export function fmtNum(v, digits = 4) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(3);
    return Number(v.toFixed(digits)).toString();
}

export function fmtBytes(n) {
    if (!Number.isFinite(n)) return '?';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function fmtDuration(s) {
    s = Math.max(0, Math.floor(s));
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return (hh ? hh + ':' : '') + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}

export const lsGet = (k, d = null) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } };
export const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable: preference only */ } };
