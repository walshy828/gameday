// server/sheetsSync.js
// Pulls standings + schedule data FROM the Google Sheet (the document of
// record) INTO the active data backend (Firebase RTDB or MariaDB, via the
// Store abstraction — see server/datastores/index.js) so it works the same
// way regardless of DATA_BACKEND. This is the inverse of sheetsMirror.js,
// which only pushes match results the other way. Used by the superadmin
// Settings page ("Sync Now" / auto-sync) — see server/syncScheduler.js for
// the background interval and server/index.js for the /api/sheetSync/*
// routes.
import dotenv from 'dotenv';
import { google } from 'googleapis';
import { Store } from './datastores/index.js';
import { readTabData } from './sheetConfig.js';
dotenv.config();

let jwtClient = null;
let sheetsApi = null;
if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
  try {
    jwtClient = new google.auth.JWT({
      email: process.env.GOOGLE_CLIENT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/drive.readonly']
    });
    sheetsApi = google.sheets({ version: 'v4', auth: jwtClient });
  } catch (e) {
    console.warn('sheetsSync: Google Sheets client not initialized:', e.message || e);
    jwtClient = null;
    sheetsApi = null;
  }
}

/**
 * The spreadsheet ID to sync against: the superadmin's configured value in
 * Settings (`googleSheetId`) when set, otherwise the `.env` default. Read
 * fresh each time (not cached at module load) so a Settings change takes
 * effect on the very next sync without a server restart.
 */
export async function getEffectiveSpreadsheetId() {
  try {
    const { settings } = await Store.getSyncStatus();
    return settings.googleSheetId || process.env.SPREADSHEET_ID || null;
  } catch (e) {
    return process.env.SPREADSHEET_ID || null;
  }
}

export async function isConfigured() {
  if (!sheetsApi || !jwtClient) return false;
  return !!(await getEffectiveSpreadsheetId());
}

export async function getSpreadsheetUrl() {
  const id = await getEffectiveSpreadsheetId();
  return id ? `https://docs.google.com/spreadsheets/d/${id}/edit` : null;
}

/**
 * List every visible division tab in the sheet (used to populate the
 * "Selected Divisions" picker in the Settings page and to resolve which
 * tabs "all" actually means at sync time).
 */
export async function getAvailableDivisions() {
  if (!(await isConfigured())) return [];
  await jwtClient.authorize();
  const spreadsheetId = await getEffectiveSpreadsheetId();
  const meta = await sheetsApi.spreadsheets.get({ spreadsheetId });
  return (meta.data.sheets || [])
    .filter(s => !s.properties.hidden)
    .map(s => s.properties.title);
}

// Tab order changes rarely and /api/divisions is hit on every page load, so
// the sheet's tab order is cached briefly rather than fetched per request.
const TAB_ORDER_TTL_MS = 60 * 1000;
let tabOrderCache = { at: 0, titles: [] };

/**
 * Sort division names into the order their tabs appear in the Google
 * workbook. Names not found in the sheet (or all names, if the sheet isn't
 * configured/reachable) keep their incoming order after the ones that are.
 */
export async function orderDivisionsBySheet(names) {
  try {
    if (Date.now() - tabOrderCache.at > TAB_ORDER_TTL_MS) {
      tabOrderCache = { at: Date.now(), titles: await getAvailableDivisions() };
    }
  } catch (e) {
    console.error('orderDivisionsBySheet: could not read sheet tab order', e.message || e);
    return names;
  }
  const rank = new Map(tabOrderCache.titles.map((t, i) => [t, i]));
  return [...names].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity));
}

/**
 * Pull division tabs from the sheet and write standings + schedule into the
 * active Store backend. Which tabs get synced is driven by the persisted
 * sync settings (Store.getSyncStatus().settings): 'all' visible tabs, or
 * just the ones listed in `selectedDivisions` when scope is 'selected' —
 * this lets a superadmin limit auto-sync/"Sync Now" to only the
 * division(s) actively playing instead of pulling the whole sheet.
 */
// Syncs (timer, "Sync Now", post-save refresh, startup) all rewrite the same
// store rows, so they run one at a time — an overlapping pair could otherwise
// have the older read land last and overwrite fresher data. Callers queue
// behind whatever is running; background 'auto' ticks are simply skipped when
// busy since another tick is coming anyway.
let syncChain = Promise.resolve();
let pendingSyncs = 0;
function exclusive(fn) {
  pendingSyncs += 1;
  const run = syncChain.then(fn).finally(() => { pendingSyncs -= 1; });
  syncChain = run.catch(() => {});
  return run;
}

export function syncAll(triggeredBy = 'manual') {
  if (triggeredBy === 'auto' && pendingSyncs > 0) {
    return Promise.resolve({ success: false, skipped: true, error: 'A sync is already running.' });
  }
  return exclusive(() => runSyncAll(triggeredBy));
}

/**
 * Re-pull just the given division tabs (e.g. the ones that just had results
 * reported) instead of every tab in scope — a fraction of the Sheets reads.
 * Ignores the Settings sync scope: a division someone is reporting into is
 * by definition in play.
 */
export function syncDivisions(names, triggeredBy = 'result') {
  return exclusive(() => runSyncDivisions(names, triggeredBy));
}

async function runSyncDivisions(names, triggeredBy) {
  const startedAt = Date.now();
  if (!(await isConfigured())) {
    return { success: false, error: 'Google Sheets sync not configured.' };
  }
  try {
    const spreadsheetId = await getEffectiveSpreadsheetId();
    const divisionNames = [...new Set(names || [])].filter(Boolean);
    const { standingsCount, matchesCount, legacyTabs, failedTabs, syncedCount } = await syncTabs(spreadsheetId, divisionNames);
    return recordResult({
      success: syncedCount > 0, triggeredBy, startedAt, scope: 'selected', divisionNames,
      divisions: syncedCount, standingsCount, matchesCount, legacyTabs, failedTabs,
      ...(failedTabs.length && !syncedCount ? { error: 'All divisions failed to sync — see failedTabs.' } : {})
    });
  } catch (e) {
    console.error('sheetsSync.syncDivisions failed', e);
    return recordResult({ success: false, error: e.toString(), triggeredBy, startedAt });
  }
}

/**
 * One malformed/incompatible tab (a non-division utility sheet, a one-off API
 * hiccup, ...) must not take the rest down with it — each tab's read+write
 * is isolated.
 */
async function syncTabs(spreadsheetId, divisionNames) {
  let standingsCount = 0;
  let matchesCount = 0;
  const legacyTabs = [];
  const failedTabs = [];
  let syncedCount = 0;
  for (const name of divisionNames) {
    try {
      const { standings, schedule, legacy, config } = await readTabData(sheetsApi, spreadsheetId, name);
      await Store.writeDivisionData(name, { standings, schedule, scheduleConfig: config });
      standingsCount += standings.length;
      matchesCount += schedule.length;
      syncedCount += 1;
      if (legacy) legacyTabs.push(name);
    } catch (e) {
      console.error(`sheetsSync: failed to sync tab "${name}"`, e);
      failedTabs.push({ name, error: e.message || e.toString() });
    }
  }
  return { standingsCount, matchesCount, legacyTabs, failedTabs, syncedCount };
}

async function runSyncAll(triggeredBy) {
  const startedAt = Date.now();
  if (!(await isConfigured())) {
    return recordResult({ success: false, error: 'Google Sheets sync not configured.', triggeredBy, startedAt });
  }
  try {
    const spreadsheetId = await getEffectiveSpreadsheetId();
    const { settings } = await Store.getSyncStatus();
    const allDivisionNames = await getAvailableDivisions();

    // Spreadsheet swap: the configured sheet ID no longer matches the sheet
    // the stored divisions came from, so anything not a tab in the new sheet
    // is left over from the old one and gets deleted. Only prune when the
    // new sheet actually returned tabs — an empty list means an API/permission
    // problem, and wiping every division over that would be destructive.
    let pruned = [];
    if (settings.spreadsheetId !== spreadsheetId && allDivisionNames.length) {
      if (settings.spreadsheetId) {
        pruned = await Store.pruneDivisions(allDivisionNames);
        if (pruned.length) {
          console.log(`sheetsSync: spreadsheet changed — removed ${pruned.length} division(s) from the previous sheet: ${pruned.join(', ')}`);
        }
      }
      // Drop any selected-division picks that only existed in the old sheet,
      // otherwise a 'selected' scope can end up matching nothing.
      const patch = { spreadsheetId };
      const keptSelections = (settings.selectedDivisions || []).filter(n => allDivisionNames.includes(n));
      if (keptSelections.length !== (settings.selectedDivisions || []).length) {
        patch.selectedDivisions = keptSelections;
        settings.selectedDivisions = keptSelections;
      }
      await Store.updateSyncSettings(patch);
    }

    let divisionNames = allDivisionNames;
    let scope = 'all';
    if (settings.syncScope === 'selected' && Array.isArray(settings.selectedDivisions) && settings.selectedDivisions.length) {
      divisionNames = allDivisionNames.filter(name => settings.selectedDivisions.includes(name));
      scope = 'selected';
    }

    if (!divisionNames.length) {
      return recordResult({
        success: false,
        error: scope === 'selected' ? 'No matching divisions found for the selected sync scope.' : 'No divisions found in the sheet.',
        triggeredBy, startedAt, scope, divisionNames: settings.selectedDivisions, pruned
      });
    }

    const { standingsCount, matchesCount, legacyTabs, failedTabs, syncedCount } = await syncTabs(spreadsheetId, divisionNames);

    return recordResult({
      success: syncedCount > 0, triggeredBy, startedAt, scope, divisionNames, pruned,
      divisions: syncedCount, standingsCount, matchesCount, legacyTabs, failedTabs,
      ...(failedTabs.length && !syncedCount ? { error: 'All divisions failed to sync — see failedTabs.' } : {})
    });
  } catch (e) {
    console.error('sheetsSync.syncAll failed', e);
    return recordResult({ success: false, error: e.toString(), triggeredBy, startedAt });
  }
}

async function recordResult({ success, error, triggeredBy, startedAt, divisions, standingsCount, matchesCount, scope, divisionNames, pruned, legacyTabs, failedTabs }) {
  const timestamp = Date.now();
  const durationMs = timestamp - startedAt;
  const entry = {
    timestamp,
    status: success ? (failedTabs && failedTabs.length ? 'partial' : 'success') : 'error',
    durationMs,
    triggeredBy,
    ...(error ? { error } : {}),
    ...(divisions != null ? { divisions, standingsCount, matchesCount } : {}),
    ...(scope ? { scope } : {}),
    ...(divisionNames && divisionNames.length ? { divisionNames } : {}),
    ...(pruned && pruned.length ? { prunedDivisions: pruned } : {}),
    ...(legacyTabs && legacyTabs.length ? { legacyTabs } : {}),
    ...(failedTabs && failedTabs.length ? { failedTabs } : {})
  };

  try {
    await Store.recordSyncLog(entry);
  } catch (e) {
    console.error('sheetsSync: failed to record sync log', e);
  }

  return { success, ...entry };
}

/**
 * Delete every stored division that isn't a visible tab in the spreadsheet
 * currently configured, and record that id as the one the stored data came
 * from. syncAll() does this on its own when it notices the id changed; this
 * is the manual entry point for cleaning up a swap that happened before the
 * id was being tracked.
 */
export async function pruneStaleDivisions() {
  if (!(await isConfigured())) {
    return { success: false, error: 'Google Sheets sync not configured.', pruned: [] };
  }
  try {
    const spreadsheetId = await getEffectiveSpreadsheetId();
    const allDivisionNames = await getAvailableDivisions();
    if (!allDivisionNames.length) {
      return { success: false, error: 'No divisions found in the sheet — refusing to prune.', pruned: [] };
    }
    const pruned = await Store.pruneDivisions(allDivisionNames);
    await Store.updateSyncSettings({ spreadsheetId });
    return { success: true, pruned, kept: allDivisionNames };
  } catch (e) {
    console.error('sheetsSync.pruneStaleDivisions failed', e);
    return { success: false, error: e.toString(), pruned: [] };
  }
}

export async function getStatus() {
  return Store.getSyncStatus();
}

export async function updateSettings(patch) {
  return Store.updateSyncSettings(patch);
}
