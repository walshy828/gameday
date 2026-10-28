// public/js/concessions.js
// Concessions view (concessions staff + superadmin): Sell, History, Report, Items. Everything runs from the
// local-first store (concessionsStore.js), so selling keeps working with no connection and syncs afterwards.
import * as Store from './concessionsStore.js';
import { renderReport, resetReport } from './concessionsReport.js';
import { renderItems, resetItems } from './concessionsItems.js';
import { esc, money, moneyShort, cents, fmtTime, fmtDay, dayKey, card, pillBtn, goldStyle, kicker, chip, toast, catColor, venmoUrl, qrBox } from './concessionsUi.js';

const S = {
    tab: 'sell', cart: {}, step: 'cart',          // step: cart → pay → done
    method: null, tendered: '', done: null,
    histDay: 'today', mine: false, open: null, voiding: null, showQr: null, voidReason: ''
};

const body = () => document.getElementById('concessions-body');
const seller = () => (typeof App !== 'undefined' && App.state && App.state.reporterName) || sessionStorage.getItem('reporterName') || (Store.loadAuth() || {}).name || '';
const catalog = () => Store.catalog();

/* ---------- the order being built ---------- */

function activeItems() { const c = catalog(); return c ? c.items.filter((i) => i.active) : []; }
function cartLines() {
    const byId = new Map((catalog()?.items || []).map((i) => [i.id, i]));
    return Object.entries(S.cart).filter(([, q]) => q > 0).map(([id, qty]) => {
        const it = byId.get(Number(id));
        return it ? { id: it.id, name: it.name, price: it.price, qty, category: it.category } : null;
    }).filter(Boolean);
}
const cartTotal = (lines) => lines.reduce((a, l) => a + cents(l.price) * l.qty, 0) / 100;
const cartCount = (lines) => lines.reduce((a, l) => a + l.qty, 0);

/* ---------- status pill ---------- */

function statusHtml() {
    const st = Store.getState(), n = Store.pendingCount(), failed = st.failed.length;
    let label, color;
    if (st.authProblem) { label = 'Sign in again to sync'; color = 'var(--mar)'; }
    else if (st.online === false) { label = n ? `Offline · ${n} waiting to sync` : 'Offline · sales saved on this phone'; color = '#b45309'; }
    else if (st.syncing || n) { label = n ? `Syncing ${n}…` : 'Syncing…'; color = '#b45309'; }
    else if (st.online === true) { label = 'Online · all synced'; color = '#15803d'; }
    else { label = 'Checking connection…'; color = '#52525b'; }
    return `<span class="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold text-white" style="background:${color}"><span class="h-1.5 w-1.5 rounded-full bg-white/80"></span>${esc(label)}</span>
      ${failed ? `<button data-act="failed" class="ml-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold text-white" style="background:var(--mar)">${failed} not saved</button>` : ''}`;
}
function updateStatus() { const el = document.getElementById('cn-status'); if (el) el.innerHTML = statusHtml(); }

/* ---------- SELL ---------- */

/** One tap on the tile adds one; the gold badge shows the quantity and the − button takes one off. */
function tile(it) {
    const q = S.cart[it.id] || 0;
    return `<div class="${card} relative ${q ? 'ring-1 ring-white/40' : ''}" style="min-height:68px">
      <button type="button" data-act="add" data-v="${it.id}" class="block h-full w-full px-3 py-2.5 text-left" style="min-height:68px" aria-label="Add ${esc(it.name)}">
        <div class="truncate text-[15px] font-semibold leading-tight text-white" style="${q ? 'padding-right:34px' : ''}">${esc(it.name)}</div>
        <div class="mt-0.5 text-[13px] font-semibold tabular-nums text-white/55">${moneyShort(it.price)}</div></button>
      ${q ? `<span class="pointer-events-none absolute right-2 top-2 flex h-7 min-w-[28px] items-center justify-center rounded-full px-1.5 text-[14px] font-bold tabular-nums" style="${goldStyle}">${q}</span>
      <button type="button" data-act="dec" data-v="${it.id}" class="absolute bottom-1.5 right-1.5 flex h-8 w-11 items-center justify-center rounded-full border border-white/25 bg-white/10 text-[20px] font-bold leading-none text-white" aria-label="Remove one ${esc(it.name)}">−</button>` : ''}</div>`;
}

function renderSell() {
    const c = catalog();
    if (!c) return `<div class="${card} mt-4 px-4 py-4 text-[14px] text-white/80">The item list hasn't loaded yet. Connect once to load it, then the stand works offline.</div>`;
    if (S.step === 'pay') return renderPay();

    const items = activeItems();
    if (!items.length) return `<div class="${card} mt-4 px-4 py-4 text-[14px] text-white/80">No items for sale. Add some on the Items tab.</div>`;
    const cats = c.settings.categories.filter((cat) => items.some((i) => i.category === cat));
    items.forEach((i) => { if (!cats.includes(i.category)) cats.push(i.category); });

    const sections = cats.map((cat) => `<div>
        <div class="mb-1.5 flex items-center gap-2">${`<span class="h-2.5 w-2.5 rounded-full" style="background:${catColor(cat, c.settings.categories)}"></span>`}${kicker(cat)}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">${items.filter((i) => i.category === cat).map(tile).join('')}</div></div>`).join('');

    return `<div class="mt-2.5 grid gap-2.5">${sections}
      <div id="cn-sellbar" class="sticky z-40 -mx-1 rounded-3xl p-1.5" style="bottom:calc(96px + env(safe-area-inset-bottom,0px));background:rgba(14,14,16,.82);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)">${sellBar()}</div></div>`;
}

function sellBar() {
    const lines = cartLines(), n = cartCount(lines), total = cartTotal(lines);
    if (!n) return `<div class="px-3 py-3.5 text-center text-[13px] font-semibold text-white/50">Tap + Add to start an order</div>`;
    return `<div class="flex items-center gap-2">
      <button data-act="clear" class="flex-none rounded-[20px] border border-white/20 bg-white/[.06] px-4 py-4 text-[13px] font-semibold leading-none text-white/75">Clear</button>
      <button data-act="charge" class="flex-1 rounded-[20px] px-4 py-4 text-[16px] font-bold leading-none" style="${goldStyle}">Charge ${money(total)} <span class="font-semibold opacity-70">· ${n} ${n === 1 ? 'item' : 'items'}</span></button></div>`;
}

function summary(lines) {
    return `<div class="${card} divide-y divide-white/10 px-3.5">${lines.map((l) => `<div class="flex items-baseline justify-between gap-3 py-2.5 text-[14px]">
        <span class="min-w-0 truncate text-white/85"><span class="font-bold tabular-nums">${l.qty}×</span> ${esc(l.name)}</span><span class="tabular-nums text-white/60">${money(l.price * l.qty)}</span></div>`).join('')}</div>`;
}

function renderPay() {
    const lines = cartLines(), total = cartTotal(lines), s = catalog().settings;
    const head = `<div class="mt-3.5 grid gap-3">${summary(lines)}
      <div class="text-center"><div class="text-[11px] font-semibold uppercase tracking-[.16em] text-white/50">Total due</div>
        <div class="mt-1 text-[46px] font-bold leading-none tabular-nums text-white">${money(total)}</div></div>`;
    if (!S.method) {
        return `${head}<div class="grid grid-cols-2 gap-2.5">
          <button data-act="complete" data-v="cash" class="rounded-3xl border border-white/15 bg-white/[.06] py-7 text-[18px] font-bold text-white">💵 Cash</button>
          <button data-act="method" data-v="venmo" class="rounded-3xl border border-white/15 bg-white/[.06] py-7 text-[18px] font-bold text-white">📱 Venmo</button></div>
          <button data-act="back" class="py-2 text-[13px] font-semibold text-white/55">← Back to order</button></div>`;
    }
    if (S.method === 'venmo') {
        const qr = s.venmoUser
            ? `${qrBox(venmoUrl(s.venmoUser, total, s.venmoNote))}<div class="text-center text-[12px] text-white/55">Scan with the Venmo app or the phone camera · pays @${esc(s.venmoUser)} ${money(total)}</div>`
            : `<div class="${card} px-4 py-4 text-[14px] text-white/80">No Venmo username is set yet. Add it on the Items tab, or take cash.</div>`;
        return `${head}${qr}
          <button data-act="complete" class="w-full rounded-[20px] px-4 py-4 text-[16px] font-bold leading-none" style="${goldStyle}">Payment received ✓</button>
          <button data-act="method" data-v="" class="py-2 text-[13px] font-semibold text-white/55">← Change payment</button></div>`;
    }
}

function complete(method) {
    const lines = cartLines();
    method = method || S.method;
    if (!lines.length || !method) return;
    const sale = Store.recordSale({ lines, payment: method, seller: seller() });
    S.step = 'cart'; S.cart = {}; S.method = null; S.tendered = ''; S.done = null;
    toast(`✓ Sale complete · ${money(sale.total)} ${method === 'venmo' ? 'Venmo' : 'cash'}`, false, {
        label: 'Undo',
        run: () => { Store.voidSale(sale.clientId, seller(), 'Voided right after sale'); toast('Sale voided'); }
    });
}

/* ---------- HISTORY ---------- */

function summaryText(lines) { return lines.map((l) => `${l.qty} ${l.name}`).join(', '); }

function historyRows() {
    const all = Store.sales().slice().reverse();
    const today = dayKey(Date.now());
    const me = seller();
    let rows = all.filter((s) => (S.histDay === 'today' ? dayKey(s.t) === today : true) && (!S.mine || s.seller === me));
    const live = rows.filter((s) => !s.voided && !s.failed);
    const total = live.reduce((a, s) => a + s.total, 0);
    const cfg = catalog()?.settings || {};
    let lastDay = '';
    const list = rows.map((s) => {
        const dayHead = S.histDay === 'all' && dayKey(s.t) !== lastDay ? (lastDay = dayKey(s.t), `<div class="pt-2">${kicker(fmtDay(s.t))}</div>`) : '';
        const open = S.open === s.clientId;
        const badge = s.failed ? `<span class="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase" style="background:rgba(217,80,60,.25);color:#ff9d8e">Not saved</span>`
            : s.voided ? `<span class="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold uppercase text-white/60">Void</span>`
            : s.pending || s.voidPending ? `<span class="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase" style="background:rgba(224,184,99,.18);color:var(--gold-l)">Syncing</span>` : '';
        const detail = open ? `<div class="mt-3 border-t border-white/10 pt-3 text-[13px]">
            <div class="grid gap-1">${s.lines.map((l) => `<div class="flex justify-between gap-3"><span class="text-white/80">${l.qty}× ${esc(l.name)}</span><span class="tabular-nums text-white/55">${money(l.price * l.qty)}</span></div>`).join('')}</div>
            <div class="mt-2 text-[12px] text-white/45">${esc(s.seller || '—')} · ${s.payment === 'venmo' ? 'Venmo' : 'Cash'}${s.seq ? ` · #${s.seq}` : ''}${s.voided ? ` · voided by ${esc(s.voidBy)}${s.voidReason ? ' (' + esc(s.voidReason) + ')' : ''}` : ''}${s.failed ? ` · ${esc(s.failed)}` : ''}</div>
            ${S.showQr === s.clientId ? `<div class="mt-3">${cfg.venmoUser ? `${qrBox(venmoUrl(cfg.venmoUser, s.total, cfg.venmoNote), 240)}<div class="mt-1.5 text-center text-[11px] text-white/45">${money(s.total)} to @${esc(cfg.venmoUser)}</div>` : '<div class="text-white/55">No Venmo username set (Items tab).</div>'}</div>` : ''}
            ${S.voiding === s.clientId ? `<div class="mt-3 grid gap-2"><input data-f="voidReason" type="text" placeholder="Reason (optional)" value="${esc(S.voidReason)}" class="field-dark" aria-label="Void reason">
                <div class="grid grid-cols-2 gap-2"><button data-act="voidgo" data-v="${s.clientId}" class="rounded-2xl py-3 text-[13px] font-bold text-white" style="background:var(--mar)">Yes, void it</button><button data-act="voidno" class="rounded-2xl border border-white/20 bg-white/[.06] py-3 text-[13px] font-semibold text-white/75">Keep sale</button></div></div>`
              : `<div class="mt-3 flex flex-wrap gap-2"><button data-act="qr" data-v="${s.clientId}" class="${pillBtn}">${S.showQr === s.clientId ? 'Hide' : 'Show'} Venmo QR</button>${s.voided || s.failed ? '' : `<button data-act="voidask" data-v="${s.clientId}" class="${pillBtn}" style="color:#ff9d8e">Void sale</button>`}</div>`}
          </div>` : '';
        return `${dayHead}<div class="${card} px-3.5 py-3 ${s.voided ? 'opacity-60' : ''}">
          <button data-act="open" data-v="${s.clientId}" class="flex w-full items-start gap-3 text-left">
            <div class="w-[58px] flex-none text-[12px] font-semibold tabular-nums text-white/50">${esc(fmtTime(s.t))}</div>
            <div class="min-w-0 flex-1"><div class="truncate text-[14px] text-white/90 ${s.voided ? 'line-through' : ''}">${esc(summaryText(s.lines))}</div>
              <div class="mt-0.5 flex items-center gap-2 text-[11px] text-white/45"><span class="truncate">${esc(s.seller || '—')}</span><span>${s.payment === 'venmo' ? 'Venmo' : 'Cash'}</span>${badge}</div></div>
            <div class="flex-none text-[16px] font-bold tabular-nums text-white ${s.voided ? 'line-through' : ''}">${money(s.total)}</div></button>${detail}</div>`;
    }).join('');

    return `<div class="mt-3.5 flex flex-wrap items-center gap-2">${chip('Today', S.histDay === 'today', 'data-act="day" data-v="today"', '!px-3.5 !py-2.5 !text-[12px]')}${chip('Whole season', S.histDay === 'all', 'data-act="day" data-v="all"', '!px-3.5 !py-2.5 !text-[12px]')}${chip('Just mine', S.mine, 'data-act="mine"', '!px-3.5 !py-2.5 !text-[12px]')}
        <span class="ml-auto text-[12px] font-semibold tabular-nums text-white/55">${live.length} ${live.length === 1 ? 'sale' : 'sales'} · ${money(total)}</span></div>
      <div id="cn-hist" class="mt-3 grid gap-2">${list || `<div class="py-10 text-center text-sm text-white/50">No sales yet.</div>`}</div>`;
}

/* ---------- shell ---------- */

const TABS = [['sell', 'Sell'], ['history', 'History'], ['report', 'Report'], ['items', 'Items']];

function render() {
    const el = body(); if (!el) return;
    const c = catalog();
    el.innerHTML = `<div class="screen-head"><h2 class="screen-title">Concessions</h2><div id="cn-status" class="flex items-center">${statusHtml()}</div></div>
      ${Store.isPersistent() ? '' : `<div class="mt-2 rounded-2xl px-3 py-2 text-[12px] font-semibold text-white" style="background:var(--mar)">This browser can't store data (private mode?). Sales will not survive a reload if you go offline.</div>`}
      <div class="mt-3 grid grid-cols-4 gap-1.5 rounded-[18px] p-1.5" style="background:rgba(255,255,255,.06)">${TABS.map(([k, l]) =>
        `<button data-act="tab" data-v="${k}" class="rounded-[13px] py-2.5 text-[13px] font-semibold ${S.tab === k ? '' : 'text-white/65'}" style="${S.tab === k ? goldStyle : ''}">${l}</button>`).join('')}</div>
      ${c && c.season ? `<div class="mt-1.5 px-1 text-[11px] text-white/40">Season ${esc(c.season.label)}</div>` : ''}
      <div id="cn-pane">${S.tab === 'sell' ? renderSell() : S.tab === 'history' ? historyRows() : ''}</div>`;
    const pane = document.getElementById('cn-pane');
    if (S.tab === 'report') renderReport(pane);
    if (S.tab === 'items') renderItems(pane);
}

/** Re-renders only what depends on the store (not the Items editor, which may hold unsaved edits). */
function refresh() {
    updateStatus();
    if (S.tab === 'sell' || S.tab === 'history') { const el = body(); if (el && el.querySelector('#cn-pane')) { const pane = document.getElementById('cn-pane'); const typing = document.activeElement && pane.contains(document.activeElement) && document.activeElement.tagName === 'INPUT'; if (!typing) pane.innerHTML = S.tab === 'sell' ? renderSell() : historyRows(); } }
    else if (S.tab === 'report') renderReport(document.getElementById('cn-pane'), true);
}

let started = false;
export function renderConcessions() {
    wire();
    if (!started) { started = true; Store.onChange(() => { const v = document.getElementById('concessions-view'); if (v && !v.classList.contains('hidden')) refresh(); }); }
    Store.startSync();
    render();
    Store.loadCatalog().then(() => { render(); });
    Store.loadSales().then(() => refresh());
    Store.sync();
}

/** Called on logout / role change so a different login never sees this person's draft. Unsynced sales stay on the phone. */
export function resetConcessions() {
    Object.assign(S, { tab: 'sell', cart: {}, step: 'cart', method: null, tendered: '', done: null, histDay: 'today', mine: false, open: null, voiding: null, showQr: null, voidReason: '' });
    resetReport(); resetItems();
    const el = body(); if (el) el.innerHTML = '';
}

/** How many sales are still only on this phone (logout warns about them). */
export const unsyncedCount = () => Store.outboxCount();

let wired = false;
function wire() {
    const el = body();
    if (!el || wired) return;
    wired = true;
    el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]'); if (!b) return;
        const act = b.getAttribute('data-act'), v = b.getAttribute('data-v');
        switch (act) {
            case 'tab': S.tab = v; S.open = null; break;
            case 'add': S.cart[v] = Math.min(99, (S.cart[v] || 0) + 1); break;
            case 'dec': S.cart[v] = Math.max(0, (S.cart[v] || 0) - 1); if (!S.cart[v]) delete S.cart[v]; break;
            case 'clear': S.cart = {}; break;
            case 'charge': if (cartLines().length) { S.step = 'pay'; S.method = null; S.tendered = ''; } break;
            case 'back': S.step = 'cart'; break;
            case 'method': S.method = v || null; S.tendered = ''; break;
                        case 'complete': complete(v); break;
            case 'day': S.histDay = v; break;
            case 'mine': S.mine = !S.mine; break;
            case 'open': S.open = S.open === v ? null : v; S.voiding = null; S.showQr = null; break;
            case 'qr': S.showQr = S.showQr === v ? null : v; break;
            case 'voidask': S.voiding = v; S.voidReason = ''; break;
            case 'voidno': S.voiding = null; break;
            case 'voidgo': Store.voidSale(v, seller(), S.voidReason); S.voiding = null; toast('Sale voided'); break;
            case 'failed': {
                const f = Store.getState().failed;
                alert(`${f.length} sale change(s) were rejected by the server and not saved:\n\n` + f.map((x) => `• ${x.op} ${x.clientId.slice(0, 8)}: ${x.error}`).join('\n'));
                if (confirm('Clear this notice?')) f.slice().forEach(() => Store.dismissFailed(0));
                break;
            }
            default: return;
        }
        if (['charge', 'back', 'complete', 'tab'].includes(act)) window.scrollTo({ top: 0 });
        render();
    });
    el.addEventListener('input', (e) => {
        const t = e.target, k = t.getAttribute && t.getAttribute('data-f');
        if (k === 'voidReason') S.voidReason = t.value;
    });
}
