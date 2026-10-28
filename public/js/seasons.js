// public/js/seasons.js
// Setup card (superadmin): the current season, past seasons, and "Start a new season". Concessions and raffle
// records are stamped with the season they were made in, so a new year starts clean while history is kept.
import { getSeasons, startSeason } from './api.js';
import { esc } from './concessionsUi.js';

const S = { seasons: null, error: '', busy: false, label: '', confirming: false };
const token = () => { try { return sessionStorage.getItem('adminAuthToken'); } catch (e) { return null; } };
const body = () => document.getElementById('seasons-body');
const fmt = (t) => new Date(t).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });

export function resetSeasons() { Object.assign(S, { seasons: null, error: '', busy: false, label: '', confirming: false }); const el = body(); if (el) el.innerHTML = ''; }

function html() {
    if (S.error && !S.seasons) return `<div class="text-[13px] text-white/70">${esc(S.error)} <button data-sa="reload" class="ml-1 font-semibold underline">Try again</button></div>`;
    if (!S.seasons) return '<div class="text-[13px] text-white/50">Loading…</div>';
    const cur = S.seasons.find((s) => s.current) || S.seasons[0];
    const next = String((parseInt(cur.label, 10) || new Date().getFullYear()) + 1);
    return `<div class="text-[13px] text-white/80">Current season: <strong class="text-white">${esc(cur.label)}</strong> <span class="text-white/45">(started ${esc(fmt(cur.createdAt))})</span></div>
      ${S.seasons.length > 1 ? `<div class="mt-1 text-[12px] text-white/45">Earlier: ${S.seasons.filter((s) => !s.current).map((s) => esc(s.label)).join(', ')}</div>` : ''}
      <div class="mt-3 flex gap-2"><input data-sf="label" type="text" placeholder="New season name, e.g. ${esc(next)}" value="${esc(S.label)}" class="field-dark min-w-0 flex-1" aria-label="New season name">
        <button data-sa="start" ${S.busy ? 'disabled' : ''} class="h-12 flex-none rounded-xl border border-white/20 bg-white/[.06] px-4 text-[13px] font-semibold text-white/85">${S.confirming ? 'Tap again to confirm' : 'Start season'}</button></div>
      ${S.error ? `<div class="mt-2 text-[12px] text-red-300">${esc(S.error)}</div>` : ''}
      <div class="mt-2 text-[11px] text-white/45">New concession sales and raffle backups go into the new season; Sell/History/Report start empty. Nothing is deleted. Raffle tickets themselves still live in the raffle sheet, so start a fresh Sales tab or sheet there too.</div>`;
}

async function load() {
    try { S.seasons = (await getSeasons(token())).seasons; S.error = ''; } catch (e) { S.error = e.status === 0 ? 'Needs a connection.' : e.message; }
    draw();
}
function draw() { const el = body(); if (el) el.innerHTML = html(); }

let wired = false;
export function renderSeasons() {
    const el = body(); if (!el) return;
    if (!wired) {
        wired = true;
        el.addEventListener('input', (e) => { if (e.target.getAttribute('data-sf') === 'label') { S.label = e.target.value; S.confirming = false; } });
        el.addEventListener('click', async (e) => {
            const b = e.target.closest('[data-sa]'); if (!b) return;
            if (b.getAttribute('data-sa') === 'reload') { load(); return; }
            if (!S.label.trim()) { S.error = 'Give the new season a name.'; draw(); return; }
            if (!S.confirming) { S.confirming = true; S.error = ''; draw(); return; }
            S.busy = true; draw();
            try { S.seasons = (await startSeason(token(), S.label)).seasons; S.label = ''; S.error = ''; }
            catch (err) { S.error = err.status === 0 ? 'Needs a connection.' : err.message; }
            S.busy = false; S.confirming = false; draw();
        });
    }
    if (App.state.isSuperAdmin) { draw(); load(); }
}
