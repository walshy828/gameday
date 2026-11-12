// public/js/courtReady.js
// Court readiness (optional, Setup → "Court Ready"). After a referee reports a
// game, their court goes to "reported" and they get one big button to mark it
// ready once both next teams are standing on it. The MC (superadmin) sees a
// board of every court and an "all courts ready" alert, then starts the round.
//
// State lives only on the server, in memory (server/courtStatus.js); nothing
// here touches the Google Sheet. Rendered into #court-ready-panel at the top
// of the admin match entry view.
import { getCourtStatus, setCourtStatus, courtRoundAction } from './api.js';
import { getRoundOrder, isReported as isReportedOfficial } from './schedule.js';
import { getSocket } from './socketClient.js';
import { toast } from './concessionsUi.js';

const POLL_MS = 20000;
const UNDO_MS = 10000;

let watching = false;
let courts = [];             // [{ court, status, division, nextMatch, updatedBy, updatedAt, readyAt }]
let focusCourt = null;       // referee: court of the game they last reported
let undoUntil = 0;           // referee: show "Undo" on their ready court until then
let wasAllReady = false;     // superadmin: edge-detect the "all ready" alert
let knownReady = new Set();  // superadmin: edge-detect per-court "ready" toasts
let busy = false;
let primed = false;          // superadmin: no alerts for the state found on first load
let stale = false;           // set on logout so the next sign-in refetches

function enabled() {
    return App.settings?.courtReadyEnabled === true;
}

function token() {
    return sessionStorage.getItem('adminAuthToken');
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

function isAdminReported(game) {
    const w = (game.adminWinner || '').trim();
    return isReportedOfficial(game) || (w !== '' && w !== 'TBA' && w !== '—');
}

const courtKey = (c) => String(c || '').trim();

/** Next game on the same court after `game`'s round, in the current division. */
function findNextMatch(game) {
    const schedule = App.data.allScheduleData || [];
    const order = getRoundOrder();
    const idx = order.indexOf(game.roundTime || 'TBD');
    const court = courtKey(game.court);
    let best = null;
    let bestIdx = Infinity;
    for (const g of schedule) {
        if (courtKey(g.court) !== court) continue;
        const i = order.indexOf(g.roundTime || 'TBD');
        if (i > idx && i < bestIdx) { best = g; bestIdx = i; }
    }
    return best;
}

// --- server sync -------------------------------------------------------------

function applyCourts(list) {
    courts = Array.isArray(list) ? list : [];
    if (App.state.isSuperAdmin) alertOnChanges();
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
        applyCourts(res.courts);
    } catch (e) {
        console.warn('Court status refresh failed:', e.message);
    }
}

/** Starts (once) live updates: socket push + a slow poll as fallback. Safe to call on every render. */
export function ensureCourtReadyWatch() {
    if (!App.state.isAdmin) return;
    if (watching) {
        if (stale) { stale = false; refresh(); }
        return;
    }
    watching = true;
    refresh();
    try {
        const socket = getSocket();
        socket.on('courtStatusUpdate', applyCourts);
        socket.on('connect', refresh);
        socket.on('featureSettingsUpdate', (s) => {
            if (!s) return;
            App.settings = App.settings || {};
            App.settings.courtReadyEnabled = s.courtReadyEnabled === true;
            if (!enabled()) { courts = []; wasAllReady = false; knownReady = new Set(); }
            render();
        });
    } catch (e) {
        console.warn('Court status live updates unavailable, polling only:', e.message);
    }
    setInterval(() => { if (!document.hidden && enabled()) refresh(); else render(); }, POLL_MS);
}

/** Court manager switched courts: their Mark ready bar now follows the new court. */
export function followCourt(court) {
    focusCourt = courtKey(court) || null;
    undoUntil = 0;
    render();
}

/** Current board entry for a court (or null), e.g. to warn when leaving one that's waiting. */
export function courtStatusOf(court) {
    if (!enabled()) return null;
    return courts.find(c => courtKey(c.court) === courtKey(court)) || null;
}

export function resetCourtReady() {
    courts = [];
    focusCourt = null;
    undoUntil = 0;
    wasAllReady = false;
    knownReady = new Set();
    primed = false;
    stale = true;
    const panel = document.getElementById('court-ready-panel');
    if (panel) { panel.innerHTML = ''; panel.classList.add('hidden'); }
}

async function post(court, status, extra = {}) {
    const t = token();
    if (!t) throw new Error('Not signed in.');
    const res = await setCourtStatus(t, {
        court,
        status,
        by: App.state.reporterName || localStorage.getItem('lastAdminName') || '',
        ...extra
    });
    if (res?.courts) applyCourts(res.courts);
    return res;
}

/**
 * Called by admin.js after a result saves. Puts the game's court into
 * "reported" (or "idle" if it has no next game) — unless the referee is
 * correcting an older game whose follow-up is already reported.
 */
export function onMatchSaved(game, winner) {
    if (!enabled() || !game || !courtKey(game.court) || !winner) return;
    const next = findNextMatch(game);
    if (next && isAdminReported(next)) return; // editing an old result; leave the court alone
    focusCourt = courtKey(game.court);
    undoUntil = 0;
    post(focusCourt, next ? 'reported' : 'idle', {
        division: App.config.currentSheetName,
        nextMatch: next ? { team1: next.team1, team2: next.team2, roundTime: next.roundTime, match: next.match } : null
    }).catch(e => console.warn('Court status update failed:', e.message));
}

async function markReady(court, ready = true) {
    if (busy) return;
    busy = true;
    try {
        await post(court, ready ? 'ready' : 'reported');
        if (ready) {
            try { navigator.vibrate && navigator.vibrate(40); } catch (e) { /* unsupported */ }
            if (!App.state.isSuperAdmin) {
                undoUntil = Date.now() + UNDO_MS;
                setTimeout(render, UNDO_MS + 50);
                toast(`✓ Court ${court} marked ready`, false, { label: 'Undo', run: () => markReady(court, false) });
            }
        } else {
            undoUntil = 0;
        }
        render();
    } catch (e) {
        toast(e.status === 409 ? 'Court ready is turned off.' : `Couldn't update court: ${e.body?.error || e.message}`, true);
    } finally {
        busy = false;
    }
}

async function roundAction(action) {
    const t = token();
    if (!t || busy) return;
    if (action === 'clear' && !confirm('Clear every court status on the board?')) return;
    busy = true;
    try {
        const res = await courtRoundAction(t, action, App.state.reporterName || 'MC');
        wasAllReady = false;
        knownReady = new Set();
        applyCourts(res.courts);
        if (action === 'start') toast('▶ Round started — courts set to in play');
    } catch (e) {
        toast(`Couldn't update courts: ${e.body?.error || e.message}`, true);
    } finally {
        busy = false;
    }
}

// --- superadmin board ----------------------------------------------------------

/**
 * Every court the MC should be watching: the board's courts plus any court in
 * the current division that still has an unplayed game. A scheduled court
 * that hasn't reported yet counts as "in play" so it blocks "all ready".
 */
function boardCourts() {
    const map = new Map(courts.map(c => [courtKey(c.court), c]));
    const schedule = App.data.allScheduleData || [];
    for (const g of schedule) {
        const k = courtKey(g.court);
        if (!k || map.has(k) || isAdminReported(g)) continue;
        map.set(k, { court: k, status: 'playing', implied: true });
    }
    return [...map.values()].sort((a, b) => courtKey(a.court).localeCompare(courtKey(b.court), undefined, { numeric: true }));
}

function summary(list) {
    const active = list.filter(c => c.status !== 'idle');
    const ready = active.filter(c => c.status === 'ready').length;
    return { active: active.length, ready, allReady: active.length > 0 && ready === active.length };
}

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

function alertOnChanges() {
    if (!enabled()) return;
    const list = boardCourts();
    const nowReady = new Set(list.filter(c => c.status === 'ready').map(c => courtKey(c.court)));
    const { allReady } = summary(list);
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

const STATUS_STYLE = {
    ready: { label: 'READY', dot: 'var(--ok)', bg: 'rgba(46,158,99,.18)', border: 'rgba(46,158,99,.65)', text: '#B9F0D0' },
    reported: { label: 'WAITING FOR TEAMS', dot: 'var(--gold)', bg: 'rgba(224,184,99,.12)', border: 'rgba(224,184,99,.5)', text: 'var(--gold-l)' },
    playing: { label: 'IN PLAY', dot: 'var(--warn)', bg: 'rgba(255,255,255,.05)', border: 'rgba(255,255,255,.12)', text: 'rgba(255,255,255,.75)' },
    idle: { label: 'NO NEXT GAME', dot: 'rgba(255,255,255,.35)', bg: 'rgba(255,255,255,.03)', border: 'rgba(255,255,255,.08)', text: 'rgba(255,255,255,.45)' }
};

function renderBoard(panel) {
    const list = boardCourts();
    const { active, ready, allReady } = summary(list);
    const tiles = list.map((c) => {
        const st = STATUS_STYLE[c.status] || STATUS_STYLE.playing;
        const nm = c.nextMatch;
        const when = c.status === 'ready' ? `ready ${ago(c.readyAt || c.updatedAt)}` : c.implied ? '' : ago(c.updatedAt);
        const by = c.implied ? 'not reported yet' : `${esc(c.updatedBy || '')}${when ? ' · ' + when : ''}`;
        const action = c.status === 'reported'
            ? `<button type="button" data-cr-ready="${esc(c.court)}" class="mt-2 w-full rounded-full px-3 py-2 text-[11px] font-bold" style="background:rgba(46,158,99,.25);color:#B9F0D0">Mark ready</button>`
            : c.status === 'ready'
                ? `<button type="button" data-cr-unready="${esc(c.court)}" class="mt-2 w-full rounded-full px-3 py-2 text-[11px] font-semibold" style="background:rgba(255,255,255,.06);color:rgba(255,255,255,.6)">Not ready</button>`
                : '';
        return `
            <div class="rounded-[20px] border p-3" style="background:${st.bg};border-color:${st.border}">
                <div class="flex items-center justify-between gap-2">
                    <div class="text-[15px] font-extrabold text-white">Court ${esc(c.court)}</div>
                    <span class="inline-block h-2.5 w-2.5 rounded-full" style="background:${st.dot}"></span>
                </div>
                <div class="mt-1 text-[12px] font-extrabold tracking-[.08em]" style="color:${st.text}">${st.label}</div>
                ${nm ? `<div class="mt-1.5 text-[11px] leading-[1.35] text-white/75">${esc(nm.team1)} <span class="text-white/40">vs</span> ${esc(nm.team2)}</div>` : ''}
                <div class="mt-1 text-[10px] text-white/40">${by}</div>
                ${action}
            </div>`;
    }).join('');

    const headline = allReady
        ? `<span style="color:#B9F0D0">🟢 All courts ready</span>`
        : `<span class="text-white">${ready} of ${active} ready</span>`;

    panel.innerHTML = `
        <section class="rounded-[26px] border p-3.5" style="background:rgba(255,255,255,.055);border-color:${allReady ? 'rgba(46,158,99,.7)' : 'rgba(255,255,255,.1)'};box-shadow:${allReady ? '0 0 0 1px rgba(46,158,99,.35),' : ''}0 14px 36px rgba(0,0,0,.26)">
            <div class="flex items-center justify-between gap-2">
                <div>
                    <div class="text-[10px] tracking-[.16em] font-semibold text-white/50 uppercase">Court board</div>
                    <div class="mt-0.5 text-[15px] font-extrabold">${headline}</div>
                </div>
                <div class="flex flex-none items-center gap-1.5">
                    <button type="button" data-cr-clear class="rounded-full border border-white/15 bg-white/[.06] px-3 py-2 text-[11px] font-semibold text-white/60">Clear</button>
                    <button type="button" data-cr-start class="rounded-full px-3.5 py-2 text-[11px] font-bold" style="background:linear-gradient(135deg,var(--gold) 0%,var(--gold-d) 100%);color:#2A1B08">▶ Start round</button>
                </div>
            </div>
            ${list.length
                ? `<div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">${tiles}</div>`
                : `<p class="mt-2 text-[12px] text-white/45">Courts appear here as referees report games.</p>`}
        </section>`;
}

// --- referee bar ---------------------------------------------------------------

function renderRefBar(panel) {
    const court = focusCourt || courtKey(App.state.selectedCourt);
    const c = courts.find(x => courtKey(x.court) === court);
    if (!c || (c.status !== 'reported' && c.status !== 'ready')) {
        panel.innerHTML = '';
        return false;
    }
    const nm = c.nextMatch;
    const next = nm
        ? `<div class="mt-1 text-[13px] font-semibold text-white">${esc(nm.team1)} <span class="text-white/45">vs</span> ${esc(nm.team2)}</div>`
        : '';

    if (c.status === 'ready') {
        const canUndo = Date.now() < undoUntil;
        panel.innerHTML = `
            <section class="rounded-[22px] border p-3.5" style="background:rgba(46,158,99,.16);border-color:rgba(46,158,99,.6)">
                <div class="flex items-center justify-between gap-3">
                    <div class="min-w-0">
                        <div class="text-[13px] font-extrabold" style="color:#B9F0D0">✓ Court ${esc(court)} ready</div>
                        <div class="mt-0.5 text-[11px] text-white/55">Waiting on the MC to start the round.</div>
                    </div>
                    <button type="button" data-cr-unready="${esc(court)}" class="flex-none rounded-full border border-white/20 bg-white/[.06] px-3 py-2 text-[11px] font-semibold text-white/70">${canUndo ? 'Undo' : 'Not ready'}</button>
                </div>
            </section>`;
        return true;
    }

    panel.innerHTML = `
        <section class="rounded-[22px] border p-3.5" style="background:rgba(224,184,99,.1);border-color:rgba(224,184,99,.55)">
            <div class="text-[10px] tracking-[.16em] font-semibold uppercase" style="color:var(--gold-l)">Court ${esc(court)} · next up</div>
            ${next || '<div class="mt-1 text-[13px] font-semibold text-white">Next game</div>'}
            <button type="button" data-cr-ready="${esc(court)}" class="mt-3 w-full rounded-full px-4 py-3.5 text-[14px] font-extrabold" style="background:linear-gradient(135deg,var(--ok) 0%,#21774a 100%);color:#fff">
                Both teams on court — Mark ready
            </button>
        </section>`;
    return true;
}

// --- render --------------------------------------------------------------------

export function render() {
    const panel = document.getElementById('court-ready-panel');
    if (!panel) return;
    if (!enabled() || !App.state.isAdmin) {
        panel.innerHTML = '';
        panel.classList.add('hidden');
        return;
    }
    let shown = true;
    if (App.state.isSuperAdmin) {
        renderBoard(panel);
        panel.style.position = '';
    } else {
        shown = renderRefBar(panel);
        // The referee's button stays in reach while they scroll the schedule,
        // tucked just under the sticky app header.
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
            if (el.dataset.crReady) markReady(el.dataset.crReady, true);
            else if (el.dataset.crUnready) markReady(el.dataset.crUnready, false);
            else if ('crStart' in el.dataset) roundAction('start');
            else if ('crClear' in el.dataset) roundAction('clear');
        });
    }
}
