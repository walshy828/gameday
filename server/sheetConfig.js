// server/sheetConfig.js
// Reads the GONK_SHEET_CONFIG block (columns AA:AB, rows 1-100) that the
// schedule-generator Apps Script writes into every division tab (v2 and v3
// templates alike) and shapes a tab's standings/schedule rows from it. See
// the "Gonk Dodgeball: Sheet Config Block" reference doc for the full key
// list and conventions.
//
// A tab without the block (predates its install) falls back to the
// hardcoded legacy ranges/columns this app used before the config block
// existed — flagged with `legacy: true` so callers can surface it rather
// than silently guessing forever.

const CONFIG_MARKER = 'GONK_SHEET_CONFIG';
const SUPPORTED_SCHEMA = '1';

const LEGACY_STANDINGS_RANGE = process.env.STANDINGS_RANGE || 'A2:D20';
const LEGACY_SCHEDULE_START_ROW = Number(process.env.SCHEDULE_START_ROW || 74);

/** 'A' -> 0, 'N' -> 13, 'AA' -> 26, ... */
function colLetterToIndex(letter) {
  let n = 0;
  for (const ch of letter.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

/** 'A5:D28' -> { startCol: 'A', startColIndex: 0, startRow: 5, endCol: 'D', endRow: 28 } */
function parseRange(a1) {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec((a1 || '').trim());
  if (!m) return null;
  return {
    startCol: m[1], startColIndex: colLetterToIndex(m[1]), startRow: Number(m[2]),
    endCol: m[3], endColIndex: colLetterToIndex(m[3]), endRow: Number(m[4])
  };
}

/**
 * Read a tab's config block. Returns `null` if the tab has no marker/an
 * unsupported schema (caller falls back to legacy ranges).
 */
export async function readSheetConfig(sheetsApi, spreadsheetId, tabName) {
  let resp;
  try {
    resp = await sheetsApi.spreadsheets.values.get({
      spreadsheetId, range: `'${tabName}'!AA1:AB100`, valueRenderOption: 'FORMATTED_VALUE'
    });
  } catch (e) {
    // A tab that isn't shaped like a division tab at all (e.g. a utility/
    // control sheet with fewer than 27 columns) can't even be asked for
    // AA1:AB100 — the Sheets API rejects the range outright ("exceeds grid
    // limits"). Treat that the same as "no config block found" rather than
    // letting it abort the whole sync.
    return null;
  }
  const rows = resp.data.values || [];
  if (!rows[0] || rows[0][0] !== CONFIG_MARKER || String(rows[0][1]) !== SUPPORTED_SCHEMA) return null;

  const cfg = {};
  for (const row of rows) {
    const key = row[0];
    if (!key || key.startsWith('#')) continue;
    cfg[key] = row[1] ?? '';
  }
  return cfg;
}

function buildRowMapper(cfg, startColIndex) {
  const at = (row, key) => {
    const letter = cfg[key];
    if (!letter) return '';
    return (row[colLetterToIndex(letter) - startColIndex] ?? '').toString().trim();
  };
  return at;
}

async function readStandingsGroup(sheetsApi, spreadsheetId, tabName, range, label) {
  if (!range) return [];
  const resp = await sheetsApi.spreadsheets.values.get({
    spreadsheetId, range: `'${tabName}'!${range}`
  });
  const values = resp.data.values || [];
  return values.map(row => ({
    rank: row[0] || '',
    team: (row[1] || '').toString().trim(),
    record: row[2] || '',
    points: row[3] || '',
    subDivision: label || ''
  })).filter(s => s.team);
}

/** Config-driven standings read: one or two labeled groups per `sub_division_count`. */
async function readStandingsConfigDriven(sheetsApi, spreadsheetId, tabName, cfg) {
  if (cfg.sub_division_count === '2') {
    const [group1, group2] = await Promise.all([
      readStandingsGroup(sheetsApi, spreadsheetId, tabName, cfg.standings_1_range, cfg.sub_division_1_label),
      readStandingsGroup(sheetsApi, spreadsheetId, tabName, cfg.standings_2_range, cfg.sub_division_2_label)
    ]);
    return [...group1, ...group2];
  }
  return readStandingsGroup(sheetsApi, spreadsheetId, tabName, cfg.standings_1_range, '');
}

/** Config-driven schedule read: one ranged fetch, columns resolved via col_* keys. */
async function readScheduleConfigDriven(sheetsApi, spreadsheetId, tabName, cfg) {
  const range = parseRange(cfg.results_data_range);
  if (!range) return [];

  const resp = await sheetsApi.spreadsheets.values.get({
    spreadsheetId, range: `'${tabName}'!${cfg.results_data_range}`, valueRenderOption: 'FORMATTED_VALUE'
  });
  const values = resp.data.values || [];
  const at = buildRowMapper(cfg, range.startColIndex);
  const firstRow = Number(cfg.results_first_row) || range.startRow;
  const hasSubDivision = cfg.has_sub_division_column === 'yes';

  return values.map((row, idx) => {
    const match = at(row, 'col_match_id');
    const team1 = at(row, 'col_team1');
    const team2 = at(row, 'col_team2');
    if (!match) return null;
    return {
      rowIndex: firstRow + idx,
      match,
      team1,
      team2,
      subDivision: hasSubDivision ? at(row, 'col_sub_division') : '',
      court: at(row, 'col_court'),
      roundTime: at(row, 'col_time'),
      winner: at(row, 'col_official_winner'),
      playersRemaining: at(row, 'col_official_players'),
      adminName: at(row, 'col_submitted_name'),
      adminWinner: at(row, 'col_submitted_winner'),
      adminPlayersRemaining: at(row, 'col_submitted_players'),
      notes: at(row, 'col_submitted_notes')
    };
  }).filter(Boolean);
}

async function readStandingsLegacy(sheetsApi, spreadsheetId, tabName) {
  const resp = await sheetsApi.spreadsheets.values.get({
    spreadsheetId, range: `'${tabName}'!${LEGACY_STANDINGS_RANGE}`
  });
  const values = resp.data.values || [];
  return values.map(row => ({
    rank: row[0] || '',
    team: (row[1] || '').toString().trim(),
    record: row[2] || '',
    points: row[3] || '',
    subDivision: ''
  })).filter(s => s.team);
}

async function readScheduleLegacy(sheetsApi, spreadsheetId, tabName) {
  const startRow = LEGACY_SCHEDULE_START_ROW;
  const lastRowResp = await sheetsApi.spreadsheets.values.get({
    spreadsheetId, range: `'${tabName}'!A:A`
  });
  const lastRow = (lastRowResp.data.values || []).length;
  const numRows = Math.max(0, lastRow - startRow + 1);
  if (numRows <= 0) return [];

  const range = `'${tabName}'!A${startRow}:K${lastRow}`;
  const resp = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range });
  const values = resp.data.values || [];

  return values.map((row, idx) => {
    const team1 = (row[1] || '').toString().trim();
    const team2 = (row[2] || '').toString().trim();
    if (!team1 && !team2) return null;
    return {
      match: row[0] || '',
      rowIndex: startRow + idx,
      team1, team2,
      subDivision: '',
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
 * Read a tab's standings + schedule, config-driven when the tab carries a
 * GONK_SHEET_CONFIG block, falling back to the legacy hardcoded ranges when
 * it doesn't. Returns `{ standings, schedule, legacy, config }`.
 */
export async function readTabData(sheetsApi, spreadsheetId, tabName) {
  const config = await readSheetConfig(sheetsApi, spreadsheetId, tabName);
  if (!config) {
    const [standings, schedule] = await Promise.all([
      readStandingsLegacy(sheetsApi, spreadsheetId, tabName),
      readScheduleLegacy(sheetsApi, spreadsheetId, tabName)
    ]);
    return { standings, schedule, legacy: true, config: null };
  }

  const [standings, schedule] = await Promise.all([
    readStandingsConfigDriven(sheetsApi, spreadsheetId, tabName, config),
    readScheduleConfigDriven(sheetsApi, spreadsheetId, tabName, config)
  ]);
  return { standings, schedule, legacy: false, config };
}

export { colLetterToIndex };
