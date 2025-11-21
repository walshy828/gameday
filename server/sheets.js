// server/sheets.js (Firebase + Sheets bridge)
import dotenv from 'dotenv';
import admin from './firebase.js';
import { google } from 'googleapis';
dotenv.config();

const BASE_REF = 'dodgeball-tournament/divisions';

// Google Sheets config (used when available). If not configured, Sheets writes will be skipped.
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

/**
 * Read division names from the Firebase Realtime Database.
 * Returns an array of division keys/titles.
 */
export async function getDivisionNames() {
  if (!admin || !admin.database) throw new Error('Firebase admin not initialized');
  const ref = admin.database().ref(BASE_REF);
  const snap = await ref.once('value');
  const val = snap.val() || {};
  // The divisions are stored as children under BASE_REF. Return their keys as names.
  return Object.keys(val).filter(k => k != null);
}

/**
 * Read standings for a division from Firebase.
 * Expects data at `dodgeball-tournament/divisions/${sheetName}/standings`.
 * Returns an array of objects: { rank, team, record, points }
 */
export async function getStandings(sheetName) {
  if (!sheetName) return [];
  const ref = admin.database().ref(`${BASE_REF}/${sheetName}/standings`);
  const snap = await ref.once('value');
  const val = snap.val();
  if (!val) return [];
  // val may be an array or an object map. Normalize to array.
  let arr = [];
  if (Array.isArray(val)) {
    arr = val;
  } else if (typeof val === 'object') {
    // preserve ordering if numeric keys present
    arr = Object.values(val);
  }
  // Map to expected shape and filter empty team entries
  return arr.map(item => ({
    rank: item.rank || '',
    team: (item.team || '').toString().trim(),
    record: item.record || '',
    points: item.points || ''
  })).filter(s => s.team);
}

/**
 * Read schedule for a division from Firebase.
 * Expects data at `dodgeball-tournament/divisions/${sheetName}/schedule`.
 * Returns an array of match objects similar to the original sheets-based output.
 */
export async function getSchedule(sheetName) {
  if (!sheetName) return [];
  const ref = admin.database().ref(`${BASE_REF}/${sheetName}/schedule`);
  const snap = await ref.once('value');
  const val = snap.val();
  if (!val) return [];

  // If the schedule is an array, map it with indices. If it's an object, map entries.
  if (Array.isArray(val)) {
    return val.map((m, idx) => ({
      ...m,
      firebaseIndex: idx
    })).filter(match => match && (match.team1 || match.team2));
  }

  // object map: key -> match
  return Object.entries(val).map(([key, m]) => ({
    ...m,
    firebaseIndex: key
  })).filter(match => match && (match.team1 || match.team2));
}

/**
 * Save match result - writes to columns H: L (admin columns) and updates a JSON history column (M).
 * matchData must include: sheetName, rowIndex, adminName, winner, playersRemaining, notes
 */
export async function saveMatchResult(matchData) {
  // Save match result into Firebase Realtime Database under the schedule entry
  const { sheetName, firebaseIndex, rowIndex, adminName, winner, playersRemaining, notes } = matchData;
  if (!sheetName || (firebaseIndex === undefined || firebaseIndex === null)) {
    return { success: false, error: 'Invalid sheetName/firebaseIndex' };
  }

  const entryRef = admin.database().ref(`${BASE_REF}/${sheetName}/schedule/${firebaseIndex}`);

  const updatePayload = {
    adminName: adminName || '',
    adminWinner: winner || '',
    adminPlayersRemaining: playersRemaining || '',
    notes: notes || '',
    lastUpdated: new Date().toISOString()
  };

  const results = { firebase: null, sheets: null };

  // Update the schedule entry in Firebase
  try {
    await entryRef.update(updatePayload);
    // push history
    const historyRef = entryRef.child('history');
    await historyRef.push({ name: adminName || '', winner: winner || '', playersRemaining: playersRemaining || '', notes: notes || '', date: new Date().toISOString() });
    results.firebase = { success: true };
  } catch (e) {
    console.error('Firebase update failed', e);
    results.firebase = { success: false, error: e.toString() };
  }

  // Also update Google Sheets if configured and rowIndex provided
  if (sheetsApi && jwtClient && typeof rowIndex !== 'undefined' && rowIndex !== null) {
    try {
      // authorize jwt client (no-op if already authorized)
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

      results.sheets = { success: true };
    } catch (e) {
      console.error('Sheets update failed', e);
      results.sheets = { success: false, error: e.toString() };
    }
  } else {
    results.sheets = { success: false, error: 'Sheets API not configured or rowIndex missing' };
  }

  return { success: true, results };
}
