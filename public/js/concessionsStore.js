// public/js/concessionsStore.js
// Local-first data layer for the concession stand. A sale is ALWAYS written to this phone first (localStorage,
// synchronously, before anything touches the network) and then posted to the server from an outbox; so selling
// works the same online and offline, and a dropped connection can never lose or delay a sale.
//
//   cn:catalog  items + settings + seasons from the last successful load (the stand runs from this when offline)
//   cn:sales    this season's sales by clientId: server rows, plus ones made here that haven't synced yet
//   cn:outbox   ordered operations still to post ({op:'sale'|'void', clientId, ...}); order matters (a void
//               follows its sale)
//   cn:failed   operations the server permanently rejected (shown to the user, never silently dropped)
//   cn:auth     token + name (+ role: concessions or raffle), so a phone that reloads while offline can still sign in
//
// Every operation is idempotent on the sale's clientId, so retries and double syncs are safe. If localStorage is
// unavailable (private mode) it falls back to memory and `persistent` is false, which the UI warns about.
import { getConcessions, getConcessionSales, postConcessionSale, postConcessionVoid } from './api.js';

const PREFIX = 'cn:';
const mem = {};
let persistent = true;

function read(key, fallback) {
    try {
        const raw = localStorage.getItem(PREFIX + key);
        return raw == null ? (key in mem ? mem[key] : fallback) : JSON.parse(raw);
    } catch (e) { persistent = false; return key in mem ? mem[key] : fallback; }
}
function write(key, value) {
    mem[key] = value;
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch (e) { persistent = false; }
}

const state = {
    catalog: read('catalog', null),
    sales: read('sales', { seasonId: null, byId: {} }),
    outbox: read('outbox', []),
    failed: read('failed', []),
    online: null,          // null = unknown yet, true/false = result of the last request
    syncing: false,
    lastSyncAt: 0,
    authProblem: false
};

const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const notify = () => listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });

export const isPersistent = () => persistent;
export const getState = () => state;
export const pendingCount = () => state.outbox.filter((o) => o.op === 'sale').length;
export const outboxCount = () => state.outbox.length;

/* ---------- sign-in that survives an offline reload ---------- */

const AUTH_MAX_AGE = 24 * 3600e3;
export function saveAuth(token, name, role = 'concessions') { try { localStorage.setItem(PREFIX + 'auth', JSON.stringify({ token, name, role, t: Date.now() })); } catch (e) { /* storage unavailable */ } }
export function loadAuth() {
    try {
        const a = JSON.parse(localStorage.getItem(PREFIX + 'auth') || 'null');
        if (a && a.token && Date.now() - a.t < AUTH_MAX_AGE) return a;
    } catch (e) { /* ignore */ }
    return null;
}
export function clearAuth() { try { localStorage.removeItem(PREFIX + 'auth'); } catch (e) { /* ignore */ } }
export function authToken() {
    try { return sessionStorage.getItem('adminAuthToken') || (loadAuth() || {}).token || null; } catch (e) { return (loadAuth() || {}).token || null; }
}

/* ---------- reading ---------- */

export const catalog = () => state.catalog;
export const currentSeasonId = () => (state.catalog && state.catalog.season ? state.catalog.season.id : null);

/** Sales for the current season, oldest first (server rows plus anything still waiting to sync). */
export function sales() {
    const sid = currentSeasonId();
    return Object.values(state.sales.byId).filter((s) => sid == null || s.seasonId === sid).sort((a, b) => a.t - b.t);
}

export function newId() {
    return (crypto.randomUUID && crypto.randomUUID()) || (Date.now().toString(16) + Math.random().toString(16).slice(2));
}

/* ---------- loading from the server ---------- */

function markNetwork(ok, err) {
    state.online = ok;
    if (ok) { state.lastSyncAt = Date.now(); state.authProblem = false; }
    else if (err && (err.status === 401 || err.status === 403)) { state.authProblem = true; }
}

/** Refreshes items/settings/seasons. Returns true on success; offline it quietly keeps the cached copy. */
export async function loadCatalog() {
    const token = authToken();
    if (!token) return false;
    try {
        const c = await getConcessions(token);
        state.catalog = { items: c.items, settings: c.settings, seasons: c.seasons, season: c.season, serverTime: c.serverTime };
        write('catalog', state.catalog);
        markNetwork(true);
        notify();
        return true;
    } catch (e) {
        markNetwork(e.status !== 0 ? true : false, e);
        notify();
        return false;
    }
}

/** Adopts a catalog the server just returned from an items/settings save. */
export function applyCatalog(c) {
    state.catalog = { items: c.items, settings: c.settings, seasons: c.seasons, season: c.season, serverTime: c.serverTime };
    write('catalog', state.catalog);
    notify();
}

/** Replaces the cached sales with the server's, keeping sales/voids that haven't reached the server yet. */
export async function loadSales() {
    const token = authToken();
    if (!token) return false;
    try {
        const out = await getConcessionSales(token);
        const byId = {};
        out.sales.forEach((s) => { byId[s.clientId] = s; });
        const voidPending = new Set(state.outbox.filter((o) => o.op === 'void').map((o) => o.clientId));
        // Unsynced sales survive even if the season changed meanwhile (they sync into the season they were made in).
        Object.values(state.sales.byId).forEach((s) => {
            if (s.pending) byId[s.clientId] = s;                                               // made here, not on the server yet
            else if (voidPending.has(s.clientId) && byId[s.clientId]) byId[s.clientId] = { ...byId[s.clientId], ...pick(s, ['voided', 'voidBy', 'voidAt', 'voidReason', 'voidPending']) };
        });
        state.sales = { seasonId: out.season.id, byId };
        write('sales', state.sales);
        markNetwork(true);
        notify();
        return true;
    } catch (e) {
        markNetwork(e.status !== 0, e);
        notify();
        return false;
    }
}
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

/** A past season's sales, straight from the server (online only; not cached). */
export async function fetchSeasonSales(seasonId) {
    const out = await getConcessionSales(authToken(), seasonId);
    return out.sales;
}

/* ---------- writing (local first) ---------- */

function persistAll() {
    write('sales', state.sales);
    write('outbox', state.outbox);
    write('failed', state.failed);
}

/** Records a sale on this phone and queues it for the server. Never needs the network. */
export function recordSale({ lines, payment, seller }) {
    const total = Math.round(lines.reduce((a, l) => a + l.price * l.qty, 0) * 100) / 100;
    const sale = {
        clientId: newId(), seasonId: currentSeasonId(), seq: null, seller, lines, total, payment,
        t: Date.now(), voided: false, voidBy: '', voidAt: null, voidReason: '', pending: true
    };
    state.sales.seasonId = sale.seasonId;
    state.sales.byId[sale.clientId] = sale;
    state.outbox.push({ op: 'sale', clientId: sale.clientId });
    persistAll();
    notify();
    sync();
    return sale;
}

export function voidSale(clientId, by, reason) {
    const s = state.sales.byId[clientId];
    if (!s || s.voided) return;
    s.voided = true; s.voidBy = by; s.voidAt = Date.now(); s.voidReason = reason || ''; s.voidPending = true;
    state.outbox.push({ op: 'void', clientId, by, reason: s.voidReason, at: s.voidAt });
    persistAll();
    notify();
    sync();
}

export function dismissFailed(index) {
    state.failed.splice(index, 1);
    write('failed', state.failed);
    notify();
}

/* ---------- the outbox ---------- */

export async function sync() {
    if (state.syncing || !state.outbox.length) return;
    const token = authToken();
    if (!token) return;
    state.syncing = true; notify();
    try {
        while (state.outbox.length) {
            const op = state.outbox[0];
            const local = state.sales.byId[op.clientId];
            try {
                if (op.op === 'sale') {
                    if (!local) { state.outbox.shift(); continue; }
                    const r = await postConcessionSale(token, { clientId: local.clientId, seasonId: local.seasonId, seller: local.seller, lines: local.lines, payment: local.payment, soldAt: local.t });
                    const keepVoid = local.voided && !r.sale.voided;
                    state.sales.byId[local.clientId] = keepVoid ? { ...r.sale, voided: true, voidBy: local.voidBy, voidAt: local.voidAt, voidReason: local.voidReason, voidPending: true } : r.sale;
                } else {
                    const r = await postConcessionVoid(token, { clientId: op.clientId, by: op.by, reason: op.reason, at: op.at });
                    if (local) state.sales.byId[op.clientId] = r.sale;
                }
                state.outbox.shift();
                markNetwork(true);
                persistAll();
                notify();
            } catch (e) {
                if (e.status === 400) {
                    // The server will never accept this one: park it where the user can see it and keep going.
                    state.outbox.shift();
                    state.failed.push({ ...op, error: e.message, at: Date.now() });
                    if (local && op.op === 'sale') { local.pending = false; local.failed = e.message; }
                    markNetwork(true);
                    persistAll();
                    notify();
                    continue;
                }
                markNetwork(false, e);          // offline, server down or sign-in problem: stop and retry later
                break;
            }
        }
    } finally {
        state.syncing = false;
        notify();
    }
}

/* ---------- keep-alive: sync when the connection returns, and on a timer ---------- */

let started = false;
export function startSync() {
    if (started) return;
    started = true;
    window.addEventListener('online', () => { sync(); });
    setInterval(() => { if (!document.hidden) sync(); }, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
    // Ask the browser not to evict this data under storage pressure (best effort; some browsers ignore it).
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { /* ignore */ }
}
