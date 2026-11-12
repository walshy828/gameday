// server/courtStatus.js
// Court readiness board (optional, behind the `courtReadyEnabled` feature
// setting). The board's court statuses are NOT stored here — every client
// derives them from the schedule (which games are reported) and the round
// clock, so they can never drift out of sync. This module only keeps the two
// facts the schedule can't tell us:
//
//   marks  — "both teams are on the court" for a specific upcoming game,
//            keyed by division + game (round|court|team1|team2), not by court,
//            so a mark can't leak onto a different game.
//   starts — per division, which round the MC started (board Start round or
//            the clock's Start), so "in play" means the round actually began.
//
// Deliberately in-memory only: never the Google Sheet, Firebase or MariaDB. A
// restart only loses ready taps (clients fall back to the running clock for
// "in play"), and everything else rebuilds from the schedule.
import { broadcastCourtStatusUpdate } from './socket.js';

const MAX_MARKS = 1000;

const marks = new Map();  // `${division}\u0000${gameKey}` -> { division, gameKey, court, by, at }
const starts = new Map(); // division -> { roundTime, by, at }

export function clean(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

export function snapshot() {
  return {
    marks: [...marks.values()],
    starts: Object.fromEntries(starts)
  };
}

function changed() {
  broadcastCourtStatusUpdate(snapshot());
}

/** Marks (or unmarks) one upcoming game's teams as on the court. */
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

/** Records that `roundTime` is in play for `division` (idempotent for the same round). */
export function startRound({ division, roundTime, by }) {
  const prev = starts.get(division);
  if (prev?.roundTime !== roundTime) {
    starts.set(division, { roundTime, by: clean(by, 40) || 'MC', at: Date.now() });
    changed();
  }
  return snapshot();
}

/** Undo an accidental start: the round goes back to waiting/ready. */
export function unstartRound({ division }) {
  if (starts.delete(division)) changed();
  return snapshot();
}

/** Clears ready marks for one division (or every division). Starts are kept. */
export function clearMarks({ division } = {}) {
  let removed = false;
  for (const [key, m] of marks) {
    if (!division || m.division === division) { marks.delete(key); removed = true; }
  }
  if (removed) changed();
  return snapshot();
}

export function clearAll() {
  if (marks.size === 0 && starts.size === 0) return snapshot();
  marks.clear();
  starts.clear();
  changed();
  return snapshot();
}
