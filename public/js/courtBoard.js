// public/js/courtBoard.js
// Pure derivation of the round-based court board, shared by the MC board and
// referee bar (courtReady.js) and the public "My team" card (myTeam.js), so
// they can never disagree. No DOM, no App, no network: callers pass in the
// schedule, the round order, the server's board record + ready marks, and the
// round clock's state.
//
// One *board round* B in one of two phases:
//   playing — after Start round (or the clock's Start): IN PLAY / FINAL
//   staging — after End round, or once every game in B is reported: the
//             round's teams are being called (WAITING FOR TEAMS / READY)
// Without a board record (Court Ready never used / server restart) B is the
// earliest unreported round, `playing` if the clock runs its main segment on it.
import { isReported as isReportedOfficial } from './schedule.js';

export const CLOCK_START_SLACK_MS = 5000;
export const ROUND_UNDO_MS = 2 * 60000;

export const courtKey = (c) => String(c || '').trim();
export const roundOf = (g) => g.roundTime || 'TBD';
export const hasValue = (v) => { const t = (v || '').trim(); return t !== '' && t !== 'TBA' && t !== '—'; };
/** Done for board purposes: a referee has reported it, or it's official. */
export const isDone = (g) => isReportedOfficial(g) || hasValue(g.adminWinner);

/** Stable identity of a game across reloads and sheet re-syncs. */
export function gameKeyOf(g) {
    return [roundOf(g), courtKey(g.court), (g.team1 || '').trim(), (g.team2 || '').trim()].join('|');
}

/**
 * The board's round key: the start time inside a round label, so games from
 * different sub-divisions/brackets that start together ("Round of 16 · 12:25 PM",
 * "Quarterfinals · 12:25 PM") are run as ONE round on the board. Labels without
 * a time are their own round.
 */
export function slotKey(rt) {
    const m = /(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(rt || '');
    if (!m) return (rt || 'TBD').trim() || 'TBD';
    return `${+m[1]}:${m[2]}${m[3] ? ' ' + m[3].toUpperCase() : ''}`;
}
export const slotOf = (g) => slotKey(roundOf(g));

/** A bracket/schedule name that isn't a real team yet ("Winner P3", "TBD", "#1 Seed", "BYE"). */
export function isPlaceholderTeam(name) {
    const n = (name || '').trim();
    return !n || /^(tbd|tba|bye|—|-)$/i.test(n) || /^(winner|loser|w|l)\b/i.test(n) || /\bseed\b/i.test(n);
}

const baseName = (n) => (n || '').replace(/\s*\(#\d+\)\s*$/, '').trim().toLowerCase();

/** The clock is running its main segment on board round B, started after the board record. */
export function clockPlaying(clock, B, rec) {
    if (!B || !clock?.running || clock.startAfterRoundRunning) return false;
    if (slotKey(clock.currentRound) !== B) return false;
    return !rec || (Number(clock.startTime) || 0) > (rec.at || 0) + CLOCK_START_SLACK_MS;
}

/**
 * @param {object} p
 * @param {Array} p.games      schedule rows for the division
 * @param {Array} p.order      every round label, chronologically (getRoundOrder)
 * @param {string} p.division
 * @param {Array} p.marks      [{ division, gameKey, court, by?, at }]
 * @param {Array} p.earlies    [{ division, gameKey, court, at }] games squeezed in early on a free court
 * @param {object|null} p.rec  the division's board record { round, phase, prevRound, at, canUndo }
 * @param {object|null} p.clock the round clock's state for the division
 */
export function deriveBoard({ games, order: rawOrder, division, marks = [], earlies = [], rec = null, clock = null, now = Date.now() }) {
    // Board rounds = distinct start times, in order.
    const order = [...new Set(rawOrder.map(slotKey))];
    const idx = (r) => order.indexOf(r);
    const gIdx = (g) => idx(slotOf(g));
    const inRound = (R) => games.filter(g => slotOf(g) === R);
    const allDone = (R) => { const l = inRound(R); return l.length > 0 && l.every(isDone); };
    const nextAfter = (R) => (idx(R) >= 0 ? order[idx(R) + 1] : undefined) || null;
    const prevOf = (R) => (idx(R) > 0 ? order[idx(R) - 1] : null);
    const firstRawOf = (R) => rawOrder.find(r => slotKey(r) === R) || R;
    const live = order.find(R => inRound(R).some(g => !isDone(g))) || null;
    const markFor = (g) => {
        const key = gameKeyOf(g);
        return marks.find(m => m.division === division && m.gameKey === key) || null;
    };
    const earlyFor = (g) => {
        const key = gameKeyOf(g);
        return earlies.find(e => e.division === division && e.gameKey === key) || null;
    };
    /** Where a game is actually played: its squeeze-in court, else the scheduled one. */
    const courtFor = (g) => (earlyFor(g)?.court) || courtKey(g.court);

    const recValid = !!rec && (rec.round === '' || idx(rec.round) >= 0);
    let B, phase, prev;
    if (recValid) {
        B = rec.round || null;
        phase = rec.phase;
        prev = rec.prevRound || prevOf(B);
    } else {
        B = live;
        prev = prevOf(B);
        phase = clockPlaying(clock, B, null) ? 'playing' : 'staging';
    }
    // The clock was started somewhere that didn't record it.
    if (phase === 'staging' && clockPlaying(clock, B, recValid ? rec : null)) phase = 'playing';
    // Every game in the board round is in: move on by itself.
    let advanced = false;
    while (B && allDone(B)) {
        prev = B;
        B = nextAfter(B);
        phase = 'staging';
        advanced = true;
    }

    const courts = [...new Set(games.map(g => courtKey(g.court)).concat(earlies.filter(e => e.division === division).map(e => courtKey(e.court))).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    // Unreported games on a court from rounds before B (e.g. the MC ended the
    // round, or time ran out, before the referee entered the score).
    const owedOn = (court) => games
        .filter(x => courtFor(x) === court && !isDone(x) && (B ? gIdx(x) < idx(B) : true))
        .sort((a, b) => gIdx(a) - gIdx(b));
    // Games from a LATER round squeezed in early and still being played.
    const earlyOn = (court) => games.find(x => !isDone(x) && earlyFor(x) && courtFor(x) === court && (!B || gIdx(x) > idx(B))) || null;

    const rows = courts.map((court) => {
        const owed = owedOn(court);
        return { ...courtRow(court), owed };
    });
    function courtRow(court) {
        if (!B) return { court, status: 'none', game: null, inR: false };
        const inB = games.filter(x => slotOf(x) === B && courtFor(x) === court);
        const g = inB.find(x => !isDone(x)) || inB[0] || null;
        const early = earlyOn(court);
        if (early && (!g || isDone(g))) {
            return { court, status: 'playing', game: early, early: true, inR: false, after: g };
        }
        if (!g) {
            const later = games.filter(x => courtFor(x) === court && gIdx(x) > idx(B) && !isDone(x))
                .sort((a, b) => gIdx(a) - gIdx(b))[0] || null;
            return { court, status: 'bye', game: null, later, inR: false };
        }
        const mark = markFor(g);
        let status;
        if (isDone(g)) status = 'final';
        else if (phase === 'playing' || earlyFor(g)) status = 'playing';
        else status = mark ? 'ready' : 'waiting';
        return { court, status, game: g, mark, inR: true, early: !!earlyFor(g) && !isDone(g) };
    }

    const withGame = rows.filter(r => r.game && r.inR);
    const summary = phase === 'playing'
        ? { final: withGame.filter(r => r.status === 'final').length, total: withGame.length }
        : (() => {
            const open = withGame.filter(r => r.status !== 'final' && r.status !== 'playing');
            // A court still owing an earlier score isn't ready, even if marked.
            const ready = open.filter(r => r.status === 'ready' && !r.owed.length).length;
            return { ready, total: open.length, allReady: open.length > 0 && ready === open.length };
        })();

    // Squeeze-in: a court that's free now (its game is final, or it has no game
    // this round) can start a game from a short later round (≤ 2 games) whose
    // teams are already known and aren't playing right now.
    const busy = new Set(games.filter(x => !isDone(x) && (slotOf(x) === B && phase === 'playing' || earlyFor(x)))
        .flatMap(x => [baseName(x.team1), baseName(x.team2)]));
    const shortRound = (R) => inRound(R).length <= 2;
    const candidates = B ? games.filter(x => !isDone(x) && !earlyFor(x) && gIdx(x) > idx(B) && shortRound(slotOf(x))
        && !isPlaceholderTeam(x.team1) && !isPlaceholderTeam(x.team2)
        && !busy.has(baseName(x.team1)) && !busy.has(baseName(x.team2)))
        .sort((a, b) => gIdx(a) - gIdx(b) || courtKey(a.court).localeCompare(courtKey(b.court), undefined, { numeric: true })) : [];
    const freeCourts = rows.filter(r => !r.owed.length && (r.status === 'bye' || (r.status === 'final' && phase === 'playing'))).map(r => r.court);
    const squeeze = freeCourts.slice(0, candidates.length).map((court, i) => ({ court, game: candidates[i] }));

    // Scores still missing from rounds before the board round.
    const missing = games.filter(g => !isDone(g) && (B ? gIdx(g) < idx(B) : true))
        .sort((a, b) => gIdx(a) - gIdx(b) || courtFor(a).localeCompare(courtFor(b), undefined, { numeric: true }));
    const prevGames = prev ? inRound(prev) : [];
    const prevInfo = prev ? { round: prev, final: prevGames.filter(isDone).length, total: prevGames.length } : null;

    // Time's up: the clock that ran this round has stopped or is in the after-round break.
    const clockForRound = !!clock && !!B && slotKey(clock.currentRound) === B
        && (Number(clock.startTime) || 0) >= ((recValid && rec.phase === 'playing' ? rec.at : 0) - CLOCK_START_SLACK_MS);
    const timesUp = phase === 'playing' && clockForRound && (!clock.running || !!clock.startAfterRoundRunning);

    const canUndo = !!(recValid && rec.canUndo && !advanced && now - (rec.at || 0) < ROUND_UNDO_MS);
    return { B, phase, prev, rec: recValid ? rec : null, advanced, rows, summary, missing, prevInfo, timesUp, canUndo,
        nextAfter, markFor, earlyFor, courtFor, firstRawOf, squeeze, order };
}
