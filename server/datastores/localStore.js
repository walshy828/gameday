// server/datastores/localStore.js
// MariaDB-backed implementation of the Store interface, selected when
// DATA_BACKEND=local. Realtime push (replacing Firebase RTDB's built-in
// listeners) is done via Socket.IO broadcasts after each write.
import { pool } from '../db.js';
import { broadcastDivisionUpdate, broadcastTimerUpdate, broadcastSyncStatus, broadcastAnnouncementUpdate, broadcastChatUpdate } from '../socket.js';

export const backend = 'local';

const MAX_SYNC_LOG_ENTRIES = 25;

// Self-heals and auto-provisions database tables if they do not exist.
// This ensures any existing database or a freshly spawned local/Docker database
// gets correctly set up with the full schema at server startup.
(async function ensureFeatureTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS divisions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(191) NOT NULL UNIQUE,
        sort_order INT NOT NULL DEFAULT 0
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS standings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        division VARCHAR(191) NOT NULL,
        rnk VARCHAR(16),
        team VARCHAR(191) NOT NULL,
        record VARCHAR(64),
        points VARCHAR(64),
        sort_order INT NOT NULL DEFAULT 0,
        INDEX idx_standings_division (division)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schedule (
        id INT AUTO_INCREMENT PRIMARY KEY,
        division VARCHAR(191) NOT NULL,
        match_index INT NOT NULL,
        round_time VARCHAR(64),
        court VARCHAR(64),
        match_number VARCHAR(64),
        team1 VARCHAR(191),
        team2 VARCHAR(191),
        is_bye BOOLEAN NOT NULL DEFAULT FALSE,
        winner VARCHAR(191),
        players_remaining VARCHAR(64),
        row_index INT NULL,
        adminName VARCHAR(191),
        adminWinner VARCHAR(191),
        adminPlayersRemaining VARCHAR(64),
        notes TEXT,
        lastUpdated DATETIME NULL,
        UNIQUE KEY uq_schedule_div_idx (division, match_index),
        INDEX idx_schedule_division (division)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS match_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        division VARCHAR(191) NOT NULL,
        match_index INT NOT NULL,
        name VARCHAR(191),
        winner VARCHAR(191),
        players_remaining VARCHAR(64),
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_history_div_idx (division, match_index)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS timer_state (
        division VARCHAR(191) PRIMARY KEY,
        duration INT NOT NULL DEFAULT 300,
        lastSetDuration INT NOT NULL DEFAULT 300,
        running BOOLEAN NOT NULL DEFAULT FALSE,
        startTime BIGINT NULL,
        currentRound VARCHAR(64) NULL,
        afterRoundDuration INT NOT NULL DEFAULT 60,
        startAfterRoundRunning BOOLEAN NOT NULL DEFAULT FALSE,
        showClock BOOLEAN NOT NULL DEFAULT TRUE
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sync_settings (
        id INT PRIMARY KEY,
        auto_sync_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        interval_seconds INT NOT NULL DEFAULT 300,
        sync_scope VARCHAR(16) NOT NULL DEFAULT 'all',
        selected_divisions TEXT NULL,
        spreadsheet_id VARCHAR(191) NULL
      )
    `);
    // Added after the table shipped — bring pre-existing databases forward.
    try {
      await pool.query('ALTER TABLE sync_settings ADD COLUMN spreadsheet_id VARCHAR(191) NULL');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sync_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        timestamp BIGINT NOT NULL,
        status VARCHAR(16) NOT NULL,
        duration_ms INT,
        triggered_by VARCHAR(32),
        error TEXT,
        divisions INT,
        standings_count INT,
        matches_count INT,
        scope VARCHAR(16),
        division_names TEXT,
        INDEX idx_sync_log_timestamp (timestamp)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS announcements (
        id BIGINT PRIMARY KEY,
        text TEXT NOT NULL,
        ts BIGINT NOT NULL,
        is_on BOOLEAN NOT NULL DEFAULT TRUE,
        INDEX idx_announcements_ts (ts)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id BIGINT PRIMARY KEY,
        who VARCHAR(191) NOT NULL,
        is_mgr BOOLEAN NOT NULL DEFAULT FALSE,
        text TEXT NOT NULL,
        ts BIGINT NOT NULL,
        INDEX idx_chat_ts (ts)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gameday_submissions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(191),
        winner VARCHAR(191),
        playersremaining VARCHAR(64),
        notes TEXT,
        Date DATETIME,
        division VARCHAR(191),
        rowindex INT
      )
    `);
  } catch (e) {
    console.error('localStore: failed to ensure all schema tables exist', e);
  }
})();

function mapStandingsRow(row) {
  return {
    rank: row.rnk || '',
    team: row.team || '',
    record: row.record || '',
    points: row.points || ''
  };
}

function mapScheduleRow(row) {
  return {
    firebaseIndex: row.match_index,
    rowIndex: row.row_index,
    roundTime: row.round_time,
    court: row.court,
    match: row.match_number,
    team1: row.team1,
    team2: row.team2,
    isBye: !!row.is_bye,
    winner: row.winner,
    playersRemaining: row.players_remaining,
    adminName: row.adminName,
    adminWinner: row.adminWinner,
    adminPlayersRemaining: row.adminPlayersRemaining,
    notes: row.notes,
    lastUpdated: row.lastUpdated
  };
}

export async function getDivisionNames() {
  const [rows] = await pool.query('SELECT name FROM divisions ORDER BY sort_order, name');
  return rows.map(r => r.name);
}

export async function getStandings(sheetName) {
  if (!sheetName) return [];
  const [rows] = await pool.query(
    'SELECT rnk, team, record, points FROM standings WHERE division = ? ORDER BY sort_order, rnk',
    [sheetName]
  );
  return rows.map(mapStandingsRow).filter(s => s.team);
}

export async function getSchedule(sheetName) {
  if (!sheetName) return [];
  const [rows] = await pool.query(
    'SELECT * FROM schedule WHERE division = ? ORDER BY match_index',
    [sheetName]
  );
  return rows.map(mapScheduleRow).filter(m => m && (m.team1 || m.team2));
}

async function loadDivisionSnapshot(sheetName) {
  const [standings, schedule] = await Promise.all([
    getStandings(sheetName),
    getSchedule(sheetName)
  ]);
  return { standings, schedule };
}

export async function saveMatchResult(matchData) {
  const { sheetName, firebaseIndex, adminName, winner, playersRemaining, notes } = matchData || {};
  if (!sheetName || firebaseIndex === undefined || firebaseIndex === null) {
    return { success: false, error: 'Invalid sheetName/firebaseIndex' };
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      `UPDATE schedule
       SET adminName = ?, adminWinner = ?, adminPlayersRemaining = ?, notes = ?, lastUpdated = NOW()
       WHERE division = ? AND match_index = ?`,
      [adminName || '', winner || '', playersRemaining || '', notes || '', sheetName, firebaseIndex]
    );

    await conn.query(
      `INSERT INTO match_history (division, match_index, name, winner, players_remaining, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sheetName, firebaseIndex, adminName || '', winner || '', playersRemaining || '', notes || '']
    );

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    console.error('localStore.saveMatchResult failed', e);
    return { success: false, error: e.toString() };
  } finally {
    conn.release();
  }

  const snapshot = await loadDivisionSnapshot(sheetName);
  broadcastDivisionUpdate(sheetName, snapshot);
  return { success: true, results: { local: { success: true } } };
}

/**
 * Write a division's sheet-sourced standings + schedule into MariaDB.
 * Standings are fully replaced; schedule rows are upserted on
 * (division, match_index) touching only the base sheet columns — admin*
 * columns and lastUpdated (written by the app's own match-entry flow) are
 * left untouched.
 */
export async function writeDivisionData(name, { standings, schedule } = {}) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('INSERT IGNORE INTO divisions (name) VALUES (?)', [name]);

    await conn.query('DELETE FROM standings WHERE division = ?', [name]);
    if (standings && standings.length) {
      const values = standings.map((s, idx) => [name, s.rank || '', s.team, s.record || '', s.points || '', idx]);
      await conn.query(
        'INSERT INTO standings (division, rnk, team, record, points, sort_order) VALUES ?',
        [values]
      );
    }

    for (const [idx, m] of (schedule || []).entries()) {
      await conn.query(
        `INSERT INTO schedule (division, match_index, round_time, court, match_number, team1, team2, winner, players_remaining, row_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           round_time = VALUES(round_time), court = VALUES(court), match_number = VALUES(match_number),
           team1 = VALUES(team1), team2 = VALUES(team2), winner = VALUES(winner),
           players_remaining = VALUES(players_remaining), row_index = VALUES(row_index)`,
        [name, idx, m.roundTime || '', m.court || '', m.match || '', m.team1 || '', m.team2 || '',
          m.winner || '', m.playersRemaining || '', m.rowIndex ?? null]
      );
    }

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  const snapshot = await loadDivisionSnapshot(name);
  broadcastDivisionUpdate(name, snapshot);
}

/**
 * Remove a division and all of its rows (standings, schedule, match history,
 * timer state). Used when the sheet a division came from is no longer the
 * source of record — see pruneDivisions().
 */
export async function deleteDivision(name) {
  if (!name) return;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM standings WHERE division = ?', [name]);
    await conn.query('DELETE FROM schedule WHERE division = ?', [name]);
    await conn.query('DELETE FROM match_history WHERE division = ?', [name]);
    await conn.query('DELETE FROM timer_state WHERE division = ?', [name]);
    await conn.query('DELETE FROM divisions WHERE name = ?', [name]);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
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

function mapSyncLogRow(row) {
  let divisionNames;
  if (row.division_names) {
    try { divisionNames = JSON.parse(row.division_names); } catch (e) { divisionNames = undefined; }
  }
  return {
    timestamp: Number(row.timestamp),
    status: row.status,
    durationMs: row.duration_ms,
    triggeredBy: row.triggered_by,
    ...(row.error ? { error: row.error } : {}),
    ...(row.divisions != null ? { divisions: row.divisions, standingsCount: row.standings_count, matchesCount: row.matches_count } : {}),
    ...(row.scope ? { scope: row.scope } : {}),
    ...(divisionNames ? { divisionNames } : {})
  };
}

function mapSyncSettingsRow(row) {
  if (!row) return { autoSyncEnabled: false, intervalSeconds: 300, syncScope: 'all', selectedDivisions: [], spreadsheetId: null };
  let selectedDivisions = [];
  if (row.selected_divisions) {
    try { selectedDivisions = JSON.parse(row.selected_divisions); if (!Array.isArray(selectedDivisions)) selectedDivisions = []; } catch (e) { selectedDivisions = []; }
  }
  return {
    autoSyncEnabled: !!row.auto_sync_enabled,
    intervalSeconds: row.interval_seconds,
    syncScope: row.sync_scope || 'all',
    selectedDivisions,
    // Spreadsheet the stored divisions were last pulled from; sheetsSync
    // compares this against SPREADSHEET_ID to detect a sheet swap.
    spreadsheetId: row.spreadsheet_id || null
  };
}

export async function getSyncStatus() {
  const [settingsRows] = await pool.query(
    'SELECT auto_sync_enabled, interval_seconds, sync_scope, selected_divisions, spreadsheet_id FROM sync_settings WHERE id = 1'
  );
  const settings = mapSyncSettingsRow(settingsRows[0]);

  const [logRows] = await pool.query('SELECT * FROM sync_log ORDER BY timestamp DESC LIMIT ?', [MAX_SYNC_LOG_ENTRIES]);
  const log = logRows.map(mapSyncLogRow);
  return { settings, lastSync: log[0] || null, log };
}

export async function updateSyncSettings(patch) {
  const current = (await getSyncStatus()).settings;
  const next = { ...current, ...patch };
  await pool.query(
    `INSERT INTO sync_settings (id, auto_sync_enabled, interval_seconds, sync_scope, selected_divisions, spreadsheet_id) VALUES (1, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE auto_sync_enabled = VALUES(auto_sync_enabled), interval_seconds = VALUES(interval_seconds),
       sync_scope = VALUES(sync_scope), selected_divisions = VALUES(selected_divisions),
       spreadsheet_id = VALUES(spreadsheet_id)`,
    [next.autoSyncEnabled, next.intervalSeconds, next.syncScope, JSON.stringify(next.selectedDivisions || []), next.spreadsheetId || null]
  );
  const status = await getSyncStatus();
  broadcastSyncStatus(status);
  return status;
}

export async function recordSyncLog(entry) {
  await pool.query(
    `INSERT INTO sync_log (timestamp, status, duration_ms, triggered_by, error, divisions, standings_count, matches_count, scope, division_names)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [entry.timestamp, entry.status, entry.durationMs, entry.triggeredBy, entry.error || null,
      entry.divisions ?? null, entry.standingsCount ?? null, entry.matchesCount ?? null,
      entry.scope || null, entry.divisionNames ? JSON.stringify(entry.divisionNames) : null]
  );
  await pool.query(
    `DELETE FROM sync_log WHERE id NOT IN (SELECT id FROM (SELECT id FROM sync_log ORDER BY timestamp DESC LIMIT ?) keep)`,
    [MAX_SYNC_LOG_ENTRIES]
  );
  const status = await getSyncStatus();
  broadcastSyncStatus(status);
  return status;
}

const DEFAULT_TIMER_STATE = {
  duration: 300,
  lastSetDuration: 300,
  running: false,
  startTime: null,
  currentRound: null,
  afterRoundDuration: 60,
  startAfterRoundRunning: false,
  showClock: true
};

function mapTimerRow(row) {
  if (!row) return null;
  return {
    duration: row.duration,
    lastSetDuration: row.lastSetDuration,
    running: !!row.running,
    startTime: row.startTime === null ? null : Number(row.startTime),
    currentRound: row.currentRound,
    afterRoundDuration: row.afterRoundDuration,
    startAfterRoundRunning: !!row.startAfterRoundRunning,
    showClock: !!row.showClock
  };
}

export async function getTimerState(sheetName) {
  if (!sheetName) return { ...DEFAULT_TIMER_STATE };
  const [rows] = await pool.query('SELECT * FROM timer_state WHERE division = ?', [sheetName]);
  if (rows.length) return mapTimerRow(rows[0]);

  await pool.query(
    `INSERT INTO timer_state (division, duration, lastSetDuration, running, afterRoundDuration, showClock)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [sheetName, DEFAULT_TIMER_STATE.duration, DEFAULT_TIMER_STATE.lastSetDuration, false, DEFAULT_TIMER_STATE.afterRoundDuration, true]
  );
  return { ...DEFAULT_TIMER_STATE };
}

export async function setTimerState(sheetName, patch) {
  if (!sheetName) throw new Error('sheetName is required');

  // Ensure a row exists, then merge the patch onto current state.
  const current = await getTimerState(sheetName);
  const next = { ...current, ...patch };

  await pool.query(
    `UPDATE timer_state SET
       duration = ?, lastSetDuration = ?, running = ?, startTime = ?,
       currentRound = ?, afterRoundDuration = ?, startAfterRoundRunning = ?, showClock = ?
     WHERE division = ?`,
    [
      next.duration, next.lastSetDuration, next.running, next.startTime,
      next.currentRound, next.afterRoundDuration, next.startAfterRoundRunning, next.showClock,
      sheetName
    ]
  );

  broadcastTimerUpdate(sheetName, next);
  return next;
}

export async function getAnnouncements() {
  const [rows] = await pool.query('SELECT id, text, ts, is_on AS `on` FROM announcements ORDER BY ts ASC');
  return rows.map(r => ({ id: Number(r.id), text: r.text, ts: Number(r.ts), on: !!r.on }));
}

export async function createAnnouncement(text) {
  const id = Date.now();
  await pool.query('INSERT INTO announcements (id, text, ts, is_on) VALUES (?, ?, ?, TRUE)', [id, text, id]);
  const list = await getAnnouncements();
  broadcastAnnouncementUpdate(list);
  return list;
}

export async function updateAnnouncement(id, patch) {
  const fields = [];
  const values = [];
  if (typeof patch.text === 'string') { fields.push('text = ?'); values.push(patch.text); }
  if (typeof patch.on === 'boolean') { fields.push('is_on = ?'); values.push(patch.on); }
  if (fields.length) {
    values.push(id);
    await pool.query(`UPDATE announcements SET ${fields.join(', ')} WHERE id = ?`, values);
  }
  const list = await getAnnouncements();
  broadcastAnnouncementUpdate(list);
  return list;
}

export async function deleteAnnouncement(id) {
  await pool.query('DELETE FROM announcements WHERE id = ?', [id]);
  const list = await getAnnouncements();
  broadcastAnnouncementUpdate(list);
  return list;
}

export async function getChatMessages() {
  const [rows] = await pool.query('SELECT id, who, is_mgr AS mgr, text, ts FROM chat_messages ORDER BY ts ASC');
  return rows.map(r => ({ id: Number(r.id), who: r.who, mgr: !!r.mgr, text: r.text, ts: Number(r.ts) }));
}

export async function postChatMessage({ who, mgr, text }) {
  const id = Date.now();
  await pool.query('INSERT INTO chat_messages (id, who, is_mgr, text, ts) VALUES (?, ?, ?, ?, ?)', [id, who, !!mgr, text, id]);
  const list = await getChatMessages();
  broadcastChatUpdate(list);
  return list;
}

export async function deleteChatMessage(id) {
  await pool.query('DELETE FROM chat_messages WHERE id = ?', [id]);
  const list = await getChatMessages();
  broadcastChatUpdate(list);
  return list;
}

export async function adjustTimer(sheetName, deltaSeconds) {
  if (!sheetName) throw new Error('sheetName is required');
  const conn = await pool.getConnection();
  let next;
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM timer_state WHERE division = ? FOR UPDATE', [sheetName]);
    const current = rows.length ? mapTimerRow(rows[0]) : { ...DEFAULT_TIMER_STATE };

    if (current.running) {
      // No-op while running, mirrors the client-side Firebase transaction guard.
      await conn.commit();
      return current;
    }

    let newDuration = Math.max(30, (current.duration || 0) + deltaSeconds);
    newDuration = Math.round(newDuration / 30) * 30;
    next = { ...current, duration: newDuration, lastSetDuration: newDuration, running: false };

    await conn.query(
      `UPDATE timer_state SET duration = ?, lastSetDuration = ?, running = FALSE WHERE division = ?`,
      [next.duration, next.lastSetDuration, sheetName]
    );
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  broadcastTimerUpdate(sheetName, next);
  return next;
}
