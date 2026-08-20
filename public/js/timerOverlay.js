// public/js/timerOverlay.js
// Superadmin timer controls. In the redesign these live inline on the Admin
// page (design §9 "Timer controls" card) rather than in a popover anchored to
// the header clock, so there is no positioning/show-hide logic left — the card
// is revealed with the rest of #admin-panel by updateAdminUI().
//
// What remains is the clock mirror: the timer modules only ever write the
// header's #timer-display, so we copy its text and colour onto the Admin
// page's large #admin-timer-display instead of teaching every timer backend
// about a second element.
export function initTimerOverlay() {
  if (App?.state?.isSuperAdmin !== true) return;

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
