// server/datastores/firebaseStore.js
// Thin wrapper around the existing Firebase RTDB logic in server/sheets.js
// and server/firebase.js. Selected when DATA_BACKEND=firebase (the default).
//
// The round timer stays entirely client-side (browser talks to Firebase RTDB
// directly, as it always has) in this mode, so the timer methods below are
// unused by the frontend and exist only to satisfy the shared Store interface.
import * as Sheets from '../sheets.js';
import admin, { createCustomToken as fbCreateCustomToken } from '../firebase.js';
import { broadcastSyncStatus, broadcastFeatureSettingsUpdate, broadcastDiscrepancyPing } from '../socket.js';

const SYNC_SETTINGS_PATH = 'dodgeball-tournament/settings/sheetSync';
const MAX_SYNC_LOG_ENTRIES = 100;
const DISCREPANCY_PATH = 'dodgeball-tournament/discrepancyDismissals';
const FEATURE_SETTINGS_PATH = 'dodgeball-tournament/settings/features';

export async function getDivisionNames() {
  return Sheets.getDivisionNames();
}

export async function getStandings(sheetName) {
  return Sheets.getStandings(sheetName);
}

export async function getSchedule(sheetName) {
  return Sheets.getSchedule(sheetName);
}

export async function getScheduleConfig(sheetName) {
  if (!sheetName) return null;
  const snap = await admin.database().ref(`dodgeball-tournament/divisions/${sheetName}/scheduleConfig`).once('value');
  return snap.val() || null;
}

export async function saveMatchResult(matchData) {
  return Sheets.saveMatchResult(matchData);
}

export async function getTimerState() {
  return { unsupported: true, reason: 'Timer state is managed client-side against Firebase RTDB in firebase mode.' };
}

export async function mutateTimer() {
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
export async function writeDivisionData(name, { standings, schedule, scheduleConfig } = {}) {
  const db = admin.database();
  await db.ref(`dodgeball-tournament/divisions/${name}/standings`).set(standings || []);
  // null (a tab without a config block) removes any stale node.
  await db.ref(`dodgeball-tournament/divisions/${name}/scheduleConfig`).set(scheduleConfig || null);

  const updates = {};
  (schedule || []).forEach((match, idx) => { updates[idx] = match; });
  if (Object.keys(updates).length) {
    await db.ref(`dodgeball-tournament/divisions/${name}/schedule`).update(updates);
  }
}

/**
 * Remove a division and everything under it (standings, schedule, per-match
 * history). Used when the sheet a division came from is no longer the
 * source of record — see pruneDivisions().
 */
export async function deleteDivision(name) {
  if (!name) return;
  await admin.database().ref(`dodgeball-tournament/divisions/${name}`).remove();
}

/**
 * Delete every stored division whose name isn't in `keepNames`, and return
 * the names that were removed. Called after a spreadsheet swap so divisions
 * left behind by the previous sheet stop showing up in /api/divisions.
 */
export async function pruneDivisions(keepNames = []) {
  const keep = new Set(keepNames);
  const stale = (await getDivisionNames()).filter(name => !keep.has(name));
  for (const name of stale) await deleteDivision(name);
  return stale;
}

const ANNOUNCEMENTS_PATH = 'dodgeball-tournament/announcements';
const CHAT_PATH = 'dodgeball-tournament/chat';
const CHAT_LEAD_PATH = 'dodgeball-tournament/chatLeadership';

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

// Leadership messages live under a separate node so they can't leak through
// the crew node's direct browser listener; clients read them only through the
// authenticated GET /api/chat/lead.
function chatPath(channel) {
  return channel === 'lead' ? CHAT_LEAD_PATH : CHAT_PATH;
}

export async function getChatMessages(channel = 'crew') {
  const snap = await admin.database().ref(chatPath(channel)).once('value');
  const val = snap.val() || {};
  return Object.values(val).sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

export async function postChatMessage({ who, mgr, text, channel = 'crew' }) {
  const id = Date.now();
  await admin.database().ref(chatPath(channel)).push({ id, who, mgr: !!mgr, text, ts: id });
  return getChatMessages(channel);
}

export async function deleteChatMessage(id, channel = 'crew') {
  const db = admin.database();
  const snap = await db.ref(chatPath(channel)).orderByChild('id').equalTo(id).once('value');
  const val = snap.val() || {};
  const key = Object.keys(val)[0] || null;
  if (key) await db.ref(`${chatPath(channel)}/${key}`).remove();
  return getChatMessages(channel);
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
      selectedDivisions: Array.isArray(val.selectedDivisions) ? val.selectedDivisions : [],
      // Spreadsheet the stored divisions were last pulled from; sheetsSync
      // compares this against the effective configured id to detect a swap.
      spreadsheetId: val.spreadsheetId || null,
      // Superadmin-configured sync target (Settings page); falls back to the
      // SPREADSHEET_ID env var when unset — see server/sheetsSync.js.
      googleSheetId: val.googleSheetId || null,
      // Epoch ms when auto-sync switches itself off (see server/syncScheduler.js).
      autoSyncExpiresAt: Number(val.autoSyncExpiresAt) || null
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

export async function getFeatureSettings() {
  const snap = await admin.database().ref(FEATURE_SETTINGS_PATH).once('value');
  const val = snap.val() || {};
  return {
    championCelebrationEnabled: val.championCelebrationEnabled !== false,
    autoUpdateOfficialResultsEnabled: val.autoUpdateOfficialResultsEnabled === true
  };
}

export async function updateFeatureSettings(patch) {
  await admin.database().ref(FEATURE_SETTINGS_PATH).update(patch || {});
  const settings = await getFeatureSettings();
  broadcastFeatureSettingsUpdate(settings);
  return settings;
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

const SESSIONS_PATH = 'dodgeball-tournament/sessions';
const MAX_SESSION_ENTRIES = 500;

export async function recordLogin({ sessionId, role, name, court, ip, userAgent, os, browser, device }) {
  const now = Date.now();
  const db = admin.database();
  await db.ref(`${SESSIONS_PATH}/${sessionId}`).set({
    sessionId, role, name, court: court || null, ip, userAgent, os, browser, device,
    loginAt: now, lastActivityAt: now, logoutAt: null, active: true
  });

  // Prune oldest ended sessions once history grows past the cap — never
  // removes an active session.
  const snap = await db.ref(SESSIONS_PATH).once('value');
  const val = snap.val() || {};
  const keys = Object.keys(val);
  if (keys.length > MAX_SESSION_ENTRIES) {
    const removable = keys.filter(k => !val[k].active).sort((a, b) => (val[a].loginAt || 0) - (val[b].loginAt || 0));
    const excess = keys.length - MAX_SESSION_ENTRIES;
    const removals = {};
    removable.slice(0, excess).forEach(k => { removals[k] = null; });
    if (Object.keys(removals).length) await db.ref(SESSIONS_PATH).update(removals);
  }
}

export async function touchSession(sessionId) {
  await admin.database().ref(`${SESSIONS_PATH}/${sessionId}/lastActivityAt`).set(Date.now());
}

export async function endSession(sessionId) {
  await admin.database().ref(`${SESSIONS_PATH}/${sessionId}`).update({ active: false, logoutAt: Date.now() });
}

export async function getActiveSessions() {
  const snap = await admin.database().ref(SESSIONS_PATH).orderByChild('active').equalTo(true).once('value');
  const val = snap.val() || {};
  return Object.values(val);
}

export async function getLoginHistory(limit = 200) {
  const snap = await admin.database().ref(SESSIONS_PATH).once('value');
  const val = snap.val() || {};
  return Object.values(val).sort((a, b) => (b.loginAt || 0) - (a.loginAt || 0)).slice(0, limit);
}

// Superadmin dismissals of result discrepancies. RTDB keys can't contain
// `. # $ [ ] /`, so the "<division>|<index>" key is encoded before use.
const fbKey = key => encodeURIComponent(key).replace(/\./g, '%2E');

export async function getDiscrepancyDismissals() {
  const snap = await admin.database().ref(DISCREPANCY_PATH).once('value');
  const out = {};
  Object.values(snap.val() || {}).forEach(v => { if (v && v.key) out[v.key] = { sig: v.sig, by: v.by || '', ts: v.ts || 0 }; });
  return out;
}

export async function setDiscrepancyDismissal(key, sig, by) {
  await admin.database().ref(`${DISCREPANCY_PATH}/${fbKey(key)}`).set({ key, sig, by: by || '', ts: Date.now() });
  broadcastDiscrepancyPing();
}

export const backend = 'firebase';
