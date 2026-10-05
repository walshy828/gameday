// public/js/discrepancy.js
// Pure (no DOM, no App) helpers shared by the browser and the server
// (server/discrepancies.js imports this file directly), so both agree on what
// counts as a discrepancy between a referee-submitted (unofficial) result and
// the official one.

const isBlank = w => { const v = (w ?? '').toString().trim(); return v === '' || v === 'TBA' || v === '—'; };
const hasValue = n => n !== undefined && n !== null && n !== '';

/**
 * True when a referee-submitted result disagrees with an official one on
 * winner or players remaining. A game with no official result yet isn't a
 * discrepancy — it's just "not official yet".
 */
export function hasDiscrepancy(game) {
    if (!game || isBlank(game.winner) || isBlank(game.adminWinner)) return false;
    if (game.adminWinner.toString().trim() !== game.winner.toString().trim()) return true;
    if (!hasValue(game.playersRemaining) || !hasValue(game.adminPlayersRemaining)) return false;
    return Number(game.playersRemaining) !== Number(game.adminPlayersRemaining);
}

/**
 * Fingerprint of the values in dispute. A dismissal stores this, so it only
 * holds while neither the reported nor the official result changes.
 */
export function discrepancySig(game) {
    return [
        (game.adminWinner ?? '').toString().trim(),
        game.adminPlayersRemaining ?? '',
        (game.winner ?? '').toString().trim(),
        game.playersRemaining ?? ''
    ].join('|');
}

/** Playoff games are always numbered 'P1', 'P2', … in the match column. */
export function isPlayoffMatch(game) {
    return /^P\s*\d/i.test(((game && game.match) || '').toString().trim());
}
