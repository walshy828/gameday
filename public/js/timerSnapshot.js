// public/js/timerSnapshot.js
// Latest round-clock state for the viewed division, published by whichever
// timer backend is active (timerFirebase.js / timerLocal.js) so read-only
// consumers like the Game Management view don't need to know which one it is.
let snapshot = null;

export function setTimerSnapshot(division, state, offsetMs = 0) {
  snapshot = { division, state, offsetMs };
  window.dispatchEvent(new CustomEvent('timersnapshot'));
}

/** { state, nowMs } for `division`, or null if the clock hasn't loaded for it. */
export function getTimerSnapshot(division) {
  if (!snapshot || snapshot.division !== division) return null;
  return { state: snapshot.state, nowMs: Date.now() + snapshot.offsetMs };
}
