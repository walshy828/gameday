// public/js/settings.js
// Superadmin-only Settings view. Currently holds the Google Sheet Sync
// section: a manual "Sync Now" trigger, an auto-sync interval toggle, and a
// log of recent sync attempts.
//
// Backend-agnostic by design: initial state comes from GET /api/sheetSync/status,
// settings changes go through POST /api/sheetSync/settings, and live updates
// (from this browser or any other, or from the server's own auto-sync timer)
// arrive over the same Socket.IO connection used for the round timer/division
// updates in local mode — 'syncStatusUpdate' is broadcast to every client
// regardless of DATA_BACKEND, so this works the same whether the server is
// running against Firebase or MariaDB.
import { getSheetSyncConfig, getSheetSyncStatus, updateSheetSyncSettings, runSheetSync, pruneSheetSyncDivisions } from './api.js';
import { getSocket } from './socketClient.js';

const PRESET_INTERVALS = [30, 60, 300];

let socketWired = false;
let relativeTimeTicker = null;
let lastSyncTimestamp = null;
let availableDivisions = [];
let currentSettings = null;

function formatRelativeTime(ts) {
    if (!ts) return 'Never';
    const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (diffSec < 5) return 'just now';
    if (diffSec < 60) return `${diffSec}s ago`;
    const min = Math.floor(diffSec / 60);
    if (min < 60) return `${min}m ${diffSec % 60}s ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ${min % 60}m ago`;
    const days = Math.floor(hr / 24);
    return `${days}d ago`;
}

function updateRelativeTimeDisplay() {
    const el = document.getElementById('sync-last-time');
    if (el) el.textContent = formatRelativeTime(lastSyncTimestamp);
}

function startRelativeTimeTicker() {
    if (relativeTimeTicker) return;
    relativeTimeTicker = setInterval(updateRelativeTimeDisplay, 1000);
}

function statusBadge(status) {
    if (status === 'success') return '<span class="px-2 py-0.5 rounded text-xs font-semibold bg-gold text-white">Success</span>';
    if (status === 'error') return '<span class="px-2 py-0.5 rounded text-xs font-semibold bg-red-600 text-white">Error</span>';
    return '<span class="px-2 py-0.5 rounded text-xs font-semibold bg-gray-600 text-white">Unknown</span>';
}

function renderLog(logEntries) {
    const tbody = document.getElementById('sync-log-table-body');
    if (!tbody) return;
    const entries = [...(logEntries || [])].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    if (!entries.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center py-3 text-gray-500">No syncs yet.</td></tr>';
        return;
    }

    tbody.innerHTML = entries.map(entry => {
        const scopeLabel = entry.scope === 'selected' && entry.divisionNames && entry.divisionNames.length
            ? ` (${entry.divisionNames.join(', ')})`
            : '';
        const detail = entry.error
            ? `<span class="text-red-400">${entry.error}</span>`
            : (entry.divisions != null ? `${entry.divisions} divisions${scopeLabel} · ${entry.standingsCount} standings · ${entry.matchesCount} matches` : '—');
        return `
            <tr class="border-t border-gray-800">
                <td class="px-3 py-2 text-sm text-gray-300 whitespace-nowrap">${new Date(entry.timestamp).toLocaleString()}</td>
                <td class="px-3 py-2 text-sm">${statusBadge(entry.status)}</td>
                <td class="px-3 py-2 text-sm text-gray-300 whitespace-nowrap">${entry.durationMs != null ? (entry.durationMs / 1000).toFixed(1) + 's' : '—'}</td>
                <td class="px-3 py-2 text-sm text-gray-300 capitalize">${entry.triggeredBy || '—'}</td>
                <td class="px-3 py-2 text-sm text-gray-400">${detail}</td>
            </tr>
        `;
    }).join('');
}

function highlightIntervalButton(activeSeconds) {
    PRESET_INTERVALS.forEach(seconds => {
        const btn = document.getElementById(`sync-interval-${seconds}`);
        if (!btn) return;
        const active = seconds === activeSeconds;
        btn.classList.toggle('bg-gold', active);
        btn.classList.toggle('text-white', active);
        btn.classList.toggle('bg-gray-700', !active);
        btn.classList.toggle('text-gray-300', !active);
    });

    const customBtn = document.getElementById('sync-interval-custom-btn');
    const customInput = document.getElementById('sync-interval-custom-input');
    const isCustom = !PRESET_INTERVALS.includes(activeSeconds);
    if (customBtn) {
        customBtn.classList.toggle('bg-gold', isCustom);
        customBtn.classList.toggle('text-white', isCustom);
        customBtn.classList.toggle('bg-gray-700', !isCustom);
        customBtn.classList.toggle('text-gray-300', !isCustom);
    }
    if (customInput && document.activeElement !== customInput) {
        customInput.value = isCustom ? activeSeconds : '';
    }
}

function renderDivisionPicker() {
    const picker = document.getElementById('sync-division-picker');
    if (!picker) return;

    const selected = (currentSettings && currentSettings.selectedDivisions) || [];
    if (!availableDivisions.length) {
        picker.innerHTML = '<p class="text-sm text-gray-500">No divisions found in the sheet yet.</p>';
        return;
    }

    picker.innerHTML = availableDivisions.map(name => {
        const checked = selected.includes(name) ? 'checked' : '';
        const safeName = name.replace(/"/g, '&quot;');
        return `
            <label class="flex items-center gap-2 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-300 cursor-pointer">
                <input type="checkbox" value="${safeName}" ${checked} onchange="toggleSyncDivision('${safeName}', this.checked)">
                ${name}
            </label>
        `;
    }).join('');
}

function renderStatus(status) {
    if (!status) return;
    currentSettings = status.settings || null;

    const toggle = document.getElementById('auto-sync-toggle');
    if (toggle) toggle.checked = !!(status.settings && status.settings.autoSyncEnabled);

    const intervalSeconds = Number(status.settings && status.settings.intervalSeconds) || 300;
    highlightIntervalButton(intervalSeconds);

    const intervalControls = document.getElementById('auto-sync-interval-controls');
    if (intervalControls) intervalControls.classList.toggle('opacity-50', !(status.settings && status.settings.autoSyncEnabled));

    const scope = (status.settings && status.settings.syncScope) || 'all';
    const scopeAllRadio = document.getElementById('sync-scope-all');
    const scopeSelectedRadio = document.getElementById('sync-scope-selected');
    if (scopeAllRadio) scopeAllRadio.checked = scope === 'all';
    if (scopeSelectedRadio) scopeSelectedRadio.checked = scope === 'selected';

    const picker = document.getElementById('sync-division-picker');
    if (picker) picker.classList.toggle('hidden', scope !== 'selected');
    renderDivisionPicker();

    lastSyncTimestamp = (status.lastSync && status.lastSync.timestamp) || null;
    updateRelativeTimeDisplay();

    renderLog(status.log);
}

function attachSocketListener() {
    if (socketWired) return;
    try {
        const socket = getSocket();
        socket.on('syncStatusUpdate', renderStatus);
        socketWired = true;
    } catch (e) {
        console.error('Failed to attach sync status socket listener', e);
    }
}

/**
 * Called by switchView('settings') each time the tab is opened. Safe to call
 * repeatedly — the socket listener and time ticker are only wired once.
 */
function initSettingsView() {
    if (!App.state.isSuperAdmin) return;

    startRelativeTimeTicker();
    attachSocketListener();

    const linkEl = document.getElementById('sheet-sync-link');
    const statusEl = document.getElementById('sheet-sync-configured-status');
    const syncBtn = document.getElementById('sync-now-button');
    const authToken = sessionStorage.getItem('adminAuthToken');
    if (!authToken) return;

    getSheetSyncConfig(authToken).then(cfg => {
        if (linkEl) {
            if (cfg.spreadsheetUrl) {
                linkEl.href = cfg.spreadsheetUrl;
                linkEl.classList.remove('hidden');
            } else {
                linkEl.classList.add('hidden');
            }
        }
        if (statusEl) {
            statusEl.textContent = cfg.configured ? 'Connected' : 'Not configured';
            statusEl.className = cfg.configured
                ? 'px-2 py-0.5 rounded text-xs font-semibold bg-gold text-white'
                : 'px-2 py-0.5 rounded text-xs font-semibold bg-gray-600 text-white';
        }
        if (syncBtn) syncBtn.disabled = !cfg.configured;
        const pruneBtn = document.getElementById('prune-divisions-button');
        if (pruneBtn) pruneBtn.disabled = !cfg.configured;

        availableDivisions = Array.isArray(cfg.availableDivisions) ? cfg.availableDivisions : [];
        renderDivisionPicker();
    }).catch(e => {
        console.error('Failed to load sheet sync config', e);
        if (statusEl) {
            statusEl.textContent = 'Error loading status';
            statusEl.className = 'px-2 py-0.5 rounded text-xs font-semibold bg-red-600 text-white';
        }
    });

    getSheetSyncStatus(authToken).then(renderStatus).catch(e => console.error('Failed to load sheet sync status', e));
}

async function syncNow() {
    const btn = document.getElementById('sync-now-button');
    const authToken = sessionStorage.getItem('adminAuthToken');
    if (!authToken) {
        showStatus('Please log in as superadmin.', true);
        return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
    try {
        const result = await runSheetSync(authToken);
        if (result.success) {
            showStatus(`Sync complete: ${result.divisions} divisions, ${result.matchesCount} matches.`, false);
        } else {
            showStatus('Sync failed: ' + (result.error || 'Unknown error'), true);
        }
        setTimeout(() => showStatus(null), 4000);
    } catch (e) {
        console.error('Sync now failed', e);
        showStatus('Sync failed: ' + e.message, true);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔄 Sync Now'; }
    }
}

// Deletes divisions left over from a previously configured SPREADSHEET_ID.
// Destructive, so the first click only arms the button — the second one
// within 5s actually runs it.
let pruneArmed = false;
let pruneArmTimer = null;

async function pruneDivisions() {
    const btn = document.getElementById('prune-divisions-button');
    const authToken = sessionStorage.getItem('adminAuthToken');
    if (!authToken) {
        showStatus('Please log in as superadmin.', true);
        return;
    }

    if (!pruneArmed) {
        pruneArmed = true;
        if (btn) btn.textContent = 'Click again to confirm';
        clearTimeout(pruneArmTimer);
        pruneArmTimer = setTimeout(() => {
            pruneArmed = false;
            if (btn) btn.textContent = '🧹 Remove Stale Divisions';
        }, 5000);
        return;
    }

    clearTimeout(pruneArmTimer);
    pruneArmed = false;
    if (btn) { btn.disabled = true; btn.textContent = 'Removing…'; }
    try {
        const result = await pruneSheetSyncDivisions(authToken);
        if (result.success) {
            showStatus(result.pruned.length
                ? `Removed ${result.pruned.length} stale division(s): ${result.pruned.join(', ')}`
                : 'No stale divisions found — everything matches the current sheet.', false);
            // The division list is built once at bootstrap, so reload to drop
            // the removed divisions from the picker.
            if (result.pruned.length) setTimeout(() => window.location.reload(), 2500);
        } else {
            showStatus('Cleanup failed: ' + (result.error || 'Unknown error'), true);
        }
        setTimeout(() => showStatus(null), 5000);
    } catch (e) {
        console.error('Prune divisions failed', e);
        showStatus('Cleanup failed: ' + e.message, true);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🧹 Remove Stale Divisions'; }
    }
}

async function persistSettings(patch) {
    const authToken = sessionStorage.getItem('adminAuthToken');
    if (!authToken) {
        showStatus('Please log in as superadmin.', true);
        return;
    }
    try {
        const status = await updateSheetSyncSettings(authToken, patch);
        renderStatus(status);
    } catch (e) {
        console.error('Failed to update sync settings', e);
        showStatus('Failed to update auto-sync settings: ' + e.message, true);
        setTimeout(() => showStatus(null), 4000);
    }
}

function toggleAutoSync(checked) {
    persistSettings({ autoSyncEnabled: !!checked });
}

function setSyncInterval(seconds) {
    const value = Math.max(Number(seconds) || 0, 10);
    persistSettings({ intervalSeconds: value });
}

function setCustomSyncInterval() {
    const input = document.getElementById('sync-interval-custom-input');
    if (!input) return;
    const seconds = parseInt(input.value, 10);
    if (!seconds || seconds < 10) {
        showStatus('Custom interval must be at least 10 seconds.', true);
        setTimeout(() => showStatus(null), 3000);
        return;
    }
    setSyncInterval(seconds);
}

function setSyncScope(scope) {
    if (scope !== 'all' && scope !== 'selected') return;
    const picker = document.getElementById('sync-division-picker');
    if (picker) picker.classList.toggle('hidden', scope !== 'selected');
    persistSettings({ syncScope: scope });
}

function toggleSyncDivision(name, checked) {
    const current = (currentSettings && currentSettings.selectedDivisions) || [];
    const next = checked
        ? [...new Set([...current, name])]
        : current.filter(d => d !== name);
    persistSettings({ selectedDivisions: next });
}

export {
    initSettingsView,
    syncNow,
    pruneDivisions,
    toggleAutoSync,
    setSyncInterval,
    setCustomSyncInterval,
    setSyncScope,
    toggleSyncDivision
};
