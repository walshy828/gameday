// public/js/timerControlsUI.js
// Shared (both timer backends) rendering of clock ownership in the superadmin
// timer popover: a status banner with Take control / Take over / Release, and
// locking the control buttons while another tab owns the clock. Also remembers
// which division this tab last ran the clock for (see timerOverlay.js's guard).
import { getClientId } from './timerClient.js';

const LOCKABLE_IDS = [
  'plus-btn', 'minus-btn', 'start-btn', 'stop-btn', 'reset-btn',
  'after-round-toggle', 'minus-after-btn', 'plus-after-btn',
  'prev-round-btn', 'next-round-btn', 'toggle-display-switch'
];

export const LAST_DIVISION_KEY = 'timerLastDivision';

let handlers = { takeover: null, release: null };
let lastMine = false;
let lastDivision = null;
let wired = false;

export function setControlHandlers(h) {
  handlers = { ...handlers, ...h };
}

/** True when this tab owns the clock of `division` (as of the last state seen). */
export function isController(division) {
  return lastMine && lastDivision === division;
}

export function renderControlState(state, division) {
  const me = getClientId();
  const owner = state?.controllerId || null;
  const mine = owner === me;
  const locked = !!owner && !mine;
  lastMine = mine;
  lastDivision = division;

  if (mine && division) {
    try { sessionStorage.setItem(LAST_DIVISION_KEY, division); } catch { /* ignore */ }
  }

  for (const id of LOCKABLE_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.disabled = locked;
    el.style.opacity = locked ? '.4' : '';
  }

  const text = document.getElementById('timer-control-text');
  const btn = document.getElementById('timer-control-action');
  if (!text || !btn) return;

  if (!wired) {
    btn.addEventListener('click', () => {
      const fn = btn.dataset.mode === 'release' ? handlers.release : handlers.takeover;
      fn?.();
    });
    wired = true;
  }

  if (!owner) {
    text.textContent = 'Nobody is running this clock.';
    btn.textContent = 'Take control';
    btn.dataset.mode = 'takeover';
  } else if (mine) {
    text.textContent = 'You are running this clock.';
    btn.textContent = 'Release';
    btn.dataset.mode = 'release';
  } else {
    text.textContent = `${state.controllerName || 'Another manager'} is running this clock.`;
    btn.textContent = 'Take over';
    btn.dataset.mode = 'takeover';
  }
}
