// server/courtIssues.js
// Court issue flags ("raise your hand"): a referee flags their court when
// something needs the tournament manager there — a dispute, an injury, or
// anything else. The MC (superadmin) sees every open flag on
// every screen, can acknowledge it ("On my way") and clear it once resolved;
// the referee can also take their own flag down.
//
// Keyed by the physical court (one flag per court), not by division or game.
// Always on (no feature setting). Deliberately in-memory only, like court
// readiness: a restart drops open flags, which the referee simply raises again.
import { broadcastCourtIssueUpdate } from './socket.js';
import { pushNtfy } from './ntfy.js';

export const REASONS = {
  dispute: 'Dispute',
  injury: 'Injury',
  other: 'Other'
};

const MAX_RECENT = 30;

const issues = new Map(); // court -> { id, court, division, reason, by, at, ackBy, ackAt }
const recent = [];        // newest first: resolved flags { ...issue, clearedBy, clearedAt, clearedByMc }

function clean(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function isValidCourt(court) {
  return typeof court === 'string' && /^[A-Za-z0-9 ._-]{1,16}$/.test(court.trim());
}

export function snapshot() {
  return {
    issues: [...issues.values()].sort((a, b) => a.at - b.at),
    recent: recent.slice(0, 10)
  };
}

function changed() {
  broadcastCourtIssueUpdate();
}

/**
 * Raises (or updates) the flag on a court. A second raise on a court that is
 * already flagged (two referees, a retried tap) keeps the original raise time
 * and acknowledgement, and only refreshes the reason.
 */
export function raise({ court, division, reason, by }) {
  court = court.trim();
  const key = REASONS[reason] ? reason : 'other';
  const cur = issues.get(court);
  if (cur) {
    cur.reason = key;
    changed();
    return { ...snapshot(), issue: cur, already: true };
  }
  const issue = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    court,
    division: clean(division, 100),
    reason: key,
    by: clean(by, 40) || 'Referee',
    at: Date.now(),
    ackBy: '',
    ackAt: 0
  };
  issues.set(court, issue);
  changed();
  pushNtfy({
    title: `Court ${court} needs you - ${REASONS[key]}`,
    body: [`Flag raised by ${issue.by}`, issue.division].filter(Boolean).join(' · '),
    priority: key === 'other' ? 'high' : 'urgent',
    tags: 'raising_hand'
  });
  return { ...snapshot(), issue };
}

/** MC acknowledges: the referee's phone shows "<name> is on the way". */
export function acknowledge({ court, by }) {
  const cur = issues.get(court.trim());
  if (!cur) return { ...snapshot(), gone: true };
  if (!cur.ackAt) {
    cur.ackBy = clean(by, 40) || 'MC';
    cur.ackAt = Date.now();
    changed();
  }
  return { ...snapshot(), issue: cur };
}

/**
 * Takes a court's flag down. `id` (when given) must match the open flag, so a
 * stale tap from an old screen can't clear a newer flag on the same court.
 */
export function clear({ court, id, by, byMc }) {
  court = court.trim();
  const cur = issues.get(court);
  if (!cur) return { ...snapshot(), gone: true };
  if (id && cur.id !== id) return { ...snapshot(), kept: cur };
  issues.delete(court);
  recent.unshift({ ...cur, clearedBy: clean(by, 40) || (byMc ? 'MC' : 'Referee'), clearedAt: Date.now(), clearedByMc: !!byMc });
  recent.length = Math.min(recent.length, MAX_RECENT);
  changed();
  return snapshot();
}
