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
import { getSheetSyncConfig, getSheetSyncStatus, updateSheetSyncSettings, updateFeatureSettings, runSheetSync, pruneSheetSyncDivisions, getActiveSessions, getLoginHistory } from './api.js';
import { getSocket } from './socketClient.js';
import { setCheckinEnabled } from './roster.js';

const PRESET_INTERVALS = [30, 60, 300];
const SESSIONS_POLL_INTERVAL_MS = 15000;
const SYNC_LOG_PAGE_SIZE = 10;
const ROLE_LABELS = { admin: 'Referee', superadmin: 'Tournament Admin', parent: 'Parent' };

let socketWired = false;
let relativeTimeTicker = null;
let lastSyncTimestamp = null;
let availableDivisions = [];
let currentSettings = null;
let sessionsPollTimer = null;
let syncLogEntries = [];
let syncLogShown = SYNC_LOG_PAGE_SIZE;
let lastSessions = [];
let showInactiveUsers = false;
let autoSyncExpiresAt = null;

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

function formatTimeLeft(ms) {
    const min = Math.max(0, Math.ceil(ms / 60000));
    if (min < 60) return `${min}m`;
    return `${Math.floor(min / 60)}h ${min % 60}m`;
}

function updateAutoSyncChip(enabled = !!autoSyncExpiresAt) {
    const chip = document.getElementById('auto-sync-chip');
    const note = document.getElementById('auto-sync-expiry-note');
    if (chip) {
        chip.classList.toggle('hidden', !enabled);
        const soon = autoSyncExpiresAt && autoSyncExpiresAt - Date.now() < 15 * 60000;
        chip.classList.toggle('bg-yellow-600', !!soon);
        chip.classList.toggle('bg-green-600', !soon);
        chip.textContent = autoSyncExpiresAt
            ? `Auto-sync on · off in ${formatTimeLeft(autoSyncExpiresAt - Date.now())}`
            : 'Auto-sync on';
    }
    if (note && enabled && autoSyncExpiresAt) {
        note.textContent = `Turns off automatically at ${new Date(autoSyncExpiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} (${formatTimeLeft(autoSyncExpiresAt - Date.now())} left). Toggle off and on to restart the clock.`;
    }
}

function updateRelativeTimeDisplay() {
    const el = document.getElementById('sync-last-time');
    if (el) el.textContent = formatRelativeTime(lastSyncTimestamp);
    if (autoSyncExpiresAt) updateAutoSyncChip(true);
}

function startRelativeTimeTicker() {
    if (relativeTimeTicker) return;
    relativeTimeTicker = setInterval(updateRelativeTimeDisplay, 1000);
}

const STATUS_ICONS = {
    success: { label: 'Success', color: 'text-green-500', path: 'M5 13l4 4L19 7' },
    partial: { label: 'Partial success', color: 'text-yellow-500', path: 'M12 9v4m0 4h.01M10.3 4.3L2.6 17.6A2 2 0 004.3 20.6h15.4a2 2 0 001.7-3L13.7 4.3a2 2 0 00-3.4 0z' },
    error: { label: 'Error', color: 'text-red-500', path: 'M6 6l12 12M18 6L6 18' },
    unknown: { label: 'Unknown status', color: 'text-gray-500', path: 'M9.5 9a2.5 2.5 0 115 0c0 1.5-2.5 2-2.5 3.5M12 17h.01' }
};

function escapeHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Icon-only status; the title tooltip carries the label plus any error/failed-tab detail.
function statusBadge(status, detail) {
    const icon = STATUS_ICONS[status] || STATUS_ICONS.unknown;
    const tip = escapeAttr(detail ? `${icon.label}: ${detail}` : icon.label);
    return `<span class="inline-flex ${icon.color}" title="${tip}" aria-label="${tip}" role="img">` +
        `<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="${icon.path}"/></svg></span>`;
}

function renderLog(logEntries) {
    if (logEntries) syncLogEntries = [...logEntries].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const tbody = document.getElementById('sync-log-table-body');
    if (!tbody) return;
    const entries = syncLogEntries.slice(0, syncLogShown);

    const countEl = document.getElementById('sync-log-count');
    const moreBtn = document.getElementById('sync-log-more');
    if (countEl) countEl.textContent = syncLogEntries.length ? `Showing ${entries.length} of ${syncLogEntries.length}` : '';
    if (moreBtn) moreBtn.classList.toggle('hidden', syncLogShown >= syncLogEntries.length);

    if (!entries.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center py-3 text-gray-500">No syncs yet.</td></tr>';
        return;
    }

    tbody.innerHTML = entries.map(entry => {
        const scopeLabel = entry.scope === 'selected' && entry.divisionNames && entry.divisionNames.length
            ? ` (${escapeHtml(entry.divisionNames.join(', '))})`
            : '';
        const failedLabel = entry.failedTabs && entry.failedTabs.length
            ? `<br><span class="text-red-400">Failed: ${entry.failedTabs.map(f => `${escapeHtml(f.name)} (${escapeHtml(f.error)})`).join(', ')}</span>`
            : '';
        const detail = entry.error
            ? `<span class="text-red-400">${escapeHtml(entry.error)}</span>${failedLabel}`
            : (entry.divisions != null ? `${entry.divisions} divisions${scopeLabel} · ${entry.standingsCount} standings · ${entry.matchesCount} matches${failedLabel}` : '—');
        return `
            <tr class="border-t border-gray-800">
                <td class="px-3 py-2 text-sm text-gray-300 whitespace-nowrap">${new Date(entry.timestamp).toLocaleString()}</td>
                <td class="px-3 py-2 text-sm">${statusBadge(entry.status, [entry.error, ...(entry.failedTabs || []).map(f => `${f.name} (${f.error})`)].filter(Boolean).join('; '))}</td>
                <td class="px-3 py-2 text-sm text-gray-300 whitespace-nowrap">${entry.durationMs != null ? (entry.durationMs / 1000).toFixed(1) + 's' : '—'}</td>
                <td class="px-3 py-2 text-sm text-gray-300 capitalize">${escapeHtml(entry.triggeredBy || '—')}</td>
                <td class="px-3 py-2 text-sm text-gray-400">${detail}</td>
            </tr>
        `;
    }).join('');
}

function deviceLabel(session) {
    const parts = [session.device, session.os, session.browser].filter(Boolean);
    return parts.length ? parts.join(' · ') : '—';
}

function renderActiveSessions(sessions) {
    if (sessions) lastSessions = sessions;
    const tbody = document.getElementById('active-sessions-table-body');
    if (!tbody) return;
    const all = [...lastSessions].sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
    const inactiveCount = all.filter(s => !s.online).length;
    const list = showInactiveUsers ? all : all.filter(s => s.online);

    const toggleBtn = document.getElementById('inactive-users-toggle');
    if (toggleBtn) {
        toggleBtn.classList.toggle('hidden', inactiveCount === 0);
        toggleBtn.textContent = showInactiveUsers ? 'Hide inactive' : `Show inactive (${inactiveCount})`;
    }

    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center py-3 text-gray-500">${inactiveCount ? 'No one active right now.' : 'No one signed in.'}</td></tr>`;
        return;
    }

    tbody.innerHTML = list.map(s => {
        const dot = s.online
            ? '<span class="inline-block w-2 h-2 rounded-full" style="background:#22c55e" title="Online"></span>'
            : '<span class="inline-block w-2 h-2 rounded-full" style="background:#eab308" title="Offline"></span>';
        return `
            <tr class="border-t border-gray-800">
                <td class="px-3 py-2 text-sm">${dot}</td>
                <td class="px-3 py-2 text-sm text-gray-200">${escapeHtml(s.name || '—')}</td>
                <td class="px-3 py-2 text-sm text-gray-300">${escapeHtml(ROLE_LABELS[s.role] || s.role)}</td>
                <td class="px-3 py-2 text-sm text-gray-300">${s.court ? escapeHtml('Court ' + s.court) : '—'}</td>
                <td class="px-3 py-2 text-sm text-gray-400 whitespace-nowrap">${escapeHtml(deviceLabel(s))}</td>
                <td class="px-3 py-2 text-sm text-gray-400 whitespace-nowrap">${escapeHtml(s.ip || '—')}</td>
                <td class="px-3 py-2 text-sm text-gray-400 whitespace-nowrap">${formatRelativeTime(s.lastActivityAt)}</td>
            </tr>
        `;
    }).join('');
}

function renderSessionHistory(history) {
    const tbody = document.getElementById('session-history-table-body');
    if (!tbody) return;
    const list = [...(history || [])].sort((a, b) => (b.loginAt || 0) - (a.loginAt || 0));

    if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center py-3 text-gray-500">No sign-ins yet.</td></tr>';
        return;
    }

    tbody.innerHTML = list.map(s => {
        const statusLabel = s.active
            ? '<span class="px-2 py-0.5 rounded text-xs font-semibold bg-green-600 text-white">Active</span>'
            : '<span class="px-2 py-0.5 rounded text-xs font-semibold bg-gray-600 text-white">Ended</span>';
        const durationLabel = s.logoutAt
            ? `${Math.max(0, Math.round((s.logoutAt - s.loginAt) / 60000))}m`
            : '—';
        return `
            <tr class="border-t border-gray-800">
                <td class="px-3 py-2 text-sm text-gray-300 whitespace-nowrap">${new Date(s.loginAt).toLocaleString()}</td>
                <td class="px-3 py-2 text-sm text-gray-200">${escapeHtml(s.name || '—')}</td>
                <td class="px-3 py-2 text-sm text-gray-300">${escapeHtml(ROLE_LABELS[s.role] || s.role)}</td>
                <td class="px-3 py-2 text-sm text-gray-300">${s.court ? escapeHtml('Court ' + s.court) : '—'}</td>
                <td class="px-3 py-2 text-sm text-gray-400 whitespace-nowrap">${escapeHtml(deviceLabel(s))}</td>
                <td class="px-3 py-2 text-sm text-gray-400 whitespace-nowrap">${escapeHtml(s.ip || '—')}</td>
                <td class="px-3 py-2 text-sm">${statusLabel}${s.logoutAt ? ` <span class="text-gray-500">(${durationLabel})</span>` : ''}</td>
            </tr>
        `;
    }).join('');
}

function refreshActiveSessions() {
    const authToken = sessionStorage.getItem('adminAuthToken');
    if (!authToken || !App.state.isSuperAdmin) return;
    getActiveSessions(authToken).then(renderActiveSessions).catch(e => console.error('Failed to load active sessions', e));
}

function refreshSessionHistory() {
    const authToken = sessionStorage.getItem('adminAuthToken');
    if (!authToken || !App.state.isSuperAdmin) return;
    getLoginHistory(authToken).then(renderSessionHistory).catch(e => console.error('Failed to load session history', e));
}

function startSessionsPoller() {
    if (sessionsPollTimer) return;
    sessionsPollTimer = setInterval(refreshActiveSessions, SESSIONS_POLL_INTERVAL_MS);
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
        const safeName = escapeAttr(name).replace(/'/g, '&#39;');
        return `
            <label class="flex items-center gap-2 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-300 cursor-pointer">
                <input type="checkbox" value="${safeName}" ${checked} onchange="toggleSyncDivision(this.value, this.checked)">
                ${escapeHtml(name)}
            </label>
        `;
    }).join('');
}

function renderStatus(status) {
    if (!status) return;
    currentSettings = status.settings || null;

    const toggle = document.getElementById('auto-sync-toggle');
    if (toggle) toggle.checked = !!(status.settings && status.settings.autoSyncEnabled);

    autoSyncExpiresAt = (status.settings && status.settings.autoSyncEnabled && status.settings.autoSyncExpiresAt) || null;
    updateAutoSyncChip(!!(status.settings && status.settings.autoSyncEnabled));

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

    const sheetIdInput = document.getElementById('google-sheet-id-input');
    if (sheetIdInput && document.activeElement !== sheetIdInput) {
        sheetIdInput.value = (status.settings && status.settings.googleSheetId) || '';
    }

    lastSyncTimestamp = (status.lastSync && status.lastSync.timestamp) || null;
    updateRelativeTimeDisplay();

    renderLog(status.log);
}

function renderFeatureSettings(settings) {
    if (!settings) return;
    App.settings = App.settings || {};
    App.settings.championCelebrationEnabled = settings.championCelebrationEnabled !== false;
    App.settings.autoUpdateOfficialResultsEnabled = settings.autoUpdateOfficialResultsEnabled === true;

    const toggle = document.getElementById('champion-celebration-toggle');
    if (toggle) toggle.checked = App.settings.championCelebrationEnabled;

    App.settings.checkinEnabled = settings.checkinEnabled === true;
    setCheckinEnabled(App.settings.checkinEnabled);
    const checkinToggle = document.getElementById('checkin-toggle');
    if (checkinToggle) checkinToggle.checked = App.settings.checkinEnabled;

    const officialResultsToggle = document.getElementById('auto-update-official-results-toggle');
    if (officialResultsToggle) officialResultsToggle.checked = App.settings.autoUpdateOfficialResultsEnabled;
}

// Heads-up (and final notice) that auto-sync is about to switch / has switched
// itself off. Only superadmins see it; it stays up until dismissed by the next
// status message, and also fires a browser notification when permitted.
function handleAutoSyncNotice(notice) {
    if (!App.state.isSuperAdmin || !notice) return;
    showStatus(notice.message, notice.type === 'expired');
    setTimeout(() => showStatus(null), 15000);
    try {
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('Dodgeball Tracker', { body: notice.message });
        }
    } catch (e) { /* notifications are best-effort */ }
}

function attachSocketListener() {
    if (socketWired) return;
    try {
        const socket = getSocket();
        socket.on('syncStatusUpdate', renderStatus);
        socket.on('featureSettingsUpdate', renderFeatureSettings);
        socket.on('autoSyncNotice', handleAutoSyncNotice);
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
    renderFeatureSettings(App.settings);
    const prefSelect = document.getElementById('discrepancy-pref-select');
    if (prefSelect && window.getDiscrepancyPref) prefSelect.value = window.getDiscrepancyPref();
    startSessionsPoller();
    refreshActiveSessions();
    refreshSessionHistory();

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
            statusEl.textContent = cfg.configured ? '✓ Connected' : '✗ Not connected';
            statusEl.className = cfg.configured
                ? 'px-2 py-0.5 rounded text-xs font-semibold bg-green-600 text-white'
                : 'px-2 py-0.5 rounded text-xs font-semibold bg-red-600 text-white';
        }
        if (syncBtn) syncBtn.disabled = !cfg.configured;
        const pruneBtn = document.getElementById('prune-divisions-button');
        if (pruneBtn) pruneBtn.disabled = !cfg.configured;

        availableDivisions = Array.isArray(cfg.availableDivisions) ? cfg.availableDivisions : [];
        renderDivisionPicker();
    }).catch(e => {
        console.error('Failed to load sheet sync config', e);
        if (statusEl) {
            statusEl.textContent = '✗ Error loading status';
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

/**
 * Saves the superadmin-configured Google Sheet ID (Settings page). This
 * overrides the SPREADSHEET_ID .env default for all sync/mirror operations
 * — see getEffectiveSpreadsheetId() in server/sheetsSync.js. Reloads the
 * page's sheet-sync config afterward so the "Open Google Sheet" link and
 * available-divisions list reflect the new sheet immediately.
 */
async function saveGoogleSheetId() {
    const input = document.getElementById('google-sheet-id-input');
    const btn = document.getElementById('save-sheet-id-button');
    const authToken = sessionStorage.getItem('adminAuthToken');
    if (!authToken) {
        showStatus('Please log in as superadmin.', true);
        return;
    }
    const value = (input?.value || '').trim();
    if (!value) {
        showStatus('Enter a Google Sheet ID first.', true);
        setTimeout(() => showStatus(null), 3000);
        return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
        await updateSheetSyncSettings(authToken, { googleSheetId: value });
        showStatus('Google Sheet ID saved.', false);
        setTimeout(() => showStatus(null), 3000);
        // Re-check configured/available-divisions status against the new sheet.
        initSettingsView();
    } catch (e) {
        console.error('Failed to save Google Sheet ID', e);
        showStatus('Failed to save Google Sheet ID: ' + e.message, true);
        setTimeout(() => showStatus(null), 4000);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    }
}

async function toggleChampionCelebration(checked) {
    const authToken = sessionStorage.getItem('adminAuthToken');
    if (!authToken) {
        showStatus('Please log in as superadmin.', true);
        return;
    }
    try {
        const settings = await updateFeatureSettings(authToken, { championCelebrationEnabled: !!checked });
        renderFeatureSettings(settings);
    } catch (e) {
        console.error('Failed to update champion celebration setting', e);
        showStatus('Failed to update champion celebration setting: ' + e.message, true);
        setTimeout(() => showStatus(null), 4000);
    }
}

async function toggleAutoUpdateOfficialResults(checked) {
    const authToken = sessionStorage.getItem('adminAuthToken');
    if (!authToken) {
        showStatus('Please log in as superadmin.', true);
        return;
    }
    try {
        const settings = await updateFeatureSettings(authToken, { autoUpdateOfficialResultsEnabled: !!checked });
        renderFeatureSettings(settings);
    } catch (e) {
        console.error('Failed to update auto-update official results setting', e);
        showStatus('Failed to update auto-update official results setting: ' + e.message, true);
        setTimeout(() => showStatus(null), 4000);
    }
}

async function toggleCheckin(checked) {
    const authToken = sessionStorage.getItem('adminAuthToken');
    if (!authToken) {
        showStatus('Please log in as superadmin.', true);
        return;
    }
    try {
        const settings = await updateFeatureSettings(authToken, { checkinEnabled: !!checked });
        renderFeatureSettings(settings);
    } catch (e) {
        console.error('Failed to update check-in setting', e);
        const toggle = document.getElementById('checkin-toggle');
        if (toggle) toggle.checked = !checked;
        showStatus('Failed to update check-in setting: ' + e.message, true);
        setTimeout(() => showStatus(null), 4000);
    }
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

/** Generic "show more" disclosure: button's data-target is the panel id. */
function toggleSetupPanel(btn) {
    const panel = document.getElementById(btn.dataset.target);
    if (!panel) return;
    const open = panel.classList.toggle('hidden') === false;
    btn.classList.toggle('open', open);
    if (btn.dataset.target === 'sync-history-panel') {
        syncLogShown = SYNC_LOG_PAGE_SIZE;
        renderLog();
    }
}

function loadMoreSyncLog() {
    syncLogShown += SYNC_LOG_PAGE_SIZE;
    renderLog();
}

function toggleInactiveUsers() {
    showInactiveUsers = !showInactiveUsers;
    renderActiveSessions();
}

export {
    initSettingsView,
    toggleSetupPanel,
    loadMoreSyncLog,
    toggleInactiveUsers,
    syncNow,
    pruneDivisions,
    toggleAutoSync,
    toggleChampionCelebration,
    toggleAutoUpdateOfficialResults,
    toggleCheckin,
    setSyncInterval,
    setCustomSyncInterval,
    setSyncScope,
    toggleSyncDivision,
    saveGoogleSheetId,
    refreshActiveSessions,
    refreshSessionHistory
};
