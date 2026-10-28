// public/js/raffleStore.js
// Local-first data layer for raffle selling, the same idea as concessionsStore.js. A sale is ALWAYS decided and
// saved on this phone first (localStorage, synchronously) and then posted to the server from an outbox, so a
// dropped connection can never lose or delay a sale. The phone picks the ticket numbers itself, from the last
// roll state it saw plus every sale it has made since (the seller tears exactly those tickets); the server records
// those exact numbers in the sheet + database and flags it if another phone sold the same tickets meanwhile.
//
//   rf:snap     the last server payload (config, rolls, sales) - the sell form runs from this when offline
//   rf:log      every sale made on this phone by clientId, with its status (pending / synced / failed) -
//               the on-device record you can read, copy or download if the connection never comes back
//   rf:outbox   clientIds still to post, oldest first (a sale's numbers depend on the ones before it)
//   rf:seq      this phone's sale counter, shown as "Local #n" until the sheet assigns the real receipt
//
// Posting is idempotent on clientId (the server answers a repeat with what it already recorded), so retries and
// double syncs are safe. If localStorage is unavailable it falls back to memory and `persistent` is false.
import { getRaffleSnap, postRaffleSale } from './api.js';
import { allocate, strip } from './raffleLogic.js';
import { authToken } from './concessionsStore.js';

export { authToken };

const PREFIX = 'rf:';
const KEEP_SYNCED_MS = 36 * 3600e3;      // synced entries stay readable on the phone this long
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
    snap: read('snap', null),
    log: read('log', {}),
    outbox: read('outbox', []),
    online: null,          // null = unknown yet, true/false = whether the last request reached the server
    syncing: false,
    authProblem: false,
    lastError: ''
};
// Drop old synced entries (unsynced ones are never dropped).
Object.keys(state.log).forEach((id) => { const e = state.log[id]; if (e.status === 'synced' && Date.now() - (e.syncedAt || e.t) > KEEP_SYNCED_MS) delete state.log[id]; });

const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const notify = () => listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });

export const isPersistent = () => persistent;
export const getState = () => state;
export const entry = (clientId) => state.log[clientId] || null;
export const hasSnapshot = () => !!state.snap;

const entries = () => Object.values(state.log).sort((a, b) => a.seq - b.seq);
export const pendingCount = () => state.outbox.length;
/** Rejected sales and ticket-number overlaps that nobody has marked as handled. */
export const attention = () => entries().filter((e) => !e.handled && (e.status === 'failed' || (e.conflicts && e.conflicts.length)));
export const deviceEntries = () => entries();

function persistAll() {
    write('snap', state.snap);
    write('log', state.log);
    write('outbox', state.outbox);
}

/* ---------- what the sell form sees ---------- */

const wallNow = (t) => t - new Date(t).getTimezoneOffset() * 60000;    // sheet times are wall-clock-as-UTC ms
const localLabel = (e) => `Local #${e.seq}`;

/**
 * The server snapshot with this phone's unsynced sales applied on top: rolls advanced past the tickets already torn,
 * and those sales listed first. Synced sales are already in the snapshot, so they are not applied twice.
 */
export function view() {
    const snap = state.snap;
    if (!snap) return null;
    const rolls = snap.rolls.map((r) => ({ ...r }));
    const byId = Object.fromEntries(rolls.map((r) => [r.id, r]));
    const local = [];
    entries().forEach((e) => {
        if (e.status === 'synced') return;      // failed ones count too: the tickets were handed out, so never reuse them
        e.lines.forEach((l) => {
            const r = byId[l.roll];
            if (!r) return;
            r.next = Math.max(r.next, l.end + 1);
            r.sold += l.qty;
            r.remaining = Math.max(0, r.remaining - l.qty);
            if (r.status === 'Active' && r.next > r.end) r.status = 'Full';
        });
        local.push({
            receipt: e.receipt || localLabel(e), t: wallNow(e.t), seller: e.seller, name: e.name, phone: e.phone, email: e.email,
            pay: e.pay, price: e.price, qty: e.qty, void: false, notes: e.notes,
            lines: e.lines.map((l) => [l.roll, l.color, l.start, l.end, l.qty]), local: true, status: e.status, conflicts: e.conflicts || []
        });
    });
    const active = rolls.filter((r) => r.status === 'Active' && r.remaining > 0);
    return { ...snap, rolls, sales: local.reverse().concat(snap.sales), defaultRoll: (active.find((r) => r.id === snap.defaultRoll) || active[0] || {}).id || '' };
}

export const snapshotAt = () => (state.snap && state.snap._at) || 0;

/* ---------- loading from the server ---------- */

function markNetwork(reached, err) {
    state.online = reached;
    if (reached) { state.authProblem = false; state.lastError = ''; }
    if (err) {
        if (err.status === 401 || err.status === 403) state.authProblem = true;
        state.lastError = err.status === 0 ? '' : (err.message || '');
    }
}

/**
 * Refreshes the snapshot. Unsynced sales go first (the new snapshot must not be applied under them), and a failed
 * load quietly keeps the saved copy. Returns { ok, error }; error only matters when there is no saved copy at all.
 */
export async function load(refresh) {
    const token = authToken();
    if (!token) return { ok: false, error: 'Sign in to load the raffle.' };
    await sync();
    if (state.outbox.length) return { ok: false, error: '' };
    try {
        const d = await getRaffleSnap(token, !!refresh);
        state.snap = { ...d, _at: Date.now() - (Number(d.ageMs) || 0) };
        markNetwork(true);
        persistAll();
        notify();
        return { ok: true };
    } catch (e) {
        markNetwork(e.status !== 0, e);
        notify();
        return { ok: false, error: e.status === 0 ? 'No connection.' : e.message };
    }
}

/* ---------- selling (local first) ---------- */

/**
 * Records a sale on this phone and queues it for the server. Never needs the network.
 * in: { seller, rollId, qty, price, pre: {start, color} | null, name, phone, email, pay, notes }
 * Returns { error } or { entry, result } where result feeds the "tear these tickets" screen.
 */
export function recordSale(input) {
    const v = view();
    if (!v) return { error: 'The raffle has not loaded yet.' };
    const issued = [];
    v.sales.forEach((s) => s.lines.forEach((l) => issued.push({ roll: l[0], start: l[2], end: l[3], receipt: s.receipt })));
    const alloc = input.pre ? strip(Number(input.pre.start), input.qty, input.pre.color || '', v.rolls, issued) : allocate(input.qty, input.rollId, v.rolls);
    if (alloc.error) return { error: alloc.error };

    const seq = (read('seq', 0) || 0) + 1;
    write('seq', seq);
    const e = {
        clientId: (crypto.randomUUID && crypto.randomUUID()) || Date.now().toString(16) + Math.random().toString(16).slice(2),
        seq, t: Date.now(), seller: input.seller, qty: input.qty, price: input.price, pay: input.pay,
        name: input.name, phone: input.phone, email: input.email, notes: input.notes,
        lines: alloc.lines, rollId: alloc.lines[0].roll,
        status: 'pending', receipt: '', conflicts: [], error: '', handled: false
    };
    state.log[e.clientId] = e;
    state.outbox.push(e.clientId);
    persistAll();

    const after = view();
    const cur = after.rolls.find((r) => r.id === alloc.lines[alloc.lines.length - 1].roll);
    let next = input.pre ? input.rollId : (cur ? cur.id : '');
    if (!input.pre && (!cur || cur.status !== 'Active' || cur.remaining <= 0)) {
        const alt = after.rolls.find((r) => r.status === 'Active' && r.remaining > 0 && cur && r.color === cur.color) || after.rolls.find((r) => r.status === 'Active' && r.remaining > 0);
        next = alt ? alt.id : '';
    }
    notify();
    sync();
    return {
        entry: e,
        result: {
            clientId: e.clientId, qty: e.qty, price: e.price, pay: e.pay, lines: alloc.lines, split: alloc.lines.length > 1,
            noRollLeft: !input.pre && !next, suggestedRoll: next
        }
    };
}

/** Marks a rejected or overlapping sale as dealt with (it stays in the log and the exports). */
export function markHandled(clientId) {
    const e = state.log[clientId];
    if (!e) return;
    e.handled = true;
    persistAll();
    notify();
}

/** Puts a rejected sale back in the outbox (e.g. after fixing the Rolls tab in the sheet). */
export function retry(clientId) {
    const e = state.log[clientId];
    if (!e || e.status !== 'failed') return;
    e.status = 'pending'; e.error = ''; e.handled = false;
    if (!state.outbox.includes(clientId)) state.outbox.push(clientId);
    persistAll();
    notify();
    sync();
}

/* ---------- the outbox ---------- */

const payloadOf = (e) => ({
    clientId: e.clientId, seller: e.seller, rollId: e.rollId, customQty: e.qty, customPrice: e.price,
    name: e.name, phone: e.phone, email: e.email, pay: e.pay, notes: e.notes,
    lines: e.lines.map((l) => ({ roll: l.roll, start: l.start, end: l.end })), soldAt: e.t
});

export async function sync() {
    if (state.syncing || !state.outbox.length) return;
    const token = authToken();
    if (!token) return;
    state.syncing = true; notify();
    try {
        while (state.outbox.length) {
            const e = state.log[state.outbox[0]];
            if (!e) { state.outbox.shift(); continue; }
            try {
                const r = await postRaffleSale(token, payloadOf(e));
                e.status = 'synced'; e.receipt = r.receipt; e.conflicts = r.conflicts || []; e.error = ''; e.syncedAt = Date.now();
                e.backup = r.backup || '';
                if (state.snap) {
                    state.snap.rolls = r.rolls;
                    if (r.sale && !state.snap.sales.some((s) => s.receipt === r.sale.receipt)) state.snap.sales.unshift(r.sale);
                    state.snap._at = Date.now();
                }
                state.outbox.shift();
                markNetwork(true);
                persistAll();
                notify();
            } catch (err) {
                if (err.status === 400) {
                    // The server will never accept this one as sent: keep it where the seller can see it and carry on.
                    e.status = 'failed'; e.error = err.message;
                    state.outbox.shift();
                    markNetwork(true);
                    persistAll();
                    notify();
                    continue;
                }
                markNetwork(err.status !== 0 && err.status !== 401 && err.status !== 403, err);    // offline, server down or sign-in problem: stop, retry later
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
    sync();
}

/* ---------- getting the record off the phone ---------- */

const pad = (n) => String(n).padStart(2, '0');
const stamp = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const ref = (e) => e.receipt || localLabel(e);

/** One row per ticket range, in the order of the Sales tab's columns A:P (bundle qty and price on the first row only). */
function saleRows(e) {
    return e.lines.map((l, i) => [ref(e), stamp(e.t), e.seller, e.name, e.phone, e.email, i === 0 ? e.qty : '', i === 0 ? e.price : '',
        e.pay, l.roll, l.color, l.start, l.end, l.qty, 'FALSE', e.notes]);
}

/** Tab-separated rows ready to paste into the Sales tab. Defaults to just the sales the server has not confirmed. */
export function exportTsv(onlyUnsynced = true) {
    const list = entries().filter((e) => !onlyUnsynced || e.status !== 'synced');
    return list.flatMap(saleRows).map((r) => r.map((c) => String(c ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');
}

const csvCell = (c) => { const s = String(c ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/** Every sale made on this phone (any status) as CSV, with status and any error. */
export function exportCsv() {
    const head = ['Receipt', 'Time', 'Seller', 'Name', 'Phone', 'Email', 'Bundle', 'Price', 'Payment', 'Roll', 'Color', 'Start', 'End', 'Tickets', 'Void', 'Notes', 'Status', 'Note'];
    const rows = entries().flatMap((e) => saleRows(e).map((r) => r.concat([e.status, e.error || (e.conflicts && e.conflicts.length ? 'Overlaps ' + e.conflicts.map((c) => `${c.roll} ${c.start}-${c.end} ${c.receipt}`).join('; ') : '')])));
    return [head].concat(rows).map((r) => r.map(csvCell).join(',')).join('\r\n');
}

/** Plain readable text, for sending in a message when nothing else works. */
export function exportText(onlyUnsynced = true) {
    return entries().filter((e) => !onlyUnsynced || e.status !== 'synced').map((e) =>
        `${ref(e)} ${stamp(e.t)} ${e.seller}: ${e.qty} tix $${e.price} ${e.pay} | ${e.lines.map((l) => `${l.roll} ${l.start}-${l.end}`).join(', ')} | ${[e.name, e.phone, e.email].filter(Boolean).join(' / ')}${e.notes ? ' | ' + e.notes : ''} [${e.status}]`).join('\n');
}
