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

export function clean(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

export function snapshot() {
  return {
    marks: [...marks.values()],
    boards: Object.fromEntries([...boards].map(([d, b]) => [d, { ...b, canUndo: undos.has(d) }]))
  };
}

function changed() {
  broadcastCourtStatusUpdate(snapshot());
}

/** Marks (or unmarks) one game's teams as on the court. */
export function setMark({ division, gameKey, court, ready, by }) {
  const key = `${division}\u0000${gameKey}`;
  if (ready) {
    marks.delete(key); // re-insert so the newest is last (oldest pruned first)
    marks.set(key, { division, gameKey, court, by: clean(by, 40) || 'Referee', at: Date.now() });
    while (marks.size > MAX_MARKS) marks.delete(marks.keys().next().value);
  } else {
    marks.delete(key);
  }
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
  if (marks.size === 0 && boards.size === 0) return snapshot();
  marks.clear();
  boards.clear();
  undos.clear();
  changed();
  return snapshot();
}
