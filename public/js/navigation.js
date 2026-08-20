import { getDivisions } from './api.js';
import { initSettingsView } from './settings.js';
import { onChatTabOpened } from './chat.js';
import { renderLiveView } from './live.js';

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
    showStatus('Failed to load divisions: ' + error.message, true);
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
        btn.className = 'text-left rounded-2xl p-3.5 border border-white/[.12] bg-white/[.06] hover:bg-white/10 transition-colors';
        btn.innerHTML = `<span class="block text-lg font-bold tracking-tight text-gray-50">${name}</span>`;
        btn.onclick = () => enterApp(name);
        grid.appendChild(btn);
    });
}

/** Shows the Gate screen and hides the app shell. */
function showGate() {
    App.state.screen = 'gate';
    document.getElementById('gate-screen')?.classList.remove('hidden');
    document.getElementById('app-screen')?.classList.add('hidden');
    document.getElementById('bottom-tab-bar')?.classList.add('hidden');
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
 * Populates the team and court filter dropdowns for both public and admin views.
 */
function initializeFilter(retainedTeam = 'all', retainedCourt = 'all', retainedAdminTeam = 'all', retainedAdminCourt = 'all') {
    const filters = [
        { id: 'team-select', retained: retainedTeam, type: 'team' },
        { id: 'court-select', retained: retainedCourt, type: 'court' },
        { id: 'admin-team-select', retained: retainedAdminTeam, type: 'team' },
        { id: 'admin-court-select', retained: retainedAdminCourt, type: 'court' }
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
    });
}

/**
 * Toggles between the Standings, Schedule, and Admin views.
 */
function switchView(view) {
    App.state.currentView = view;
    //gtag('event', 'switch_view', {
    //                view: view
    //                });
    const views = {
        'live': document.getElementById('live-view'),
        'standings': document.getElementById('standings-view'),
        'schedule': document.getElementById('schedule-view'),
        'info': document.getElementById('info-view'),
        'admin-entry': document.getElementById('admin-match-entry-view'),
        'chat': document.getElementById('chat-view'),
        'settings': document.getElementById('settings-view')
    };
    const tabs = {
        'live': document.getElementById('live-tab'),
        'standings': document.getElementById('standings-tab'),
        'schedule': document.getElementById('schedule-tab'),
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
                tab.classList.add(v === 'admin-entry' || v === 'settings' ? 'tab-admin-active' : 'tab-active');
                tab.classList.remove(v === 'admin-entry' || v === 'settings' ? 'tab-active' : 'tab-admin-active');
            }
            // Trigger specific view update
            if (v === 'schedule') updateScheduleView();
            if (v === 'admin-entry') updateAdminMatchEntryView();
            if (v === 'settings') initSettingsView();
            if (v === 'chat') onChatTabOpened();
            if (v === 'live') renderLiveView();

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
    switchView,
    showGate,
    goToGate,
    enterApp
};