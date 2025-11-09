// Avoid importing from main.js (circular). Use the api wrapper directly.
import { validateAdmin, saveMatchResult as apiSaveMatchResult } from './api.js';
import { getFilterableTeamName, parseRoundTime } from './schedule.js';

function updateAdminMatchEntryView() {
    if (!App.state.isAdmin) {
        document.getElementById('admin-match-list').innerHTML = '<p class="text-center py-4 text-gray-500">Please log in as an Admin to access match entry.</p>';
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
            totalMatches: Array.isArray(App.data.allScheduleData) ? App.data.allScheduleData.length : 0,
            selectedTeam,
            selectedCourt,
            isHidingPlayed
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
    
    let infoText = `Showing matches in <span class="text-lime-400">${App.config.currentSheetName}</span>`;
    if (selectedTeam !== 'all') infoText += `, filtered by Team: <span class="text-lime-400">${selectedTeam}</span>`;
    if (selectedCourt !== 'all') infoText += `, filtered by Court: <span class="text-lime-400">${selectedCourt}</span>`;
    if (isHidingPlayed) infoText += `, <span class="text-lime-400">Played Games Hidden</span> 🚫`;
    
    filterInfoDiv.classList.remove('hidden');
    filterInfoDiv.innerHTML = infoText;

    const fragment = document.createDocumentFragment(); //for batching updates
    Object.entries(groupedMatches).forEach(([roundTime, games]) => {
        const roundHeader = document.createElement('h3');
        roundHeader.className = 'round-header text-xl md:text-2xl font-bold text-white bg-indigo-900 p-3 md:p-4 rounded-lg shadow-inner mt-4 border-l-4 border-lime-500';
        //roundHeader.className = 'round-header text-xl md:text-2xl font-bold text-lime bg-admin-bg/50 p-3 md:p-4 rounded-lg shadow-inner mt-4 border-l-4 border-lime-500';
        roundHeader.textContent = `Round: ${roundTime}`;
        fragment.appendChild(roundHeader);

        games.forEach(game => {
            // Find the original index 
            const gameIndex = App.data.allScheduleData.findIndex(g => 
                g.roundTime === game.roundTime && g.court === game.court && g.team1 === game.team1 && g.team2 === game.team2
            );
            
            const card = document.createElement('div');
            card.id = `game-entry-${gameIndex}`;
            
            // Highlight the card if it has admin data but official data is missing or different
            const hasAdminEntry = game.adminWinner || game.adminName || game.adminPlayersRemaining;
            const hasOfficialGameWinner = !!game.winner
            const cardClass = hasOfficialGameWinner
                ? 'border-lime-400 border-2'
                : hasAdminEntry
                    ? 'border-amber-400 border-2'
                    : 'border-gray-700';

            card.className = `match-entry-card bg-gray-800 p-2 sm:p-2.5 rounded-lg shadow-sm flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 border ${cardClass}`;
            //card.className = `match-entry-card bg-gray-800 p-3 md:p-4 rounded-xl shadow-lg flex flex-col md:flex-row items-center justify-between space-y-3 md:space-y-0 border ${cardClass}`;
            
            // --- Official Data (Standard Size) ---
            const officialIsCompleted = game.winner && game.winner.trim() !== '' && game.winner.trim() !== 'TBA' && game.winner.trim() !== '—';
            const officialPlayersDisplay = officialIsCompleted ? `<span class="text-white font-mono">${game.playersRemaining || 0}</span>` : '<span class="text-gray-500">—</span>';
            
            //Highlight the official game winner
            const winnerName = game.winner ? game.winner.trim() : null;
            const playersRemainingText = game.playersRemaining ? ` (${game.playersRemaining})` : '';
            const winnerDecoration = ' <span class="text-green-400">✅</span>';
            const tieDecoration = '<span class="text-yellow-400">[T]</span>'

            // Build the display strings for each team
            let team1Display = game.team1 || 'TBD';
            let team2Display = game.team2 || 'TBD';

            // Check for the official winner and apply styling/emoji
            if (officialIsCompleted) {
                if (winnerName === game.team1) {
                    // Highlight Team 1, add checkmark, and players remaining
                    team1Display = `<span class="text-lime-400 font-extrabold">${game.team1}${winnerDecoration}${playersRemainingText}</span>`;
                } else if (winnerName === game.team2) {
                    // Highlight Team 2, add checkmark, and players remaining
                    team2Display = `<span class="text-lime-400 font-extrabold">${game.team2}${winnerDecoration}${playersRemainingText}</span>`;
                } else if(App.settings.is_tie_allowed && winnerName==="tie") {
                    team1Display = `${game.team1}${tieDecoration}`;
                    team2Display = `${game.team2}${tieDecoration}`;
                }
            }

            // --- Admin Data (Small, Different Color) ---
            const adminWinnerText = game.adminWinner || '—';
            const adminPlayersText = game.adminPlayersRemaining || '—';
            const adminNameText = game.adminName || '—';
            let noteEmoji = '';

            if(game.notes) {
                noteEmoji=' 📝';
            }
            
            const adminDisplay = `
                <div class="mt-2 text-xs text-accent/80 font-medium space-y-0.5 md:mt-0 md:pl-4 md:border-l md:border-gray-700">
                    <p class="whitespace-nowrap"><span class="font-bold">Admin Winner:</span> ${adminWinnerText}</p>
                    <p class="whitespace-nowrap"><span class="font-bold">Admin Players Left:</span> ${adminPlayersText}</p>
                    <p class="whitespace-nowrap"><span class="font-bold">Admin Name:</span> ${adminNameText}</p>
                </div>
            `;

            // 1. Define button classes and hover behavior
            let buttonBaseClasses = "flex items-center justify-center px-1 py-0.5 text-[11px] font-semibold rounded-md transition shadow"; 

            // 2. Determine colors based on adminWinnerText value
            let buttonColorClasses;
            let buttonHoverClasses;

            // Check if adminWinnerText has a value (i.e., is not '—' and is not an empty string)
            if (adminWinnerText && adminWinnerText.trim() !== '—') {
                // Game is already reported by Admin: use gray/slate classes
                buttonColorClasses = "bg-slate-500 text-gray-900";
                buttonHoverClasses = "hover:bg-slate-400";
            } else {
                // Game is NOT reported by Admin: use lime classes
                buttonColorClasses = "bg-lime-500 text-gray-900";
                buttonHoverClasses = "hover:bg-lime-400";
            }

            // 3. Combine classes for the button
            //const buttonClasses = `${buttonColorClasses} ${buttonHoverClasses}`;
            const buttonClasses = `${buttonBaseClasses} ${buttonColorClasses} ${buttonHoverClasses}`;


            card.innerHTML = `
                <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between w-full gap-2">
                
                <div class="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 text-base sm:text-lg leading-tight">
                    <div class="font-semibold text-lime-400">Court: ${game.court || '—'}</div>
                    <div class="font-bold text-white">
                    ${team1Display} 
                    <span class="text-gray-400">vs</span> <br class="sm:hidden">
                    ${team2Display}
                    </div>
                </div>
                
                <div class="flex flex-col items-start sm:flex-row sm:items-center gap-2 shrink-0 text-[11px] sm:text-xs text-gray-400">
                    
                    <div class="flex w-full justify-between sm:w-auto"> 
                    
                    <div>
                        <span class="font-semibold text-white">W:</span> ${adminWinnerText}
                        <span class="font-semibold text-white ml-2">P:</span> ${adminPlayersText}
                        <span class="font-semibold text-white ml-2">By:</span> ${adminNameText} ${noteEmoji}
                    </div>
                    
                    <div>
                        <span class="font-semibold text-white">&nbsp;M:</span> ${game.match || '—'} 
                    </div>
                    
                    </div>
                    
                    <button onclick="showMatchEntryModal(${gameIndex})"
                        class="${buttonClasses} w-full sm:w-fit"> 
                        Report Game
                    </button>
                </div>
                </div>
            `;
            
            fragment.appendChild(card);
        });
    });
    matchListDiv.appendChild(fragment);
}

/**
 * Updates the visual state of the Admin button and conditional UI elements.
 */
function updateAdminUI() {
    const adminButton = document.getElementById('admin-button');
    const adminStatusText = document.getElementById('admin-status-text');
    const adminEntryTab = document.getElementById('admin-entry-tab');
    const adminControls = document.getElementById('admin-controls');
    const adminTimerControls = document.getElementById('admin-panel');

    if (!adminButton || !adminStatusText || !adminEntryTab) return;

    if (App.state.isAdmin) {
        adminStatusText.textContent = 'Logout';
        adminButton.classList.remove('bg-gray-700', 'hover:bg-gray-600', 'text-accent');
        adminButton.classList.add('bg-lime-600', 'hover:bg-lime-500', 'text-white');
        adminButton.onclick = logoutAdmin;
        adminEntryTab.classList.remove('hidden'); // Show Admin Tab
        if(App.state.isSuperAdmin) adminTimerControls.classList.remove('hidden');
        console.log(`App.state.isSuperAdmin: ${App.state.isSuperAdmin}`)
    } else {
        adminStatusText.textContent = 'Admin';
        adminButton.classList.remove('bg-lime-600', 'hover:bg-lime-500', 'text-white');
        adminButton.classList.add('bg-gray-700', 'hover:bg-gray-600', 'text-accent');
        adminButton.onclick = showAdminLoginModal;
        adminEntryTab.classList.add('hidden'); // Hide Admin Tab
        if (adminControls) adminControls.classList.add('hidden');
    }
}

function showAdminLoginModal() {
    const modal = document.getElementById('admin-login-modal');
    const passwordInput = document.getElementById('admin-password-input');
    const message = document.getElementById('admin-login-message');

    // Show the modal
    modal.classList.remove('hidden');

    // Clear previous input and messages
    passwordInput.value = '';
    message.classList.add('hidden');

    // Wait a short moment to ensure the modal is visible before focusing
    setTimeout(() => passwordInput.focus(), 50);
}

function hideAdminLoginModal() {
    document.getElementById('admin-login-modal').classList.add('hidden');
}

async function loginAdmin() {
    const passwordInputEl = document.getElementById('admin-password-input');
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
    loginMessage.classList.add('hidden');
    loginButton.disabled = true;
    loginButton.textContent = 'Verifying...';

    try {
    // Use the API helper which returns the validation result
    const result = await validateAdmin(password);
        
        if (result && result.isAdmin) {
            App.state.isAdmin = true;
            //store this for persitstance
            sessionStorage.setItem('isAdmin', 'true');
            sessionStorage.setItem('isSuperAdmin', 'false');
            sessionStorage.setItem('adminAuthToken', result.token);
            if (result.isSuperAdmin && result.firebaseToken) {
                try {
                console.log(`I am a super admin: ${App.state.isSuperAdmin}`)
                await firebase.auth().signInWithCustomToken(result.firebaseToken);
                console.log('Super admin signed in to Firebase successfully');
                } catch (err) {
                console.error('Firebase sign-in error:', err);
                }
                App.state.isSuperAdmin = true;
                sessionStorage.setItem('isSuperAdmin', 'true');
                sessionStorage.setItem('firebaseToken', result.firebaseToken);
                //unhide timer controls for admin (if present)
                const timerControlsEl = document.getElementById('timer-controls');
                if (timerControlsEl) timerControlsEl.classList.remove('hidden');

            }

            hideAdminLoginModal();
            updateAdminUI();
            switchView('admin-entry'); // Go straight to admin view after login
            showStatus('Successfully logged in as Admin.', false);
            setTimeout(() => showStatus(null), 3000); 
            
        } else {
            App.state.isAdmin = false;
            loginMessage.textContent = 'Invalid password.';
            sessionStorage.removeItem('adminAuthToken'); // Clear any old token
            loginMessage.classList.remove('hidden');
        }

    } catch (error) {
        console.error("Admin Login Error:", error);
        loginMessage.textContent = 'An error occurred during login verification.';
        loginMessage.classList.remove('hidden');
    } finally {
        loginButton.disabled = false;
        loginButton.textContent = 'Login';
    }
}

function logoutAdmin() {
    App.state.isAdmin = false;
    //remove admin persistance
    sessionStorage.removeItem('isAdmin');
    sessionStorage.removeItem('isSuperAdmin');
    sessionStorage.removeItem('firebaseToken');
    firebase.auth().signOut();
    updateAdminUI();
    //hide timer controls if present.
    const _timerControlsEl = document.getElementById('timer-controls');
    if (_timerControlsEl) _timerControlsEl.classList.add('hidden');
    // If the user was in the admin tab, switch them out
    if (App.state.currentView === 'admin-entry') {
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
    winnerSelect.innerHTML = '<option value="—">— Select Winner —</option>';
    saveMessage.classList.add('hidden');
    
    // 1. Populate Match Info Display
    matchInfoDisplay.textContent = `${game.roundTime} | Court ${game.court || '—'} | ${game.team1 || 'TBD'} vs ${game.team2 || 'TBD'}`;

    // 2. Populate Winner Dropdown
    const teams = [game.team1, game.team2].filter(t => t && t.trim() !== '');
    teams.forEach(team => {
        const option = document.createElement('option');
        option.value = team;
        option.textContent = team;
        winnerSelect.appendChild(option);
    });

    if(App.settings.is_tie_allowed) {
        const option = document.createElement('option');
        option.value = "tie";
        option.textContent = "⚖️ tie";
        winnerSelect.appendChild(option);
    }
    
    // 3. Set current values (if available)
    const currentWinner = (game.adminWinner && game.adminWinner.trim() !== 'TBA') ? game.adminWinner.trim() : '—';
    winnerSelect.value = currentWinner;
    
    playersInput.value = game.adminPlayersRemaining || 0;
    notesTextarea.value = game.notes || '';
    
    // Set default admin name if previously entered in the session
    const lastAdminName = localStorage.getItem('lastAdminName') || '';
    adminNameInput.value = lastAdminName;

    // 4. Show the modal
    modal.classList.remove('hidden');
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
    saveButton.textContent = 'Saving...';
    messageElement.classList.add('hidden');
    messageElement.textContent = '';

    // --- 1. GET THE AUTH TOKEN ---
    const authToken = sessionStorage.getItem('adminAuthToken');
    //console.log(`AuthToken: ${authToken}`) ;

    if (!authToken) {
        messageElement.textContent = 'Authentication error - Please log in again.';
        messageElement.classList.remove('hidden');
        messageElement.classList.remove('text-lime-400');
        messageElement.classList.add('text-red-400');

        saveButton.disabled = false;
        saveButton.textContent = 'Save Result';
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

    console.log(`payload: ${payload}`)

    try {
    // Use the API helper to save match result
    // apiSaveMatchResult expects (authToken, matchData)
    const result = await apiSaveMatchResult(authToken, matchData);
        
        if (result.success) {
            messageElement.textContent = 'Result saved!';
            messageElement.classList.remove('hidden');
            messageElement.classList.remove('text-red-400');
            messageElement.classList.add('text-lime-400');
            
            // Reload all data to refresh standings and schedule
            await loadData(App.config.currentSheetName); 
            
            // Give user a moment to see the success message before closing
            setTimeout(hideMatchEntryModal, 500); 

        } else {
            // Server responded but indicated failure
            const errMsg = result.error || 'Server reported failure.';
            messageElement.textContent = 'ERROR: ' + errMsg;
            messageElement.classList.remove('hidden');
            messageElement.classList.remove('text-lime-400');
            messageElement.classList.add('text-red-400');
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
        messageElement.classList.remove('text-lime-400');
        messageElement.classList.add('text-red-400');
    } finally {
        saveButton.disabled = false;
        saveButton.textContent = 'Save Result';
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