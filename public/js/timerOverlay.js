// public/js/timerOverlay.js
// Superadmin timer controls: a popover anchored to the header round-clock
// (#scoreboard), reachable from any page — tap the clock to open it. Same
// control IDs the timer backend modules (timerFirebase.js / timerLocal.js)
// bind to; they don't know or care that the controls live in a popover now.
//
// Two extra jobs live here that aren't backend-specific:
//  - Mirror the header's #timer-display text/colour onto the popover's own
//    big #admin-timer-display (the backends only ever write the header).
//  - Auto-sync the timer's round label to the schedule's computed "on court
//    now" round (getLiveRoundKey in schedule.js) whenever that round
//    actually changes. Manual Prev/Next (in "More controls") still works as
//    an override in between transitions — this only fires on a real flip,
//    so it never fights a manual click made seconds earlier. It only runs in
//    the tab that owns this division's clock, and re-baselines on every
//    division switch so browsing another division can never write a round.
//  - Wrong-division guard: a warning banner (and a confirm before the first
//    control click) when the division being viewed isn't the one this tab last
//    ran the clock for — e.g. a manager peeking at another division.
import { getLiveRoundKey } from './schedule.js';
import { isController, LAST_DIVISION_KEY } from './timerControlsUI.js';

const AUTO_SYNC_POLL_MS = 5000;

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

// undefined until the first poll tick establishes a baseline — we never want
// the very first check (e.g. right after page load/reconnect) to clobber
// whatever round is already set.
let lastSyncedLiveKey;
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

    // Division switched: drop the old baseline so the new division's live
    // round is treated as a fresh baseline, never as a "flip" to write.
    if (division !== lastSyncedDivision) {
      lastSyncedDivision = division;
      lastSyncedLiveKey = undefined;
    }

    // The schedule in memory must be the viewed division's (it lags the
    // division switch while loadData is in flight).
    if (App.data?.scheduleDivision !== division) return;
    if (!App.data.allScheduleData?.length) return;

    let liveKey;
    try {
      liveKey = getLiveRoundKey();
    } catch {
      return;
    }
    if (!liveKey) return; // everything reported — leave the clock on the last round

    if (lastSyncedLiveKey === undefined) {
      lastSyncedLiveKey = liveKey;
      return;
    }
    if (liveKey !== lastSyncedLiveKey) {
      lastSyncedLiveKey = liveKey;
      // Only the tab that owns this division's clock writes its round; every
      // other super admin tab just observes.
      if (isController(division)) setCurrentRound(liveKey);
    }
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
