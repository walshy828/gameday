// server/courtStatus.js
// Court readiness board (optional, behind the `courtReadyEnabled` feature
// setting). Court statuses are NOT stored here — every client derives them
// from the schedule (which games are reported) and the round clock, so they
// can never drift out of sync. This module only keeps the facts the schedule
// can't tell us:
//
//   marks  — "both teams are on the court" for a specific game, keyed by
//            division + game (round|court|team1|team2), never by court.
//   boards — per division, the round the MC's board is on and its phase:
//            'playing' (after Start round / the clock's Start) or 'staging'
//            (after End round — the next round's teams are being set up).
//            One level of undo is kept per division for mis-taps.
//
// Deliberately in-memory only: never the Google Sheet, Firebase or MariaDB. A
// restart loses ready taps and the board record; clients then fall back to the
// earliest unreported round and the running clock.
import { broadcastCourtStatusUpdate } from './socket.js';

const MAX_MARKS = 1000;

const marks = new Map();  // `${division}\u0000${gameKey}` -> { division, gameKey, court, by, at }
const boards = new Map(); // division -> { round, phase, prevRound, at, by }
const undos = new Map();  // division -> previous board (or null for "none")
// Squeeze-ins: a game from a later (short) round started early on a free court.
const earlies = new Map(); // `${division}\u0000${gameKey}` -> { division, gameKey, court, at, by }

export function clean(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

export function snapshot() {
  return {
    marks: [...marks.values()],
    boards: Object.fromEntries([...boards].map(([d, b]) => [d, { ...b, canUndo: undos.has(d) }])),
    earlies: [...earlies.values()]
  };
}

// Data-less nudge: the broadcast reaches every viewer (public too), so it
// carries nothing — staff refetch GET /api/courtStatus, the public card
// refetches the name-free GET /api/courtStatus/public.
function changed() {
  broadcastCourtStatusUpdate();
}

/** Public, read-only view of one division: the board record and which games are marked ready — no referee names. */
export function publicSnapshot(division) {
  const b = boards.get(division);
  return {
    board: b ? { round: b.round, phase: b.phase, prevRound: b.prevRound, at: b.at } : null,
    marks: [...marks.values()].filter(m => m.division === division).map(m => ({ division, gameKey: m.gameKey, court: m.court, at: m.at })),
    earlies: [...earlies.values()].filter(e => e.division === division).map(e => ({ division, gameKey: e.gameKey, court: e.court, at: e.at }))
  };
}

/**
 * Marks (or unmarks) one game's teams as on the court. Built for two referees
 * on one court and a slow venue network:
 * - ready: the FIRST tap wins. A later or retried tap changes nothing and gets
 *   `already` (who marked it, when), so that phone can say "already marked
 *   ready by Maya" instead of claiming the mark (and offering an Undo of it).
 * - unready with `onlyIfAt` (the referee's Undo): only removes the mark if it
 *   is still the one they made; otherwise it is left and `kept` is returned.
 *   A plain "Not ready" (no onlyIfAt) always clears it.
 */
export function setMark({ division, gameKey, court, ready, by, onlyIfAt = null }) {
  const key = `${division}\u0000${gameKey}`;
  const cur = marks.get(key);
  if (ready) {
    if (cur) return { ...snapshot(), already: { by: cur.by, at: cur.at } };
    const mark = { division, gameKey, court, by: clean(by, 40) || 'Referee', at: Date.now() };
    marks.set(key, mark);
    while (marks.size > MAX_MARKS) marks.delete(marks.keys().next().value);
    changed();
    return { ...snapshot(), mark: { by: mark.by, at: mark.at } };
  }
  if (!cur) return snapshot();
  if (onlyIfAt !== null && cur.at !== onlyIfAt) return { ...snapshot(), kept: { by: cur.by, at: cur.at } };
  marks.delete(key);
  changed();
  return snapshot();
}

function setBoard(division, next) {
  undos.set(division, boards.get(division) || null);
  boards.set(division, next);
  changed();
  return snapshot();
}

/** Start round: `roundTime` is now in play. Idempotent for the same round. */
export function startRound({ division, roundTime, prevRound, by }) {
  const cur = boards.get(division);
  if (cur?.round === roundTime && cur.phase === 'playing') return snapshot();
  return setBoard(division, {
    round: roundTime,
    phase: 'playing',
    prevRound: clean(prevRound, 64) || cur?.prevRound || '',
    at: Date.now(),
    by: clean(by, 40) || 'MC'
  });
}

/** End round: the board moves on to set up `nextRound` (even if a score is missing). */
export function endRound({ division, roundTime, nextRound, by }) {
  return setBoard(division, {
    round: nextRound || '',
    phase: 'staging',
    prevRound: roundTime,
    at: Date.now(),
    by: clean(by, 40) || 'MC'
  });
}

/** Undo the last Start/End round for a division (one level). */
export function undoRound({ division }) {
  if (!undos.has(division)) return snapshot();
  const prev = undos.get(division);
  undos.delete(division);
  if (prev) boards.set(division, prev);
  else boards.delete(division);
  changed();
  return snapshot();
}

/** Squeeze a later game in now on a free court (or undo that). */
export function setEarly({ division, gameKey, court, on, by }) {
  const key = `${division}\u0000${gameKey}`;
  if (on) earlies.set(key, { division, gameKey, court, at: Date.now(), by: clean(by, 40) || 'MC' });
  else earlies.delete(key);
  changed();
  return snapshot();
}

/** Clears ready marks for one division (or every division). The board round is kept. */
export function clearMarks({ division } = {}) {
  let removed = false;
  for (const [key, m] of marks) {
    if (!division || m.division === division) { marks.delete(key); removed = true; }
  }
  if (removed) changed();
  return snapshot();
}

export function clearAll() {
  if (marks.size === 0 && boards.size === 0 && earlies.size === 0) return snapshot();
  marks.clear();
  boards.clear();
  undos.clear();
  earlies.clear();
  changed();
  return snapshot();
}
