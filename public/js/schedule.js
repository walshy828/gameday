/**
 * Filters the schedule data based on public dropdown selections and renders the table.
 */
function updateScheduleView() {
    const teamSelect = document.getElementById('team-select');
    const courtSelect = document.getElementById('court-select');
    
    const selectedTeam = teamSelect?.value || 'all';
    const selectedCourt = courtSelect?.value || 'all';
    
    
    
    const allRoundTimes = new Set(App.data.allScheduleData.map(g => g.roundTime).filter(t => t));
    let chronologicalRounds = Array.from(allRoundTimes).sort(compareRoundTimes);

    let combinedSchedule = [];
    //const byeContainer = document.getElementById('bye-rounds-info');
    //byeContainer.classList.add('hidden');

    // "Hide finished games" drops every game with a reported result; a round
    // whose games are all reported then falls out of the view entirely.
    const hideFinished = document.getElementById('hide-finished-toggle')?.checked;

    const courtFilteredSchedule = App.data.allScheduleData.filter(game =>
        (selectedCourt === 'all' || (game.court && game.court.trim() === selectedCourt)) &&
        !(hideFinished && isReported(game))
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

        // With "hide finished" on, byes already in the past go too — only the
        // current and upcoming ones are still worth showing.
        const liveKey = getLiveRoundKey();
        const liveIndex = liveKey === undefined ? chronologicalRounds.length : chronologicalRounds.indexOf(liveKey);

        for (const roundTime of chronologicalRounds) {
            if (hideFinished && chronologicalRounds.indexOf(roundTime) < liveIndex) continue;

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

    combinedSchedule.sort((a, b) => compareRoundTimes(a.roundTime, b.roundTime));

                
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

    // The "live" round comes from the WHOLE schedule, not the filtered view, so
    // that a team filtered down to a bye still sees its current round marked —
    // otherwise its synthetic BYE row (which carries a winner) would read as a
    // finished round and nothing would be highlighted.
    const roundKeys = [...rounds.keys()];
    const roundOrder = getRoundOrder();
    const liveKey = getLiveRoundKey();
    const liveIndex = liveKey === undefined ? roundOrder.length : roundOrder.indexOf(liveKey);

    const fragment = document.createDocumentFragment();  //to batch updates

    // Bye teams are only meaningful in the unfiltered view — with a single team
    // selected the round card holds just that team's game, so listing every
    // other team as "not playing" would be noise.
    const showByeFooter = (document.getElementById('team-select')?.value || 'all') === 'all';
    const allTeams = showByeFooter ? getRosterTeams() : null;

    const dim = 'rgba(255,255,255,.38)';
    const strong = 'rgba(255,255,255,.86)';

    roundKeys.forEach(roundTime => {
        const games = rounds.get(roundTime);
        const live = roundTime === liveKey;
        const done = roundOrder.indexOf(roundTime) < liveIndex;
        // A live round holding only BYE rows means the filtered team is sitting
        // this round out — same gold highlight, different wording.
        const liveBye = live && games.every(g => g.isBye);

        // The live round keeps the same dark card as every other round; the only
        // difference is a gold border (plus a soft gold glow) marking it active.
        const card = document.createElement('section');
        card.className = 'rounded-[26px] border p-3.5';
        card.style.background = live ? 'rgba(255,255,255,.075)' : 'rgba(255,255,255,.055)';
        card.style.borderColor = live ? 'var(--gold)' : 'rgba(255,255,255,.1)';
        card.style.boxShadow = live
            ? '0 0 0 1px rgba(224,184,99,.35), 0 14px 36px rgba(0,0,0,.26)'
            : '0 14px 36px rgba(0,0,0,.26)';

        const chipStyle = live
            ? 'background:linear-gradient(135deg,var(--gold) 0%,var(--gold-d) 100%);color:#2A1B08'
            : 'background:rgba(255,255,255,.08);color:rgba(255,255,255,.7)';

        const head = document.createElement('div');
        head.className = 'flex items-center gap-2.5';
        head.innerHTML = `
            <span class="rounded-full px-2.5 py-1.5 text-[11px] font-semibold leading-none tracking-[.02em]" style="${chipStyle}">${esc(roundTime)}</span>
            <span class="text-[9px] font-semibold leading-none tracking-[.12em]" style="color:${live ? 'var(--gold)' : 'rgba(255,255,255,.4)'}">${liveBye ? 'ON BYE THIS ROUND' : live ? 'ON COURT NOW' : done ? 'FINAL' : 'UPCOMING'}</span>
        `;
        card.appendChild(head);

        const rows = document.createElement('div');
        rows.className = 'mt-2.5 grid gap-[5px]';

        games.forEach(game => {
            const row = document.createElement('div');
            row.className = 'flex items-center gap-2.5 rounded-2xl px-3 py-2.5';
            row.style.background = 'rgba(255,255,255,.05)';

            if (game.isBye) {
                // A bye in the current round gets the same gold treatment an
                // in-progress game does, so "you're off this round" is obvious.
                if (live) {
                    row.style.background = 'rgba(224,184,99,.07)';
                    row.style.boxShadow = 'inset 0 0 0 1px rgba(224,184,99,.55)';
                }
                row.innerHTML = `
                    <span class="flex-none w-[26px] h-[26px] rounded-[9px] text-center text-[10px] font-bold leading-[26px]"
                          style="background:${live ? 'rgba(224,184,99,.14)' : 'rgba(255,255,255,.08)'};color:${live ? 'var(--gold-l)' : 'rgba(255,255,255,.6)'}">—</span>
                    <span class="flex-1 min-w-0 truncate text-[13px] font-semibold leading-[1.4]" style="color:${strong}">${esc(game.team)}</span>
                    <span class="flex-none text-right text-[9px] font-semibold leading-[1.3] tracking-[.08em]" style="color:${live ? 'var(--gold)' : dim}">${live ? 'ON BYE NOW' : 'BYE'}</span>
                `;
                rows.appendChild(row);
                return;
            }

            const reported = isReported(game);
            const winner = reported ? game.winner.trim() : null;
            const tie = reported && App.settings.is_tie_allowed && winner === 'tie';
            const aWon = reported && winner === game.team1;
            const bWon = reported && winner === game.team2;

            // Within the live round, a game still awaiting a result is the one
            // actually being played — give it its own gold outline.
            if (live && !reported) {
                row.style.background = 'rgba(224,184,99,.07)';
                row.style.boxShadow = 'inset 0 0 0 1px rgba(224,184,99,.55)';
            }

            let res, resColor;
            if (reported) {
                // The winner is called out on its own team line, so the result
                // slot only carries the tie case.
                res = tie ? 'TIE' : '';
                resColor = 'var(--gold)';
            } else if (live) {
                res = 'ON COURT';
                resColor = 'var(--ok)';
            } else {
                res = esc(roundTime);
                resColor = dim;
            }

            row.innerHTML = `
                <span class="flex-none w-[26px] h-[26px] rounded-[9px] text-center text-[10px] font-bold leading-[26px]"
                      style="background:${live ? 'rgba(224,184,99,.14)' : 'rgba(255,255,255,.08)'};color:${live ? 'var(--gold-l)' : 'rgba(255,255,255,.6)'}">C${esc(game.court || '?')}</span>
                <span class="flex-1 min-w-0 grid gap-[2px]">
                    ${teamLine(game.team1, reported, aWon, tie, dim, strong, game.playersRemaining)}
                    ${teamLine(game.team2, reported, bWon, tie, dim, strong, game.playersRemaining)}
                </span>
                <span class="flex-none text-right text-[9px] font-semibold leading-[1.3] tracking-[.08em]" style="color:${resColor}">${res}</span>
            `;
            rows.appendChild(row);
        });

        card.appendChild(rows);

        // --- Teams sitting this round out ---------------------------------
        if (allTeams) {
            const byeTeams = getByeTeams(roundTime, allTeams);
            if (byeTeams.length) {
                const footer = document.createElement('div');
                footer.className = 'mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-2.5';
                footer.style.borderColor = 'rgba(255,255,255,.08)';
                footer.innerHTML = `
                    <span class="text-[9px] font-semibold leading-none tracking-[.12em]" style="color:rgba(255,255,255,.4)">ON BYE</span>
                    ${byeTeams.map(t => `
                        <span class="rounded-full px-2 py-1 text-[11px] font-medium leading-none"
                              style="background:rgba(255,255,255,.06);color:rgba(255,255,255,.6)">${esc(t)}</span>
                    `).join('')}
                `;
                card.appendChild(footer);
            }
        }

        fragment.appendChild(card);
    });

    scheduleContainer.appendChild(fragment);
}

/**
 * One team line inside a game row. A reported winner is called out with a gold
 * check badge (carrying its players-remaining count) and gold text; the losing
 * side dims. On a tie neither is marked.
 */
function teamLine(name, reported, won, tie, dim, strong, playersRemaining) {
    const mark = won && !tie
        ? `<span class="flex-none inline-flex items-center gap-1 rounded-full px-1.5 h-[15px] text-[9px] font-bold leading-[15px]"
                 style="background:var(--gold);color:#2A1B08">✓ ${esc(playersRemaining ?? 0)}</span>`
        : '';
    const color = !reported || tie ? strong : (won ? 'var(--gold-l)' : dim);
    return `
        <span class="flex items-center gap-1.5">
            <span class="min-w-0 truncate text-[13px] leading-[1.4] ${won && !tie ? 'font-bold' : 'font-semibold'}" style="color:${color}">${esc(name || 'TBD')}</span>
            ${mark}
        </span>
    `;
}

/** Chronological comparator for two roundTime strings (times before text). */
function compareRoundTimes(a, b) {
    const sortA = parseRoundTime(a);
    const sortB = parseRoundTime(b);

    // Both times or both text: compare their values. Mixed: time comes first.
    if (sortA.isTime === sortB.isTime) return sortA.sortValue.localeCompare(sortB.sortValue);
    return sortA.isTime ? -1 : 1;
}

/** Every round in the full schedule, chronologically. */
function getRoundOrder() {
    return [...new Set(App.data.allScheduleData.map(g => g.roundTime || 'TBD'))].sort(compareRoundTimes);
}

/**
 * The round currently being played: the earliest round in the full schedule
 * that still has an unreported game. Undefined once everything is reported.
 */
function getLiveRoundKey() {
    return getRoundOrder().find(key =>
        App.data.allScheduleData.some(g => (g.roundTime || 'TBD') === key && !isReported(g))
    );
}

/** True for an actual team name (not a bracket placeholder like 'Winner P3'). */
function isRealTeam(name) {
    return getFilterableTeamName(name) !== null;
}

/** Every real team appearing anywhere in the schedule, as their raw names. */
function getRosterTeams() {
    const teams = new Set();
    App.data.allScheduleData.forEach(g => {
        [g.team1, g.team2].forEach(t => { if (isRealTeam(t)) teams.add(t.trim()); });
    });
    return teams;
}

/**
 * Teams from the full roster with no game in this round. Reads the unfiltered
 * schedule so a court filter can't make a playing team look like it's on a bye.
 * Playoff rounds ('P…') sit most of the field out by design, so they're skipped.
 */
function getByeTeams(roundTime, allTeams) {
    if (typeof roundTime === 'string' && roundTime.startsWith('P')) return [];

    const playing = new Set();
    App.data.allScheduleData.forEach(g => {
        if ((g.roundTime || 'TBD') !== roundTime) return;
        [g.team1, g.team2].forEach(t => { if (isRealTeam(t)) playing.add(t.trim()); });
    });

    if (playing.size === 0) return [];
    // Playoff bracket seeds (e.g. "Team Name (#6)") duplicate the base team
    // name — only the base name belongs on the bye footer.
    return [...allTeams]
        .filter(t => !playing.has(t) && !/\(#\d+\)\s*$/.test(t))
        .sort((a, b) => a.localeCompare(b));
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

export {
    updateScheduleView,
    renderScheduleView,
    parseRoundTime,
    getUniqueCourts,
    getUniqueTeams,
    getFilterableTeamName,
    getRoundOrder,
    getLiveRoundKey,
    getRosterTeams,
    getByeTeams,
    isReported
};