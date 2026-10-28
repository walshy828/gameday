// public/js/danger.js
// Setup "Danger zone" (superadmin): permanently deletes concession sales and/or raffle backup rows from the database
// for retesting. Only shown when the server has ALLOW_TEST_DATA_RESET=true. Two confirmations before it runs.
// Google Sheets are never touched.
import { getTestReset, runTestReset } from './api.js';
import { esc } from './concessionsUi.js';

const fresh = () => ({ enabled: false, concessions: false, raffle: false, step: 0, busy: false, error: '', done: '' });
const S = fresh();
const token = () => { try { return sessionStorage.getItem('adminAuthToken'); } catch (e) { return null; } };
const card = () => document.getElementById('danger-card');
const body = () => document.getElementById('danger-body');

export function resetDanger() { Object.assign(S, fresh()); const c = card(); if (c) c.classList.add('hidden'); const el = body(); if (el) el.innerHTML = ''; }

function what() { return [S.concessions && 'CONCESSIONS', S.raffle && 'RAFFLE'].filter(Boolean).join(' and '); }

function html() {
    const chk = (k, label) => `<label class="flex items-center gap-2 text-[14px] text-white/85"><input type="checkbox" data-dk="${k}" ${S[k] ? 'checked' : ''} ${S.busy ? 'disabled' : ''} class="h-5 w-5"> ${label}</label>`;
    let action;
    if (S.step === 0) action = `<button data-da="start" ${S.concessions || S.raffle ? '' : 'disabled'} class="h-12 w-full rounded-xl border border-red-400/60 bg-red-600/20 px-4 text-[13px] font-semibold text-red-100 disabled:opacity-40">Delete selected sales…</button>`;
    else if (S.step === 1) action = `<div class="rounded-xl border border-red-400/60 bg-red-900/40 p-3 text-[13px] text-red-100">Are you sure? This will permanently erase ALL <strong>${what()}</strong> sales from the database, in every season.</div>
        <div class="mt-2 flex gap-2"><button data-da="cancel" class="h-12 flex-1 rounded-xl border border-white/20 bg-white/[.06] text-[13px] font-semibold text-white/85">Cancel</button>
        <button data-da="next" class="h-12 flex-1 rounded-xl border border-red-400/60 bg-red-600/30 text-[13px] font-semibold text-red-100">Yes, continue</button></div>`;
    else action = `<div class="rounded-xl border border-red-400 bg-red-900/60 p-3 text-[13px] font-semibold text-red-50">Are you REALLY sure? This cannot be undone. ${what()} sales will be gone for good.</div>
        <div class="mt-2 flex gap-2"><button data-da="cancel" ${S.busy ? 'disabled' : ''} class="h-12 flex-1 rounded-xl border border-white/20 bg-white/[.06] text-[13px] font-semibold text-white/85">No, cancel</button>
        <button data-da="go" ${S.busy ? 'disabled' : ''} class="h-12 flex-1 rounded-xl bg-red-600 text-[13px] font-bold text-white">${S.busy ? 'Deleting…' : 'Delete forever'}</button></div>`;
    return `<p class="text-[12px] text-red-100/80">For testing only. Permanently erases sales saved in the database (all seasons). Items, prices and seasons are kept. Google Sheets are <strong>not</strong> changed; clear those yourself. Sales still waiting on a phone will re-upload when that phone syncs.</p>
      <div class="mt-3 space-y-2">${chk('concessions', 'Concessions sales')}${chk('raffle', 'Raffle sales (database backup)')}</div>
      <div class="mt-3">${action}</div>
      ${S.error ? `<div class="mt-2 text-[12px] text-red-300">${esc(S.error)}</div>` : ''}
      ${S.done ? `<div class="mt-2 text-[12px] text-emerald-300">${esc(S.done)}</div>` : ''}`;
}

function draw() { const el = body(); if (el) el.innerHTML = html(); }

let wired = false;
export async function renderDanger() {
    const el = body(); if (!el || !App.state.isSuperAdmin) return;
    if (!wired) {
        wired = true;
        el.addEventListener('change', (e) => {
            const k = e.target.getAttribute('data-dk'); if (!k) return;
            S[k] = e.target.checked; S.step = 0; S.error = ''; S.done = ''; draw();
        });
        el.addEventListener('click', async (e) => {
            const b = e.target.closest('[data-da]'); if (!b) return;
            const a = b.getAttribute('data-da');
            if (a === 'start') { S.step = 1; S.error = ''; S.done = ''; }
            else if (a === 'next') S.step = 2;
            else if (a === 'cancel') S.step = 0;
            else if (a === 'go') {
                S.busy = true; draw();
                try {
                    const { deleted } = await runTestReset(token(), { concessions: S.concessions, raffle: S.raffle });
                    S.done = 'Deleted: ' + ['concessions', 'raffle'].filter((k) => k in deleted).map((k) => `${deleted[k]} ${k} sale${deleted[k] === 1 ? '' : 's'}`).join(', ') + '.';
                    S.concessions = false; S.raffle = false; S.error = '';
                } catch (err) { S.error = err.status === 0 ? 'Needs a connection.' : err.message; }
                S.busy = false; S.step = 0;
            }
            draw();
        });
    }
    try {
        const r = await getTestReset(token());
        S.enabled = !!(r.enabled && r.dbConfigured);
    } catch (e) { S.enabled = false; }
    const c = card(); if (c) c.classList.toggle('hidden', !S.enabled);
    if (S.enabled) draw();
}
