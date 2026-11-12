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
import { getRoundOrder, isReported as isReportedOfficial } from './schedule.js';
import { getSocket } from './socketClient.js';
import { getTimerSnapshot } from './timerSnapshot.js';
import { isController } from './timerControlsUI.js';
import { toast } from './concessionsUi.js';

const POLL_MS = 20000;
const UNDO_MS = 10000;          // referee "Undo" after marking ready
const ROUND_UNDO_MS = 2 * 60000; // MC "Undo" after Start/End round
const CLOCK_START_SLACK_MS = 5000;

let watching = false;
let marks = [];              // [{ division, gameKey, court, by, at }]
let boards = {};             // { [division]: { round, phase, prevRound, at, by, canUndo } }
let focusCourt = null;       // referee: court of the game they last reported
let undoUntil = 0;
let busy = false;
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

/** The clock is running its main segment on round B, started after the board record. */
function clockPlaying(B, rec) {
    const st = clockState();
    if (!B || !st?.running || st.startAfterRoundRunning) return false;
    if ((st.currentRound || '').trim() !== B) return false;
    return !rec || (Number(st.startTime) || 0) > (rec.at || 0) + CLOCK_START_SLACK_MS;
}

function markFor(game) {
    const key = gameKeyOf(game);
    const div = division();
    return marks.find(m => m.division === div && m.gameKey === key) || null;
}

/** The whole board for the viewed division: round, phase, per-court rows, summaries. */
function deriveBoard() {
    const games = schedule();
    const order = getRoundOrder();
    const idx = (r) => order.indexOf(r);
    const inRound = (R) => games.filter(g => roundOf(g) === R);
    const allDone = (R) => { const l = inRound(R); return l.length > 0 && l.every(isDone); };
    const nextAfter = (R) => (idx(R) >= 0 ? order[idx(R) + 1] : undefined) || null;
    const prevOf = (R) => (idx(R) > 0 ? order[idx(R) - 1] : null);
    const live = order.find(R => inRound(R).some(g => !isDone(g))) || null;

    const rec = boards[division()] || null;
    const recValid = rec && (rec.round === '' || idx(rec.round) >= 0);
    let B, phase, prev;
    if (recValid) {
        B = rec.round || null;
        phase = rec.phase;
        prev = rec.prevRound || prevOf(B);
    } else {
        B = live;
        prev = prevOf(B);
        phase = clockPlaying(B, null) ? 'playing' : 'staging';
    }
    // The clock was started somewhere that didn't record it.
    if (phase === 'staging' && clockPlaying(B, recValid ? rec : null)) phase = 'playing';
    // Every game in the board round is in: move on by itself.
    let advanced = false;
    while (B && allDone(B)) {
        prev = B;
        B = nextAfter(B);
        phase = 'staging';
        advanced = true;
    }

    const courts = [...new Set(games.map(g => courtKey(g.court)).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const rows = courts.map((court) => {
        const g = B ? games.find(x => roundOf(x) === B && courtKey(x.court) === court) : null;
        if (!B) return { court, status: 'none', game: null, inR: false };
        if (!g) {
            const later = games.filter(x => courtKey(x.court) === court && idx(roundOf(x)) > idx(B) && !isDone(x))
                .sort((a, b) => idx(roundOf(a)) - idx(roundOf(b)))[0] || null;
            return { court, status: 'bye', game: null, later, inR: false };
        }
        const mark = markFor(g);
        let status;
        if (isDone(g)) status = 'final';
        else if (phase === 'playing') status = 'playing';
        else status = mark ? 'ready' : 'waiting';
        return { court, status, game: g, mark, inR: true };
    });

    const withGame = rows.filter(r => r.game);
    const summary = phase === 'playing'
        ? { final: withGame.filter(r => r.status === 'final').length, total: withGame.length }
        : (() => {
            const open = withGame.filter(r => r.status !== 'final');
            const ready = open.filter(r => r.status === 'ready').length;
            return { ready, total: open.length, allReady: open.length > 0 && ready === open.length };
        })();

    // Scores still missing from rounds before the board round.
    const missing = games.filter(g => !isDone(g) && (B ? idx(roundOf(g)) < idx(B) : true))
        .sort((a, b) => idx(roundOf(a)) - idx(roundOf(b)) || courtKey(a.court).localeCompare(courtKey(b.court), undefined, { numeric: true }));
    const prevGames = prev ? inRound(prev) : [];
    const prevInfo = prev ? { round: prev, final: prevGames.filter(isDone).length, total: prevGames.length } : null;

    // Time's up: the clock that ran this round has stopped or is in the after-round break.
    const st = clockState();
    const clockForRound = !!st && !!B && (st.currentRound || '').trim() === B
        && (Number(st.startTime) || 0) >= ((recValid && rec.phase === 'playing' ? rec.at : 0) - CLOCK_START_SLACK_MS);
    const timesUp = phase === 'playing' && clockForRound && (!st.running || !!st.startAfterRoundRunning);

    const canUndo = !!(recValid && rec.canUndo && !advanced && Date.now() - (rec.at || 0) < ROUND_UNDO_MS);
    return { B, phase, prev, rec: recValid ? rec : null, advanced, rows, summary, missing, prevInfo, timesUp, canUndo, nextAfter };
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
            if (!enabled()) { marks = []; boards = {}; primed = false; }
            render();
        });
    } catch (e) {
        console.warn('Court status live updates unavailable, polling only:', e.message);
    }
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
    focusCourt = null;
    undoUntil = 0;
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

async function setReady(court, ready) {
    if (busy) return;
    const row = deriveBoard().rows.find(r => r.court === court);
    if (!row?.game) return;
    busy = true;
    try {
        const res = await setCourtMark(token(), {
            division: division(),
            gameKey: gameKeyOf(row.game),
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

async function post(action, extra) {
    const res = await courtRoundAction(token(), action, { division: division(), by: App.state.reporterName || 'MC', ...extra });
    applyState(res);
    return res;
}

/** True when this tab may drive the clock (owns it, or nobody does). */
function canRunClock() {
    const st = clockState();
    return !!st && (!st.controllerId || isController(division()));
}

function setClockRoundIfMine(round) {
    const st = clockState();
    if (!round || !st || !canRunClock()) return;
    if ((st.currentRound || '').trim() !== round) window.setClockRound?.(round);
}

/**
 * Start round: records the start and, if this tab can run the clock and it
 * isn't running, points the clock at this round and starts it (one tap).
 */
async function startRoundFromBoard() {
    const { B, phase, prev } = deriveBoard();
    if (!B || phase !== 'staging' || busy) return;
    busy = true;
    try {
        await post('start', { roundTime: B, prevRound: prev || '' });
        const st = clockState();
        const startBtn = document.getElementById('start-btn');
        if (st && !st.running && startBtn && canRunClock()) {
            setClockRoundIfMine(B);
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
    const next = nextAfter(B);
    busy = true;
    try {
        await post('end', { roundTime: B, nextRound: next || '' });
        setClockRoundIfMine(next);
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

// --- superadmin board -------------------------------------------------------------------

const STATUS_STYLE = {
    ready: { label: 'READY', dot: 'var(--ok)', bg: 'rgba(46,158,99,.18)', border: 'rgba(46,158,99,.65)', text: '#B9F0D0' },
    waiting: { label: 'WAITING FOR TEAMS', dot: 'var(--gold)', bg: 'rgba(224,184,99,.12)', border: 'rgba(224,184,99,.5)', text: 'var(--gold-l)' },
    playing: { label: 'IN PLAY', dot: 'var(--warn)', bg: 'rgba(255,255,255,.05)', border: 'rgba(255,255,255,.12)', text: 'rgba(255,255,255,.8)' },
    final: { label: '✓ FINAL', dot: 'var(--ok)', bg: 'rgba(255,255,255,.04)', border: 'rgba(46,158,99,.35)', text: '#B9F0D0' },
    bye: { label: 'NO GAME THIS ROUND', dot: 'rgba(255,255,255,.3)', bg: 'rgba(255,255,255,.03)', border: 'rgba(255,255,255,.08)', text: 'rgba(255,255,255,.45)' },
    none: { label: '—', dot: 'rgba(255,255,255,.25)', bg: 'rgba(255,255,255,.03)', border: 'rgba(255,255,255,.08)', text: 'rgba(255,255,255,.4)' }
};

function tileHtml(r, phase) {
    const st = STATUS_STYLE[r.status];
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
    const action = r.status === 'waiting'
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
            ${body}
            ${action}
        </div>`;
}

function lastRoundStrip(board) {
    const { missing, prevInfo, phase } = board;
    if (missing.length) {
        const first = missing[0];
        const round = roundOf(first);
        const inThat = missing.filter(g => roundOf(g) === round);
        const total = schedule().filter(g => roundOf(g) === round).length;
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

function renderBoard(panel, board) {
    const { B, phase, rows, summary, rec, timesUp, canUndo } = board;

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
            ${B && rows.length
                ? `<div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">${rows.map(r => tileHtml(r, phase)).join('')}</div>`
                : (B ? '<p class="mt-2 text-[12px] text-white/45">No courts in this division\'s schedule.</p>' : '')}
            ${B && phase === 'staging' ? `<div class="mt-2.5 flex justify-end">
                <button type="button" data-cr-clear class="text-[11px] font-semibold text-white/40 underline">Reset ready marks</button>
            </div>` : ''}
        </section>`;
}

// --- referee bar -------------------------------------------------------------------------

function compactBar(dot, html) {
    return `
        <section class="rounded-[22px] border px-3.5 py-2.5" style="background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.12)">
            <div class="flex items-center gap-2 text-[12px] text-white/75">
                <span class="inline-block h-2 w-2 flex-none rounded-full" style="background:${dot}"></span>
                <span class="min-w-0">${html}</span>
            </div>
        </section>`;
}

function renderRefBar(panel, board) {
    const court = focusCourt || courtKey(App.state.selectedCourt);
    const r = board.rows.find(x => x.court === court);
    if (!r || r.status === 'none') { panel.innerHTML = ''; return false; }
    const g = r.game;
    const teams = g ? `${esc(g.team1)} <span class="text-white/45">vs</span> ${esc(g.team2)}` : '';

    if (r.status === 'bye') {
        panel.innerHTML = compactBar('rgba(255,255,255,.35)', `<span class="font-bold text-white">Court ${esc(court)} · no game this round</span>${r.later ? ` · next at ${esc(roundOf(r.later))}` : ''}`);
        return true;
    }
    if (r.status === 'playing') {
        panel.innerHTML = compactBar('var(--warn)', `<span class="font-bold text-white">Court ${esc(court)} · in play</span> · ${teams}`);
        return true;
    }
    if (r.status === 'final') {
        if (board.phase === 'staging') { panel.innerHTML = ''; return false; }
        panel.innerHTML = compactBar('var(--ok)', `<span class="font-bold" style="color:#B9F0D0">✓ Court ${esc(court)} final</span> · next round's teams come up when the round ends`);
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
    // waiting
    panel.innerHTML = `
        <section class="rounded-[22px] border p-3.5" style="background:rgba(224,184,99,.1);border-color:rgba(224,184,99,.55)">
            <div class="text-[10px] tracking-[.16em] font-semibold uppercase" style="color:var(--gold-l)">Court ${esc(court)} · ${esc(board.B)} round · next up</div>
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
            else if ('crEnd' in el.dataset) endRoundFromBoard();
            else if ('crUndo' in el.dataset) roundAction('undo');
            else if ('crClear' in el.dataset) roundAction('clearMarks');
        });
    }
}
