// public/js/timerFirebase.js
// Round-timer/scoreboard logic for DATA_BACKEND=firebase (the default).
// The browser talks directly to Firebase RTDB using the client SDK
// (initialized in main.js before init() is called here).
//
// Each division has its own clock at `timer/byDivision/{division}` (nested
// under the original `timer` node so any security rules already on it keep
// applying). Viewing another division therefore never touches the one being
// run — the listeners just re-bind to the viewed division's node.
//
// There is no server in this mode, so safety comes from RTDB transactions:
//  - every control action is a transaction (a double Start is a no-op);
//  - clock ownership is stored in the node (controllerId/controllerName) and
//    checked inside each transaction — advisory only (a hostile client with
//    write access could ignore it) but it stops two managers colliding;
//  - the after-round toggle is stored in the node, not per tab;
//  - at expiry only the owning tab (or any super admin tab if the owner has
//    vanished for 4s) acts, and the transition is a transaction guarded by
//    the run's startTime, so duplicate attempts are harmless.
import { getClientId, getClientName } from './timerClient.js';
import { renderControlState, setControlHandlers } from './timerControlsUI.js';

const EXPIRY_TAKEOVER_MS = 4000;

let serverOffset = 0;
let localTimerInterval = null;
let allRounds = [];
let timerRef = null;
let roundsRef = null;
let boundDivision = null;
let valueHandler = null;
let latestData = null;
let lastServerTimeCheck = Date.now();

const currentDivision = () => App?.config?.currentSheetName || null;
const serverNow = () => Date.now() + serverOffset;
const isLockedFor = (data) => !!data?.controllerId && data.controllerId !== getClientId();

// Build ordered list from App.data.allScheduleData
function loadRounds() {
  if (!App?.data?.allScheduleData) return [];

  const all = App.data.allScheduleData
    .map(r => r.roundTime)
    .filter(Boolean);

  // Split into timed and playoff rounds
  const timeRounds = [...new Set(all.filter(t => !t.startsWith('P')))].sort((a, b) => {
    const parseTime = t => {
      const [time, period] = t.split(' ');
      let [hour, min] = time.split(':').map(Number);
      if (period === 'PM' && hour !== 12) hour += 12;
      if (period === 'AM' && hour === 12) hour = 0;
      return hour * 60 + min;
    };
    return parseTime(a) - parseTime(b);
  });

  const playoffRounds = [...new Set(all.filter(t => t.startsWith('P')))].sort((a, b) => {
    const nA = parseInt(a.match(/\d+/)?.[0] || '0', 10);
    const nB = parseInt(b.match(/\d+/)?.[0] || '0', 10);
    return nA - nB;
  });

  return [...timeRounds, ...playoffRounds];
}

// --- Division binding ---
// Points the listeners at the viewed division's clock node (detaching the
// previous one). Safe to call repeatedly; no-op if already bound.
function bindDivision(division) {
  if (!division || division === boundDivision) return;
  unbindDivision();

  boundDivision = division;
  timerRef = firebase.database().ref(`timer/byDivision/${division}`);
  roundsRef = timerRef.child('currentRound');
  valueHandler = timerRef.on('value', snap => onTimerValue(snap.val(), division));
}

function unbindDivision() {
  clearInterval(localTimerInterval);
  if (timerRef && valueHandler) timerRef.off('value', valueHandler);
  timerRef = null;
  roundsRef = null;
  boundDivision = null;
  valueHandler = null;
  latestData = null;
}

export function refreshState() {
  bindDivision(currentDivision());
}

// Single listener for everything on the clock node.
function onTimerValue(raw, division) {
  if (division !== boundDivision) return; // stale callback from a previous bind

  // A division nobody has touched yet has no node: render defaults locally
  // (writes happen on demand, inside the control transactions).
  const data = { duration: 300, lastSetDuration: 300, running: false, ...(raw || {}) };
  latestData = data;

  const scoreboard = document.getElementById('scoreboard');
  if (scoreboard) {
    // always visible to SuperAdmin
    scoreboard.style.display = (App.state.isSuperAdmin || data.showClock !== false) ? 'flex' : 'none';
  }

  updateDisplay(data);
  renderControlState(data, division);
  lastServerTimeCheck = Date.now();

  const toggleSwitch = document.getElementById('toggle-display-switch');
  if (toggleSwitch) toggleSwitch.checked = data.showClock ?? true;

  const afterRoundToggle = document.getElementById('after-round-toggle');
  if (afterRoundToggle) afterRoundToggle.checked = !!data.afterRoundEnabled;

  const afterRoundDurationDisplay = document.getElementById('after-round-duration');
  if (afterRoundDurationDisplay) afterRoundDurationDisplay.textContent = `${data.afterRoundDuration || 60}s`;

  const current = data.currentRound || allRounds[0] || 'Unknown Round';
  const roundDisplayEl = document.getElementById('current-round-display');
  if (roundDisplayEl) roundDisplayEl.textContent = current;
  // Mirror into the Admin timer card's kicker (design §9: "ROUND n · DIVISION")
  const kicker = document.getElementById('admin-round-kicker');
  if (kicker) kicker.textContent = `${current} · ${division}`;
}

export function initRounds() {
  // loadData finished for the viewed division — make sure we're bound to it.
  bindDivision(currentDivision());
  if (!App?.data?.allScheduleData || !roundsRef) return;

  allRounds = loadRounds();

  // If the stored round isn't one of this division's rounds, repair it — only
  // from a super admin tab, only once this division's schedule is actually the
  // one loaded, and inside a transaction so a round chosen meanwhile survives.
  if (App.state?.isSuperAdmin && App.data.scheduleDivision === boundDivision && allRounds.length) {
    timerRef.transaction(cur => {
      cur = cur || {};
      if (allRounds.includes((cur.currentRound || '').trim())) return; // already valid: abort
      return { duration: 300, lastSetDuration: 300, running: false, ...cur, currentRound: allRounds[0] };
    });
  }

  // Attach buttons now that rounds exist
  const nextBtn = document.getElementById('next-round-btn');
  const prevBtn = document.getElementById('prev-round-btn');

  const step = (dir) => {
    mutate(cur => {
      const current = (cur.currentRound || '').trim();
      let idx = allRounds.findIndex(r => r.trim() === current);
      if (idx === -1) idx = 0; // fallback
      const target = idx + dir;
      if (target < 0 || target > allRounds.length - 1) return null;
      return { currentRound: allRounds[target] };
    });
  };
  nextBtn.onclick = () => step(1);
  prevBtn.onclick = () => step(-1);
}

// Redesign palette (design tokens, §5/§9): the clock is gold-light while it
// runs, warm gold during the after-round breather, and --warn once it's
// stopped/expired. No glow — the design uses flat tabular numerals.
function updateTimerColor(el, data) {
  el.style.textShadow = 'none';
  if (!data.running) {
    el.style.color = 'var(--warn)';
  } else if (data.startAfterRoundRunning) {
    el.style.color = 'var(--gold)';
  } else {
    el.style.color = 'var(--gold-l)';
  }
}

function formatTime(sec) {
  const m = String(Math.floor(sec / 60)).padStart(1, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

// --- Blink 0:00 for 5s then reset ---
function blinkThenReset(originalDuration) {
  const el = document.getElementById('timer-display');
  let visible = true;
  let count = 0;

  const blinkInterval = setInterval(() => {
    el.style.visibility = visible ? 'hidden' : 'visible';
    visible = !visible;
    count++;
    if (count >= 10) { // 5 seconds @ 500ms toggle
      clearInterval(blinkInterval);
      el.style.visibility = 'visible';
      // Local reset only (don't touch Firebase)
      el.innerText = formatTime(originalDuration);
    }
  }, 500);
}

// --- Writes ---
// Every control action funnels through here: a transaction that aborts when
// someone else owns the clock, claims an unowned clock for this tab, and
// applies `fn(current)`'s patch (null = nothing to do).
function ownershipFor(cur) {
  const me = getClientId();
  return cur.controllerId === me ? {} : { controllerId: me, controllerName: getClientName() };
}

function mutate(fn) {
  if (!timerRef) return Promise.resolve();
  return timerRef.transaction(cur => {
    cur = cur || {};
    if (isLockedFor(cur)) return; // abort
    const patch = fn(cur);
    if (!patch) return; // abort: nothing to write
    return { ...cur, ...ownershipFor(cur), ...patch };
  }).then(result => {
    if (!result.committed && isLockedFor(latestData)) {
      window.showStatus?.(`${latestData.controllerName || 'Another manager'} is running this clock. Use "Take over" to control it.`, true);
    }
  }).catch(e => console.error('Timer write failed', e));
}

const remainingOf = (cur) => {
  const elapsed = Math.floor((serverNow() - cur.startTime) / 1000);
  return Math.max((cur.duration || 0) - elapsed, 0);
};

// At zero: start the after-round breather, or reset. Guarded by startTime so a
// clock that was stopped/restarted meanwhile — or an expiry another tab already
// performed — is left alone.
function expireClock(expiredStartTime) {
  if (!timerRef) return;
  timerRef.transaction(cur => {
    if (!cur || !cur.running || cur.startTime !== expiredStartTime) return; // abort
    if (!cur.startAfterRoundRunning && cur.afterRoundEnabled) {
      return {
        ...cur,
        duration: cur.afterRoundDuration || 60,
        startTime: firebase.database.ServerValue.TIMESTAMP,
        running: true,
        startAfterRoundRunning: true
      };
    }
    return {
      ...cur,
      duration: cur.lastSetDuration || 300,
      running: false,
      startAfterRoundRunning: false
    };
  }).catch(e => console.error('Timer expiry failed', e));
}

function updateDisplay(timerData) {
  // Clear any previous interval
  clearInterval(localTimerInterval);

  const timerEl = document.getElementById('timer-display');
  const running = timerData.running;
  const duration = timerData.duration ?? 0;

  // Buttons
  const plusBtn = document.getElementById('plus-btn');
  const minusBtn = document.getElementById('minus-btn');
  const startBtn = document.getElementById('start-btn');
  const stopBtn = document.getElementById('stop-btn');
  const resetBtn = document.getElementById('reset-btn');

  const showAdjust = !running && duration === (timerData.lastSetDuration || 300);
  plusBtn.style.display = showAdjust ? 'inline-block' : 'none';
  minusBtn.style.display = showAdjust ? 'inline-block' : 'none';
  startBtn.style.display = running ? 'none' : 'inline-block';
  stopBtn.style.display = running ? 'inline-block' : 'none';
  resetBtn.style.display = !running && !showAdjust ? 'inline-block' : 'none';

  // Determine remaining seconds
  function getRemaining() {
    if (running) {
      return Math.max(0, duration - Math.floor((serverNow() - timerData.startTime) / 1000));
    }
    return duration;
  }

  // Update display initially
  let remaining = getRemaining();
  updateTimerColor(timerEl, timerData);
  timerEl.innerText = formatTime(remaining);

  if (!running) return; // no need to run interval if not running

  // --- Main interval ---
  const me = getClientId();
  localTimerInterval = setInterval(() => {
    remaining = getRemaining();
    timerEl.innerText = formatTime(remaining);
    updateTimerColor(timerEl, timerData);

    if (remaining > 0) return;

    if (!App.state.isSuperAdmin) {
      // Blink 0:00 locally for everyone else; the super admin's transition
      // arrives through the listener.
      clearInterval(localTimerInterval);
      blinkThenReset(timerData.lastSetDuration || 300);
      return;
    }

    // Super admin tabs: the owner (or any tab if nobody owns it) acts at once;
    // a non-owner only steps in if the owner hasn't acted within the grace period.
    const overdueMs = serverNow() - (timerData.startTime + duration * 1000);
    const mayAct = !timerData.controllerId || timerData.controllerId === me || overdueMs > EXPIRY_TAKEOVER_MS;
    if (mayAct) {
      clearInterval(localTimerInterval);
      expireClock(timerData.startTime);
    }
  }, 250);
}

// --- Controls ---
const adjustTime = (delta) => mutate(cur => {
  if (cur.running) return null;
  let newDuration = Math.max(30, (cur.duration || 0) + delta);
  newDuration = Math.round(newDuration / 30) * 30;
  return { duration: newDuration, lastSetDuration: newDuration, running: false };
});

// A second Start while running is a no-op (must not rewrite startTime).
const startTimer = () => mutate(cur => (cur.running ? null : {
  startTime: firebase.database.ServerValue.TIMESTAMP,
  running: true,
  duration: cur.duration || 300,
  lastSetDuration: cur.lastSetDuration || cur.duration || 300
}));

const stopTimer = () => mutate(cur => (cur.running
  ? { duration: remainingOf(cur), running: false }
  : null));

const resetTimer = () => mutate(cur => ({
  duration: cur.lastSetDuration || 300,
  running: false,
  startAfterRoundRunning: false
}));

// Used by timerOverlay.js's round auto-sync (sets currentRound straight to a
// computed value, unlike the Prev/Next buttons which step by one index).
export function setCurrentRound(round) {
  if (!round) return;
  mutate(() => ({ currentRound: round }));
}

export function init() {
  const db = firebase.database();
  const offsetRef = db.ref('.info/serverTimeOffset');

  // --- Server offset ---
  offsetRef.on('value', snap => {
    serverOffset = snap.val() || 0;
  });

  // --- Connectivity indicator: red border on the clock when sync is stale ---
  setInterval(() => {
    const scoreboardEl = document.getElementById('scoreboard');
    if (!scoreboardEl) return;
    const diff = Math.abs(Date.now() - lastServerTimeCheck);
    scoreboardEl.style.borderColor = diff < 2000 ? '' : '#ef4444';
  }, 2000);

  // The clock node itself is bound once the viewed division is known — see
  // refreshState()/initRounds(), called from main.js on every division load.
  bindDivision(currentDivision());

  // --- Show/Hide toggle switch ---
  const toggleSwitch = document.getElementById('toggle-display-switch');
  if (toggleSwitch) {
    toggleSwitch.onchange = (e) => {
      const isChecked = e.target.checked;
      mutate(() => ({ showClock: isChecked }));
    };
  } else {
    console.error('Could not find #toggle-display-switch element.');
  }

  // --- After-Round Duration Controls ---
  const afterRoundSettingsBtn = document.getElementById('after-round-settings-btn');
  const afterRoundSettings = document.getElementById('after-round-settings');
  const plusAfterBtn = document.getElementById('plus-after-btn');
  const minusAfterBtn = document.getElementById('minus-after-btn');

  // Toggle visibility of the settings
  afterRoundSettingsBtn.onclick = () => {
    afterRoundSettings.classList.toggle('hidden');
  };

  const adjustAfterRoundTime = (delta) => mutate(cur => ({
    afterRoundDuration: Math.max(15, (cur.afterRoundDuration || 60) + delta)
  }));

  // Increment/decrement buttons
  plusAfterBtn.onclick = () => adjustAfterRoundTime(15);
  minusAfterBtn.onclick = () => adjustAfterRoundTime(-15);

  // --- Attach buttons ---
  document.getElementById('plus-btn').onclick = () => adjustTime(30);
  document.getElementById('minus-btn').onclick = () => adjustTime(-30);
  document.getElementById('start-btn').onclick = startTimer;
  document.getElementById('stop-btn').onclick = stopTimer;
  document.getElementById('reset-btn').onclick = resetTimer;
  document.getElementById('after-round-toggle').onchange = e => {
    // Shared per-division setting stored on the clock node, not a per-tab flag.
    const enabled = e.target.checked;
    mutate(() => ({ afterRoundEnabled: enabled })).then(() => {
      e.target.checked = !!latestData?.afterRoundEnabled;
    });
  };

  // --- Clock ownership ---
  setControlHandlers({
    takeover: () => timerRef?.transaction(cur => ({
      ...(cur || {}),
      controllerId: getClientId(),
      controllerName: getClientName()
    })),
    release: () => timerRef?.transaction(cur => {
      if (!cur || cur.controllerId !== getClientId()) return; // abort
      return { ...cur, controllerId: null, controllerName: null };
    })
  });
}
