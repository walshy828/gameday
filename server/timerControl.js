// server/timerControl.js
// Server-side round-clock logic for DATA_BACKEND=local. Three jobs:
//
//  1. Clock ownership. Each division's clock has at most one "controller"
//     (a tab, identified by a client-generated id). Control actions from anyone
//     else are refused with 409 until they explicitly take over, so two
//     tournament managers can't fight over Start/Stop/round.
//  2. Atomic transitions. Every action runs inside Store.mutateTimer (row lock +
//     column-level update), so a double Start, or a Stop racing an after-round
//     change, can't overwrite each other.
//  3. Expiry. When a running clock reaches zero the *server* performs the
//     after-round / reset transition, so it no longer depends on a particular
//     super admin tab being on that division (and N tabs don't each post it).
import { Store } from './datastores/index.js';

export class TimerError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const expiryTimers = new Map(); // division -> setTimeout handle

function resetPatch(cur) {
  return { running: false, duration: cur.lastSetDuration || 300, startAfterRoundRunning: false };
}

function clearExpiry(division) {
  const handle = expiryTimers.get(division);
  if (handle) clearTimeout(handle);
  expiryTimers.delete(division);
}

function scheduleExpiry(division, state) {
  clearExpiry(division);
  if (!state?.running || !state.startTime) return;
  const delay = Math.max(0, state.startTime + (state.duration || 0) * 1000 - Date.now()) + 50;
  const startTime = state.startTime;
  expiryTimers.set(division, setTimeout(() => handleExpiry(division, startTime), delay));
}

async function run(division, mutator) {
  const result = await Store.mutateTimer(division, mutator);
  scheduleExpiry(division, result.state);
  return result;
}

async function handleExpiry(division, startTime) {
  expiryTimers.delete(division);
  try {
    await run(division, (cur) => {
      // startTime doubles as a version: a clock that was stopped/restarted since
      // this timer was armed has a different startTime and is left alone.
      if (!cur.running || cur.startTime !== startTime) return null;
      if (!cur.startAfterRoundRunning && cur.afterRoundEnabled) {
        return {
          running: true,
          startTime: Date.now(),
          duration: cur.afterRoundDuration || 60,
          startAfterRoundRunning: true
        };
      }
      return resetPatch(cur);
    });
  } catch (e) {
    console.error(`timer expiry failed for "${division}"`, e);
  }
}

/** Re-arm expiry for clocks that were running when the server (re)started. */
export async function initTimerControl() {
  try {
    await Store.schemaReady; // table/column migrations must have run first
    const running = await Store.listRunningTimers();
    for (const t of running) scheduleExpiry(t.division, t);
  } catch (e) {
    console.error('initTimerControl failed', e);
  }
}

// Returns the ownership columns to merge into a patch: nothing if the caller
// already owns the clock, a claim if it is unowned, or a 409 if someone else does.
function requireControl(cur, client) {
  if (cur.controllerId && cur.controllerId !== client.id) {
    throw new TimerError(409, 'not_controller', { controllerName: cur.controllerName, state: cur });
  }
  return cur.controllerId === client.id ? {} : { controllerId: client.id, controllerName: client.name };
}

const nowRemaining = (cur) => {
  if (!cur.running || !cur.startTime) return cur.duration;
  const elapsed = Math.floor((Date.now() - cur.startTime) / 1000);
  return Math.max((cur.duration || 0) - elapsed, 0);
};

// Each action returns the patch for the clock's own fields; ownership is
// layered on top by controlTimer.
const ACTIONS = {
  // No-op while already running: a second Start must not rewrite startTime.
  start: (cur) => (cur.running ? {} : {
    running: true,
    startTime: Date.now(),
    duration: cur.duration || cur.lastSetDuration || 300
  }),
  stop: (cur) => (cur.running ? { running: false, duration: nowRemaining(cur) } : {}),
  reset: (cur) => resetPatch(cur),
  adjust: (cur, p) => {
    if (cur.running) return {};
    const delta = Number(p.deltaSeconds);
    if (!Number.isFinite(delta)) return {};
    const duration = Math.round(Math.max(30, (cur.duration || 0) + delta) / 30) * 30;
    return { duration, lastSetDuration: duration, running: false };
  },
  setRound: (cur, p) => {
    const round = typeof p.round === 'string' ? p.round.trim().slice(0, 64) : '';
    if (!round) throw new TimerError(400, 'invalid_round');
    return { currentRound: round };
  },
  afterRoundDuration: (cur, p) => {
    const n = Number(p.afterRoundDuration) || 60;
    return { afterRoundDuration: Math.min(3600, Math.max(15, Math.round(n))) };
  },
  showClock: (cur, p) => ({ showClock: !!p.showClock }),
  afterRoundEnabled: (cur, p) => ({ afterRoundEnabled: !!p.afterRoundEnabled })
};

export const TIMER_ACTION_NAMES = [...Object.keys(ACTIONS), 'takeover', 'release', 'fixRound'];

/**
 * Run a timer action for `division` on behalf of `client` ({ id, name }).
 * Resolves to { state, changed }; throws TimerError on refusal.
 */
export async function controlTimer(action, division, client, params = {}) {
  if (!division || typeof division !== 'string') throw new TimerError(400, 'invalid_division');

  if (action === 'takeover') {
    return run(division, () => ({ controllerId: client.id, controllerName: client.name }));
  }
  if (action === 'release') {
    return run(division, (cur) => (cur.controllerId === client.id
      ? { controllerId: null, controllerName: null }
      : null));
  }
  if (action === 'fixRound') {
    // Compare-and-set used when a tab loads a division whose stored round isn't
    // in its schedule: only applies if the round is still what the caller saw,
    // and never claims ownership — merely viewing a division must not take the clock.
    const round = typeof params.round === 'string' ? params.round.trim().slice(0, 64) : '';
    if (!round) throw new TimerError(400, 'invalid_round');
    return run(division, (cur) => ((cur.currentRound ?? null) === (params.expected ?? null)
      ? { currentRound: round }
      : null));
  }

  const fn = ACTIONS[action];
  if (!fn) throw new TimerError(404, 'unknown_action');
  return run(division, (cur) => {
    const claim = requireControl(cur, client);
    return { ...claim, ...fn(cur, params) };
  });
}
