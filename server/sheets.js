// server/sheets.js
import { google } from 'googleapis';
import dotenv from 'dotenv';
dotenv.config();

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const jwtClient = new google.auth.JWT({
  email: process.env.GOOGLE_CLIENT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly']
});
const sheets = google.sheets({ version: 'v4', auth: jwtClient });

export async function getDivisionNames() {
  // list sheets metadata and filter hidden
  await jwtClient.authorize();
  const drive = google.drive({ version: 'v3', auth: jwtClient });
  // Alternative: sheets.spreadsheets.get to retrieve sheet metadata
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const names = (meta.data.sheets || [])
    .filter(s => !s.properties.hidden)
    .map(s => s.properties.title);
  return names;
}

export async function getStandings(sheetName) {
  await jwtClient.authorize();
  const range = process.env.STANDINGS_RANGE || 'A2:D20';
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!${range}` });
  const values = resp.data.values || [];
  // map rows to objects (GAS code used different indices)
  const standings = values.map(row => ({
    rank: row[0] || '',
    team: (row[1] || '').toString().trim(),
    record: row[2] || '',
    points: row[3] || ''
  })).filter(s => s.team);
  return standings;
}

export async function getSchedule(sheetName) {
  await jwtClient.authorize();
  const startRow = Number(process.env.SCHEDULE_START_ROW || 74);
  const lastRowResp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:A`
  });
  const lastRow = (lastRowResp.data.values || []).length;
  const numRows = Math.max(0, lastRow - startRow + 1);
  if (numRows <= 0) return [];

  // read columns A:K (1..11)
  const endCol = 'K';
  const range = `${sheetName}!A${startRow}:${endCol}${lastRow}`;
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  const values = resp.data.values || [];

  const schedule = values.map((row, idx) => {
    const rowIndex = startRow + idx;
    const match = (row[0] || '').toString().trim();
    const team1 = (row[1] || '').toString().trim();
    const team2 = (row[2] || '').toString().trim();
    if (!team1 && !team2) return null;
    const court = row[3] || '';
    const roundTimeRaw = row[4];
    const roundTime = roundTimeRaw ? roundTimeRaw : '';
    return {
      match, rowIndex, team1, team2, court, roundTime,
      winner: (row[5] || '').toString().trim(),
      playersRemaining: (row[6] || '').toString().trim(),
      adminName: (row[7] || '').toString().trim(),
      adminWinner: (row[8] || '').toString().trim(),
      adminPlayersRemaining: (row[9] || '').toString().trim(),
      notes: (row[10] || '').toString().trim()
    };
  }).filter(Boolean);

  return schedule;
}

/**
 * Save match result - writes to columns H: L (admin columns) and updates a JSON history column (M).
 * matchData must include: sheetName, rowIndex, adminName, winner, playersRemaining, notes
 */
export async function saveMatchResult(matchData) {
  await jwtClient.authorize();
  const { sheetName, rowIndex, adminName, winner, playersRemaining, notes } = matchData;
  if (!sheetName || !rowIndex) return { success: false, error: 'Invalid sheetName/rowIndex' };

  // Read existing history JSON in column M (col 13)
  const historyRangeA1 = `${sheetName}!M${rowIndex}`;
  const historyResp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: historyRangeA1, valueRenderOption: 'UNFORMATTED_VALUE'
  });
  let historyArray = [];
  const current = (historyResp.data.values || [])[0] && (historyResp.data.values[0][0]);
  if (current) {
    try { historyArray = JSON.parse(current); if (!Array.isArray(historyArray)) historyArray = []; } catch (e) { historyArray = []; }
  }
  historyArray.push({ name: adminName, winner, playersRemaining, notes, date: new Date().toISOString() });

  // Prepare batch update: set admin columns H-K and history column M in one batch
  // Columns H..L are 8..12 (we need H,I,J,K,new Date())
  const valuesForAdmin = [[adminName, winner, playersRemaining, notes, new Date().toISOString()]];
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

  // Use spreadsheets.values.batchUpdate
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: requests
    }
  });

  return { success: true, message: 'Saved' };
}
