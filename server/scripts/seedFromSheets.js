// server/scripts/seedFromSheets.js
// Standalone maintenance script: pulls every visible worksheet (division)
// from the Google Sheet at SPREADSHEET_ID and does a full replace of that
// division's standings/schedule rows in MariaDB. Run with `npm run seed:sheets`.
import dotenv from 'dotenv';
import { google } from 'googleapis';
import { pool } from '../db.js';
import { readTabData } from '../sheetConfig.js';

dotenv.config();

const SPREADSHEET_ID = process.env.SPREADSHEET_ID || null;

if (!SPREADSHEET_ID || !process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
  console.error('seedFromSheets: SPREADSHEET_ID, GOOGLE_CLIENT_EMAIL, and GOOGLE_PRIVATE_KEY must all be set.');
  process.exit(1);
}

const jwtClient = new google.auth.JWT({
  email: process.env.GOOGLE_CLIENT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.readonly'
  ]
});
const sheetsApi = google.sheets({ version: 'v4', auth: jwtClient });

async function getDivisionNames() {
  const meta = await sheetsApi.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  return (meta.data.sheets || [])
    .filter(s => !s.properties.hidden)
    .map(s => s.properties.title);
}

async function seedDivision(sheetName, sortOrder) {
  const { standings, schedule: scheduleRaw, legacy } = await readTabData(sheetsApi, SPREADSHEET_ID, sheetName);
  if (legacy) console.log(`  ${sheetName}: no GONK_SHEET_CONFIG block found — using legacy fallback ranges`);
  const schedule = scheduleRaw.map((m, matchIndex) => ({ ...m, isBye: !m.team1 || !m.team2, matchIndex }));

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      'INSERT INTO divisions (name, sort_order) VALUES (?, ?) ON DUPLICATE KEY UPDATE sort_order = VALUES(sort_order)',
      [sheetName, sortOrder]
    );

    await conn.query('DELETE FROM standings WHERE division = ?', [sheetName]);
    for (const [i, s] of standings.entries()) {
      await conn.query(
        'INSERT INTO standings (division, rnk, team, record, points, sort_order, sub_division) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [sheetName, s.rank, s.team, s.record, s.points, i, s.subDivision || '']
      );
    }

    await conn.query('DELETE FROM schedule WHERE division = ?', [sheetName]);
    for (const m of schedule) {
      await conn.query(
        `INSERT INTO schedule
           (division, match_index, round_time, court, match_number, team1, team2, is_bye,
            winner, players_remaining, row_index, adminName, adminWinner, adminPlayersRemaining, notes, sub_division)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sheetName, m.matchIndex, m.roundTime, m.court, m.match, m.team1, m.team2, m.isBye,
          m.winner, m.playersRemaining, m.rowIndex, m.adminName, m.adminWinner, m.adminPlayersRemaining, m.notes,
          m.subDivision || ''
        ]
      );
    }

    await conn.commit();
    return { standings: standings.length, schedule: schedule.length };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function main() {
  await jwtClient.authorize();
  const divisionNames = await getDivisionNames();
  console.log(`Found ${divisionNames.length} division(s): ${divisionNames.join(', ')}`);

  let totalStandings = 0;
  let totalSchedule = 0;
  let failures = 0;

  for (const [i, sheetName] of divisionNames.entries()) {
    try {
      const { standings, schedule } = await seedDivision(sheetName, i);
      totalStandings += standings;
      totalSchedule += schedule;
      console.log(`  ${sheetName}: ${standings} standings rows, ${schedule} schedule rows`);
    } catch (e) {
      failures += 1;
      console.error(`  ${sheetName}: FAILED — ${e.message || e}`);
    }
  }

  console.log(`Done. ${totalStandings} standings rows, ${totalSchedule} schedule rows written across ${divisionNames.length - failures}/${divisionNames.length} division(s).`);
  await pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('seedFromSheets: fatal error', e);
  process.exit(1);
});
