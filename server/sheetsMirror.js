// server/sheetsMirror.js
// Optional, best-effort Google Sheets mirror for match results.
// Independent of the primary data backend (DATA_BACKEND) — gated purely on
// its own env vars so it can run alongside either Firebase or a local DB.
import dotenv from 'dotenv';
import { google } from 'googleapis';
import { readSheetConfig } from './sheetConfig.js';
import { getEffectiveSpreadsheetId } from './sheetsSync.js';
dotenv.config();

let jwtClient = null;
let sheetsApi = null;
if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
  try {
    jwtClient = new google.auth.JWT({
      email: process.env.GOOGLE_CLIENT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly']
    });
    sheetsApi = google.sheets({ version: 'v4', auth: jwtClient });
  } catch (e) {
    console.warn('Google Sheets client not initialized:', e.message || e);
    jwtClient = null;
    sheetsApi = null;
  }
}

export async function isConfigured() {
  if (!sheetsApi || !jwtClient) return false;
  return !!(await getEffectiveSpreadsheetId());
}

/**
 * Mirror a match result into Google Sheets. Columns come from the tab's
 * GONK_SHEET_CONFIG block (the individual `col_submitted_*` keys, which are
 * contiguous: name, winner, players, notes, datetime) when present, falling
 * back to the pre-config literal H:L / M layout for tabs that predate it.
 * No-op (returns a `not configured` result) if Sheets env vars aren't set or
 * `rowIndex` wasn't provided.
 * matchData must include: sheetName, rowIndex, adminName, winner, playersRemaining, notes
 *
 * When `autoUpdateOfficialResults` is true (superadmin "auto-update official
 * results" setting), the official winner/players columns are also set from
 * the submitted values — but only per-field, and only when that field is
 * currently blank. A field that already has an official value is left alone;
 * the submitted/unofficial columns are always updated regardless.
 * `forceOfficial` (superadmin only, decided in server/index.js) instead
 * overwrites both official fields unconditionally.
 */
export async function saveMatchResult(matchData) {
  const { sheetName, rowIndex, adminName, winner, playersRemaining, notes, autoUpdateOfficialResults, forceOfficial } = matchData || {};

  if (!(await isConfigured())) {
    return { success: false, skipped: true, error: 'Google Sheets is not configured.' };
  }
  if (typeof rowIndex === 'undefined' || rowIndex === null) {
    return { success: false, error: 'Match has no sheet row (rowIndex missing) — run a sync.' };
  }

  try {
    await jwtClient.authorize();
    const spreadsheetId = await getEffectiveSpreadsheetId();

    const config = await readSheetConfig(sheetsApi, spreadsheetId, sheetName);
    const startCol = (config && config.col_submitted_name) || 'H';
    const endCol = (config && config.col_submitted_datetime) || 'L';
    const historyCol = (config && config.col_submitted_history) || 'M';
    const officialWinnerCol = (config && config.col_official_winner) || 'F';
    const officialPlayersCol = (config && config.col_official_players) || 'G';

    // Read existing history JSON in the history column
    const historyRangeA1 = `'${sheetName}'!${historyCol}${rowIndex}`;
    const historyResp = await sheetsApi.spreadsheets.values.get({
      spreadsheetId, range: historyRangeA1, valueRenderOption: 'UNFORMATTED_VALUE'
    });
    let historyArray = [];
    const current = (historyResp.data.values || [])[0] && (historyResp.data.values[0][0]);
    if (current) {
      try { historyArray = JSON.parse(current); if (!Array.isArray(historyArray)) historyArray = []; } catch (e) { historyArray = []; }
    }
    historyArray.push({ name: adminName || '', winner: winner || '', playersRemaining: playersRemaining || '', notes: notes || '', date: new Date().toISOString() });

    // Prepare batch update: set the submitted-field columns and the history column
    const valuesForAdmin = [[adminName || '', winner || '', playersRemaining || '', notes || '', new Date().toISOString()]];
    const requests = [
      {
        range: `'${sheetName}'!${startCol}${rowIndex}:${endCol}${rowIndex}`,
        values: valuesForAdmin
      },
      {
        range: `'${sheetName}'!${historyCol}${rowIndex}`,
        values: [[JSON.stringify(historyArray)]]
      }
    ];

    if (forceOfficial) {
      // Superadmin ticked "submit as official": overwrite (or clear, when
      // there's no winner) regardless of what's already there.
      requests.push({ range: `'${sheetName}'!${officialWinnerCol}${rowIndex}`, values: [[winner || '']] });
      requests.push({ range: `'${sheetName}'!${officialPlayersCol}${rowIndex}`, values: [[winner ? playersRemaining : '']] });
    } else if (autoUpdateOfficialResults) {
      const officialResp = await sheetsApi.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges: [
          `'${sheetName}'!${officialWinnerCol}${rowIndex}`,
          `'${sheetName}'!${officialPlayersCol}${rowIndex}`
        ],
        valueRenderOption: 'UNFORMATTED_VALUE'
      });
      const [winnerRange, playersRange] = officialResp.data.valueRanges || [];
      const existingOfficialWinner = (winnerRange && winnerRange.values && winnerRange.values[0] && winnerRange.values[0][0]) ?? '';
      const existingOfficialPlayers = (playersRange && playersRange.values && playersRange.values[0] && playersRange.values[0][0]) ?? '';

      if (existingOfficialWinner === '') {
        requests.push({ range: `'${sheetName}'!${officialWinnerCol}${rowIndex}`, values: [[winner || '']] });
      }
      if (existingOfficialPlayers === '') {
        requests.push({ range: `'${sheetName}'!${officialPlayersCol}${rowIndex}`, values: [[playersRemaining || '']] });
      }
    }

    await sheetsApi.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: requests
      }
    });

    return { success: true };
  } catch (e) {
    console.error('Sheets update failed', e);
    return { success: false, error: e.toString() };
  }
}
