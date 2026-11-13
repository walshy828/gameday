// public/js/myTeam.js
// The "My team" card for the team followed on this phone (follow.js) — for
// parents and coaches, no login. Shown at the top of Standings and Schedule.
// It answers "where do we need to be, and when": playing now, being called
// to a court, ready on court, game over, byes (with time off), next game, and
// the playoff path (seed, round, opponent or feeder game, advanced,
// eliminated, finalists, champions).
//
// Everything is derived from data the app already has: the schedule, the
// round clock, and — when Court Ready is on — the court board's round/phase
// and ready marks via the public, name-free GET /api/courtStatus/public. The
// board rules are the shared courtBoard.js, so this card always agrees with
// the MC board and the referee bar.
//
// Results: playoff progress (advanced / eliminated / champions) uses OFFICIAL
// results only, like the public games page. A referee-reported score shows as
// "Game over · result pending" until it's official.
import { getPublicCourtStatus } from './api.js';
import { getRoundOrder } from './schedule.js';
import { getSocket } from './socketClient.js';
import { trafficPollFactor } from './presence.js';
import { getTimerSnapshot } from './timerSnapshot.js';
import { deriveBoard, isDone, roundOf, slotOf, courtKey, hasValue } from './courtBoard.js';
import { getFollowed, isFollowed, isSignedIn, openFollowPicker } from './follow.js';
import {
    buildBracketTree, isPlayoff, isOfficial, isByeSlot, isRealTeamSlot,
    teamSeed, teamLabel, cleanRoundLabel, defaultRoundLabel
} from './playoffs.js';

const POLL_MS = 30000;
const CONTAINERS = ['my-team-card-standings', 'my-team-card-schedule'];

let pub = { division: null, enabled: false, board: null, marks: [], earlies: [] };
let watching = false;
let fetching = false;
let clockSig = '';
let lastAlertKey = '';

// --- small helpers -----------------------------------------------------------------

function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function division() {
    return App.config?.currentSheetName || '';
}

function schedule() {
    if (App.data?.scheduleDivision && App.data.scheduleDivision !== division()) return [];
    return App.data?.allScheduleData || [];
}

/** "Round of 16 · 12:25 PM" → "12:25 PM"; text without a time is returned as-is. */
function timeLabel(rt) {
    const m = /(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i.exec(rt || '');
    return m ? m[1].toUpperCase().replace(/\s+/, ' ') : (rt || '');
}

function minutesOf(rt) {
    const m = /(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(rt || '');
    if (!m) return null;
    let h = +m[1];
    const ap = (m[3] || '').toUpperCase();
    if (ap === 'PM' && h !== 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    return h * 60 + +m[2];
}

function ordinal(n) {
    const v = +n;
    if (!v) return String(n);
    const s = ['th', 'st', 'nd', 'rd'], r = v % 100;
    return v + (s[(r - 20) % 10] || s[r] || s[0]);
}

const isMine = (g) => isFollowed(g.team1) || isFollowed(g.team2);
const opponentOf = (g) => (isFollowed(g.team1) ? g.team2 : g.team1) || 'TBD';
const courtOf = (g) => courtKey(g.court);

/** Official result from the followed team's side. */
function officialOutcome(g) {
    if (!isOfficial(g)) return null;
    const w = (g.winner || '').trim();
    if (w.toLowerCase() === 'tie') return 'tie';
    return isFollowed(w) ? 'won' : 'lost';
}

function singular(label) {
    return (label || '').replace(/^(Semi|Quarter)finals$/i, (m, p) => `${p}final`).replace(/^Finals$/i, 'Final');
}

// --- data ---------------------------------------------------------------------------

async function refresh() {
    const d = division();
    if (!d || !getFollowed() || fetching) return;
    fetching = true;
    try {
        const res = await getPublicCourtStatus(d);
        if (res?.success) pub = { division: d, enabled: !!res.enabled, board: res.board || null, marks: res.marks || [], earlies: res.earlies || [] };
    } catch (e) {
        // Offline / server hiccup: keep the last known board; the card still works from the schedule.
    } finally {
        fetching = false;
    }
    renderMyTeam();
}

function startWatch() {
    if (watching) return;
    watching = true;
    try {
        const socket = getSocket();
        socket.on('courtStatusUpdate', refresh);
        socket.on('connect', refresh);
    } catch (e) { /* polling only */ }
    window.addEventListener('timersnapshot', () => {
        const st = getTimerSnapshot(division())?.state;
        const sig = st ? [st.running, st.startAfterRoundRunning, st.currentRound, st.startTime].join('|') : '';
        if (sig !== clockSig) { clockSig = sig; renderMyTeam(); }
    });
    // Under traffic priority (Ease/Protect) the server asks public tabs to poll less often.
    let ticks = 0;
    setInterval(() => {
        ticks++;
        if (ticks % trafficPollFactor() !== 0) return;
        if (!document.hidden && getFollowed()) refresh();
    }, POLL_MS);
}

function board(games, order) {
    const d = division();
    const fresh = pub.division === d && pub.enabled;
    return deriveBoard({
        games,
        order,
        division: d,
        marks: fresh ? pub.marks : [],
        earlies: fresh ? pub.earlies : [],
        rec: fresh ? pub.board : null,
        clock: getTimerSnapshot(d)?.state || null
    });
}

// --- the card's content ---------------------------------------------------------------

/**
 * What the followed team is doing in board round B (if it has a game there).
 * Returns null when it has no game in B.
 */
function nowLine(g, brd, usingBoard) {
    if (!g) return null;
    const c = brd.courtFor(g);
    // Squeezed in early on a free court: playing now, wherever it was scheduled.
    if (brd.earlyFor(g) && !isDone(g)) return { tone: 'live', icon: '🔴', title: `Playing now · Court ${c}` };
    if (slotOf(g) !== brd.B) return null;
    if (!isDone(g)) {
        if (brd.phase === 'playing') return { tone: 'live', icon: '🔴', title: `Playing now${c ? ' · Court ' + c : ''}` };
        if (brd.markFor(g)) return { tone: 'ready', icon: '✓', title: `On Court ${c} · ready to start` };
        if (usingBoard) return { tone: 'call', icon: '📣', title: `Head to Court ${c} now` };
        return { tone: 'info', icon: '⏭', title: `Up next${c ? ' · Court ' + c : ''}` };
    }
    const o = officialOutcome(g);
    if (!o) return { tone: 'done', icon: '✓', title: 'Game over · result pending' };
    return { tone: 'done', icon: o === 'won' ? '🎉' : '✓', title: o === 'won' ? 'Won' : o === 'tie' ? 'Tie' : 'Game over' };
}

/**
 * The followed team's next pool game after `afterRound`, plus the bye rounds
 * in between (counting `afterRound` itself when `includeAfterRound`).
 */
function nextInfo(games, order, afterRound, includeAfterRound) {
    const idx = (r) => order.indexOf(r);
    const from = idx(afterRound);
    const next = games.filter(isMine).filter(g => !isDone(g) && !isPlayoff(g) && idx(roundOf(g)) > from)
        .sort((a, b) => idx(roundOf(a)) - idx(roundOf(b)))[0];
    if (!next) return null;
    const poolRound = (r) => games.some(g => roundOf(g) === r && !isPlayoff(g));
    const byes = order.slice(includeAfterRound ? Math.max(from, 0) : from + 1, idx(roundOf(next)))
        .filter(r => poolRound(r) && !games.some(g => roundOf(g) === r && isMine(g)));
    const a = byes.length ? minutesOf(byes[0]) : null, b = minutesOf(roundOf(next));
    return {
        game: next,
        byes,
        offMin: a !== null && b !== null && b > a ? b - a : null,
        at: `${timeLabel(roundOf(next))}${courtOf(next) ? ' · Court ' + courtOf(next) : ''} vs ${opponentOf(next)}`
    };
}

/** "Next: 11:45 · Court 3 vs Tigers" / "Bye at 11:30 · then …" / "2 bye rounds · about 30 min off · back at …" */
function nextText(info) {
    if (!info) return '';
    const { byes, offMin, at } = info;
    if (byes.length === 0) return `Next: ${at}`;
    if (byes.length === 1) return `Bye at ${timeLabel(byes[0])} · then ${at}`;
    return `${byes.length} bye rounds${offMin ? ` · about ${offMin} min off` : ''} · back at ${at}`;
}

function standingFor(team) {
    return (App.data?.allStandingsData || []).find(s => isFollowed(s.team, team)) || null;
}

function poolDoneCard(team, extra) {
    const st = standingFor(team);
    const sub = st ? `${st.record || ''}${st.rank ? ` · currently ${ordinal(st.rank)}` : ''}`.replace(/^ · /, '') : '';
    return { tone: 'info', icon: '🏁', title: 'Pool play done', sub, next: extra || 'Playoff seeding coming up' };
}

/** Playoff state for the followed team (only once its pool games are all reported). */
function playoffCard(team, games, brd, usingBoard) {
    const mineSub = games.find(g => isMine(g) && g.subDivision)?.subDivision;
    const pGames = games.filter(isPlayoff).filter(g => !mineSub || !g.subDivision || g.subDivision === mineSub);
    if (!pGames.length) return poolDoneCard(team);
    const tree = buildBracketTree(pGames);
    if (!tree) return poolDoneCard(team);

    const final = tree.roots[0];
    const finalWhere = final && !isOfficial(final.g)
        ? `${timeLabel(final.g.roundTime) && /\d:\d/.test(final.g.roundTime) ? ' at ' + timeLabel(final.g.roundTime) : ''}${courtOf(final.g) ? ' on Court ' + courtOf(final.g) : ''}`
        : '';
    // "Quarterfinals · 10:30 AM" → "Quarterfinal" (the time is shown separately).
    const roundName = (node) => {
        const label = cleanRoundLabel(node.g.roundTime)
            .replace(/\s*[·|•\-–—]?\s*\d{1,2}:\d{2}\s*(AM|PM)?\s*$/i, '')
            .replace(/^\s*\d{1,2}:\d{2}\s*(AM|PM)?\s*[·|•\-–—]?\s*/i, '')
            .trim();
        return singular(label || defaultRoundLabel(node.depth));
    };
    // A bracket slot as a name: the team, the decided winner it's waiting on, or TBD.
    const slotName = (s) => {
        if (isRealTeamSlot(s)) return s.raw.trim();
        if (s.feeder && isOfficial(s.feeder.g)) return (s.feeder.g.winner || '').trim();
        return 'TBD';
    };
    const slotOf = (node) => node.slots.findIndex(s => !isByeSlot(s.raw) && isRealTeamSlot(s) && isFollowed(s.raw));

    // Every bracket card with the team's name in it, earliest round first.
    const mineNodes = tree.nodes.filter(n => slotOf(n) >= 0).sort((a, b) => b.depth - a.depth);
    if (!mineNodes.length) {
        const unseeded = tree.nodes.some(n => !n.isBye && n.slots.some(s => !s.feeder && !isRealTeamSlot(s) && !isByeSlot(s.raw)));
        if (unseeded) return poolDoneCard(team);
        return { tone: 'info', icon: '👏', title: 'Pool play complete', sub: 'Thanks for playing today!', next: finalWhere ? `Stick around for the Final${finalWhere}` : '' };
    }
    const seedSlot = mineNodes[0].slots[slotOf(mineNodes[0])];
    const seed = teamSeed(seedSlot.raw);
    const badge = `🏆 Playoffs${seed ? ' · #' + seed + ' seed' : ''}`;

    // Walk the team's path: through wins (official) to the current card.
    let node = mineNodes[0];
    let advancedTo = null;
    while (node) {
        if (node.isBye) { node = node.parent; continue; }
        const o = officialOutcome(node.g);
        if (!o) break;
        if (o === 'lost') {
            const where = roundName(node);
            if (node.depth === 0) return { badge, tone: 'champ', icon: '🥈', title: 'Finalists. What a run!', sub: 'So proud of this team today.' };
            const finish = node.depth <= 3 ? ` · Top ${Math.pow(2, node.depth + 1)} finish!` : '';
            return {
                badge, tone: 'sad', icon: '😢', title: `Eliminated in the ${where}`,
                sub: `We hope you had a blast today!${finish}`,
                next: finalWhere ? `Stick around and watch the Final${finalWhere}.` : 'Thanks for playing!'
            };
        }
        if (o === 'won' && !node.parent) return { badge, tone: 'champ', icon: '🏆', title: 'Champions!', sub: 'What a day. Congratulations!' };
        node = node.parent;
        advancedTo = node;
    }
    if (!node) return poolDoneCard(team);

    // A bye card in the team's path: they skip straight to the next real game.
    const g = node.g;
    const where = roundName(node);
    // The team's slot: by name once the sheet fills it in, else the slot fed by the game they won (or their bye).
    const mySlot = slotOf(node) >= 0 ? slotOf(node) : node.slots.findIndex(s => s.feeder && isFollowed(s.feeder.g.winner));
    const other = node.slots[mySlot === 0 ? 1 : 0];
    let vs;
    if (other.feeder && !isOfficial(other.feeder.g) && !other.feeder.isBye) {
        const f = other.feeder;
        const names = f.slots.map(s => teamLabel(slotName(s)) || 'TBD').join(' / ');
        const fRow = brd.rows.find(r => r.game === f.g);
        const playing = fRow?.status === 'playing' ? ` · playing now on Court ${fRow.court}` : '';
        vs = `winner of ${names}${playing}`;
    } else if (isByeSlot(other.raw)) {
        vs = 'a bye';
    } else {
        vs = slotName(other);
    }
    const at = `${/\d:\d/.test(g.roundTime || '') ? timeLabel(g.roundTime) + ' · ' : ''}${brd.courtFor(g) ? 'Court ' + brd.courtFor(g) : ''}`.replace(/ · $/, '');
    const now = nowLine(g, brd, usingBoard);
    if (now) return { badge, ...now, sub: `${where} vs ${vs}` };
    const hadBye = mineNodes.some(n => n.isBye) && !advancedTo;
    return {
        badge,
        tone: advancedTo ? 'champ' : 'info',
        icon: advancedTo ? '🎉' : '⏭',
        title: advancedTo ? `Advanced to the ${where}!` : hadBye ? `Bye into the ${where}` : `${where} up next`,
        sub: `${at ? at + ' · ' : ''}vs ${vs}`
    };
}

function computeCard(team) {
    const games = schedule();
    if (!games.length) return null;
    const order = getRoundOrder();
    const idx = (r) => order.indexOf(r);
    const brd = board(games, order);
    const usingBoard = !!brd.rec;
    const mine = games.filter(isMine).sort((a, b) => idx(roundOf(a)) - idx(roundOf(b)));
    if (!mine.length) return { tone: 'info', icon: '🔎', title: 'No games found', sub: 'This team isn\'t on the current schedule.' };

    const poolLeft = mine.some(g => !isPlayoff(g) && !isDone(g));
    const cur = mine.find(g => brd.earlyFor(g) && !isDone(g)) || (brd.B ? mine.find(g => slotOf(g) === brd.B) : null);

    const hasPlayoffs = games.some(isPlayoff);
    if (cur && !isPlayoff(cur)) {
        const now = nowLine(cur, brd, usingBoard);
        const info = nextInfo(games, order, brd.B, false);
        const lastPool = !mine.some(g => g !== cur && !isPlayoff(g) && !isDone(g));
        return { ...now, sub: `vs ${opponentOf(cur)}`, next: info ? nextText(info) : (lastPool ? `Last pool game${hasPlayoffs ? ' · playoffs next' : ''}` : '') };
    }
    if (poolLeft) {
        // No game in the board round: sitting this round out (or the board is elsewhere).
        const onByeNow = !!brd.B && games.some(g => slotOf(g) === brd.B && !isPlayoff(g));
        const info = nextInfo(games, order, brd.B || order[0], onByeNow);
        if (!info) return { tone: 'info', icon: '☕', title: onByeNow ? 'Bye this round' : 'Up later' };
        if (onByeNow && info.byes.length >= 2) {
            return { tone: 'info', icon: '☕', title: `${info.byes.length} bye rounds${info.offMin ? ` · about ${info.offMin} min off` : ''}`, sub: `Back at ${info.at}` };
        }
        if (onByeNow) return { tone: 'info', icon: '☕', title: 'Bye this round', sub: `Next: ${info.at}` };
        return { tone: 'info', icon: '⏭', title: 'Up later', sub: nextText(info) };
    }
    return playoffCard(team, games, brd, usingBoard);
}

// --- render ---------------------------------------------------------------------------

const TONES = {
    live: { bg: 'rgba(217,80,60,.14)', border: 'rgba(217,80,60,.6)', title: '#FFD9D2' },
    call: { bg: 'linear-gradient(135deg,rgba(224,184,99,.28) 0%,rgba(184,137,58,.2) 100%)', border: 'var(--gold)', title: 'var(--gold-l)' },
    ready: { bg: 'rgba(46,158,99,.16)', border: 'rgba(46,158,99,.6)', title: '#B9F0D0' },
    done: { bg: 'rgba(255,255,255,.06)', border: 'rgba(255,255,255,.14)', title: '#fff' },
    info: { bg: 'rgba(255,255,255,.06)', border: 'rgba(224,184,99,.35)', title: '#fff' },
    sad: { bg: 'rgba(120,140,200,.12)', border: 'rgba(160,175,230,.45)', title: '#E3E8FF' },
    champ: { bg: 'linear-gradient(135deg,rgba(224,184,99,.3) 0%,rgba(123,29,43,.35) 100%)', border: 'var(--gold)', title: 'var(--gold-l)' }
};

function cardHtml(team, card) {
    const t = TONES[card.tone] || TONES.info;
    const teamSelect = document.getElementById('team-select');
    const filtered = teamSelect && isFollowed(teamSelect.value, team);
    return `
        <section class="rounded-[22px] border p-3.5 ${card.tone === 'call' ? 'animate-pulse' : ''}" style="background:${t.bg};border-color:${t.border};box-shadow:0 10px 28px rgba(0,0,0,.22)">
            <div class="flex items-center justify-between gap-2">
                <div class="min-w-0 truncate text-[10px] font-semibold uppercase tracking-[.14em] text-white/55">★ ${esc(team)}${card.badge ? ' · ' + esc(card.badge.replace(/^🏆 /, '')) : ''}</div>
                <div class="flex flex-none items-center gap-2.5">
                    <button type="button" data-myteam-games class="text-[11px] font-semibold text-white/60 underline">${filtered ? 'All games' : 'My games'}</button>
                    <button type="button" data-myteam-change class="text-[11px] font-semibold text-white/45 underline">Change</button>
                </div>
            </div>
            <div class="mt-1.5 flex items-start gap-2.5">
                <span class="flex-none text-[22px] leading-none">${card.icon || ''}</span>
                <div class="min-w-0">
                    <div class="text-[17px] font-extrabold leading-[1.2]" style="color:${t.title}">${esc(card.title)}</div>
                    ${card.sub ? `<div class="mt-0.5 text-[13px] font-semibold leading-[1.35] text-white/85">${esc(card.sub)}</div>` : ''}
                    ${card.next ? `<div class="mt-1 text-[12px] leading-[1.35] text-white/60">${esc(card.next)}</div>` : ''}
                </div>
            </div>
        </section>`;
}

function promptHtml() {
    return `
        <button type="button" data-myteam-change class="flex w-full items-center justify-between gap-2 rounded-[18px] border border-dashed px-3.5 py-3 text-left"
            style="border-color:rgba(224,184,99,.45);background:rgba(224,184,99,.06)">
            <span class="text-[13px] font-semibold text-white/80">☆ Follow a team · see where they play next</span>
            <span class="text-[12px] font-bold" style="color:var(--gold-l)">Pick</span>
        </button>`;
}

/** Alert (vibrate) once when the followed team is called to a court or starts playing. */
function alertIfCalled(team, card) {
    if (card.tone !== 'call' && card.tone !== 'live') { if (card.tone !== 'ready') lastAlertKey = ''; return; }
    const key = `${division()}|${team}|${card.tone}|${card.title}`;
    if (key === lastAlertKey) return;
    const first = lastAlertKey === '' && !document.body.dataset.myTeamPrimed;
    lastAlertKey = key;
    document.body.dataset.myTeamPrimed = '1';
    if (first) return; // state found on load — no buzz
    try { navigator.vibrate && navigator.vibrate(card.tone === 'call' ? [120, 80, 120] : 60); } catch (e) { /* unsupported */ }
}

export function renderMyTeam() {
    startWatch();
    const team = getFollowed();
    const games = schedule();
    let html = '';
    if (!team) {
        html = !isSignedIn() && games.length && (App.data?.teamNames || []).length ? promptHtml() : '';
    } else {
        if (pub.division !== division()) refresh();
        const card = computeCard(team);
        if (card) {
            html = cardHtml(team, card);
            alertIfCalled(team, card);
        }
    }
    CONTAINERS.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.innerHTML = html;
        el.classList.toggle('hidden', !html);
        if (!el.dataset.wired) {
            el.dataset.wired = '1';
            el.addEventListener('click', (ev) => {
                const btn = ev.target.closest('button');
                if (!btn) return;
                if ('myteamChange' in btn.dataset) openFollowPicker();
                else if ('myteamGames' in btn.dataset) toggleMyGames();
            });
        }
    });
}

function toggleMyGames() {
    const team = getFollowed();
    const sel = document.getElementById('team-select');
    if (!team || !sel) return;
    const on = isFollowed(sel.value, team);
    const value = on ? 'all' : ([...sel.options].find(o => isFollowed(o.value, team))?.value || 'all');
    sel.value = value;
    sel.dispatchEvent(new Event('change'));
    if (App.state.currentView !== 'schedule' && typeof window.switchView === 'function') window.switchView('schedule');
    renderMyTeam();
}

/** Refetch the public board now (e.g. after an action elsewhere on this page). */
export { refresh as refreshMyTeam };
