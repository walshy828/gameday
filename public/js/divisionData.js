// public/js/divisionData.js
// Setup card (superadmin): per-division view of what the app has stored (entered results, history, submission log),
// CSV download, and a typed-confirmation "Clear" for test data. Standings/schedule from the sheet and Google Sheets
// themselves are never changed. Mirrors seasons.js.
import { getDivisionData, clearDivisionData, downloadDivisionData } from './api.js';
import { esc } from './concessionsUi.js';

const fresh = () => ({ rows: null, error: '', done: '', busy: false, sel: '', confirm: false, typed: '' });
const S = fresh();
const token = () => { try { return sessionStorage.getItem('adminAuthToken'); } catch (e) { return null; } };
const body = () => document.getElementById('division-data-body');
const fmt = (t) => (t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
const target = () => S.sel || 'ALL';

export function resetDivisionData() { Object.assign(S, fresh()); const el = body(); if (el) el.innerHTML = ''; }

function html() {
    if (S.error && !S.rows) return `<div class="text-[13px] text-white/70">${esc(S.error)} <button data-dd="reload" class="ml-1 font-semibold underline">Try again</button></div>`;
    if (!S.rows) return '<div class="text-[13px] text-white/50">Loading…</div>';
    const list = S.rows.length
        ? S.rows.map((r) => `<div class="flex items-center justify-between gap-3 border-t border-white/10 py-2 text-[12px] first:border-0">
            <div class="min-w-0"><div class="truncate font-semibold text-white">${esc(r.division)}</div>
            <div class="text-white/50">${r.enteredResults} result${r.enteredResults === 1 ? '' : 's'} entered · ${r.historyEntries} history · ${r.submissions} logged · last ${esc(fmt(r.lastActivity))}</div></div></div>`).join('')
        : '<div class="text-[12px] text-white/50">No divisions stored.</div>';
    const opts = ['<option value="">All divisions</option>', ...S.rows.map((r) => `<option value="${esc(r.division)}" ${S.sel === r.division ? 'selected' : ''}>${esc(r.division)}</option>`)].join('');
    const need = target();
    const confirmBox = S.confirm
        ? `<div class="mt-3 rounded-xl border border-red-400/60 bg-red-900/40 p-3 text-[12px] text-red-100">
            Clears entered results, "updated" stamps, history and the submission log for <strong>${esc(S.sel || 'ALL divisions')}</strong>. The sheet schedule and standings stay. Download a copy first if you may want it. This cannot be undone.
            <div class="mt-2">Type <strong>${esc(need)}</strong> to confirm:</div>
            <input data-dd-input type="text" value="${esc(S.typed)}" autocomplete="off" autocapitalize="off" class="field-dark mt-1 w-full" aria-label="Type to confirm">
            <div class="mt-2 flex gap-2"><button data-dd="cancel" class="h-12 flex-1 rounded-xl border border-white/20 bg-white/[.06] text-[13px] font-semibold text-white/85">Cancel</button>
            <button data-dd="go" ${S.typed === need && !S.busy ? '' : 'disabled'} class="h-12 flex-1 rounded-xl bg-red-600 text-[13px] font-bold text-white disabled:opacity-40">${S.busy ? 'Clearing…' : 'Clear data'}</button></div></div>`
        : '';
    return `<div class="max-h-56 overflow-y-auto rounded-xl border border-white/10 bg-white/[.03] px-3">${list}</div>
      <div class="mt-3"><select data-dd-sel class="field-dark w-full" aria-label="Division">${opts}</select></div>
      <div class="mt-2 flex gap-2">
        <button data-dd="download" ${S.busy ? 'disabled' : ''} class="h-12 flex-1 rounded-xl border border-white/20 bg-white/[.06] px-3 text-[13px] font-semibold text-white/85">Download CSV</button>
        <button data-dd="clear" ${S.busy || S.confirm ? 'disabled' : ''} class="h-12 flex-1 rounded-xl border border-red-400/60 bg-red-600/20 px-3 text-[13px] font-semibold text-red-100 disabled:opacity-40">Clear data…</button></div>
      ${confirmBox}
      ${S.error ? `<div class="mt-2 text-[12px] text-red-300">${esc(S.error)}</div>` : ''}
      ${S.done ? `<div class="mt-2 text-[12px] text-emerald-300">${esc(S.done)}</div>` : ''}`;
}

function draw() {
    const el = body(); if (!el) return;
    const keep = el.querySelector('[data-dd-input]') === document.activeElement;
    el.innerHTML = html();
    if (keep) { const i = el.querySelector('[data-dd-input]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
}

async function load() {
    try { S.rows = (await getDivisionData(token())).divisions; S.error = ''; } catch (e) { S.error = e.status === 0 ? 'Needs a connection.' : e.message; }
    draw();
}

let wired = false;
export function renderDivisionData() {
    const el = body(); if (!el || !App.state.isSuperAdmin) return;
    if (!wired) {
        wired = true;
        el.addEventListener('change', (e) => {
            if (!e.target.hasAttribute('data-dd-sel')) return;
            S.sel = e.target.value; S.confirm = false; S.typed = ''; S.error = ''; S.done = ''; draw();
        });
        el.addEventListener('input', (e) => {
            if (!e.target.hasAttribute('data-dd-input')) return;
            S.typed = e.target.value; draw();
        });
        el.addEventListener('click', async (e) => {
            const b = e.target.closest('[data-dd]'); if (!b) return;
            const a = b.getAttribute('data-dd');
            S.error = ''; S.done = '';
            if (a === 'reload') { S.rows = null; draw(); return load(); }
            if (a === 'clear') { S.confirm = true; S.typed = ''; }
            else if (a === 'cancel') { S.confirm = false; S.typed = ''; }
            else if (a === 'download') {
                S.busy = true; draw();
                try { await downloadDivisionData(token(), S.sel); S.done = 'Downloaded.'; }
                catch (err) { S.error = err.status === 0 ? 'Needs a connection.' : err.message; }
                S.busy = false;
            } else if (a === 'go') {
                S.busy = true; draw();
                try {
                    const { deleted, divisions } = await clearDivisionData(token(), S.sel || null, target());
                    S.rows = divisions;
                    S.done = `Cleared ${S.sel || 'all divisions'}: ${deleted.scheduleRowsReset} schedule rows reset, ${deleted.historyDeleted} history and ${deleted.submissionsDeleted} logged submissions removed.`;
                    S.confirm = false; S.typed = '';
                } catch (err) { S.error = err.status === 0 ? 'Needs a connection.' : err.message; }
                S.busy = false;
            }
            draw();
        });
    }
    if (!S.rows) draw();
    load();
}
