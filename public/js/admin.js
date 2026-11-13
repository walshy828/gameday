// Avoid importing from main.js (circular). Use the api wrapper directly.
import { validateAdmin, getDiscrepancies, getMatchHistory, dismissDiscrepancy as dismissDiscrepancyApi, saveMatchResult as apiSaveMatchResult, sendSessionHeartbeat, endSession as apiEndSession, runSheetSync, getSheetSyncConfig } from './api.js';
import {
    getFilterableTeamName, parseRoundTime,
    getRoundOrder, getRosterTeams, getByeTeams,
    isReported as isReportedOfficial
} from './schedule.js';
import { switchView, enterApp, openConcessionsFromGate } from './navigation.js';
import { resetRoster } from './roster.js';
import { resetRaffle } from './raffle.js';
import { resetRaffleBackup } from './raffleBackup.js';
import { resetConcessions, unsyncedCount } from './concessions.js';
import { saveAuth, clearAuth, loadAuth } from './concessionsStore.js';
import { resetSeasons } from './seasons.js';
import { resetDanger } from './danger.js';
import { resetDivisionData } from './divisionData.js';
import { renderMyTeam } from './myTeam.js';
import { getSocket } from './socketClient.js';
import { isUrgentDiscrepancy, isPlayoffMatch, isPlayoffGame } from './discrepancy.js';
import { toast } from './concessionsUi.js';
import { ensureCourtReadyWatch, onMatchSaved as courtReadyOnSave, render as renderCourtReady, resetCourtReady, followCourt as courtReadyFollow, courtStatusOf } from './courtReady.js';
import { ensureCourtIssueWatch, stopCourtIssues, render as renderCourtIssues } from './courtIssues.js';

// --- Edit history (audit trail) ---------------------------------------------
// Every submission for a match (who, what, when, and whether it was also set as
// official), read on demand from GET /api/matchHistory only when someone expands
// it, so it costs nothing in the normal report flow.
const historyCache = new Map(); // "division|index" -> { at, items } | { loading } | { error }
const HISTORY_TTL_MS = 15000;
const openHistory = new Set();  // Needs-review items whose history is expanded

const historyKey = (division, index) => `${division}|${index}`;

async function loadMatchHistory(division, index, force = false) {
    const key = historyKey(division, index);
    const hit = historyCache.get(key);
    if (!force && hit && hit.items && Date.now() - hit.at < HISTORY_TTL_MS) return hit;
    const authToken = sessionStorage.getItem('adminAuthToken');
    historyCache.set(key, { loading: true, items: hit?.items });
    try {
        const res = await getMatchHistory(authToken, division, index);
        if (!res.success) throw new Error(res.error || 'failed');
        const entry = { at: Date.now(), items: res.items || [] };
        historyCache.set(key, entry);
        return entry;
    } catch (e) {
        const entry = { error: 'Could not load the edit history.' };
        historyCache.set(key, entry);
        return entry;
    }
}

function historyResult(h) {
    const w = (h.winner || '').toString().trim();
    if (!w || w === '—') return 'No winner (cleared)';
    if (w === 'tie') return 'Tie';
    const n = h.playersRemaining;
    return `${w}${n !== '' && n !== null && n !== undefined ? ` · ${n} left` : ''}`;
}

function historyTime(iso) {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return '—';
    const sameDay = d.toDateString() === new Date().toDateString();
    return d.toLocaleString(undefined, sameDay
        ? { hour: 'numeric', minute: '2-digit', second: '2-digit' }
        : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** The timeline markup for a cache entry (oldest first). */
function historyListHtml(entry) {
    if (!entry || (entry.loading && !entry.items)) return '<div class="text-[11px] text-white/50">Loading…</div>';
    if (entry.error) return `<div class="text-[11px]" style="color:var(--gold-l)">${esc(entry.error)}</div>`;
    const items = entry.items || [];
    if (!items.length) return '<div class="text-[11px] text-white/50">No submissions recorded for this game yet.</div>';
    return `<ol class="grid gap-1">${items.map((h, i) => {
        const prev = items[i - 1];
        const changed = prev && historyResult(prev) !== historyResult(h);
        const tag = i === 0 ? 'Reported' : changed ? 'Changed' : h.official ? 'Made official' : 'Re-submitted';
        return `
        <li class="rounded-xl px-2.5 py-1.5" style="background:rgba(255,255,255,.04)">
            <div class="flex flex-wrap items-baseline gap-x-1.5 text-[11px]">
                <span class="tabular-nums text-white/55">${esc(historyTime(h.at))}</span>
                <span class="font-semibold text-white/85">${esc(h.name || 'Unknown')}</span>
                <span class="text-white/45">${tag}</span>
                ${h.official ? '<span class="rounded-full px-1.5 text-[10px] font-semibold" style="background:rgba(52,168,83,.18);color:var(--ok)">OFFICIAL</span>' : ''}
            </div>
            <div class="text-[11.5px]" style="color:${changed ? 'var(--gold-l)' : 'rgba(255,255,255,.78)'}">${esc(historyResult(h))}</div>
            ${h.notes ? `<div class="text-[11px] italic text-white/50">“${esc(h.notes)}”</div>` : ''}
        </li>`;
    }).join('')}</ol>`;
}

/** Match entry modal: a collapsed "Edit history" link under the official toggle. */
function setupModalHistory(game) {
    const wrap = document.getElementById('modal-history-wrap');
    if (!wrap) return;
    const reported = !!((game.adminWinner || '').trim() || (game.winner || '').trim() || game.lastUpdated || game.history);
    wrap.classList.toggle('hidden', !reported);
    const list = document.getElementById('modal-history-list');
    const btn = document.getElementById('modal-history-toggle');
    list.classList.add('hidden');
    list.innerHTML = '';
    btn.setAttribute('aria-expanded', 'false');
    btn.querySelector('[data-caret]').textContent = '▸';
    const division = App.config.currentSheetName;
    const index = game.firebaseIndex;
    btn.onclick = async () => {
        const open = list.classList.toggle('hidden') === false;
        btn.setAttribute('aria-expanded', String(open));
        btn.querySelector('[data-caret]').textContent = open ? '▾' : '▸';
        if (!open) return;
        list.innerHTML = historyListHtml(historyCache.get(historyKey(division, index)) || { loading: true });
        const entry = await loadMatchHistory(division, index, true);
        // Still the same game and still open?
        if (App.data.allScheduleData[App.admin.currentGameIndex] !== game || list.classList.contains('hidden')) return;
        list.innerHTML = historyListHtml(entry);
    };
}

async function toggleDiscrepancyHistory(key) {
    const d = (App.data.discrepancies || []).find(x => x.key === key);
    if (!d) return;
    if (openHistory.has(key)) { openHistory.delete(key); renderAdminMatchEntryViewImpl(); return; }
    openHistory.add(key);
    renderAdminMatchEntryViewImpl();
    await loadMatchHistory(d.division, d.firebaseIndex, true);
    if (openHistory.has(key)) renderAdminMatchEntryViewImpl();
}

// --- Result discrepancies (superadmin) -------------------------------------
// A referee-submitted result that differs from the official one. The server
// (server/discrepancies.js) scans every division and keeps dismissals shared
// between all superadmins; the client just mirrors its list in
// App.data.discrepancies and re-fetches whenever something might have changed.

const DISC_PREF_KEY = 'discrepancyAlertPref';
const DISC_POLL_MS = 30000;
let discWatching = false;

/** Per-browser alert level: 'dot' (default; tab dot only) | 'full' (adds gate badge + row chips) | 'off'. */
function getDiscrepancyPref() {
    try {
        const v = localStorage.getItem(DISC_PREF_KEY);
        return v === 'full' || v === 'off' ? v : 'dot';
    } catch { return 'dot'; }
}

function setDiscrepancyPref(value) {
    try { localStorage.setItem(DISC_PREF_KEY, value); } catch { /* storage unavailable */ }
    updateDiscrepancyBadge();
    renderAdminMatchEntryViewImpl();
}

function getOpenDiscrepancies() {
    if (!App.state.isSuperAdmin || getDiscrepancyPref() === 'off') return [];
    return Array.isArray(App.data.discrepancies) ? App.data.discrepancies : [];
}

const sameIndex = (a, b) => String(a) === String(b);
const CONFIRM_WINDOW_MS = 4000;
let pendingConfirm = null; // { key, act, timer } — the armed "click again to confirm" button

function clearPendingConfirm(rerender = true) {
    if (!pendingConfirm) return;
    clearTimeout(pendingConfirm.timer);
    pendingConfirm = null;
    if (rerender) renderAdminMatchEntryViewImpl();
}

const escAttr = v => esc(v).replace(/"/g, '&quot;');

/** One delegated handler for the panel buttons and the per-row chips (keys may hold any division name). */
function wireDiscrepancyActions(listEl) {
    if (listEl.dataset.discWired) return;
    listEl.dataset.discWired = '1';
    listEl.addEventListener('click', e => {
        if (e.target.closest('[data-passive-toggle]')) return togglePassiveOpen();
        const btn = e.target.closest('[data-act]');
        const holder = btn && btn.closest('[data-disc-key]');
        if (!btn || !holder) return;
        const key = holder.dataset.discKey;
        const act = btn.dataset.act;
        if (act === 'edit') return reviewDiscrepancy(key);
        if (act === 'history') return toggleDiscrepancyHistory(key);
        // Use reported / Keep official change what the manager sees as the
        // result, so they take a second click on the same button (inline,
        // no browser dialog). It disarms itself after a few seconds.
        if (pendingConfirm && pendingConfirm.key === key && pendingConfirm.act === act) {
            clearPendingConfirm();
            return act === 'use' ? useReportedResult(key) : dismissDiscrepancy(key);
        }
        clearPendingConfirm(false);
        pendingConfirm = { key, act, timer: setTimeout(clearPendingConfirm, CONFIRM_WINDOW_MS) };
        renderAdminMatchEntryViewImpl();
    });
}

/** Open item for a game in the current division, if any (drives the row chip). */
function discrepancyFor(game) {
    return getOpenDiscrepancies().find(d => d.division === App.config.currentSheetName && sameIndex(d.firebaseIndex, game.firebaseIndex));
}

/** Amber dot on the ADMIN tab and a count on the gate's Admin Panel. Never moves layout. */
function updateDiscrepancyBadge() {
    const n = getOpenDiscrepancies().length;
    const pref = getDiscrepancyPref();
    const dot = document.getElementById('discrepancy-dot');
    if (dot) {
        const urgent = getOpenDiscrepancies().filter(isUrgentDiscrepancy).length;
        dot.classList.toggle('hidden', n === 0);
        dot.classList.toggle('urgent', urgent > 0);
        dot.title = urgent ? `Playoff winner changed — ${urgent} to settle` : n ? `${n} result${n === 1 ? '' : 's'} need review` : '';
    }
    const gate = document.getElementById('gate-discrepancy-btn');
    if (gate) {
        const show = n > 0 && pref === 'full';
        gate.classList.toggle('hidden', !show);
        const count = document.getElementById('gate-discrepancy-count');
        if (count) count.textContent = String(n);
    }
}

async function refreshDiscrepancies() {
    const authToken = sessionStorage.getItem('adminAuthToken');
    if (!App.state.isSuperAdmin || !authToken) {
        App.data.discrepancies = [];
        updateDiscrepancyBadge();
        return;
    }
    try {
        const res = await getDiscrepancies(authToken);
        App.data.discrepancies = res.success ? res.items : [];
    } catch (e) {
        console.error('Discrepancy refresh failed:', e);
        return; // keep the last known list rather than flashing it empty
    }
    updateDiscrepancyBadge();
    if (App.state.currentView === 'admin-entry') renderAdminMatchEntryViewImpl();
}

/** Starts (once) the live refresh: socket nudges + a slow poll as a fallback. */
function startDiscrepancyWatch() {
    if (!App.state.isSuperAdmin) return;
    refreshDiscrepancies();
    if (discWatching) return;
    discWatching = true;
    try {
        const socket = getSocket();
        ['discrepancyUpdate', 'syncStatusUpdate'].forEach(evt => socket.on(evt, refreshDiscrepancies));
        socket.on('connect', refreshDiscrepancies);
    } catch (e) {
        console.warn('Discrepancy live updates unavailable, polling only:', e.message);
    }
    setInterval(() => { if (!document.hidden) refreshDiscrepancies(); }, DISC_POLL_MS);
}

async function dismissDiscrepancy(key) {
    const item = (App.data.discrepancies || []).find(d => d.key === key);
    const authToken = sessionStorage.getItem('adminAuthToken');
    if (!item || !authToken) return;
    try {
        const res = await dismissDiscrepancyApi(authToken, item.division, item.firebaseIndex, App.state.reporterName || '');
        if (res.success) App.data.discrepancies = res.items;
    } catch (e) {
        console.error('Dismiss failed:', e);
        showStatus(`Could not dismiss: ${e.message}`, true);
        setTimeout(() => showStatus(null), 6000);
        return;
    }
    updateDiscrepancyBadge();
    renderAdminMatchEntryViewImpl();
}

/** Makes the referee-reported result the official one (same path as the modal's "submit as official"). */
async function useReportedResult(key) {
    const g = (App.data.discrepancies || []).find(d => d.key === key);
    const authToken = sessionStorage.getItem('adminAuthToken');
    if (!g || !authToken) return;
    try {
        const result = await apiSaveMatchResult(authToken, {
            sheetName: g.division,
            rowIndex: g.rowIndex,
            firebaseIndex: g.firebaseIndex,
            team1: g.team1,
            team2: g.team2,
            winner: g.adminWinner,
            playersRemaining: parseInt(g.adminPlayersRemaining) || 0,
            adminName: App.state.reporterName || g.adminName || 'Tournament manager',
            notes: `Official set from result reported by ${g.adminName || 'referee'}`,
            setOfficial: true
        });
        if (!result.success) throw new Error(result.error || 'Server reported failure.');
        await loadData(App.config.currentSheetName);
        await refreshDiscrepancies();
    } catch (e) {
        console.error('Use reported failed:', e);
        showStatus(`Could not update official result: ${e.message}`, true);
        setTimeout(() => showStatus(null), 6000);
    }
}

/** Edit opens the match modal for this division, or switches to the item's division first. */
async function reviewDiscrepancy(key) {
    const d = (App.data.discrepancies || []).find(x => x.key === key);
    if (!d) return;
    if (d.division !== App.config.currentSheetName) {
        await enterApp(d.division);
        switchView('admin-entry');
    }
    const idx = (App.data.allScheduleData || []).findIndex(g => sameIndex(g.firebaseIndex, d.firebaseIndex));
    if (idx >= 0) showMatchEntryModal(idx);
}

/** Gate shortcut: jump into the first division with something to review. */
async function openDiscrepancyReview() {
    const first = getOpenDiscrepancies()[0];
    if (!first) return;
    await enterApp(first.division);
    switchView('admin-entry');
}

// Two places on the Admin page, by how soon the MC must act:
// - urgent (#discrepancy-urgent, very top): a playoff game whose reported
//   winner differs from the official one. The bracket advances the official
//   winner, so this must be settled before the next round is called.
// - passive (#discrepancy-passive, under the court board, above the filters):
//   everything else (pool play, playoff players-left only). One line,
//   collapsed by default; it can be fixed as later rounds go on.
const DISC_PASSIVE_OPEN_KEY = 'discrepancyPassiveOpen';
let passiveOpenMemory = null; // fallback when localStorage is blocked

function passiveOpen() {
    if (passiveOpenMemory !== null) return passiveOpenMemory;
    try { return localStorage.getItem(DISC_PASSIVE_OPEN_KEY) === '1'; } catch { return false; }
}

function togglePassiveOpen() {
    passiveOpenMemory = !passiveOpen();
    try { localStorage.setItem(DISC_PASSIVE_OPEN_KEY, passiveOpenMemory ? '1' : '0'); } catch { /* per-session only */ }
    renderDiscrepancyPanels();
}

function discrepancyItemHtml(g, urgent) {
    const other = g.division !== App.config.currentSheetName;
    const fmt = (w, n) => `${esc((w || '—').toString().trim() || '—')}${!urgent && n !== undefined && n !== null && n !== '' ? ` · ${esc(String(n))} left` : ''}`;
    const armed = act => !!pendingConfirm && pendingConfirm.key === g.key && pendingConfirm.act === act;
    const btn = 'rounded-[13px] px-3 py-2 text-[11px] font-semibold leading-none';
    const ghost = 'background:rgba(255,255,255,.08);color:rgba(255,255,255,.85);border:1px solid rgba(255,255,255,.14)';
    const confirmStyle = 'background:var(--ok);color:#06210F;border:0';
    const primary = urgent
        ? 'background:linear-gradient(135deg,#e2604a 0%,var(--warn) 100%);color:#fff;border:0'
        : 'background:linear-gradient(135deg,var(--gold) 0%,var(--gold-d) 100%);color:#2A1B08;border:0';
    const label = [other ? esc(g.division) : '', isPlayoffMatch(g) ? esc(g.match) : '', esc(g.roundTime), `C${esc(g.court || '?')}`].filter(Boolean).join(' · ');
    return `
        <div class="rounded-2xl px-3 py-2.5" style="background:rgba(255,255,255,.05)" data-disc-key="${escAttr(g.key)}">
            <div class="text-[11px] font-semibold" style="color:rgba(255,255,255,.86)">${label} · ${esc(g.team1)} vs ${esc(g.team2)}</div>
            ${urgent ? `
            <div class="mt-1 text-[12px] font-semibold" style="color:var(--ok)">Official (bracket advances): ${fmt(g.winner)}</div>
            <div class="text-[12px] font-semibold" style="color:#FF9C8A">${esc(g.adminName || 'Referee')} now reports: ${fmt(g.adminWinner)}</div>`
            : `
            <div class="mt-1 text-[11px]" style="color:var(--ok)">Official: ${fmt(g.winner, g.playersRemaining)}</div>
            <div class="text-[11px]" style="color:var(--gold-l)">Reported by ${esc(g.adminName || '—')}: ${fmt(g.adminWinner, g.adminPlayersRemaining)}</div>`}
            <div class="mt-2 flex flex-wrap gap-1.5">
                <button data-act="use" class="${btn}" style="${armed('use') ? confirmStyle : primary}">${armed('use') ? 'Tap again to confirm' : (urgent ? `Make ${esc((g.adminWinner || '').toString().trim())} official` : 'Use reported')}</button>
                <button data-act="edit" class="${btn}" style="${ghost}">${other ? 'Open division' : 'Edit'}</button>
                <button data-act="keep" class="${btn}" style="${armed('keep') ? confirmStyle : ghost}">${armed('keep') ? 'Tap again to confirm' : 'Keep official'}</button>
                <button data-act="history" aria-expanded="${openHistory.has(g.key)}" class="${btn}" style="background:transparent;color:rgba(255,255,255,.7);border:1px dashed rgba(255,255,255,.2)">Edit history ${openHistory.has(g.key) ? '▾' : '▸'}</button>
            </div>
            ${openHistory.has(g.key) ? `<div class="mt-2">${historyListHtml(historyCache.get(historyKey(g.division, g.firebaseIndex)) || { loading: true })}</div>` : ''}
        </div>`;
}

/** Renders both review areas (superadmin only; empty and hidden otherwise). */
function renderDiscrepancyPanels() {
    const urgentEl = document.getElementById('discrepancy-urgent');
    const passiveEl = document.getElementById('discrepancy-passive');
    if (!urgentEl || !passiveEl) return;
    wireDiscrepancyActions(urgentEl);
    wireDiscrepancyActions(passiveEl);
    const open = App.state.isAdmin ? getOpenDiscrepancies() : [];
    const urgent = open.filter(isUrgentDiscrepancy);
    const passive = open.filter(g => !isUrgentDiscrepancy(g));

    urgentEl.classList.toggle('hidden', urgent.length === 0);
    urgentEl.innerHTML = urgent.length ? `
        <section role="alert" class="rounded-[26px] border-2 p-3.5" style="background:rgba(217,80,60,.14);border-color:var(--warn)">
            <div class="text-[12px] font-bold tracking-[.06em]" style="color:#FF9C8A">⚠ PLAYOFF WINNER CHANGED${urgent.length > 1 ? ` (${urgent.length})` : ''}</div>
            <div class="mt-0.5 text-[11px] leading-[1.4]" style="color:rgba(255,255,255,.7)">The referee changed the winner after it went official. Settle it before calling the next playoff round.</div>
            <div class="mt-2 grid gap-[5px]">${urgent.map(g => discrepancyItemHtml(g, true)).join('')}</div>
        </section>` : '';

    passiveEl.classList.toggle('hidden', passive.length === 0);
    if (!passive.length) { passiveEl.innerHTML = ''; return; }
    const expanded = passiveOpen();
    passiveEl.innerHTML = `
        <section class="rounded-[22px] border px-3.5 py-2.5" style="background:rgba(224,184,99,.05);border-color:rgba(224,184,99,.3)">
            <button type="button" data-passive-toggle aria-expanded="${expanded}" class="flex w-full items-center justify-between gap-2 text-left">
                <span class="text-[11px] font-semibold tracking-[.08em]" style="color:var(--gold-l)">NEEDS REVIEW (${passive.length})</span>
                <span class="text-[11px] text-white/55">${expanded ? 'Hide ▾' : 'Show ▸'}</span>
            </button>
            ${expanded ? `<div class="mt-2 grid gap-[5px]">${passive.map(g => discrepancyItemHtml(g, false)).join('')}</div>` : ''}
        </section>`;
}

/** A game counts as reported for admin purposes once it has an admin-submitted or official result. */
// --- Bye footers: shown or collapsed ------------------------------------------
// Court managers mostly look at one court, where the "on bye" chips just eat
// screen space, so they start collapsed; the tournament manager starts with
// them shown. One tap flips every round, remembered per browser and per role.

function byePrefKey() {
    return App.state.isSuperAdmin ? 'adminByesShown:superadmin' : 'adminByesShown:court';
}

const byeMemory = {}; // fallback when localStorage is blocked

function byesShown() {
    if (byePrefKey() in byeMemory) return byeMemory[byePrefKey()];
    try {
        const v = localStorage.getItem(byePrefKey());
        if (v === '1') return true;
        if (v === '0') return false;
    } catch (e) { /* storage blocked: fall back to the role default */ }
    return !!App.state.isSuperAdmin;
}

function wireByeToggle(listEl) {
    if (listEl.dataset.byeWired) return;
    listEl.dataset.byeWired = '1';
    listEl.addEventListener('click', (ev) => {
        if (!ev.target.closest('[data-bye-toggle]')) return;
        const next = !byesShown();
        byeMemory[byePrefKey()] = next;
        try { localStorage.setItem(byePrefKey(), next ? '1' : '0'); } catch (e) { /* per-session only */ }
        renderAdminMatchEntryViewImpl();
    });
}

function isAdminReported(game) {
    const reportedByAdmin = !!(game.adminWinner && game.adminWinner.trim() !== '' && game.adminWinner.trim() !== 'TBA' && game.adminWinner.trim() !== '—');
    return isReportedOfficial(game) || reportedByAdmin;
}

// Core renderer (kept private) — we'll expose a debounced public wrapper below
function renderAdminMatchEntryViewImpl() {
    renderDiscrepancyPanels();
    if (!App.state.isAdmin) {
        document.getElementById('admin-match-list').innerHTML = '<p class="py-4 text-center text-sm text-white/45">Please sign in to access match entry.</p>';
        return;
    }

    const teamSelect = document.getElementById('admin-team-select');
    const courtSelect = document.getElementById('admin-court-select');
    const subDivisionSelect = document.getElementById('admin-sub-division-select');
    const hidePlayedToggle = document.getElementById('hide-played-toggle');
    const matchListDiv = document.getElementById('admin-match-list');
    const filterInfoDiv = document.getElementById('admin-filter-info');

    const selectedTeam = teamSelect?.value || 'all';
    const selectedCourt = courtSelect?.value || 'all';
    const selectedSubDivision = subDivisionSelect?.value || 'all';
    const isHidingPlayed = hidePlayedToggle?.checked || false;

    if (!matchListDiv) return;

    if (App.state.isSuperAdmin && (!App.data.allScheduleData || App.data.allScheduleData.length === 0)) {
        renderEmptyScheduleSyncBanner(matchListDiv);
        if (filterInfoDiv) filterInfoDiv.classList.add('hidden');
        return;
    }

    // Diagnostic logging to help identify why nothing is rendering
    try {
        console.log('updateAdminMatchEntryView called', {
            isAdmin: App.state.isAdmin,
            isSuperAdmin: App.state.isSuperAdmin,
            totalMatches: Array.isArray(App.data.allScheduleData) ? App.data.allScheduleData.length : 0,
            selectedTeam,
            selectedCourt,
            isHidingPlayed,
        });
    } catch (e) {
        console.log('Diagnostic log failed:', e);
    }

    // 'Hide games already reported' hides a whole round only once every game
    // in it has an admin-submitted or official result — a round with even
    // one game still outstanding stays fully visible (all its courts), so
    // the tournament manager can see the whole round in play, not just the
    // one straggler game. Computed off the full, unfiltered schedule so a
    // team/court filter can't make a round look "done" prematurely.
    const roundsFullyReported = new Set();
    {
        const byRound = new Map();
        App.data.allScheduleData.forEach(game => {
            const key = game.roundTime || 'TBD';
            if (!byRound.has(key)) byRound.set(key, []);
            byRound.get(key).push(game);
        });
        byRound.forEach((games, key) => {
            if (games.every(isAdminReported)) roundsFullyReported.add(key);
        });
    }

    // 1. Filter and Sort logic (remains the same as your part 3)
    let filteredSchedule = App.data.allScheduleData.filter(game => {
        const teamMatch = selectedTeam === 'all' ||
            getFilterableTeamName(game.team1) === selectedTeam ||
            getFilterableTeamName(game.team2) === selectedTeam;

        const courtMatch = selectedCourt === 'all' || (game.court && game.court.trim() === selectedCourt);

        const subDivisionMatch = selectedSubDivision === 'all' || game.subDivision === selectedSubDivision;

        const playedMatch = !isHidingPlayed || !roundsFullyReported.has(game.roundTime || 'TBD');

        return teamMatch && courtMatch && subDivisionMatch && playedMatch;
    });

    filteredSchedule.sort((a, b) => {
        const timeA = parseRoundTime(a.roundTime);
        const timeB = parseRoundTime(b.roundTime);

        // Case 1: Both are times
        if (timeA.isTime && timeB.isTime) {
            // Directly compare the chronological sort values (e.g., "09:05")
            return timeA.sortValue.localeCompare(timeB.sortValue);
        }

        // Case 2: Time sorts before text (P rounds)
        if (timeA.isTime && !timeB.isTime) {
            return -1; // A (time) comes before B (text)
        }
        if (!timeA.isTime && timeB.isTime) {
            return 1; // A (text) comes after B (time)
        }

        // Case 3: Both are text (P rounds or other non-time text)
        // Alpha sort ascending
        return timeA.sortValue.localeCompare(timeB.sortValue);
    });

    const groupedMatches = filteredSchedule.reduce((acc, game) => {
        const round = game.roundTime || 'TBD/Unscheduled';
        if (!acc[round]) {
            acc[round] = [];
        }
        acc[round].push(game);
        return acc;
    }, {});

    ensureCourtIssueWatch();
    renderCourtIssues();
    ensureCourtReadyWatch();
    renderCourtReady();

    const gamesHeading = document.getElementById('admin-games-heading');
    if (gamesHeading) gamesHeading.textContent = selectedCourt === 'all' ? 'All games' : `Court ${selectedCourt} games`;

    matchListDiv.innerHTML = '';
    wireDiscrepancyActions(matchListDiv);
    updateDiscrepancyBadge();

    // ... (Filter Info rendering logic remains the same) ...

    // Title is generic for every admin tier — the court filter is a view
    // choice, so the court only appears in the identity line below.
    const titleEl = document.getElementById('admin-title');
    if (titleEl) titleEl.textContent = 'Tournament admin';
    const whoEl = document.getElementById('admin-who');
    if (whoEl) {
        const name = App.state.reporterName || 'Staff';
        if (App.state.isSuperAdmin) {
            whoEl.textContent = `${name} · tournament manager · all courts`;
        } else {
            whoEl.innerHTML = `${esc(name)} · court manager · `
                + `<button type="button" onclick="openCourtSwitcher()" aria-label="Change your court" `
                + `class="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 align-middle text-[11px] font-bold leading-none" `
                + `style="border-color:rgba(224,184,99,.55);background:rgba(224,184,99,.12);color:var(--gold-l)">`
                + `Court ${esc(App.state.selectedCourt || '?')} <span aria-hidden="true">▾</span></button>`
                + ` · ${esc(App.config.currentSheetName)}`;
        }
    }

    let infoText = `Showing <span class="text-gold-l">${esc(App.config.currentSheetName)}</span>`;
    if (selectedTeam !== 'all') infoText += ` · team <span class="text-gold-l">${esc(selectedTeam)}</span>`;
    if (selectedCourt !== 'all') infoText += ` · court <span class="text-gold-l">${esc(selectedCourt)}</span>`;
    if (isHidingPlayed) infoText += ` · <span class="text-gold-l">reported games hidden</span>`;

    filterInfoDiv.classList.remove('hidden');
    filterInfoDiv.innerHTML = infoText;

    // Admin's own "live round": unlike the public page (official results
    // only), a round stays "ON COURT NOW" here until every game in it has
    // *either* an admin-submitted or an official result — so the tournament
    // manager can see a court is done as soon as it's reported, without
    // waiting on the official sheet sync.
    const roundOrder = getRoundOrder();
    const liveKey = roundOrder.find(key =>
        App.data.allScheduleData.some(g => (g.roundTime || 'TBD') === key && !isAdminReported(g))
    );
    const liveIndex = liveKey === undefined ? roundOrder.length : roundOrder.indexOf(liveKey);

    // Bye footers (below) are only meaningful across the whole roster — with a
    // single team selected the round already holds just that team's game.
    const showByeFooter = selectedTeam === 'all';
    const byesOpen = byesShown();
    wireByeToggle(matchListDiv);
    const allTeams = showByeFooter ? getRosterTeams() : null;

    const dim = 'rgba(255,255,255,.38)';
    const strong = 'rgba(255,255,255,.86)';

    const fragment = document.createDocumentFragment(); //for batching updates
    Object.entries(groupedMatches).forEach(([roundTime, games]) => {
        const isLiveRound = roundTime === liveKey;
        const isDone = roundOrder.indexOf(roundTime) < liveIndex;

        // Same dark round card the public games page uses: a gold border +
        // "ON COURT NOW" chip for the live round, flat glass otherwise.
        const card = document.createElement('section');
        card.className = 'rounded-[26px] border p-3.5';
        card.style.background = isLiveRound ? 'rgba(255,255,255,.075)' : 'rgba(255,255,255,.055)';
        card.style.borderColor = isLiveRound ? 'var(--gold)' : 'rgba(255,255,255,.1)';
        card.style.boxShadow = isLiveRound
            ? '0 0 0 1px rgba(224,184,99,.35), 0 14px 36px rgba(0,0,0,.26)'
            : '0 14px 36px rgba(0,0,0,.26)';

        const chipStyle = isLiveRound
            ? 'background:linear-gradient(135deg,var(--gold) 0%,var(--gold-d) 100%);color:#2A1B08'
            : 'background:rgba(255,255,255,.08);color:rgba(255,255,255,.7)';

        const head = document.createElement('div');
        head.className = 'flex items-center gap-2.5';
        head.innerHTML = `
            <span class="rounded-full px-2.5 py-1.5 text-[11px] font-semibold leading-none tracking-[.02em]" style="${chipStyle}">${esc(roundTime)}</span>
            <span class="text-[9px] font-semibold leading-none tracking-[.12em]" style="color:${isLiveRound ? 'var(--gold)' : 'rgba(255,255,255,.4)'}">${isLiveRound ? 'ON COURT NOW' : isDone ? 'FINAL' : 'UPCOMING'}</span>
        `;
        card.appendChild(head);

        const rows = document.createElement('div');
        rows.className = 'mt-2.5 grid gap-[5px]';

        games.forEach(game => {
            // Find the original index
            const gameIndex = App.data.allScheduleData.findIndex(g =>
                g.roundTime === game.roundTime && g.court === game.court && g.team1 === game.team1 && g.team2 === game.team2
            );

            const row = document.createElement('div');
            row.id = `game-entry-${gameIndex}`;
            row.className = 'rounded-2xl px-3 py-2.5';
            row.style.background = 'rgba(255,255,255,.05)';

            const disc = getDiscrepancyPref() === 'full' ? discrepancyFor(game) : null;
            const discChip = disc
                ? `<span data-disc-key="${escAttr(disc.key)}"><button data-act="edit" title="Reported result differs from official" class="rounded-full px-1.5 py-0.5" style="background:rgba(224,184,99,.18);color:var(--gold-l);border:1px solid rgba(224,184,99,.45)">≠ review</button></span>`
                : '';
            const officialIsCompleted = isReportedOfficial(game);
            const winnerName = game.winner ? game.winner.trim() : null;
            const reportedByAdmin = !!(game.adminWinner && game.adminWinner.trim() !== '' && game.adminWinner.trim() !== '—');
            const isReported = isAdminReported(game);

            // A live-round game still awaiting a result gets the same gold
            // inset outline as an in-progress game on the public games page.
            if (isLiveRound && !isReported) {
                row.style.boxShadow = 'inset 0 0 0 1px rgba(224,184,99,.55)';
            }

            // Winner checkbox: gold + checkmark while only the admin's own
            // report has it (game.winner not yet refreshed by the sheet
            // sync); green + checkmark + players-left count once official.
            const adminWinnerVal = game.adminWinner ? game.adminWinner.trim() : '';
            const tie = App.settings.is_tie_allowed && (officialIsCompleted ? winnerName === 'tie' : adminWinnerVal === 'tie');
            const team1Name = (game.team1 || '').trim();
            const team2Name = (game.team2 || '').trim();
            const team1Official = officialIsCompleted && !tie && winnerName === team1Name;
            const team2Official = officialIsCompleted && !tie && winnerName === team2Name;
            const team1AdminOnly = !officialIsCompleted && !tie && reportedByAdmin && adminWinnerVal === team1Name;
            const team2AdminOnly = !officialIsCompleted && !tie && reportedByAdmin && adminWinnerVal === team2Name;
            const count = officialIsCompleted ? game.playersRemaining : game.adminPlayersRemaining;
            const tieChip = tie
                ? `<span class="rounded-full px-1.5 py-0.5" style="background:${officialIsCompleted ? 'rgba(52,168,83,.18)' : 'rgba(224,184,99,.18)'};color:${officialIsCompleted ? 'var(--ok)' : 'var(--gold-l)'}">🤝 TIE</span>`
                : '';

            // "Updated:" line replaces the old "Team won · N left · Name"
            // stamp — who reported it and when, unofficial while game.winner
            // hasn't caught up with the admin's own report yet.
            let updatedHtml = esc('');
            let updatedColor = '#E0B863';
            if (isReported) {
                const by = game.adminName || '—';
                const when = formatUpdatedTime(game.lastUpdated);
                const suffix = officialIsCompleted ? '' : '';
                // The "when" chunk carries the raw timestamp so the ticking
                // clock (below) can refresh just this text in place, without
                // a full re-render, while it's still showing a relative time.
                const whenHtml = when
                    ? ` · <span class="js-updated-when" data-last-updated="${esc(game.lastUpdated)}">${esc(when)}</span>`
                    : '';
                updatedHtml = `${esc(`Updated: ${by}`)}${whenHtml}${esc(suffix)}`;
                updatedColor = officialIsCompleted ? 'var(--ok)' : 'var(--gold-l)';
            }

            row.innerHTML = `
                <div class="flex items-center gap-2.5">
                    <span class="flex-none w-[26px] h-[26px] rounded-[9px] text-center text-[10px] font-bold leading-[26px]"
                          style="background:${isLiveRound ? 'rgba(224,184,99,.14)' : 'rgba(255,255,255,.08)'};color:${isLiveRound ? 'var(--gold-l)' : 'rgba(255,255,255,.6)'}">C${esc(game.court || '?')}</span>
                    <span class="flex-1 min-w-0 grid gap-[2px]">
                        ${adminTeamLine(game.team1, team1Official, team1AdminOnly, count, dim, strong)}
                        ${adminTeamLine(game.team2, team2Official, team2AdminOnly, count, dim, strong)}
                    </span>
                    <button onclick="showMatchEntryModal(${gameIndex})"
                            class="flex-none rounded-[13px] px-3 py-2 text-[11px] font-semibold leading-none"
                            style="${isReported ? 'background:rgba(255,255,255,.08);color:rgba(255,255,255,.85);border:1px solid rgba(255,255,255,.14)' : 'background:linear-gradient(135deg,var(--gold) 0%,var(--gold-d) 100%);color:#2A1B08;border:0'}">
                        ${isReported ? 'Edit' : 'Report'}
                    </button>
                </div>
                <div class="mt-1.5 flex items-center justify-between gap-2 pl-[34px]">
                    <span class="flex items-center gap-1.5 text-[9px] font-semibold leading-none tracking-[.08em]" style="color:${dim}">
                        ${game.match ? esc(`M${game.match}`) : ''}
                        ${game.subDivision ? `<span class="rounded-full px-1.5 py-0.5" style="background:rgba(255,255,255,.08);color:rgba(255,255,255,.6)">${esc(game.subDivision)}</span>` : ''}
                        ${tieChip}
                        ${discChip}
                    </span>
                    <span class="text-right text-[10px] font-medium leading-[1.3]" style="color:${updatedColor}">${updatedHtml}</span>
                </div>
            `;

            rows.appendChild(row);
        });

        card.appendChild(rows);

        // --- Teams sitting this round out, same as the public games page ---
        // Collapsible (see byesShown): court managers start collapsed to a
        // one-line "N teams on bye ▸", the tournament manager starts expanded.
        if (allTeams) {
            const byeTeams = getByeTeams(roundTime, allTeams);
            if (byeTeams.length) {
                const footer = document.createElement('div');
                footer.className = 'mt-2.5 border-t pt-2.5';
                footer.style.borderColor = 'rgba(255,255,255,.08)';
                const label = `${byeTeams.length} ${byeTeams.length === 1 ? 'team' : 'teams'} on bye`;
                footer.innerHTML = byesOpen
                    ? `<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <button type="button" data-bye-toggle aria-expanded="true" aria-label="Hide teams on bye"
                            class="text-[9px] font-semibold leading-none tracking-[.12em]" style="color:rgba(255,255,255,.4)">ON BYE ▾</button>
                        ${byeTeams.map(t => `
                            <span class="rounded-full px-2 py-1 text-[11px] font-medium leading-none" style="background:rgba(255,255,255,.06);color:rgba(255,255,255,.6)">${esc(t)}</span>
                        `).join('')}
                    </div>`
                    : `<button type="button" data-bye-toggle aria-expanded="false"
                        class="text-[11px] font-medium leading-none" style="color:rgba(255,255,255,.45)">${label} <span aria-hidden="true">▸</span></button>`;
                card.appendChild(footer);
            }
        }

        fragment.appendChild(card);
    });

    matchListDiv.appendChild(fragment);
}

/**
 * Shown on the Admin tab in place of the match list when a superadmin picks
 * a division that exists but has never been synced (or hasn't been synced
 * since its tab was added to the sheet). Reuses the exact same sync
 * mechanism as Settings → Sync Now (POST /api/sheetSync/run) so there's only
 * one sync code path — this is just a closer-at-hand trigger for it.
 */
function renderEmptyScheduleSyncBanner(container) {
    container.innerHTML = '';
    const banner = document.createElement('div');
    banner.className = 'rounded-2xl border p-4 text-center';
    banner.style.background = 'rgba(224,184,99,.07)';
    banner.style.borderColor = 'rgba(224,184,99,.4)';
    banner.innerHTML = `
        <p class="text-sm font-semibold" style="color:var(--gold-l)">No schedule data yet for ${esc(App.config.currentSheetName)}.</p>
        <p class="mt-1 text-xs text-white/50">Pull the latest standings and schedule from the Google Sheet to get started.</p>
    `;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mt-3 rounded-[13px] px-4 py-2 text-[12px] font-semibold leading-none';
    btn.style.background = 'linear-gradient(135deg,var(--gold) 0%,var(--gold-d) 100%)';
    btn.style.color = '#2A1B08';
    btn.textContent = '🔄 Sync from Google Sheet';
    btn.onclick = async () => {
        const authToken = sessionStorage.getItem('adminAuthToken');
        if (!authToken) return;
        btn.disabled = true;
        btn.textContent = 'Syncing…';
        try {
            const result = await runSheetSync(authToken);
            if (result.success) {
                showStatus(`Sync complete: ${result.divisions} divisions, ${result.matchesCount} matches.`, false);
                setTimeout(() => showStatus(null), 4000);
                await loadData(App.config.currentSheetName);
            } else {
                showStatus('Sync failed: ' + (result.error || 'Unknown error'), true);
                btn.disabled = false;
                btn.textContent = '🔄 Sync from Google Sheet';
            }
        } catch (e) {
            console.error('Inline sync failed', e);
            showStatus('Sync failed: ' + e.message, true);
            btn.disabled = false;
            btn.textContent = '🔄 Sync from Google Sheet';
        }
    };
    banner.appendChild(btn);
    container.appendChild(banner);
}

/**
 * One team line in the admin match list. A winning team gets a checkbox-style
 * badge: gold while only the admin's own report carries it (game.winner not
 * yet refreshed by the sheet sync), green with the players-remaining count
 * once that official result is in — otherwise the team name renders plain
 * against the dark row, same as the public games page.
 */
function adminTeamLine(name, official, adminOnly, count, dim, strong) {
    const label = esc(name || 'TBD');
    if (!official && !adminOnly) {
        return `<span class="min-w-0 truncate text-[13px] font-semibold leading-[1.4]" style="color:${strong}">${label}</span>`;
    }
    const bg = official ? 'var(--ok)' : 'var(--gold)';
    const fg = official ? '#fff' : '#2A1B08';
    const nameColor = official ? 'var(--ok)' : 'var(--gold-l)';
    return `
        <span class="flex items-center gap-1.5">
            <span class="min-w-0 truncate text-[13px] font-bold leading-[1.4]" style="color:${nameColor}">${label}</span>
            <span class="flex-none inline-flex items-center gap-1 rounded-full px-1.5 h-[15px] text-[9px] font-bold leading-[15px]" style="background:${bg};color:${fg}">✓ ${esc(count ?? 0)}</span>
        </span>
    `;
}

/**
 * "Updated" timestamp for a reported game: a relative "N min ago" while the
 * report is fresh (≤10 minutes old), otherwise the actual date/time it was
 * reported — so a stale "unofficial" result doesn't read as just-now.
 */
function formatUpdatedTime(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';

    const diffMin = Math.floor((Date.now() - then) / 60000);
    if (diffMin <= 0) return 'just now';
    if (diffMin <= 10) return `${diffMin} min ago`;

    return new Date(then).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
}

// While a report is under 5 minutes old its "Updated" stamp reads as a
// relative time ("2 min ago") that would otherwise go stale on screen until
// the next full render. Refresh just that text in place every 10s so a
// tournament manager watching the board sees it tick forward live.
if (typeof window !== 'undefined') {
    setInterval(() => {
        document.querySelectorAll('.js-updated-when[data-last-updated]').forEach(el => {
            const iso = el.dataset.lastUpdated;
            const then = new Date(iso).getTime();
            if (Number.isNaN(then)) return;
            if (Date.now() - then >= 5 * 60000) return; // 5+ min: leave the (now-static) relative/absolute text alone
            el.textContent = formatUpdatedTime(iso);
        });
    }, 10000);
}

/** Escapes a value for safe interpolation into a template-literal row. */
function esc(str) {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
}

// Simple debounce utility to coalesce rapid calls into a single render
function debounce(fn, wait = 50) {
    let timer = null;
    return function (...args) {
        // If a full data load is in progress, skip scheduling renders; the loader
        // will call `renderAdminMatchEntryNow()` once it's finished.
        if (App && App.refresh && App.refresh.isLoadingData) return;

        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            try { fn.apply(this, args); } catch (e) { console.error('Debounced render error', e); }
        }, wait);
    };
}

// Public debounced function exported/used throughout the app and referenced by inline handlers.
const updateAdminMatchEntryView = debounce(renderAdminMatchEntryViewImpl, 40);

// Immediate render helper to be called when we want to force a single render
// (for example after the initial load completes). This bypasses the debounce
// and is safe to call repeatedly.
function renderAdminMatchEntryNow() {
    try {
        renderAdminMatchEntryViewImpl();
    } catch (e) {
        console.error('Immediate render error', e);
    }
}

// Expose immediate renderer to global so other modules (main.js) can call it
if (typeof window !== 'undefined') window.renderAdminMatchEntryNow = renderAdminMatchEntryNow;
// The header's "Court N ▾" chip is inline markup, so its handler lives on window.
if (typeof window !== 'undefined') window.openCourtSwitcher = openCourtSwitcher;


/** Points the gate's Admin Panel "Google Sheet" link at the configured spreadsheet (hidden if none). */
async function loadGateSheetLink() {
    const link = document.getElementById('gate-sheet-link');
    const authToken = sessionStorage.getItem('adminAuthToken');
    if (!link || !authToken) return;
    try {
        const cfg = await getSheetSyncConfig(authToken);
        if (cfg && cfg.spreadsheetUrl) {
            link.href = cfg.spreadsheetUrl;
            link.classList.remove('hidden');
        } else {
            link.classList.add('hidden');
        }
    } catch (e) {
        console.error('Failed to load sheet link', e);
    }
}

/**
 * Shows login state on the division gate (Admin login button vs. Log out +
 * "Signed in as …") and a small signed-in badge in the app header.
 */
function updateGateAdminUI(loggedIn) {
    const btn = document.getElementById('gate-admin-btn');
    const who = document.getElementById('gate-admin-who');
    const adminPanel = document.getElementById('gate-admin-panel');
    const badge = document.getElementById('header-staff-badge');
    const badgeName = document.getElementById('header-staff-name');
    const name = App.state.reporterName || 'Staff';
    const role = App.state.isSuperAdmin ? 'Tournament manager'
        : App.state.isAdmin ? `Court manager${App.state.selectedCourt ? ' · court ' + App.state.selectedCourt : ''}`
        : App.state.isRaffle ? 'Raffle manager'
        : App.state.isConcessions ? 'Concessions'
        : 'Parent';

    if (btn) {
        btn.textContent = loggedIn ? 'Log out' : 'Admin login';
        btn.onclick = loggedIn ? logoutAdmin : showAdminLoginModal;
    }
    // Court issue flags: referees raise them, the MC is alerted on every view.
    if (loggedIn && App.state.isAdmin) ensureCourtIssueWatch(); else stopCourtIssues();
    const showPanel = !!(loggedIn && App.state.isSuperAdmin);
    if (adminPanel) adminPanel.classList.toggle('hidden', !showPanel);
    if (showPanel) loadGateSheetLink();
    if (who) {
        who.classList.toggle('hidden', !loggedIn);
        who.textContent = loggedIn ? `Signed in as ${name} · ${role}` : '';
    }
    if (badge) {
        badge.classList.toggle('hidden', !loggedIn);
        badge.classList.toggle('inline-flex', loggedIn);
        if (badgeName) badgeName.textContent = loggedIn ? name : '';
        badge.title = loggedIn ? `Signed in as ${name} · ${role}` : '';
    }
}

/**
 * Updates the visual state of the Admin button and conditional UI elements.
 */
function updateAdminUI() {
    // Signed-in staff/parents aren't nudged to follow a team; refresh the card.
    try { renderMyTeam(); } catch (e) { /* card not ready yet */ }
    const adminButton = document.getElementById('admin-button');
    const adminStatusText = document.getElementById('admin-status-text');
    const adminEntryTab = document.getElementById('admin-entry-tab');
    const adminControls = document.getElementById('admin-controls');
    const setupGear = document.getElementById('admin-setup-gear');
    const chatSetupGear = document.getElementById('chat-setup-gear');
    const chatTab = document.getElementById('chat-tab');
    const scheduleTab = document.getElementById('schedule-tab');
    const infoTab = document.getElementById('info-tab');
    const rosterTab = document.getElementById('roster-tab');
    const raffleTab = document.getElementById('raffle-tab');
    const concessionsTab = document.getElementById('concessions-tab');

    if (!adminButton || !adminStatusText || !adminEntryTab) return;

    const loggedIn = App.state.isAdmin || App.state.isParent || App.state.isRaffle || App.state.isConcessions;

    updateGateAdminUI(loggedIn);
    if (App.state.isSuperAdmin && loggedIn) startDiscrepancyWatch(); else { App.data.discrepancies = []; updateDiscrepancyBadge(); }
    window.syncChatRole?.();

    if (loggedIn) {
        adminStatusText.textContent = 'Logout';
        adminButton.classList.remove('bg-gray-700', 'hover:bg-gray-600', 'text-accent');
        adminButton.classList.add('bg-gold', 'hover:bg-gold-d', 'text-white');
        adminButton.onclick = logoutAdmin;
        // Match entry stays referee/superadmin-only; parents only get chat.
        if (App.state.isAdmin) {
            adminEntryTab.classList.remove('hidden'); // Show Admin Tab
            // The Admin tab duplicates the Games/schedule view, so hide Games for admins/superadmins.
            if (scheduleTab) {
                scheduleTab.classList.add('hidden');
                if (App.state.currentView === 'schedule') switchView('admin-entry');
            }
        } else {
            adminEntryTab.classList.add('hidden');
            if (scheduleTab) scheduleTab.classList.remove('hidden');
        }
        // Raffle and concessions staff get chat (crew + leadership) alongside their stand.
        // Superadmins reach Raffle and Concessions from the gate's Admin Panel instead of the tab bar.
        if (chatTab) chatTab.classList.remove('hidden');
        if (raffleTab) raffleTab.classList.toggle('hidden', !App.state.isRaffle);
        if (concessionsTab) concessionsTab.classList.toggle('hidden', !App.state.isConcessions);
        if (!App.state.isRaffle && !App.state.isSuperAdmin) { if (App.state.currentView === 'raffle') switchView('standings'); resetRaffle(); }
        if (!App.state.isConcessions && !App.state.isSuperAdmin) { if (App.state.currentView === 'concessions') switchView('standings'); resetConcessions(); }
        if (!App.state.isSuperAdmin) { if (App.state.currentView === 'raffle-backup') switchView('standings'); resetRaffleBackup(); }
        // Superadmins reach Info from the gate's Admin Panel instead of the tab bar.
        if (infoTab) {
            infoTab.classList.toggle('hidden', !!App.state.isSuperAdmin);
            if (App.state.isSuperAdmin && App.state.currentView === 'info') switchView('admin-entry');
        }
        // Roster (Registrations sheet) is superadmin-only; the server enforces it too.
        if (rosterTab) rosterTab.classList.toggle('hidden', !App.state.isSuperAdmin);
        if (!App.state.isSuperAdmin) { if (App.state.currentView === 'roster') switchView('admin-entry'); resetRoster(); }
        if (App.state.isSuperAdmin) {
            if (setupGear) setupGear.classList.remove('hidden');
            if (chatSetupGear) chatSetupGear.classList.remove('hidden');
        }
    } else {
        adminStatusText.textContent = 'Admin';
        adminButton.classList.remove('bg-gold', 'hover:bg-gold-d', 'text-white');
        adminButton.classList.add('bg-gray-700', 'hover:bg-gray-600', 'text-accent');
        adminButton.onclick = showAdminLoginModal;
        adminEntryTab.classList.add('hidden'); // Hide Admin Tab
        if (scheduleTab) scheduleTab.classList.remove('hidden'); // Restore Games Tab
        if (infoTab) infoTab.classList.remove('hidden');
        if (adminControls) adminControls.classList.add('hidden');
        if (setupGear) setupGear.classList.add('hidden');
        if (chatSetupGear) chatSetupGear.classList.add('hidden');
        if (chatTab) chatTab.classList.add('hidden');
        if (rosterTab) rosterTab.classList.add('hidden');
        if (raffleTab) raffleTab.classList.add('hidden');
        if (concessionsTab) concessionsTab.classList.add('hidden');
        if (['roster', 'raffle', 'raffle-backup', 'concessions'].includes(App.state.currentView)) switchView('standings');
        resetRaffle();
        resetConcessions();
        resetSeasons();
        resetDanger();
        resetDivisionData();
        resetRaffleBackup();
        resetRoster();
        window.closeTimerOverlay?.();
    }
}

const SESSION_HEARTBEAT_INTERVAL_MS = 45000;

/**
 * Keeps the server's session record "online" for this login while the tab
 * is open — see /api/session/heartbeat and the Setup page's "Signed-in
 * users" module. Safe to call repeatedly; clears any previous interval.
 */
function startSessionHeartbeat() {
    stopSessionHeartbeat();
    const token = sessionStorage.getItem('adminAuthToken');
    const sessionId = sessionStorage.getItem('sessionId');
    if (!token || !sessionId) return;
    const beat = () => sendSessionHeartbeat(token, sessionId, App.state.isSuperAdmin ? null : App.state.selectedCourt)
        .catch(err => console.error('Session heartbeat failed:', err));
    App.state.sessionHeartbeatBeat = beat;
    beat();
    App.state.sessionHeartbeatInterval = setInterval(beat, SESSION_HEARTBEAT_INTERVAL_MS);

    // Mobile browsers throttle/suspend setInterval while a tab is
    // backgrounded (screen locked, app switched away) — the next tick can
    // land well past SESSION_HEARTBEAT_INTERVAL_MS after it resumes, during
    // which the presence dot reads stale/offline even though the person is
    // actively using the app again. Firing immediately on visibility regain
    // closes that gap.
    if (!App.state.sessionHeartbeatVisibilityListener) {
        App.state.sessionHeartbeatVisibilityListener = () => {
            if (document.visibilityState === 'visible' && App.state.sessionHeartbeatInterval) beat();
        };
        document.addEventListener('visibilitychange', App.state.sessionHeartbeatVisibilityListener);
    }
}

function stopSessionHeartbeat() {
    if (App.state.sessionHeartbeatInterval) {
        clearInterval(App.state.sessionHeartbeatInterval);
        App.state.sessionHeartbeatInterval = null;
    }
}

function showAdminLoginModal() {
    const modal = document.getElementById('admin-login-modal');
    const passwordInput = document.getElementById('admin-password-input');
    const nameInput = document.getElementById('admin-name-field');
    const message = document.getElementById('admin-login-message');

    // Show the modal
    modal.classList.remove('hidden');

    // Clear previous input and messages
    passwordInput.value = '';
    try {
        const saved = JSON.parse(localStorage.getItem('savedAdminPassword') || 'null');
        if (saved && saved.p && Date.now() - saved.t < 24 * 60 * 60 * 1000) passwordInput.value = saved.p;
        else if (saved) localStorage.removeItem('savedAdminPassword');
    } catch (e) { /* ignore */ }
    nameInput.value = localStorage.getItem('lastAdminName') || '';
    message.classList.add('hidden');

    renderLoginCourtPicker();

    // Returning user (name remembered): skip straight to the password field.
    setTimeout(() => (nameInput.value ? passwordInput : nameInput).focus(), 50);
}

/**
 * Renders the "Your Court" 4-up picker in the login modal. Only meaningful
 * for the court-manager role — ignored server-side/client-side if the
 * password turns out to belong to the tournament manager.
 */
function renderLoginCourtPicker() {
    const wrap = document.getElementById('login-court-picker');
    if (!wrap) return;
    wrap.innerHTML = '';

    if (!App.state.selectedCourt) App.state.selectedCourt = localStorage.getItem('lastAdminCourt') || '1';
    const selected = App.state.selectedCourt;
    ['1', '2', '3', '4'].forEach(court => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'C' + court;
        const isActive = court === selected;
        btn.setAttribute('aria-pressed', isActive);
        // Selected court is a solid maroon pill with white text; the rest stay flat/muted.
        btn.className = 'rounded-[14px] py-2.5 text-[13px] leading-none transition-colors ' +
            (isActive ? 'font-bold text-white shadow-[0_3px_10px_rgba(123,29,43,.45)] ring-2 ring-offset-1 ring-[#7B1D2B]'
                : 'font-semibold text-mute hover:bg-white/60');
        if (isActive) btn.style.background = 'linear-gradient(135deg,var(--mar-l) 0%,var(--mar) 100%)';
        btn.onclick = () => {
            App.state.selectedCourt = court;
            renderLoginCourtPicker();
        };
        wrap.appendChild(btn);
    });
}

// --- Court switching (court managers) -----------------------------------------
// The court picked at login is the referee's identity for the day (header,
// crew chat label, session record, Court Ready), but refs move between
// courts. The header's "Court N ▾" chip opens this sheet; the save-toast
// nudge calls switchCourt() directly.

function switcherCourts() {
    const extra = (App.data.courtNames || []).map(c => String(c).trim()).filter(Boolean);
    return [...new Set(['1', '2', '3', '4', ...extra])]
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function closeCourtSwitcher() {
    document.getElementById('court-switcher')?.remove();
}

function openCourtSwitcher() {
    if (!App.state.isAdmin || App.state.isSuperAdmin) return;
    closeCourtSwitcher();
    const current = (App.state.selectedCourt || '').trim();
    const wrap = document.createElement('div');
    wrap.id = 'court-switcher';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', 'Change your court');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:130;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.55)';
    const buttons = switcherCourts().map(c => {
        const on = c === current;
        return `<button type="button" data-court="${esc(c)}" aria-pressed="${on}" class="rounded-[16px] py-4 text-[16px] font-extrabold leading-none" `
            + `style="${on ? 'background:linear-gradient(135deg,var(--gold) 0%,var(--gold-d) 100%);color:#2A1B08' : 'background:rgba(255,255,255,.07);color:#fff;border:1px solid rgba(255,255,255,.14)'}">C${esc(c)}</button>`;
    }).join('');
    wrap.innerHTML = `
        <div class="w-full max-w-md rounded-t-[26px] border border-white/10 p-4" style="background:#241318;padding-bottom:calc(1rem + env(safe-area-inset-bottom,0px))">
            <div class="text-[10px] tracking-[.16em] font-semibold text-white/50 uppercase">Your court</div>
            <div class="mt-1 text-[16px] font-extrabold text-white">Which court are you on now?</div>
            <div class="mt-3 grid grid-cols-4 gap-2">${buttons}</div>
            <button type="button" data-cancel class="mt-3 w-full rounded-full border border-white/15 bg-white/[.06] py-3 text-[13px] font-semibold text-white/70">Cancel</button>
        </div>`;
    wrap.addEventListener('click', (ev) => {
        if (ev.target === wrap || ev.target.closest('[data-cancel]')) return closeCourtSwitcher();
        const btn = ev.target.closest('[data-court]');
        if (btn) { closeCourtSwitcher(); switchCourt(btn.dataset.court); }
    });
    document.addEventListener('keydown', function onKey(e) {
        if (e.key === 'Escape') { closeCourtSwitcher(); document.removeEventListener('keydown', onKey); }
    });
    document.body.appendChild(wrap);
}

/** Moves a court manager to another court for the rest of their session. */
function switchCourt(court) {
    court = String(court || '').trim();
    const prev = (App.state.selectedCourt || '').trim();
    if (!court || !App.state.isAdmin || App.state.isSuperAdmin) return;
    if (court === prev) return toast(`You're already on Court ${court}`);

    App.state.selectedCourt = court;
    sessionStorage.setItem('selectedCourt', court);
    localStorage.setItem('lastAdminCourt', court);

    // Their match list follows them (if this division uses that court).
    // Dispatching change persists the filter and re-renders, like a manual pick.
    const sel = document.getElementById('admin-court-select');
    if (sel && [...sel.options].some(o => o.value === court)) {
        sel.value = court;
        sel.dispatchEvent(new Event('change'));
    } else {
        updateAdminMatchEntryView();
    }

    courtReadyFollow(court);
    renderCourtIssues();
    updateGateAdminUI(true);
    App.state.sessionHeartbeatBeat?.(); // session list shows the new court right away

    const left = prev ? courtStatusOf(prev) : null;
    // Only worth saying when the old court's next game is in the round about to start.
    const note = left?.status === 'waiting' && left.inR ? ` · Court ${prev} still waiting for teams` : '';
    toast(`Now on Court ${court}${note}`);
    try { navigator.vibrate && navigator.vibrate(30); } catch (e) { /* unsupported */ }
}

function hideAdminLoginModal() {
    document.getElementById('admin-login-modal').classList.add('hidden');
}

async function loginAdmin() {
    const passwordInputEl = document.getElementById('admin-password-input');
    const nameInputEl = document.getElementById('admin-name-field');
    const loginMessage = document.getElementById('admin-login-message');
    const loginButton = document.getElementById('login-button');

    // Defensive checks: if the modal elements are missing, abort and log helpful info
    if (!passwordInputEl || !loginMessage || !loginButton) {
        console.error('loginAdmin: required DOM elements missing', {
            passwordInputEl: !!passwordInputEl,
            loginMessage: !!loginMessage,
            loginButton: !!loginButton
        });
        return;
    }

    const password = passwordInputEl.value;
    const reporterName = (nameInputEl?.value || '').trim();
    loginMessage.classList.add('hidden');

    if (!reporterName) {
        loginMessage.textContent = 'Your name is required.';
        loginMessage.classList.remove('hidden');
        return;
    }

    loginButton.disabled = true;
    loginButton.textContent = 'Verifying…';

    const sessionId = crypto.randomUUID();

    try {
        // Use the API helper which returns the validation result
        const result = await validateAdmin(password, reporterName, App.state.selectedCourt, sessionId);

        // One-day tournament: remember the password on this device (expires after 24h).
        if (result && (result.isParent || result.isRaffle || result.isConcessions || (result.isAdmin && !result.isSuperAdmin))) {
            // Superadmin password is never stored on the device.
            try { localStorage.setItem('savedAdminPassword', JSON.stringify({ p: password, t: Date.now() })); } catch (e) { /* storage unavailable */ }
        }

        if (result && result.isParent) {
            App.state.isParent = true;
            App.state.reporterName = reporterName;
            localStorage.setItem('lastAdminName', reporterName);
            sessionStorage.setItem('reporterName', reporterName);
            sessionStorage.setItem('isParent', 'true');
            sessionStorage.setItem('adminAuthToken', result.token);
            sessionStorage.setItem('sessionId', sessionId);
            startSessionHeartbeat();

            hideAdminLoginModal();
            updateAdminUI();
            switchView('chat');
            showStatus(`Signed in as ${reporterName} (Parent).`, false);
            setTimeout(() => showStatus(null), 3000);

        } else if (result && result.isRaffle) {
            App.state.isRaffle = true;
            App.state.reporterName = reporterName;
            localStorage.setItem('lastAdminName', reporterName);
            sessionStorage.setItem('reporterName', reporterName);
            sessionStorage.setItem('isRaffle', 'true');
            sessionStorage.setItem('adminAuthToken', result.token);
            sessionStorage.setItem('sessionId', sessionId);
            // Kept on the device too, so a phone that reloads with no signal can still reach the raffle and sync later.
            saveAuth(result.token, reporterName, 'raffle');
            startSessionHeartbeat();

            hideAdminLoginModal();
            updateAdminUI();
            switchView('raffle');
            showStatus(`Signed in as ${reporterName} (Raffle).`, false);
            setTimeout(() => showStatus(null), 3000);

        } else if (result && result.isConcessions) {
            App.state.isConcessions = true;
            App.state.reporterName = reporterName;
            localStorage.setItem('lastAdminName', reporterName);
            sessionStorage.setItem('reporterName', reporterName);
            sessionStorage.setItem('isConcessions', 'true');
            sessionStorage.setItem('adminAuthToken', result.token);
            sessionStorage.setItem('sessionId', sessionId);
            // Kept on the device too, so a phone that reloads with no signal can still reach the stand and sync later.
            saveAuth(result.token, reporterName);
            startSessionHeartbeat();

            hideAdminLoginModal();
            updateAdminUI();
            openConcessionsFromGate();
            showStatus(`Signed in as ${reporterName} (Concessions).`, false);
            setTimeout(() => showStatus(null), 3000);

        } else if (result && result.isAdmin) {
            App.state.isAdmin = true;
            App.state.reporterName = reporterName;
            localStorage.setItem('lastAdminName', reporterName);
            sessionStorage.setItem('reporterName', reporterName);
            if (App.state.selectedCourt) localStorage.setItem('lastAdminCourt', App.state.selectedCourt);

            //store this for persitstance
            sessionStorage.setItem('isAdmin', 'true');
            sessionStorage.setItem('isSuperAdmin', 'false');
            sessionStorage.setItem('isParent', 'false');
            sessionStorage.setItem('adminAuthToken', result.token);
            sessionStorage.setItem('sessionId', sessionId);
            startSessionHeartbeat();
            if (result.isSuperAdmin) {
                // Firebase custom-token sign-in is only meaningful (and only
                // returned by the server) when DATA_BACKEND=firebase — local
                // mode's superadmin auth relies solely on the SHA-256 authToken.
                if (result.firebaseToken && window.__DATA_BACKEND__ !== 'local') {
                    try {
                        await firebase.auth().signInWithCustomToken(result.firebaseToken);
                        console.log('Super admin signed in to Firebase successfully');
                    } catch (err) {
                        console.error('Firebase sign-in error:', err);
                    }
                    sessionStorage.setItem('firebaseToken', result.firebaseToken);
                }
                App.state.isSuperAdmin = true;
                sessionStorage.setItem('isSuperAdmin', 'true');
                // initialize/move timer overlay for superadmin (if present)
                if (typeof window.initTimerOverlay === 'function') window.initTimerOverlay();
                window.gtag?.('event', 'login', {
                    method: 'web', // or 'google', 'facebook', etc.
                    success: true,
                    user_id: 'superadmin' // optional, only if you have one
                });
            } else {
                // Court manager — the court picked in the login modal scopes
                // their Admin tab's results list (see admin-court-select
                // default in main.js's loadData()).
                const court = App.state.selectedCourt || '1';
                App.state.selectedCourt = court;
                sessionStorage.setItem('selectedCourt', court);
                window.gtag?.('event', 'login', {
                    method: 'web', // or 'google', 'facebook', etc.
                    success: true,
                    user_id: 'admin' // optional, only if you have one
                });
            }

            hideAdminLoginModal();
            updateAdminUI();

            if (App.state.isSuperAdmin && (!App.data.allDivisionNames || !App.data.allDivisionNames.length)) {
                // Bypass gate and redirect to settings
                App.state.screen = 'app';
                document.getElementById('gate-screen')?.classList.add('hidden');
                document.getElementById('app-screen')?.classList.remove('hidden');
                document.getElementById('bottom-tab-bar')?.classList.remove('hidden');
                switchView('settings');
                showStatus('Please configure and run Google Sheets sync to populate divisions.', false);
            } else {
                switchView('admin-entry'); // Go straight to admin view after login
                showStatus(`Signed in as ${reporterName}.`, false);
                setTimeout(() => showStatus(null), 3000);
            }

        } else {
            App.state.isAdmin = false;
            App.state.isParent = false;
            App.state.isRaffle = false;
            App.state.isConcessions = false;
            loginMessage.textContent = 'Invalid password.';
            sessionStorage.removeItem('adminAuthToken'); // Clear any old token
            try { localStorage.removeItem('savedAdminPassword'); } catch (e) { /* ignore */ }
            loginMessage.classList.remove('hidden');
            window.gtag?.('event', 'login_failed', {
                method: 'web',
                success: false
            });
        }

    } catch (error) {
        console.error("Admin Login Error:", error);
        loginMessage.textContent = 'An error occurred during login verification.';
        loginMessage.classList.remove('hidden');
    } finally {
        loginButton.disabled = false;
        loginButton.textContent = 'Sign in →';
    }
}

function logoutAdmin() {
    const waiting = unsyncedCount();
    if (waiting && !confirm(`${waiting} concession ${waiting === 1 ? 'change is' : 'changes are'} still waiting to sync. They stay safely on this phone and upload the next time a concessions or tournament manager signs in with a connection.\n\nLog out anyway?`)) return;
    stopSessionHeartbeat();
    const token = sessionStorage.getItem('adminAuthToken');
    const sessionId = sessionStorage.getItem('sessionId');
    if (token && sessionId) {
        apiEndSession(token, sessionId).catch(err => console.error('Session logout failed:', err));
    }

    App.state.isAdmin = false;
    App.state.isSuperAdmin = false;
    App.state.isParent = false;
    App.state.isRaffle = false;
    App.state.isConcessions = false;
    App.state.reporterName = '';
    App.state.selectedCourt = '';
    //remove admin persistance
    sessionStorage.removeItem('isAdmin');
    sessionStorage.removeItem('isSuperAdmin');
    sessionStorage.removeItem('isParent');
    sessionStorage.removeItem('isRaffle');
    sessionStorage.removeItem('isConcessions');
    clearAuth();
    resetCourtReady();
    stopCourtIssues();
    sessionStorage.removeItem('firebaseToken');
    sessionStorage.removeItem('reporterName');
    sessionStorage.removeItem('selectedCourt');
    sessionStorage.removeItem('adminAuthToken');
    sessionStorage.removeItem('sessionId');
    if (window.__DATA_BACKEND__ !== 'local') {
        firebase.auth().signOut();
    }
    // The timer controls live in the header-clock popover now; updateAdminUI()
    // closes it for non-superadmins.
    updateAdminUI();
    // If the user was in a staff-only tab, switch them out
    if (['admin-entry', 'settings', 'game-manager', 'chat', 'concessions', 'raffle'].includes(App.state.currentView)) {
        switchView('standings');
    }
    showStatus('Logged out of Admin Mode.', false);
    setTimeout(() => showStatus(null), 3000);
}

// --- MATCH ENTRY MODAL: tap-first result reporting ---
//
// Built for a referee on a phone between games: tap who won, tap how many
// players they had left, tap Submit. The reporter name comes from login and
// notes are rare, so both stay tucked behind links unless needed. Each opening
// of the modal gets a clientId so a double tap / retry never saves twice.

const modalState = { clientId: null, saving: false };

function newClientId() {
    try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* insecure context */ }
    return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

/** Highest players-left tile (superadmin Setup → Match entry). */
function maxPlayersLeft() {
    const n = Number(App.settings && App.settings.maxPlayersLeft);
    return Number.isInteger(n) && n >= 1 && n <= 20 ? n : 8;
}

function isTeamWinner(winner) {
    return !!winner && winner !== '—' && winner !== 'tie';
}

function modalReporterName() {
    return (document.getElementById('admin-name-input')?.value || '').trim();
}

/**
 * Populates and shows the match entry modal.
 * @param {number} gameIndex - The index of the game in the allScheduleData array.
 */
function showMatchEntryModal(gameIndex) {
    const modal = document.getElementById('match-entry-modal');
    const matchInfoDisplay = document.getElementById('match-info-display');
    const winnerSelect = document.getElementById('modal-winner-select');
    const playersInput = document.getElementById('modal-players-input');
    const notesTextarea = document.getElementById('modal-notes-textarea');
    const saveMessage = document.getElementById('modal-save-message');
    const adminNameInput = document.getElementById('admin-name-input');

    const game = App.data.allScheduleData[gameIndex];
    if (!game) return console.error('Game data not found for index:', gameIndex);

    App.admin.currentGameIndex = gameIndex;
    modalState.clientId = newClientId();
    modalState.saving = false;

    saveMessage.classList.add('hidden');
    saveMessage.textContent = '';

    matchInfoDisplay.textContent = `Court ${game.court || '—'} · ${game.roundTime} · ${App.config.currentSheetName}`;

    // Prefill with whatever was already reported (editing a report).
    const currentWinner = (game.adminWinner && game.adminWinner.trim() !== 'TBA') ? game.adminWinner.trim() : '—';
    winnerSelect.value = currentWinner || '—';
    playersInput.value = isTeamWinner(winnerSelect.value) ? (parseInt(game.adminPlayersRemaining) || 0) : 0;

    // Notes: collapsed unless this game already has one.
    notesTextarea.value = game.notes || '';
    const hasNote = !!notesTextarea.value.trim();
    document.getElementById('modal-notes-wrap').classList.toggle('hidden', !hasNote);
    document.getElementById('modal-notes-toggle').classList.toggle('hidden', hasNote);

    // Reporter: the name captured at login. Only show the field when it's
    // missing (sessions that predate the login name field) or on "Change".
    adminNameInput.value = App.state.reporterName || localStorage.getItem('lastAdminName') || '';
    syncReporterLine(!adminNameInput.value.trim());

    const officialEl = document.getElementById('modal-official-display');
    if (officialEl) {
        const officialWinner = (game.winner || '').trim();
        officialEl.textContent = officialWinner
            ? `${officialWinner}${officialWinner === 'tie' ? '' : ` · ${game.playersRemaining || 0} left`}`
            : 'not official yet';
    }

    // Superadmin only: "also submit as official". Defaults to on when the
    // auto-update setting is on (their report then flows to official), off
    // otherwise (opt in per entry).
    const officialToggleWrap = document.getElementById('modal-official-toggle-wrap');
    if (officialToggleWrap) {
        officialToggleWrap.classList.toggle('hidden', !App.state.isSuperAdmin);
        document.getElementById('modal-official-toggle').checked = !!App.settings.autoUpdateOfficialResultsEnabled;
    }

    setupModalHistory(game);
    renderMatchEntryControls(game);
    modal.classList.remove('hidden');
}

/** Shows either "Reporting as X · Change" or the name field. */
function syncReporterLine(showField) {
    const name = modalReporterName();
    document.getElementById('modal-reporter-name').textContent = name;
    document.getElementById('modal-reporter-line').classList.toggle('hidden', showField || !name);
    document.getElementById('modal-reporter-wrap').classList.toggle('hidden', !showField && !!name);
}

function showModalReporterField() {
    syncReporterLine(true);
    const input = document.getElementById('admin-name-input');
    input.focus();
    input.select();
}

function showModalNotesField() {
    document.getElementById('modal-notes-wrap').classList.remove('hidden');
    document.getElementById('modal-notes-toggle').classList.add('hidden');
    document.getElementById('modal-notes-textarea').focus();
}

function currentModalGame() {
    return App.admin.currentGameIndex === null ? null : App.data.allScheduleData[App.admin.currentGameIndex];
}

/** Repaints winner tiles, players tiles and the submit button from the hidden inputs. */
function renderMatchEntryControls(game) {
    renderWinnerTiles(game);
    renderPlayersTiles();
    updateModalSaveButton(game);
}

/**
 * "Who won?" choice tiles (design §10). The value lives on the hidden
 * #modal-winner-select input so the save path and its validation are unchanged.
 */
function renderWinnerTiles(game) {
    const wrap = document.getElementById('modal-winner-tiles');
    const winnerSelect = document.getElementById('modal-winner-select');
    const playersInput = document.getElementById('modal-players-input');
    if (!wrap || !winnerSelect) return;

    const options = [game.team1, game.team2]
        .filter(t => t && t.trim() !== '')
        .map(t => ({ value: t, label: t }));

    // Ties are a pool-play option only: a playoff game always needs a winner.
    const playoff = isPlayoffGame(game);
    if (App.settings.is_tie_allowed && !playoff) {
        options.push({ value: 'tie', label: '🤝 Horn sounded even — tie' });
    }
    if (playoff && winnerSelect.value === 'tie') {
        winnerSelect.value = '—';
        if (playersInput) playersInput.value = 0;
    }

    wrap.innerHTML = '';
    if (playoff && App.settings.is_tie_allowed) {
        const note = document.createElement('p');
        note.className = 'col-span-full text-[11px] leading-[1.4] text-white/55';
        note.textContent = 'Playoff game — no ties. Pick the team that advances.';
        wrap.appendChild(note);
    }
    options.forEach(opt => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tile-dark';
        btn.style.touchAction = 'manipulation';
        btn.textContent = opt.label;
        btn.dataset.selected = String(winnerSelect.value === opt.value);
        btn.onclick = () => {
            const was = winnerSelect.value;
            // Tapping the selected tile clears it, matching the old "—" option.
            winnerSelect.value = was === opt.value ? '—' : opt.value;
            // Switching teams keeps the count; tie / no winner means 0 left.
            if (!isTeamWinner(winnerSelect.value)) playersInput.value = 0;
            renderMatchEntryControls(game);
            // Bring the next step into view on short phones.
            if (isTeamWinner(winnerSelect.value) && !isTeamWinner(was)) {
                document.getElementById('modal-players-wrap')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        };
        wrap.appendChild(btn);
    });
}

/** 1…max quick-tap tiles for the winner's players left (tiebreak). */
function renderPlayersTiles() {
    const wrap = document.getElementById('modal-players-wrap');
    const tiles = document.getElementById('modal-players-tiles');
    const winnerSelect = document.getElementById('modal-winner-select');
    const playersInput = document.getElementById('modal-players-input');
    if (!wrap || !tiles) return;

    const show = isTeamWinner(winnerSelect.value);
    wrap.classList.toggle('hidden', !show);
    if (!show) return;

    const current = parseInt(playersInput.value) || 0;
    // Never hide an already-reported count that's above the current max.
    const max = Math.max(maxPlayersLeft(), current);
    const cols = max <= 4 ? max : max <= 8 ? 4 : 5;
    tiles.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;

    tiles.innerHTML = '';
    for (let n = 1; n <= max; n++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'num-tile-dark';
        btn.textContent = String(n);
        btn.setAttribute('aria-label', `${n} player${n === 1 ? '' : 's'} left`);
        btn.dataset.selected = String(current === n);
        btn.onclick = () => {
            playersInput.value = current === n ? 0 : n;
            const game = currentModalGame();
            if (game) renderMatchEntryControls(game);
        };
        tiles.appendChild(btn);
    }
}

/** Submit button says exactly what will be saved, and stays disabled until it's complete. */
function updateModalSaveButton(game) {
    const btn = document.getElementById('modal-save-button');
    if (!btn || modalState.saving) return;
    const winner = document.getElementById('modal-winner-select').value;
    const players = parseInt(document.getElementById('modal-players-input').value) || 0;
    const hadReport = !!(game && game.adminWinner && !['', 'TBA', '—'].includes(game.adminWinner.trim()));

    let label = 'Submit result';
    let enabled = true;
    if (isTeamWinner(winner)) {
        if (players < 1) { label = 'Tap players left'; enabled = false; }
        else label = `Submit · ${players} left`;
    } else if (winner === 'tie') {
        label = 'Submit · Tie';
    } else if (hadReport) {
        label = 'Clear reported result';
    } else {
        label = 'Tap who won';
        enabled = false;
    }
    btn.textContent = label;
    btn.disabled = !enabled;
}

function hideMatchEntryModal() {
    document.getElementById('match-entry-modal').classList.add('hidden');
    App.admin.currentGameIndex = null;
    modalState.clientId = null;
}

function describeResult(winner, players) {
    if (winner === 'tie') return 'Tie';
    if (!isTeamWinner(winner)) return 'Result cleared';
    return `${winner} won · ${players} left`;
}

/**
 * Saves the match result using data from the modal.
 */
async function saveMatchResultFromModal() {
    if (App.admin.currentGameIndex === null) return console.error('No game selected for saving.');
    // One save at a time: ignore extra taps while one is in flight.
    if (modalState.saving) return;

    const game = App.data.allScheduleData[App.admin.currentGameIndex];
    const winnerSelect = document.getElementById('modal-winner-select');
    const playersInput = document.getElementById('modal-players-input');
    const notesTextarea = document.getElementById('modal-notes-textarea');
    const saveButton = document.getElementById('modal-save-button');
    const messageElement = document.getElementById('modal-save-message');

    const showError = (text) => {
        messageElement.textContent = text;
        messageElement.style.color = 'var(--warn)';
        messageElement.classList.remove('hidden');
    };

    const adminName = modalReporterName();
    const winner = winnerSelect.value;
    const playersRemaining = isTeamWinner(winner) ? (parseInt(playersInput.value) || 0) : 0;
    const notes = notesTextarea.value.trim();

    // Validation
    if (!adminName) {
        syncReporterLine(true);
        document.getElementById('admin-name-input').focus();
        return showError('Enter your name so we know who reported this.');
    }
    if (isTeamWinner(winner) && playersRemaining < 1) {
        return showError('Tap how many players the winner had left.');
    }
    if (winner === 'tie' && isPlayoffGame(game)) {
        return showError('Playoff games can\'t end in a tie — pick the team that advances.');
    }

    const setOfficial = App.state.isSuperAdmin && !!document.getElementById('modal-official-toggle')?.checked;
    if (!isTeamWinner(winner) && winner !== 'tie') {
        const msg = setOfficial
            ? 'No winner selected — this will clear the official result. Continue?'
            : 'No winner selected — this will clear the reported result. Continue?';
        if (!confirm(msg)) return;
    }

    // Same result as what's already reported: nothing to save, just confirm.
    const prevWinner = (game.adminWinner || '').trim();
    const unchanged = !setOfficial
        && prevWinner === (winner === '—' ? '' : winner)
        && (parseInt(game.adminPlayersRemaining) || 0) === playersRemaining
        && (game.notes || '').trim() === notes
        && prevWinner !== '';
    if (unchanged) {
        hideMatchEntryModal();
        toast(`✓ Already saved — ${describeResult(winner, playersRemaining)}`);
        return;
    }

    const authToken = sessionStorage.getItem('adminAuthToken');
    if (!authToken) return showError('Authentication error — please log in again.');

    localStorage.setItem('lastAdminName', adminName);

    modalState.saving = true;
    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    messageElement.classList.add('hidden');

    const sheetName = App.config.currentSheetName;
    const matchData = {
        sheetName,
        rowIndex: game.rowIndex,
        firebaseIndex: game.firebaseIndex,
        team1: game.team1,
        team2: game.team2,
        winner: winner === '—' ? '' : winner,
        playersRemaining,
        adminName,
        notes,
        setOfficial // superadmin only; the server re-checks the token
    };

    let saved = false;
    try {
        const result = await apiSaveMatchResult(authToken, matchData, modalState.clientId);

        if (!result.success) {
            if (result.logout) {
                sessionStorage.removeItem('adminAuthToken');
                logoutAdmin();
            }
            throw new Error(result.error || 'Server reported failure.');
        }

        saved = true;
        // Done: close straight away and confirm with a toast, so the referee
        // is back on the schedule (and the next game) immediately.
        hideMatchEntryModal();
        // Nudge: a court manager reporting a game on another court has
        // probably moved and forgotten to switch — offer it in one tap.
        const gameCourt = (game.court || '').trim();
        const myCourt = (App.state.selectedCourt || '').trim();
        if (!App.state.isSuperAdmin && gameCourt && myCourt && gameCourt !== myCourt) {
            toast(`✓ Saved · you're on Court ${myCourt}`, false, { label: `Switch to Court ${gameCourt}`, run: () => switchCourt(gameCourt) });
        } else {
            toast(`✓ Saved — ${describeResult(winner, playersRemaining)}`);
        }
        try { navigator.vibrate && navigator.vibrate(40); } catch (e) { /* unsupported */ }
        // Court Ready: the referee's bar follows the court they just reported.
        courtReadyOnSave(game);

        const sheetFailed = result.sheetsMirror && !result.sheetsMirror.success && !result.sheetsMirror.skipped;
        // Refresh standings/schedule in the background. loadData() resets the
        // status bar, so the sheet warning goes up after it finishes.
        loadData(sheetName).finally(() => {
            if (sheetFailed) {
                showStatus('Saved, but the Google Sheet update failed: ' + (result.sheetsMirror.error || 'unknown error') + ' — tell the tournament manager.', true);
                setTimeout(() => showStatus(null), 10000);
            }
        });
    } catch (error) {
        console.error('Save failed:', error);
        if (error && error.status === 401) {
            sessionStorage.removeItem('adminAuthToken');
            logoutAdmin();
            showError('Session expired. Please log in again.');
        } else if (error && (error.status === 0 || error instanceof TypeError)) {
            showError('No connection — nothing was saved. Try again.');
        } else {
            showError('Not saved: ' + ((error && error.body && error.body.error) || error.message || 'Unknown error'));
        }
    } finally {
        modalState.saving = false;
        // The same clientId is kept on failure, so a retry that actually
        // reached the server the first time can't save twice.
        if (!saved) {
            const g = currentModalGame();
            if (g) updateModalSaveButton(g);
            else { saveButton.disabled = false; saveButton.textContent = 'Submit result'; }
        }
    }
}

function checkLoginStatus() {
    const isAdmin = sessionStorage.getItem('isAdmin');
    const isSuperAdmin = sessionStorage.getItem('isSuperAdmin');
    const isParent = sessionStorage.getItem('isParent');
    const isRaffle = sessionStorage.getItem('isRaffle');
    const firebaseToken = sessionStorage.getItem('firebaseToken');

    // Normalize stored strings to booleans for app state
    App.state.isSuperAdmin = (isSuperAdmin === 'true');
    if (firebaseToken) App.state.firebaseToken = firebaseToken;
    App.state.isAdmin = (isAdmin === 'true');
    App.state.isParent = (isParent === 'true');
    App.state.isRaffle = (isRaffle === 'true');
    App.state.isConcessions = (sessionStorage.getItem('isConcessions') === 'true');
    App.state.reporterName = sessionStorage.getItem('reporterName') || '';
    App.state.selectedCourt = sessionStorage.getItem('selectedCourt') || '';

    // A concessions or raffle phone that was closed/reloaded (possibly with no signal) picks its sign-in back up from the
    // device copy, so the stand is reachable offline. It expires after 24 hours.
    if (!App.state.isAdmin && !App.state.isParent && !App.state.isRaffle && !App.state.isConcessions && !App.state.isSuperAdmin) {
        const saved = loadAuth();
        if (saved && saved.name) {
            if (saved.role === 'raffle') {
                App.state.isRaffle = true;
                sessionStorage.setItem('isRaffle', 'true');
            } else {
                App.state.isConcessions = true;
                sessionStorage.setItem('isConcessions', 'true');
            }
            sessionStorage.setItem('adminAuthToken', saved.token);
            sessionStorage.setItem('reporterName', saved.name);
            App.state.reporterName = saved.name;
        }
    }

    // Resume the heartbeat after a page reload so the session doesn't go
    // stale in the Setup page's "Signed-in users" view.
    if (App.state.isAdmin || App.state.isParent || App.state.isRaffle || App.state.isConcessions) startSessionHeartbeat();

    // The updateAdminUI() call below will handle showing the correct buttons.
}

Object.assign(window, { openDiscrepancyReview, setDiscrepancyPref });
window.getDiscrepancyPref = getDiscrepancyPref;

export {
    updateAdminMatchEntryView,
    updateAdminUI,
    showAdminLoginModal,
    hideAdminLoginModal,
    loginAdmin,
    logoutAdmin,
    showMatchEntryModal,
    hideMatchEntryModal,
    saveMatchResultFromModal,
    openCourtSwitcher,
    switchCourt,
    showModalReporterField,
    showModalNotesField,
    checkLoginStatus
};