import { getDivisions } from './api.js';
import { initSettingsView } from './settings.js';
import { onChatTabOpened } from './chat.js';
import { renderPlayoffsView } from './playoffs.js';
import { renderGameManager } from './gameManagerUI.js';
import { renderStandings } from './standings.js';

/**
 * Fetches all division (sheet) names via the /api/divisions REST endpoint.
 * Backend-agnostic: works identically whether the server is running against
 * Firebase or a local database (DATA_BACKEND).
 */
const DIVISION_STORAGE_KEY = 'selectedDivision';

async function fetchDivisionNames() {
    showStatus('Fetching divisions...');

    try {
    const divisionNames = await getDivisions();

    if (!divisionNames || !divisionNames.length) throw new Error("No divisions found.");

    App.data.allDivisionNames = divisionNames;

    renderGateDivisions();

    const storedDivision = localStorage.getItem(DIVISION_STORAGE_KEY);
    if (storedDivision && App.data.allDivisionNames.includes(storedDivision)) {
        // Returning visitor — skip the gate and go straight back into the app.
        await enterApp(storedDivision);
    } else {
        // First-time visitor (or no prior selection) — wait at the gate for
        // a division tap; renderGateDivisions() above already populated it.
        showGate();
    }

    } catch (error) {
    console.error("Error fetching division names:", error);
    if (App.state.isSuperAdmin) {
        // If superadmin, bypass the gate and go directly to settings to fix the setup
        App.state.screen = 'app';
        document.getElementById('gate-screen')?.classList.add('hidden');
        document.getElementById('app-screen')?.classList.remove('hidden');
        document.getElementById('bottom-tab-bar')?.classList.remove('hidden');
        switchView('settings');
        showStatus('No divisions found. Please configure and run Google Sheets sync below.', false);
    } else {
        showStatus('Failed to load divisions: ' + error.message, true);
    }
    }
}

/**
 * Renders the division card grid on the Gate screen. Reuses the same
 * `App.data.allDivisionNames` fetched for the in-app dropdown/pill picker —
 * just a different presentation of the same data source.
 */
function renderGateDivisions() {
    const grid = document.getElementById('gate-division-grid');
    if (!grid) return;
    grid.innerHTML = '';

    App.data.allDivisionNames.forEach(name => {
        const btn = document.createElement('button');
        btn.className = 'text-left rounded-2xl p-3.5 border border-white/[.12] bg-white/[.06] hover:bg-gold/10 hover:border-gold/40 active:bg-gold/15 transition-colors';
        const label = document.createElement('span');
        label.className = 'block text-lg font-bold tracking-tight text-gray-50';
        label.textContent = name;
        btn.appendChild(label);
        btn.onclick = () => enterApp(name);
        grid.appendChild(btn);
    });
}

/** Shows the Gate screen and hides the app shell. */
function showGate() {
    App.state.screen = 'gate';
    document.documentElement.classList.remove('chat-locked');
    document.getElementById('gate-screen')?.classList.remove('hidden');
    document.getElementById('app-screen')?.classList.add('hidden');
    document.getElementById('bottom-tab-bar')?.classList.add('hidden');
}

/** Superadmin shortcut from the Gate to the Setup page (initial configuration). */
function openSettingsFromGate() {
    if (!App.state.isSuperAdmin) return;
    App.state.screen = 'app';
    document.getElementById('gate-screen')?.classList.add('hidden');
    document.getElementById('app-screen')?.classList.remove('hidden');
    document.getElementById('bottom-tab-bar')?.classList.remove('hidden');
    switchView('settings');
}

/**
 * Superadmin shortcut from the Gate to Game Management. The assessment is per
 * division, so enter the last-used (or first) division if none is loaded yet.
 */
async function openGameManagerFromGate() {
    if (!App.state.isSuperAdmin) return;
    const names = App.data.allDivisionNames || [];
    const stored = localStorage.getItem(DIVISION_STORAGE_KEY);
    const division = App.config.currentSheetName || (names.includes(stored) ? stored : names[0]);
    if (!division) return;
    if (App.data.scheduleDivision !== division) {
        await enterApp(division);
    } else {
        App.state.screen = 'app';
        document.getElementById('gate-screen')?.classList.add('hidden');
        document.getElementById('app-screen')?.classList.remove('hidden');
        document.getElementById('bottom-tab-bar')?.classList.remove('hidden');
    }
    switchView('game-manager');
}

/** Returns to the Gate screen from within the app (the header "Change" chip). */
function goToGate() {
    showGate();
}

/**
 * Selects a division and enters the app shell — the target of both a Gate
 * division-card tap and a returning-visitor auto-resume.
 */
async function enterApp(divisionName) {
    App.config.currentSheetName = divisionName;
    localStorage.setItem(DIVISION_STORAGE_KEY, divisionName);

    App.state.screen = 'app';
    document.getElementById('gate-screen')?.classList.add('hidden');
    document.getElementById('app-screen')?.classList.remove('hidden');
    document.getElementById('bottom-tab-bar')?.classList.remove('hidden');

    renderDivisionDropdown();
    await loadData(divisionName);
    watchDivision(divisionName);
}

function renderDivisionDropdown() {
    const headerLabel = document.getElementById('header-division-label');
    if (headerLabel) headerLabel.textContent = App.config.currentSheetName || '—';

    const wrapperDesktop = document.getElementById('division-selector-wrapper');
    const wrapperMobile = document.getElementById('division-selector-wrapper-mobile');
    if (!wrapperDesktop || !wrapperMobile) return;

    wrapperDesktop.innerHTML = '';
    wrapperMobile.innerHTML = '';

    // --- Desktop dropdown ---
    const selectElement = document.createElement('select');
    selectElement.id = 'division-select-desktop';
    selectElement.onchange = handleDivisionChange;
    selectElement.classList.add(
    'p-2', 'bg-[var(--color-maroon-primary)]', 'border', 'border-[var(--color-gold-primary)]',
    'rounded-lg', 'text-[var(--color-gold-light)]', 'shadow-md',
    'focus:border-[var(--color-gold-primary)]', 'focus:ring', 'focus:ring-[var(--color-gold-primary)]/50',
    'transition', 'duration-150', 'ease-in-out', 'font-semibold', 'text-xs', 'md:text-sm'
    );

    App.data.allDivisionNames.forEach(name => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    selectElement.appendChild(option);
    });
    selectElement.value = App.config.currentSheetName;
    wrapperDesktop.appendChild(selectElement);

    // --- Mobile scrollable buttons ---
    const scrollContainer = document.createElement('div');
    scrollContainer.className = `
    flex gap-2 overflow-x-auto py-2 px-1 no-scrollbar
    w-full max-w-full touch-pan-x snap-x snap-mandatory overscroll-behavior: contain
    `;

    const previousScroll = parseFloat(wrapperMobile.dataset.scroll || 0);

    // Get the current loading state
    const isLoading = App.refresh.isLoadingData; 



    App.data.allDivisionNames.forEach(name => {
    const button = document.createElement('button');
    button.textContent = name;
    
    // Set the disabled state
    button.disabled = isLoading; 
    
    // Add a special class for active button detection
    const isActive = name === App.config.currentSheetName;

    // Conditional classes based on active state AND loading state
    let buttonClasses = `
        flex-shrink-0 snap-start
        px-4 py-2 rounded-full text-sm font-semibold whitespace-nowrap
        transition-all duration-150 shadow-sm
    `;
    //make the buttons appear inactive if loading
    if(isLoading) buttonClasses += ' opacity-50 cursor-not-allowed';

    if (isActive) {
        // Active button classes
        buttonClasses += ' bg-[var(--color-gold-light)] text-[var(--color-maroon-dark)] active-division';
        // Add the pulse animation if loading is complete or if it's the *currently active* button after initial load
        if (!isLoading) {
            buttonClasses += ' animate-pulse-once';
        }
    } else {
        // Inactive button classes
        buttonClasses += ' bg-[var(--color-maroon-primary)] text-[var(--color-gold-light)]';
        
        if (isLoading) {
            // Disabled look for inactive buttons
            buttonClasses += ' opacity-50 cursor-not-allowed';
        } else {
            // Hover/Interactive look for inactive buttons
            buttonClasses += ' hover:bg-[var(--color-maroon-light)]';
        }
    }
    
    // If the application is currently loading, add a global loading indicator class
    if (isLoading) {
        buttonClasses += ' animate-pulse'; // A general pulse/spinner for *all* buttons while loading
    }


    button.className = buttonClasses;

    // The onclick function should also check the disabled state, although the disabled attribute usually handles this.
    button.onclick = () => {
        if (button.disabled) return; // Explicit check for safety
        
        if (name !== App.config.currentSheetName) {
        wrapperMobile.dataset.scroll = scrollContainer.scrollLeft;

        App.config.currentSheetName = name;
        localStorage.setItem(DIVISION_STORAGE_KEY, name);
        selectElement.value = name;

        updateSheetInfoDisplay();
        loadData(App.config.currentSheetName);

        // Attach new listener for this division
        watchDivision(App.config.currentSheetName);
        
        // Crucial: Re-render the dropdown immediately to apply the 'disabled' state
        renderDivisionDropdown(); 
        }
    };

    scrollContainer.appendChild(button);
    });

    wrapperMobile.classList.add('w-full', 'overflow-hidden');
    wrapperMobile.appendChild(scrollContainer);

    // --- Restore scroll position AFTER DOM render ---
    requestAnimationFrame(() => {
    scrollContainer.scrollLeft = previousScroll;

    const activeButton = scrollContainer.querySelector('.active-division');

    if (activeButton) {
        // Only center if we don't have a saved scroll position
        if (!previousScroll || previousScroll === 0) {
        activeButton.scrollIntoView({
            behavior: 'smooth',
            inline: 'center',
            block: 'nearest',
        });
        }

        // Brief pulse feedback
        activeButton.classList.add('animate-pulse-once');
        setTimeout(() => activeButton.classList.remove('animate-pulse-once'), 600);
    }
    });

    updateSheetInfoDisplay();
}


/**
 * Handler for when the division dropdown value changes.
 */
function handleDivisionChange(event) {
    const newSheetName = event.target.value;
    
    if (newSheetName && newSheetName !== App.config.currentSheetName) {
        App.config.currentSheetName = newSheetName;
        
        //save the new division to local storage
        localStorage.setItem(DIVISION_STORAGE_KEY, newSheetName);
        const otherSelectId = event.target.id === 'division-select-desktop' ? 'division-select-mobile' : 'division-select-desktop';
        const otherSelect = document.getElementById(otherSelectId);
        if (otherSelect) otherSelect.value = newSheetName;
        
        
        updateSheetInfoDisplay();
        loadData(App.config.currentSheetName);
    }
}

function updateSheetInfoDisplay() {
    // The "last updated" stamp lives at the foot of the INFO tab in the
    // redesign — reset just the timestamp, the label around it is static.
    const el = document.getElementById('last-updated');
    if (el) el.textContent = '…';
}



/**
 * Persisted schedule/admin filter state, per division, in localStorage
 * (`scheduleFilters` → { [division]: { team, court, adminTeam, adminCourt,
 * hideFinished, hidePlayed, subAll } }) so the filters survive a reload.
 * The sub division itself is NOT stored here — it's the shared
 * get/setSelectedSubDivision value (also used by Standings/Playoffs); only
 * the "All sub divisions" choice (`subAll`), which those tabs can't
 * represent, lives here.
 */
const FILTER_STORAGE_KEY = 'scheduleFilters';

function readFilterMap() {
    try {
        return JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY) || '{}');
    } catch {
        return {};
    }
}

function getStoredFilters() {
    return readFilterMap()[App.config.currentSheetName] || {};
}

function saveFilter(key, value) {
    const name = App.config.currentSheetName;
    if (!name) return;
    const map = readFilterMap();
    map[name] = { ...(map[name] || {}), [key]: value };
    try {
        localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(map));
    } catch { /* storage unavailable — filters just won't persist */ }
}

let lastFilterDivision = null;


/**
 * Populates the team and court filter dropdowns for both public and admin views.
 * The passed-in values are the live selections to keep across data refreshes;
 * on first load (and whenever the division changes) the persisted values for
 * the division take over.
 */
function initializeFilter(retainedTeam = 'all', retainedCourt = 'all', retainedAdminTeam = 'all', retainedAdminCourt = 'all') {
    const division = App.config.currentSheetName;
    const divisionChanged = !!division && division !== lastFilterDivision;
    const stored = divisionChanged ? getStoredFilters() : {};
    // Passed values came from a different division on a division switch, so
    // fall back to 'all' there; on the very first load they're still useful
    // (e.g. the court manager's login-court default).
    const fallback = (v) => (lastFilterDivision === null ? v : 'all');

    const filters = [
        { id: 'team-select', key: 'team', retained: stored.team ?? fallback(retainedTeam), type: 'team' },
        { id: 'court-select', key: 'court', retained: stored.court ?? fallback(retainedCourt), type: 'court' },
        { id: 'admin-team-select', key: 'adminTeam', retained: stored.adminTeam ?? fallback(retainedAdminTeam), type: 'team' },
        { id: 'admin-court-select', key: 'adminCourt', retained: stored.adminCourt ?? fallback(retainedAdminCourt), type: 'court' }
    ];

    filters.forEach(filter => {
        const select = document.getElementById(filter.id);
        if (!select) return;

        select.innerHTML = '';
        const allOption = document.createElement('option');
        allOption.value = 'all';
        allOption.textContent = filter.type === 'team' ? 'All teams' : 'All courts';
        select.appendChild(allOption);

        const data = filter.type === 'team' ? App.data.teamNames : App.data.courtNames;

        data.forEach(item => {
            const option = document.createElement('option');
            option.value = item;
            option.textContent = item;
            select.appendChild(option);
        });

        if (data.includes(filter.retained)) {
            select.value = filter.retained;
        } else {
            select.value = 'all';
        }

        if (!select.dataset.persistBound) {
            select.dataset.persistBound = '1';
            select.addEventListener('change', () => saveFilter(filter.key, select.value));
        }
    });

    [
        { id: 'hide-finished-toggle', key: 'hideFinished' },
        { id: 'hide-played-toggle', key: 'hidePlayed' }
    ].forEach(({ id, key }) => {
        const toggle = document.getElementById(id);
        if (!toggle) return;
        if (divisionChanged) toggle.checked = !!stored[key];
        if (!toggle.dataset.persistBound) {
            toggle.dataset.persistBound = '1';
            toggle.addEventListener('change', () => saveFilter(key, toggle.checked));
        }
    });

    if (division) lastFilterDivision = division;

    initializeSubDivisionFilter();
    bindFilterHighlight();
}

const FILTER_SELECT_IDS = ['team-select', 'court-select', 'sub-division-select',
    'admin-team-select', 'admin-court-select', 'admin-sub-division-select'];
const FILTER_TOGGLE_IDS = ['hide-finished-toggle', 'hide-played-toggle'];

/** Highlights every filter that is currently narrowing its list. */
function updateFilterHighlights() {
    FILTER_SELECT_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('filter-active', !!el.value && el.value !== 'all');
    });
    FILTER_TOGGLE_IDS.forEach(id => {
        const el = document.getElementById(id);
        const label = el && el.closest('label');
        if (label) label.classList.toggle('filter-active', el.checked);
    });
}

function bindFilterHighlight() {
    [...FILTER_SELECT_IDS, ...FILTER_TOGGLE_IDS].forEach(id => {
        const el = document.getElementById(id);
        if (el && !el.dataset.highlightBound) {
            el.dataset.highlightBound = '1';
            el.addEventListener('change', updateFilterHighlights);
        }
    });
    updateFilterHighlights();
}

/**
 * Populates (and shows/hides) the sub-division filter dropdowns on the
 * Schedule and Admin views. Only shown when the current division actually
 * has 2+ distinct sub divisions in its schedule data — a v2 tab or a
 * single-pool v3 tab never carries a non-empty `subDivision` value, so the
 * control stays hidden and nothing else about those views changes.
 */
function getSubDivisionNames() {
    // One canonical list for every tab: standings order first (the sheet's
    // configured group order, e.g. Pool A before Pool B), then any names only
    // the schedule knows about. Never sort alphabetically here — Standings,
    // Schedule and Playoffs must all show the same order and the same default.
    const names = new Set();
    const standings = App.data.allStandingsData?.length ? App.data.allStandingsData : (App.data.standings || []);
    standings.forEach(s => { if (s.subDivision) names.add(s.subDivision); });
    (App.data.allScheduleData || []).forEach(g => { if (g.subDivision) names.add(g.subDivision); });
    return [...names];
}

/**
 * Shared, persisted "currently selected sub division" — the Standings and
 * Playoffs tabs both read/write this (instead of each keeping their own
 * module-local variable) so picking a sub division in one tab is reflected
 * in the other immediately, and survives reloads/future visits. Scoped per
 * division (keyed by `App.config.currentSheetName`) so switching divisions
 * doesn't leak one division's selection into another's.
 */
const SUBDIVISION_STORAGE_KEY = 'selectedSubDivision';

function readSubDivisionMap() {
    try {
        return JSON.parse(localStorage.getItem(SUBDIVISION_STORAGE_KEY) || '{}');
    } catch {
        return {};
    }
}

function getSelectedSubDivision() {
    return readSubDivisionMap()[App.config.currentSheetName] || null;
}

/**
 * `auto` marks Standings/Playoffs falling back to a default (nothing valid
 * stored) — that must not cancel a deliberate "All sub divisions" choice on
 * the Schedule/Admin filters.
 */
function setSelectedSubDivision(name, { auto = false } = {}) {
    if (!auto && name) saveFilter('subAll', false);
    const map = readSubDivisionMap();
    if (name) {
        map[App.config.currentSheetName] = name;
    } else {
        delete map[App.config.currentSheetName];
    }
    localStorage.setItem(SUBDIVISION_STORAGE_KEY, JSON.stringify(map));
    syncSubDivisionSelects();
}

/**
 * Points the Schedule sub-division select at the shared (Standings/Playoffs)
 * selection. The Admin select is deliberately independent — it keeps its own
 * persisted `adminSub` filter and is never moved by the Standings toggle.
 */
function syncSubDivisionSelects() {
    const setValue = (id, value) => {
        const select = document.getElementById(id);
        if (!select) return;
        const hasOption = [...select.options].some(o => o.value === value);
        select.value = hasOption ? value : 'all';
    };
    setValue('sub-division-select', getStoredFilters().subAll ? 'all' : (getSelectedSubDivision() || 'all'));
    setValue('admin-sub-division-select', getStoredFilters().adminSub || 'all');
    updateFilterHighlights();
}

function initializeSubDivisionFilter() {
    const subDivisions = getSubDivisionNames();
    const show = subDivisions.length > 1;

    [
        { wrapperId: 'sub-division-select-wrapper', selectId: 'sub-division-select' },
        { wrapperId: 'admin-sub-division-select-wrapper', selectId: 'admin-sub-division-select' }
    ].forEach(({ wrapperId, selectId }) => {
        const wrapper = document.getElementById(wrapperId);
        const select = document.getElementById(selectId);
        if (!wrapper || !select) return;

        wrapper.classList.toggle('hidden', !show);
        if (!show) return;

        select.innerHTML = '';
        const allOption = document.createElement('option');
        allOption.value = 'all';
        allOption.textContent = 'All sub divisions';
        select.appendChild(allOption);
        subDivisions.forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            select.appendChild(option);
        });

        if (!select.dataset.persistBound) {
            select.dataset.persistBound = '1';
            select.addEventListener('change', () => {
                if (selectId === 'admin-sub-division-select') {
                    saveFilter('adminSub', select.value);
                    return;
                }
                if (select.value === 'all') {
                    saveFilter('subAll', true);
                    syncSubDivisionSelects();
                } else {
                    setSelectedSubDivision(select.value);
                }
                // Standings isn't re-rendered on tab switch; keep it in step.
                renderStandings(App.data.allStandingsData);
            });
        }
    });

    syncSubDivisionSelects();
}

/**
 * Toggles between the Standings, Schedule, and Admin views.
 */
function switchView(view) {
    App.state.currentView = view;
    document.documentElement.classList.toggle('chat-locked', view === 'chat');
    //gtag('event', 'switch_view', {
    //                view: view
    //                });
    const views = {
        'standings': document.getElementById('standings-view'),
        'schedule': document.getElementById('schedule-view'),
        'playoffs': document.getElementById('playoffs-view'),
        'info': document.getElementById('info-view'),
        'admin-entry': document.getElementById('admin-match-entry-view'),
        'chat': document.getElementById('chat-view'),
        'settings': document.getElementById('settings-view'),
        'game-manager': document.getElementById('game-manager-view')
    };
    const tabs = {
        'standings': document.getElementById('standings-tab'),
        'schedule': document.getElementById('schedule-tab'),
        'playoffs': document.getElementById('playoffs-tab'),
        'info': document.getElementById('info-tab'),
        'admin-entry': document.getElementById('admin-entry-tab'),
        'chat': document.getElementById('chat-tab')
        // 'settings' has no bottom-tab entry — it's reached via the gear
        // icon on the Admin view and has its own "← Admin" back button.
    };

    Object.keys(views).forEach(v => {
        const tab = tabs[v];
        const viewEl = views[v];
        if (!viewEl) return;

        if (v === view) {
            viewEl.classList.remove('hidden');
            if (tab) {
                tab.classList.add(v === 'admin-entry' || v === 'settings' || v === 'game-manager' ? 'tab-admin-active' : 'tab-active');
                tab.classList.remove(v === 'admin-entry' || v === 'settings' || v === 'game-manager' ? 'tab-active' : 'tab-admin-active');
            }
            // Trigger specific view update
            if (v === 'schedule') updateScheduleView();
            if (v === 'admin-entry') updateAdminMatchEntryView();
            if (v === 'settings') initSettingsView();
            if (v === 'game-manager') renderGameManager();
            if (v === 'chat') onChatTabOpened();
            if (v === 'playoffs') renderPlayoffsView();

        } else {
            viewEl.classList.add('hidden');
            if (tab) {
                tab.classList.remove('tab-active', 'tab-admin-active');
            }
        }
    });
}

export {
    fetchDivisionNames,
    renderDivisionDropdown,
    renderGateDivisions,
    handleDivisionChange,
    initializeFilter,
    getSubDivisionNames,
    getSelectedSubDivision,
    setSelectedSubDivision,
    switchView,
    showGate,
    goToGate,
    openSettingsFromGate,
    openGameManagerFromGate,
    enterApp
};