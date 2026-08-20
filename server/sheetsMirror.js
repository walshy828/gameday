// server/sheetsMirror.js
// Optional, best-effort Google Sheets mirror for match results.
// Independent of the primary data backend (DATA_BACKEND) — gated purely on
// its own env vars so it can run alongside either Firebase or a local DB.
import dotenv from 'dotenv';
import { google } from 'googleapis';
dotenv.config();

const SPREADSHEET_ID = process.env.SPREADSHEET_ID || null;
let jwtClient = null;
let sheetsApi = null;
if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY && SPREADSHEET_ID) {
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

export function isConfigured() {
  return !!(sheetsApi && jwtClient);
}

/**
 * Mirror a match result into Google Sheets, columns H:L plus a JSON history
 * blob in column M. No-op (returns a `not configured` result) if Sheets
 * env vars aren't set or `rowIndex` wasn't provided.
 * matchData must include: sheetName, rowIndex, adminName, winner, playersRemaining, notes
 */
export async function saveMatchResult(matchData) {
  const { sheetName, rowIndex, adminName, winner, playersRemaining, notes } = matchData || {};

  if (!isConfigured() || typeof rowIndex === 'undefined' || rowIndex === null) {
    return { success: false, error: 'Sheets API not configured or rowIndex missing' };
  }

  try {
    await jwtClient.authorize();

    // Read existing history JSON in column M (col 13)
    const historyRangeA1 = `${sheetName}!M${rowIndex}`;
    const historyResp = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: historyRangeA1, valueRenderOption: 'UNFORMATTED_VALUE'
    });
    let historyArray = [];
    const current = (historyResp.data.values || [])[0] && (historyResp.data.values[0][0]);
    if (current) {
      try { historyArray = JSON.parse(current); if (!Array.isArray(historyArray)) historyArray = []; } catch (e) { historyArray = []; }
    }
    historyArray.push({ name: adminName || '', winner: winner || '', playersRemaining: playersRemaining || '', notes: notes || '', date: new Date().toISOString() });

    // Prepare batch update: set admin columns H..L and history column M
    const valuesForAdmin = [[adminName || '', winner || '', playersRemaining || '', notes || '', new Date().toISOString()]];
    const requests = [
      {
        range: `${sheetName}!H${rowIndex}:L${rowIndex}`,
        values: valuesForAdmin
      },
      {
        range: `${sheetName}!M${rowIndex}`,
        values: [[JSON.stringify(historyArray)]]
      }
    ];

    await sheetsApi.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
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
