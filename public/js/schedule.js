/**
 * Filters the schedule data based on public dropdown selections and renders the table.
 */
import { getCurrentFilteredTeam } from './main.js';
function updateScheduleView() {
    const teamSelect = document.getElementById('team-select');
    const courtSelect = document.getElementById('court-select');
    
    const selectedTeam = teamSelect?.value || 'all';
    const selectedCourt = courtSelect?.value || 'all';
    
    
    
    const allRoundTimes = new Set(App.data.allScheduleData.map(g => g.roundTime).filter(t => t)); 
    let chronologicalRounds = Array.from(allRoundTimes);
    
    chronologicalRounds.sort((a, b) => {
        // a and b are the roundTime strings, so pass them directly to parseRoundTime
        const sortA = parseRoundTime(a);
        const sortB = parseRoundTime(b);
        
        const isTimeA = sortA.isTime;
        const isTimeB = sortB.isTime;

        // Case 1: Both are times or both are text (sort by their respective values)
        if (isTimeA === isTimeB) {
            return sortA.sortValue.localeCompare(sortB.sortValue);
        }

        // Case 2: Mixed types - Time always comes before Text
        return isTimeA ? -1 : 1; 
    });

    let combinedSchedule = [];
    //const byeContainer = document.getElementById('bye-rounds-info');
    //byeContainer.classList.add('hidden');

    const courtFilteredSchedule = App.data.allScheduleData.filter(game => 
        selectedCourt === 'all' || (game.court && game.court.trim() === selectedCourt)
    );

    if (selectedTeam === 'all') {
        combinedSchedule = courtFilteredSchedule;
    } else {
        // *** MODIFIED FILTER LOGIC ***
        const teamAndCourtFilteredSchedule = courtFilteredSchedule.filter(game => {
            const baseTeam1 = getFilterableTeamName(game.team1);
            const baseTeam2 = getFilterableTeamName(game.team2);

            // Check if the selected base team matches the base name of team1 or team2
            const team1Match = (baseTeam1 === selectedTeam);
            const team2Match = (baseTeam2 === selectedTeam);
            
            return team1Match || team2Match;
        });

        const teamPlayedRoundTimes = new Set(App.data.allScheduleData.filter(game => 
                // The BYE logic also needs to check against the base team name
                getFilterableTeamName(game.team1) === selectedTeam || 
                getFilterableTeamName(game.team2) === selectedTeam
            ).map(g => g.roundTime).filter(t => t));

        let byeRounds = [];

        for (const roundTime of chronologicalRounds) {
            if (!teamPlayedRoundTimes.has(roundTime) && !roundTime.startsWith('P')) {
                const gamesInRound = App.data.allScheduleData.filter(g => g.roundTime === roundTime);
                const gameIsOnFilteredCourt = selectedCourt === 'all' || gamesInRound.some(g => g.court && g.court.trim() === selectedCourt);

                if (selectedCourt === 'all' || gameIsOnFilteredCourt) {
                    byeRounds.push({
                        roundTime: roundTime,
                        isBye: true,
                        team: selectedTeam,
                        team1: selectedTeam, team2: 'BYE', court: '—', winner: 'BYE', playersRemaining: '—' 
                    });
                }
            }
        }
        
        combinedSchedule = [...teamAndCourtFilteredSchedule, ...byeRounds];

        let infoText = `Filtering for: <span class="text-accent">${selectedTeam}</span>`;
        if (selectedCourt !== 'all') {
            infoText += ` on Court: <span class="text-accent">${selectedCourt}</span>`;
        }
        //byeContainer.classList.remove('hidden');
        //byeContainer.innerHTML = `<p class="font-bold text-sm">${infoText}</p>`;
    }

    combinedSchedule.sort((a, b) => {
        // a.roundTime and b.roundTime are the strings, so pass them to parseRoundTime
        const sortA = parseRoundTime(a.roundTime);
        const sortB = parseRoundTime(b.roundTime);

        const isTimeA = sortA.isTime;
        const isTimeB = sortB.isTime;

        // Case 1: Both are times or both are text (sort by their respective values)
        if (isTimeA === isTimeB) {
            return sortA.sortValue.localeCompare(sortB.sortValue);
        }

        // Case 2: Mixed types - Time always comes before Text
        return isTimeA ? -1 : 1;
    });

                
    renderScheduleView(combinedSchedule);
}

/**
* Renders the schedule data into the schedule table. (Public View)
*/
function renderScheduleView(schedule) {
    // We are now rendering into the container div, not a tbody.
    // Assuming the container for the schedule is a div with the ID 'schedule-table-container' 
    // or similar, instead of a 'tbody' with ID 'schedule-table-body'.
    const scheduleContainer = document.getElementById('schedule-view-container');
    if (!scheduleContainer) return;

    scheduleContainer.innerHTML = ''; // Clear previous content

    if (schedule.length === 0) {
        scheduleContainer.innerHTML = '<p class="text-center py-4 text-gray-500">No schedule or results data available based on current filters.</p>';
        return;
    }

    const currentTeam = getCurrentFilteredTeam();
    let firstUnplayedGameFound = false;

    const winnerHighlightClass = 'text-lime-300 font-extrabold';
    const checkmark = '<span class="text-lime-500 ml-1">✅</span>';
    const tieHighlightClass = 'text-yellow-100';
    const tieIndicator = '<span class="text-yellow-300">[T]</span>';

    // Helper map for mobile border color fallback
    const mobileBorderColorMap = {
        'border-green-600': '#059669', // Green
        'border-red-600': '#DC2626',   // Red
        'border-accent': '#FFBF00',    // Amber (Assumes border-accent maps to a specific amber color)
        'border-gray-700': '#374151',  // Gray
        'border-gray-600': '#4B5563'   // Darker Gray
    };

    // Use a simple screen width check for mobile/desktop
    const isMobile = window.innerWidth <= 768; // 768px is a common tablet/mobile cutoff

    const fragment = document.createDocumentFragment();  //to batch updates
    schedule.forEach(game => {
        const card = document.createElement('div');
        
        // --- Determine Card Styling (Borders & Backgrounds) ---
        let cardClasses = 'schedule-card bg-gray-800/50 p-3 rounded-lg shadow-md mb-3 border-l-4 transition duration-150 ease-in-out';
        let backgroundClass = 'bg-gray-800/50';
        let borderClasses = 'border-gray-600'; // Default
        
        if (game.isBye) {
            // Styling for BYE rounds
            borderClasses = 'border-gray-700'; // Match the default unplayed game
            cardClasses = 'schedule-card bg-gray-900/10 p-3 rounded-lg shadow-md mb-3 border-l-4 border-gray-700 text-accent font-semibold transition duration-150 ease-in-out';
            card.innerHTML = `
                <div class="flex flex-col">
                    <div class="text-base font-bold mb-1">${game.roundTime || 'TBD'} <span class="mr-2">😴</span></div>
                    <div class="flex items-center text-sm md:text-base">
                            ${game.team} has a **BYE**
                    </div>
                </div>
            `;
        } else {
            const isCompleted = game.winner && game.winner.trim() !== '' && game.winner.trim() !== 'TBA' && game.winner.trim() !== '—';
            
            if (isCompleted) {
        if (currentTeam !== 'all') {
            const winnerTrimmed = game.winner.trim();
            if (winnerTrimmed === currentTeam) {
                backgroundClass = 'bg-green-900/10';
                borderClasses = 'border-green-600'; // Green for Win
            } else if(App.settings.is_tie_allowed && winnerTrimmed==="tie") {
                backgroundClass = 'bg-green-900/10';
                borderClasses = 'border-green-200'; // light green for the tie
            } else {
                backgroundClass = 'bg-red-900/10';
                borderClasses = 'border-red-600'; // Red for Loss
            }
        } else {
            backgroundClass = 'bg-gray-800/50';
            borderClasses = 'border-gray-600';
        }
    } else {
        if (!firstUnplayedGameFound) {
            // Highlight the next upcoming game
            borderClasses = 'border-accent'; // AMBER for Next Game
            backgroundClass = 'bg-gray-700/50'; // Use a distinct background for next game
            firstUnplayedGameFound = true;
        } else {
            borderClasses = 'border-gray-700';
            backgroundClass = 'bg-gray-800/50';
        }
    }
            
            cardClasses += ` ${backgroundClass}`;

            // --- Team Display Logic ---
            let team1Classes = 'font-bold';
            let team2Classes = 'font-bold';
            let team1Emoji = '';
            let team2Emoji = '';
            
            if (isCompleted) {
                const winnerTrimmed = game.winner.trim();
                if (winnerTrimmed === game.team1) {
                    team1Classes += ` ${winnerHighlightClass}`;
                    team1Emoji = checkmark;
                } else if (winnerTrimmed === game.team2) {
                    team2Classes += ` ${winnerHighlightClass}`;
                    team2Emoji = checkmark;
                } else if (App.settings.is_tie_allowed && winnerTrimmed==="tie") {
                    team1Classes += ` ${tieHighlightClass}`;
                    team1Emoji = tieIndicator;
                    team2Classes += ` ${tieHighlightClass}`;
                    team2Emoji = tieIndicator;
                }
            }
            
            // Player Remaining display logic
            const playersRemainingDisplay = isCompleted ? (game.playersRemaining || '—') : '—';

            // --- Card Content Structure ---
            // Main flex container for content, allowing for horizontal/vertical stacking
            card.innerHTML = `
                    <div class="flex flex-col w-full"> 
                        <div class="flex justify-between w-full mb-2 text-lg">
                            <div class="font-bold text-white text-base leading-tight">
                                ${game.roundTime || 'TBD'}
                            </div>
                            <div class="font-bold text-white text-base leading-tight">
                                Court ${game.court || ' —'}
                            </div>
                        </div>
                        
                        <div class="relative flex flex-col text-sm md:text-base flex-grow min-w-0">
                            <div class="flex items-center flex-wrap text-base">
                                <span class="${team1Classes} whitespace-nowrap">${game.team1 || 'TBD'}${team1Emoji}</span>
                                <span class="text-gray-500 font-normal ml-2 mr-2">vs</span>
                            </div>
                            <div class="flex items-center text-base mt-1 justify-between">
                                <span class="${team2Classes} whitespace-nowrap">${game.team2 || 'TBD'}${team2Emoji}</span>
                                <div class="text-xs text-gray-400 font-semibold">
                                    M:${game.match || '—'}
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }
        // --- Final Border Application ---
    
            if (isMobile) {
                // On mobile, remove all default border classes and apply inline style
                const mobileColor = mobileBorderColorMap[borderClasses] || '#374151';
                card.style.borderLeft = `4px solid ${mobileColor}`;
            } else {
                // On desktop/larger screens, apply the Tailwind utility class
                cardClasses += ` ${borderClasses} border-solid`; // Added border-solid for robustness
            }


        // Remove any default border-gray-700 that might have been in the base cardClasses
        cardClasses = cardClasses.replace('border-gray-700', '').trim().replace(/\s+/g, ' ');
        
        card.className = cardClasses.trim();
        fragment.appendChild(card);
    });
    scheduleContainer.appendChild(fragment);
}

    /**
 * Parses time strings into a sortable string.
 */
function parseRoundTime(timeStr) {
        if (!timeStr || typeof timeStr !== 'string') {
            // Treat null/empty strings as text that sorts last
            return { isTime: false, sortValue: 'Zz' }; 
        }

        // Check if it looks like a time (starts with a digit and has a colon)
        const isTimeFormat = /^\d.*:.*\s*(AM|PM)?/i.test(timeStr);

        if (isTimeFormat) {
            const parts = timeStr.match(/(\d+):(\d+)\s*(AM|PM)?/i);
            
            if (!parts) {
                // Failed to parse, treat as text
                return { isTime: false, sortValue: timeStr };
            }

            let hour = parseInt(parts[1]);
            const minute = parts[2];
            const ampm = parts[3] ? parts[3].toUpperCase() : '';

            // Convert to 24-hour format
            if (ampm === 'PM' && hour !== 12) {
                hour += 12;
            } else if (ampm === 'AM' && hour === 12) {
                hour = 0;
            }

            const hourStr = String(hour).padStart(2, '0');
            // Return a key for chronological sorting (e.g., "09:05")
            return { isTime: true, sortValue: `${hourStr}:${minute}` }; 
        }

        // If it's not a time (e.g., 'P1.Round 1'), treat it as text
        return { isTime: false, sortValue: timeStr };
    }


// --- DATA FETCHING AND RENDERING ---

/**
 * Utility to get unique, sorted court names from the schedule data.
 */
function getUniqueCourts() {
    return App.data.allScheduleData
        .map(g => g.court)
        .filter((value, index, self) => value && value.trim() !== '' && self.indexOf(value) === index) 
        .sort();
}

/**
 * Utility to get unique, sorted base team names for the filter dropdowns.
 */
function getUniqueTeams() {
    const teams = new Set();
    App.data.allScheduleData.forEach(game => {
        // Process Team 1
        const baseTeam1 = getFilterableTeamName(game.team1);
        if (baseTeam1) teams.add(baseTeam1);
        
        // Process Team 2
        const baseTeam2 = getFilterableTeamName(game.team2);
        if (baseTeam2) teams.add(baseTeam2);
    });
    
    // Sort the final list of base team names
    return Array.from(teams).sort((a, b) => a.localeCompare(b)); 
}

/**
 * Extracts the base team name for use in the filter dropdown.
 * Ex: '🦆 The Mighty Duckers (#1)' -> '🦆 The Mighty Duckers'
 * Ex: 'Winner P3' -> null (Do not show in filter)
 * Ex: 'The Mighty Duckers' -> 'The Mighty Duckers'
 * @param {string} teamName - The full team name from the data.
 * @returns {string|null} The base team name or null if it's a bracket placeholder.
 */
function getFilterableTeamName(teamName) {
    if (!teamName || teamName.trim() === '') return null;
    const name = teamName.trim();
    
    // 1. Exclude match placeholders/winners (e.g., 'Winner P3', 'TBA', 'BYE', '—')
    if (name.startsWith('Winner') || name === 'TBA' || name === '—' || name === 'BYE') {
        return null;
    }

    // 2. Remove rank indicator: ' Ducks (#1)' -> ' Ducks'
    const cleanedName = name.replace(/\s*\(#\d+\)$/, '').trim();
    
    return cleanedName;
}

// Global state variables for the pager
// Global state variables for the pager (now initialized dynamically)
let pagerInterval;
let currentPage = 0;

/**
 * Renders a single page of standings data into the pager element.
 * (This function remains the same as before)
 */
function buildPagerContent(pageItems) {
    if (!pageItems || pageItems.length === 0) {
        return '<p class="text-sm text-gray-500 px-2">No standings data available.</p>';
    }

    // Build the HTML for the current page
    return pageItems.map(item => `
        <span class="standings-pager-item flex items-center gap-1.5 px-3 border-r border-gray-800 last:border-r-0">
            <span class="font-bold text-lime-400 text-sm">${item.rank || '?'}</span>
            <span class="font-medium text-gray-300 text-sm">${item.team}</span>
            <span class="font-mono text-xs text-gray-500">(${item.record || '0-0'})</span>
        </span>
    `).join('');
}


/**
 * Core function to start the paginating cycle.
 * (This function remains mostly the same, but now accepts dynamic config)
 */
function initStandingsPager(standingsData, itemsPerPage, cycleDelayMs) {
    const contentDiv = document.getElementById('standings-pager-content');
    if (!contentDiv) return;

    // 1. Clear any existing interval
    if (pagerInterval) {
        clearInterval(pagerInterval);
    }
    
    // 2. Handle no data
    if (!standingsData || standingsData.length === 0) {
        contentDiv.innerHTML = '<p class="text-sm text-gray-500 px-2">No standings data available.</p>';
        contentDiv.classList.remove('opacity-0');
        return;
    }

    // 3. Slice the full data into pages using the dynamic itemsPerPage
    const pages = [];
    for (let i = 0; i < standingsData.length; i += itemsPerPage) {
        pages.push(standingsData.slice(i, i + itemsPerPage));
    }

    const totalPages = pages.length;
    currentPage = 0;

    // 4. Function to update the view
    function updatePager() {
        contentDiv.classList.add('opacity-0'); 

        // Wait for the fade-out to complete (500ms from CSS transition)
        setTimeout(() => {
            const pageData = pages[currentPage];
            contentDiv.innerHTML = buildPagerContent(pageData);

            currentPage = (currentPage + 1) % totalPages;

            contentDiv.classList.remove('opacity-0');
        }, 500); 
    }

    // 5. Start the cycle with the dynamic cycleDelayMs
    updatePager(); // Display the first page immediately
    pagerInterval = setInterval(updatePager, cycleDelayMs); 
}


/**
 * Initializes the standings pager by checking screen size, setting config, 
 * fetching data, and starting the cycle.
 */
async function loadAndStartStandingsPager(standingsData) {
    let itemsPerPage;
    let cycleDelayMs;
    // Define the mobile breakpoint (e.g., Tailwind's 'sm' breakpoint is 640px)
    const MOBILE_BREAKPOINT = 640; 

    // Check the current screen width
    if (window.innerWidth < MOBILE_BREAKPOINT) {
        // 📱 Mobile/Small Screen Configuration
        itemsPerPage = 1;
        cycleDelayMs = 2000; // 2 seconds
        console.log("Pager: Mobile config (1 item / 2s cycle)");
    } else {
        // 💻 Desktop/Large Screen Configuration
        itemsPerPage = 4;
        cycleDelayMs = 6000; // 6 seconds
        console.log("Pager: Desktop config (5 items / 6s cycle)");
    }
    
    try {
        // 1. Fetch data (This remains the same)
        // ASSUMPTION: Your getStandingsData() fetches and returns the data array.
        
        // 2. Start the pager with the dynamic settings
        initStandingsPager(standingsData, itemsPerPage, cycleDelayMs);
    } catch (error) {
        console.error("Error loading standings for pager:", error);
        const contentDiv = document.getElementById('standings-pager-content');
        if (contentDiv) {
            contentDiv.innerHTML = '<p class="text-sm text-red-400 px-2">Failed to load standings data.</p>';
            contentDiv.classList.remove('opacity-0');
        }
    }
}

export {
    updateScheduleView,
    renderScheduleView,
    parseRoundTime,
    getUniqueCourts,
    getUniqueTeams,
    buildPagerContent,
    initStandingsPager,
    loadAndStartStandingsPager,
    getFilterableTeamName
};