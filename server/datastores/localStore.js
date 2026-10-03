// server/datastores/localStore.js
// MariaDB-backed implementation of the Store interface, selected when
// DATA_BACKEND=local. Realtime push (replacing Firebase RTDB's built-in
// listeners) is done via Socket.IO broadcasts after each write.
import { pool } from '../db.js';
import { broadcastDivisionUpdate, broadcastTimerUpdate, broadcastSyncStatus, broadcastAnnouncementUpdate, broadcastChatUpdate, broadcastChatLeadPing, broadcastFeatureSettingsUpdate } from '../socket.js';

export const backend = 'local';

const MAX_SYNC_LOG_ENTRIES = 100;

// Self-heals and auto-provisions database tables if they do not exist.
// This ensures any existing database or a freshly spawned local/Docker database
// gets correctly set up with the full schema at server startup.
export const schemaReady = (async function ensureFeatureTables() {
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
        sub_division VARCHAR(191) NULL,
        INDEX idx_standings_division (division)
      )
    `);
    try {
      await pool.query('ALTER TABLE standings ADD COLUMN sub_division VARCHAR(191) NULL');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
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
        sub_division VARCHAR(191) NULL,
        UNIQUE KEY uq_schedule_div_idx (division, match_index),
        INDEX idx_schedule_division (division)
      )
    `);
    try {
      await pool.query('ALTER TABLE schedule ADD COLUMN sub_division VARCHAR(191) NULL');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
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
        showClock BOOLEAN NOT NULL DEFAULT TRUE,
        afterRoundEnabled BOOLEAN NOT NULL DEFAULT FALSE,
        controllerId VARCHAR(64) NULL,
        controllerName VARCHAR(191) NULL
      )
    `);
    // Clock-ownership / shared after-round columns were added after the table
    // shipped — bring pre-existing databases forward.
    for (const col of [
      'afterRoundEnabled BOOLEAN NOT NULL DEFAULT FALSE',
      'controllerId VARCHAR(64) NULL',
      'controllerName VARCHAR(191) NULL'
    ]) {
      try {
        await pool.query(`ALTER TABLE timer_state ADD COLUMN ${col}`);
      } catch (e) {
        if (e.code !== 'ER_DUP_FIELDNAME') throw e;
      }
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sync_settings (
        id INT PRIMARY KEY,
        auto_sync_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        interval_seconds INT NOT NULL DEFAULT 300,
        sync_scope VARCHAR(16) NOT NULL DEFAULT 'all',
        selected_divisions TEXT NULL,
        spreadsheet_id VARCHAR(191) NULL,
        google_sheet_id VARCHAR(191) NULL,
        auto_sync_expires_at BIGINT NULL
      )
    `);
    // Added after the table shipped — bring pre-existing databases forward.
    try {
      await pool.query('ALTER TABLE sync_settings ADD COLUMN spreadsheet_id VARCHAR(191) NULL');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
    try {
      await pool.query('ALTER TABLE sync_settings ADD COLUMN google_sheet_id VARCHAR(191) NULL');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
    try {
      await pool.query('ALTER TABLE sync_settings ADD COLUMN auto_sync_expires_at BIGINT NULL');
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
        failed_tabs TEXT,
        INDEX idx_sync_log_timestamp (timestamp)
      )
    `);
    try {
      await pool.query('ALTER TABLE sync_log ADD COLUMN failed_tabs TEXT');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
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
        channel VARCHAR(16) NOT NULL DEFAULT 'crew',
        INDEX idx_chat_ts (ts)
      )
    `);
    try {
      await pool.query("ALTER TABLE chat_messages ADD COLUMN channel VARCHAR(16) NOT NULL DEFAULT 'crew'");
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id VARCHAR(64) PRIMARY KEY,
        role VARCHAR(16) NOT NULL,
        name VARCHAR(191),
        court VARCHAR(64) NULL,
        ip VARCHAR(64),
        user_agent VARCHAR(512),
        os VARCHAR(32),
        browser VARCHAR(32),
        device VARCHAR(16),
        login_at BIGINT NOT NULL,
        last_activity_at BIGINT NOT NULL,
        logout_at BIGINT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        INDEX idx_sessions_active (active),
        INDEX idx_sessions_login_at (login_at)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS feature_settings (
        id INT PRIMARY KEY,
        champion_celebration_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        auto_update_official_results_enabled BOOLEAN NOT NULL DEFAULT FALSE
      )
    `);
    try {
      await pool.query('ALTER TABLE feature_settings ADD COLUMN auto_update_official_results_enabled BOOLEAN NOT NULL DEFAULT FALSE');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
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
    points: row.points || '',
    subDivision: row.sub_division || ''
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
    lastUpdated: row.lastUpdated,
    subDivision: row.sub_division || ''
  };
}

export async function getDivisionNames() {
  const [rows] = await pool.query('SELECT name FROM divisions ORDER BY sort_order, name');
  return rows.map(r => r.name);
}

export async function getStandings(sheetName) {
  if (!sheetName) return [];
  const [rows] = await pool.query(
    'SELECT rnk, team, record, points, sub_division FROM standings WHERE division = ? ORDER BY sort_order, rnk',
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
      const values = standings.map((s, idx) => [name, s.rank || '', s.team, s.record || '', s.points || '', idx, s.subDivision || '']);
      await conn.query(
        'INSERT INTO standings (division, rnk, team, record, points, sort_order, sub_division) VALUES ?',
        [values]
      );
    }

    for (const [idx, m] of (schedule || []).entries()) {
      await conn.query(
        `INSERT INTO schedule (division, match_index, round_time, court, match_number, team1, team2, winner, players_remaining, row_index, sub_division)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           round_time = VALUES(round_time), court = VALUES(court), match_number = VALUES(match_number),
           team1 = VALUES(team1), team2 = VALUES(team2), winner = VALUES(winner),
           players_remaining = VALUES(players_remaining), row_index = VALUES(row_index),
           sub_division = VALUES(sub_division)`,
        [name, idx, m.roundTime || '', m.court || '', m.match || '', m.team1 || '', m.team2 || '',
          m.winner || '', m.playersRemaining || '', m.rowIndex ?? null, m.subDivision || '']
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
  let failedTabs;
  if (row.failed_tabs) {
    try { failedTabs = JSON.parse(row.failed_tabs); } catch (e) { failedTabs = undefined; }
  }
  return {
    timestamp: Number(row.timestamp),
    status: row.status,
    durationMs: row.duration_ms,
    triggeredBy: row.triggered_by,
    ...(row.error ? { error: row.error } : {}),
    ...(row.divisions != null ? { divisions: row.divisions, standingsCount: row.standings_count, matchesCount: row.matches_count } : {}),
    ...(row.scope ? { scope: row.scope } : {}),
    ...(divisionNames ? { divisionNames } : {}),
    ...(failedTabs && failedTabs.length ? { failedTabs } : {})
  };
}

function mapSyncSettingsRow(row) {
  if (!row) return { autoSyncEnabled: false, intervalSeconds: 300, syncScope: 'all', selectedDivisions: [], spreadsheetId: null, googleSheetId: null, autoSyncExpiresAt: null };
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
    // compares this against the effective configured id to detect a swap.
    spreadsheetId: row.spreadsheet_id || null,
    // Superadmin-configured sync target (Settings page); falls back to the
    // SPREADSHEET_ID env var when unset — see server/sheetsSync.js.
    googleSheetId: row.google_sheet_id || null,
    // Epoch ms when auto-sync switches itself off (see server/syncScheduler.js).
    autoSyncExpiresAt: row.auto_sync_expires_at != null ? Number(row.auto_sync_expires_at) : null
  };
}

export async function getSyncStatus() {
  const [settingsRows] = await pool.query(
    'SELECT auto_sync_enabled, interval_seconds, sync_scope, selected_divisions, spreadsheet_id, google_sheet_id, auto_sync_expires_at FROM sync_settings WHERE id = 1'
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
    `INSERT INTO sync_settings (id, auto_sync_enabled, interval_seconds, sync_scope, selected_divisions, spreadsheet_id, google_sheet_id, auto_sync_expires_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE auto_sync_enabled = VALUES(auto_sync_enabled), interval_seconds = VALUES(interval_seconds),
       sync_scope = VALUES(sync_scope), selected_divisions = VALUES(selected_divisions),
       spreadsheet_id = VALUES(spreadsheet_id), google_sheet_id = VALUES(google_sheet_id),
       auto_sync_expires_at = VALUES(auto_sync_expires_at)`,
    [next.autoSyncEnabled, next.intervalSeconds, next.syncScope, JSON.stringify(next.selectedDivisions || []), next.spreadsheetId || null, next.googleSheetId || null, next.autoSyncExpiresAt || null]
  );
  const status = await getSyncStatus();
  broadcastSyncStatus(status);
  return status;
}

export async function getFeatureSettings() {
  const [rows] = await pool.query('SELECT champion_celebration_enabled, auto_update_official_results_enabled FROM feature_settings WHERE id = 1');
  const row = rows[0];
  return {
    championCelebrationEnabled: row ? !!row.champion_celebration_enabled : true,
    autoUpdateOfficialResultsEnabled: row ? !!row.auto_update_official_results_enabled : false
  };
}

export async function updateFeatureSettings(patch) {
  const current = await getFeatureSettings();
  const next = { ...current, ...patch };
  await pool.query(
    `INSERT INTO feature_settings (id, champion_celebration_enabled, auto_update_official_results_enabled) VALUES (1, ?, ?)
     ON DUPLICATE KEY UPDATE champion_celebration_enabled = VALUES(champion_celebration_enabled),
       auto_update_official_results_enabled = VALUES(auto_update_official_results_enabled)`,
    [next.championCelebrationEnabled, next.autoUpdateOfficialResultsEnabled]
  );
  const settings = await getFeatureSettings();
  broadcastFeatureSettingsUpdate(settings);
  return settings;
}

export async function recordSyncLog(entry) {
  await pool.query(
    `INSERT INTO sync_log (timestamp, status, duration_ms, triggered_by, error, divisions, standings_count, matches_count, scope, division_names, failed_tabs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [entry.timestamp, entry.status, entry.durationMs, entry.triggeredBy, entry.error || null,
      entry.divisions ?? null, entry.standingsCount ?? null, entry.matchesCount ?? null,
      entry.scope || null, entry.divisionNames ? JSON.stringify(entry.divisionNames) : null,
      entry.failedTabs && entry.failedTabs.length ? JSON.stringify(entry.failedTabs) : null]
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
  showClock: true,
  afterRoundEnabled: false,
  controllerId: null,
  controllerName: null
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
    showClock: !!row.showClock,
    afterRoundEnabled: !!row.afterRoundEnabled,
    controllerId: row.controllerId || null,
    controllerName: row.controllerName || null
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

const TIMER_COLUMNS = [
  'duration', 'lastSetDuration', 'running', 'startTime', 'currentRound',
  'afterRoundDuration', 'startAfterRoundRunning', 'showClock',
  'afterRoundEnabled', 'controllerId', 'controllerName'
];

/**
 * Atomically read-modify-write one division's timer row. The row is locked
 * (SELECT ... FOR UPDATE) while `mutator(current)` decides what to change, so
 * concurrent control requests serialize instead of overwriting each other, and
 * only the columns in the returned patch are written (no full-row clobber).
 * `mutator` must be synchronous; return a patch object, or null/{} for no-op,
 * or throw to abort. Broadcasts only when something actually changed.
 */
export async function mutateTimer(sheetName, mutator) {
  if (!sheetName) throw new Error('sheetName is required');

  // The row is created *outside* the transaction (autocommit): doing the
  // INSERT inside it leaves a lock that concurrent transactions then deadlock
  // on when they upgrade to SELECT ... FOR UPDATE.
  await pool.query('INSERT IGNORE INTO timer_state (division) VALUES (?)', [sheetName]);

  for (let attempt = 1; ; attempt++) {
    const conn = await pool.getConnection();
    let current;
    let next = null;
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query('SELECT * FROM timer_state WHERE division = ? FOR UPDATE', [sheetName]);
      current = mapTimerRow(rows[0]);

      const patch = mutator(current);
      const keys = patch ? Object.keys(patch).filter(k => TIMER_COLUMNS.includes(k)) : [];
      if (keys.length) {
        await conn.query(
          `UPDATE timer_state SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE division = ?`,
          [...keys.map(k => patch[k]), sheetName]
        );
        next = { ...current, ...Object.fromEntries(keys.map(k => [k, patch[k]])) };
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback().catch(() => {});
      if (e.code === 'ER_LOCK_DEADLOCK' && attempt < 3) continue; // retry the whole transaction
      throw e;
    } finally {
      conn.release();
    }

    if (!next) return { state: current, changed: false };
    broadcastTimerUpdate(sheetName, next);
    return { state: next, changed: true };
  }
}

/** Every division whose clock is currently running (used to re-arm expiry timers on boot). */
export async function listRunningTimers() {
  const [rows] = await pool.query('SELECT * FROM timer_state WHERE running = TRUE');
  return rows.map(r => ({ division: r.division, ...mapTimerRow(r) }));
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

// `channel` is 'crew' (everyone) or 'lead' (superadmin + parents). Crew
// updates broadcast their full list; lead updates only broadcast a payload-free
// ping, since a socket broadcast reaches referees too — authorized clients
// refetch via the authenticated GET /api/chat/lead instead.
export async function getChatMessages(channel = 'crew') {
  const [rows] = await pool.query('SELECT id, who, is_mgr AS mgr, text, ts FROM chat_messages WHERE channel = ? ORDER BY ts ASC', [channel]);
  return rows.map(r => ({ id: Number(r.id), who: r.who, mgr: !!r.mgr, text: r.text, ts: Number(r.ts) }));
}

async function broadcastChat(channel) {
  if (channel === 'lead') return broadcastChatLeadPing();
  broadcastChatUpdate(await getChatMessages('crew'));
}

export async function postChatMessage({ who, mgr, text, channel = 'crew' }) {
  const id = Date.now();
  await pool.query('INSERT INTO chat_messages (id, who, is_mgr, text, ts, channel) VALUES (?, ?, ?, ?, ?, ?)', [id, who, !!mgr, text, id, channel]);
  await broadcastChat(channel);
  return getChatMessages(channel);
}

export async function deleteChatMessage(id, channel = 'crew') {
  await pool.query('DELETE FROM chat_messages WHERE id = ? AND channel = ?', [id, channel]);
  await broadcastChat(channel);
  return getChatMessages(channel);
}

function mapSessionRow(row) {
  return {
    sessionId: row.session_id,
    role: row.role,
    name: row.name,
    court: row.court,
    ip: row.ip,
    userAgent: row.user_agent,
    os: row.os,
    browser: row.browser,
    device: row.device,
    loginAt: Number(row.login_at),
    lastActivityAt: Number(row.last_activity_at),
    logoutAt: row.logout_at === null ? null : Number(row.logout_at),
    active: !!row.active
  };
}

const MAX_SESSION_ENTRIES = 500;

export async function recordLogin({ sessionId, role, name, court, ip, userAgent, os, browser, device }) {
  const now = Date.now();
  await pool.query(
    `INSERT INTO sessions (session_id, role, name, court, ip, user_agent, os, browser, device, login_at, last_activity_at, logout_at, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, TRUE)`,
    [sessionId, role, name || '', court || null, ip || '', userAgent || '', os || '', browser || '', device || '', now, now]
  );

  // Prune oldest ended sessions once history grows past the cap — never
  // removes an active session.
  await pool.query(
    `DELETE FROM sessions WHERE active = FALSE AND session_id NOT IN (
       SELECT session_id FROM (
         SELECT session_id FROM sessions ORDER BY login_at DESC LIMIT ?
       ) keep
     )`,
    [MAX_SESSION_ENTRIES]
  );
}

export async function touchSession(sessionId) {
  await pool.query('UPDATE sessions SET last_activity_at = ? WHERE session_id = ?', [Date.now(), sessionId]);
}

export async function endSession(sessionId) {
  await pool.query('UPDATE sessions SET active = FALSE, logout_at = ? WHERE session_id = ?', [Date.now(), sessionId]);
}

export async function getActiveSessions() {
  const [rows] = await pool.query('SELECT * FROM sessions WHERE active = TRUE');
  return rows.map(mapSessionRow);
}

export async function getLoginHistory(limit = 200) {
  const [rows] = await pool.query('SELECT * FROM sessions ORDER BY login_at DESC LIMIT ?', [limit]);
  return rows.map(mapSessionRow);
}

