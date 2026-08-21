-- server/datastores/schema.sql
-- Schema for DATA_BACKEND=local (MariaDB as primary datastore).
-- Auto-applied by the `db` docker-compose service on first container start
-- (mounted into /docker-entrypoint-initdb.d).

CREATE TABLE IF NOT EXISTS divisions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(191) NOT NULL UNIQUE,
  sort_order INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS standings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  division VARCHAR(191) NOT NULL,
  rnk VARCHAR(16),
  team VARCHAR(191) NOT NULL,
  record VARCHAR(64),
  points VARCHAR(64),
  sort_order INT NOT NULL DEFAULT 0,
  INDEX idx_standings_division (division)
);

-- One row per schedule/match entry. `match_index` is the ordering key
-- returned to the frontend as `firebaseIndex` (kept for API/field-name
-- compatibility with the existing frontend, which is unaware of the
-- backend in use).
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
);

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
);

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
);

-- Superadmin Settings page: Google Sheet sync toggle/interval/scope, single row.
-- sync_scope is 'all' (every division tab in the sheet) or 'selected'
-- (only the divisions listed in selected_divisions, a JSON array of names).
CREATE TABLE IF NOT EXISTS sync_settings (
  id INT PRIMARY KEY DEFAULT 1,
  auto_sync_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  interval_seconds INT NOT NULL DEFAULT 300,
  sync_scope VARCHAR(16) NOT NULL DEFAULT 'all',
  selected_divisions TEXT NULL,
  spreadsheet_id VARCHAR(191) NULL
);

-- Superadmin Settings page: log of each Google Sheet sync attempt.
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
);

-- Tournament-wide (not division-scoped) announcement banner, managed from
-- the Setup screen. `id` is a client-generated Date.now() millisecond
-- timestamp, matching the id scheme used by the Firebase-backed announcements
-- node so both backends order/compare ids the same way.
CREATE TABLE IF NOT EXISTS announcements (
  id BIGINT PRIMARY KEY,
  text TEXT NOT NULL,
  ts BIGINT NOT NULL,
  is_on BOOLEAN NOT NULL DEFAULT TRUE,
  INDEX idx_announcements_ts (ts)
);

-- Tournament-wide staff-only crew chat. `mgr` marks a tournament-manager
-- (superadmin) message — used client-side for the CHAT tab's unread-dot
-- color rule (red if any unread message has mgr=true, maroon otherwise).
CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGINT PRIMARY KEY,
  who VARCHAR(191) NOT NULL,
  is_mgr BOOLEAN NOT NULL DEFAULT FALSE,
  text TEXT NOT NULL,
  ts BIGINT NOT NULL,
  INDEX idx_chat_ts (ts)
);

-- Existing audit-log table (already written to unconditionally by
-- server/mariadb.js regardless of DATA_BACKEND) — shape unchanged.
CREATE TABLE IF NOT EXISTS gameday_submissions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(191),
  winner VARCHAR(191),
  playersremaining VARCHAR(64),
  notes TEXT,
  Date DATETIME,
  division VARCHAR(191),
  rowindex INT
);
