// public/js/courtReady.js
// Court readiness (optional, Setup → "Court Ready").
//
// The board is ROUND-BASED: it shows one round at a time (the "board round"),
// in one of two phases:
//   playing — after Start round (or the clock's Start). Each court is IN PLAY
//             or FINAL (with its result). Nothing about the next round shows.
//   staging — after End round, or automatically once every game in the round
//             is reported. Courts show the round's teams (to announce) as
//             WAITING FOR TEAMS / READY; referees can only mark ready now.
// A "last round" strip lists scores still missing from earlier rounds, then
// "✓ all scores in" once they arrive.
//
// Statuses are DERIVED on every render from the schedule (which games are
// reported), the round clock, and two facts kept on the server
// (server/courtStatus.js): ready marks keyed by game, and per division the
// board's round + phase. With no board record (never used, or a server
// restart) it falls back to the earliest unreported round and the clock.
//
// Rendered into #court-ready-panel at the top of the admin match entry view:
// the MC (superadmin) gets the court board, a referee gets their court's bar.
import { getCourtStatus, setCourtMark, courtRoundAction } from './api.js';
import { isUrgentDiscrepancy } from './discrepancy.js';
import { getRoundOrder } from './schedule.js';
import { deriveBoard as deriveBoardPure, gameKeyOf, courtKey, roundOf, slotOf, slotKey, hasValue } from './courtBoard.js';
import { getSocket } from './socketClient.js';
import { getTimerSnapshot } from './timerSnapshot.js';
import { isController } from './timerControlsUI.js';
import { toast } from './concessionsUi.js';
import { courtIssueFor, refFlagUp, REASONS as ISSUE_REASONS } from './courtIssues.js';

const POLL_MS = 20000;
const UNDO_MS = 10000;          // referee "Undo" after marking ready

let watching = false;
let marks = [];              // [{ division, gameKey, court, by, at }]
let boards = {};             // { [division]: { round, phase, prevRound, at, by, canUndo } }
let earlies = [];            // [{ division, gameKey, court, at, by }] squeeze-ins
let focusCourt = null;       // referee: court of the game they last reported
let undoUntil = 0;
let busy = false;
let pending = null;           // { court, ready } while a mark request is in flight (button shows "Marking…")
let myMark = null;            // { court, at } the mark this phone just made (its Undo only removes that one)
let writeSeq = 0;             // bumped when a mark/round response lands; older in-flight refreshes are dropped
let stale = false;           // set on logout so the next sign-in refetches
let clockSig = '';
// superadmin alert edge detection
let primed = false;
let last = { allReady: false, ready: new Set(), timesUp: false, missing: 0, missingRound: null, round: undefined, phase: undefined };

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

export { gameKeyOf };

function schedule() {
    // The schedule in memory lags a division switch while loadData is in flight.
    if (App.data?.scheduleDivision && App.data.scheduleDivision !== division()) return [];
    return App.data?.allScheduleData || [];
}

/** "Semifinals · 10:45 AM" → "10:45 AM"; text without a time is returned as-is. */
function timeOnly(rt) {
    const m = /(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i.exec(rt || '');
    return m ? m[1].toUpperCase() : (rt || '');
}

function resultText(g) {
    const official = hasValue(g.winner);
    const w = (official ? g.winner : g.adminWinner || '').trim();
    const n = parseInt(official ? g.playersRemaining : g.adminPlayersRemaining) || 0;
    if (w.toLowerCase() === 'tie') return 'Tie';
    return n ? `${w} won · ${n} left` : `${w} won`;
}

// --- derived state ---------------------------------------------------------------

function clockState() {
    return getTimerSnapshot(division())?.state || null;
}

/** The whole board for the viewed division (see courtBoard.js). */
function deriveBoard() {
    return deriveBoardPure({
        games: schedule(),
        order: getRoundOrder(),
        division: division(),
        marks,
        earlies,
        rec: boards[division()] || null,
        clock: clockState()
    });
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
    boards = data.boards && typeof data.boards === 'object' ? data.boards : {};
    earlies = Array.isArray(data.earlies) ? data.earlies : [];
    render();
}

async function refresh() {
    const t = token();
    if (!App.state.isAdmin || !t) return;
    const seenWrite = writeSeq;
    try {
        const res = await getCourtStatus(t);
        if (!res.success) return;
        // A write landed while this read was in flight: the read may predate
        // it (on a slow network) and would flip the court back for a moment.
        // The write's own response is newer; the socket nudge refreshes again.
        if (seenWrite !== writeSeq) return;
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
        // Data-less nudge (the broadcast reaches public viewers too): refetch.
        socket.on('courtStatusUpdate', refresh);
        socket.on('connect', refresh);
        socket.on('featureSettingsUpdate', (s) => {
            if (!s) return;
            App.settings = App.settings || {};
            App.settings.courtReadyEnabled = s.courtReadyEnabled === true;
            if (!enabled()) { marks = []; boards = {}; earlies = []; primed = false; }
            render();
        });
    } catch (e) {
        console.warn('Court status live updates unavailable, polling only:', e.message);
    }
    // A court flag going up/down marks the board tile (and frees the ref's sticky spot).
    window.addEventListener('courtissues', render);
    // The clock changes the phase / time's up; re-render only when its state changes.
    window.addEventListener('timersnapshot', () => {
        const st = clockState();
        const sig = st ? [st.running, st.startAfterRoundRunning, st.currentRound, st.startTime, st.controllerId].join('|') : '';
        if (sig !== clockSig) { clockSig = sig; render(); }
    });
    setInterval(() => { if (!document.hidden && enabled()) refresh(); }, POLL_MS);
}

export function resetCourtReady() {
    marks = [];
    boards = {};
    earlies = [];
    focusCourt = null;
    undoUntil = 0;
    pending = null;
    myMark = null;
    primed = false;
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

function myName() {
    return App.state.reporterName || localStorage.getItem('lastAdminName') || '';
}

/**
 * Marks / unmarks a court's next game. Two referees on one court, or a slow
 * venue network, are expected: the server keeps the FIRST ready tap (later or
 * retried taps get `already`), a referee's Undo only removes the mark they
 * made, and a timed-out request is safe to tap again.
 */
async function setReady(court, ready, { onlyIfAt = null } = {}) {
    if (busy) return;
    const row = deriveBoard().rows.find(r => r.court === court);
    if (!row?.game) return;
    if (ready && row.owed?.length && !App.state.isSuperAdmin) {
        toast(`Report the ${roundOf(row.owed[0])} game on Court ${court} first`, true);
        return;
    }
    busy = true;
    pending = { court, ready };
    render();
    try {
        const res = await setCourtMark(token(), {
            division: division(),
            gameKey: gameKeyOf(row.game),
            court,
            ready,
            by: myName(),
            onlyIfAt
        });
        writeSeq++;
        pending = null;
        if (ready) {
            try { navigator.vibrate && navigator.vibrate(40); } catch (e) { /* unsupported */ }
            const already = res.already;
            // A retry after a timeout can find this phone's own earlier tap: that's a success.
            const mine = !already || (already.by && already.by === (myName() || 'Referee'));
            if (!mine) {
                undoUntil = 0;
                toast(`Court ${court} was already marked ready${already.by ? ` by ${already.by}` : ''}`);
            } else if (!App.state.isSuperAdmin) {
                myMark = { court, at: (res.mark || already).at };
                undoUntil = Date.now() + UNDO_MS;
                setTimeout(render, UNDO_MS + 50);
                toast(`✓ Court ${court} marked ready`, false, { label: 'Undo', run: () => setReady(court, false, { onlyIfAt: myMark?.court === court ? myMark.at : null }) });
            }
        } else {
            undoUntil = 0;
            myMark = null;
            if (res.kept) toast(`Court ${court} was marked ready again${res.kept.by ? ` by ${res.kept.by}` : ''} — left as ready`);
        }
        applyState(res);
    } catch (e) {
        pending = null;
        render();
        const offline = e.name === 'AbortError' || !e.status;
        toast(e.status === 409 ? 'Court ready is turned off.'
            : offline ? `No connection — Court ${court} was not ${ready ? 'marked ready' : 'changed'}. Tap again.`
            : `Couldn't update court: ${e.body?.error || e.message}`, true);
        refresh(); // the request may still have landed: show what the server has
    } finally {
        busy = false;
    }
}

/** Button label/attrs while this phone's request for `court` is in flight. */
function pendingFor(court, ready) {
    return !!pending && pending.court === court && pending.ready === ready;
}

async function post(action, extra) {
    const res = await courtRoundAction(token(), action, { division: division(), by: App.state.reporterName || 'MC', ...extra });
    writeSeq++;
    applyState(res);
    return res;
}

/** True when this tab may drive the clock (owns it, or nobody does). */
function canRunClock() {
    const st = clockState();
    return !!st && (!st.controllerId || isController(division()));
}

/** Point the clock at a board round (a start time) using that round's first schedule label. */
function setClockRoundIfMine(slot, board) {
    const st = clockState();
    if (!slot || !st || !canRunClock()) return;
    if (slotKey(st.currentRound) !== slot) window.setClockRound?.(board.firstRawOf(slot));
}

/**
 * Start round: records the start and, if this tab can run the clock and it
 * isn't running, points the clock at this round and starts it (one tap).
 */
/**
 * Playoff games in this division whose referee-reported winner differs from
 * the official one (open, not dismissed; the alert-level "Off" hides them).
 * The bracket advances the official winner, so starting/ending a round on top
 * of one asks first. Shown at the top of Admin by admin.js.
 */
function disputedPlayoffGames() {
    if (!App.state.isSuperAdmin || window.getDiscrepancyPref?.() === 'off') return [];
    return (App.data?.discrepancies || []).filter(d => d.division === division() && isUrgentDiscrepancy(d));
}

function confirmDisputes(verb) {
    const list = disputedPlayoffGames();
    if (!list.length) return true;
    const lines = list.map(d => `• ${d.match || ''} ${d.team1} vs ${d.team2}: official ${d.winner}, referee now says ${d.adminWinner}`).join('\n');
    return confirm(`Playoff winner changed — not settled yet:\n${lines}\n\nThe bracket uses the official winner. ${verb} anyway?`);
}

async function startRoundFromBoard() {
    const brd = deriveBoard();
    const { B, phase, prev } = brd;
    if (!B || phase !== 'staging' || busy) return;
    if (!confirmDisputes(`Start the ${B} round`)) return;
    busy = true;
    try {
        await post('start', { roundTime: B, prevRound: prev || '' });
        const st = clockState();
        const startBtn = document.getElementById('start-btn');
        // Point the clock at this round even if it's still running from the last one.
        setClockRoundIfMine(B, brd);
        if (st && !st.running && startBtn && canRunClock()) {
            if (!startBtn.disabled) startBtn.click();
            toast(`▶ ${B} round started · clock running`);
        } else if (st && !st.running && st.controllerId) {
            toast(`▶ ${B} round started · the clock is run by ${st.controllerName || 'another manager'}`);
        } else if (st?.running) {
            toast(`▶ ${B} round started (clock was already running)`);
        } else {
            toast(`▶ ${B} round started`);
        }
    } catch (e) {
        toast(`Couldn't start the round: ${e.body?.error || e.message}`, true);
    } finally {
        busy = false;
    }
}

/** End round: the board moves on to the next round's teams, even with a score missing. */
async function endRoundFromBoard() {
    const board = deriveBoard();
    const { B, phase, rows, nextAfter } = board;
    if (!B || phase !== 'playing' || busy) return;
    const open = rows.filter(r => r.status === 'playing');
    if (open.length) {
        const list = open.map(r => `Court ${r.court}`).join(', ');
        if (!confirm(`${list} ${open.length === 1 ? 'hasn\'t' : 'haven\'t'} reported yet.\n\nEnd the ${B} round anyway? Missing scores can still come in and show under "Last round".`)) return;
    }
    if (!confirmDisputes(`End the ${B} round`)) return;
    const next = nextAfter(B);
    busy = true;
    try {
        await post('end', { roundTime: B, nextRound: next || '' });
        setClockRoundIfMine(next, board);
        toast(next ? `Next up: ${next} round` : 'That was the last round');
    } catch (e) {
        toast(`Couldn't end the round: ${e.body?.error || e.message}`, true);
    } finally {
        busy = false;
    }
}

/** The clock's own Start (header clock popover) also starts the board round. */
function wireClockStart() {
    if (!App.state.isSuperAdmin) return;
    const btn = document.getElementById('start-btn');
    if (!btn || btn.dataset.courtReadyWired) return;
    btn.dataset.courtReadyWired = '1';
    btn.addEventListener('click', () => {
        if (!enabled() || btn.disabled || busy) return;
        if (clockState()?.running) return; // Start while running is a no-op
        const { B, phase, prev } = deriveBoard();
        if (B && phase === 'staging') post('start', { roundTime: B, prevRound: prev || '' }).catch(e => console.warn('Round start not recorded:', e.message));
    });
}

/** Start a later game now on a free court (or undo it). */
async function squeezeIn(gameKey, court, on) {
    if (busy) return;
    busy = true;
    try {
        await post(on ? 'early' : 'unearly', { gameKey, court });
        toast(on ? `⚡ Squeezed in on Court ${court}` : 'Squeeze-in undone');
    } catch (e) {
        toast(`Couldn't update the board: ${e.body?.error || e.message}`, true);
    } finally {
        busy = false;
    }
}

async function roundAction(action) {
    if (busy) return;
    if (action === 'clearMarks' && !confirm('Clear every "ready" mark in this division? The board round and scores are not changed.')) return;
    busy = true;
    try {
        await post(action, {});
    } catch (e) {
        toast(`Couldn't update the board: ${e.body?.error || e.message}`, true);
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

function buzz(pattern) {
    try { navigator.vibrate && navigator.vibrate(pattern); } catch (e) { /* unsupported */ }
}

function notify(title, body) {
    try {
        if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification(title, { body });
    } catch (e) { /* best-effort */ }
}

function alertOnChanges(board) {
    const staging = board.phase === 'staging';
    const allReady = staging && board.summary.allReady;
    const ready = new Set(staging ? board.rows.filter(r => r.status === 'ready').map(r => r.court) : []);
    const missing = board.missing.length;
    const missingRound = missing ? roundOf(board.missing[0]) : null;
    const now = { allReady, ready, timesUp: board.timesUp, missing, missingRound, round: board.B, phase: board.phase };
    // The board moved (End round / Undo / auto-advance): only the "round
    // complete" alert is about that move; the rest re-baseline silently.
    const moved = board.B !== last.round || board.phase !== last.phase;

    if (!primed) {
        primed = true;
    } else {
        if (moved) {
            if (board.advanced && board.B) {
                toast(`✓ ${board.prev} round complete · ${board.B} teams up`);
                buzz(60);
            }
        } else if (board.timesUp && !last.timesUp) {
            toast('⏱ Time\'s up · end the round to call the next teams');
            beep();
            buzz([80, 60, 80]);
            notify('Time\'s up', `End the ${board.B} round to call the next teams.`);
        } else if (allReady && !last.allReady) {
            toast('🟢 All courts ready');
            beep();
            buzz([80, 60, 80]);
            notify('All courts ready', 'Every court has both teams on it.');
        } else if (missing === 0 && last.missing > 0 && last.missingRound) {
            toast(`✓ All ${last.missingRound} scores in`);
        } else if (staging && !allReady) {
            const fresh = [...ready].filter(k => !last.ready.has(k));
            if (fresh.length) toast(`Court ${fresh.join(', ')} ready`);
        }
    }
    last = now;
}

// --- report shortcut ---------------------------------------------------------------------
// The court bar / board tiles open the same match entry modal as the list's
// Report button, for the game on that court.

function reportBtn(game, label, primary) {
    const i = (App.data?.allScheduleData || []).indexOf(game);
    if (i < 0) return '';
    const style = primary
        ? 'background:linear-gradient(135deg,var(--gold) 0%,var(--gold-d) 100%);color:#2A1B08'
        : 'background:rgba(255,255,255,.06);color:rgba(255,255,255,.7);border:1px solid rgba(255,255,255,.18)';
    return `<button type="button" data-cr-report="${i}" class="flex-none rounded-full px-3.5 py-2 text-[12px] font-bold leading-none" style="${style}">${label}</button>`;
}

// --- superadmin board -------------------------------------------------------------------

const STATUS_STYLE = {
    ready: { label: 'READY', dot: 'var(--ok)', bg: 'rgba(46,158,99,.18)', border: 'rgba(46,158,99,.65)', text: '#B9F0D0' },
    waiting: { label: 'WAITING FOR TEAMS', dot: 'var(--gold)', bg: 'rgba(224,184,99,.12)', border: 'rgba(224,184,99,.5)', text: 'var(--gold-l)' },
    playing: { label: 'IN PLAY', dot: 'var(--warn)', bg: 'rgba(255,255,255,.05)', border: 'rgba(255,255,255,.12)', text: 'rgba(255,255,255,.8)' },
    final: { label: '✓ FINAL', dot: 'var(--ok)', bg: 'rgba(255,255,255,.04)', border: 'rgba(46,158,99,.35)', text: '#B9F0D0' },
    bye: { label: 'NO GAME THIS ROUND', dot: 'rgba(255,255,255,.3)', bg: 'rgba(255,255,255,.03)', border: 'rgba(255,255,255,.08)', text: 'rgba(255,255,255,.45)' },
    none: { label: '—', dot: 'rgba(255,255,255,.25)', bg: 'rgba(255,255,255,.03)', border: 'rgba(255,255,255,.08)', text: 'rgba(255,255,255,.4)' }
};

/** "Pool A · Quarterfinals · P5" — shown when a board round mixes brackets/sub-divisions. */
function gameCaption(g) {
    const name = (g.roundTime || '').replace(/\s*[·|•\-–—]?\s*\d{1,2}:\d{2}\s*(AM|PM)?\s*/i, ' ').replace(/^P\s*\d+\s*[.\-:_]?\s*/i, '').trim();
    const match = /^P\s*\d+$/i.test((g.match || '').trim()) ? g.match.trim() : '';
    return [g.subDivision, name, match].filter(Boolean).join(' · ');
}

function tileHtml(r, phase, showCaption) {
    const st = r.early ? { ...STATUS_STYLE.playing, label: 'IN PLAY · SQUEEZED IN' } : STATUS_STYLE[r.status];
    const g = r.game;
    let body = '';
    if (g && r.status === 'final') {
        body = `<div class="mt-1.5 text-[11px] leading-[1.35] text-white/55">${esc(g.team1)} <span class="text-white/35">vs</span> ${esc(g.team2)}</div>
                <div class="mt-1 text-[12px] font-bold text-white">${esc(resultText(g))}</div>
                ${g.adminName ? `<div class="mt-0.5 text-[10px] text-white/40">${esc(g.adminName)}</div>` : ''}`;
    } else if (g && phase === 'staging') {
        // Big, readable names so the MC can announce the round from here.
        body = `<div class="mt-1.5 text-[14px] font-extrabold leading-[1.25] text-white">${esc(g.team1)}</div>
                <div class="text-[10px] font-semibold text-white/40">vs</div>
                <div class="text-[14px] font-extrabold leading-[1.25] text-white">${esc(g.team2)}</div>
                ${r.mark ? `<div class="mt-1 text-[10px] text-white/45">${esc(r.mark.by)} · ${ago(r.mark.at)}</div>` : ''}`;
    } else if (g) {
        body = `<div class="mt-1.5 text-[11px] leading-[1.35] text-white/75">${esc(g.team1)} <span class="text-white/40">vs</span> ${esc(g.team2)}</div>`;
    } else if (r.later) {
        body = `<div class="mt-1.5 text-[10px] text-white/40">Next: ${esc(roundOf(r.later))}</div>`;
    }
    const action = r.status === 'playing'
        ? `<div class="mt-2 flex">${reportBtn(g, 'Report', true).replace('flex-none', 'w-full')}</div>`
        : r.status === 'final'
        ? `<div class="mt-2 flex justify-end">${reportBtn(g, 'Edit', false)}</div>`
        : r.status === 'waiting'
        ? `<button type="button" data-cr-ready="${esc(r.court)}" ${pendingFor(r.court, true) ? 'disabled aria-busy="true"' : ''} class="mt-2 w-full rounded-full px-3 py-2 text-[11px] font-bold disabled:opacity-60" style="background:rgba(46,158,99,.25);color:#B9F0D0">${pendingFor(r.court, true) ? 'Marking…' : 'Mark ready'}</button>`
        : r.status === 'ready'
            ? `<button type="button" data-cr-unready="${esc(r.court)}" ${pendingFor(r.court, false) ? 'disabled aria-busy="true"' : ''} class="mt-2 w-full rounded-full px-3 py-2 text-[11px] font-semibold disabled:opacity-60" style="background:rgba(255,255,255,.06);color:rgba(255,255,255,.6)">${pendingFor(r.court, false) ? 'Updating…' : 'Not ready'}</button>`
            : '';
    const disputed = g && disputedPlayoffGames().some(d => String(d.firebaseIndex) === String(g.firebaseIndex));
    const dispute = disputed
        ? `<div class="mt-2 rounded-[12px] px-2 py-1.5 text-[10px] font-bold leading-[1.3]" style="background:rgba(217,80,60,.18);color:#FFB4A6">⚠ Winner changed — see top</div>`
        : '';
    const issue = courtIssueFor(r.court);
    const flag = issue
        ? `<div class="mt-2 rounded-[12px] px-2 py-1.5 text-[10px] font-bold leading-[1.3]" style="background:rgba(217,80,60,.28);color:#FFD2C8">✋ Flag up · ${esc((ISSUE_REASONS.find(x => x.key === issue.reason) || {}).label || 'Other')}${issue.ackAt ? ` · ${esc(issue.ackBy || 'MC')} on the way` : ''}</div>`
        : '';
    const owed = r.owed?.length
        ? `<div class="mt-2 rounded-[12px] px-2 py-1.5 text-[10px] font-bold leading-[1.3]" style="background:rgba(217,80,60,.18);color:#FFB4A6">⚠ ${esc(roundOf(r.owed[0]))} score missing${r.owed.length > 1 ? ` (+${r.owed.length - 1})` : ''}</div>
           <div class="mt-1.5 flex">${reportBtn(r.owed[0], `Report ${esc(timeOnly(roundOf(r.owed[0])))}`, true).replace('flex-none', 'w-full')}</div>`
        : '';
    return `
        <div class="rounded-[20px] border p-3" style="background:${st.bg};border-color:${issue ? 'rgba(255,120,100,.95)' : r.owed?.length ? 'rgba(217,80,60,.65)' : st.border}${issue ? ';box-shadow:0 0 0 2px rgba(217,80,60,.35)' : ''}">
            <div class="flex items-center justify-between gap-2">
                <div class="text-[15px] font-extrabold text-white">Court ${esc(r.court)}</div>
                <span class="inline-block h-2.5 w-2.5 rounded-full" style="background:${st.dot}"></span>
            </div>
            <div class="mt-1 text-[11px] font-extrabold tracking-[.08em]" style="color:${st.text}">${st.label}</div>
            ${g && (showCaption || r.early) && gameCaption(g) ? `<div class="mt-0.5 text-[10px] font-semibold text-white/45">${esc(gameCaption(g))}</div>` : ''}
            ${r.early ? `<button type="button" data-cr-unearly="${esc(gameKeyOf(g))}" class="mt-1 text-[10px] font-semibold underline text-white/40">Undo squeeze-in</button>` : ''}
            ${body}
            ${flag}
            ${dispute}
            ${owed}
            ${action}
        </div>`;
}

function lastRoundStrip(board) {
    const { missing, prevInfo, phase } = board;
    if (missing.length) {
        const first = missing[0];
        const round = slotOf(first);
        const inThat = missing.filter(g => slotOf(g) === round);
        const total = schedule().filter(g => slotOf(g) === round).length;
        const who = inThat.map(g => `Court ${esc(courtKey(g.court))} (${esc(g.team1)} vs ${esc(g.team2)})`).join(', ');
        const older = missing.length > inThat.length ? ` · +${missing.length - inThat.length} from earlier rounds` : '';
        return `<div class="mt-2.5 rounded-[14px] border px-3 py-2 text-[11px] leading-[1.4]" style="border-color:rgba(217,80,60,.45);background:rgba(217,80,60,.1);color:rgba(255,255,255,.85)">
                <span class="font-bold">${esc(round)} round: ${total - inThat.length} of ${total} final</span> · waiting on ${who}${older}</div>`;
    }
    if (prevInfo && phase === 'staging') {
        return `<div class="mt-2.5 rounded-[14px] border px-3 py-2 text-[11px] font-semibold" style="border-color:rgba(46,158,99,.4);background:rgba(46,158,99,.1);color:#B9F0D0">✓ ${esc(prevInfo.round)} round: all scores in</div>`;
    }
    return '';
}

/** "⚡ Court 3 is free · start Quarterfinals P9 · Ducks vs Owls now?" */
function squeezeStrip(board) {
    if (!board.squeeze.length) return '';
    return board.squeeze.map(({ court, game }) => `
        <div class="mt-2.5 flex items-center justify-between gap-2 rounded-[14px] border px-3 py-2" style="border-color:rgba(224,184,99,.5);background:rgba(224,184,99,.08)">
            <div class="min-w-0 text-[11px] leading-[1.4] text-white/85">
                <span class="font-bold" style="color:var(--gold-l)">⚡ Court ${esc(court)} is free</span> · squeeze in ${esc(gameCaption(game) || roundOf(game))}:
                <span class="font-semibold text-white">${esc(game.team1)} vs ${esc(game.team2)}</span>
            </div>
            <button type="button" data-cr-early="${esc(gameKeyOf(game))}" data-court="${esc(court)}" class="flex-none rounded-full px-3 py-2 text-[11px] font-bold" style="background:linear-gradient(135deg,var(--gold) 0%,var(--gold-d) 100%);color:#2A1B08">Start on Court ${esc(court)}</button>
        </div>`).join('');
}

function renderBoard(panel, board) {
    const { B, phase, rows, summary, rec, timesUp, canUndo } = board;
    // Captions only matter when one board round mixes brackets / sub-divisions.
    const inB = rows.filter(r => r.game && r.inR).map(r => r.game);
    const showCaption = new Set(inB.map(g => `${g.subDivision || ''}|${roundOf(g)}`)).size > 1;

    let headline;
    if (!B) headline = '<span class="text-white">All rounds played</span>';
    else if (phase === 'playing') headline = `<span class="text-white">In play · ${summary.final} of ${summary.total} final</span>`;
    else if (summary.allReady) headline = '<span style="color:#B9F0D0">🟢 All courts ready</span>';
    else headline = `<span class="text-white">Teams up · ${summary.ready} of ${summary.total} ready</span>`;

    const sinceTs = rec && rec.phase === 'playing' && rec.round === B ? rec.at : 0;
    const undo = canUndo ? '<button type="button" data-cr-undo class="text-[11px] font-semibold underline text-white/45">Undo</button>' : '';
    let control = '';
    if (B && phase === 'playing') {
        const style = timesUp
            ? 'background:linear-gradient(135deg,var(--gold) 0%,var(--gold-d) 100%);color:#2A1B08;box-shadow:0 0 0 3px rgba(224,184,99,.35)'
            : 'background:rgba(255,255,255,.08);color:#fff;border:1px solid rgba(255,255,255,.2)';
        control = `${undo}<button type="button" data-cr-end class="rounded-full px-3.5 py-2 text-[11px] font-bold ${timesUp ? 'animate-pulse' : ''}" style="${style}">${timesUp ? '⏱ Time\'s up · End round →' : 'End round →'}</button>`;
    } else if (B) {
        control = `${undo}<button type="button" data-cr-start class="rounded-full px-3.5 py-2 text-[11px] font-bold" style="background:linear-gradient(135deg,var(--gold) 0%,var(--gold-d) 100%);color:#2A1B08">▶ Start round</button>`;
    }

    const kicker = B ? `${esc(B)} round · ${phase === 'playing' ? `in play${sinceTs ? ' since ' + esc(clockTime(sinceTs)) : ''}` : 'up next'}` : 'Court board';
    const glow = phase === 'staging' && summary.allReady;
    panel.innerHTML = `
        <section class="rounded-[26px] border p-3.5" style="background:rgba(255,255,255,.055);border-color:${glow ? 'rgba(46,158,99,.7)' : 'rgba(255,255,255,.1)'};box-shadow:${glow ? '0 0 0 1px rgba(46,158,99,.35),' : ''}0 14px 36px rgba(0,0,0,.26)">
            <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="min-w-0">
                    <div class="text-[10px] tracking-[.16em] font-semibold text-white/50 uppercase">${kicker}</div>
                    <div class="mt-0.5 text-[15px] font-extrabold">${headline}</div>
                </div>
                <div class="flex flex-none items-center gap-2">${control}</div>
            </div>
            ${lastRoundStrip(board)}
            ${squeezeStrip(board)}
            ${B && rows.length
                ? `<div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">${rows.map(r => tileHtml(r, phase, showCaption)).join('')}</div>`
                : (B ? '<p class="mt-2 text-[12px] text-white/45">No courts in this division\'s schedule.</p>' : '')}
            ${B && phase === 'staging' ? `<div class="mt-2.5 flex justify-end">
                <button type="button" data-cr-clear class="text-[11px] font-semibold text-white/40 underline">Reset ready marks</button>
            </div>` : ''}
        </section>`;
}

// --- referee bar -------------------------------------------------------------------------

function compactBar(dot, html, action = '') {
    return `
        <section class="rounded-[22px] border px-3.5 py-2.5" style="background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.12)">
            <div class="flex items-center gap-2 text-[12px] text-white/75">
                <span class="inline-block h-2 w-2 flex-none rounded-full" style="background:${dot}"></span>
                <span class="min-w-0 flex-1">${html}</span>
                ${action}
            </div>
        </section>`;
}

function renderRefBar(panel, board) {
    const court = focusCourt || courtKey(App.state.selectedCourt);
    const r = board.rows.find(x => x.court === court);
    if (!r) { panel.innerHTML = ''; return false; }
    if (r.status === 'none') {
        panel.innerHTML = compactBar('rgba(255,255,255,.3)', `<span class="font-bold text-white">Court ${esc(court)}</span> · all rounds played`);
        return true;
    }
    const g = r.game;
    const teams = g ? `${esc(g.team1)} <span class="text-white/45">vs</span> ${esc(g.team2)}` : '';

    // A score from an earlier round is still missing on this court (the MC
    // ended the round or time ran out first): report it before anything else.
    if (r.owed?.length) {
        const o = r.owed[0];
        const more = r.owed.length > 1 ? ` (+${r.owed.length - 1} more)` : '';
        const nextUp = g && (r.status === 'waiting' || r.status === 'ready')
            ? `<div class="mt-2.5 border-t pt-2 text-[11px] leading-[1.4] text-white/50" style="border-color:rgba(255,255,255,.1)">Next up: ${teams} · mark ready once this score is in</div>`
            : '';
        panel.innerHTML = `
            <section class="rounded-[22px] border p-3.5" style="background:rgba(217,80,60,.14);border-color:rgba(217,80,60,.65)">
                <div class="text-[10px] tracking-[.16em] font-semibold uppercase" style="color:#FFB4A6">Court ${esc(court)} · ${esc(roundOf(o))} score not reported${esc(more)}</div>
                <div class="mt-1 text-[13px] font-semibold text-white">${esc(o.team1)} <span class="text-white/45">vs</span> ${esc(o.team2)}</div>
                <div class="mt-3 flex">${reportBtn(o, `Report ${esc(timeOnly(roundOf(o)))} score`, true).replace('flex-none', 'w-full py-3.5 text-[14px]')}</div>
                ${nextUp}
            </section>`;
        return true;
    }

    if (r.status === 'bye') {
        panel.innerHTML = compactBar('rgba(255,255,255,.35)', `<span class="font-bold text-white">Court ${esc(court)} · no game this round</span>${r.later ? ` · next at ${esc(roundOf(r.later))}` : ''}`);
        return true;
    }
    if (r.status === 'playing') {
        panel.innerHTML = compactBar('var(--warn)', `<span class="font-bold text-white">Court ${esc(court)} · in play</span><br>${teams}`, reportBtn(g, 'Report', true));
        return true;
    }
    if (r.status === 'final') {
        const note = board.phase === 'staging' ? 'already reported' : 'next round\'s teams come up when the round ends';
        panel.innerHTML = compactBar('var(--ok)', `<span class="font-bold" style="color:#B9F0D0">✓ Court ${esc(court)} final · ${esc(resultText(g))}</span><br>${note}`, reportBtn(g, 'Edit', false));
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
                        ${r.mark?.by ? `<div class="mt-0.5 text-[10px] text-white/45">Marked by ${esc(r.mark.by)} · ${ago(r.mark.at)}</div>` : ''}
                    </div>
                    <button type="button" data-cr-unready="${esc(court)}" ${canUndo ? 'data-cr-undo-mine' : ''} ${pendingFor(court, false) ? 'disabled aria-busy="true"' : ''} class="flex-none rounded-full border border-white/20 bg-white/[.06] px-3 py-2 text-[11px] font-semibold text-white/70 disabled:opacity-60">${pendingFor(court, false) ? 'Updating…' : canUndo ? 'Undo' : 'Not ready'}</button>
                </div>
            </section>`;
        return true;
    }
    // waiting
    panel.innerHTML = `
        <section class="rounded-[22px] border p-3.5" style="background:rgba(224,184,99,.1);border-color:rgba(224,184,99,.55)">
            <div class="text-[10px] tracking-[.16em] font-semibold uppercase" style="color:var(--gold-l)">Court ${esc(court)} · ${esc(board.B)} round · next up</div>
            <div class="mt-1 text-[13px] font-semibold text-white">${teams}</div>
            <button type="button" data-cr-ready="${esc(court)}" ${pendingFor(court, true) ? 'disabled aria-busy="true"' : ''} class="mt-3 w-full rounded-full px-4 py-3.5 text-[14px] font-extrabold disabled:opacity-70" style="background:linear-gradient(135deg,var(--ok) 0%,#21774a 100%);color:#fff">
                ${pendingFor(court, true) ? 'Marking ready…' : 'Both teams on court — Mark ready'}
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
        // The referee's bar stays in reach while they scroll, under the sticky
        // header — unless their court has an issue flag up, which takes that spot.
        const header = document.querySelector('header.app-header');
        panel.style.position = refFlagUp() ? '' : 'sticky';
        panel.style.top = `${(header?.offsetHeight || 0) + 8}px`;
        panel.style.zIndex = '40';
    }
    panel.classList.toggle('hidden', !shown);

    if (!panel.dataset.wired) {
        panel.dataset.wired = '1';
        panel.addEventListener('click', (ev) => {
            const el = ev.target.closest('button');
            if (!el) return;
            if (el.dataset.crReport !== undefined) window.showMatchEntryModal?.(Number(el.dataset.crReport));
            else if (el.dataset.crReady) setReady(el.dataset.crReady, true);
            else if (el.dataset.crUnready) {
                const c = el.dataset.crUnready;
                // Undo (shortly after this phone marked it) only removes this phone's own mark.
                const own = 'crUndoMine' in el.dataset && myMark?.court === c ? myMark.at : null;
                setReady(c, false, { onlyIfAt: own });
            }
            else if ('crStart' in el.dataset) startRoundFromBoard();
            else if ('crEnd' in el.dataset) endRoundFromBoard();
            else if ('crUndo' in el.dataset) roundAction('undo');
            else if ('crClear' in el.dataset) roundAction('clearMarks');
            else if (el.dataset.crEarly) squeezeIn(el.dataset.crEarly, el.dataset.court, true);
            else if (el.dataset.crUnearly) squeezeIn(el.dataset.crUnearly, '', false);
        });
    }
}
