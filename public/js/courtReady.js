// public/js/courtReady.js
// Court readiness (optional, Setup → "Court Ready").
//
// Court statuses are DERIVED, never stored: every render works them out from
// the schedule (which games are reported), the round clock, and two small
// facts kept on the server (server/courtStatus.js): which upcoming games have
// been marked "both teams on court", and which round the MC started. So the
// board can't drift out of sync — clearing marks, a reload or a server restart
// all rebuild it from the schedule.
//
//   live round R = earliest round with an unreported game (same rule the clock uses)
//   a court's up-next game = its earliest unreported game
//     up-next in R:   R started → IN PLAY, else marked → READY, else WAITING FOR TEAMS
//     up-next later:  R started (court finished early) → READY / WAITING for its next game,
//                     else → BYE this round
//     nothing left:   DONE
//   "R started" = the MC started it (board Start round or the clock's Start),
//   or, with no newer record, the clock is running its main segment on R.
//
// Rendered into #court-ready-panel at the top of the admin match entry view:
// the MC (superadmin) gets the court board, a referee gets their court's bar.
import { getCourtStatus, setCourtMark, courtRoundAction } from './api.js';
import { getRoundOrder, isReported as isReportedOfficial } from './schedule.js';
import { getSocket } from './socketClient.js';
import { getTimerSnapshot } from './timerSnapshot.js';
import { isController } from './timerControlsUI.js';
import { toast } from './concessionsUi.js';

const POLL_MS = 20000;
const UNDO_MS = 10000;
const CLOCK_START_SLACK_MS = 5000;

let watching = false;
let marks = [];              // [{ division, gameKey, court, by, at }]
let starts = {};             // { [division]: { roundTime, by, at } }
let focusCourt = null;       // referee: court of the game they last reported
let undoUntil = 0;
let primed = false;          // superadmin: no alerts for the state found on load
let wasAllReady = false;
let knownReady = new Set();
let busy = false;
let stale = false;           // set on logout so the next sign-in refetches
let clockSig = '';

// --- basics --------------------------------------------------------------------

function enabled() {
    return App.settings?.courtReadyEnabled === true;
}

function token() {
    return sessionStorage.getItem('adminAuthToken');
}

function division() {
    return App.config?.currentSheetName || '';
}

function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

function clockTime(ts) {
    try { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
}

const courtKey = (c) => String(c || '').trim();
const roundOf = (g) => g.roundTime || 'TBD';
const hasValue = (v) => { const t = (v || '').trim(); return t !== '' && t !== 'TBA' && t !== '—'; };
const isDone = (g) => isReportedOfficial(g) || hasValue(g.adminWinner);

/** Stable identity of a game across reloads and sheet re-syncs. */
export function gameKeyOf(g) {
    return [roundOf(g), courtKey(g.court), (g.team1 || '').trim(), (g.team2 || '').trim()].join('|');
}

function schedule() {
    // The schedule in memory lags a division switch while loadData is in flight.
    if (App.data?.scheduleDivision && App.data.scheduleDivision !== division()) return [];
    return App.data?.allScheduleData || [];
}

// --- derived state ---------------------------------------------------------------

function liveRound(games, order) {
    return order.find(key => games.some(g => roundOf(g) === key && !isDone(g)));
}

function clockState() {
    return getTimerSnapshot(division())?.state || null;
}

function isStarted(R) {
    if (!R) return false;
    const rec = starts[division()];
    if (rec?.roundTime === R) return true;
    // Fallback (clock started somewhere that didn't record it, or the server
    // restarted): the clock is running its main segment on R, and was started
    // after the last recorded start.
    const st = clockState();
    if (!st?.running || st.startAfterRoundRunning) return false;
    if ((st.currentRound || '').trim() !== R) return false;
    return !rec || (Number(st.startTime) || 0) > (rec.at || 0) + CLOCK_START_SLACK_MS;
}

function markFor(game) {
    const key = gameKeyOf(game);
    const div = division();
    return marks.find(m => m.division === div && m.gameKey === key) || null;
}

/** Every court's derived status for the viewed division. */
function deriveBoard() {
    const games = schedule();
    const order = getRoundOrder();
    const R = liveRound(games, order);
    const started = isStarted(R);
    const idx = (g) => order.indexOf(roundOf(g));

    const byCourt = new Map();
    for (const g of games) {
        const c = courtKey(g.court);
        if (!c) continue;
        if (!byCourt.has(c)) byCourt.set(c, []);
        byCourt.get(c).push(g);
    }

    const rows = [...byCourt.entries()].map(([court, list]) => {
        const upNext = list.filter(g => !isDone(g)).sort((a, b) => idx(a) - idx(b))[0] || null;
        const hadGameInR = list.some(g => roundOf(g) === R);
        if (!upNext) return { court, status: 'done', upNext: null, hadGameInR };
        const mark = markFor(upNext);
        let status;
        if (roundOf(upNext) === R) status = started ? 'playing' : (mark ? 'ready' : 'waiting');
        else status = (started || mark) ? (mark ? 'ready' : 'waiting') : 'bye';
        return { court, status, upNext, mark, inR: roundOf(upNext) === R, hadGameInR };
    }).sort((a, b) => a.court.localeCompare(b.court, undefined, { numeric: true }));

    const needs = rows.filter(r => r.inR);
    const summary = started
        ? { mode: 'playing', inPlay: rows.filter(r => r.status === 'playing').length, total: rows.filter(r => r.hadGameInR).length }
        : { mode: 'staging', ready: needs.filter(r => r.status === 'ready').length, total: needs.length, allReady: needs.length > 0 && needs.every(r => r.status === 'ready') };
    return { R, started, startRec: starts[division()] || null, rows, summary };
}

/** Derived status of one court (or null), e.g. to warn when a referee leaves it. */
export function courtStatusOf(court) {
    if (!enabled()) return null;
    return deriveBoard().rows.find(r => r.court === courtKey(court)) || null;
}

// --- server sync -------------------------------------------------------------------

function applyState(data) {
    if (!data) return;
    marks = Array.isArray(data.marks) ? data.marks : [];
    starts = data.starts && typeof data.starts === 'object' ? data.starts : {};
    render();
}

async function refresh() {
    const t = token();
    if (!App.state.isAdmin || !t) return;
    try {
        const res = await getCourtStatus(t);
        if (!res.success) return;
        App.settings = App.settings || {};
        App.settings.courtReadyEnabled = res.enabled === true;
        applyState(res);
    } catch (e) {
        console.warn('Court status refresh failed:', e.message);
    }
}

/** Starts (once) live updates. Safe to call on every admin render. */
export function ensureCourtReadyWatch() {
    if (!App.state.isAdmin) return;
    wireClockStart();
    if (watching) {
        if (stale) { stale = false; refresh(); }
        return;
    }
    watching = true;
    refresh();
    try {
        const socket = getSocket();
        socket.on('courtStatusUpdate', applyState);
        socket.on('connect', refresh);
        socket.on('featureSettingsUpdate', (s) => {
            if (!s) return;
            App.settings = App.settings || {};
            App.settings.courtReadyEnabled = s.courtReadyEnabled === true;
            if (!enabled()) { marks = []; starts = {}; primed = false; }
            render();
        });
    } catch (e) {
        console.warn('Court status live updates unavailable, polling only:', e.message);
    }
    // The clock changes "in play"; re-render only when its state actually changes.
    window.addEventListener('timersnapshot', () => {
        const st = clockState();
        const sig = st ? [st.running, st.startAfterRoundRunning, st.currentRound, st.startTime, st.controllerId].join('|') : '';
        if (sig !== clockSig) { clockSig = sig; render(); }
    });
    setInterval(() => { if (!document.hidden && enabled()) refresh(); }, POLL_MS);
}

export function resetCourtReady() {
    marks = [];
    starts = {};
    focusCourt = null;
    undoUntil = 0;
    primed = false;
    wasAllReady = false;
    knownReady = new Set();
    stale = true;
    const panel = document.getElementById('court-ready-panel');
    if (panel) { panel.innerHTML = ''; panel.classList.add('hidden'); }
}

/** After a referee saves a result: their bar follows the court they just reported. */
export function onMatchSaved(game) {
    if (!game || !courtKey(game.court)) return;
    focusCourt = courtKey(game.court);
    undoUntil = 0;
    render();
}

/** Court manager switched courts: their bar now follows the new court. */
export function followCourt(court) {
    focusCourt = courtKey(court) || null;
    undoUntil = 0;
    render();
}

// --- actions -------------------------------------------------------------------------

async function setReady(court, ready) {
    if (busy) return;
    const row = deriveBoard().rows.find(r => r.court === court);
    if (!row?.upNext) return;
    busy = true;
    try {
        const res = await setCourtMark(token(), {
            division: division(),
            gameKey: gameKeyOf(row.upNext),
            court,
            ready,
            by: App.state.reporterName || localStorage.getItem('lastAdminName') || ''
        });
        if (ready) {
            try { navigator.vibrate && navigator.vibrate(40); } catch (e) { /* unsupported */ }
            if (!App.state.isSuperAdmin) {
                undoUntil = Date.now() + UNDO_MS;
                setTimeout(render, UNDO_MS + 50);
                toast(`✓ Court ${court} marked ready`, false, { label: 'Undo', run: () => setReady(court, false) });
            }
        } else {
            undoUntil = 0;
        }
        applyState(res);
    } catch (e) {
        toast(e.status === 409 ? 'Court ready is turned off.' : `Couldn't update court: ${e.body?.error || e.message}`, true);
    } finally {
        busy = false;
    }
}

async function recordStart(R) {
    const res = await courtRoundAction(token(), 'start', { division: division(), roundTime: R, by: App.state.reporterName || 'MC' });
    applyState(res);
}

/**
 * Board "Start round": records the start and, if this tab can run the clock
 * and it isn't running, starts the clock too (one tap instead of three).
 */
async function startRoundFromBoard() {
    const { R, started } = deriveBoard();
    if (!R || started || busy) return;
    busy = true;
    try {
        await recordStart(R);
        const st = clockState();
        const startBtn = document.getElementById('start-btn');
        if (st && !st.running && startBtn) {
            const owner = st.controllerId;
            if (!owner || isController(division())) {
                if (!startBtn.disabled) startBtn.click();
                toast(`▶ ${R} round started · clock running`);
            } else {
                toast(`▶ ${R} round started · the clock is run by ${st.controllerName || 'another manager'}`);
            }
        } else if (st?.running) {
            toast(`▶ ${R} round started (clock was already running)`);
        } else {
            toast(`▶ ${R} round started`);
        }
    } catch (e) {
        toast(`Couldn't start the round: ${e.body?.error || e.message}`, true);
    } finally {
        busy = false;
    }
}

/** The clock's own Start (header clock popover) also starts the round. */
function wireClockStart() {
    if (!App.state.isSuperAdmin) return;
    const btn = document.getElementById('start-btn');
    if (!btn || btn.dataset.courtReadyWired) return;
    btn.dataset.courtReadyWired = '1';
    btn.addEventListener('click', () => {
        if (!enabled() || btn.disabled) return;
        if (clockState()?.running) return; // Start while running is a no-op
        const { R, started } = deriveBoard();
        if (R && !started) recordStart(R).catch(e => console.warn('Round start not recorded:', e.message));
    });
}

async function roundAction(action) {
    if (busy) return;
    if (action === 'clearMarks' && !confirm('Clear every "ready" mark in this division? Court statuses rebuild from the schedule.')) return;
    if (action === 'unstart' && !confirm('Undo the round start? Courts go back to waiting/ready. The clock is not changed.')) return;
    busy = true;
    try {
        const res = await courtRoundAction(token(), action, { division: division() });
        primed = false;
        applyState(res);
    } catch (e) {
        toast(`Couldn't update courts: ${e.body?.error || e.message}`, true);
    } finally {
        busy = false;
    }
}

// --- superadmin alerts ----------------------------------------------------------------

function beep() {
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        [0, 0.18].forEach((t) => {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.frequency.value = 880;
            g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
            g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + t + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.15);
            o.connect(g).connect(ctx.destination);
            o.start(ctx.currentTime + t);
            o.stop(ctx.currentTime + t + 0.16);
        });
        setTimeout(() => ctx.close(), 800);
    } catch (e) { /* audio is best-effort */ }
}

function alertOnChanges(board) {
    const nowReady = new Set(board.rows.filter(r => r.status === 'ready' && r.inR).map(r => r.court));
    const allReady = board.summary.mode === 'staging' && board.summary.allReady;
    if (!primed) {
        primed = true;
    } else if (allReady && !wasAllReady) {
        toast('🟢 All courts ready');
        beep();
        try { navigator.vibrate && navigator.vibrate([80, 60, 80]); } catch (e) { /* unsupported */ }
        try {
            if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
                new Notification('All courts ready', { body: 'Every court has both teams on it.' });
            }
        } catch (e) { /* best-effort */ }
    } else if (!allReady) {
        const fresh = [...nowReady].filter(k => !knownReady.has(k));
        if (fresh.length) toast(`Court ${fresh.join(', ')} ready`);
    }
    wasAllReady = allReady;
    knownReady = nowReady;
}

// --- superadmin board -------------------------------------------------------------------

const STATUS_STYLE = {
    ready: { label: 'READY', dot: 'var(--ok)', bg: 'rgba(46,158,99,.18)', border: 'rgba(46,158,99,.65)', text: '#B9F0D0' },
    waiting: { label: 'WAITING FOR TEAMS', dot: 'var(--gold)', bg: 'rgba(224,184,99,.12)', border: 'rgba(224,184,99,.5)', text: 'var(--gold-l)' },
    playing: { label: 'IN PLAY', dot: 'var(--warn)', bg: 'rgba(255,255,255,.05)', border: 'rgba(255,255,255,.12)', text: 'rgba(255,255,255,.8)' },
    bye: { label: 'BYE THIS ROUND', dot: 'rgba(255,255,255,.35)', bg: 'rgba(255,255,255,.03)', border: 'rgba(255,255,255,.08)', text: 'rgba(255,255,255,.5)' },
    done: { label: 'DONE', dot: 'rgba(255,255,255,.25)', bg: 'rgba(255,255,255,.03)', border: 'rgba(255,255,255,.08)', text: 'rgba(255,255,255,.4)' }
};

function matchupHtml(r, R) {
    const g = r.upNext;
    if (!g) return '';
    const when = roundOf(g) !== R ? ` <span class="text-white/40">· ${esc(roundOf(g))}</span>` : '';
    return `<div class="mt-1.5 text-[11px] leading-[1.35] text-white/75">${esc(g.team1)} <span class="text-white/40">vs</span> ${esc(g.team2)}${when}</div>`;
}

function renderBoard(panel, board) {
    const { R, started, startRec, rows, summary } = board;
    const tiles = rows.map((r) => {
        const st = STATUS_STYLE[r.status];
        const meta = r.status === 'ready' && r.mark ? `${esc(r.mark.by)} · ${ago(r.mark.at)}` : '';
        const action = (r.status === 'waiting' || r.status === 'bye')
            ? `<button type="button" data-cr-ready="${esc(r.court)}" class="mt-2 w-full rounded-full px-3 py-2 text-[11px] font-bold" style="background:rgba(46,158,99,.25);color:#B9F0D0">Mark ready</button>`
            : r.status === 'ready'
                ? `<button type="button" data-cr-unready="${esc(r.court)}" class="mt-2 w-full rounded-full px-3 py-2 text-[11px] font-semibold" style="background:rgba(255,255,255,.06);color:rgba(255,255,255,.6)">Not ready</button>`
                : '';
        return `
            <div class="rounded-[20px] border p-3" style="background:${st.bg};border-color:${st.border}">
                <div class="flex items-center justify-between gap-2">
                    <div class="text-[15px] font-extrabold text-white">Court ${esc(r.court)}</div>
                    <span class="inline-block h-2.5 w-2.5 rounded-full" style="background:${st.dot}"></span>
                </div>
                <div class="mt-1 text-[11px] font-extrabold tracking-[.08em]" style="color:${st.text}">${st.label}</div>
                ${matchupHtml(r, R)}
                ${meta ? `<div class="mt-1 text-[10px] text-white/40">${meta}</div>` : ''}
                ${action}
            </div>`;
    }).join('');

    let headline;
    if (!R) headline = '<span class="text-white">All games reported</span>';
    else if (summary.mode === 'playing') headline = `<span class="text-white">Round in play · ${summary.total - summary.inPlay} of ${summary.total} finished</span>`;
    else if (summary.allReady) headline = '<span style="color:#B9F0D0">🟢 All courts ready</span>';
    else headline = `<span class="text-white">${summary.ready} of ${summary.total} ready</span>`;

    const startedAt = startRec?.roundTime === R ? startRec.at : (Number(clockState()?.startTime) || 0);
    const startControl = !R ? ''
        : started
            ? `<span class="rounded-full border border-white/15 bg-white/[.04] px-3 py-2 text-[11px] font-semibold text-white/55">In play${startedAt ? ' since ' + esc(clockTime(startedAt)) : ''}</span>
               ${startRec?.roundTime === R ? '<button type="button" data-cr-unstart class="text-[11px] font-semibold underline text-white/45">Undo</button>' : ''}`
            : `<button type="button" data-cr-start class="rounded-full px-3.5 py-2 text-[11px] font-bold" style="background:linear-gradient(135deg,var(--gold) 0%,var(--gold-d) 100%);color:#2A1B08">▶ Start round</button>`;

    const allReadyGlow = summary.mode === 'staging' && summary.allReady;
    panel.innerHTML = `
        <section class="rounded-[26px] border p-3.5" style="background:rgba(255,255,255,.055);border-color:${allReadyGlow ? 'rgba(46,158,99,.7)' : 'rgba(255,255,255,.1)'};box-shadow:${allReadyGlow ? '0 0 0 1px rgba(46,158,99,.35),' : ''}0 14px 36px rgba(0,0,0,.26)">
            <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="min-w-0">
                    <div class="text-[10px] tracking-[.16em] font-semibold text-white/50 uppercase">Court board${R ? ' · ' + esc(R) + ' round' : ''}</div>
                    <div class="mt-0.5 text-[15px] font-extrabold">${headline}</div>
                </div>
                <div class="flex flex-none items-center gap-1.5">${startControl}</div>
            </div>
            ${rows.length
                ? `<div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">${tiles}</div>`
                : '<p class="mt-2 text-[12px] text-white/45">No courts in this division\'s schedule.</p>'}
            <div class="mt-2.5 flex justify-end">
                <button type="button" data-cr-clear class="text-[11px] font-semibold text-white/40 underline">Reset ready marks</button>
            </div>
        </section>`;
}

// --- referee bar -------------------------------------------------------------------------

function renderRefBar(panel, board) {
    const court = focusCourt || courtKey(App.state.selectedCourt);
    const r = board.rows.find(x => x.court === court);
    if (!r || r.status === 'done' || !r.upNext) {
        panel.innerHTML = '';
        return false;
    }
    const g = r.upNext;
    const teams = `${esc(g.team1)} <span class="text-white/45">vs</span> ${esc(g.team2)}`;

    if (r.status === 'playing') {
        panel.innerHTML = `
            <section class="rounded-[22px] border px-3.5 py-2.5" style="background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.12)">
                <div class="flex items-center gap-2 text-[12px] text-white/80">
                    <span class="inline-block h-2 w-2 flex-none rounded-full" style="background:var(--warn)"></span>
                    <span class="font-bold text-white">Court ${esc(court)} · in play</span>
                    <span class="min-w-0 truncate">${teams}</span>
                </div>
            </section>`;
        return true;
    }

    if (r.status === 'ready') {
        const canUndo = Date.now() < undoUntil;
        panel.innerHTML = `
            <section class="rounded-[22px] border p-3.5" style="background:rgba(46,158,99,.16);border-color:rgba(46,158,99,.6)">
                <div class="flex items-center justify-between gap-3">
                    <div class="min-w-0">
                        <div class="text-[13px] font-extrabold" style="color:#B9F0D0">✓ Court ${esc(court)} ready</div>
                        <div class="mt-0.5 text-[11px] text-white/60">${teams} · waiting on the MC to start.</div>
                    </div>
                    <button type="button" data-cr-unready="${esc(court)}" class="flex-none rounded-full border border-white/20 bg-white/[.06] px-3 py-2 text-[11px] font-semibold text-white/70">${canUndo ? 'Undo' : 'Not ready'}</button>
                </div>
            </section>`;
        return true;
    }

    const kicker = r.status === 'bye'
        ? `Court ${esc(court)} · bye this round · next at ${esc(roundOf(g))}`
        : `Court ${esc(court)} · next up${r.inR ? '' : ' at ' + esc(roundOf(g))}`;
    panel.innerHTML = `
        <section class="rounded-[22px] border p-3.5" style="background:rgba(224,184,99,.1);border-color:rgba(224,184,99,.55)">
            <div class="text-[10px] tracking-[.16em] font-semibold uppercase" style="color:var(--gold-l)">${kicker}</div>
            <div class="mt-1 text-[13px] font-semibold text-white">${teams}</div>
            <button type="button" data-cr-ready="${esc(court)}" class="mt-3 w-full rounded-full px-4 py-3.5 text-[14px] font-extrabold" style="background:linear-gradient(135deg,var(--ok) 0%,#21774a 100%);color:#fff">
                Both teams on court — Mark ready
            </button>
        </section>`;
    return true;
}

// --- render -------------------------------------------------------------------------------

export function render() {
    const panel = document.getElementById('court-ready-panel');
    if (!panel) return;
    if (!enabled() || !App.state.isAdmin) {
        panel.innerHTML = '';
        panel.classList.add('hidden');
        return;
    }
    const board = deriveBoard();
    let shown = true;
    if (App.state.isSuperAdmin) {
        alertOnChanges(board);
        renderBoard(panel, board);
        panel.style.position = '';
    } else {
        shown = renderRefBar(panel, board);
        // The referee's bar stays in reach while they scroll, under the sticky header.
        const header = document.querySelector('header.app-header');
        panel.style.position = 'sticky';
        panel.style.top = `${(header?.offsetHeight || 0) + 8}px`;
        panel.style.zIndex = '40';
    }
    panel.classList.toggle('hidden', !shown);

    if (!panel.dataset.wired) {
        panel.dataset.wired = '1';
        panel.addEventListener('click', (ev) => {
            const el = ev.target.closest('button');
            if (!el) return;
            if (el.dataset.crReady) setReady(el.dataset.crReady, true);
            else if (el.dataset.crUnready) setReady(el.dataset.crUnready, false);
            else if ('crStart' in el.dataset) startRoundFromBoard();
            else if ('crUnstart' in el.dataset) roundAction('unstart');
            else if ('crClear' in el.dataset) roundAction('clearMarks');
        });
    }
}
