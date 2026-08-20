// server/sheets.js — Firebase Realtime Database reads/writes.
// The Google Sheets mirror previously embedded here has moved to
// server/sheetsMirror.js so it has no dependency on Firebase and can run
// under either DATA_BACKEND.
import dotenv from 'dotenv';
import admin from './firebase.js';
dotenv.config();

const BASE_REF = 'dodgeball-tournament/divisions';

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
 * Save match result into Firebase Realtime Database under the schedule entry.
 * The Google Sheets mirror write has moved to sheetsMirror.js and is called
 * separately (see server/index.js) so it stays independent of this backend.
 * matchData must include: sheetName, firebaseIndex, adminName, winner, playersRemaining, notes
 */
export async function saveMatchResult(matchData) {
  const { sheetName, firebaseIndex, adminName, winner, playersRemaining, notes } = matchData;
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

  try {
    await entryRef.update(updatePayload);
    // push history
    const historyRef = entryRef.child('history');
    await historyRef.push({ name: adminName || '', winner: winner || '', playersRemaining: playersRemaining || '', notes: notes || '', date: new Date().toISOString() });
    return { success: true, results: { firebase: { success: true } } };
  } catch (e) {
    console.error('Firebase update failed', e);
    return { success: false, results: { firebase: { success: false, error: e.toString() } } };
  }
}
