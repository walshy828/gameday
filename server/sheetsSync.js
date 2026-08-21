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
dotenv.config();

const SPREADSHEET_ID = process.env.SPREADSHEET_ID || null;

let jwtClient = null;
let sheetsApi = null;
if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY && SPREADSHEET_ID) {
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

export function isConfigured() {
  return !!(sheetsApi && jwtClient);
}

export function getSpreadsheetUrl() {
  return SPREADSHEET_ID ? `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit` : null;
}

/**
 * List every visible division tab in the sheet (used to populate the
 * "Selected Divisions" picker in the Settings page and to resolve which
 * tabs "all" actually means at sync time).
 */
export async function getAvailableDivisions() {
  if (!isConfigured()) return [];
  await jwtClient.authorize();
  const meta = await sheetsApi.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  return (meta.data.sheets || [])
    .filter(s => !s.properties.hidden)
    .map(s => s.properties.title);
}

async function readStandings(sheetName) {
  const range = process.env.STANDINGS_RANGE || 'A2:D20';
  const resp = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!${range}`
  });
  const values = resp.data.values || [];
  return values.map(row => ({
    rank: row[0] || '',
    team: (row[1] || '').toString().trim(),
    record: row[2] || '',
    points: row[3] || ''
  })).filter(s => s.team);
}

async function readSchedule(sheetName) {
  const startRow = Number(process.env.SCHEDULE_START_ROW || 74);
  const lastRowResp = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!A:A`
  });
  const lastRow = (lastRowResp.data.values || []).length;
  const numRows = Math.max(0, lastRow - startRow + 1);
  if (numRows <= 0) return [];

  const range = `${sheetName}!A${startRow}:K${lastRow}`;
  const resp = await sheetsApi.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  const values = resp.data.values || [];

  return values.map((row, idx) => {
    const team1 = (row[1] || '').toString().trim();
    const team2 = (row[2] || '').toString().trim();
    if (!team1 && !team2) return null;
    return {
      match: row[0] || '',
      rowIndex: startRow + idx,
      team1, team2,
      court: row[3] || '',
      roundTime: row[4] || '',
      winner: (row[5] || '').toString().trim(),
      playersRemaining: (row[6] || '').toString().trim(),
      adminName: (row[7] || '').toString().trim(),
      adminWinner: (row[8] || '').toString().trim(),
      adminPlayersRemaining: (row[9] || '').toString().trim(),
      notes: (row[10] || '').toString().trim()
    };
  }).filter(Boolean);
}

/**
 * Pull division tabs from the sheet and write standings + schedule into the
 * active Store backend. Which tabs get synced is driven by the persisted
 * sync settings (Store.getSyncStatus().settings): 'all' visible tabs, or
 * just the ones listed in `selectedDivisions` when scope is 'selected' —
 * this lets a superadmin limit auto-sync/"Sync Now" to only the
 * division(s) actively playing instead of pulling the whole sheet.
 */
export async function syncAll(triggeredBy = 'manual') {
  const startedAt = Date.now();
  if (!isConfigured()) {
    return recordResult({ success: false, error: 'Google Sheets sync not configured.', triggeredBy, startedAt });
  }
  try {
    const { settings } = await Store.getSyncStatus();
    const allDivisionNames = await getAvailableDivisions();

    // Spreadsheet swap: SPREADSHEET_ID in .env no longer matches the sheet
    // the stored divisions came from, so anything not a tab in the new sheet
    // is left over from the old one and gets deleted. Only prune when the
    // new sheet actually returned tabs — an empty list means an API/permission
    // problem, and wiping every division over that would be destructive.
    let pruned = [];
    if (settings.spreadsheetId !== SPREADSHEET_ID && allDivisionNames.length) {
      if (settings.spreadsheetId) {
        pruned = await Store.pruneDivisions(allDivisionNames);
        if (pruned.length) {
          console.log(`sheetsSync: spreadsheet changed — removed ${pruned.length} division(s) from the previous sheet: ${pruned.join(', ')}`);
        }
      }
      // Drop any selected-division picks that only existed in the old sheet,
      // otherwise a 'selected' scope can end up matching nothing.
      const patch = { spreadsheetId: SPREADSHEET_ID };
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

    let standingsCount = 0;
    let matchesCount = 0;

    for (const name of divisionNames) {
      const [standings, schedule] = await Promise.all([readStandings(name), readSchedule(name)]);
      await Store.writeDivisionData(name, { standings, schedule });
      standingsCount += standings.length;
      matchesCount += schedule.length;
    }

    return recordResult({
      success: true, triggeredBy, startedAt, scope, divisionNames, pruned,
      divisions: divisionNames.length, standingsCount, matchesCount
    });
  } catch (e) {
    console.error('sheetsSync.syncAll failed', e);
    return recordResult({ success: false, error: e.toString(), triggeredBy, startedAt });
  }
}

async function recordResult({ success, error, triggeredBy, startedAt, divisions, standingsCount, matchesCount, scope, divisionNames, pruned }) {
  const timestamp = Date.now();
  const durationMs = timestamp - startedAt;
  const entry = {
    timestamp,
    status: success ? 'success' : 'error',
    durationMs,
    triggeredBy,
    ...(error ? { error } : {}),
    ...(divisions != null ? { divisions, standingsCount, matchesCount } : {}),
    ...(scope ? { scope } : {}),
    ...(divisionNames && divisionNames.length ? { divisionNames } : {}),
    ...(pruned && pruned.length ? { prunedDivisions: pruned } : {})
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
 * SPREADSHEET_ID currently points at, and record that id as the one the
 * stored data came from. syncAll() does this on its own when it notices the
 * id changed; this is the manual entry point for cleaning up a swap that
 * happened before the id was being tracked.
 */
export async function pruneStaleDivisions() {
  if (!isConfigured()) {
    return { success: false, error: 'Google Sheets sync not configured.', pruned: [] };
  }
  try {
    const allDivisionNames = await getAvailableDivisions();
    if (!allDivisionNames.length) {
      return { success: false, error: 'No divisions found in the sheet — refusing to prune.', pruned: [] };
    }
    const pruned = await Store.pruneDivisions(allDivisionNames);
    await Store.updateSyncSettings({ spreadsheetId: SPREADSHEET_ID });
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
