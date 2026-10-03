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
//    so it never fights a manual click made seconds earlier.
import { getLiveRoundKey } from './schedule.js';

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
let autoSyncStarted = false;

function startRoundAutoSync(setCurrentRound) {
  if (autoSyncStarted || typeof setCurrentRound !== 'function') return;
  autoSyncStarted = true;

  setInterval(() => {
    if (App?.state?.isSuperAdmin !== true) return;
    if (!App?.data?.allScheduleData?.length) return;

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
      setCurrentRound(liveKey);
    }
  }, AUTO_SYNC_POLL_MS);
}

export function initTimerOverlay(setCurrentRound) {
  if (App?.state?.isSuperAdmin !== true) return;

  wireMirror();
  wirePopover();
  wireMoreDisclosure();
  startRoundAutoSync(setCurrentRound);
}
