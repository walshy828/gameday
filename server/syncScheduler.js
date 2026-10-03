// server/syncScheduler.js
// Background auto-sync timer for the Google Sheet -> Store pull sync.
// Backend-agnostic (works for both DATA_BACKEND=firebase and =local) since
// it only talks to sheetsSync.js, which itself goes through the Store
// abstraction. `applySyncSettings` is called once at startup with the
// persisted settings, and again by the POST /api/sheetSync/settings route
// whenever the superadmin changes the toggle/interval, so changes take
// effect immediately without a server restart.
import * as SheetsSync from './sheetsSync.js';
import { broadcastAutoSyncNotice } from './socket.js';

const MIN_INTERVAL_SECONDS = 10;
let timer = null;

// Result-triggered refresh: after match results are reported (and mirrored
// to the sheet), re-pull just those divisions once things go quiet, so the
// sheet's recalculated official results/standings reach the app without
// waiting for the slow interval timer. Debounced so a round's worth of
// near-simultaneous submissions from several courts costs one sync.
const RESULT_SYNC_DELAY_MS = Math.max(Number(process.env.RESULT_SYNC_DELAY_SECONDS) || 45, 5) * 1000;
const pendingDivisions = new Set();
let resultTimer = null;

export function scheduleResultSync(sheetName) {
  if (!sheetName) return;
  pendingDivisions.add(sheetName);
  if (resultTimer) clearTimeout(resultTimer);
  resultTimer = setTimeout(() => {
    resultTimer = null;
    const names = [...pendingDivisions];
    pendingDivisions.clear();
    SheetsSync.syncDivisions(names, 'result').catch(e => console.error('syncScheduler: result sync failed', e));
  }, RESULT_SYNC_DELAY_MS);
}

// Auto-sync switches itself off after AUTO_SYNC_TIMEOUT_HOURS so it can't run
// forever after game day; superadmins get a heads-up AUTO_SYNC_WARNING_MINUTES
// beforehand and a notice when it actually turns off. The deadline is
// persisted (settings.autoSyncExpiresAt) so a server restart doesn't reset it.
const AUTO_SYNC_TIMEOUT_MS = Math.max(Number(process.env.AUTO_SYNC_TIMEOUT_HOURS) || 4, 0.1) * 3600 * 1000;
const AUTO_SYNC_WARNING_MS = Math.max(Number(process.env.AUTO_SYNC_WARNING_MINUTES) || 15, 0) * 60 * 1000;
let expiryTimer = null;
let warningTimer = null;

export function computeAutoSyncExpiry() {
  return Date.now() + AUTO_SYNC_TIMEOUT_MS;
}

function clearExpiryTimers() {
  if (expiryTimer) clearTimeout(expiryTimer);
  if (warningTimer) clearTimeout(warningTimer);
  expiryTimer = warningTimer = null;
}

async function expireAutoSync() {
  clearExpiryTimers();
  try {
    const status = await SheetsSync.updateSettings({ autoSyncEnabled: false, autoSyncExpiresAt: null });
    await applySyncSettings(status.settings);
  } catch (e) {
    console.error('syncScheduler: failed to disable expired auto-sync', e);
  }
  broadcastAutoSyncNotice({
    type: 'expired',
    hours: AUTO_SYNC_TIMEOUT_MS / 3600000,
    message: 'Auto-sync turned itself off after its time limit. Re-enable it in Setup if you still need it.'
  });
}

function scheduleExpiry(expiresAt) {
  clearExpiryTimers();
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) {
    expireAutoSync();
    return;
  }
  expiryTimer = setTimeout(expireAutoSync, remaining);
  const untilWarning = remaining - AUTO_SYNC_WARNING_MS;
  if (AUTO_SYNC_WARNING_MS > 0 && untilWarning > 0) {
    warningTimer = setTimeout(() => {
      warningTimer = null;
      const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60000));
      broadcastAutoSyncNotice({
        type: 'warning',
        expiresAt,
        message: `Auto-sync will turn off in about ${minutes} min. Re-enable it in Setup to keep it running.`
      });
    }, untilWarning);
  }
}

export async function applySyncSettings(settings) {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const enabled = !!(settings && settings.autoSyncEnabled);
  if (!enabled) clearExpiryTimers();
  if (!enabled || !(await SheetsSync.isConfigured())) return;

  // Legacy/manual enable with no deadline yet: start the clock now.
  if (!settings.autoSyncExpiresAt) {
    try {
      const status = await SheetsSync.updateSettings({ autoSyncExpiresAt: computeAutoSyncExpiry() });
      settings = status.settings;
    } catch (e) {
      console.error('syncScheduler: failed to set auto-sync deadline', e);
    }
  }
  if (settings.autoSyncExpiresAt) {
    if (settings.autoSyncExpiresAt <= Date.now()) {
      await expireAutoSync();
      return;
    }
    scheduleExpiry(settings.autoSyncExpiresAt);
  }

  const intervalSeconds = Math.max(Number(settings.intervalSeconds) || 300, MIN_INTERVAL_SECONDS);
  timer = setInterval(() => {
    SheetsSync.syncAll('auto').catch(e => console.error('syncScheduler: auto sync failed', e));
  }, intervalSeconds * 1000);
}

export async function initSyncScheduler() {
  if (!(await SheetsSync.isConfigured())) {
    console.log('syncScheduler: not started (Google Sheets sync not configured).');
    return;
  }
  try {
    const status = await SheetsSync.getStatus();
    
    const needsInitialSync = !status.lastSync || status.lastSync.status !== 'success';
    const autoSyncEnabled = !!(status.settings && status.settings.autoSyncEnabled);

    if (needsInitialSync || autoSyncEnabled) {
      const reason = needsInitialSync ? 'initial run (no previous successful sync)' : 'startup (auto-sync enabled)';
      console.log(`syncScheduler: Triggering immediate sync on ${reason}...`);
      SheetsSync.syncAll('startup').catch(e => {
        console.error('syncScheduler: startup sync failed:', e);
      });
    }

    await applySyncSettings(status.settings);
  } catch (e) {
    console.error('syncScheduler: failed to load initial sync settings', e);
  }
}
