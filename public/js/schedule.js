/**
 * Filters the schedule data based on public dropdown selections and renders the table.
 */
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
    const scheduleContainer = document.getElementById('schedule-view-container');
    if (!scheduleContainer) return;

    scheduleContainer.innerHTML = ''; // Clear previous content

    // Court-count kicker on the title row (design §7)
    const courtLabel = document.getElementById('schedule-court-count');
    if (courtLabel) {
        const n = getUniqueCourts().length;
        courtLabel.textContent = n ? `${n} COURT${n === 1 ? '' : 'S'}` : '';
    }

    if (schedule.length === 0) {
        scheduleContainer.innerHTML = '<p class="py-4 text-center text-sm text-white/45">No schedule or results data available based on current filters.</p>';
        return;
    }

    // --- Group by round time -----------------------------------------------
    // Design §7 renders one card per round (time chip + status label) holding a
    // row per court, rather than one card per game. `schedule` is already sorted
    // chronologically by updateScheduleView(), so insertion order is the round
    // order and a Map preserves it.
    const rounds = new Map();
    schedule.forEach(game => {
        const key = game.roundTime || 'TBD';
        if (!rounds.has(key)) rounds.set(key, []);
        rounds.get(key).push(game);
    });

    // The "live" round is the earliest one with an unreported game — everything
    // before it is FINAL, everything after is UPCOMING. That's the same signal
    // the old renderer used for its single amber "next game" highlight.
    const roundKeys = [...rounds.keys()];
    const liveKey = roundKeys.find(key => rounds.get(key).some(g => !isReported(g)));

    const fragment = document.createDocumentFragment();  //to batch updates

    roundKeys.forEach(roundTime => {
        const games = rounds.get(roundTime);
        const live = roundTime === liveKey;
        const done = liveKey === undefined || roundKeys.indexOf(roundTime) < roundKeys.indexOf(liveKey);

        const card = document.createElement('section');
        card.className = 'rounded-[26px] border p-3.5 shadow-[0_14px_36px_rgba(0,0,0,.26)]';
        card.style.background = live ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.055)';
        card.style.borderColor = live ? 'rgba(224,184,99,.5)' : 'rgba(255,255,255,.1)';

        const chipStyle = live
            ? 'background:linear-gradient(135deg,var(--gold) 0%,var(--gold-d) 100%);color:#2A1B08'
            : 'background:rgba(255,255,255,.08);color:rgba(255,255,255,.7)';

        const head = document.createElement('div');
        head.className = 'flex items-center gap-2.5';
        head.innerHTML = `
            <span class="rounded-full px-2.5 py-1.5 text-[11px] font-semibold leading-none tracking-[.02em]" style="${chipStyle}">${esc(roundTime)}</span>
            <span class="text-[9px] font-semibold leading-none tracking-[.12em]" style="color:${live ? 'var(--mar)' : 'rgba(255,255,255,.4)'}">${live ? 'ON COURT NOW' : done ? 'FINAL' : 'UPCOMING'}</span>
        `;
        card.appendChild(head);

        const rows = document.createElement('div');
        rows.className = 'mt-2.5 grid gap-[5px]';

        games.forEach(game => {
            const row = document.createElement('div');
            row.className = 'flex items-center gap-2.5 rounded-2xl px-3 py-2.5';
            row.style.background = live ? '#F5F5F6' : 'rgba(255,255,255,.05)';

            if (game.isBye) {
                row.innerHTML = `
                    <span class="flex-none w-[26px] h-[26px] rounded-[9px] text-center text-[10px] font-bold leading-[26px]"
                          style="background:${live ? 'rgba(123,29,43,.1)' : 'rgba(255,255,255,.08)'};color:${live ? 'var(--mar)' : 'rgba(255,255,255,.6)'}">—</span>
                    <span class="flex-1 min-w-0 truncate text-[13px] font-semibold leading-[1.4]" style="color:${live ? 'var(--ink)' : 'rgba(255,255,255,.86)'}">${esc(game.team)}</span>
                    <span class="flex-none text-right text-[9px] font-semibold leading-[1.3] tracking-[.08em]" style="color:${live ? 'var(--mute)' : 'rgba(255,255,255,.38)'}">BYE</span>
                `;
                rows.appendChild(row);
                return;
            }

            const reported = isReported(game);
            const winner = reported ? game.winner.trim() : null;
            const tie = reported && App.settings.is_tie_allowed && winner === 'tie';
            const aWon = reported && winner === game.team1;
            const bWon = reported && winner === game.team2;

            // Losing side dims; winner (or both, on a tie) stays at full strength.
            const dim = live ? 'var(--mute)' : 'rgba(255,255,255,.38)';
            const strong = live ? 'var(--ink)' : 'rgba(255,255,255,.86)';

            let res, resColor;
            if (reported) {
                res = tie ? 'TIE' : `WIN · ${game.playersRemaining ?? 0}`;
                resColor = live ? 'var(--mar)' : 'var(--gold)';
            } else if (live) {
                res = 'ON COURT';
                resColor = 'var(--ok)';
            } else {
                res = esc(roundTime);
                resColor = 'rgba(255,255,255,.38)';
            }

            row.innerHTML = `
                <span class="flex-none w-[26px] h-[26px] rounded-[9px] text-center text-[10px] font-bold leading-[26px]"
                      style="background:${live ? 'rgba(123,29,43,.1)' : 'rgba(255,255,255,.08)'};color:${live ? 'var(--mar)' : 'rgba(255,255,255,.6)'}">C${esc(game.court || '?')}</span>
                <span class="flex-1 min-w-0">
                    <span class="block truncate text-[13px] font-semibold leading-[1.4]" style="color:${reported && !aWon && !tie ? dim : strong}">${esc(game.team1 || 'TBD')}</span>
                    <span class="block truncate text-[13px] font-semibold leading-[1.4]" style="color:${reported && !bWon && !tie ? dim : strong}">${esc(game.team2 || 'TBD')}</span>
                </span>
                <span class="flex-none text-right text-[9px] font-semibold leading-[1.3] tracking-[.08em]" style="color:${resColor}">${res}</span>
            `;
            rows.appendChild(row);
        });

        card.appendChild(rows);
        fragment.appendChild(card);
    });

    scheduleContainer.appendChild(fragment);
}

/** A game counts as played once it carries a real winner value. */
function isReported(game) {
    const w = (game.winner || '').trim();
    return w !== '' && w !== 'TBA' && w !== '—';
}

/** Escapes a value for safe interpolation into a template-literal row. */
function esc(str) {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
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
        <span class="standings-pager-item flex items-center gap-1.5 px-3 border-r border-white/10 last:border-r-0">
            <span class="text-sm font-bold text-gold-l tabular-nums">${esc(item.rank || '?')}</span>
            <span class="text-sm font-medium text-white/75">${esc(item.team)}</span>
            <span class="text-xs text-white/40 tabular-nums">(${esc(item.record || '0-0')})</span>
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