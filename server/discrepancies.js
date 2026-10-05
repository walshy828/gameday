// server/discrepancies.js
// Finds matches where a referee-submitted (unofficial) result disagrees with
// the official one, across every division, minus the ones a superadmin has
// dismissed. Backend-agnostic: it only uses the Store interface.
import axios from 'axios';
import { Store } from './datastores/index.js';
import { hasDiscrepancy, discrepancySig, isPlayoffMatch } from '../public/js/discrepancy.js';

export const dismissKey = (division, firebaseIndex) => `${division}|${firebaseIndex}`;

const toItem = (division, g, dismissed) => {
  const key = dismissKey(division, g.firebaseIndex);
  const sig = discrepancySig(g);
  return {
    division,
    key,
    sig,
    dismissed: dismissed[key]?.sig === sig,
    firebaseIndex: g.firebaseIndex,
    rowIndex: g.rowIndex ?? null,
    match: g.match || '',
    roundTime: g.roundTime || '',
    court: g.court || '',
    team1: g.team1 || '',
    team2: g.team2 || '',
    winner: g.winner || '',
    playersRemaining: g.playersRemaining ?? '',
    adminName: g.adminName || '',
    adminWinner: g.adminWinner || '',
    adminPlayersRemaining: g.adminPlayersRemaining ?? '',
    lastUpdated: g.lastUpdated || null,
    playoff: isPlayoffMatch(g)
  };
};

/** Open (not dismissed) discrepancies in every division. */
export async function listOpenDiscrepancies() {
  const [names, dismissed] = await Promise.all([Store.getDivisionNames(), Store.getDiscrepancyDismissals()]);
  const perDivision = await Promise.all(names.map(async name => {
    const schedule = await Store.getSchedule(name);
    return schedule.filter(hasDiscrepancy).map(g => toItem(name, g, dismissed));
  }));
  return perDivision.flat().filter(i => !i.dismissed);
}

/** Dismisses the discrepancy currently on a match (the sig is computed here, never trusted from the client). */
export async function dismissDiscrepancy(division, firebaseIndex, by) {
  const game = (await Store.getSchedule(division)).find(g => String(g.firebaseIndex) === String(firebaseIndex));
  if (!game) return { ok: false, error: 'Match not found.' };
  if (!hasDiscrepancy(game)) return { ok: true, alreadyResolved: true };
  await Store.setDiscrepancyDismissal(dismissKey(division, game.firebaseIndex), discrepancySig(game), by);
  return { ok: true };
}

// --- Optional push for high-impact (playoff) games ---------------------------
// Off unless NTFY_URL (full topic URL, e.g. https://ntfy.example.com/gameday)
// is set. Sent at most once per distinct disputed value, never to the UI.
const notified = new Set();

export async function notifyIfHighImpact(division, firebaseIndex) {
  const url = process.env.NTFY_URL;
  if (!url) return;
  try {
    const game = (await Store.getSchedule(division)).find(g => String(g.firebaseIndex) === String(firebaseIndex));
    if (!game || !isPlayoffMatch(game) || !hasDiscrepancy(game)) return;
    const id = `${dismissKey(division, game.firebaseIndex)}|${discrepancySig(game)}`;
    if (notified.has(id)) return;
    notified.add(id);
    await axios.post(
      url,
      `${game.team1} vs ${game.team2} (${game.match}, court ${game.court}): official ${game.winner}, reported ${game.adminWinner} by ${game.adminName || 'referee'}.`,
      {
        timeout: 5000,
        headers: {
          Title: `Playoff result needs review - ${division}`,
          Priority: 'high',
          Tags: 'warning',
          ...(process.env.NTFY_TOKEN ? { Authorization: `Bearer ${process.env.NTFY_TOKEN}` } : {})
        }
      }
    );
  } catch (e) {
    console.error('Discrepancy push failed', e.message || e);
  }
}
