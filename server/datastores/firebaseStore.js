// server/datastores/firebaseStore.js
// Thin wrapper around the existing Firebase RTDB logic in server/sheets.js
// and server/firebase.js. Selected when DATA_BACKEND=firebase (the default).
//
// The round timer stays entirely client-side (browser talks to Firebase RTDB
// directly, as it always has) in this mode, so the timer methods below are
// unused by the frontend and exist only to satisfy the shared Store interface.
import * as Sheets from '../sheets.js';
import admin, { createCustomToken as fbCreateCustomToken } from '../firebase.js';
import { broadcastSyncStatus } from '../socket.js';

const SYNC_SETTINGS_PATH = 'dodgeball-tournament/settings/sheetSync';
const MAX_SYNC_LOG_ENTRIES = 25;

export async function getDivisionNames() {
  return Sheets.getDivisionNames();
}

export async function getStandings(sheetName) {
  return Sheets.getStandings(sheetName);
}

export async function getSchedule(sheetName) {
  return Sheets.getSchedule(sheetName);
}

export async function saveMatchResult(matchData) {
  return Sheets.saveMatchResult(matchData);
}

export async function getTimerState() {
  return { unsupported: true, reason: 'Timer state is managed client-side against Firebase RTDB in firebase mode.' };
}

export async function setTimerState() {
  return { unsupported: true, reason: 'Timer state is managed client-side against Firebase RTDB in firebase mode.' };
}

export async function adjustTimer() {
  return { unsupported: true, reason: 'Timer state is managed client-side against Firebase RTDB in firebase mode.' };
}

export async function createCustomToken(uid, claims = {}) {
  return fbCreateCustomToken(uid, claims);
}

/**
 * Write a division's sheet-sourced standings + schedule into RTDB.
 * Schedule rows are written with `update()` per index (not `set()`) so
 * per-match `history` nodes written by the app's own match-entry flow
 * aren't clobbered by the pull.
 */
export async function writeDivisionData(name, { standings, schedule } = {}) {
  const db = admin.database();
  await db.ref(`dodgeball-tournament/divisions/${name}/standings`).set(standings || []);

  const updates = {};
  (schedule || []).forEach((match, idx) => { updates[idx] = match; });
  if (Object.keys(updates).length) {
    await db.ref(`dodgeball-tournament/divisions/${name}/schedule`).update(updates);
  }
}

const ANNOUNCEMENTS_PATH = 'dodgeball-tournament/announcements';
const CHAT_PATH = 'dodgeball-tournament/chat';

// Reads go straight to the RTDB node from the browser too (a direct
// `.on('value')` listener, same pattern as `watchDivision`), so these
// server-side getters exist for the REST GET routes' initial payload and
// aren't the live-update path.
export async function getAnnouncements() {
  const snap = await admin.database().ref(ANNOUNCEMENTS_PATH).once('value');
  const val = snap.val() || {};
  return Object.values(val).sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

export async function createAnnouncement(text) {
  const db = admin.database();
  const id = Date.now();
  await db.ref(ANNOUNCEMENTS_PATH).push({ id, text, ts: id, on: true });
  return getAnnouncements();
}

async function findAnnouncementKey(db, id) {
  const snap = await db.ref(ANNOUNCEMENTS_PATH).orderByChild('id').equalTo(id).once('value');
  const val = snap.val() || {};
  return Object.keys(val)[0] || null;
}

export async function updateAnnouncement(id, patch) {
  const db = admin.database();
  const key = await findAnnouncementKey(db, id);
  if (key) {
    const updates = {};
    if (typeof patch.text === 'string') updates.text = patch.text;
    if (typeof patch.on === 'boolean') updates.on = patch.on;
    await db.ref(`${ANNOUNCEMENTS_PATH}/${key}`).update(updates);
  }
  return getAnnouncements();
}

export async function deleteAnnouncement(id) {
  const db = admin.database();
  const key = await findAnnouncementKey(db, id);
  if (key) await db.ref(`${ANNOUNCEMENTS_PATH}/${key}`).remove();
  return getAnnouncements();
}

export async function getChatMessages() {
  const snap = await admin.database().ref(CHAT_PATH).once('value');
  const val = snap.val() || {};
  return Object.values(val).sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

export async function postChatMessage({ who, mgr, text }) {
  const id = Date.now();
  await admin.database().ref(CHAT_PATH).push({ id, who, mgr: !!mgr, text, ts: id });
  return getChatMessages();
}

export async function getSyncStatus() {
  const snap = await admin.database().ref(SYNC_SETTINGS_PATH).once('value');
  const val = snap.val() || {};
  const log = Object.values(val.log || {}).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return {
    settings: {
      autoSyncEnabled: !!val.autoSyncEnabled,
      intervalSeconds: Number(val.intervalSeconds) || 300,
      syncScope: val.syncScope || 'all',
      selectedDivisions: Array.isArray(val.selectedDivisions) ? val.selectedDivisions : []
    },
    lastSync: val.lastSync || null,
    log
  };
}

export async function updateSyncSettings(patch) {
  await admin.database().ref(SYNC_SETTINGS_PATH).update(patch || {});
  const status = await getSyncStatus();
  broadcastSyncStatus(status);
  return status;
}

export async function recordSyncLog(entry) {
  const db = admin.database();
  const logRef = db.ref(`${SYNC_SETTINGS_PATH}/log`);
  await logRef.push(entry);
  await db.ref(`${SYNC_SETTINGS_PATH}/lastSync`).set(entry);

  const snap = await logRef.once('value');
  const val = snap.val() || {};
  const keys = Object.keys(val).sort((a, b) => (val[a].timestamp || 0) - (val[b].timestamp || 0));
  if (keys.length > MAX_SYNC_LOG_ENTRIES) {
    const removals = {};
    keys.slice(0, keys.length - MAX_SYNC_LOG_ENTRIES).forEach(k => { removals[k] = null; });
    await logRef.update(removals);
  }

  const status = await getSyncStatus();
  broadcastSyncStatus(status);
  return status;
}

export const backend = 'firebase';
