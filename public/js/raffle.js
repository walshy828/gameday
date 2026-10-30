// public/js/raffle.js
// Raffle view (raffle managers + superadmin): sell tickets from a phone, browse/search past sales, and a
// small report. Everything goes through /api/raffle*, which reads and writes the Raffle Manager spreadsheet, but
// selling is local-first (raffleStore.js): a sale is saved on this phone and picks its own ticket numbers, then
// syncs when there is a connection, so a dropped signal never slows or loses a sale. The Device tab shows what is waiting.
// One server snapshot (config + rolls + all sales) feeds all three tabs, so searching, filtering and the
// report are computed here and cost no sheet calls; only a sale (and the occasional refresh) touches Sheets.
import * as Store from './raffleStore.js';
import { priceSale, allocate, strip } from './raffleLogic.js';
import { toast } from './concessionsUi.js';

const REFRESH_MS = 60000;      // quiet refresh while the tab is open (the server serves its own cached copy)
const PAGE = 40;

const S = {
    data: null, loadedAt: 0, loading: false, error: '',
    tab: 'sell',
    cart: {}, f: blankForm(), busy: false, err: '', result: null,
    custom: false, pre: false, rollOpen: false, buyerOpen: false, touched: { phone: false, email: false },
    q: '', mine: false, open: null, shown: PAGE,
    metric: 'usd', gran: 'hour'
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const seller = () => (typeof App !== 'undefined' && App.state && App.state.reporterName) || sessionStorage.getItem('reporterName') || '';
const body = () => document.getElementById('raffle-body');
const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });

const touchedBlank = () => ({ phone: false, email: false });
function blankForm() {
    return { roll: '', cq: '', cp: '', preStart: '', preColor: '', name: '', phone: '', email: '', pay: '', notes: '' };
}

/* ---------- what stays on this phone between sales (roll, payment, last buyer) ---------- */

const LS = 'raffleLast';
function loadLast() { try { return JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch (e) { return {}; } }
function saveLast(patch) { try { localStorage.setItem(LS, JSON.stringify({ ...loadLast(), ...patch })); } catch (e) { /* storage unavailable */ } }

/* ---------- formatting ---------- */

// Sale times arrive as the sheet's own wall-clock time stored as ms, so read them with UTC getters.
const fmtTime = (t) => new Date(t).toLocaleString('en-US', { timeZone: 'UTC', weekday: 'short', hour: 'numeric', minute: '2-digit' });
const hourLabel = (t, withDay) => new Date(t).toLocaleString('en-US', { timeZone: 'UTC', ...(withDay ? { weekday: 'short' } : {}), hour: 'numeric', ...(S.gran === 'half' ? { minute: '2-digit' } : {}) });
const digits = (s) => String(s || '').replace(/\D/g, '');
const range = (l) => (l[2] === l[3] ? String(l[2]) : `${l[2]}–${l[3]}`);

/* ---------- shared UI snippets ---------- */

const pillBtn = 'flex-none rounded-full border border-white/20 bg-white/[.06] px-3.5 py-2.5 text-[11px] font-semibold leading-none text-white/75';
const goldStyle = 'background:linear-gradient(135deg,var(--gold) 0%,var(--gold-d) 100%);color:#2A1B08';
const kicker = (t) => `<div class="text-[10px] tracking-[.16em] font-semibold text-white/50 uppercase">${esc(t)}</div>`;
const card = 'rounded-2xl border border-white/10 bg-white/[.05]';
const COLORS = { blue: '#3b82f6', yellow: '#facc15', red: '#ef4444', green: '#22c55e', pink: '#ec4899', orange: '#f97316', white: '#f4f4f5', purple: '#a855f7' };
const dot = (color) => `<span class="inline-block h-2.5 w-2.5 flex-none rounded-full border border-white/30" style="background:${COLORS[String(color).toLowerCase()] || '#9ca3af'}"></span>`;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/;
const DOMAINS = ['gmail.com', 'yahoo.com', 'icloud.com', 'outlook.com', 'hotmail.com', 'aol.com'];
/** US phone as (555) 123-4567; a leading 1 is dropped, extra digits ignored. */
function fmtPhone(v) {
    let d = digits(v);
    if (d.length > 10 && d[0] === '1') d = d.slice(1);
    d = d.slice(0, 10);
    if (d.length < 4) return d.length ? `(${d}` : '';
    if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}
const phoneErr = (v) => (v && digits(v).length !== 10 ? 'Enter all 10 digits (area code + number)' : '');
const emailErr = (v) => (v && !EMAIL_RE.test(v.trim()) ? 'Email should look like name@example.com' : '');
const selRoll = () => (S.data && S.data.rolls.find(r => r.id === S.f.roll)) || null;
/** The pre-torn strip's color is the selected roll's color (only sent if the sheet lists it). */
const preColorOf = () => { const r = selRoll(); return r && S.data.colors.includes(r.color) ? r.color : ''; };

/** Checks a pre-torn first ticket against the roll ranges and already-sold tickets. null = nothing entered. */
function preCheck(priced) {
    const f = S.f;
    if (!S.pre || f.preStart === '') return null;
    const start = Number(f.preStart);
    if (!(start > 0)) return { error: 'Enter the first ticket number.' };
    const issued = [];
    S.data.sales.forEach(x => x.lines.forEach(l => issued.push({ roll: l[0], start: l[2], end: l[3], receipt: x.receipt })));
    const r = strip(start, priced && !priced.error ? priced.qty : 1, preColorOf(), S.data.rolls, issued);
    return r.error ? { error: r.error } : { ok: true, line: r.lines[0] };
}

function chip(label, on, attrs, extra) {
    return `<button type="button" ${attrs} class="flex-none rounded-full border px-4 py-3 text-[13px] font-semibold leading-none ${on ? 'border-transparent' : 'border-white/15 bg-white/[.06] text-white/80'} ${extra || ''}" style="${on ? goldStyle : ''}">${label}</button>`;
}

/* ---------- loading ---------- */

/** Selects the remembered roll (or the sheet's default) and the last payment method if the form has none yet. */
function pickDefaults() {
    const d = S.data, last = loadLast(), f = S.f;
    if (!d) return;
    const active = d.rolls.filter(r => r.status === 'Active' && r.remaining > 0);
    if (!active.some(r => r.id === f.roll)) f.roll = active.some(r => r.id === last.roll) ? last.roll : d.defaultRoll;
    if (!f.pay && d.payments.includes(last.pay)) f.pay = last.pay;
}

async function load(quiet, refresh) {
    if (S.loading) return null;
    S.loading = true; S.error = '';
    if (!quiet) render();
    let r = null;
    try {
        r = await Store.load(!!refresh);
        const d = Store.view();
        if (!d) throw new Error(r.error || 'Could not load the raffle.');
        S.data = d; S.loadedAt = Store.snapshotAt();
        pickDefaults();
    } catch (e) {
        S.error = e.message || String(e);
    } finally {
        S.loading = false;
        if (!S.busy) render();
    }
    return r;
}

/** Refresh button: shows "Refreshing…" right away and says how it went. */
async function refreshNow() {
    if (S.loading) return;
    const r = await load(false, true);
    if (!r) return;
    if (r.ok) toast('Up to date');
    else if (Store.pendingCount()) toast(`${Store.pendingCount()} sale(s) still waiting to upload`, true);
    else toast(S.error ? S.error : 'Could not reach the server. Showing the saved copy.', true);
}

/** Sync now: confirm the tap, then report what happened. */
async function syncNow() {
    if (Store.getState().syncing) return;
    const before = Store.pendingCount();
    if (!before) { toast('Nothing waiting. Everything is uploaded'); return; }
    toast('Uploading…');
    await Store.sync();
    const left = Store.pendingCount();
    toast(left ? `${left} still waiting${Store.getState().online === false ? ' (offline)' : ''}` : `Uploaded ${before} sale${before === 1 ? '' : 's'}`, !!left);
}

function stamp(short) {
    if (!S.loadedAt) return '';
    const mins = Math.max(0, Math.floor((Date.now() - S.loadedAt) / 60000));
    return `${short ? '' : 'Sales as of '}${new Date(S.loadedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${mins < 1 ? 'just now' : mins + ' min ago'}`;
}

/** Connection / sync state as one colored dot at the end of the tab bar (a count when sales are waiting); tap it for the words. */
function statusInfo() {
    const st = Store.getState(), n = Store.pendingCount();
    if (st.authProblem) return { label: n ? `Sign in again to upload ${n}` : 'Sign in again to upload', color: 'var(--mar)' };
    if (st.online === false) return { label: n ? `Offline · ${n} saved on this phone` : 'Offline · sales are saved on this phone', color: '#b45309' };
    if (st.syncing || n) return { label: n ? `Uploading ${n}…` : 'Uploading…', color: '#b45309' };
    if (st.online === true) return { label: 'Online · everything saved', color: '#15803d' };
    return { label: 'Checking connection…', color: '#52525b' };
}
function statusHtml() {
    const { label, color } = statusInfo(), n = Store.pendingCount(), bad = Store.attention().length;
    return `<button type="button" data-act="status" class="flex h-full min-w-[40px] items-center justify-center rounded-[13px] px-2 text-[12px] font-bold tabular-nums text-white" style="background:${color}" aria-label="${esc(label)}" title="${esc(label)}">${n ? n : '<span class="h-2 w-2 rounded-full bg-white/90"></span>'}</button>
      ${bad ? `<button data-act="tab" data-v="device" class="ml-1 rounded-[13px] px-2.5 text-[11px] font-bold text-white" style="background:var(--mar)">${bad} to check</button>` : ''}`;
}
function updateStatus() { const el = document.getElementById('raffle-status'); if (el) el.innerHTML = statusHtml(); }

let unsub = null;
/** The store changed (sync progress, a sale confirmed): refresh the numbers without disturbing a form being typed into. */
function onStore() {
    const v = document.getElementById('raffle-view');
    if (!S.data || !v || v.classList.contains('hidden')) return;
    S.data = Store.view() || S.data;
    updateStatus();
    if (S.busy) return;
    if (S.tab !== 'sell' || S.result) render();
}

let timer = null;
function startTimer() {
    if (timer) return;
    timer = setInterval(() => {
        const v = document.getElementById('raffle-view');
        if (!v || v.classList.contains('hidden') || document.hidden || S.busy) return;
        load(true, false);
    }, REFRESH_MS);
}

export function renderRaffle() {
    wire();
    startTimer();
    Store.startSync();
    if (!unsub) unsub = Store.onChange(onStore);
    if (!S.data && Store.hasSnapshot()) { S.data = Store.view(); S.loadedAt = Store.snapshotAt(); pickDefaults(); }    // open instantly from the saved copy, then refresh
    if (!S.data && !S.loading) { load(); return; }
    if (S.data && Date.now() - S.loadedAt > REFRESH_MS / 2 && !S.loading) load(true, false);   // coming back to the tab: catch up quietly
    render();
}

/** Called on logout / role change so a different login never sees this person's data or draft. */
export function resetRaffle() {
    Object.assign(S, { data: null, loadedAt: 0, loading: false, error: '', tab: 'sell', cart: {}, f: blankForm(), busy: false, err: '', result: null, custom: false, pre: false, rollOpen: false, buyerOpen: false, touched: touchedBlank(), q: '', mine: false, open: null, shown: PAGE });
    const el = body(); if (el) el.innerHTML = '';
}

/* ---------- the sale being built ---------- */

/** The tapped bundles (S.cart = { bundleQty: count }) as one sale: total tickets and the sum of the bundle prices. */
function cartParts(bundles) { return bundles.filter(b => S.cart[b.qty] > 0).map(b => ({ ...b, count: S.cart[b.qty] })); }
function cartPrice(bundles) {
    const parts = cartParts(bundles);
    if (!parts.length) return { error: 'Pick a bundle.' };
    const qty = parts.reduce((a, b) => a + b.qty * b.count, 0);
    const price = parts.reduce((a, b) => a + Math.round(b.price * 100) * b.count, 0) / 100;
    return qty > 5000 ? { error: 'That is more than 5000 tickets.' } : { qty, price };
}

function plan() {
    const d = S.data, f = S.f, need = [];
    const priced = S.custom ? priceSale({ customQty: f.cq, customPrice: f.cp }, d.bundles) : cartPrice(d.bundles);
    if (priced.error) need.push(S.custom && f.cq === '' ? 'Enter a quantity' : 'Pick a bundle');
    const manual = S.pre && f.preStart !== '';
    const pc = preCheck(priced);
    if (pc && pc.error) need.push('Fix the ticket number');
    if (!manual && !f.roll) need.push('Pick a roll');
    if (d.require.name && !f.name.trim()) need.push('Buyer name');
    if (d.require.contact && !f.phone.trim() && !f.email.trim()) need.push('Phone or email');
    if (phoneErr(f.phone)) need.push('Fix the phone number');
    if (emailErr(f.email)) need.push('Fix the email');
    if (d.require.pay && !f.pay && !payBtns()) need.push('Payment');
    let lines = null, note = '';
    if (!priced.error) {
        if (manual) {
            const s = Number(f.preStart);
            note = s > 0 && !(pc && pc.error) ? `Pre-torn: tickets ${s}–${s + priced.qty - 1}` : '';
        } else if (f.roll) {
            const a = allocate(priced.qty, f.roll, d.rolls);
            if (a.error) note = a.error; else lines = a.lines;
            if (lines) note = lines.map(l => `${l.roll}: ${l.start}–${l.end}`).join('  +  ');
        }
    }
    return { priced, need, note, ready: !priced.error && need.length === 0 && !(note && !lines && !manual) };
}

function dirty() { S.err = ''; }

/* ---------- SELL ---------- */

/** Up to 3 payment methods become the commit buttons themselves (one tap = payment + sell); more falls back to chips + Sell. */
const payBtns = () => !!S.data && S.data.payments.length > 0 && S.data.payments.length <= 3;
const PAY_ICON = (m) => (/cash/i.test(m) ? '💵 ' : /venmo|zelle|paypal/i.test(m) ? '📱 ' : /card|credit|debit/i.test(m) ? '💳 ' : '');
const stickyStyle = 'bottom:calc(96px + env(safe-area-inset-bottom,0px));background:rgba(14,14,16,.82);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)';

function renderSell() {
    const d = S.data, f = S.f, p = plan();
    const active = d.rolls.filter(r => r.status === 'Active' || (S.pre && r.status === 'Pre-torn'));
    const sr = selRoll(), hex = sr && (COLORS[String(sr.color).toLowerCase()] || '#9ca3af');

    // Roll: one compact line (it is remembered between sales); the chips and pre-torn options open under "Change".
    const chips = `<div class="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">${active.map(r =>
        chip(`<span class="inline-flex items-center gap-2">${dot(r.color)}${esc(r.id)}<span class="font-medium opacity-70">${r.remaining} left</span></span>`, f.roll === r.id, `data-act="roll" data-v="${esc(r.id)}"`, r.remaining <= 0 ? 'opacity-40' : '')).join('')}</div>`;
    let rollBlock;
    if (!active.length) {
        rollBlock = `<div class="${card} px-3.5 py-3 text-[13px] text-white/60">No Active rolls. Mark a roll Active on the Rolls tab of the sheet${S.pre ? '' : ', or use a pre-torn strip'}.</div>`;
    } else if (!sr) {
        rollBlock = chips;
    } else {
        const low = sr.remaining > 0 && sr.remaining <= 10;
        rollBlock = `<div class="flex items-center gap-3 rounded-2xl border border-white/10 py-2.5 pl-3.5 pr-2.5" style="border-left:6px solid ${hex};background:linear-gradient(90deg,${hex}30 0%,rgba(255,255,255,.04) 70%)">
          <div class="min-w-0 flex-1">
            <div class="text-[22px] font-bold leading-none tabular-nums text-white">${sr.remaining > 0 ? `Next #${sr.next}` : 'Roll is out'}</div>
            <div class="mt-1.5 flex items-center gap-2 truncate text-[12px] font-semibold text-white/70">${dot(sr.color)}<span class="truncate">${esc(sr.color || 'Roll')} · ${esc(sr.id)} · <span style="${low ? 'color:var(--gold-l)' : ''}">${low ? '⚠ only ' : ''}${sr.remaining} left</span></span></div></div>
          <button type="button" data-act="rolls" class="flex-none rounded-full border border-white/20 bg-white/[.08] px-4 py-3 text-[13px] font-semibold leading-none text-white" aria-expanded="${S.rollOpen}">${S.rollOpen ? 'Done' : 'Change'}</button></div>
        ${S.rollOpen ? `<div class="mt-2">${chips}
          <div class="mt-1 flex flex-wrap gap-2">
            <button type="button" data-act="editnext" class="${pillBtn} !text-[12px]">✎ Edit next ticket #</button>
            <button type="button" data-act="pre" class="${pillBtn} !text-[12px]">${S.pre ? 'Cancel pre-torn strip' : 'Selling a pre-torn strip?'}</button></div></div>` : ''}`;
    }

    const pre = S.pre ? `<div class="${card} p-3"><div class="mb-2 flex items-baseline justify-between">${kicker('Pre-torn strip')}<button data-act="pre" class="px-1 py-1 text-[12px] font-semibold text-white/50">Cancel</button></div>
        <input data-f="preStart" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="First ticket #" value="${esc(f.preStart)}" class="field-dark text-[20px] font-bold tabular-nums" aria-label="First ticket number">
        <div id="raffle-prehint" class="mt-2 text-[13px] font-semibold">${preHint(p)}</div></div>`
        : '';

    // Bundles: 3 columns; a selected tile shows ×count top-left and a − top-right (no layout shift, separate targets).
    const bundles = `<div class="grid grid-cols-3 gap-2">${d.bundles.map(b => {
        const q = S.custom ? 0 : (S.cart[b.qty] || 0);
        return `<div class="relative rounded-2xl border ${q ? 'border-transparent' : 'border-white/15 bg-white/[.06] text-white'}" style="${q ? 'box-shadow:0 0 0 2px var(--gold);background:rgba(224,184,99,.14)' : ''}">
          <button type="button" data-act="badd" data-v="${b.qty}" class="block w-full px-2 py-3.5 text-center" aria-label="Add ${b.qty} ${b.qty === 1 ? 'ticket' : 'tickets'} for ${money(b.price)}">
            <span class="block text-[24px] font-bold leading-none tabular-nums">${b.qty}<span class="ml-1 text-[11px] font-semibold opacity-60">${b.qty === 1 ? 'ticket' : 'tix'}</span></span>
            <span class="mt-1.5 block text-[14px] font-semibold ${q ? '' : 'text-white/60'}" style="${q ? 'color:var(--gold-l)' : ''}">${money(q > 1 ? Math.round(b.price * 100) * q / 100 : b.price)}</span></button>
          ${q > 1 ? `<span class="pointer-events-none absolute left-2.5 top-2 text-[13px] font-bold tabular-nums" style="color:var(--gold-l)">×${q}</span>` : ''}
          ${q ? `<button type="button" data-act="bdec" data-v="${b.qty}" class="absolute right-0 top-0 flex h-11 w-11 items-center justify-center text-[24px] font-bold leading-none text-white" aria-label="Remove one ${b.qty}-ticket bundle">−</button>` : ''}</div>`;
    }).join('')}
      <button type="button" data-act="custom" class="rounded-2xl border px-2 py-3.5 text-center ${S.custom ? 'border-transparent' : 'border-white/15 bg-white/[.06] text-white'}" style="${S.custom ? goldStyle : ''}">
        <span class="block text-[24px] font-bold leading-none">…</span><span class="mt-1.5 block text-[14px] font-semibold ${S.custom ? '' : 'text-white/60'}">Custom</span></button></div>
      ${S.custom ? `<div class="mt-2 grid grid-cols-2 gap-2">
        <input data-f="cq" type="number" inputmode="numeric" min="1" placeholder="Tickets" value="${esc(f.cq)}" class="field-dark" aria-label="Custom quantity">
        <input data-f="cp" type="number" inputmode="decimal" min="0" step="0.01" placeholder="Price (optional)" value="${esc(f.cp)}" class="field-dark" aria-label="Custom price"></div>` : ''}`;

    // Payment chips only when there are too many methods to be the commit buttons.
    const pays = payBtns() ? '' : `<div data-sec="pay" style="scroll-margin-top:72px">${kicker('Payment')}<div class="-mx-1 mt-2 flex flex-wrap gap-2 px-1">${d.payments.map(m => chip(esc(m), f.pay === m, `data-act="pay" data-v="${esc(m)}"`)).join('')}</div></div>`;

    // Buyer: only the fields the sheet requires; everything else (and the note) sits behind one link.
    const showName = d.require.name || S.buyerOpen, showContact = d.require.contact || S.buyerOpen;
    const contact = showContact ? `<input data-f="phone" type="tel" inputmode="numeric" pattern="[0-9]*" enterkeyhint="next" autocomplete="off" placeholder="Phone (555) 123-4567" value="${esc(f.phone)}" class="field-dark" aria-label="Phone">
        <div id="raffle-phonehint" class="empty:hidden -mt-1 px-1 text-[12px] font-semibold" style="color:var(--warn)">${hint('phone')}</div>
        <input data-f="email" type="email" inputmode="email" enterkeyhint="done" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Email" value="${esc(f.email)}" class="field-dark" aria-label="Email">
        <div id="raffle-emailquick" class="empty:hidden -mx-1 flex gap-1.5 overflow-x-auto px-1">${emailQuick()}</div>
        <div id="raffle-emailhint" class="empty:hidden -mt-1 px-1 text-[12px] font-semibold" style="color:var(--warn)">${hint('email')}</div>` : '';
    const name = showName ? `<input data-f="name" type="text" autocomplete="off" autocapitalize="words" enterkeyhint="next" placeholder="Buyer name${d.require.name ? '' : ' (optional)'}" value="${esc(f.name)}" class="field-dark" aria-label="Buyer name">
        <div id="raffle-namequick" class="empty:hidden -mx-1 flex gap-1.5 overflow-x-auto px-1">${nameQuick()}</div>` : '';
    const more = S.buyerOpen
        ? `<input data-f="notes" type="text" placeholder="Note (optional)" value="${esc(f.notes)}" class="field-dark" aria-label="Notes">`
        : `<button type="button" data-act="details" class="py-1 text-left text-[12px] font-semibold text-white/50 underline underline-offset-2">${d.require.name && d.require.contact ? '+ Add a note' : '+ Buyer details or note'}</button>`;

    return `<div class="mt-2.5 grid gap-3">
      <div>${rollBlock}</div>
      ${pre}
      ${bundles}
      ${pays}
      <div data-sec="buyer" class="grid gap-2" style="scroll-margin-top:72px">${name}${contact}${more}</div>
      <div id="raffle-sellbar" class="sticky z-40 -mx-1 rounded-3xl p-1.5" style="${stickyStyle}">${sellBar(p)}</div>
    </div>`;
}

function preHint(p) {
    const pc = preCheck(p.priced);
    if (!pc) {
        const r = selRoll();
        return r ? `<span class="text-white/60">Enter a ticket between ${r.start} and ${r.end}${p.priced.error ? '' : ` (${p.priced.qty} tickets)`}.</span>` : '<span class="text-white/60">Pick a roll first.</span>';
    }
    return pc.error ? `<span style="color:var(--warn)">⚠ ${esc(pc.error)}</span>`
        : `<span style="color:var(--ok)">✔ ${pc.line.roll}: tickets ${pc.line.start}–${pc.line.end}</span>`;
}
/** Phone/email problems show once the field has been left (not while still typing); the Sell buttons block either way. */
function hint(k) { return S.touched[k] ? esc(k === 'phone' ? phoneErr(S.f.phone) : emailErr(S.f.email)) : ''; }
/** Tap-to-finish email domains, shown while the address has no complete domain yet. */
function emailQuick() {
    const e = S.f.email.trim();
    if (!e || EMAIL_RE.test(e)) return '';
    const [local, part = ''] = e.split('@');
    if (!local || e.split('@').length > 2) return '';
    const opts = DOMAINS.filter(dm => dm.startsWith(part.toLowerCase()));
    return opts.map(dm => `<button type="button" data-act="domain" data-v="${dm}" data-keepfocus class="${pillBtn} !text-[13px]" style="border-color:var(--gold);color:var(--gold-l);background:rgba(224,184,99,.12)">@${dm}</button>`).join('');
}
/** Past buyers matching the typed name: one tap fills the name and the contact. */
let nameSug = [];
function nameQuick() {
    nameSug = [];
    const q = S.f.name.trim().toLowerCase();
    if (q.length < 2 || S.f.phone || S.f.email || !S.data) return '';
    const seen = new Set();
    for (const s of S.data.sales) {
        if (s.void || !s.name || !s.name.toLowerCase().startsWith(q)) continue;
        const key = `${s.name.toLowerCase()}|${digits(s.phone)}|${String(s.email || '').toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        nameSug.push({ name: s.name, phone: s.phone || '', email: s.email || '' });
        if (nameSug.length >= 3) break;
    }
    return nameSug.map((s, i) => `<button type="button" data-act="buyer" data-v="${i}" data-keepfocus class="${pillBtn} !text-[13px]">${esc(s.name)}${s.phone ? ` · ${esc(digits(s.phone).slice(-4))}` : ''}</button>`).join('');
}
function updateHints() {
    const set = (id, h) => { const el = document.getElementById(id); if (el) el.innerHTML = h; };
    set('raffle-prehint', preHint(plan())); set('raffle-phonehint', hint('phone')); set('raffle-emailhint', hint('email')); set('raffle-emailquick', emailQuick()); set('raffle-namequick', nameQuick());
}

/** The sticky commit area: one info line, one "what's missing" line, then the Cash/Venmo buttons (or a single Sell button). Updated in place while typing. */
function sellBar(p) {
    const d = S.data, ready = p.ready && !S.busy;
    const parts = S.custom ? [] : cartParts(d.bundles);
    const tix = p.priced.error ? '' : `${parts.length > 1 ? parts.map(b => `${b.count}×${b.qty}`).join(' + ') + ' = ' : ''}${p.priced.qty} ${p.priced.qty === 1 ? 'ticket' : 'tickets'}`;
    const info = [tix, p.note].filter(Boolean).join(' · ');
    const blocked = !p.ready && !p.need.length && !p.priced.error;
    const amount = p.priced.error ? '' : money(p.priced.price);
    const buttons = payBtns()
        ? `<div class="grid gap-2" style="grid-template-columns:repeat(${d.payments.length},minmax(0,1fr))">${d.payments.map(m => `<button data-act="sell" data-v="${esc(m)}" ${ready ? '' : 'disabled'} class="rounded-[20px] px-2 py-3 text-center leading-none ${ready ? '' : 'opacity-50'}" style="${goldStyle}"><span class="block text-[16px] font-bold">${PAY_ICON(m)}${esc(m)}</span>${amount ? `<span class="mt-1.5 block text-[14px] font-semibold opacity-75">${amount}</span>` : ''}</button>`).join('')}</div>`
        : `<button data-act="sell" ${ready ? '' : 'disabled'} class="w-full rounded-[20px] px-4 py-4 text-[16px] font-bold leading-none ${ready ? '' : 'opacity-50'}" style="${goldStyle}">${S.busy ? 'Saving…' : p.ready ? `Sell ${p.priced.qty} ${p.priced.qty === 1 ? 'ticket' : 'tickets'} · ${amount}` : 'Sell'}</button>`;
    return `${S.err ? `<div class="mb-1.5 rounded-2xl px-3 py-2 text-[12px] font-semibold text-white" style="background:var(--mar)">${esc(S.err)}</div>` : ''}
      ${info ? `<div class="mb-1.5 px-2 text-center text-[12px] font-semibold" style="color:${blocked ? 'var(--warn)' : 'var(--gold-l)'}">${esc(info)}</div>` : ''}
      ${!p.ready && p.need[0] ? `<div class="mb-1.5 px-2 text-center text-[12px] font-semibold text-white/55">${esc(p.need[0])}</div>` : ''}
      ${buttons}`;
}
function updateSellBar() { const el = document.getElementById('raffle-sellbar'); if (el) el.innerHTML = sellBar(plan()); }

const receiptOf = (r) => { const e = Store.entry(r.clientId); return e && e.receipt ? e.receipt : `Local #${e ? e.seq : ''}`; };
/** Only problems are shown: a normal sale is silently uploaded (a small ⏱ by the receipt says it is still on the way). */
function syncNote(r) {
    const e = Store.entry(r.clientId);
    const warn = (t) => `<div class="rounded-2xl px-3.5 py-3 text-[13px] font-semibold" style="background:rgba(224,184,99,.16);color:var(--gold-l)">${t}</div>`;
    if (!e) return '';
    if (e.status === 'failed') return warn(`⚠ This sale could not be uploaded: ${esc(e.error)} The tickets above are still the buyer's; see Details on the Sales tab.`);
    if (e.status !== 'synced') return Store.getState().online === false ? `<div class="rounded-2xl px-3.5 py-3 text-[13px] font-semibold text-white/70" style="background:rgba(255,255,255,.06)">Saved on this phone. It will upload when you are back online.</div>` : '';
    return (e.conflicts && e.conflicts.length ? warn(`⚠ Another sale already used some of these tickets (${e.conflicts.map((c) => esc(`${c.roll} ${c.start}–${c.end}, ${c.receipt}`)).join('; ')}). Tell the tournament manager.`) : '')
        + (e.backup === 'unavailable' ? warn('⚠ Saved to the sheet, but the backup copy was unavailable. Tell the tournament manager.') : '');
}

function renderResult() {
    const r = S.result, e = Store.entry(r.clientId), uploading = e && e.status === 'pending';
    return `<div class="mt-2.5 grid gap-3">
      <div class="${card} flex items-center gap-3 px-4 py-3" style="border-color:rgba(46,158,99,.5);background:rgba(46,158,99,.12)">
        <span class="text-[26px] leading-none" style="color:var(--ok)">✔</span>
        <div class="min-w-0 flex-1"><div class="truncate text-[16px] font-bold text-white">Sold · ${esc(receiptOf(r))}${uploading ? ' <span class="opacity-60" title="Uploading">⏱</span>' : ''}</div>
          <div class="text-[13px] text-white/70">${r.qty} ${r.qty === 1 ? 'ticket' : 'tickets'} · ${money(r.price)} · ${esc(r.pay)}</div></div></div>
      <div>${kicker('Tear these tickets')}<div class="mt-2 grid gap-2">${r.lines.map(l => `<div class="${card} flex items-center justify-between gap-3 px-4 py-4">
        <span class="flex items-center gap-2 text-[13px] font-semibold text-white/70">${dot(l.color)}${esc(l.roll)}</span>
        <span class="text-[36px] font-bold leading-none tabular-nums text-white">${l.start === l.end ? l.start : `${l.start}–${l.end}`}</span></div>`).join('')}</div></div>
      ${r.split ? `<div class="rounded-2xl px-3.5 py-3 text-[13px] font-semibold" style="background:rgba(224,184,99,.16);color:var(--gold-l)">⚠ That roll ran out, so the sale is split. Tear the rest from the next roll.</div>` : ''}
      ${syncNote(r)}
      ${r.noRollLeft ? `<div class="rounded-2xl px-3.5 py-3 text-[13px] font-semibold" style="background:rgba(224,184,99,.16);color:var(--gold-l)">⚠ No Active roll left. Add one on the Rolls tab of the sheet.</div>` : ''}
      <div class="sticky z-40 -mx-1 rounded-3xl p-1.5" style="${stickyStyle}"><button data-act="next" class="w-full rounded-[20px] px-4 py-4 text-[16px] font-bold leading-none" style="${goldStyle}">Next sale</button></div>
    </div>`;
}

function submit(pay) {
    if (S.busy) return;
    if (pay && payBtns()) S.f.pay = pay;
    const p = plan();
    if (!p.ready) return;
    const f = S.f;
    const out = Store.recordSale({
        seller: seller(), rollId: f.roll, qty: p.priced.qty, price: p.priced.price,
        pre: S.pre && f.preStart !== '' ? { start: f.preStart, color: preColorOf() } : null,
        name: f.name, phone: f.phone, email: f.email, pay: f.pay, notes: f.notes
    });
    if (out.error) { S.err = out.error; updateSellBar(); return; }
    const r = out.result;
    S.err = '';
    S.data = Store.view();
    S.result = r;
    saveLast({ roll: r.suggestedRoll || f.roll, pay: f.pay });
    // Fresh form for the next buyer; the roll and payment carry over.
    S.cart = {};
    Object.assign(S.f, { roll: r.suggestedRoll || S.f.roll, cq: '', cp: '', preStart: '', name: '', phone: '', email: '', notes: '' });
    S.custom = false; S.buyerOpen = false; S.rollOpen = false; S.pre = false; S.touched = touchedBlank();
    window.scrollTo({ top: 0 });
    render();
}

/* ---------- SALES ---------- */

function matches(s, q, digitsQ) {
    if (!q) return true;
    if (digitsQ.length >= 3 && digits(s.phone).includes(digitsQ)) return true;
    return `${s.name} ${s.email} ${s.receipt} ${s.phone}`.toLowerCase().includes(q);
}

function filtered() {
    const q = S.q.trim().toLowerCase(), dq = digits(S.q), me = seller().toLowerCase();
    return S.data.sales.filter(s => (!S.mine || s.seller.toLowerCase() === me) && matches(s, q, dq));
}

function saleRow(s) {
    const open = S.open === s.receipt;
    const tel = String(s.phone).replace(/[^\d+]/g, '');
    return `<div class="${card} ${s.void ? 'opacity-50' : ''}">
      <button data-act="open" data-v="${esc(s.receipt)}" class="flex w-full items-center justify-between gap-3 px-3.5 py-3 text-left">
        <span class="min-w-0"><span class="block truncate text-[14px] font-semibold text-white ${s.void ? 'line-through' : ''}">${esc(s.name || s.phone || s.email || '(no name)')}</span>
          <span class="block truncate text-[12px] text-white/50">${esc(s.receipt)} · ${esc(fmtTime(s.t))} · ${esc(s.seller)}${s.local ? (s.status === 'failed' ? ' · <b style="color:#ff9d8e">NOT SAVED</b>' : ' · <b style="color:var(--gold-l)">waiting to upload</b>') : ''}${s.conflicts && s.conflicts.length ? ' · <b style="color:#ff9d8e">check tickets</b>' : ''}</span></span>
        <span class="flex-none text-right"><span class="block text-[15px] font-bold tabular-nums text-white">${money(s.price)}</span><span class="block text-[11px] text-white/50">${s.qty} tix · ${esc(s.pay)}</span></span></button>
      ${open ? `<div class="grid gap-1.5 border-t border-white/10 px-3.5 py-3 text-[13px] text-white/75">
        ${s.void ? '<div class="font-semibold" style="color:var(--warn)">Voided</div>' : ''}
        ${s.phone ? `<div>📞 <a href="tel:${esc(tel)}" class="underline underline-offset-2">${esc(s.phone)}</a></div>` : ''}
        ${s.email ? `<div>✉️ <a href="mailto:${esc(s.email)}" class="break-all underline underline-offset-2">${esc(s.email)}</a></div>` : ''}
        <div class="flex flex-wrap gap-x-4 gap-y-1">${s.lines.map(l => `<span class="inline-flex items-center gap-1.5 tabular-nums">${dot(l[1])}${esc(l[0])}: ${esc(range(l))}</span>`).join('')}</div>
        ${s.notes ? `<div class="text-white/55">“${esc(s.notes)}”</div>` : ''}</div>` : ''}</div>`;
}

function salesList() {
    const list = filtered(), shown = list.slice(0, S.shown);
    if (!list.length) return `<div class="py-10 text-center text-sm text-white/50">${S.q ? `Nothing matches “${esc(S.q)}”.` : 'No sales yet.'}</div>`;
    const live = list.filter(s => !s.void);
    return `<div class="mb-2 px-1 text-[11px] text-white/45">${list.length} ${list.length === 1 ? 'sale' : 'sales'} · ${money(live.reduce((a, s) => a + s.price, 0))} · ${live.reduce((a, s) => a + s.qty, 0)} tickets</div>
      <div class="grid gap-2">${shown.map(saleRow).join('')}</div>
      ${list.length > shown.length ? `<button data-act="more" class="${pillBtn} mx-auto mt-3 block">Show ${Math.min(PAGE, list.length - shown.length)} more</button>` : ''}`;
}
function updateList() { const el = document.getElementById('raffle-list'); if (el) el.innerHTML = salesList(); }

function renderSales() {
    return `<div class="mt-3.5"><input id="raffle-q" type="search" value="${esc(S.q)}" placeholder="Search name, phone, email or receipt…" autocomplete="off" aria-label="Search sales" class="field-dark"></div>
      <div class="mt-2.5 flex gap-2">${chip('All sales', !S.mine, 'data-act="mine" data-v="0"')}${chip('My sales', S.mine, 'data-act="mine" data-v="1"')}</div>
      <div id="raffle-list" class="mt-3">${salesList()}</div>`;
}

/* ---------- REPORT ---------- */

function tally(live, keyFn) {
    const m = new Map();
    live.forEach(s => { const k = keyFn(s); if (k == null) return; const o = m.get(k) || { usd: 0, tix: 0, n: 0 }; o.usd += s.price; o.tix += s.qty; o.n += 1; m.set(k, o); });
    return m;
}

function barRows(rows, metric, labelFn) {
    const val = (o) => (metric === 'usd' ? o.usd : metric === 'tix' ? o.tix : o.n);
    const fmt = (n) => (metric === 'usd' ? money(n) : n.toLocaleString('en-US'));
    const max = Math.max(1, ...rows.map(r => val(r[1])));
    return `<div class="grid gap-1.5">${rows.map(([k, o]) => `<div class="grid grid-cols-[72px_1fr_64px] items-center gap-2 text-[12px]">
      <span class="truncate text-white/65">${esc(labelFn ? labelFn(k) : k)}</span>
      <span class="h-5 overflow-hidden rounded-md bg-white/[.06]"><span class="block h-full rounded-md" style="width:${Math.max(val(o) ? 2 : 0, Math.round(val(o) / max * 100))}%;background:linear-gradient(90deg,var(--gold-d),var(--gold))"></span></span>
      <span class="text-right font-semibold tabular-nums text-white">${fmt(val(o))}</span></div>`).join('')}</div>`;
}

function renderReport() {
    const live = S.data.sales.filter(s => !s.void);
    const raised = live.reduce((a, s) => a + s.price, 0), tix = live.reduce((a, s) => a + s.qty, 0);
    const kpi = (label, v) => `<div class="${card} px-3.5 py-3"><div class="text-[22px] font-bold leading-none tabular-nums text-white">${v}</div><div class="mt-1.5 text-[11px] font-semibold uppercase tracking-[.1em] text-white/45">${label}</div></div>`;
    if (!live.length) return `<div class="mt-3.5 grid grid-cols-2 gap-2">${kpi('Raised', '$0')}${kpi('Tickets', '0')}</div><div class="py-10 text-center text-sm text-white/50">Sales will show up here.</div>`;

    const step = S.gran === 'half' ? 1800000 : 3600000;
    const slots = tally(live, s => Math.floor(s.t / step) * step);
    const keys = [...slots.keys()].sort((a, b) => a - b);
    const first = keys[0], lastK = keys[keys.length - 1];
    const dense = (lastK - first) / step < 24;                          // short span: show the empty slots too, so quiet stretches are visible
    const rows = [];
    if (dense) for (let k = first; k <= lastK; k += step) rows.push([k, slots.get(k) || { usd: 0, tix: 0, n: 0 }]);
    else keys.forEach(k => rows.push([k, slots.get(k)]));
    const multiDay = new Set(keys.map(k => new Date(k).getUTCDate())).size > 1;
    const peak = rows.reduce((b, r) => (r[1].usd > b[1].usd ? r : b), rows[0]);

    const mBtn = (v, l) => chip(l, S.metric === v, `data-act="metric" data-v="${v}"`, '!px-3.5 !py-2.5 !text-[12px]');
    const gBtn = (v, l) => chip(l, S.gran === v, `data-act="gran" data-v="${v}"`, '!px-3.5 !py-2.5 !text-[12px]');
    const section = (title, inner) => `<div class="${card} p-3.5">${kicker(title)}<div class="mt-3">${inner}</div></div>`;
    const sorted = (m) => [...m.entries()].sort((a, b) => b[1].usd - a[1].usd);

    const colors = new Map();
    live.forEach(s => s.lines.forEach(l => { const o = colors.get(l[1]) || { usd: 0, tix: 0, n: 0 }; o.tix += l[4]; o.n += 1; colors.set(l[1], o); }));

    return `<div class="mt-3.5 grid grid-cols-2 gap-2">${kpi('Raised', money(raised))}${kpi('Tickets sold', tix.toLocaleString('en-US'))}${kpi('Sales', live.length)}${kpi('Avg sale', money(raised / live.length))}</div>
      <div class="mt-3 grid gap-3">
        ${section('Sales by time', `<div class="mb-3 flex flex-wrap gap-2">${mBtn('usd', '$ Raised')}${mBtn('tix', 'Tickets')}${mBtn('n', 'Sales')}<span class="w-full"></span>${gBtn('hour', 'Hourly')}${gBtn('half', '30 min')}</div>
          ${barRows(rows, S.metric, (k) => hourLabel(k, multiDay))}
          <div class="mt-3 text-[11px] text-white/45">Busiest: ${esc(hourLabel(peak[0], multiDay))} · ${money(peak[1].usd)} from ${peak[1].n} ${peak[1].n === 1 ? 'sale' : 'sales'}</div>`)}
        ${section('By payment', barRows(sorted(tally(live, s => s.pay || '—')), S.metric))}
        ${section('By seller', barRows(sorted(tally(live, s => s.seller || '—')), S.metric))}
        ${section('By bundle', barRows([...tally(live, s => s.qty).entries()].sort((a, b) => a[0] - b[0]), S.metric, (k) => `${k} tix`))}
        ${section('Tickets by color', barRows([...colors.entries()].sort((a, b) => b[1].tix - a[1].tix), 'tix'))}
      </div>`;
}

/* ---------- DEVICE (what is saved on this phone) ---------- */

const rangeText = (e) => e.lines.map((l) => `${l.roll} ${l.start === l.end ? l.start : l.start + '–' + l.end}`).join(', ');

function deviceRow(e) {
    const bad = e.status === 'failed', warn = e.conflicts && e.conflicts.length;
    const badge = bad ? '<span class="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase" style="background:rgba(217,80,60,.25);color:#ff9d8e">Not saved</span>'
        : e.status === 'pending' ? '<span class="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase" style="background:rgba(224,184,99,.18);color:var(--gold-l)">Waiting</span>'
        : '<span class="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase" style="background:rgba(46,158,99,.2);color:#7be0a9">Uploaded</span>';
    return `<div class="${card} px-3.5 py-3 ${e.handled ? 'opacity-60' : ''}">
      <div class="flex items-center justify-between gap-2"><span class="min-w-0 truncate text-[14px] font-semibold text-white">${esc(e.receipt || 'Local #' + e.seq)} · ${esc(e.name || e.phone || e.email || '(no name)')}</span>${badge}</div>
      <div class="mt-1 text-[12px] text-white/55">${esc(new Date(e.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))} · ${e.qty} tix · ${money(e.price)} · ${esc(e.pay)}</div>
      <div class="mt-1 text-[13px] font-semibold tabular-nums text-white/85">${esc(rangeText(e))}</div>
      ${bad ? `<div class="mt-1.5 text-[12px] font-semibold" style="color:#ff9d8e">${esc(e.error)}</div>` : ''}
      ${warn ? `<div class="mt-1.5 text-[12px] font-semibold" style="color:#ff9d8e">Overlaps ${e.conflicts.map((c) => esc(`${c.roll} ${c.start}–${c.end} (${c.receipt})`)).join(', ')}</div>` : ''}
      ${(bad || warn) && !e.handled ? `<div class="mt-2 flex gap-2">${bad ? `<button data-act="dretry" data-v="${esc(e.clientId)}" class="${pillBtn}">Try again</button>` : ''}<button data-act="dhandled" data-v="${esc(e.clientId)}" class="${pillBtn}">Mark handled</button></div>` : ''}</div>`;
}

function renderDevice() {
    const all = Store.deviceEntries().slice().reverse(), waiting = all.filter((e) => e.status !== 'synced');
    const st = Store.getState();
    return `<div class="grid gap-3">
      <button data-act="tab" data-v="sell" class="justify-self-start px-1 py-1 text-[13px] font-semibold text-white/60">← Back to selling</button>
      <div class="${card} px-4 py-3.5 text-[13px] text-white/75">Every sale is saved on this phone the moment you tap Sell, then uploaded to the raffle sheet automatically.
        If the internet drops you can keep selling; nothing is lost. ${waiting.length ? `<b class="text-white">${waiting.length} not uploaded yet.</b>` : 'Everything on this phone is uploaded.'}</div>
      <div class="flex flex-wrap gap-2">
        <button data-act="dsync" class="${pillBtn}" ${st.syncing ? 'disabled' : ''}>${st.syncing ? '<span class="rf-spin"></span> Uploading…' : '↻ Upload now'}</button>
        <button data-act="dcsv" class="${pillBtn}" ${all.length ? '' : 'disabled'}>⬇ Download all (CSV)</button>
        <button data-act="dcopy" data-v="tsv" class="${pillBtn}" ${waiting.length ? '' : 'disabled'}>Copy not-uploaded (for the sheet)</button>
        <button data-act="dcopy" data-v="text" class="${pillBtn}" ${waiting.length ? '' : 'disabled'}>Copy not-uploaded as text</button></div>
      ${waiting.length ? `<div>${kicker('Not uploaded yet')}<div class="mt-2 grid gap-2">${waiting.map(deviceRow).join('')}</div></div>` : ''}
      <div>${kicker('Sold on this phone')}<div class="mt-2 grid gap-2">${all.filter((e) => e.status === 'synced').map(deviceRow).join('') || '<div class="py-6 text-center text-sm text-white/50">Nothing yet.</div>'}</div></div>
    </div>`;
}

function download(name, text, type) {
    try {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type }));
        a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) { toast('Could not download. Use Copy instead.', true); }
}
async function copy(text, okMsg) {
    try { await navigator.clipboard.writeText(text); toast(okMsg); }
    catch (e) {
        // Clipboard blocked: show the text so it can be selected by hand.
        const w = document.createElement('textarea'); w.value = text; w.className = 'field-dark mt-3 h-40 w-full text-[11px]'; w.readOnly = true;
        body().appendChild(w); w.focus(); w.select(); toast('Select and copy the text at the bottom', true);
    }
}

/* ---------- shell ---------- */

const TABS = [['sell', 'Sell'], ['sales', 'Sales'], ['report', 'Report']];

/** "Sales as of" + refresh, only where stale data matters (Sales / Report), plus a pointer to anything not uploaded yet. */
function asOfRow() {
    const n = Store.pendingCount();
    return `<div class="mt-2.5 flex items-center gap-2">
        <span class="min-w-0 flex-1 truncate text-[11px] text-white/45">${esc(stamp())}</span>
        ${n ? `<button data-act="tab" data-v="device" class="flex-none rounded-full px-3 py-2 text-[11px] font-bold" style="background:rgba(224,184,99,.18);color:var(--gold-l)">⏱ ${n} waiting · Details</button>` : ''}
        <button data-act="refresh" aria-label="Refresh" title="Refresh" class="flex h-9 w-9 flex-none items-center justify-center rounded-full border border-white/20 bg-white/[.06] text-[15px] leading-none text-white/75" ${S.loading ? 'disabled' : ''}>${S.loading ? '<span class="rf-spin" style="margin:0"></span>' : '↻'}</button></div>`;
}

function render() {
    const el = body(); if (!el) return;
    if (S.error && !S.data) {
        el.innerHTML = `<div class="flex justify-end"><button data-act="refresh" class="${pillBtn}">↻ Try again</button></div>
          <div class="${card} mt-4 px-4 py-4 text-[14px] text-white/80">${esc(S.error)}</div>`;
        return;
    }
    if (!S.data) { el.innerHTML = `<div class="py-12 text-center text-sm text-white/50">Loading…</div>`; return; }

    const keep = document.activeElement && document.activeElement.id === 'raffle-q';
    const inner = S.tab === 'sell' ? (S.result ? renderResult() : renderSell()) : S.tab === 'sales' ? renderSales() : S.tab === 'device' ? renderDevice() : renderReport();
    // Tabs with the status dot at the end (same as concessions); sync details live behind the dot.
    el.innerHTML = `${Store.isPersistent() ? '' : `<div class="mb-2 rounded-2xl px-3 py-2 text-[12px] font-semibold text-white" style="background:var(--mar)">This browser can't keep data (private mode?). Sales are NOT kept if this tab closes.</div>`}
      <div class="flex items-stretch gap-1.5 rounded-[18px] p-1.5" style="background:rgba(255,255,255,.06)">
        <div class="grid min-w-0 flex-1 grid-cols-3 gap-1.5">${TABS.map(([k, l]) =>
        `<button data-act="tab" data-v="${k}" class="rounded-[13px] py-2.5 text-[13px] font-semibold ${S.tab === k ? '' : 'text-white/65'}" style="${S.tab === k ? goldStyle : ''}">${l}</button>`).join('')}</div>
        <div id="raffle-status" class="flex flex-none items-stretch">${statusHtml()}</div></div>
      ${S.tab === 'sales' || S.tab === 'report' ? asOfRow() : ''}
      <div class="${S.tab === 'sell' ? '' : 'mt-2.5'}">${inner}</div>`;

    if (keep) { const q = document.getElementById('raffle-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }
}

/* ---------- guided flow: bundle -> buyer -> tap how they paid ---------- */

/** Scrolls a section of the sell form into view, and optionally puts the cursor in one of its fields (opens the keyboard). */
function goTo(sec, field) {
    const el = body() && body().querySelector(`[data-sec="${sec}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const i = field && body().querySelector(`[data-f="${field}"]`);
    if (i && !i.value) i.focus({ preventScroll: true });
}
const NEXT_FIELD = { name: 'phone', phone: 'email' };
const focusField = (k) => { const i = body() && body().querySelector(`[data-f="${k}"]`); if (i) i.focus(); return i; };

/* ---------- events ---------- */

let wired = false;
function wire() {
    const el = body();
    if (!el || wired) return;
    wired = true;
    el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]'); if (!b || !S.data && b.getAttribute('data-act') !== 'refresh') return;
        const act = b.getAttribute('data-act'), v = b.getAttribute('data-v'), f = S.f;
        let after = null;
        switch (act) {
            case 'refresh': refreshNow(); return;
            case 'status': {
                const n = Store.pendingCount();
                toast(statusInfo().label, false, n || Store.attention().length ? { label: 'Details', run: () => { S.tab = 'device'; render(); } } : null);
                return;
            }
            case 'tab': S.tab = v; S.open = null; S.shown = PAGE; window.scrollTo({ top: 0 }); break;
            case 'roll': f.roll = v; S.rollOpen = false; saveLast({ roll: v }); dirty(); break;
            case 'rolls': S.rollOpen = !S.rollOpen; break;
            case 'badd': if (S.custom) { S.custom = false; f.cq = ''; f.cp = ''; } S.cart[v] = Math.min(99, (S.cart[v] || 0) + 1); dirty(); break;
            case 'bdec': S.cart[v] = Math.max(0, (S.cart[v] || 0) - 1); if (!S.cart[v]) delete S.cart[v]; dirty(); break;
            case 'custom': S.custom = !S.custom; if (S.custom) S.cart = {}; else { f.cq = ''; f.cp = ''; } dirty(); break;
            case 'pay': f.pay = v; saveLast({ pay: v }); dirty(); after = () => goTo('buyer', 'name'); break;
            case 'editnext': { const r = selRoll(); S.pre = true; S.rollOpen = false; f.preStart = r && r.remaining > 0 ? String(r.next) : ''; dirty(); render(); const i = body().querySelector('[data-f="preStart"]'); if (i) { i.focus(); i.select(); } return; }
            case 'domain': { f.email = f.email.split('@')[0] + '@' + v; const i = body().querySelector('[data-f="email"]'); if (i) i.value = f.email; dirty(); updateHints(); updateSellBar(); return; }
            case 'pre': S.pre = !S.pre; S.rollOpen = false; f.preStart = ''; f.preColor = ''; dirty(); break;
            case 'details': S.buyerOpen = true; after = () => { const first = ['name', 'phone', 'email'].find((k) => { const i = body().querySelector(`[data-f="${k}"]`); return i && !i.value; }); if (first) focusField(first); }; break;
            case 'buyer': {
                const s = nameSug[Number(v)];
                if (s) {
                    f.name = s.name; f.phone = s.phone ? fmtPhone(s.phone) : ''; f.email = s.email;
                    if (s.phone || s.email) S.buyerOpen = true;
                    S.touched = touchedBlank();
                    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
                }
                dirty(); break;
            }
            case 'sell': submit(v); return;
            case 'dsync': syncNow(); return;
            case 'dcsv': download(`raffle-sales-${seller().replace(/\W+/g, '_') || 'phone'}-${Date.now()}.csv`, Store.exportCsv(), 'text/csv'); toast(`Downloaded ${Store.deviceEntries().length} sales`); return;
            case 'dcopy': copy(v === 'tsv' ? Store.exportTsv(true) : Store.exportText(true), 'Copied'); return;
            case 'dretry': Store.retry(v); return;
            case 'dhandled': Store.markHandled(v); return;
            case 'next': S.result = null; window.scrollTo({ top: 0 }); break;
            case 'mine': S.mine = v === '1'; S.shown = PAGE; break;
            case 'open': S.open = S.open === v ? null : v; updateList(); return;
            case 'more': S.shown += PAGE; updateList(); return;
            case 'metric': S.metric = v; break;
            case 'gran': S.gran = v; break;
            default: return;
        }
        render();
        if (after) after();
    });
    el.addEventListener('input', (e) => {
        const t = e.target;
        if (t.id === 'raffle-q') { S.q = t.value; S.open = null; S.shown = PAGE; updateList(); return; }
        const k = t.getAttribute && t.getAttribute('data-f');
        if (!k) return;
        const f = S.f;
        let val = t.value;
        if (k === 'phone') { val = fmtPhone(val); t.value = val; }
        else if (k === 'preStart') { val = digits(val).replace(/^0+/, ''); t.value = val; }
        else if (k === 'email') { val = val.replace(/\s/g, ''); if (val !== t.value) t.value = val; }
        const hadAll = k === 'phone' && digits(f.phone).length === 10;
        f[k] = val; dirty(); updateHints(); updateSellBar();
        // A complete phone number moves straight on to the email.
        if (k === 'phone' && !hadAll && digits(val).length === 10) focusField('email');
    });
    // The keyboard's Next / Enter key moves name -> phone -> email, then puts the keyboard away.
    el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const k = e.target.getAttribute && e.target.getAttribute('data-f'), nx = NEXT_FIELD[k];
        if (!nx) { if (k === 'email') e.target.blur(); return; }
        e.preventDefault();
        const n = body().querySelector(`[data-f="${nx}"]`); if (n) n.focus(); else e.target.blur();
    });
    el.addEventListener('focusout', (e) => {
        const k = e.target.getAttribute && e.target.getAttribute('data-f');
        if (k === 'phone' || k === 'email') { S.touched[k] = true; updateHints(); }
    });
    // Keep the keyboard up when tapping a quick-email / past-buyer chip.
    el.addEventListener('mousedown', (e) => { if (e.target.closest('[data-keepfocus]')) e.preventDefault(); });
}
