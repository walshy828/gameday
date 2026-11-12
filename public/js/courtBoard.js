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

/** The clock is running its main segment on round B, started after the board record. */
export function clockPlaying(clock, B, rec) {
    if (!B || !clock?.running || clock.startAfterRoundRunning) return false;
    if ((clock.currentRound || '').trim() !== B) return false;
    return !rec || (Number(clock.startTime) || 0) > (rec.at || 0) + CLOCK_START_SLACK_MS;
}

/**
 * @param {object} p
 * @param {Array} p.games      schedule rows for the division
 * @param {Array} p.order      every round, chronologically
 * @param {string} p.division
 * @param {Array} p.marks      [{ division, gameKey, court, by?, at }]
 * @param {object|null} p.rec  the division's board record { round, phase, prevRound, at, canUndo }
 * @param {object|null} p.clock the round clock's state for the division
 */
export function deriveBoard({ games, order, division, marks = [], rec = null, clock = null, now = Date.now() }) {
    const idx = (r) => order.indexOf(r);
    const inRound = (R) => games.filter(g => roundOf(g) === R);
    const allDone = (R) => { const l = inRound(R); return l.length > 0 && l.every(isDone); };
    const nextAfter = (R) => (idx(R) >= 0 ? order[idx(R) + 1] : undefined) || null;
    const prevOf = (R) => (idx(R) > 0 ? order[idx(R) - 1] : null);
    const live = order.find(R => inRound(R).some(g => !isDone(g))) || null;
    const markFor = (g) => {
        const key = gameKeyOf(g);
        return marks.find(m => m.division === division && m.gameKey === key) || null;
    };

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
    const clockForRound = !!clock && !!B && (clock.currentRound || '').trim() === B
        && (Number(clock.startTime) || 0) >= ((recValid && rec.phase === 'playing' ? rec.at : 0) - CLOCK_START_SLACK_MS);
    const timesUp = phase === 'playing' && clockForRound && (!clock.running || !!clock.startAfterRoundRunning);

    const canUndo = !!(recValid && rec.canUndo && !advanced && now - (rec.at || 0) < ROUND_UNDO_MS);
    return { B, phase, prev, rec: recValid ? rec : null, advanced, rows, summary, missing, prevInfo, timesUp, canUndo, nextAfter, markFor };
}
