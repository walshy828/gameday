// server/loadShield.js
// Traffic priority: keeps the people running the tournament fast when the
// crowd is large. Staff always get fresh data and instant live updates; the
// public (and, at the strongest level, crew-chat parents) get the same data a
// little later. Order of preference:
//   1. Tournament admins  2. Referees  3. Raffle / concessions  -> "staff", never throttled
//   4. Crew-chat parents  -> throttled only in Protect
//   5. Participants & parents with no sign-in -> throttled in Ease and Protect
//
// Three levels, set by the superadmin from Setup → Live now (in memory; a
// server restart goes back to Normal, the safe default):
//   normal  — public reads share a 2s cache (identical requests in a burst
//             hit the database once); live pushes go to everyone at once.
//   ease    — public reads cached 15s; public live pushes are batched to at
//             most one per division every 5s; public polling slows 2x.
//   protect — public reads cached 60s; public pushes at most every 30s,
//             parents every 5s; public polling slows 4x.
//
// Caches are dropped whenever the data actually changes (division write,
// sheet sync, announcement, feature setting), so "cached" only means
// "bursts are collapsed", not "stale", unless a write skips the broadcast.

export const MODES = {
  normal: { label: 'Normal', cacheMs: 2000, delay: { public: 0, parent: 0 }, pollFactor: 1 },
  ease: { label: 'Ease', cacheMs: 15000, delay: { public: 5000, parent: 0 }, pollFactor: 2 },
  protect: { label: 'Protect', cacheMs: 60000, delay: { public: 30000, parent: 5000 }, pollFactor: 4 }
};

let mode = 'normal';
let changedAt = 0;
let roleOf = () => null;
let onChange = () => {};
const cache = new Map(); // key -> { at, value } | { promise }
const stats = { hits: 0, misses: 0 };

export function setRoleResolver(fn) { roleOf = typeof fn === 'function' ? fn : () => null; }
export function setModeListener(fn) { onChange = typeof fn === 'function' ? fn : () => {}; }

/** 'staff' | 'parent' | 'public' for a role from chatRoleOf (null = no sign-in). */
export function tierOf(role) {
  if (role === 'superadmin' || role === 'admin' || role === 'raffle' || role === 'concessions') return 'staff';
  if (role === 'parent') return 'parent';
  return 'public';
}

export function getMode() { return mode; }
export function getModeInfo() {
  const m = MODES[mode];
  return { mode, label: m.label, changedAt, pollFactor: m.pollFactor, cacheMs: m.cacheMs, delay: m.delay, cache: { ...stats, entries: cache.size } };
}

export function setMode(next) {
  if (!MODES[next]) throw new Error('Unknown traffic mode');
  if (next === mode) return getModeInfo();
  mode = next;
  changedAt = Date.now();
  stats.hits = 0; stats.misses = 0;
  onChange(getModeInfo());
  return getModeInfo();
}

/** The delay before a live push reaches this tier, in the current mode. */
export function pushDelay(tier) {
  return tier === 'staff' ? 0 : (MODES[mode].delay[tier] || 0);
}

function bearer(req) {
  const h = req.headers.authorization;
  return typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

/**
 * Read-through cache for public GET routes. Staff (a valid staff token in the
 * Authorization header) always compute fresh. Concurrent misses share one
 * computation. Errors are never cached.
 */
export async function cachedRead(req, key, compute) {
  const token = bearer(req);
  if (token && tierOf(roleOf(token)) === 'staff') return compute();
  const now = Date.now();
  const hit = cache.get(key);
  if (hit) {
    if (hit.promise) { stats.hits++; return hit.promise; }
    if (now - hit.at < MODES[mode].cacheMs) { stats.hits++; return hit.value; }
  }
  stats.misses++;
  // If invalidate() runs while this is in flight, the entry is gone and the
  // (possibly pre-write) result is returned to these callers but not stored.
  const entry = {};
  entry.promise = compute().then(
    (value) => { if (cache.get(key) === entry) cache.set(key, { at: Date.now(), value }); return value; },
    (err) => { if (cache.get(key) === entry) cache.delete(key); throw err; }
  );
  cache.set(key, entry);
  return entry.promise;
}

/** Drop cached reads whose key starts with prefix (or everything). */
export function invalidate(prefix = '') {
  if (!prefix) { cache.clear(); return; }
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}
