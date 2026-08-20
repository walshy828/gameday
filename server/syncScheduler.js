// server/syncScheduler.js
// Background auto-sync timer for the Google Sheet -> Store pull sync.
// Backend-agnostic (works for both DATA_BACKEND=firebase and =local) since
// it only talks to sheetsSync.js, which itself goes through the Store
// abstraction. `applySyncSettings` is called once at startup with the
// persisted settings, and again by the POST /api/sheetSync/settings route
// whenever the superadmin changes the toggle/interval, so changes take
// effect immediately without a server restart.
import * as SheetsSync from './sheetsSync.js';

const MIN_INTERVAL_SECONDS = 10;
let timer = null;

export function applySyncSettings(settings) {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const enabled = !!(settings && settings.autoSyncEnabled);
  if (!enabled || !SheetsSync.isConfigured()) return;

  const intervalSeconds = Math.max(Number(settings.intervalSeconds) || 300, MIN_INTERVAL_SECONDS);
  timer = setInterval(() => {
    SheetsSync.syncAll('auto').catch(e => console.error('syncScheduler: auto sync failed', e));
  }, intervalSeconds * 1000);
}

export async function initSyncScheduler() {
  if (!SheetsSync.isConfigured()) {
    console.log('syncScheduler: not started (Google Sheets sync not configured).');
    return;
  }
  try {
    const status = await SheetsSync.getStatus();
    applySyncSettings(status.settings);
  } catch (e) {
    console.error('syncScheduler: failed to load initial sync settings', e);
  }
}
