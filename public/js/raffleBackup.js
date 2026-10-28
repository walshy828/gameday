// public/js/raffleBackup.js
// Setup sub-page (superadmin): the raffle sales saved in the database, and an on-demand reconciliation against
// the raffle spreadsheet. Opening the page and searching cost no Sheets calls; "Reconcile" makes one fresh read.
import { getRaffleBackup, reconcileRaffle } from './api.js';

const S = { seasons: [], seasonId: null, rows: null, loading: false, error: '', q: '', shown: 40, rec: null, recLoading: false, recError: '', open: null };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const token = () => { try { return sessionStorage.getItem('adminAuthToken'); } catch (e) { return null; } };
const body = () => document.getElementById('raffle-backup-body');
const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtTime = (t) => (t ? new Date(t).toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
const digits = (s) => String(s || '').replace(/\D/g, '');
const ranges = (lines) => (lines || []).map(l => { const r = l.roll ?? l[0], a = l.start ?? l[2], b = l.end ?? l[3]; return `${r}: ${a === b ? a : a + '–' + b}`; }).join(', ');

const card = 'rounded-2xl border border-white/10 bg-white/[.05]';
const pillBtn = 'flex-none rounded-full border border-white/20 bg-white/[.06] px-3.5 py-2.5 text-[11px] font-semibold leading-none text-white/75';
const goldStyle = 'background:linear-gradient(135deg,var(--gold) 0%,var(--gold-d) 100%);color:#2A1B08';
const kicker = (t) => `<div class="text-[10px] tracking-[.16em] font-semibold text-white/50 uppercase">${esc(t)}</div>`;
const STATUS = {
    synced: ['Synced', 'rgba(46,158,99,.18)', '#7ddba6'],
    pending: ['Pending', 'rgba(224,184,99,.18)', 'var(--gold-l)'],
    failed: ['Failed', 'rgba(217,80,60,.2)', '#ff9d8e']
};
const badge = (st) => { const [l, bg, fg] = STATUS[st] || [st, 'rgba(255,255,255,.1)', '#fff']; return `<span class="flex-none rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide" style="background:${bg};color:${fg}">${esc(l)}</span>`; };

async function load() {
    if (S.loading) return;
    S.loading = true; S.error = ''; render();
    try { const out = await getRaffleBackup(token(), S.seasonId); S.rows = out.rows; S.seasons = out.seasons; S.seasonId = out.season.id; }
    catch (e) { S.error = e.message || String(e); }
    finally { S.loading = false; render(); }
}

async function reconcile() {
    if (S.recLoading) return;
    S.recLoading = true; S.recError = ''; render();
    try { S.rec = await reconcileRaffle(token()); }
    catch (e) { S.recError = e.message || String(e); }
    finally { S.recLoading = false; render(); }
}

export function renderRaffleBackup() {
    wire();
    if (!S.rows && !S.loading) { load(); return; }
    render();
}

export function resetRaffleBackup() {
    Object.assign(S, { seasons: [], seasonId: null, rows: null, loading: false, error: '', q: '', shown: 40, rec: null, recLoading: false, recError: '', open: null });
    const el = body(); if (el) el.innerHTML = '';
}

/* ---------- reconciliation ---------- */

function sale(r, extra) {
    return `<div class="${card} px-3.5 py-2.5 text-[13px]">
      <div class="flex items-center justify-between gap-2"><span class="min-w-0 truncate font-semibold text-white">${esc(r.receipt)} · ${esc(r.name || r.phone || r.email || '(no name)')}</span>${r.status ? badge(r.status) : ''}</div>
      <div class="text-[12px] text-white/55">${esc(fmtTime(r.t))} · ${esc(r.seller)} · ${r.qty} tix · ${money(r.price)} · ${esc(r.pay)}</div>
      ${r.lines && r.lines.length ? `<div class="text-[12px] text-white/45 tabular-nums">${esc(ranges(r.lines))}</div>` : ''}
      ${r.error ? `<div class="text-[12px]" style="color:#ff9d8e">${esc(r.error)}</div>` : ''}${extra || ''}</div>`;
}

function group(title, hint, items, render) {
    if (!items.length) return '';
    return `<div class="mt-4">${kicker(`${title} (${items.length})`)}<div class="mt-1 mb-2 text-[12px] text-white/50">${esc(hint)}</div><div class="grid gap-2">${items.map(render).join('')}</div></div>`;
}

function renderRec() {
    if (S.recError) return `<div class="mt-3 rounded-2xl px-3.5 py-3 text-[13px] font-semibold text-white" style="background:var(--mar)">${esc(S.recError)}</div>`;
    const r = S.rec;
    if (!r) return '';
    const s = r.summary, clean = !s.missingInSheet && !s.missingInDb && !s.mismatched && !s.pending && !s.duplicateReceipts.length;
    const stat = (l, db, sh, bad) => `<div class="grid grid-cols-[1fr_auto_auto] items-baseline gap-x-4 py-1.5 text-[13px]"><span class="text-white/60">${l}</span><span class="tabular-nums text-white">${db}</span><span class="tabular-nums ${bad ? 'font-bold' : 'text-white'}" style="${bad ? 'color:#ff9d8e' : ''}">${sh}</span></div>`;
    return `<div class="mt-3 ${card} p-3.5" style="${clean ? 'border-color:rgba(46,158,99,.5)' : 'border-color:rgba(224,184,99,.5)'}">
      <div class="text-[15px] font-bold text-white">${clean ? '✔ Database and sheet agree' : 'Differences found'}</div>
      <div class="mb-1 text-[11px] text-white/45">Checked ${esc(new Date(r.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</div>
      <div class="grid grid-cols-[1fr_auto_auto] gap-x-4 border-b border-white/10 pb-1 text-[10px] font-semibold uppercase tracking-[.12em] text-white/40"><span></span><span>Database</span><span>Sheet</span></div>
      ${stat('Sales', s.dbSales, s.sheetSales, s.dbSales !== s.sheetSales)}
      ${stat('Raised (not voided)', money(s.dbRaised), money(s.sheetRaised), s.dbRaised !== s.sheetRaised)}
      ${stat('Tickets (not voided)', s.dbTickets, s.sheetTickets, s.dbTickets !== s.sheetTickets)}
      <div class="mt-1 text-[12px] text-white/50">${s.matched} matched · ${s.mismatched} differ · ${s.missingInSheet} not in sheet · ${s.missingInDb} not in database${s.pending ? ` · ${s.pending} pending` : ''}${s.failed ? ` · ${s.failed} failed` : ''}${s.voidedInSheet ? ` · ${s.voidedInSheet} voided in sheet` : ''}</div>
      ${s.duplicateReceipts.length ? `<div class="mt-2 text-[12px]" style="color:var(--gold-l)">⚠ Receipt number reused in the database: ${esc(s.duplicateReceipts.join(', '))}. This happens if the sheet's Sales log was cleared between events; only the newest was compared.</div>` : ''}</div>
      ${group('Differ', 'In both, but a value is different. The database value is what the app recorded at the time of sale; the sheet value may have been edited since.', r.mismatched, (m) => sale(m, `<div class="mt-1.5 grid gap-1 border-t border-white/10 pt-1.5">${m.diffs.map(d => `<div class="grid grid-cols-[84px_1fr] gap-2 text-[12px]"><span class="text-white/45">${esc(d.field)}</span><span class="break-words"><span class="text-white/70">DB: ${esc(d.db) || '—'}</span><br><span style="color:var(--gold-l)">Sheet: ${esc(d.sheet) || '—'}</span></span></div>`).join('')}${m.voidedInSheet ? '<div class="text-[12px]" style="color:#ff9d8e">Voided in the sheet</div>' : ''}</div>`))}
      ${group('In database, not in sheet', 'Sold through the app but missing from the Sales tab: a row deleted or moved in the sheet, or a sheet write whose result was unknown (Pending).', r.missingInSheet, (m) => sale(m))}
      ${group('In sheet, not in database', 'On the Sales tab but never saved here: sold at a Station tab in the sheet, or before the backup existed.', r.missingInDb, (m) => sale(m))}
      ${group('Failed attempts', 'The sheet refused these, so the sale did not happen. Listed for reference only.', r.failed, (m) => sale(m))}`;
}

/* ---------- database list ---------- */

function matches(r, q, dq) {
    if (!q) return true;
    if (dq.length >= 3 && digits(r.phone).includes(dq)) return true;
    return `${r.name} ${r.email} ${r.receipt} ${r.phone} ${r.seller}`.toLowerCase().includes(q);
}

function listHtml() {
    const q = S.q.trim().toLowerCase(), dq = digits(S.q);
    const all = S.rows.slice().reverse().filter(r => matches(r, q, dq));
    if (!all.length) return `<div class="py-8 text-center text-sm text-white/50">${S.q ? `Nothing matches “${esc(S.q)}”.` : 'No raffle sales saved in the database yet.'}</div>`;
    const shown = all.slice(0, S.shown);
    return `<div class="grid gap-2">${shown.map(r => `<button data-act="open" data-v="${r.id}" class="${card} block w-full px-3.5 py-2.5 text-left">
        <span class="flex items-center justify-between gap-2"><span class="min-w-0 truncate text-[14px] font-semibold text-white">${esc(r.receipt)} · ${esc(r.name || r.phone || r.email || '(no name)')}</span>${badge(r.status)}</span>
        <span class="block text-[12px] text-white/55">${esc(fmtTime(r.t))} · ${esc(r.seller)} · ${r.qty} tix · ${money(r.price)} · ${esc(r.pay)}</span>
        ${S.open === r.id ? `<span class="mt-1.5 grid gap-0.5 border-t border-white/10 pt-1.5 text-[12px] text-white/70">
          <span class="tabular-nums">${esc(ranges(r.lines))}</span>${r.phone ? `<span>📞 ${esc(r.phone)}</span>` : ''}${r.email ? `<span>✉️ ${esc(r.email)}</span>` : ''}${r.notes ? `<span>“${esc(r.notes)}”</span>` : ''}
          <span class="text-white/40">Saved ${esc(new Date(r.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }))}${r.error ? ' · ' + esc(r.error) : ''}</span></span>` : ''}</button>`).join('')}</div>
      ${all.length > shown.length ? `<button data-act="more" class="${pillBtn} mx-auto mt-3 block">Show more (${all.length - shown.length} left)</button>` : ''}`;
}
function updateList() { const el = document.getElementById('raffle-backup-list'); if (el) el.innerHTML = listHtml(); }

function download() {
    const cols = ['id', 'receipt', 'status', 'sold_at', 'saved_at', 'seller', 'buyer', 'phone', 'email', 'tickets', 'price', 'payment', 'ticket_numbers', 'notes', 'error'];
    const cell = (v) => { v = String(v ?? ''); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };   // quotes, and no spreadsheet formula injection
    const lines = [cols.join(',')].concat(S.rows.map(r => [r.id, r.receipt, r.status, new Date(r.t).toISOString().replace('T', ' ').slice(0, 19), new Date(r.createdAt).toISOString(), r.seller, r.name, r.phone, r.email, r.qty, r.price.toFixed(2), r.pay, ranges(r.lines), r.notes, r.error].map(cell).join(',')));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = `raffle-sales-backup-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- shell ---------- */

function render() {
    const el = body(); if (!el) return;
    if (S.error && !S.rows) { el.innerHTML = `<div class="${card} mt-4 px-4 py-4 text-[14px] text-white/80">${esc(S.error)}</div><button data-act="reload" class="${pillBtn} mt-3">↻ Try again</button>`; return; }
    if (!S.rows) { el.innerHTML = '<div class="py-12 text-center text-sm text-white/50">Loading…</div>'; return; }
    const counts = S.rows.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
    const live = S.rows.filter(r => r.status !== 'failed');
    const keep = document.activeElement && document.activeElement.id === 'raffle-backup-q';
    const seasonPick = S.seasons.length > 1 ? `<select data-f="season" class="field-dark mt-3" aria-label="Season">${S.seasons.map((x) => `<option value="${x.id}" ${x.id === S.seasonId ? 'selected' : ''}>Season ${esc(x.label)}${x.current ? ' (current)' : ''}</option>`).join('')}</select>` : '';
    el.innerHTML = `<div class="mt-3.5 ${card} p-3.5">
        <div class="text-[13px] text-white/70">Every raffle sale made in the app is saved here before it is written to the sheet.</div>
        <div class="mt-2 text-[12px] text-white/50">${S.rows.length} saved · ${money(live.reduce((a, r) => a + r.price, 0))} · ${live.reduce((a, r) => a + r.qty, 0)} tickets${counts.pending ? ` · <span style="color:var(--gold-l)">${counts.pending} pending</span>` : ''}${counts.failed ? ` · ${counts.failed} failed` : ''}</div>
        ${seasonPick}
        <div class="mt-3 flex flex-wrap gap-2">
          <button data-act="reconcile" ${S.recLoading ? 'disabled' : ''} class="rounded-[13px] px-3.5 py-2.5 text-[12px] font-semibold ${S.recLoading ? 'opacity-60' : ''}" style="${goldStyle}">${S.recLoading ? 'Comparing…' : '⇄ Reconcile with sheet'}</button>
          <button data-act="reload" class="${pillBtn}" ${S.loading ? 'disabled' : ''}>↻ Reload</button>
          <button data-act="csv" class="${pillBtn}">⬇ CSV</button></div>
        <div class="mt-2 text-[11px] text-white/40">Reconcile reads the sheet once, so wait a moment between runs while sales are busy. It compares the sheet against all seasons' saved sales.</div></div>
      ${renderRec()}
      <div class="mt-5">${kicker('Saved in database')}</div>
      <div class="mt-2"><input id="raffle-backup-q" type="search" value="${esc(S.q)}" placeholder="Search name, phone, email, receipt or seller…" autocomplete="off" aria-label="Search saved raffle sales" class="field-dark"></div>
      <div id="raffle-backup-list" class="mt-3">${listHtml()}</div>`;
    if (keep) { const q = document.getElementById('raffle-backup-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }
}

let wired = false;
function wire() {
    const el = body();
    if (!el || wired) return;
    wired = true;
    el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]'); if (!b) return;
        const v = b.getAttribute('data-v');
        switch (b.getAttribute('data-act')) {
            case 'reconcile': reconcile(); break;
            case 'reload': S.rows = null; load(); break;
            case 'csv': download(); break;
            case 'open': S.open = S.open === Number(v) ? null : Number(v); updateList(); break;
            case 'more': S.shown += 40; updateList(); break;
        }
    });
    el.addEventListener('change', (e) => {
        if (e.target.getAttribute('data-f') === 'season') { S.seasonId = Number(e.target.value); S.rows = null; load(); }
    });
    el.addEventListener('input', (e) => {
        if (e.target.id === 'raffle-backup-q') { S.q = e.target.value; S.shown = 40; S.open = null; updateList(); }
    });
}
