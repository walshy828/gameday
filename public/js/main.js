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
    switchView,
    goToGate
} from './navigation.js';

import {
    updateScheduleView,
    renderScheduleView,
    parseRoundTime,
    getUniqueCourts,
    getUniqueTeams
} from './schedule.js';

import {
    renderStandings
} from './standings.js';

import {
    syncNow,
    pruneDivisions,
    toggleAutoSync,
    setSyncInterval,
    setCustomSyncInterval,
    setSyncScope,
    toggleSyncDivision
} from './settings.js';

import { getSocket } from './socketClient.js';
import { initTimerOverlay } from './timerOverlay.js';
import * as TimerFirebase from './timerFirebase.js';
import * as TimerLocal from './timerLocal.js';
import { initAnnouncements, dismissAnnouncementBanner, postAnnouncementFromSetup, cancelAnnouncementEdit } from './announcements.js';
import { initChat, sendChatMessage, jumpToChatBottom, requestDeleteChatMessage, cancelDeleteChatMessage, confirmDeleteChatMessage } from './chat.js';
import { renderPlayoffsView } from './playoffs.js';

const IS_LOCAL_BACKEND = window.__DATA_BACKEND__ === 'local';
const TimerModule = IS_LOCAL_BACKEND ? TimerLocal : TimerFirebase;

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

// Initialize Google Analytics (called after /api/allData populates App.settings)
function initGoogleAnalytics(gaId) {
  if (!gaId) return;
  try {
    // If gtag already present, re-configure
    if (window.gtag) {
      window.gtag('config', gaId);
      return;
    }

    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${gaId}`;
    document.head.appendChild(script);

    window.dataLayer = window.dataLayer || [];
    function gtag(){ window.dataLayer.push(arguments); }
    window.gtag = gtag;
    window.gtag('js', new Date());
    window.gtag('config', gaId);
    console.log('Google Analytics initialized for:', gaId);
  } catch (err) {
    console.error('Failed to initialize Google Analytics', err);
  }
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
    // Court managers default to their own court (picked at login) until they
    // manually pick something else; the select only has a real value once
    // its options are populated, so this only fires before that first render.
    const savedAdminCourtFilter = (adminCourtSelect && adminCourtSelect.value)
      ? adminCourtSelect.value
      : (!App.state.isSuperAdmin && App.state.selectedCourt) ? App.state.selectedCourt : 'all';

    // Update app settings (coming from backend now)
    App.settings = settings || {};
    App.settings.is_tie_allowed = settings?.is_tie_allowed ?? true;
    // Initialize Google Analytics if configured from server-side settings
    // (we initialize here after /api/allData ensures App.settings is populated)
    try {
      const gaId = App.settings.ga_measurement_id || window.__GA_MEASUREMENT_ID__;
      if (gaId && typeof initGoogleAnalytics === 'function') initGoogleAnalytics(gaId);
    } catch (e) {
      console.warn('GA init failed:', e);
    }
    console.log(`load data - GA ID: ${App.settings.google_analytics_id}`);

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
    // Use immediate render after initial load to avoid duplicate renders from
    // concurrent sources (API + Firebase listener + switchView).
    if (typeof window.renderAdminMatchEntryNow === 'function') {
      window.renderAdminMatchEntryNow();
    } else {
      updateAdminMatchEntryView();
    }

    renderPlayoffsView();

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
    TimerModule.initRounds();

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
let socketDivisionRoom = null;

// Shared by both the Firebase 'value' listener and the Socket.IO
// 'divisionUpdate' handler — applies a fresh {standings, schedule} snapshot
// for `divisionName` to the DOM.
function handleDivisionSnapshot(data, divisionName) {
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
  renderPlayoffsView();
  // If a playoff final has been completed, show the championship banner locally
  try {
    const finalsGame = App.data.allScheduleData && App.data.allScheduleData.find(game => game.roundTime === "P5.Finals" && game.winner);
    if (finalsGame && typeof championshipBanner === 'function') {
      championshipBanner();
    }
  } catch (e) {
    console.error('Error running championshipBanner on division update:', e);
  }
  gtag('event','filter_change', {
    filter_name: 'division',
    filter_value: divisionName
  });
}

function watchDivision(divisionName) {
  if (IS_LOCAL_BACKEND) {
    const socket = getSocket();
    socket.emit('joinDivision', divisionName);
    socketDivisionRoom = divisionName;
    // Re-registering avoids stacking listeners across division switches.
    socket.off('divisionUpdate');
    socket.on('divisionUpdate', (payload) => {
      if (payload.division !== divisionName) return;
      handleDivisionSnapshot(payload, divisionName);
    });
    // Timer state is per-division and TimerModule.init() ran before
    // currentSheetName was known, so pull the current state now — otherwise
    // the display stays stale until the next timerUpdate broadcast (e.g. a
    // superadmin stopping/starting the timer).
    TimerModule.refreshState?.();
    return;
  }

  const divisionRef = firebase.database().ref(`dodgeball-tournament/divisions/${divisionName}`);

  // Detach previous listener
  if (currentDivisionListener) {
    currentDivisionListener.off();
  }

  currentDivisionListener = divisionRef;
  // Skip the first firebase 'value' callback because `loadData()` will have
  // already performed the initial render. Subsequent 'value' events are
  // real-time updates that should trigger renders.
  let firstSnapshot = true;
  divisionRef.on('value', (snapshot) => {
    if (firstSnapshot) {
      firstSnapshot = false;
      return; // Ignore the initial callback to avoid duplicate renders
    }
    handleDivisionSnapshot(snapshot.val(), divisionName);
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

  // Initialize timer overlay for superadmin if applicable
  if (typeof window.initTimerOverlay === 'function') window.initTimerOverlay();
    

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

// Firebase client SDK init is only needed in firebase mode — in local mode
// the timer/scoreboard and division live-updates go through Socket.IO/REST
// instead (see TimerLocal.init() and watchDivision() above).
if (!IS_LOCAL_BACKEND) {
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
}

// Sets up the round timer/scoreboard: direct Firebase RTDB listeners in
// firebase mode, or Socket.IO + /api/timer/* REST calls in local mode.
TimerModule.init();

// Announcements banner + crew chat — same dual-backend pattern as the timer.
initAnnouncements();
initChat();

// expose for admin code to call after login
window.initTimerOverlay = initTimerOverlay;



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
  goToGate,
  getCurrentFilteredTeam
});

// Expose settings view handlers (used by inline onclick handlers in index.html)
exposeGlobals({
  syncNow,
  pruneDivisions,
  toggleAutoSync,
  setSyncInterval,
  setCustomSyncInterval,
  setSyncScope,
  toggleSyncDivision
});

// Expose announcements + chat handlers (used by inline onclick handlers)
exposeGlobals({
  dismissAnnouncementBanner,
  postAnnouncementFromSetup,
  cancelAnnouncementEdit,
  sendChatMessage,
  jumpToChatBottom,
  requestDeleteChatMessage,
  cancelDeleteChatMessage,
  confirmDeleteChatMessage
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

