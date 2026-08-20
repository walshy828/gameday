// public/js/timerFirebase.js
// Round-timer/scoreboard logic for DATA_BACKEND=firebase (the default).
// Unchanged behavior from the original inline implementation in main.js:
// the browser talks directly to the Firebase RTDB `timer` node using the
// Firebase client SDK (initialized in main.js before init() is called here).

let serverOffset = 0;
let localTimerInterval = null;
let afterRoundEnabled = false;
let allRounds = [];
let timerRef = null;
let roundsRef = null;

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

export function initRounds() {
  if (!App?.data?.allScheduleData || !roundsRef) return;

  allRounds = loadRounds();

  // Ensure currentRound is valid
  roundsRef.once('value').then(snap => {
    let val = (snap.val() || '').trim();
    if (!allRounds.includes(val)) {
      // If Firebase has a bad/mismatched value, reset to first valid round
      roundsRef.set(allRounds[0] || 'Unknown Round');
      console.log('currentRound fixed to:', allRounds[0]);
    }
  });

  // Attach buttons now that rounds exist
  const nextBtn = document.getElementById('next-round-btn');
  const prevBtn = document.getElementById('prev-round-btn');

  nextBtn.onclick = async () => {
    const snap = await roundsRef.get();
    const current = (snap.val() || '').trim();
    let idx = allRounds.findIndex(r => r.trim() === current);
    if (idx === -1) idx = 0; // fallback
    console.log('Next clicked, current index:', idx, 'current:', current);

    if (idx < allRounds.length - 1) {
      roundsRef.set(allRounds[idx + 1]);
    }
  };

  prevBtn.onclick = async () => {
    const snap = await roundsRef.get();
    const current = (snap.val() || '').trim();
    let idx = allRounds.findIndex(r => r.trim() === current);
    if (idx === -1) idx = 0; // fallback
    console.log('Prev clicked, current index:', idx, 'current:', current);

    if (idx > 0) {
      roundsRef.set(allRounds[idx - 1]);
    }
  };
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

function startAfterRound(originalDuration) {
  timerRef.child('afterRoundDuration').get().then(snap => {
    const afterRoundDuration = snap.val() || 60;

    timerRef.update({
      duration: afterRoundDuration,
      startTime: firebase.database.ServerValue.TIMESTAMP,
      running: true,
      startAfterRoundRunning: true
    });
  });
}

function updateDisplay(timerData) {
  // Clear any previous interval
  clearInterval(localTimerInterval);

  const timerEl = document.getElementById('timer-display');
  const running = timerData.running;
  const afterRound = timerData.startAfterRoundRunning;
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
      const now = Date.now() + serverOffset;
      return Math.max(0, duration - Math.floor((now - timerData.startTime) / 1000));
    }
    return duration;
  }

  // Update display initially
  let remaining = getRemaining();
  updateTimerColor(timerEl, timerData);
  timerEl.innerText = formatTime(remaining);

  if (!running) return; // no need to run interval if not running

  // --- Main interval ---
  localTimerInterval = setInterval(() => {
    remaining = getRemaining();
    timerEl.innerText = formatTime(remaining);
    updateTimerColor(timerEl, timerData);

    if (remaining <= 0) {
      clearInterval(localTimerInterval);

      if (afterRound) {
        // After-round finished, reset to original timer
        timerRef.update({
          duration: timerData.lastSetDuration,
          lastSetDuration: timerData.lastSetDuration,
          running: false,
          startAfterRoundRunning: false
        });
      } else if (afterRoundEnabled) {
        // Start after-round
        startAfterRound(timerData.lastSetDuration || 300);
      } else if (!App.state.isSuperAdmin) {
        // Blink 0:00 locally for non-super admins
        blinkThenReset(timerData.lastSetDuration || 300);
      } else {
        // Super admin just resets to original duration
        timerRef.update({
          duration: timerData.lastSetDuration,
          running: false
        });
      }
    }
  }, 250);
}

// --- Adjustment buttons ---
function adjustTime(delta) {
  timerRef.transaction(current => {
    if (!current || current.running) return current;
    const currentDuration = current.duration || 0;
    let newDuration = Math.max(30, currentDuration + delta);
    newDuration = Math.round(newDuration / 30) * 30;
    return { ...current, duration: newDuration, lastSetDuration: newDuration, running: false };
  });
}

// --- Start / Stop / Reset ---
function startTimer() {
  timerRef.once('value').then(snapshot => {
    const data = snapshot.val() || {};
    const duration = data.duration || 300;

    const newData = {
      startTime: firebase.database.ServerValue.TIMESTAMP,
      running: true,
      duration
    };

    timerRef.update(newData);
    updateDisplay({ ...data, ...newData, startTime: Date.now() + serverOffset });
  });
}

function stopTimer() {
  timerRef.once('value').then(snapshot => {
    const data = snapshot.val();
    if (!data || !data.running) return;

    const now = Date.now() + serverOffset;
    const elapsed = Math.floor((now - data.startTime) / 1000);
    const remaining = Math.max(data.duration - elapsed, 0);

    timerRef.update({ duration: remaining, running: false });
  });
}

function resetTimer() {
  timerRef.once('value').then(snap => {
    const data = snap.val();
    if (!data) return;
    timerRef.update({
      duration: data.lastSetDuration || 300,
      running: false,
      startAfterRoundRunning: false
    });
  });
}

export function init() {
  const db = firebase.database();
  timerRef = db.ref('timer');
  const offsetRef = db.ref('.info/serverTimeOffset');
  roundsRef = timerRef.child('currentRound');

  // --- Server offset ---
  offsetRef.on('value', snap => {
    serverOffset = snap.val() || 0;
  });

  // --- Sync Indicator ---
  let lastServerTimeCheck = Date.now();
  setInterval(() => {
    const syncIndicator = document.getElementById('sync-indicator');
    const now = Date.now();
    const diff = Math.abs(now - lastServerTimeCheck);
    syncIndicator.style.background = diff < 2000 ? 'limegreen' : 'red';
  }, 2000);

  // --- Main Timer Listener ---
  timerRef.on('value', snapshot => {
    const data = snapshot.val();
    if (!data) return;

    // Ensure defaults
    if (data.duration === undefined) {
      timerRef.update({ duration: 300, lastSetDuration: 300, running: false });
      return;
    }
    const scoreboard = document.getElementById('scoreboard');
    if (scoreboard) {
      if (App.state.isSuperAdmin) {
        scoreboard.style.display = 'flex'; // always visible to SuperAdmin
      } else {
        scoreboard.style.display = data.showClock === false ? 'none' : 'flex';
      }
    }

    updateDisplay(data);
    lastServerTimeCheck = Date.now();
  });

  // --- Show/Hide toggle switch listener ---
  const toggleSwitch = document.getElementById('toggle-display-switch');

  if (toggleSwitch) {
    // This listener syncs the switch's state FROM Firebase
    timerRef.child('showClock').on('value', snap => {
      const showClock = snap.val() ?? true;

      // 1. Update the toggle switch's checked state
      toggleSwitch.checked = showClock;

      // 2. Update the scoreboard visibility (this logic is unchanged)
      const scoreboard = document.getElementById('scoreboard');
      if (scoreboard) {
        if (App.state.isSuperAdmin) {
          scoreboard.style.display = 'flex'; // always visible locally
        } else {
          scoreboard.style.display = showClock ? 'flex' : 'none';
        }
      }
    });

    // This listener syncs the switch's state TO Firebase
    toggleSwitch.onchange = async (e) => {
      const isChecked = e.target.checked;

      // Update the Firebase flag
      // This will trigger the 'on' listener above for all clients
      await timerRef.update({ showClock: isChecked });
    };

  } else {
    console.error('Could not find #toggle-display-switch element.');
  }

  // --- Listen for round changes ---
  const roundDisplayEl = document.getElementById('current-round-display');
  roundsRef.on('value', snap => {
    const current = snap.val() || allRounds[0] || 'Unknown Round';
    roundDisplayEl.textContent = current;
    // Mirror into the Admin timer card's kicker (design §9: "ROUND n · DIVISION")
    const kicker = document.getElementById('admin-round-kicker');
    if (kicker) kicker.textContent = `${current} · ${App.config.currentSheetName || ''}`;
  });

  // --- After-Round Duration Controls ---
  const afterRoundSettingsBtn = document.getElementById('after-round-settings-btn');
  const afterRoundSettings = document.getElementById('after-round-settings');
  const afterRoundDurationDisplay = document.getElementById('after-round-duration');
  const plusAfterBtn = document.getElementById('plus-after-btn');
  const minusAfterBtn = document.getElementById('minus-after-btn');

  // Load the stored after-round duration once
  timerRef.child('afterRoundDuration').on('value', snap => {
    const val = snap.val() || 60;
    afterRoundDurationDisplay.textContent = `${val}s`;
  });

  // Toggle visibility of the settings
  afterRoundSettingsBtn.onclick = () => {
    afterRoundSettings.classList.toggle('hidden');
  };

  function adjustAfterRoundTime(delta) {
    timerRef.child('afterRoundDuration').get().then(snap => {
      let current = snap.val() || 60;
      let updated = Math.max(15, current + delta);
      timerRef.update({ afterRoundDuration: updated });
    });
  }

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
    afterRoundEnabled = e.target.checked;
  };
}
