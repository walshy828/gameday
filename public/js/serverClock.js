// public/js/serverClock.js
// Estimates (server clock - this device's clock) so countdowns computed from
// server-stamped startTimes agree across devices regardless of local clock
// settings. NTP-style: take several samples of /api/time, keep the one with the
// lowest round-trip (least queueing noise), assume symmetric latency. Re-synced
// periodically and when the tab returns / the network comes back, since device
// clocks get stepped and drift.
let offsetMs = 0;
let started = false;

export const serverOffsetMs = () => offsetMs;
export const serverNow = () => Date.now() + offsetMs;

async function sample() {
  const t0 = Date.now();
  const res = await fetch('/api/time', { cache: 'no-store' });
  const t1 = Date.now();
  const { now } = await res.json();
  if (!Number.isFinite(now)) throw new Error('bad /api/time');
  return { rtt: t1 - t0, offset: now - (t0 + t1) / 2 };
}

export async function syncServerClock(samples = 5) {
  let best = null;
  for (let i = 0; i < samples; i++) {
    try {
      const s = await sample();
      if (!best || s.rtt < best.rtt) best = s;
    } catch { /* keep what we have */ }
  }
  if (best) offsetMs = Math.round(best.offset);
  return offsetMs;
}

export function startServerClockSync() {
  if (started) return;
  started = true;
  syncServerClock();
  setInterval(() => syncServerClock(3), 60_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncServerClock(3); });
  window.addEventListener('online', () => syncServerClock(3));
}
