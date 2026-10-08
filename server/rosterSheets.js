// server/rosterSheets.js
// Google Sheets adapter for the Roster (Team Management) feature. Reads the Registrations
// spreadsheet into the tab shape rosterCore.js expects, and executes a plan's ops against it
// in the same order Apps Script (RM_Server.gs) does: cell writes, change-log lines, row
// deletes (bottom-up), then row inserts (row numbers shifted for the deletes above them).
//
// Requires ROSTER_SPREADSHEET_ID and the existing Google service account
// (GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY), with the sheet shared to that account as Editor.
import dotenv from 'dotenv';
import { google } from 'googleapis';
import { RM_CFG, rmClean_, rmPlan_, rmVerify_, rmFresh_, rmCleanAction_ } from './rosterCore.js';
dotenv.config();

const TZ = process.env.ROSTER_TZ || 'America/New_York';

let sheetsApi = null;
if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
  try {
    const jwt = new google.auth.JWT({
      email: process.env.GOOGLE_CLIENT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    sheetsApi = google.sheets({ version: 'v4', auth: jwt });
  } catch (e) {
    console.warn('Roster Sheets client not initialized:', e.message || e);
  }
}

export function isRosterConfigured() {
  return !!(sheetsApi && process.env.ROSTER_SPREADSHEET_ID);
}
const sid = () => process.env.ROSTER_SPREADSHEET_ID;

/* ---------- A1 helpers ---------- */

function colLetter(n) { // 1-based
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
const q = (name) => "'" + String(name).replace(/'/g, "''") + "'";
const rangeOf = (tabName, row, col, nCols) => q(tabName) + '!' + colLetter(col) + row + ':' + colLetter(col + nCols - 1) + row;

/* ---------- reading ---------- */

async function readTab(key, required, headerOnly) {
  const name = RM_CFG.TAB[key], hr = RM_CFG.HEADER_ROW[key];
  const res = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: sid(),
    range: headerOnly ? q(name) + '!' + hr + ':' + hr : q(name),
    valueRenderOption: 'FORMATTED_VALUE',
    majorDimension: 'ROWS'
  }).catch((e) => {
    if (/Unable to parse range|not found/i.test(String(e.message))) throw new Error('The tab "' + name + '" was not found.');
    throw e;
  });
  const values = res.data.values || [];
  const hdrRow = headerOnly ? (values[0] || []) : (values[hr - 1] || []);
  const headers = hdrRow.map((h) => rmClean_(h));
  const cols = {};
  headers.forEach((h, i) => { if (h && !(h in cols)) cols[h] = i; });
  let lastCol = headers.length;
  const tab = { name, key, headerRow: hr, cols, lastCol, rows: [] };
  const missing = (required || []).filter((h) => cols[h] == null);
  if (missing.length) throw new Error('Tab "' + name + '" is missing the column(s): ' + missing.join(', ') + '. Team Management finds columns by their header text, so a header must have been renamed.');
  if (!headerOnly) {
    for (let i = hr; i < values.length; i++) { tab.rows.push({ r: i + 1, v: values[i] }); lastCol = Math.max(lastCol, values[i].length); }
    tab.lastCol = lastCol;
  }
  return tab;
}

const valuesOf = (o) => Object.keys(o).map((k) => o[k]);

function nowParts() {
  const parts = {};
  new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date()).forEach((p) => { parts[p.type] = p.value; });
  return parts;
}

/**
 * opts: { pl, wv, hist } — which optional tabs to read (Registrations is always read).
 * hist=true also reads the two history tabs (only add / rename / remove / move write to them).
 */
export async function loadCtx(opts = {}) {
  const { pl = true, wv = true, hist = false } = opts;
  const H = RM_CFG.H, ctx = {};
  const reqPlayers = valuesOf(H.REG);
  const jobs = [readTab('REG', reqPlayers)];
  jobs.push(pl ? readTab('PL', [H.PL.name, H.PL.team, H.PL.div, H.PL.signed, H.PL.key, H.PL.trim]) : null);
  jobs.push(wv ? readTab('WV', [H.WV.typed, H.WV.team, H.WV.found, H.WV.key, H.WV.matched]) : null);
  const withHist = hist && RM_CFG.UPDATE_HISTORY;
  jobs.push(withHist ? readTab('HP', valuesOf(H.HP)) : null);
  jobs.push(withHist ? readTab('HR', [H.HR.team, H.HR.div, H.HR.year]) : null);
  const setP = sheetsApi.spreadsheets.values.get({ spreadsheetId: sid(), range: q(RM_CFG.TAB.SET) + '!A2:B81', valueRenderOption: 'FORMATTED_VALUE' })
    .then((r) => r.data.values || []).catch(() => []);
  const [reg, plT, wvT, hpT, hrT] = await Promise.all(jobs);
  const setRows = await setP;
  ctx.reg = reg; ctx.pl = plT; ctx.wv = wvT; ctx.hp = hpT; ctx.hr = hrT; ctx.log = null;
  if (!rmPlayerColsExist(reg)) throw new Error('No "Player N Name" columns found on the Registrations tab.');
  ctx.settings = {};
  setRows.forEach((r) => { const k = rmClean_(r[0]); if (k && !(k in ctx.settings)) ctx.settings[k] = r[1] == null ? '' : r[1]; }); // first match wins
  const y = parseInt(ctx.settings['Season Year'], 10);
  const np = nowParts();
  ctx.year = isNaN(y) ? Number(np.year) : y;
  ctx.today = np.month + '/' + np.day;
  ctx.nowMs = Date.now();
  ctx.nowStamp = Number(np.month) + '/' + Number(np.day) + '/' + np.year + ' ' + Number(np.hour) + ':' + np.minute + ':' + np.second;
  return ctx;
}
function rmPlayerColsExist(tab) { return Object.keys(tab.cols).some((h) => /^player\s*\d+\s*name/i.test(h)); }

/* ---------- executing a plan ---------- */

let sheetIdCache = null;
async function sheetIds() {
  if (sheetIdCache) return sheetIdCache;
  const r = await sheetsApi.spreadsheets.get({ spreadsheetId: sid(), fields: 'sheets.properties(sheetId,title)' });
  const m = {};
  (r.data.sheets || []).forEach((s) => { m[s.properties.title] = s.properties.sheetId; });
  sheetIdCache = m;
  return m;
}

/** Flagged writes (Paid / Sub Division) must never overwrite a formula. Runs BEFORE anything is written. */
async function guardOps(ctx, ops) {
  const tabs = { REG: ctx.reg, PL: ctx.pl, WV: ctx.wv };
  for (const o of ops) {
    if (o.t === 'set' && o.noFormula) {
      const t = tabs[o.tab];
      const r = await sheetsApi.spreadsheets.values.get({ spreadsheetId: sid(), range: rangeOf(t.name, o.row, o.col, 1), valueRenderOption: 'FORMULA' });
      const f = (((r.data.values || [])[0] || [])[0]);
      if (typeof f === 'string' && f.charAt(0) === '=')
        throw new Error('That cell on ' + t.name + ' (row ' + o.row + ') is a formula, so the app did not change it. Nothing was changed.');
    }
  }
}

async function execute(ctx, ops) {
  const tabs = { REG: ctx.reg, PL: ctx.pl, WV: ctx.wv, HP: ctx.hp, HR: ctx.hr };
  const ids = await sheetIds();

  // 1. plain cell writes, grouped per row so neighbouring cells go in one range (a later op on the same cell wins)
  const byRow = {}, order = [];
  ops.filter((o) => o.t === 'set').forEach((o) => {
    const k = o.tab + '#' + o.row;
    if (!byRow[k]) { byRow[k] = { tab: o.tab, row: o.row, cols: {} }; order.push(k); }
    byRow[k].cols[o.col] = o.value;
  });
  const data = [];
  order.forEach((k) => {
    const g = byRow[k], cols = Object.keys(g.cols).map(Number).sort((a, b) => a - b);
    let i = 0;
    while (i < cols.length) {
      let j = i;
      while (j + 1 < cols.length && cols[j + 1] === cols[j] + 1) j++;
      const vals = [];
      for (let c = i; c <= j; c++) vals.push(g.cols[cols[c]]);
      data.push({ range: rangeOf(tabs[g.tab].name, g.row, cols[i], vals.length), values: [vals] });
      i = j + 1;
    }
  });
  if (data.length) await sheetsApi.spreadsheets.values.batchUpdate({ spreadsheetId: sid(), requestBody: { valueInputOption: 'USER_ENTERED', data } });

  // 2. change-log lines (all in one write)
  const logs = ops.filter((o) => o.t === 'log');
  if (logs.length) {
    const L = await readTab('LOG', valuesOf(RM_CFG.H.LOG), true), LH = RM_CFG.H.LOG;
    const rows = logs.map((o) => {
      const row = new Array(L.lastCol).fill('');
      row[L.cols[LH.ts]] = ctx.nowStamp; row[L.cols[LH.team]] = o.values.team; row[L.cols[LH.change]] = o.values.change;
      row[L.cols[LH.oldv]] = o.values.oldv; row[L.cols[LH.newv]] = o.values.newv;
      return row;
    });
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId: sid(), range: q(RM_CFG.TAB.LOG) + '!A1', valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', requestBody: { values: rows }
    });
  }

  // 3. row deletes, bottom-up per tab so row numbers stay valid
  const dels = ops.filter((o) => o.t === 'deleteRow');
  if (dels.length) {
    const requests = dels.slice().sort((a, b) => b.row - a.row).map((o) => ({
      deleteDimension: { range: { sheetId: ids[tabs[o.tab].name], dimension: 'ROWS', startIndex: o.row - 1, endIndex: o.row } }
    }));
    await sheetsApi.spreadsheets.batchUpdate({ spreadsheetId: sid(), requestBody: { requests } });
  }

  // 4. row inserts. Their row numbers were taken before the deletes above, so shift them up by the rows removed above them.
  for (const o0 of ops.filter((o) => o.t === 'insertRow')) {
    const o = { ...o0 };
    const gone = dels.filter((d) => d.tab === o.tab && d.row < o.row).length;
    const anchorGone = dels.some((d) => d.tab === o.tab && d.row === o.row);
    o.row -= gone;
    if (anchorGone && o.mode === 'after') o.row -= 1;
    const tab = tabs[o.tab], sheetId = ids[tab.name], width = tab.lastCol;
    let srcFormulas = null;
    if (o.copyFormulas && o.row >= 1) {
      const r = await sheetsApi.spreadsheets.values.get({ spreadsheetId: sid(), range: rangeOf(tab.name, o.row, 1, width), valueRenderOption: 'FORMULA' });
      srcFormulas = (r.data.values || [])[0] || [];
    }
    let newRow, srcRowAfter;
    if (o.mode === 'after') { newRow = o.row + 1; srcRowAfter = o.row; }
    else { newRow = o.row; srcRowAfter = o.row + 1; }
    await sheetsApi.spreadsheets.batchUpdate({ spreadsheetId: sid(), requestBody: { requests: [{
      insertDimension: { range: { sheetId, dimension: 'ROWS', startIndex: newRow - 1, endIndex: newRow }, inheritFromBefore: false }
    }] } });
    const written = {};
    Object.keys(o.values).forEach((h) => { const c = tab.cols[h]; if (c != null) written[c + 1] = o.values[h]; });
    const cols = Object.keys(written).map(Number).sort((a, b) => a - b);
    const wdata = [];
    let i = 0;
    while (i < cols.length) {
      let j = i;
      while (j + 1 < cols.length && cols[j + 1] === cols[j] + 1) j++;
      const vals = [];
      for (let c = i; c <= j; c++) vals.push(written[cols[c]]);
      wdata.push({ range: rangeOf(tab.name, newRow, cols[i], vals.length), values: [vals] });
      i = j + 1;
    }
    if (wdata.length) await sheetsApi.spreadsheets.values.batchUpdate({ spreadsheetId: sid(), requestBody: { valueInputOption: 'USER_ENTERED', data: wdata } });
    if (srcFormulas) { // copy formula columns (Waiver Name Found, Last year?, ...) from the neighbouring row; relative references shift like a paste
      const requests = [];
      srcFormulas.forEach((f, c) => {
        if (written[c + 1] !== undefined) return;
        if (typeof f === 'string' && f.charAt(0) === '=') requests.push({ copyPaste: {
          source: { sheetId, startRowIndex: srcRowAfter - 1, endRowIndex: srcRowAfter, startColumnIndex: c, endColumnIndex: c + 1 },
          destination: { sheetId, startRowIndex: newRow - 1, endRowIndex: newRow, startColumnIndex: c, endColumnIndex: c + 1 },
          pasteType: 'PASTE_FORMULA', pasteOrientation: 'NORMAL'
        } });
      });
      if (requests.length) await sheetsApi.spreadsheets.batchUpdate({ spreadsheetId: sid(), requestBody: { requests } });
    }
  }
}

/** Participant List B1 is =COUNTA(Participants[Team]); if it disagrees with the rows, the table didn't grow/shrink. */
async function tableCheck(ctx) {
  try {
    if (!ctx.pl) return null;
    const rng = q(RM_CFG.TAB.PL) + '!B1';
    const [f, d] = await Promise.all([
      sheetsApi.spreadsheets.values.get({ spreadsheetId: sid(), range: rng, valueRenderOption: 'FORMULA' }),
      sheetsApi.spreadsheets.values.get({ spreadsheetId: sid(), range: rng, valueRenderOption: 'FORMATTED_VALUE' })
    ]);
    const formula = String((((f.data.values || [])[0]) || [])[0] || '');
    if (!/participants\s*\[/i.test(formula)) return null;
    const shown = parseInt((((d.data.values || [])[0]) || [])[0], 10);
    let real = 0;
    const colTeam = ctx.pl.cols[RM_CFG.H.PL.team];
    ctx.pl.rows.forEach((r) => { if (rmClean_(r.v[colTeam])) real++; });
    return { ok: shown === real, msg: shown === real ? 'The Participants table has ' + real + ' rows (matches the count at the top of the tab)'
      : 'The count at the top of Participant List says ' + shown + ' but there are ' + real + ' rows — the "Participants" table may not have grown. Check that the new row is inside the table.' };
  } catch (e) { return null; }
}

/* ---------- one write at a time (the Apps Script LockService equivalent; the app is a single process) ---------- */

let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

/* ---------- API used by the routes ---------- */

export async function getRosterData() {
  const ctx = await loadCtx({ pl: true, wv: true, hist: false });
  return { ok: true, ...rmFresh_(ctx) };
}

const isHeader = (a) => a.type === 'setPaid' || a.type === 'setSub';

export async function previewAction(action) {
  const a = rmCleanAction_(action);
  const ctx = await loadCtx(isHeader(a) ? { pl: false, wv: false } : { hist: true });
  const p = rmPlan_(ctx, a);
  return { ok: true, title: p.title, confirmLabel: p.confirmLabel, danger: p.danger, errors: p.errors, warnings: p.warnings, changes: p.changes, options: p.options };
}

export function applyAction(action) {
  return withLock(async () => {
    let started = false;
    try {
      const a = rmCleanAction_(action);
      const header = isHeader(a);
      const ctx = await loadCtx(header ? { pl: false, wv: false } : { hist: true });
      const p = rmPlan_(ctx, a);
      if (p.errors.length) return { ok: false, errors: p.errors };
      // One click only when nothing needs a second look. Warnings the page already showed on its confirm line (p.soft) are covered by ack.
      const regChoice = (a.type === 'edit' || a.type === 'delete') && !p.meta.regChanged && !a.regName && p.options && p.options.regCandidates && p.options.regCandidates.length > 0;
      const hardWarn = p.warnings.filter((w) => (p.soft || []).indexOf(w) < 0);
      if (a.quick && ((a.ack ? hardWarn.length : p.warnings.length) || regChoice)) return { ok: false, needsReview: true, errors: [] };
      await guardOps(ctx, p.ops);
      started = true;
      await execute(ctx, p.ops);
      // ONE re-read after the write verifies the change and is also the page's fresh state (no history tabs).
      const ctx2 = await loadCtx(header ? { pl: false, wv: false } : {});
      const checks = rmVerify_(ctx2, a, p);
      if (p.ops.some((o) => o.t === 'insertRow' || o.t === 'deleteRow')) { const tc = await tableCheck(ctx2); if (tc) checks.push(tc); }
      const res = { ok: true, title: p.title, changes: p.changes, warnings: p.warnings, checks, allGood: checks.every((c) => c.ok) };
      if (!header) res.fresh = rmFresh_(ctx2);
      else res.value = p.meta.value;
      return res;
    } catch (e) {
      return { ok: false, errors: ['Something went wrong: ' + (e && e.message ? e.message : e) +
        (started ? ' — the sheet may be partly updated. Check the Roster Change Log and File ▸ Version history before trying again.' : '')] };
    }
  });
}
