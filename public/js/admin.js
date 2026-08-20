// Avoid importing from main.js (circular). Use the api wrapper directly.
import { validateAdmin, saveMatchResult as apiSaveMatchResult } from './api.js';
import { getFilterableTeamName, parseRoundTime } from './schedule.js';
import { switchView } from './navigation.js';

// Core renderer (kept private) — we'll expose a debounced public wrapper below
function renderAdminMatchEntryViewImpl() {
    if (!App.state.isAdmin) {
        document.getElementById('admin-match-list').innerHTML = '<p class="py-4 text-center text-sm text-white/45">Please sign in to access match entry.</p>';
        return;
    }
    
    const teamSelect = document.getElementById('admin-team-select');
    const courtSelect = document.getElementById('admin-court-select');
    const hidePlayedToggle = document.getElementById('hide-played-toggle');
    const matchListDiv = document.getElementById('admin-match-list');
    const filterInfoDiv = document.getElementById('admin-filter-info');
    
    const selectedTeam = teamSelect?.value || 'all';
    const selectedCourt = courtSelect?.value || 'all';
    const isHidingPlayed = hidePlayedToggle?.checked || false;
    
    if (!matchListDiv) return;

    // Diagnostic logging to help identify why nothing is rendering
    try {
        console.log('updateAdminMatchEntryView called', {
            isAdmin: App.state.isAdmin,
            isSuperAdmin: App.state.isSuperAdmin,
            totalMatches: Array.isArray(App.data.allScheduleData) ? App.data.allScheduleData.length : 0,
            selectedTeam,
            selectedCourt,
            isHidingPlayed,
        });
    } catch (e) {
        console.log('Diagnostic log failed:', e);
    }
    
    // 1. Filter and Sort logic (remains the same as your part 3)
    let filteredSchedule = App.data.allScheduleData.filter(game => {
        const teamMatch = selectedTeam === 'all' || 
                            getFilterableTeamName(game.team1) === selectedTeam || 
                            getFilterableTeamName(game.team2) === selectedTeam; 
                            
        const courtMatch = selectedCourt === 'all' || (game.court && game.court.trim() === selectedCourt);
        
        // NEW: Logic for 'Hide Played Games'
        // A game is 'played' if it has an official winner.
        const hasOfficialWinner = !!game.winner && game.winner.trim() !== '' && game.winner.trim() !== 'TBA' && game.winner.trim() !== '—';
        const hasAdminWinner = !!game.adminWinner && game.adminWinner.trim() !== '' && game.adminWinner.trim() !== 'TBA' && game.adminWinner.trim() !== '—';

        
        // If isHidingPlayed is true, we ONLY include games that DON'T have an official winner.
        // If isHidingPlayed is false, we include ALL games.
        const playedMatch = !isHidingPlayed || !hasAdminWinner; // <-- NEW FILTER

        return teamMatch && courtMatch && playedMatch; // <-- 'playedMatch' added to return
    });

    filteredSchedule.sort((a, b) => {
        const timeA = parseRoundTime(a.roundTime);
        const timeB = parseRoundTime(b.roundTime);

        // Case 1: Both are times
        if (timeA.isTime && timeB.isTime) {
            // Directly compare the chronological sort values (e.g., "09:05")
            return timeA.sortValue.localeCompare(timeB.sortValue);
        }
        
        // Case 2: Time sorts before text (P rounds)
        if (timeA.isTime && !timeB.isTime) {
            return -1; // A (time) comes before B (text)
        }
        if (!timeA.isTime && timeB.isTime) {
            return 1; // A (text) comes after B (time)
        }

        // Case 3: Both are text (P rounds or other non-time text)
        // Alpha sort ascending
        return timeA.sortValue.localeCompare(timeB.sortValue);
    });
    
    const groupedMatches = filteredSchedule.reduce((acc, game) => {
        const round = game.roundTime || 'TBD/Unscheduled';
        if (!acc[round]) {
            acc[round] = [];
        }
        acc[round].push(game);
        return acc;
    }, {});

    matchListDiv.innerHTML = '';
    
    // ... (Filter Info rendering logic remains the same) ...
    
    // Title + identity line (design §9: "Tournament control" for tournament
    // managers, "Court n results" for court managers).
    const titleEl = document.getElementById('admin-title');
    if (titleEl) {
        titleEl.textContent = App.state.isSuperAdmin
            ? 'Tournament control'
            : `Court ${App.state.selectedCourt || '?'} results`;
    }
    const whoEl = document.getElementById('admin-who');
    if (whoEl) {
        const name = App.state.reporterName || 'Staff';
        whoEl.textContent = App.state.isSuperAdmin
            ? `${name} · tournament manager · all courts`
            : `${name} · court manager · court ${App.state.selectedCourt || '?'} · ${App.config.currentSheetName}`;
    }

    let infoText = `Showing <span class="text-gold-l">${esc(App.config.currentSheetName)}</span>`;
    if (selectedTeam !== 'all') infoText += ` · team <span class="text-gold-l">${esc(selectedTeam)}</span>`;
    if (selectedCourt !== 'all') infoText += ` · court <span class="text-gold-l">${esc(selectedCourt)}</span>`;
    if (isHidingPlayed) infoText += ` · <span class="text-gold-l">reported games hidden</span>`;

    filterInfoDiv.classList.remove('hidden');
    filterInfoDiv.innerHTML = infoText;

    const fragment = document.createDocumentFragment(); //for batching updates
    Object.entries(groupedMatches).forEach(([roundTime, games]) => {
        // Design §9: one light card per round — scope kicker on the left, game
        // count on the right, then a 20px-radius row per game.
        const card = document.createElement('section');
        card.className = 'card-light p-4';

        const head = document.createElement('div');
        head.className = 'flex items-baseline justify-between gap-2.5';
        head.innerHTML = `
            <span class="kicker !tracking-[.12em] text-mute">${esc(roundTime)}</span>
            <span class="kicker !tracking-[.08em]" style="color:var(--mar)">${games.length} GAME${games.length === 1 ? '' : 'S'}</span>
        `;
        card.appendChild(head);

        const rows = document.createElement('div');
        rows.className = 'mt-3 grid gap-1.5';

        games.forEach(game => {
            // Find the original index
            const gameIndex = App.data.allScheduleData.findIndex(g =>
                g.roundTime === game.roundTime && g.court === game.court && g.team1 === game.team1 && g.team2 === game.team2
            );

            const row = document.createElement('div');
            row.id = `game-entry-${gameIndex}`;
            row.className = 'match-entry-card flex items-center gap-2.5 rounded-[20px] p-3';

            const officialIsCompleted = game.winner && game.winner.trim() !== '' && game.winner.trim() !== 'TBA' && game.winner.trim() !== '—';
            const winnerName = game.winner ? game.winner.trim() : null;
            const reportedByAdmin = !!(game.adminWinner && game.adminWinner.trim() !== '' && game.adminWinner.trim() !== '—');
            const isReported = officialIsCompleted || reportedByAdmin;

            // Unreported rows carry the gold "needs you" tint; reported ones go flat.
            row.style.background = isReported ? '#F5F5F6' : 'rgba(224,184,99,.14)';

            // Result stamp: amber "not reported" prompt, or the green confirmation.
            let stamp, stampColor;
            if (isReported) {
                const w = winnerName || game.adminWinner.trim();
                const left = game.playersRemaining ?? game.adminPlayersRemaining ?? 0;
                const by = game.adminName || '—';
                stamp = App.settings.is_tie_allowed && w === 'tie'
                    ? `Tie · ${by}`
                    : `${w} won · ${left} left · ${by}${game.notes ? ' · 📝' : ''}`;
                stampColor = 'var(--ok)';
            } else {
                stamp = 'Not reported yet';
                stampColor = '#B8873A';
            }

            const meta = `COURT ${game.court || '—'} · ${roundTime}${game.match ? ` · M${game.match}` : ''}`;

            row.innerHTML = `
                <div class="min-w-0 flex-1">
                    <div class="kicker !tracking-[.1em] text-mute">${esc(meta)}</div>
                    <div class="mt-1.5 truncate text-sm font-semibold leading-[1.4] tracking-[-.01em] text-ink">${esc(game.team1 || 'TBD')}</div>
                    <div class="truncate text-sm font-semibold leading-[1.4] tracking-[-.01em] text-ink">${esc(game.team2 || 'TBD')}</div>
                    <div class="mt-1.5 text-[11px] font-medium leading-[1.4]" style="color:${stampColor}">${esc(stamp)}</div>
                </div>
                <button onclick="showMatchEntryModal(${gameIndex})"
                        class="flex-none rounded-[15px] px-4 py-3 text-[13px] font-semibold leading-none ${isReported ? 'btn-outline !rounded-[15px]' : 'btn-gold !rounded-[15px]'}">
                    ${isReported ? 'Edit' : 'Report'}
                </button>
            `;

            rows.appendChild(row);
        });

        card.appendChild(rows);
        fragment.appendChild(card);
    });
    matchListDiv.appendChild(fragment);
}

/** Escapes a value for safe interpolation into a template-literal row. */
function esc(str) {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
}

// Simple debounce utility to coalesce rapid calls into a single render
function debounce(fn, wait = 50) {
    let timer = null;
    return function(...args) {
        // If a full data load is in progress, skip scheduling renders; the loader
        // will call `renderAdminMatchEntryNow()` once it's finished.
        if (App && App.refresh && App.refresh.isLoadingData) return;

        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            try { fn.apply(this, args); } catch (e) { console.error('Debounced render error', e); }
        }, wait);
    };
}

// Public debounced function exported/used throughout the app and referenced by inline handlers.
const updateAdminMatchEntryView = debounce(renderAdminMatchEntryViewImpl, 40);

// Immediate render helper to be called when we want to force a single render
// (for example after the initial load completes). This bypasses the debounce
// and is safe to call repeatedly.
function renderAdminMatchEntryNow() {
    try {
        renderAdminMatchEntryViewImpl();
    } catch (e) {
        console.error('Immediate render error', e);
    }
}

// Expose immediate renderer to global so other modules (main.js) can call it
if (typeof window !== 'undefined') window.renderAdminMatchEntryNow = renderAdminMatchEntryNow;


/**
 * Updates the visual state of the Admin button and conditional UI elements.
 */
function updateAdminUI() {
    const adminButton = document.getElementById('admin-button');
    const adminStatusText = document.getElementById('admin-status-text');
    const adminEntryTab = document.getElementById('admin-entry-tab');
    const adminControls = document.getElementById('admin-controls');
    const adminTimerControls = document.getElementById('admin-panel');
    const setupGear = document.getElementById('admin-setup-gear');
    const liveTab = document.getElementById('live-tab');
    const chatTab = document.getElementById('chat-tab');
    const infoAdminLink = document.getElementById('info-admin-link');

    if (!adminButton || !adminStatusText || !adminEntryTab) return;

    if (infoAdminLink) {
        infoAdminLink.querySelector('span').textContent = App.state.isAdmin ? 'Back to my admin view →' : 'Admin login →';
        infoAdminLink.onclick = App.state.isAdmin ? () => switchView('admin-entry') : showAdminLoginModal;
    }

    if (App.state.isAdmin) {
        adminStatusText.textContent = 'Logout';
        adminButton.classList.remove('bg-gray-700', 'hover:bg-gray-600', 'text-accent');
        adminButton.classList.add('bg-gold', 'hover:bg-gold-d', 'text-white');
        adminButton.onclick = logoutAdmin;
        adminEntryTab.classList.remove('hidden'); // Show Admin Tab
        if (chatTab) chatTab.classList.remove('hidden'); // Show Chat Tab (staff only)
        if (liveTab) liveTab.classList.add('hidden'); // Staff get the clock on Admin instead
        // Redirect off LIVE if we were sitting on it when signing in.
        if (App.state.currentView === 'live') switchView('admin-entry');
        if (App.state.isSuperAdmin) {
            adminTimerControls.classList.remove('hidden');
            if (setupGear) setupGear.classList.remove('hidden');
        }
    } else {
        adminStatusText.textContent = 'Admin';
        adminButton.classList.remove('bg-gold', 'hover:bg-gold-d', 'text-white');
        adminButton.classList.add('bg-gray-700', 'hover:bg-gray-600', 'text-accent');
        adminButton.onclick = showAdminLoginModal;
        adminEntryTab.classList.add('hidden'); // Hide Admin Tab
        if (adminControls) adminControls.classList.add('hidden');
        if (adminTimerControls) adminTimerControls.classList.add('hidden');
        if (setupGear) setupGear.classList.add('hidden');
        if (chatTab) chatTab.classList.add('hidden');
        if (liveTab) liveTab.classList.remove('hidden');
    }
}

function showAdminLoginModal() {
    const modal = document.getElementById('admin-login-modal');
    const passwordInput = document.getElementById('admin-password-input');
    const nameInput = document.getElementById('admin-name-field');
    const message = document.getElementById('admin-login-message');

    // Show the modal
    modal.classList.remove('hidden');

    // Clear previous input and messages
    passwordInput.value = '';
    nameInput.value = localStorage.getItem('lastAdminName') || '';
    message.classList.add('hidden');

    renderLoginCourtPicker();

    // Wait a short moment to ensure the modal is visible before focusing
    setTimeout(() => nameInput.focus(), 50);
}

/**
 * Renders the "Your Court" 4-up picker in the login modal. Only meaningful
 * for the court-manager role — ignored server-side/client-side if the
 * password turns out to belong to the tournament manager.
 */
function renderLoginCourtPicker() {
    const wrap = document.getElementById('login-court-picker');
    if (!wrap) return;
    wrap.innerHTML = '';

    const selected = App.state.selectedCourt || '1';
    ['1', '2', '3', '4'].forEach(court => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'C' + court;
        const isActive = court === selected;
        // Light segmented picker on the modal sheet (design §3 "Your court").
        btn.className = 'rounded-[14px] py-2.5 text-[13px] font-semibold leading-none transition-colors ' +
            (isActive ? 'bg-white text-ink shadow-[0_2px_6px_rgba(0,0,0,.07)]' : 'text-mute');
        btn.onclick = () => {
            App.state.selectedCourt = court;
            renderLoginCourtPicker();
        };
        wrap.appendChild(btn);
    });
}

function hideAdminLoginModal() {
    document.getElementById('admin-login-modal').classList.add('hidden');
}

async function loginAdmin() {
    const passwordInputEl = document.getElementById('admin-password-input');
    const nameInputEl = document.getElementById('admin-name-field');
    const loginMessage = document.getElementById('admin-login-message');
    const loginButton = document.getElementById('login-button');

    // Defensive checks: if the modal elements are missing, abort and log helpful info
    if (!passwordInputEl || !loginMessage || !loginButton) {
        console.error('loginAdmin: required DOM elements missing', {
            passwordInputEl: !!passwordInputEl,
            loginMessage: !!loginMessage,
            loginButton: !!loginButton
        });
        return;
    }

    const password = passwordInputEl.value;
    const reporterName = (nameInputEl?.value || '').trim();
    loginMessage.classList.add('hidden');

    if (!reporterName) {
        loginMessage.textContent = 'Your name is required.';
        loginMessage.classList.remove('hidden');
        return;
    }

    loginButton.disabled = true;
    loginButton.textContent = 'Verifying…';

    try {
    // Use the API helper which returns the validation result
    const result = await validateAdmin(password);

        if (result && result.isAdmin) {
            App.state.isAdmin = true;
            App.state.reporterName = reporterName;
            localStorage.setItem('lastAdminName', reporterName);
            sessionStorage.setItem('reporterName', reporterName);

            //store this for persitstance
            sessionStorage.setItem('isAdmin', 'true');
            sessionStorage.setItem('isSuperAdmin', 'false');
            sessionStorage.setItem('adminAuthToken', result.token);
            if (result.isSuperAdmin) {
                // Firebase custom-token sign-in is only meaningful (and only
                // returned by the server) when DATA_BACKEND=firebase — local
                // mode's superadmin auth relies solely on the SHA-256 authToken.
                if (result.firebaseToken && window.__DATA_BACKEND__ !== 'local') {
                    try {
                    await firebase.auth().signInWithCustomToken(result.firebaseToken);
                    console.log('Super admin signed in to Firebase successfully');
                    } catch (err) {
                    console.error('Firebase sign-in error:', err);
                    }
                    sessionStorage.setItem('firebaseToken', result.firebaseToken);
                }
                App.state.isSuperAdmin = true;
                sessionStorage.setItem('isSuperAdmin', 'true');
                // initialize/move timer overlay for superadmin (if present)
                if (typeof window.initTimerOverlay === 'function') window.initTimerOverlay();
                gtag('event', 'login', {
                    method: 'web', // or 'google', 'facebook', etc.
                    success: true,
                    user_id: 'superadmin' // optional, only if you have one
                });
            } else {
                // Court manager — the court picked in the login modal scopes
                // their Admin tab's results list (see admin-court-select
                // default in main.js's loadData()).
                const court = App.state.selectedCourt || '1';
                App.state.selectedCourt = court;
                sessionStorage.setItem('selectedCourt', court);
                gtag('event', 'login', {
                    method: 'web', // or 'google', 'facebook', etc.
                    success: true,
                    user_id: 'admin' // optional, only if you have one
                    });
            }

            hideAdminLoginModal();
            updateAdminUI();
            
            if (App.state.isSuperAdmin && (!App.data.allDivisionNames || !App.data.allDivisionNames.length)) {
                // Bypass gate and redirect to settings
                App.state.screen = 'app';
                document.getElementById('gate-screen')?.classList.add('hidden');
                document.getElementById('app-screen')?.classList.remove('hidden');
                document.getElementById('bottom-tab-bar')?.classList.remove('hidden');
                switchView('settings');
                showStatus('Please configure and run Google Sheets sync to populate divisions.', false);
            } else {
                switchView('admin-entry'); // Go straight to admin view after login
                showStatus(`Signed in as ${reporterName}.`, false);
                setTimeout(() => showStatus(null), 3000);
            }
            
        } else {
            App.state.isAdmin = false;
            loginMessage.textContent = 'Invalid password.';
            sessionStorage.removeItem('adminAuthToken'); // Clear any old token
            loginMessage.classList.remove('hidden');
            gtag('event', 'login_failed', {
                    method: 'web',
                    success: false
                    });
        }

    } catch (error) {
        console.error("Admin Login Error:", error);
        loginMessage.textContent = 'An error occurred during login verification.';
        loginMessage.classList.remove('hidden');
    } finally {
        loginButton.disabled = false;
        loginButton.textContent = 'Sign in →';
    }
}

function logoutAdmin() {
    App.state.isAdmin = false;
    App.state.isSuperAdmin = false;
    App.state.reporterName = '';
    App.state.selectedCourt = '';
    //remove admin persistance
    sessionStorage.removeItem('isAdmin');
    sessionStorage.removeItem('isSuperAdmin');
    sessionStorage.removeItem('firebaseToken');
    sessionStorage.removeItem('reporterName');
    sessionStorage.removeItem('selectedCourt');
    if (window.__DATA_BACKEND__ !== 'local') {
        firebase.auth().signOut();
    }
    // The timer controls live inside #admin-panel now, which updateAdminUI()
    // hides for non-superadmins — no separate teardown needed.
    updateAdminUI();
    // If the user was in a staff-only tab, switch them out
    if (['admin-entry', 'settings', 'chat'].includes(App.state.currentView)) {
        switchView('standings');
    }
    showStatus('Logged out of Admin Mode.', false);
    setTimeout(() => showStatus(null), 3000); 
}

// --- NEW: MODAL AND MATCH RESULT SAVING FUNCTIONS ---

/**
 * Populates and shows the match entry modal.
 * @param {number} gameIndex - The index of the game in the allScheduleData array.
 */
function showMatchEntryModal(gameIndex) {
    const modal = document.getElementById('match-entry-modal');
    const matchInfoDisplay = document.getElementById('match-info-display');
    const winnerSelect = document.getElementById('modal-winner-select');
    const playersInput = document.getElementById('modal-players-input');
    const notesTextarea = document.getElementById('modal-notes-textarea');
    const saveMessage = document.getElementById('modal-save-message');
    const adminNameInput = document.getElementById('admin-name-input');
    
    const game = App.data.allScheduleData[gameIndex];
    if (!game) return console.error('Game data not found for index:', gameIndex);
    
    App.admin.currentGameIndex = gameIndex; 

    // Clear previous state and message
    saveMessage.classList.add('hidden');

    // 1. Populate Match Info Display
    matchInfoDisplay.textContent = `Court ${game.court || '—'} · ${game.roundTime} · ${App.config.currentSheetName}`;

    // 2. Set the current winner, then paint the tiles for it
    const currentWinner = (game.adminWinner && game.adminWinner.trim() !== 'TBA') ? game.adminWinner.trim() : '—';
    winnerSelect.value = currentWinner;
    renderWinnerTiles(game);

    playersInput.value = game.adminPlayersRemaining || 0;
    notesTextarea.value = game.notes || '';
    
    // Default to the name captured at login (falls back to the last name
    // typed anywhere, for sessions that predate the login name field).
    adminNameInput.value = App.state.reporterName || localStorage.getItem('lastAdminName') || '';

    // 4. Show the modal
    modal.classList.remove('hidden');
}

/**
 * "Who won?" choice tiles (design §10). Replaces the old <select> — the value
 * still lives on the hidden #modal-winner-select input so the save path and
 * its validation are unchanged.
 */
function renderWinnerTiles(game) {
    const wrap = document.getElementById('modal-winner-tiles');
    const winnerSelect = document.getElementById('modal-winner-select');
    if (!wrap || !winnerSelect) return;

    const options = [game.team1, game.team2]
        .filter(t => t && t.trim() !== '')
        .map(t => ({ value: t, label: t }));

    if (App.settings.is_tie_allowed) {
        options.push({ value: 'tie', label: '🤝 Horn sounded even — tie' });
    }

    wrap.innerHTML = '';
    options.forEach(opt => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tile-light';
        btn.textContent = opt.label;
        btn.dataset.selected = String(winnerSelect.value === opt.value);
        btn.onclick = () => {
            // Tapping the selected tile clears it, matching the old "—" option.
            winnerSelect.value = winnerSelect.value === opt.value ? '—' : opt.value;
            renderWinnerTiles(game);
        };
        wrap.appendChild(btn);
    });
}

function hideMatchEntryModal() {
    document.getElementById('match-entry-modal').classList.add('hidden');
    App.admin.currentGameIndex = null;
}

/**
 * Saves the match result using data from the modal.
 */
async function saveMatchResultFromModal() {
    if (App.admin.currentGameIndex === null) return console.error('No game selected for saving.');

    const game = App.data.allScheduleData[App.admin.currentGameIndex];
    const winnerSelect = document.getElementById('modal-winner-select');
    const playersInput = document.getElementById('modal-players-input');
    const notesTextarea = document.getElementById('modal-notes-textarea');
    const adminNameInput = document.getElementById('admin-name-input');
    const saveButton = document.getElementById('modal-save-button');
    const messageElement = document.getElementById('modal-save-message');

    const adminName = adminNameInput.value.trim();
    const winner = winnerSelect.value;
    const playersRemaining = parseInt(playersInput.value) || 0;
    const notes = notesTextarea.value.trim();
    
    
    // Validation
    if (!adminName) {
            messageElement.textContent = 'Admin Name is required.';
            messageElement.classList.remove('hidden');
            return;
    }
    if (winner === '—' && playersRemaining !== 0) {
            messageElement.textContent = 'Players Remaining must be 0 if no winner is selected.';
            messageElement.classList.remove('hidden');
            return;
    }

    // Store admin name locally for session convenience
    localStorage.setItem('lastAdminName', adminName);

    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    messageElement.classList.add('hidden');
    messageElement.textContent = '';

    // --- 1. GET THE AUTH TOKEN ---
    const authToken = sessionStorage.getItem('adminAuthToken');
    //console.log(`AuthToken: ${authToken}`) ;

    if (!authToken) {
        messageElement.textContent = 'Authentication error - Please log in again.';
        messageElement.classList.remove('hidden');
        messageElement.style.color = 'var(--warn)';

        saveButton.disabled = false;
        saveButton.textContent = 'Submit result';
        return
    }

    // Prepare the data payload for the Apps Script
    const matchData = {
        sheetName: App.config.currentSheetName,
        // The row index in the spreadsheet for the Apps Script to find the game
        rowIndex: game.rowIndex, 
        firebaseIndex: game.firebaseIndex,
        team1: game.team1,
        team2: game.team2,
        winner: winner === '—' ? '' : winner, // Clear winner if '—' is selected
        playersRemaining: playersRemaining,
        adminName: adminName, // NEW
        notes: notes // NEW
    };

    const payload = {
        authToken: authToken,
        matchData: matchData
    };


    try {
    // Use the API helper to save match result
    // apiSaveMatchResult expects (authToken, matchData)
    const result = await apiSaveMatchResult(authToken, matchData);
        
        if (result.success) {
            messageElement.textContent = 'Result saved!';
            messageElement.classList.remove('hidden');
            messageElement.style.color = 'var(--ok)';
            
            // Reload all data to refresh standings and schedule
            await loadData(App.config.currentSheetName); 
            
            // Give user a moment to see the success message before closing
            setTimeout(hideMatchEntryModal, 500); 

        } else {
            // Server responded but indicated failure
            const errMsg = result.error || 'Server reported failure.';
            messageElement.textContent = 'ERROR: ' + errMsg;
            messageElement.classList.remove('hidden');
            messageElement.style.color = 'var(--warn)';
            // If the server flagged logout, clear token and force re-login
            if (result.logout) {
                sessionStorage.removeItem('adminAuthToken');
                logoutAdmin();
            }
            throw new Error(errMsg);
        }
    } catch (error) {
        console.error('Save failed:', error);
        // If the error came from a failed HTTP response, inspect it
        if (error && error.status === 401) {
            // Authentication failed — ensure local token is cleared and force re-login
            sessionStorage.removeItem('adminAuthToken');
            logoutAdmin();
            messageElement.textContent = 'Session expired. Please log in again.';
        } else if (error && error.body && error.body.error) {
            messageElement.textContent = 'ERROR: ' + error.body.error;
        } else {
            messageElement.textContent = 'ERROR: ' + (error.message || 'Unknown error');
        }
        messageElement.classList.remove('hidden');
        messageElement.style.color = 'var(--warn)';
    } finally {
        saveButton.disabled = false;
        saveButton.textContent = 'Submit result';
    }
}


/* Increments or decrements the value in the "Players Remaining" input field, 
* respecting the min (0) and max (8) boundaries.
* @param {number} delta - The amount to change the value by (usually +1 or -1).
*/
function changePlayers(delta) {
    const inputField = document.getElementById('modal-players-input');
    
    // Ensure the element exists and the value is treated as a number
    if (!inputField) return;
    
    let currentValue = parseInt(inputField.value) || 0;
    const newValue = currentValue + delta;
    
    const minVal = parseInt(inputField.min) || 0;
    const maxVal = parseInt(inputField.max) || 8;

    // Boundary check
    if (newValue >= minVal && newValue <= maxVal) {
        inputField.value = newValue;
    } else if (newValue < minVal) {
        // Stop at the minimum value
        inputField.value = minVal;
    } else if (newValue > maxVal) {
        // Stop at the maximum value
        inputField.value = maxVal;
    }
}

function checkLoginStatus() {
    const isAdmin = sessionStorage.getItem('isAdmin');
    const isSuperAdmin = sessionStorage.getItem('isSuperAdmin');
    const firebaseToken = sessionStorage.getItem('firebaseToken');

    // Normalize stored strings to booleans for app state
    App.state.isSuperAdmin = (isSuperAdmin === 'true');
    if (firebaseToken) App.state.firebaseToken = firebaseToken;
    App.state.isAdmin = (isAdmin === 'true');
    App.state.reporterName = sessionStorage.getItem('reporterName') || '';
    App.state.selectedCourt = sessionStorage.getItem('selectedCourt') || '';

    // The updateAdminUI() call below will handle showing the correct buttons.
}

export {
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
};