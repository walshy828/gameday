// public/js/netMonitor.js
// Connection health for signed-in staff (referees + tournament admins): is
// THIS phone/laptop keeping a steady link to the server on the venue Wi-Fi?
//
// Built to add no traffic and no risk:
// - It sends nothing of its own. It listens to things that already happen:
//   Socket.IO's heartbeat (the server pings every tab every 25s anyway), the
//   socket's disconnect/reconnect, the app's own /api requests (timed by a
//   pass-through wrapper around fetch that never changes the request or its
//   result), the browser's online/offline events and, in firebase mode, the
//   Firebase SDK's local `.info/connected` flag.
// - Starts only once someone signs in as a referee or tournament admin;
//   participants and parents never run it.
// - The log lives on the device (localStorage `netLog`, last 12h, at most 300
//   events). A few counts ride along in the presence message the tab already
//   sends when something changes (presence.js), so Setup → Live now can show
//   every staff device. That message only changes when something bad happens.
// - Every hook is wrapped in try/catch: if anything here breaks it just stops
//   recording; the app is unaffected.
// - Events that happened while the tab was in the background (screen locked,
//   other app open) are kept but flagged `bg` and not counted: phones drop
//   connections on purpose then, and that isn't the Wi-Fi's fault.

const LOG_KEY = 'netLog';
const MAX_EVENTS = 300;
const KEEP_MS = 12 * 60 * 60 * 1000;
const STALL_MS = 40 * 1000;      // heartbeat is every 25s; 40s without one = stalled
const SLOW_MS = 3000;            // an /api request slower than this is "slow"
const RECENT_MS = 5 * 60 * 1000; // amber for 5 min after a problem
const TICK_MS = 5000;
const MAX_SAMPLES = 200;

let started = false;
let socket = null;
let events = [];          // { type, at, ms?, reason?, path?, kind?, bg? }
let samples = [];         // { t, ms, path } successful /api requests
let lastPingAt = 0;
let connected = false;
let downSince = 0;
let downReason = '';
let downBg = false;
let offlineSince = 0;
let fbDownSince = 0;
let fbAttached = false;
let lastShownAt = 0;      // last time the tab became visible
const listeners = new Set();
let lastStatusSig = '';

const now = () => Date.now();

function load() {
    try {
        const raw = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
        if (Array.isArray(raw)) events = raw.filter(e => e && typeof e.at === 'number' && now() - e.at < KEEP_MS).slice(-MAX_EVENTS);
    } catch (e) { events = []; }
}

function save() {
    try { localStorage.setItem(LOG_KEY, JSON.stringify(events)); } catch (e) { /* storage full / private mode */ }
}

/** True if the tab was hidden at any point since `since` (or is hidden now). */
function wasBackground(since) {
    return document.visibilityState === 'hidden' || lastShownAt >= since;
}

function add(ev) {
    try {
        events.push(ev);
        const cut = now() - KEEP_MS;
        while (events.length > MAX_EVENTS || (events.length && events[0].at < cut)) events.shift();
        save();
        changed(true);
    } catch (e) { /* never let logging break the app */ }
}

function changed(force) {
    const s = status();
    const sig = s.level + '|' + s.text;
    if (!force && sig === lastStatusSig) return;
    lastStatusSig = sig;
    for (const fn of listeners) { try { fn(s); } catch (e) { /* listener error */ } }
}

// --- Socket.IO ------------------------------------------------------------
function attachSocket(s) {
    socket = s;
    connected = !!s.connected;
    lastPingAt = connected ? now() : 0;
    // The Manager (s.io) emits "ping" each time the server's heartbeat arrives.
    s.io.on('ping', () => {
        try {
            const t = now();
            if (lastPingAt && t - lastPingAt > STALL_MS && !wasBackground(lastPingAt)) {
                add({ type: 'stall', at: lastPingAt, ms: t - lastPingAt });
            }
            lastPingAt = t;
        } catch (e) { /* ignore */ }
    });
    s.on('disconnect', (reason) => {
        try {
            connected = false;
            if (reason === 'io client disconnect') return; // the app closed it on purpose
            downSince = now();
            downReason = String(reason || '');
            downBg = document.visibilityState === 'hidden';
            changed();
        } catch (e) { /* ignore */ }
    });
    s.on('connect', () => {
        try {
            const t = now();
            connected = true;
            lastPingAt = t;
            if (downSince) {
                add({ type: 'drop', at: downSince, ms: t - downSince, reason: downReason, bg: downBg || wasBackground(downSince) || undefined });
                downSince = 0;
            } else changed();
        } catch (e) { /* ignore */ }
    });
}

// --- /api request timing (pass-through) -------------------------------------
function apiPath(input) {
    try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const u = new URL(url, window.location.href);
        if (u.origin !== window.location.origin || !u.pathname.startsWith('/api/')) return '';
        return u.pathname;
    } catch (e) { return ''; }
}

function wrapFetch() {
    const orig = window.fetch;
    if (typeof orig !== 'function' || orig.__netMonitor) return;
    const wrapped = function (input, init) {
        const path = apiPath(input);
        const p = orig.call(window, input, init);
        if (!path) return p;
        const t0 = now();
        // Observe only: a side chain, so the caller gets exactly the original promise.
        p.then((res) => {
            try {
                const ms = now() - t0;
                if (res && res.status >= 500) add({ type: 'fail', at: t0, ms, path, kind: 'server' });
                else {
                    samples.push({ t: t0, ms, path });
                    if (samples.length > MAX_SAMPLES) samples.shift();
                    if (ms > SLOW_MS && !wasBackground(t0)) add({ type: 'slow', at: t0, ms, path });
                }
            } catch (e) { /* ignore */ }
        }, (err) => {
            try {
                const kind = err && err.name === 'AbortError' ? 'timeout' : 'network';
                add({ type: 'fail', at: t0, ms: now() - t0, path, kind, bg: wasBackground(t0) || undefined });
            } catch (e) { /* ignore */ }
        });
        return p;
    };
    wrapped.__netMonitor = true;
    window.fetch = wrapped;
}

// --- Firebase (firebase mode only; local flag, no traffic) -----------------
function attachFirebase() {
    if (fbAttached || window.__DATA_BACKEND__ === 'local') return;
    try {
        if (!window.firebase || !firebase.apps || !firebase.apps.length) return;
        fbAttached = true;
        let seenUp = false;
        firebase.database().ref('.info/connected').on('value', (snap) => {
            try {
                const up = snap.val() === true;
                if (up) {
                    if (fbDownSince) add({ type: 'firebase', at: fbDownSince, ms: now() - fbDownSince, bg: wasBackground(fbDownSince) || undefined });
                    fbDownSince = 0; seenUp = true;
                } else if (seenUp && !fbDownSince) { fbDownSince = now(); changed(); }
            } catch (e) { /* ignore */ }
        });
    } catch (e) { fbAttached = true; /* not available: skip */ }
}

// --- Public API -------------------------------------------------------------
/** Start once, when a referee/tournament admin is signed in. Safe to call repeatedly. */
export function startNetMonitor(getSocketFn) {
    if (started) return;
    started = true;
    try {
        load();
        lastShownAt = 0;
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'hidden') { lastShownAt = now(); if (connected) lastPingAt = now(); }
        });
        window.addEventListener('offline', () => { offlineSince = now(); changed(); });
        window.addEventListener('online', () => {
            if (offlineSince) add({ type: 'offline', at: offlineSince, ms: now() - offlineSince, bg: wasBackground(offlineSince) || undefined });
            offlineSince = 0;
        });
        wrapFetch();
        try { const s = getSocketFn && getSocketFn(); if (s) attachSocket(s); } catch (e) { /* no socket: skip */ }
        attachFirebase();
        setInterval(() => { attachFirebase(); changed(); }, TICK_MS);
    } catch (e) { console.warn('netMonitor disabled:', e); }
}

export function isNetMonitorRunning() { return started; }

export function onNetStatus(fn) { listeners.add(fn); if (started) fn(status()); return () => listeners.delete(fn); }

function counted(since) { return events.filter(e => !e.bg && e.at >= since); }

function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}
function pct(arr, p) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

/** Current state for the header dot: level 0 good / 1 shaky / 2 down. */
export function status() {
    if (!started) return { level: 0, text: 'Not monitoring' };
    const t = now();
    const visible = document.visibilityState !== 'hidden';
    if (navigator.onLine === false || offlineSince) return { level: 2, text: 'Device is offline' };
    if (socket && !connected && downSince && visible) return { level: 2, text: `Disconnected from server ${secs(t - downSince)}` };
    if (connected && visible && lastPingAt && t - lastPingAt > STALL_MS && lastShownAt < lastPingAt) {
        return { level: 2, text: `No heartbeat from server for ${secs(t - lastPingAt)}` };
    }
    if (fbDownSince && visible) return { level: 2, text: `Live data (Firebase) disconnected ${secs(t - fbDownSince)}` };
    const recent = counted(t - RECENT_MS);
    if (recent.length) {
        const last = recent[recent.length - 1];
        return { level: 1, text: `${describe(last)} · ${ago(t - (last.at + (last.ms || 0)))}` };
    }
    return { level: 0, text: 'Connection steady' };
}

function secs(ms) {
    const s = Math.round(ms / 1000);
    return s < 90 ? `${s}s` : `${Math.round(s / 60)} min`;
}
function ago(ms) { return ms < 60000 ? 'just now' : `${Math.round(ms / 60000)} min ago`; }

const PATH_LABELS = {
    '/api/saveMatchResult': 'saving a score', '/api/allData': 'loading scores', '/api/courtStatus': 'court board',
    '/api/courtStatus/mark': 'marking ready', '/api/session/heartbeat': 'sign-in check', '/api/usage': 'Live now'
};
const pathLabel = (p) => PATH_LABELS[p] || (p || '').replace('/api/', '');

export function describe(e) {
    switch (e.type) {
        case 'drop': return `Lost connection to server for ${secs(e.ms)}${e.reason === 'ping timeout' ? ' (no response)' : ''}`;
        case 'stall': return `Server heartbeat late by ${secs(e.ms - 25000)}`;
        case 'slow': return `Slow ${pathLabel(e.path)}: ${(e.ms / 1000).toFixed(1)}s`;
        case 'fail': return e.kind === 'server' ? `Server error ${pathLabel(e.path)}`
            : e.kind === 'timeout' ? `Timed out ${pathLabel(e.path)} after ${secs(e.ms)}`
                : `Couldn't reach server (${pathLabel(e.path)})`;
        case 'offline': return `Device offline for ${secs(e.ms)}`;
        case 'firebase': return `Live data (Firebase) dropped for ${secs(e.ms)}`;
        default: return e.type;
    }
}

/** Everything the "This device" sheet shows. */
export function netSummary() {
    const t = now();
    const hour = counted(t - 60 * 60 * 1000);
    const all = counted(t - KEEP_MS);
    const recentSamples = samples.filter(s => t - s.t < 15 * 60 * 1000).map(s => s.ms);
    const saves = samples.filter(s => s.path === '/api/saveMatchResult').slice(-20).map(s => s.ms);
    const conn = navigator.connection || null;
    const count = (list, type) => list.filter(e => e.type === type).length;
    const downMs = (list) => list.filter(e => e.type === 'drop' || e.type === 'offline' || e.type === 'firebase').reduce((n, e) => n + (e.ms || 0), 0);
    return {
        status: status(),
        lastHour: { drops: count(hour, 'drop') + count(hour, 'offline') + count(hour, 'firebase'), stalls: count(hour, 'stall'), fails: count(hour, 'fail'), slow: count(hour, 'slow'), downMs: downMs(hour) },
        today: { drops: count(all, 'drop') + count(all, 'offline') + count(all, 'firebase'), stalls: count(all, 'stall'), fails: count(all, 'fail'), slow: count(all, 'slow'), downMs: downMs(all) },
        typicalMs: median(recentSamples), p90Ms: pct(recentSamples, 0.9), sampleCount: recentSamples.length,
        saves: { count: saves.length, typicalMs: median(saves), worstMs: saves.length ? Math.max(...saves) : 0 },
        network: conn ? { type: conn.effectiveType || '', rtt: conn.rtt, downlink: conn.downlink } : null,
        events: events.slice().reverse()
    };
}

/** Tiny counts for the presence message (sent only when they change). */
export function netCounts() {
    if (!started) return null;
    const all = counted(now() - KEEP_MS);
    const c = (type) => all.filter(e => e.type === type).length;
    const lastBad = all.length ? all[all.length - 1].at : 0;
    const saves = samples.filter(s => s.path === '/api/saveMatchResult').map(s => s.ms);
    return {
        drops: c('drop') + c('offline') + c('firebase'),
        downSec: Math.round(all.filter(e => e.type === 'drop' || e.type === 'offline' || e.type === 'firebase').reduce((n, e) => n + (e.ms || 0), 0) / 1000),
        stalls: c('stall'), fails: c('fail'), slow: c('slow'),
        worstSaveMs: saves.length ? Math.round(Math.max(...saves) / 100) * 100 : 0,
        lastBadAt: lastBad
    };
}

export function clearNetLog() {
    events = []; samples = [];
    save(); changed(true);
}
