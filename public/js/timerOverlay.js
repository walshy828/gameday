// public/js/timerOverlay.js
// Superadmin timer controls: a popover anchored to the header round-clock
// (#scoreboard), reachable from any page — tap the clock to open it. Same
// control IDs the timer backend modules (timerFirebase.js / timerLocal.js)
// bind to; they don't know or care that the controls live in a popover now.
//
// Two extra jobs live here that aren't backend-specific:
//  - Mirror the header's #timer-display text/colour onto the popover's own
//    big #admin-timer-display (the backends only ever write the header).
//  - Auto-sync the timer's round label to the "on court now" round: the
//    earliest round with a game that has no result yet (referee-submitted or
//    official). When that round changes it is written to the clock, retrying
//    until the clock matches; a clock found behind on load is caught up. Manual
//    Prev/Next (in "More controls") still works as an override in between
//    transitions. It only writes from the tab that owns this division's clock,
//    and re-baselines on every division switch so browsing another division can
//    never write a round.
//  - Wrong-division guard: a warning banner (and a confirm before the first
//    control click) when the division being viewed isn't the one this tab last
//    ran the clock for — e.g. a manager peeking at another division.
import { getRoundOrder, isReported } from './schedule.js';
import { getTimerSnapshot } from './timerSnapshot.js';
import { isController, LAST_DIVISION_KEY } from './timerControlsUI.js';

const AUTO_SYNC_POLL_MS = 2000;

const hasValue = (v) => { const t = (v || '').trim(); return t !== '' && t !== 'TBA' && t !== '—'; };

// A game counts as reported once the referee has submitted a result
// (adminWinner) *or* it is official (winner). schedule.js's isReported only
// sees the official one, which would hold the clock on a round until the
// tournament manager confirmed every result.
const isGameDone = (g) => isReported(g) || hasValue(g.adminWinner);

/** Earliest round that still has an unreported game; undefined when all are done. */
function liveRoundForClock() {
  return getRoundOrder().find(key =>
    App.data.allScheduleData.some(g => (g.roundTime || 'TBD') === key && !isGameDone(g))
  );
}

function wireMirror() {
  const source = document.getElementById('timer-display');
  const mirror = document.getElementById('admin-timer-display');
  if (!source || !mirror || mirror.dataset.mirrorInit) return;

  const sync = () => {
    mirror.textContent = source.textContent;
    mirror.style.color = source.style.color || 'var(--gold-l)';
  };

  sync();
  new MutationObserver(sync).observe(source, {
    childList: true,
    characterData: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style']
  });

  mirror.dataset.mirrorInit = 'true';
}

function wirePopover() {
  const clock = document.getElementById('scoreboard');
  const panel = document.getElementById('timer-overlay-panel');
  const closeBtn = document.getElementById('timer-overlay-close');
  if (!clock || !panel || clock.dataset.overlayInit) return;

  const close = () => panel.classList.add('hidden');

  clock.style.cursor = 'pointer';
  clock.addEventListener('click', (e) => {
    e.stopPropagation();
    if (App?.state?.isSuperAdmin !== true) return;
    panel.classList.toggle('hidden');
    updateDivisionWarning();
  });
  closeBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    close();
  });

  // Click-outside and Escape both close it.
  document.addEventListener('click', (e) => {
    if (panel.classList.contains('hidden')) return;
    if (panel.contains(e.target) || clock.contains(e.target)) return;
    close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  window.closeTimerOverlay = close;
  clock.dataset.overlayInit = 'true';
}

const viewedDivision = () => App?.config?.currentSheetName || null;

function lastControlledDivision() {
  try { return sessionStorage.getItem(LAST_DIVISION_KEY); } catch { return null; }
}

// Shows/hides the "you're viewing a different division" banner in the popover.
function updateDivisionWarning() {
  const el = document.getElementById('timer-division-warning');
  if (!el) return;
  const last = lastControlledDivision();
  const viewed = viewedDivision();
  const mismatch = !!last && !!viewed && last !== viewed;
  el.classList.toggle('hidden', !mismatch);
  if (mismatch) {
    el.textContent = `You're viewing ${viewed}, but you last ran the clock for ${last}. These controls act on ${viewed}.`;
  }
}

// Capture-phase guard on the popover: the first control click against a
// division other than the one last controlled needs a confirm. Declined clicks
// never reach the backend's onclick/onchange handlers.
function wireDivisionGuard() {
  const panel = document.getElementById('timer-overlay-panel');
  if (!panel || panel.dataset.guardInit) return;

  const GUARDED = new Set([
    'plus-btn', 'minus-btn', 'start-btn', 'stop-btn', 'reset-btn',
    'after-round-toggle', 'minus-after-btn', 'plus-after-btn',
    'prev-round-btn', 'next-round-btn', 'toggle-display-switch', 'timer-control-action'
  ]);

  panel.addEventListener('click', (e) => {
    const target = e.target.closest?.('button, input');
    if (!target || !GUARDED.has(target.id)) return;
    // Releasing control is always safe.
    if (target.id === 'timer-control-action' && target.dataset.mode === 'release') return;

    const last = lastControlledDivision();
    const viewed = viewedDivision();
    if (last && viewed && last !== viewed) {
      const ok = window.confirm(`You're about to control the clock for ${viewed}, not ${last}. Continue?`);
      if (!ok) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      try { sessionStorage.setItem(LAST_DIVISION_KEY, viewed); } catch { /* ignore */ }
      updateDivisionWarning();
    } else if (!last && viewed) {
      try { sessionStorage.setItem(LAST_DIVISION_KEY, viewed); } catch { /* ignore */ }
    }
  }, true);

  panel.dataset.guardInit = 'true';
}

function wireMoreDisclosure() {
  const toggleBtn = document.getElementById('timer-more-toggle');
  const panel = document.getElementById('timer-more-panel');
  const chevron = document.getElementById('timer-more-chevron');
  if (!toggleBtn || !panel || toggleBtn.dataset.init) return;

  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const nowHidden = panel.classList.toggle('hidden');
    chevron?.classList.toggle('rotate-180', !nowHidden);
  });

  toggleBtn.dataset.init = 'true';
}

// Edge + retry: a change of the live round (the earliest round with an
// unreported game) marks that round as *pending*; it stays pending until the
// clock's stored round actually equals it, retrying every tick while this tab
// owns the clock. So a write that failed, a flip that happened while the tab was
// backgrounded/not the owner, or a dropped update can't leave the clock behind.
// Once the clock matches, pending clears — a later manual Prev/Next is never
// fought. On the first look at a division, a clock sitting *behind* the live
// round is caught up (never moved backwards).
let lastSeenLiveKey;
let pendingKey = null;
let lastSyncedDivision = null;
let autoSyncStarted = false;

function startRoundAutoSync(setCurrentRound) {
  if (autoSyncStarted || typeof setCurrentRound !== 'function') return;
  autoSyncStarted = true;

  setInterval(() => {
    if (App?.state?.isSuperAdmin !== true) return;
    updateDivisionWarning();

    const division = viewedDivision();
    if (!division) return;

    // Division switched: forget the old division's baseline/pending round so
    // browsing another division can never write a round.
    if (division !== lastSyncedDivision) {
      lastSyncedDivision = division;
      lastSeenLiveKey = undefined;
      pendingKey = null;
    }

    // The schedule in memory must be the viewed division's (it lags the
    // division switch while loadData is in flight).
    if (App.data?.scheduleDivision !== division) return;
    if (!App.data.allScheduleData?.length) return;

    let liveKey;
    try {
      liveKey = liveRoundForClock();
    } catch {
      return;
    }
    if (!liveKey) { pendingKey = null; return; } // everything reported — leave the clock on the last round

    // Need the clock's current state for this division before judging anything.
    const snap = getTimerSnapshot(division);
    if (!snap) return;
    const clockRound = (snap.state?.currentRound || '').trim();

    if (lastSeenLiveKey === undefined) {
      lastSeenLiveKey = liveKey;
      const order = getRoundOrder();
      if (order.indexOf(clockRound) < order.indexOf(liveKey)) pendingKey = liveKey; // catch up
    } else if (liveKey !== lastSeenLiveKey) {
      lastSeenLiveKey = liveKey;
      pendingKey = liveKey;
    }

    if (!pendingKey) return;
    pendingKey = liveKey; // always chase the latest live round
    if (clockRound === pendingKey) { pendingKey = null; return; }

    // Only the tab that owns this division's clock writes its round; every
    // other super admin tab just observes (and writes if it later takes over).
    if (isController(division)) setCurrentRound(pendingKey);
  }, AUTO_SYNC_POLL_MS);
}

export function initTimerOverlay(setCurrentRound) {
  if (App?.state?.isSuperAdmin !== true) return;

  wireMirror();
  wirePopover();
  wireMoreDisclosure();
  wireDivisionGuard();
  startRoundAutoSync(setCurrentRound);
}
