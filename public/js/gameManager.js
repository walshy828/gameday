// public/js/gameManager.js
// Pure (no DOM, no App) pacing assessment for one division: compares where the
// round clock is now against the schedule times from the sheet's
// GONK_SHEET_CONFIG block, projects when pool play + playoffs will finish at
// the current pace, and recommends adjustments to still finish on time.
//
// Slot model (matches the sheet): a pool round occupies `game_minutes` of the
// schedule (game + the break before the next round), playoff games run
// back-to-back for `playoff_game_minutes` each, with `playoff_intro_minutes`
// between the last pool round and the first playoff game.
import { isPlayoffMatch } from './discrepancy.js';

// Status bands, in minutes the next round is projected to start vs. its planned time.
export const AHEAD_MIN = -2;
export const ON_TRACK_MAX = 2;
export const BEHIND_MAX = 8;

// Lowest values the recommendations will suggest.
export const MIN_GAP_SEC = 60;
export const MIN_GAME_SEC = 180;
export const MIN_PLAYOFF_MIN = 3;
export const MIN_PLAYOFF_INTRO_MIN = 2;

const GAP_STEP_SEC = 15;
const GAME_STEP_SEC = 30; // matches the timer's +/- adjust
const PLAYOFF_STEP_MIN = 0.5;
const MIN_MS = 60000;

/** '13:15', '1:15 PM', '13:15:00' -> minutes since midnight (null if unparseable). */
export function parseClockMinutes(value) {
    const m = /(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])?\.?m?/i.exec((value ?? '').toString());
    if (!m) return null;
    let h = Number(m[1]);
    const min = Number(m[2]);
    const period = m[3] && m[3].toLowerCase();
    if (period === 'p' && h < 12) h += 12;
    if (period === 'a' && h === 12) h = 0;
    return h * 60 + min;
}

const num = (v) => {
    const n = parseFloat((v ?? '').toString());
    return Number.isFinite(n) ? n : null;
};

/**
 * Ordered rounds for a division, same ordering as the timer's round list:
 * timed pool rounds first, then playoff rounds. `plannedMin` is the label's
 * embedded clock time when there is one.
 */
export function buildRounds(schedule) {
    const byLabel = new Map();
    for (const g of schedule || []) {
        const label = (g.roundTime || '').toString().trim();
        if (!label) continue;
        const r = byLabel.get(label) || { label, isPlayoff: false };
        if (isPlayoffMatch(g) || /^P\s*\d/i.test(label)) r.isPlayoff = true;
        byLabel.set(label, r);
    }
    const rounds = [...byLabel.values()].map(r => ({ ...r, plannedMin: parseClockMinutes(r.label) }));
    const labelNum = (r) => parseInt(r.label.match(/\d+/)?.[0] || '0', 10);
    const pool = rounds.filter(r => !r.isPlayoff).sort((a, b) => (a.plannedMin ?? 1e9) - (b.plannedMin ?? 1e9));
    const playoff = rounds.filter(r => r.isPlayoff).sort((a, b) =>
        a.plannedMin != null && b.plannedMin != null ? a.plannedMin - b.plannedMin : labelNum(a) - labelNum(b));
    return [...pool, ...playoff];
}

/** Reads the sheet config into numbers (minutes since midnight / minutes). */
export function readPlan(cfg, rounds) {
    const pool = rounds.filter(r => !r.isPlayoff);
    const playoff = rounds.filter(r => r.isPlayoff);

    let slotMin = num(cfg.game_minutes);
    if (slotMin == null && pool.length > 1) {
        const diffs = pool.slice(1).map((r, i) => r.plannedMin - pool[i].plannedMin).filter(d => d > 0).sort((a, b) => a - b);
        if (diffs.length) slotMin = diffs[Math.floor(diffs.length / 2)];
    }

    const plan = {
        divisionStart: parseClockMinutes(cfg.division_start),
        divisionEnd: parseClockMinutes(cfg.division_end),
        poolEnd: parseClockMinutes(cfg.pool_end),
        playoffStart: parseClockMinutes(cfg.playoff_start),
        playoffEnd: parseClockMinutes(cfg.playoff_end),
        playoffIntroMin: num(cfg.playoff_intro_minutes) ?? 0,
        playoffGameMin: num(cfg.playoff_game_minutes),
        slotMin,
        playoffRounds: playoff.length || num(cfg.playoff_rounds) || 0
    };
    plan.hasPlayoffs = plan.playoffRounds > 0 && plan.playoffGameMin != null;

    // Planned start per round: label time, else playoff_start stepped by slot length.
    let k = 0;
    plan.starts = rounds.map(r => {
        if (!r.isPlayoff) return r.plannedMin;
        const t = r.plannedMin ?? (plan.playoffStart != null && plan.playoffGameMin != null
            ? plan.playoffStart + k * plan.playoffGameMin : null);
        k += 1;
        return t;
    });
    return plan;
}

const fmtMin = (m) => {
    const t = ((Math.round(m) % 1440) + 1440) % 1440;
    const h = Math.floor(t / 60);
    return `${h % 12 || 12}:${String(t % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
export const formatClockMinutes = fmtMin;

/**
 * @param {object} p
 * @param {object} p.cfg        GONK_SHEET_CONFIG key/values for the division
 * @param {Array}  p.schedule   the division's schedule rows
 * @param {object} p.timer      { currentRound, running, startTime, duration, lastSetDuration,
 *                                startAfterRoundRunning, afterRoundEnabled, afterRoundDuration } (may be null)
 * @param {number} p.nowMs      "now" (server-adjusted epoch ms)
 * @param {number} [p.allowanceMin]  late-finish allowance on top of division_end
 */
export function assess({ cfg, schedule, timer, nowMs, allowanceMin = 0 }) {
    const rounds = buildRounds(schedule);
    if (!cfg) return { ok: false, reason: 'no-config' };
    if (!rounds.length) return { ok: false, reason: 'no-rounds' };
    const plan = readPlan(cfg, rounds);
    if (plan.divisionEnd == null) return { ok: false, reason: 'no-end-time' };

    const t = timer || {};
    const dayStart = new Date(nowMs); dayStart.setHours(0, 0, 0, 0);
    const toMs = (min) => dayStart.getTime() + min * MIN_MS;

    // ---- where the clock is -------------------------------------------------
    const curLabel = (t.currentRound || '').toString().trim();
    let curIdx = rounds.findIndex(r => r.label === curLabel);
    if (curIdx === -1) curIdx = 0;
    const running = !!t.running;
    const inBreak = running && !!t.startAfterRoundRunning;
    const inGame = running && !inBreak;
    const remainingMs = running ? Math.max(0, (t.startTime || nowMs) + (t.duration || 0) * 1000 - nowMs) : 0;

    // The round that starts next: the one after the game in progress / break,
    // or the current round itself when its clock hasn't been started.
    const nextIdx = running ? curIdx + 1 : curIdx;
    const lastPoolIdx = rounds.reduce((acc, r, i) => (!r.isPlayoff ? i : acc), -1);

    const clockGameSec = t.lastSetDuration || t.duration || (plan.slotMin ? plan.slotMin * 60 : 300);
    const slotSec = (plan.slotMin ?? clockGameSec / 60) * 60;
    const clockGapSec = t.afterRoundEnabled
        ? (t.afterRoundDuration || 60)
        : Math.max(0, slotSec - clockGameSec);

    const poolLeft = Math.max(0, lastPoolIdx - nextIdx + 1);
    const playoffLeft = rounds.slice(Math.max(nextIdx, lastPoolIdx + 1)).length;
    // Intro applies when the schedule moves from a pool round into playoffs.
    const needsIntro = playoffLeft > 0 && (poolLeft > 0 ||
        (running ? !!rounds[curIdx] && !rounds[curIdx].isPlayoff : nextIdx > 0 && !rounds[nextIdx - 1].isPlayoff));

    /** Projected timeline for the given pace. Returns epoch ms + counts of what it spent time on. */
    function simulate({ gameSec, gapSec, playoffMin, introMin }) {
        const gameMs = gameSec * 1000;
        const gapMs = gapSec * 1000;
        let lastEnd = inGame ? nowMs + remainingMs : nowMs;
        let next = inGame ? lastEnd + (nextIdx <= lastPoolIdx ? gapMs : 0)
            : inBreak ? nowMs + remainingMs : nowMs;
        let gaps = inGame && nextIdx <= lastPoolIdx ? 1 : 0;
        const nextStart = next;
        for (let i = 0; i < poolLeft; i++) {
            lastEnd = next + gameMs;
            next = lastEnd + gapMs;
            if (i < poolLeft - 1) gaps += 1;
        }
        let end = lastEnd;
        if (playoffLeft > 0) {
            const pStart = poolLeft > 0 ? lastEnd + (needsIntro ? introMin * MIN_MS : 0)
                : (running ? lastEnd : nowMs) + (needsIntro ? introMin * MIN_MS : 0);
            end = pStart + playoffLeft * playoffMin * MIN_MS;
        }
        return { nextStart, poolEnd: lastEnd, end, gaps, games: poolLeft };
    }

    const current = {
        gameSec: clockGameSec,
        gapSec: clockGapSec,
        playoffMin: plan.playoffGameMin ?? 0,
        introMin: plan.playoffIntroMin
    };
    const proj = simulate(current);

    // ---- ahead / behind -----------------------------------------------------
    const plannedNext = nextIdx < rounds.length ? plan.starts[nextIdx] : null;
    const deltaMin = plannedNext != null ? (proj.nextStart - toMs(plannedNext)) / MIN_MS : null;
    let status = 'unknown';
    if (deltaMin != null) {
        status = deltaMin < AHEAD_MIN ? 'ahead' : deltaMin <= ON_TRACK_MAX ? 'on-track'
            : deltaMin <= BEHIND_MAX ? 'behind' : 'really-behind';
    }

    const deadlineMs = toMs(plan.divisionEnd);
    const allowedMs = deadlineMs + allowanceMin * MIN_MS;
    const overrunMin = (proj.end - deadlineMs) / MIN_MS;
    const fits = proj.end <= allowedMs;

    // ---- recommendations ----------------------------------------------------
    const finishes = (p) => simulate(p).end <= allowedMs;
    const levers = [];
    if (!fits) {
        const gap = lowerUntil(current, 'gapSec', GAP_STEP_SEC, MIN_GAP_SEC, finishes, simulate);
        const game = lowerUntil(current, 'gameSec', GAME_STEP_SEC, MIN_GAME_SEC, finishes, simulate);
        const playoff = plan.hasPlayoffs
            ? lowerUntil(current, 'playoffMin', PLAYOFF_STEP_MIN, MIN_PLAYOFF_MIN, finishes, simulate) : null;
        const intro = plan.hasPlayoffs && needsIntro
            ? lowerUntil(current, 'introMin', 1, MIN_PLAYOFF_INTRO_MIN, finishes, simulate) : null;
        if (proj.gaps > 0) levers.push({ key: 'gap', unit: 'sec', from: current.gapSec, ...gap });
        if (proj.games > 0) levers.push({ key: 'game', unit: 'sec', from: current.gameSec, ...game });
        if (playoff) levers.push({ key: 'playoff', unit: 'min', from: current.playoffMin, ...playoff });
        if (intro) levers.push({ key: 'intro', unit: 'min', from: current.introMin, ...intro });
    }

    // Combined: apply levers in order (gap, playoff intro, playoff game, pool game) until it fits.
    let combined = null;
    if (!fits) {
        const order = ['gap', 'intro', 'playoff', 'game'];
        const floors = { gap: ['gapSec', GAP_STEP_SEC, MIN_GAP_SEC], intro: ['introMin', 1, MIN_PLAYOFF_INTRO_MIN],
            playoff: ['playoffMin', PLAYOFF_STEP_MIN, MIN_PLAYOFF_MIN], game: ['gameSec', GAME_STEP_SEC, MIN_GAME_SEC] };
        const usable = new Set(levers.map(l => l.key));
        let cur = { ...current };
        const steps = [];
        for (const key of order) {
            if (!usable.has(key) || finishes(cur)) continue;
            const [field, step, floor] = floors[key];
            const r = lowerUntil(cur, field, step, floor, finishes, simulate);
            if (r.to !== cur[field]) { steps.push({ key, unit: key === 'gap' || key === 'game' ? 'sec' : 'min', from: cur[field], to: r.to }); cur = { ...cur, [field]: r.to }; }
        }
        const after = simulate(cur);
        combined = {
            steps,
            fits: after.end <= allowedMs,
            end: after.end,
            lateByMin: Math.max(0, Math.ceil((after.end - deadlineMs) / MIN_MS))
        };
    }

    return {
        ok: true,
        rounds,
        plan,
        status,
        deltaMin,
        current: { round: rounds[curIdx]?.label, running, inBreak, remainingSec: Math.round(remainingMs / 1000), ...current },
        nextRound: rounds[nextIdx]?.label ?? null,
        poolLeft,
        playoffLeft,
        projectedEndMs: proj.end,
        projectedPoolEndMs: proj.poolEnd,
        deadlineMs,
        plannedPlayoffEndMin: plan.playoffEnd,
        overrunMin,
        allowanceMin,
        fits,
        levers,
        combined,
        // Minutes past division_end needed to fit at the current pace.
        lateNeededMin: Math.max(0, Math.ceil(overrunMin)),
        sheetOverbooked: plan.playoffEnd != null && plan.playoffEnd > plan.divisionEnd
    };
}

/** Steps `field` down from its current value until `ok` passes or `floor` is hit. */
function lowerUntil(base, field, step, floor, ok) {
    let v = base[field];
    let p = { ...base };
    while (!ok(p) && v - step >= floor - 1e-9) {
        v -= step;
        p = { ...base, [field]: v };
    }
    return { to: v, enough: ok(p) };
}
