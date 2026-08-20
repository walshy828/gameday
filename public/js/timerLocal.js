// public/js/timerLocal.js
// Round-timer/scoreboard logic for DATA_BACKEND=local. Mirrors the behavior
// of timerFirebase.js, but state lives server-side (MariaDB) and updates
// arrive over Socket.IO instead of a Firebase RTDB listener; all writes go
// through the /api/timer/* REST endpoints (admin/superadmin authenticated
// with the same SHA-256 authToken used for match results).
import { getSocket } from './socketClient.js';

let localTimerInterval = null;
let afterRoundEnabled = false;
let allRounds = [];
let latestState = null;

function currentDivision() {
  return App?.config?.currentSheetName;
}

function authToken() {
  return sessionStorage.getItem('adminAuthToken');
}

async function postTimer(path, body = {}) {
  const res = await fetch(`/api/timer/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sheetName: currentDivision(), authToken: authToken(), ...body })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /api/timer/${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

function loadRounds() {
  if (!App?.data?.allScheduleData) return [];

  const all = App.data.allScheduleData
    .map(r => r.roundTime)
    .filter(Boolean);

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

export async function initRounds() {
  if (!App?.data?.allScheduleData) return;

  allRounds = loadRounds();

  if (!latestState || !latestState.currentRound || !allRounds.includes(latestState.currentRound)) {
    try {
      await postTimer('nextRound', { round: allRounds[0] || 'Unknown Round' });
    } catch (e) {
      console.error('Failed to initialize currentRound', e);
    }
  }

  const nextBtn = document.getElementById('next-round-btn');
  const prevBtn = document.getElementById('prev-round-btn');

  nextBtn.onclick = async () => {
    const current = (latestState?.currentRound || '').trim();
    let idx = allRounds.findIndex(r => r.trim() === current);
    if (idx === -1) idx = 0;
    if (idx < allRounds.length - 1) {
      try { await postTimer('nextRound', { round: allRounds[idx + 1] }); } catch (e) { console.error(e); }
    }
  };

  prevBtn.onclick = async () => {
    const current = (latestState?.currentRound || '').trim();
    let idx = allRounds.findIndex(r => r.trim() === current);
    if (idx === -1) idx = 0;
    if (idx > 0) {
      try { await postTimer('prevRound', { round: allRounds[idx - 1] }); } catch (e) { console.error(e); }
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

function blinkThenReset(originalDuration) {
  const el = document.getElementById('timer-display');
  let visible = true;
  let count = 0;

  const blinkInterval = setInterval(() => {
    el.style.visibility = visible ? 'hidden' : 'visible';
    visible = !visible;
    count++;
    if (count >= 10) {
      clearInterval(blinkInterval);
      el.style.visibility = 'visible';
      el.innerText = formatTime(originalDuration);
    }
  }, 500);
}

function updateDisplay(timerData) {
  clearInterval(localTimerInterval);

  const timerEl = document.getElementById('timer-display');
  const running = timerData.running;
  const afterRound = timerData.startAfterRoundRunning;
  const duration = timerData.duration ?? 0;

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

  function getRemaining() {
    if (running) {
      const now = Date.now();
      return Math.max(0, duration - Math.floor((now - timerData.startTime) / 1000));
    }
    return duration;
  }

  let remaining = getRemaining();
  updateTimerColor(timerEl, timerData);
  timerEl.innerText = formatTime(remaining);

  if (!running) return;

  localTimerInterval = setInterval(() => {
    remaining = getRemaining();
    timerEl.innerText = formatTime(remaining);
    updateTimerColor(timerEl, timerData);

    if (remaining <= 0) {
      clearInterval(localTimerInterval);

      if (afterRound) {
        postTimer('reset').catch(e => console.error(e));
      } else if (afterRoundEnabled && App.state.isSuperAdmin) {
        postTimer('start', { afterRound: true }).catch(e => console.error(e));
      } else if (!App.state.isSuperAdmin) {
        blinkThenReset(timerData.lastSetDuration || 300);
      } else {
        postTimer('reset').catch(e => console.error(e));
      }
    }
  }, 250);
}

function applyState(state) {
  latestState = state;
  const scoreboard = document.getElementById('scoreboard');
  if (scoreboard) {
    if (App.state.isSuperAdmin) {
      scoreboard.style.display = 'flex';
    } else {
      scoreboard.style.display = state.showClock === false ? 'none' : 'flex';
    }
  }
  updateDisplay(state);

  const toggleSwitch = document.getElementById('toggle-display-switch');
  if (toggleSwitch) toggleSwitch.checked = state.showClock ?? true;

  const afterRoundDurationDisplay = document.getElementById('after-round-duration');
  if (afterRoundDurationDisplay) afterRoundDurationDisplay.textContent = `${state.afterRoundDuration || 60}s`;

  const roundDisplayEl = document.getElementById('current-round-display');
  const currentRound = state.currentRound || allRounds[0] || 'Unknown Round';
  if (roundDisplayEl) roundDisplayEl.textContent = currentRound;

  // Mirror into the Admin timer card's kicker (design §9: "ROUND n · DIVISION")
  const kicker = document.getElementById('admin-round-kicker');
  if (kicker) kicker.textContent = `${currentRound} · ${App.config.currentSheetName || ''}`;
}

export async function refreshState() {
  const division = currentDivision();
  if (!division) return;
  try {
    const res = await fetch(`/api/timer?sheetName=${encodeURIComponent(division)}`);
    const state = await res.json();
    applyState(state);
  } catch (e) {
    console.error('Failed to load timer state', e);
  }
}

export function init() {
  const socket = getSocket();

  socket.on('timerUpdate', (payload) => {
    if (payload.division !== currentDivision()) return;
    applyState(payload);
    // Sync indicator mirrors the firebase-mode behavior of pulsing green on
    // every update received from the server.
    const syncIndicator = document.getElementById('sync-indicator');
    if (syncIndicator) syncIndicator.style.background = 'limegreen';
  });

  // Poll a lightweight indicator so it degrades to red if the socket drops.
  let lastUpdateSeen = Date.now();
  socket.on('timerUpdate', () => { lastUpdateSeen = Date.now(); });
  setInterval(() => {
    const syncIndicator = document.getElementById('sync-indicator');
    if (!syncIndicator) return;
    const diff = Math.abs(Date.now() - lastUpdateSeen);
    syncIndicator.style.background = (diff < 15000 || socket.connected) ? 'limegreen' : 'red';
  }, 2000);

  refreshState();

  const toggleSwitch = document.getElementById('toggle-display-switch');
  if (toggleSwitch) {
    toggleSwitch.onchange = async (e) => {
      try { await postTimer('showClock', { showClock: e.target.checked }); } catch (err) { console.error(err); }
    };
  } else {
    console.error('Could not find #toggle-display-switch element.');
  }

  const afterRoundSettingsBtn = document.getElementById('after-round-settings-btn');
  const afterRoundSettings = document.getElementById('after-round-settings');
  afterRoundSettingsBtn.onclick = () => {
    afterRoundSettings.classList.toggle('hidden');
  };

  const plusAfterBtn = document.getElementById('plus-after-btn');
  const minusAfterBtn = document.getElementById('minus-after-btn');
  async function adjustAfterRoundTime(delta) {
    const current = latestState?.afterRoundDuration || 60;
    const updated = Math.max(15, current + delta);
    try { await postTimer('afterRoundDuration', { afterRoundDuration: updated }); } catch (e) { console.error(e); }
  }
  plusAfterBtn.onclick = () => adjustAfterRoundTime(15);
  minusAfterBtn.onclick = () => adjustAfterRoundTime(-15);

  document.getElementById('plus-btn').onclick = () => postTimer('adjust', { deltaSeconds: 30 }).catch(e => console.error(e));
  document.getElementById('minus-btn').onclick = () => postTimer('adjust', { deltaSeconds: -30 }).catch(e => console.error(e));
  document.getElementById('start-btn').onclick = () => postTimer('start').catch(e => console.error(e));
  document.getElementById('stop-btn').onclick = () => postTimer('stop').catch(e => console.error(e));
  document.getElementById('reset-btn').onclick = () => postTimer('reset').catch(e => console.error(e));
  document.getElementById('after-round-toggle').onchange = e => {
    afterRoundEnabled = e.target.checked;
  };
}
