import {
  updateAdminMatchEntryView,
  updateAdminUI,
  showAdminLoginModal,
  hideAdminLoginModal,
  loginAdmin,
  logoutAdmin,
  showMatchEntryModal,
  hideMatchEntryModal,
  saveMatchResultFromModal,
  changePlayers,
  checkLoginStatus
} from './admin.js';

import {
    championshipBanner,
    closeChampion,
    stopConfetti,
    generateConfetti,
    startConfetti
} from './celebration.js';

import {
    fetchDivisionNames,
    renderDivisionDropdown,
    handleDivisionChange,
    initializeFilter,
    switchView
} from './navigation.js';

import {
    updateScheduleView,
    renderScheduleView,
    parseRoundTime,
    getUniqueCourts,
    getUniqueTeams,
    buildPagerContent,
    initStandingsPager,
    loadAndStartStandingsPager
} from './schedule.js';

import {
    renderStandings
} from './standings.js';


// Global utility to show/hide status messages
let statusTimer = null;
let hideTimer = null;

function showStatus(message, isError = false) {
  const toast = document.getElementById('status-toast');
  const toastText = document.getElementById('status-toast-text');
  const errorDiv = document.getElementById('error-message');
  const errorDetails = document.getElementById('error-details');

  // Clear pending timers
  clearTimeout(statusTimer);
  clearTimeout(hideTimer);

  // Always hide both first
  toast.classList.add('hidden');
  errorDiv.classList.add('hidden');

  if (isError) {
    errorDetails.textContent = message;
    errorDiv.classList.remove('hidden');
    return;
  }

  // Only show if the status lasts longer than 1s
  statusTimer = setTimeout(() => {
    toastText.textContent = message || 'Loading...';
    toast.classList.remove('hidden');
  }, 1000);
}

function hideStatus() {
  clearTimeout(statusTimer);
  const toast = document.getElementById('status-toast');
  toast.classList.add('hidden');
}



async function serverCall(funcName, arg1) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
  const baseURL = window.location.origin;  // Dynamically pulls the current host:port
  try {
    const response = await fetch(`${baseURL}/api/${funcName}`, {
      method: arg1 ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: arg1 ? JSON.stringify(arg1) : undefined,
      signal: controller.signal
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Server error: ${response.status} ${errText}`);
    }

    const result = await response.json();

    if (result.error) throw new Error(result.error);

    return result;

  } catch (error) {
    console.error(`API call failed for ${funcName}:`, error);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

import { getAllData } from './api.js';


async function loadData(divisionName) {
  App.refresh.isLoadingData = true;
  showStatus(`Loading ${divisionName} data...`);

  const container = document.getElementById('admin-match-list');
  const scrollTop = container.scrollTop;

  try {
    // Replace Firebase load with API call
    const { settings, standings, schedule } = await getAllData(divisionName);

    if (!standings && !schedule) throw new Error(`No data found for division ${divisionName}.`);

    // clear the confetti if it's running
    //clearInterval(confettiInterval);

    // Capture current filter state before fetching new data for both views
    const teamSelect = document.getElementById('team-select');
    const courtSelect = document.getElementById('court-select');
    const adminTeamSelect = document.getElementById('admin-team-select');
    const adminCourtSelect = document.getElementById('admin-court-select');
    
    const savedTeamFilter = teamSelect ? teamSelect.value : 'all';
    const savedCourtFilter = courtSelect ? courtSelect.value : 'all';
    const savedAdminTeamFilter = adminTeamSelect ? adminTeamSelect.value : 'all';
    const savedAdminCourtFilter = adminCourtSelect ? adminCourtSelect.value : 'all';

    // Update app settings (coming from backend now)
    App.settings = settings || {};
    App.settings.is_tie_allowed = settings?.is_tie_allowed ?? true;

    // Update standings and schedule data
    App.data.allStandingsData = standings || [];
    const scheduleData = schedule || [];

    // Normalize schedule data (same as before)
    App.data.allScheduleData = Array.isArray(scheduleData)
      ? scheduleData.map((match, index) => ({ ...match, firebaseIndex: index }))
      : Object.entries(scheduleData).map(([key, match]) => ({
          ...match,
          firebaseIndex: key
        }));

    // Update derived lists
    App.data.teamNames = getUniqueTeams();
    App.data.courtNames = getUniqueCourts();

    // Initialize filters with saved state
    initializeFilter(savedTeamFilter, savedCourtFilter, savedAdminTeamFilter, savedAdminCourtFilter);

    // Render everything
    renderStandings(App.data.allStandingsData);
    updateScheduleView();
    updateAdminMatchEntryView();

    // Update admin standings ticker
    loadAndStartStandingsPager(App.data.allStandingsData);

    showStatus(null);

    // Switch views and banners
    switchView(App.state.currentView);
    championshipBanner();

    // Restore scroll
    requestAnimationFrame(() => {
      container.scrollTop = scrollTop;
    });

    App.refresh.isLoadingData = false;
    renderDivisionDropdown();
    initRounds();

    // Update timestamp
    const now = new Date();
    document.getElementById('last-updated').textContent = now.toLocaleTimeString();

  } catch (error) {
    console.error("Data Load Error:", error);
    showStatus(`Data load failed for division: ${error.message}`, true);
  } finally {
    App.refresh.isLoadingData = false;
  }
}


/*
async function loadData(divisionName) {
    App.refresh.isLoadingData = true;
    showStatus(`Loading ${divisionName} data...`);

    const container = document.getElementById('admin-match-list');
    const scrollTop = container.scrollTop;

    try {
        const divisionRef = firebase.database().ref(`dodgeball-tournament/divisions/${divisionName}`);
        const snapshot = await divisionRef.once('value');
        const data = snapshot.val();

        if (!data) throw new Error(`No data found for division ${divisionName}.`);

        //clear the confetti if it's running
        clearInterval(confettiInterval);

        // Capture current filter state before fetching new data for both views
        const teamSelect = document.getElementById('team-select');
        const courtSelect = document.getElementById('court-select');
        const adminTeamSelect = document.getElementById('admin-team-select');
        const adminCourtSelect = document.getElementById('admin-court-select');
        
        const savedTeamFilter = teamSelect ? teamSelect.value : 'all';
        const savedCourtFilter = courtSelect ? courtSelect.value : 'all';
        const savedAdminTeamFilter = adminTeamSelect ? adminTeamSelect.value : 'all';
        const savedAdminCourtFilter = adminCourtSelect ? adminCourtSelect.value : 'all';

        //for now hardcoding allowing ties.
        App.settings.is_tie_allowed=true;


        App.data.allStandingsData = data.standings || [];
        const scheduleData = data.schedule || [];
        App.data.allScheduleData = Array.isArray(scheduleData)
        ? scheduleData.map((match, index) => ({ ...match, firebaseIndex: index }))
        : Object.entries(scheduleData).map(([key, match]) => ({
            ...match,
            firebaseIndex: key
            }));

        App.data.teamNames = getUniqueTeams();
        App.data.courtNames = getUniqueCourts(); 

        // Initialize filters, passing the saved state for both sets of filters
            initializeFilter(savedTeamFilter, savedCourtFilter, savedAdminTeamFilter, savedAdminCourtFilter); 

        // Render data
            renderStandings(App.data.allStandingsData);
            updateScheduleView(); 
            updateAdminMatchEntryView(); 

            //update admin standings ticker
            loadAndStartStandingsPager(App.data.allStandingsData);
    
            showStatus(null);
    
            switchView(App.state.currentView);
            //Load champtionship banner
            championshipBanner();

            // Restore scroll positions
            requestAnimationFrame(() => {
            container.scrollTop = scrollTop;
            });

            App.refresh.isLoadingData = false;
            renderDivisionDropdown();
            //Update Rounds
            initRounds()
            // Update timestamp
            //unlockUI();
            const now = new Date();
            document.getElementById('last-updated').textContent = now.toLocaleTimeString();
            
        } catch (error) {
            console.error("Data Load Error:", error);
            showStatus(`Data load failed for division : ${error.message}`, true);
    } finally {
        App.refresh.isLoadingData = false;
    }
    }
*/

let currentDivisionListener = null;
function watchDivision(divisionName) {
    const divisionRef = firebase.database().ref(`dodgeball-tournament/divisions/${divisionName}`);

    // Detach previous listener
    if (currentDivisionListener) {
        currentDivisionListener.off();
    }

    currentDivisionListener = divisionRef;
    divisionRef.on('value', (snapshot) => {
        const data = snapshot.val();
        if (!data) return;

        App.data.standings = data.standings || [];
        const scheduleData = data.schedule || [];
        App.data.allScheduleData = Array.isArray(scheduleData)
        ? scheduleData.map((match, index) => ({ ...match, firebaseIndex: index }))
        : Object.entries(scheduleData).map(([key, match]) => ({
            ...match,
            firebaseIndex: key
            }));
        renderStandings(App.data.standings);
        updateScheduleView();
        updateAdminMatchEntryView();
    });
}


/**
 * Switches to the schedule view and filters by the specified team.
 */
function filterScheduleByTeam(teamName) {
    const teamSelect = document.getElementById('team-select');
    const courtSelect = document.getElementById('court-select');
    
    if (teamSelect) teamSelect.value = teamName;
    if (courtSelect) courtSelect.value = 'all'; 

    switchView('schedule');
}

function getCurrentFilteredTeam() {
    const teamSelect = document.getElementById('team-select');
    return teamSelect ? teamSelect.value : 'all';
}

document.addEventListener('DOMContentLoaded', () => {
    checkLoginStatus();

    if (App.state.isAdmin) {
        switchView('admin-entry');
        
    } else {
        switchView('standings');
    }
    
    // --- INITIAL KICKOFF ACTIONS ---
    fetchDivisionNames(); 
    updateAdminUI();
    

    // --- ADMIN LOGIN ENTER KEY BINDING ---
    const passwordInput = document.getElementById('admin-password-input');
    const loginButton = document.getElementById('login-button');

    if (passwordInput && loginButton) {
        passwordInput.addEventListener('keypress', (event) => {
            // Check if the key pressed is the 'Enter' key
            if (event.key === 'Enter') {
                // Prevent the default action (like a form submission)
                event.preventDefault(); 
                
                // Programmatically click the Login button
                loginButton.click();
            }
        });
    }
});


//for dev 
const IS_DEV_MODE = false
if (IS_DEV_MODE) {
document.getElementById('devMode').classList.remove('hidden');
}

const firebaseConfig = {
  apiKey: "AIzaSyCtYdFnbp4va-wp0hJ_YnqOmucgNgOVrIg",
  authDomain: "dodgeballgameday.firebaseapp.com",
  databaseURL: "https://dodgeballgameday-default-rtdb.firebaseio.com",
  projectId: "dodgeballgameday",
  storageBucket: "dodgeballgameday.firebasestorage.app",
  messagingSenderId: "1093977518048",
  appId: "1:1093977518048:web:3e8017f501ee04f42f8585"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const auth = firebase.auth(); 


const timerRef = db.ref('timer');
const offsetRef = db.ref('.info/serverTimeOffset');

let serverOffset = 0;
let localTimerInterval = null;
let afterRoundEnabled = false;

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

/*************** round control logic **************/
// --- ROUND CONTROL LOGIC ---
const roundDisplayEl = document.getElementById('current-round-display');
const roundsRef = timerRef.child('currentRound');

let allRounds = [];

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


function initRounds() {
  if (!App?.data?.allScheduleData) return;

  allRounds = loadRounds();
  console.log('Rounds initialized:', allRounds);

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

// --- Listen for round changes ---
roundsRef.on('value', snap => {
  const current = snap.val() || allRounds[0] || 'Unknown Round';
  roundDisplayEl.textContent = current;
});


/**************************************************/


console.log(`SuperAdmin: ${App.state.isSuperAdmin}`);

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

// Increment/decrement buttons
plusAfterBtn.onclick = () => adjustAfterRoundTime(15);
minusAfterBtn.onclick = () => adjustAfterRoundTime(-15);

function adjustAfterRoundTime(delta) {
  timerRef.child('afterRoundDuration').get().then(snap => {
    let current = snap.val() || 60;
    let updated = Math.max(15, current + delta);
    timerRef.update({ afterRoundDuration: updated });
  });
}


// --- The rest of your display / control logic ---
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



function updateTimerColor(el, data) {
  if (!data.running) {
    el.style.color = 'red';
    el.style.textShadow = '0 0 10px red';
  } else if (data.startAfterRoundRunning) {
    el.style.color = 'gold';
    el.style.textShadow = '0 0 10px gold';
  } else {
    el.style.color = 'lightgreen';
    el.style.textShadow = '0 0 10px lightgreen';
  }
}


function formatTime(sec) {
  const m = String(Math.floor(sec / 60)).padStart(1, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
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

// --- After-Round Logic ---
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


// --- Attach buttons ---
document.getElementById('plus-btn').onclick = () => adjustTime(30);
document.getElementById('minus-btn').onclick = () => adjustTime(-30);
document.getElementById('start-btn').onclick = startTimer;
document.getElementById('stop-btn').onclick = stopTimer;
document.getElementById('reset-btn').onclick = resetTimer;
document.getElementById('after-round-toggle').onchange = e => {
  afterRoundEnabled = e.target.checked;
};

//Dynamic Super Admin timer controls
document.addEventListener('DOMContentLoaded', () => {
  const isSuperAdmin = App?.state?.isSuperAdmin === true;
  const timer = document.getElementById('scoreboard');
  const overlay = document.getElementById('timer-controls-overlay');

  if (!isSuperAdmin || !timer || !overlay) return;

  // Move overlay to <body> so it’s not clipped by fixed nav
  document.body.appendChild(overlay);
  overlay.style.position = 'fixed'; // <-- key change: fixed instead of absolute
  overlay.style.zIndex = 9999;

  const showOverlay = () => {
    const rect = timer.getBoundingClientRect();

    // Align overlay to the right edge of the clock
    overlay.style.left = `${rect.right}px`;
    overlay.style.top = `${rect.bottom + 8}px`;
    overlay.style.transform = 'translateX(-100%)'; // keep right edge aligned

    overlay.classList.remove('hidden');
    requestAnimationFrame(() => {
      overlay.classList.remove('opacity-0', 'scale-95');
      overlay.classList.add('opacity-100', 'scale-100');
    });
  };

  const hideOverlay = () => {
    overlay.classList.remove('opacity-100', 'scale-100');
    overlay.classList.add('opacity-0', 'scale-95');

    setTimeout(() => {
      overlay.classList.add('hidden');
    }, 150);
  };

  timer.addEventListener('click', (e) => {
    e.stopPropagation();
    const isVisible = !overlay.classList.contains('hidden');
    isVisible ? hideOverlay() : showOverlay();
  });

  document.addEventListener('click', (e) => {
    if (!overlay.classList.contains('hidden')) {
      if (!overlay.contains(e.target) && !timer.contains(e.target)) {
        hideOverlay();
      }
    }
  });
});



function exposeGlobals(obj) {
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'function') {
      window[key] = value;
    }
  }
}

// Expose admin functions
exposeGlobals({
  loginAdmin,
  logoutAdmin,
  updateAdminUI,
  showAdminLoginModal,
  hideAdminLoginModal,
  showMatchEntryModal,
  hideMatchEntryModal,
  saveMatchResultFromModal,
  changePlayers
});

// Expose schedule-related
exposeGlobals({
  updateScheduleView,
  filterScheduleByTeam,
  parseRoundTime,
  updateAdminMatchEntryView
});

// Expose utilities
exposeGlobals({
  loadData,
  watchDivision,
  showStatus,
  switchView,
  getCurrentFilteredTeam
});
/*
window.loadData = loadData;
window.watchDivision=watchDivision;
window.showStatus=showStatus;
window.switchView=switchView;
window.updateScheduleView=updateScheduleView;
window.filterScheduleByTeam=filterScheduleByTeam;
window.loginAdmin=loginAdmin;
window.updateAdminMatchEntryView=updateAdminMatchEntryView;
window.parseRoundTime=parseRoundTime;
window.getCurrentFilteredTeam=getCurrentFilteredTeam;
window.showMatchEntryModal=showMatchEntryModal;
window.changePlayers=changePlayers;
window.saveMatchResultFromModal=saveMatchResultFromModal;
*/
export {
    getCurrentFilteredTeam,
    serverCall
};

