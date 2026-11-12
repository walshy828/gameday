// server/courtStatus.js
// Court readiness board (optional, behind the `courtReadyEnabled` feature
// setting). Referees mark a physical court "ready" once both teams for the
// next game are standing on it, so the MC doesn't have to walk every court.
//
// Deliberately in-memory only: it never touches the Google Sheet, Firebase or
// MariaDB. A server restart just empties the board (courts then show as in
// play until their next report), which is harmless for a live-ops signal.
//
// Statuses, per court:
//   reported — the game on this court was just reported; waiting for teams
//   ready    — referee confirmed both next teams are on the court
//   idle     — reported, and this court has no next game (bye / done)
//   playing  — MC started the round (set by startRound)
import { broadcastCourtStatusUpdate } from './socket.js';

export const COURT_RE = /^[A-Za-z0-9 ._-]{1,16}$/;
export const SETTABLE_STATUSES = new Set(['reported', 'ready', 'idle']);

const courts = new Map();

function clean(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function cleanNextMatch(m) {
  if (!m || typeof m !== 'object') return null;
  const team1 = clean(m.team1, 60);
  const team2 = clean(m.team2, 60);
  if (!team1 && !team2) return null;
  return { team1, team2, roundTime: clean(m.roundTime, 30), match: clean(m.match, 30) };
}

export function list() {
  return [...courts.values()].sort((a, b) => a.court.localeCompare(b.court, undefined, { numeric: true }));
}

function changed() {
  broadcastCourtStatusUpdate(list());
}

/**
 * Sets one court's status. `nextMatch` is kept from the previous entry when
 * not supplied (e.g. "ready"/undo taps don't resend it).
 */
export function setStatus({ court, status, division, nextMatch, by }) {
  const prev = courts.get(court);
  const next = {
    court,
    status,
    division: clean(division, 60) || prev?.division || '',
    nextMatch: nextMatch === undefined ? (prev?.nextMatch ?? null) : cleanNextMatch(nextMatch),
    updatedBy: clean(by, 40) || 'Referee',
    updatedAt: Date.now()
  };
  if (status === 'ready' && !prev?.readyAt) next.readyAt = next.updatedAt;
  else if (status === 'ready') next.readyAt = prev.readyAt;
  courts.set(court, next);
  changed();
  return next;
}

/** MC starts the round: every court that was waiting or ready is now in play. */
export function startRound(by) {
  const now = Date.now();
  for (const [key, c] of courts) {
    if (c.status === 'idle') continue;
    courts.set(key, { court: c.court, status: 'playing', division: c.division, nextMatch: c.nextMatch, updatedBy: clean(by, 40) || 'MC', updatedAt: now });
  }
  changed();
  return list();
}

export function clearAll() {
  if (courts.size === 0) return list();
  courts.clear();
  changed();
  return list();
}
