// server/rosterSheets.js
// Google Sheets adapter for the Roster (Team Management) feature. Reads the Registrations
// spreadsheet into the tab shape rosterCore.js expects, and applies a plan's ops the way Apps Script
// (RM_Server.gs) does: cell writes, change-log lines, row deletes (bottom-up), then row inserts
// (row numbers shifted for the deletes above them).
//
// Built to stay well inside the Sheets API quota (about 60 reads and 60 writes per minute for the
// service account, shared by everyone):
//   * ONE batchGet reads every tab an action needs (not one request per tab).
//   * What the screens show comes from a server cache that lasts until someone presses Refresh or a
//     write happens (plus a safety max age). A cache is NEVER used to decide where a write goes:
//     a form submission or the Apps Script tool can move rows at any time, so every write starts
//     from a fresh read of the rows it touches.
//   * ONE atomic spreadsheets.batchUpdate applies a whole action (cells, log line, row inserts and
//     deletes, formula copy-down, new columns / tab), so an action either fully applies or doesn't.
//   * The post-write check re-reads once, and that read doubles as the cache refresh.
//   * Structural facts (tab ids, log headers, which columns hold formulas) are cached.
//   * Calls are throttled under the quota and retried with backoff on "too many requests".
//
// Requires ROSTER_SPREADSHEET_ID and the existing Google service account
// (GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY), with the sheet shared to that account as Editor.
import dotenv from 'dotenv';
import { google } from 'googleapis';
import {
  RM_CFG, rmClean_, rmNK_, rmG_, rmFindTeam_, rmCheckin_, rmSafeText_, rmPlan_, rmVerify_, rmFresh_, rmCleanAction_
} from './rosterCore.js';
dotenv.config();

let sheets = null;
if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
  try {
    const jwt = new google.auth.JWT({
      email: process.env.GOOGLE_CLIENT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    sheets = google.sheets({ version: 'v4', auth: jwt });
  } catch (e) {
    console.warn('Roster Sheets client not initialized:', e.message || e);
  }
}

export function isRosterConfigured() {
  return !!(sheets && process.env.ROSTER_SPREADSHEET_ID);
}
const sid = () => process.env.ROSTER_SPREADSHEET_ID;

/* ---------- tunables ---------- */

const MAX_AGE_MS = (Number(process.env.ROSTER_CACHE_SECONDS) || 300) * 1000;   // safety net: re-read at least this often
const STRUCT_TTL_MS = 15 * 60 * 1000;                                           // tab ids, headers, formula columns
const MIN_REFRESH_MS = 2000;                                                    // a Refresh within this of the last read reuses it
const QUOTA_PER_MIN = Number(process.env.ROSTER_MAX_REQUESTS_PER_MIN) || 50;    // stay under Google's 60 per kind per minute
const MAX_QUEUE_WAIT_MS = 25000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const valuesOf = (o) => Object.keys(o).map((k) => o[k]);

/* ---------- throttled, retrying API calls ---------- */

const stamps = { read: [], write: [] };
async function throttle(kind) {
  for (;;) {
    const now = Date.now(), a = stamps[kind];
    while (a.length && now - a[0] >= 60000) a.shift();
    if (a.length < QUOTA_PER_MIN) { a.push(now); return; }
    const wait = 60000 - (now - a[0]) + 50;
    if (wait > MAX_QUEUE_WAIT_MS) throw new Error('Google Sheets is busy (too many requests right now). Wait a few seconds and try again.');
    await sleep(wait);
  }
}
const statusOf = (e) => e && (e.code || (e.response && e.response.status));

/** Reads retry on 429 and 5xx. Writes retry only on 429 (not processed), so an action is never applied twice. */
async function call(kind, fn) {
  await throttle(kind);
  let delay = 1500;
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      const code = statusOf(e);
      const retryable = code === 429 || (kind === 'read' && (code === 500 || code === 502 || code === 503));
      if (retryable && i < 3) { await sleep(delay); delay *= 2; continue; }
      if (code === 429) throw new Error('Google Sheets is busy (too many requests right now). Wait a few seconds and try again.');
      throw e;
    }
  }
}
async function batchGet(ranges, render = 'FORMATTED_VALUE') {
  const r = await call('read', () => sheets.spreadsheets.values.batchGet({ spreadsheetId: sid(), ranges, valueRenderOption: render, majorDimension: 'ROWS' }));
  return r.data.valueRanges || [];
}
async function batchUpdate(requests) {
  if (!requests.length) return null;
  return call('write', () => sheets.spreadsheets.batchUpdate({ spreadsheetId: sid(), requestBody: { requests } }));
}
const STALE_RE = /No grid with id|Invalid sheetId|already exists|Invalid requests\[\d+\]\.(updateCells|appendCells|copyPaste|deleteDimension|insertDimension)/i;

/* ---------- A1 helpers ---------- */

const q = (name) => "'" + String(name).replace(/'/g, "''") + "'";

/* ---------- time (in the spreadsheet's own time zone, like Apps Script's new Date()) ---------- */

function wall(tz, d = new Date()) {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(d).forEach((x) => { p[x.type] = x.value; });
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour % 24, mm: +p.minute, ss: +p.second };
}
/** Sheets date-time serial for the wall-clock time in tz. */
function serialNow(tz, d = new Date()) {
  const w = wall(tz, d);
  return Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss) / 86400000 + 25569;
}
/** "10/8 9:15 AM", the shape the sheet's Check-In Time cell displays. */
function shownTime(tz, d = new Date()) {
  const w = wall(tz, d), h12 = w.hh % 12 || 12;
  return w.m + '/' + w.d + ' ' + h12 + ':' + String(w.mm).padStart(2, '0') + ' ' + (w.hh < 12 ? 'AM' : 'PM');
}

/* ---------- structural caches (tab ids, headers, formula columns) ---------- */

let metaC = null, hdrC = {}, fcolC = {}, b1C = null;
function invalidateStructure() { metaC = null; hdrC = {}; fcolC = {}; b1C = null; }
const fresh_ = (c) => c && Date.now() - c.at < STRUCT_TTL_MS;

async function getMeta() {
  if (fresh_(metaC)) return metaC;
  const r = await call('read', () => sheets.spreadsheets.get({
    spreadsheetId: sid(), fields: 'properties.timeZone,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))'
  }));
  const ids = {}, grid = {};
  (r.data.sheets || []).forEach((s) => { ids[s.properties.title] = s.properties.sheetId; grid[s.properties.title] = s.properties.gridProperties || {}; });
  metaC = { at: Date.now(), ids, grid, tz: process.env.ROSTER_TZ || r.data.properties.timeZone || 'America/New_York' };
  return metaC;
}

/** Header row (row 1) of a log tab: header text -> 0-based column, and its width. */
async function getHeader(key, tabName) {
  if (fresh_(hdrC[key])) return hdrC[key];
  const [vr] = await batchGet([q(tabName) + '!1:1']);
  const hdr = ((vr.values || [])[0] || []).map(rmClean_), cols = {};
  hdr.forEach((h, i) => { if (h && !(h in cols)) cols[h] = i; });
  hdrC[key] = { at: Date.now(), cols, width: hdr.length };
  return hdrC[key];
}

/** 0-based columns of a tab whose cell on a data row holds a formula (copied down when a row is inserted, like Apps Script does). */
async function getFormulaCols(key, tab, sampleRow) {
  if (fresh_(fcolC[key])) return fcolC[key].cols;
  const [vr] = await batchGet([q(tab.name) + '!' + sampleRow + ':' + sampleRow], 'FORMULA');
  const cols = [];
  ((vr.values || [])[0] || []).forEach((f, c) => { if (typeof f === 'string' && f.charAt(0) === '=') cols.push(c); });
  if (sampleRow > tab.headerRow) fcolC[key] = { at: Date.now(), cols };
  return cols;
}

/** Is Participant List B1 the =COUNTA(Participants[Team]) check? Cached. */
async function b1IsTable() {
  if (fresh_(b1C)) return b1C.is;
  const [vr] = await batchGet([q(RM_CFG.TAB.PL) + '!B1'], 'FORMULA');
  const f = String((((vr.values || [])[0]) || [])[0] || '');
  b1C = { at: Date.now(), is: /participants\s*\[/i.test(f) };
  return b1C.is;
}

/* ---------- reading ---------- */

function parseTab(key, values, required, headerOnly) {
  const name = RM_CFG.TAB[key], hr = RM_CFG.HEADER_ROW[key];
  const hdrRow = values[headerOnly ? 0 : hr - 1] || [];
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

/** ONE batchGet for everything an action needs. hist=true also reads the two history tabs (only roster edits write to them). */
async function readSnapshot({ hist = false } = {}) {
  const meta = await getMeta();
  const T = RM_CFG.TAB, H = RM_CFG.H;
  const withHist = hist && RM_CFG.UPDATE_HISTORY;
  const need = ['REG', 'PL', 'WV'].concat(withHist ? ['HP', 'HR'] : []);
  need.forEach((k) => { if (meta.ids[T[k]] == null) throw new Error('The tab "' + T[k] + '" was not found.'); });
  const parts = need.map((k) => [k, q(T[k])]);
  if (meta.ids[T.SET] != null) parts.push(['SET', q(T.SET) + '!A2:B81']);
  parts.push(['B1', q(T.PL) + '!B1']);
  const vr = await batchGet(parts.map((p) => p[1]));
  const by = {};
  parts.forEach((p, i) => { by[p[0]] = (vr[i] && vr[i].values) || []; });
  const ctx = { log: null };
  ctx.reg = parseTab('REG', by.REG, valuesOf(H.REG));
  if (!Object.keys(ctx.reg.cols).some((h) => /^player\s*\d+\s*name/i.test(h))) throw new Error('No "Player N Name" columns found on the Registrations tab.');
  ctx.pl = parseTab('PL', by.PL, [H.PL.name, H.PL.team, H.PL.div, H.PL.signed, H.PL.key, H.PL.trim]);
  ctx.wv = parseTab('WV', by.WV, [H.WV.typed, H.WV.team, H.WV.found, H.WV.key, H.WV.matched]);
  ctx.hp = withHist ? parseTab('HP', by.HP, valuesOf(H.HP)) : null;
  ctx.hr = withHist ? parseTab('HR', by.HR, [H.HR.team, H.HR.div, H.HR.year]) : null;
  ctx.settings = {};
  (by.SET || []).forEach((r) => { const k = rmClean_(r[0]); if (k && !(k in ctx.settings)) ctx.settings[k] = r[1] == null ? '' : r[1]; });   // first match wins
  const y = parseInt(ctx.settings['Season Year'], 10);
  const w = wall(meta.tz);
  ctx.year = isNaN(y) ? w.y : y;
  ctx.today = String(w.m).padStart(2, '0') + '/' + String(w.d).padStart(2, '0');
  ctx.nowMs = Date.now();
  ctx.tz = meta.tz;
  ctx.b1 = String((((by.B1 || [])[0]) || [])[0] || '');
  return ctx;
}

/* ---------- the display cache ---------- */

let snap = null;            // { ctx, at } - what the screens show; never used to place a write
let snapInflight = null;
let freshMemo = null;       // { of, data } - rmFresh_ of snap
let logC = null;            // { at, byTeam } - the Check-In Log tab, grouped by team (newest first)

function setSnap(ctx) { snap = { ctx, at: Date.now() }; freshMemo = null; }

/** Display snapshot: cached until Refresh / a write / the safety max age. Concurrent callers share one read. */
async function getSnapshot({ refresh = false, force = false } = {}) {
  const age = snap ? Date.now() - snap.at : Infinity;
  if (!force && snap && (refresh ? age < MIN_REFRESH_MS : age < MAX_AGE_MS)) return snap.ctx;
  if (snapInflight) return snapInflight;
  snapInflight = (async () => {
    try {
      if (refresh || force) { invalidateStructure(); logC = null; }
      const ctx = await readSnapshot({ hist: false });
      setSnap(ctx);
      return ctx;
    } finally { snapInflight = null; }
  })();
  return snapInflight;
}

/** Keep the display cache in step with a cell we just wrote (no re-read needed). */
function patchCache(ctx, rowNo, colIdx, value) {
  if (!snap || snap.ctx !== ctx || colIdx == null || colIdx < 0) return;
  const row = ctx.reg.rows.find((r) => r.r === rowNo);
  if (!row) return;
  while (row.v.length <= colIdx) row.v.push('');
  row.v[colIdx] = value == null ? '' : String(value);
  freshMemo = null;
}

/* ---------- API for the routes: reading ---------- */

export async function getRosterData({ refresh = false } = {}) {
  const ctx = await getSnapshot({ refresh });
  if (!freshMemo || freshMemo.of !== snap.at) freshMemo = { of: snap.at, data: rmFresh_(ctx) };
  return { ok: true, ...freshMemo.data, ageMs: Date.now() - snap.at };
}

const isHeader = (a) => a.type === 'setPaid' || a.type === 'setSub';

export async function previewAction(action) {
  const a = rmCleanAction_(action);
  const ctx = await readSnapshot({ hist: !isHeader(a) });
  const p = rmPlan_(ctx, a);
  return { ok: true, title: p.title, confirmLabel: p.confirmLabel, danger: p.danger, errors: p.errors, warnings: p.warnings, changes: p.changes, options: p.options };
}

/* ---------- one write at a time (the Apps Script LockService equivalent; the app is a single process) ---------- */

let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

/* ---------- building write requests ---------- */

/** A cell for updateCells. '' / null clears the cell; numbers stay numbers; everything else is text. */
function cv(v) {
  if (v === '' || v == null) return {};
  if (typeof v === 'number') return { userEnteredValue: { numberValue: v } };
  return { userEnteredValue: { stringValue: String(v) } };
}
const cellsAt = (sheetId, row, col, vals) => ({
  updateCells: { start: { sheetId, rowIndex: row - 1, columnIndex: col - 1 }, rows: [{ values: vals.map(cv) }], fields: 'userEnteredValue' }
});
/** Runs of neighbouring columns on one row -> one updateCells each. byCol is { 1-based col: value }. */
function runsOf(sheetId, row, byCol) {
  const cols = Object.keys(byCol).map(Number).sort((a, b) => a - b), out = [];
  let i = 0;
  while (i < cols.length) {
    let j = i;
    while (j + 1 < cols.length && cols[j + 1] === cols[j] + 1) j++;
    const vals = [];
    for (let k = i; k <= j; k++) vals.push(byCol[cols[k]]);
    out.push(cellsAt(sheetId, row, cols[i], vals));
    i = j + 1;
  }
  return out;
}
/** Append one line to a log tab. cols maps header text -> 0-based column. The timestamp goes in as a real date-time serial
 *  carrying its own display format, so it reads as a date whatever format the empty row below the log had. */
const LOG_TS_FORMAT = { numberFormat: { type: 'DATE_TIME', pattern: 'M/d/yyyy H:mm:ss' } };
function appendLog(sheetId, cols, width, byHeader, tsHeader, tsFormat) {
  const vals = new Array(width).fill('');
  Object.keys(byHeader).forEach((h) => { if (cols[h] != null) vals[cols[h]] = byHeader[h]; });
  const cells = vals.map(cv);
  if (tsHeader && cols[tsHeader] != null) cells[cols[tsHeader]] = { userEnteredValue: { numberValue: byHeader[tsHeader] }, userEnteredFormat: tsFormat || LOG_TS_FORMAT };
  return { appendCells: { sheetId, rows: [{ values: cells }], fields: 'userEnteredValue,userEnteredFormat.numberFormat' } };
}

/** Turns a plan's ops into requests, in Apps Script's order: cell writes, log lines, deletes (bottom-up), inserts (shifted). */
async function buildRequests(ctx, ops, meta) {
  const tabs = { REG: ctx.reg, PL: ctx.pl, WV: ctx.wv, HP: ctx.hp, HR: ctx.hr };
  const idOf = (k) => meta.ids[tabs[k].name];
  const requests = [];

  // 1. plain cell writes, grouped per row (a later op on the same cell wins)
  const byRow = {}, order = [];
  ops.filter((o) => o.t === 'set').forEach((o) => {
    const k = o.tab + '#' + o.row;
    if (!byRow[k]) { byRow[k] = { tab: o.tab, row: o.row, cols: {} }; order.push(k); }
    byRow[k].cols[o.col] = o.value;
  });
  order.forEach((k) => { const g = byRow[k]; runsOf(idOf(g.tab), g.row, g.cols).forEach((r) => requests.push(r)); });

  // 2. change-log lines
  const logs = ops.filter((o) => o.t === 'log');
  if (logs.length) {
    if (meta.ids[RM_CFG.TAB.LOG] == null) throw new Error('The tab "' + RM_CFG.TAB.LOG + '" was not found.');
    const L = await getHeader('LOG', RM_CFG.TAB.LOG), LH = RM_CFG.H.LOG, serial = serialNow(meta.tz);
    logs.forEach((o) => requests.push(appendLog(meta.ids[RM_CFG.TAB.LOG], L.cols, L.width, {
      [LH.ts]: serial, [LH.team]: o.values.team, [LH.change]: o.values.change, [LH.oldv]: o.values.oldv, [LH.newv]: o.values.newv
    }, LH.ts)));
  }

  // 3. row deletes, bottom-up so row numbers stay valid
  const dels = ops.filter((o) => o.t === 'deleteRow');
  dels.slice().sort((a, b) => b.row - a.row).forEach((o) => requests.push({
    deleteDimension: { range: { sheetId: idOf(o.tab), dimension: 'ROWS', startIndex: o.row - 1, endIndex: o.row } }
  }));

  // 4. row inserts. Their row numbers were taken before the deletes above, so shift them up by the rows removed above them.
  for (const o0 of ops.filter((o) => o.t === 'insertRow')) {
    const o = { ...o0 };
    const gone = dels.filter((d) => d.tab === o.tab && d.row < o.row).length;
    const anchorGone = dels.some((d) => d.tab === o.tab && d.row === o.row);
    const sampleRow = o.row;                                             // as read, before the shifts: a real data row
    o.row -= gone;
    if (anchorGone && o.mode === 'after') o.row -= 1;
    const tab = tabs[o.tab], sheetId = idOf(o.tab);
    const newRow = o.mode === 'after' ? o.row + 1 : o.row;
    const srcRow = o.mode === 'after' ? o.row : o.row + 1;               // the neighbour we copy formulas from, numbered after the insert
    const written = {};
    Object.keys(o.values).forEach((h) => { const c = tab.cols[h]; if (c != null) written[c + 1] = o.values[h]; });
    requests.push({ insertDimension: { range: { sheetId, dimension: 'ROWS', startIndex: newRow - 1, endIndex: newRow }, inheritFromBefore: false } });
    if (o.copyFormulas && sampleRow > tab.headerRow) {                   // formula columns (Waiver Name Found, Last year?, ...) copy down from the neighbour
      const fcols = await getFormulaCols(o.tab, tab, sampleRow);
      fcols.forEach((c) => {
        if (written[c + 1] !== undefined) return;
        requests.push({ copyPaste: {
          source: { sheetId, startRowIndex: srcRow - 1, endRowIndex: srcRow, startColumnIndex: c, endColumnIndex: c + 1 },
          destination: { sheetId, startRowIndex: newRow - 1, endRowIndex: newRow, startColumnIndex: c, endColumnIndex: c + 1 },
          pasteType: 'PASTE_FORMULA', pasteOrientation: 'NORMAL'
        } });
      });
    }
    runsOf(sheetId, newRow, written).forEach((r) => requests.push(r));
  }
  return requests;
}

/** Builds and sends one atomic batchUpdate. If a cached tab id turned out stale (a tab was created or deleted elsewhere), refresh and retry once. */
async function execute(ctx, ops) {
  for (let attempt = 0; ; attempt++) {
    try {
      const meta = await getMeta();
      const requests = await buildRequests(ctx, ops, meta);
      await batchUpdate(requests);
      return;
    } catch (e) {
      if (attempt === 0 && STALE_RE.test(String(e && e.message))) { invalidateStructure(); continue; }
      throw e;
    }
  }
}

/* ---------- roster edits: add / rename / remove / move ---------- */

async function applyFull(a) {
  const ctx = await readSnapshot({ hist: true });                       // always fresh: row numbers decide where the write lands
  const p = rmPlan_(ctx, a);
  if (p.errors.length) return { ok: false, errors: p.errors };
  // One click (after the inline confirm) only when nothing needs a second look. Warnings the page already showed on its confirm line (p.soft) are covered by ack.
  const regChoice = (a.type === 'edit' || a.type === 'delete') && !p.meta.regChanged && !a.regName && p.options && p.options.regCandidates && p.options.regCandidates.length > 0;
  const hardWarn = p.warnings.filter((w) => (p.soft || []).indexOf(w) < 0);
  if (a.quick && ((a.ack ? hardWarn.length : p.warnings.length) || regChoice)) {
    return { ok: false, needsReview: true, errors: [], preview: {
      title: p.title, confirmLabel: p.confirmLabel, danger: p.danger, warnings: p.warnings, changes: p.changes, options: p.options
    } };
  }
  let started = false;
  try {
    started = true;
    await execute(ctx, p.ops);                                         // ONE atomic request
    // ONE re-read after the write verifies the change and is also the screens' fresh state (no history tabs).
    const ctx2 = await readSnapshot({ hist: false });
    setSnap(ctx2);
    const checks = rmVerify_(ctx2, a, p);
    if (p.ops.some((o) => o.t === 'insertRow' || o.t === 'deleteRow') && await b1IsTable()) {
      let real = 0;
      const colTeam = ctx2.pl.cols[RM_CFG.H.PL.team];
      ctx2.pl.rows.forEach((r) => { if (rmClean_(r.v[colTeam])) real++; });
      const shown = parseInt(ctx2.b1, 10);
      checks.push({ ok: shown === real, msg: shown === real ? 'The Participants table has ' + real + ' rows (matches the count at the top of the tab)'
        : 'The count at the top of Participant List says ' + shown + ' but there are ' + real + ' rows — the "Participants" table may not have grown. Check that the new row is inside the table.' });
    }
    return { ok: true, title: p.title, changes: p.changes, warnings: p.warnings, checks, allGood: checks.every((c) => c.ok), fresh: { ...rmFresh_(ctx2), ageMs: 0 } };
  } catch (e) {
    return { ok: false, errors: ['Something went wrong: ' + (e && e.message ? e.message : e) +
      (started ? ' — nothing was changed (the update is applied all at once), but check the sheet before trying again.' : '')] };
  }
}

/* ---------- Paid / Sub Division: one narrow read, one atomic write ---------- */

async function applyHeader(a) {
  let ctx = await getSnapshot({});                                      // cached is fine for planning; the narrow read below decides whether to trust it
  let wasFresh = false;
  const redo = async () => { ctx = await getSnapshot({ force: true }); wasFresh = true; };
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = rmPlan_(ctx, a);
    if (p.errors.length) { if (!wasFresh) { await redo(); continue; } return { ok: false, errors: p.errors }; }
    // narrow fresh read: the header row and the team's row (raw, so a formula shows up as a formula)
    const t = p.meta.team, rowNo = t.regRow.r, R = RM_CFG.H.REG;
    const [hv, rv] = await batchGet([q(RM_CFG.TAB.REG) + '!1:1', q(RM_CFG.TAB.REG) + '!' + rowNo + ':' + rowNo], 'FORMULA');
    const hdr = ((hv.values || [])[0] || []).map(rmClean_), row = (rv.values || [])[0] || [];
    const ix = (h) => hdr.indexOf(h);
    const same = (h, want) => { const i = ix(h); const v = i < 0 ? '' : String(row[i] == null ? '' : row[i]); return v.charAt(0) === '=' || rmNK_(v) === rmNK_(want); };
    const target = p.meta.hdr, ti = ix(target);
    const rawTarget = ti < 0 || row[ti] == null ? '' : String(row[ti]);
    const cached = rmClean_(rmG_(ctx.reg, t.regRow, target));
    if (!same(R.team, t.team) || !same(R.div, t.division) || (rawTarget.charAt(0) !== '=' && rmClean_(rawTarget) !== cached)) {
      if (!wasFresh) { await redo(); continue; }                         // the cache was behind the sheet: plan again from a fresh read
      return { ok: false, errors: ['That team changed on the sheet while you were working. Refresh and try again.'] };
    }
    if (rawTarget.charAt(0) === '=')
      return { ok: false, errors: ['That cell on ' + RM_CFG.TAB.REG + ' (row ' + rowNo + ') is a formula, so the app did not change it. Nothing was changed.'] };
    try {
      await execute(ctx, p.ops);                                        // the cell + the change-log line, in one request
    } catch (e) {
      return { ok: false, errors: ['Something went wrong: ' + (e && e.message ? e.message : e) + ' — nothing was changed.'] };
    }
    patchCache(ctx, rowNo, ti, p.meta.value);
    return { ok: true, title: p.title, changes: p.changes, warnings: p.warnings, allGood: true, value: p.meta.value,
             checks: [{ ok: true, msg: target + ' on Registrations now reads ' + (p.meta.value ? '"' + p.meta.value + '"' : 'blank') }] };
  }
  return { ok: false, errors: ['Could not settle on a stable copy of the sheet. Refresh and try again.'] };
}

export function applyAction(action) {
  return withLock(async () => {
    try {
      const a = rmCleanAction_(action);
      return isHeader(a) ? await applyHeader(a) : await applyFull(a);
    } catch (e) {
      return { ok: false, errors: ['Something went wrong: ' + (e && e.message ? e.message : e)] };
    }
  });
}

/* ---------- Check-in (gameday): team-level, 3 cells on Registrations + an append-only Check-In Log tab ---------- */
// Mirrors rm_setCheckin / rm_addCheckinNote / rm_getCheckinLog in RM_Server.gs (v15).

const CI_HEADERS = () => { const H = RM_CFG.H.CI; return [H.ts, H.team, H.div, H.action, H.note, H.by, H.warn]; };
const DATETIME_FORMAT = { numberFormat: { type: 'DATE_TIME', pattern: 'M/d/yyyy h:mm:ss AM/PM' } };

/** Where a Check-In Log line goes, plus any requests needed first (create the tab with its header row, or add a missing header). */
async function logTarget(meta) {
  const name = RM_CFG.TAB.CI, names = CI_HEADERS();
  if (meta.ids[name] == null) {
    const id = 1000000 + Math.floor(Math.random() * 1e9), cols = {};
    names.forEach((n, i) => { cols[n] = i; });
    return { sheetId: id, cols, width: names.length, created: true, prep: [
      { addSheet: { properties: { sheetId: id, title: name, gridProperties: { frozenRowCount: 1 } } } },
      cellsAt(id, 1, 1, names),
      { repeatCell: { range: { sheetId: id, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex: 1 },
                      cell: { userEnteredFormat: DATETIME_FORMAT }, fields: 'userEnteredFormat.numberFormat' } }
    ] };
  }
  const L = await getHeader('CI', name), cols = { ...L.cols }, prep = [];
  let width = L.width;
  names.filter((n) => cols[n] == null).forEach((n) => { cols[n] = width; prep.push(cellsAt(meta.ids[name], 1, width + 1, [n])); width++; });
  return { sheetId: meta.ids[name], cols, width, created: false, prep };
}
function afterLogWrite(meta, target) {
  meta.ids[RM_CFG.TAB.CI] = target.sheetId;
  hdrC.CI = { at: Date.now(), cols: target.cols, width: target.width };
}
function pushLogCache(teamKey, entry) {
  if (!logC) return;
  const k = rmNK_(teamKey);
  (logC.byTeam[k] = logC.byTeam[k] || []).unshift(entry);
}

/** Finds the team, re-reading the display cache once if the cached copy doesn't know it. */
async function findTeam(teamKey) {
  let ctx = await getSnapshot({});
  let t = rmFindTeam_({ reg: ctx.reg }, String(teamKey));
  if (!t) { ctx = await getSnapshot({ force: true }); t = rmFindTeam_({ reg: ctx.reg }, String(teamKey)); }
  return { ctx, t };
}

/** Check a team in (want = 'Yes') or undo it ('No'). Writes Checked In / Check-In Time / Check-In By on the team's Registrations row
 *  (time and by cleared on undo) and ONE line on the Check-In Log, in one request. Never touches Participant List, Waivers or history. */
export function setCheckin(args) {
  return withLock(async () => {
    try { return await doCheckin(args, 0); }
    catch (e) { return { ok: false, errors: ['Something went wrong: ' + (e && e.message ? e.message : e)] }; }
  });
}

async function doCheckin({ teamKey, want, note, warnings, by }, attempt) {
  const w = String(want || '').toLowerCase();
  if (w !== 'yes' && w !== 'no') return { ok: false, errors: ['Check-in must be Yes or No.'] };
  const yes = w === 'yes', X = RM_CFG.H.REGX, R = RM_CFG.H.REG, REG = RM_CFG.TAB.REG;
  const { ctx, t } = await findTeam(teamKey);
  if (!t) return { ok: false, errors: ['Team not found: ' + teamKey + '. Refresh and try again.'] };
  const meta = await getMeta();
  // narrow fresh read: the header row and this team's row (raw, so a formula shows up as a formula)
  const rowNo = t.regRow.r;
  const [hv, rv] = await batchGet([q(REG) + '!1:1', q(REG) + '!' + rowNo + ':' + rowNo], 'FORMULA');
  const hdr = ((hv.values || [])[0] || []).map(rmClean_), row = (rv.values || [])[0] || [];
  const cols = {};
  hdr.forEach((h, i) => { if (h && !(h in cols)) cols[h] = i; });
  const raw = (h) => (cols[h] == null || row[cols[h]] == null ? '' : String(row[cols[h]]));
  const sameName = (h, want2) => { const v = raw(h); return v.charAt(0) === '=' || rmNK_(v) === rmNK_(want2); };
  if (!sameName(R.team, t.team) || !sameName(R.div, t.division)) {
    if (attempt === 0) { await getSnapshot({ force: true }); return doCheckin({ teamKey, want, note, warnings, by }, 1); }
    return { ok: false, errors: ['That team changed on the sheet while you were working. Refresh and try again.'] };
  }
  const have = [X.ci, X.ciTime, X.ciBy].filter((h) => cols[h] != null);
  for (const h of have) if (raw(h).charAt(0) === '=')
    return { ok: false, errors: ['The "' + h + '" cell for ' + t.team + ' (row ' + rowNo + ') is a formula, so the app did not change it. Nothing was changed.'] };
  const v = rmNK_(raw(X.ci)), curOn = v === 'yes' || v === 'y' || v === 'true' || v === 'checked in';
  if (curOn === yes) {
    const c = rmCheckin_({ reg: ctx.reg }, t.regRow);
    return { ok: true, unchanged: true, ci: curOn, time: c.ciTime, by: c.ciBy, team: t.key };
  }

  // new columns go to the right of the last Registrations column; nothing existing moves
  const requests = [];
  const lastCol = Math.max(ctx.reg.lastCol, hdr.length);
  const missing = [X.ci, X.ciTime, X.ciBy].filter((h) => cols[h] == null);
  if (missing.length) {
    const need = lastCol + missing.length, haveCols = (meta.grid[REG] || {}).columnCount || 0;
    if (haveCols < need) requests.push({ appendDimension: { sheetId: meta.ids[REG], dimension: 'COLUMNS', length: need - haveCols } });
    requests.push(cellsAt(meta.ids[REG], 1, lastCol + 1, missing));
    missing.forEach((h, i) => { cols[h] = lastCol + i; });
  }
  const who = rmSafeText_(by, 80), n = rmSafeText_(note, 500), wn = rmSafeText_(warnings, 300);
  const sheetId = meta.ids[REG], when = new Date(), serial = serialNow(meta.tz, when), shown = shownTime(meta.tz, when);
  requests.push(cellsAt(sheetId, rowNo, cols[X.ci] + 1, [yes ? 'Yes' : 'No']));
  requests.push(yes
    ? { updateCells: { start: { sheetId, rowIndex: rowNo - 1, columnIndex: cols[X.ciTime] }, fields: 'userEnteredValue,userEnteredFormat.numberFormat',
        rows: [{ values: [{ userEnteredValue: { numberValue: serial }, userEnteredFormat: { numberFormat: { type: 'DATE_TIME', pattern: 'M/d h:mm AM/PM' } } }] }] } }
    : cellsAt(sheetId, rowNo, cols[X.ciTime] + 1, ['']));
  requests.push(cellsAt(sheetId, rowNo, cols[X.ciBy] + 1, [yes ? who : '']));
  const target = await logTarget(meta);
  const LH = RM_CFG.H.CI;
  const entry = { time: shown, action: yes ? 'Checked in' : 'Check-in undone', note: n, by: who, warn: yes ? wn : '' };
  const allRequests = requests.concat(target.prep, [appendLog(target.sheetId, target.cols, target.width, {
    [LH.ts]: serial, [LH.team]: t.key, [LH.div]: t.division, [LH.action]: entry.action, [LH.note]: n, [LH.by]: who, [LH.warn]: entry.warn
  }, LH.ts, DATETIME_FORMAT)]);
  try {
    await batchUpdate(allRequests);
  } catch (e) {
    if (attempt === 0 && STALE_RE.test(String(e && e.message))) { invalidateStructure(); return doCheckin({ teamKey, want, note, warnings, by }, 1); }
    throw e;
  }
  // keep the caches in step with what we just wrote
  afterLogWrite(meta, target);
  if (missing.length) {
    missing.forEach((h) => { ctx.reg.cols[h] = cols[h]; });
    ctx.reg.lastCol = lastCol + missing.length;
    if (meta.grid[REG]) meta.grid[REG].columnCount = Math.max(meta.grid[REG].columnCount || 0, lastCol + missing.length);
  }
  patchCache(ctx, rowNo, cols[X.ci], yes ? 'Yes' : 'No');
  patchCache(ctx, rowNo, cols[X.ciTime], yes ? shown : '');
  patchCache(ctx, rowNo, cols[X.ciBy], yes ? who : '');
  pushLogCache(t.key, entry);
  return { ok: true, ci: yes, time: yes ? shown : '', by: yes ? who : '', team: t.key, row: rowNo, verified: true, entry };
}

/** A note about a team (the team, its captain, anything seen at the door). Log line only; nothing on Registrations changes. */
export function addCheckinNote({ teamKey, note, by }) {
  return withLock(async () => {
    try { return await doNote({ teamKey, note, by }, 0); }
    catch (e) { return { ok: false, errors: ['Something went wrong: ' + (e && e.message ? e.message : e)] }; }
  });
}
async function doNote({ teamKey, note, by }, attempt) {
  const n = rmSafeText_(note, 500);
  if (!n) return { ok: false, errors: ['Type a note first.'] };
  const { t } = await findTeam(teamKey);
  if (!t) return { ok: false, errors: ['Team not found: ' + teamKey + '. Refresh and try again.'] };
  const meta = await getMeta(), who = rmSafeText_(by, 80), when = new Date(), LH = RM_CFG.H.CI;
  const target = await logTarget(meta);
  const entry = { time: shownTime(meta.tz, when), action: 'Note', note: n, by: who, warn: '' };
  try {
    await batchUpdate(target.prep.concat([appendLog(target.sheetId, target.cols, target.width, {
      [LH.ts]: serialNow(meta.tz, when), [LH.team]: t.key, [LH.div]: t.division, [LH.action]: 'Note', [LH.note]: n, [LH.by]: who
    }, LH.ts, DATETIME_FORMAT)]));
  } catch (e) {
    if (attempt === 0 && STALE_RE.test(String(e && e.message))) { invalidateStructure(); return doNote({ teamKey, note, by }, 1); }
    throw e;
  }
  afterLogWrite(meta, target);
  pushLogCache(t.key, entry);
  return { ok: true, team: t.key, entry };
}

/** Check-in history for one team, newest first (check-ins, undos and notes). The whole tab is read once and cached; empty when the tab doesn't exist yet. */
export async function getCheckinLog(teamKey) {
  const H = RM_CFG.H.CI;
  if (!logC || Date.now() - logC.at > MAX_AGE_MS) {
    const meta = await getMeta();
    const byTeam = {};
    if (meta.ids[RM_CFG.TAB.CI] != null) {
      const [vr] = await batchGet([q(RM_CFG.TAB.CI)]);
      const values = (vr && vr.values) || [];
      if (values.length > 1) {
        const hdr = values[0].map(rmClean_), ix = (nm) => hdr.indexOf(nm);
        const c = { ts: ix(H.ts), team: ix(H.team), action: ix(H.action), note: ix(H.note), by: ix(H.by), warn: ix(H.warn) };
        const at = (r, i) => (i >= 0 && r[i] != null ? r[i] : '');
        values.slice(1).forEach((r) => {
          if (c.team < 0) return;
          const k = rmNK_(at(r, c.team));
          if (k) (byTeam[k] = byTeam[k] || []).push({ time: at(r, c.ts), action: at(r, c.action), note: at(r, c.note), by: at(r, c.by), warn: at(r, c.warn) });
        });
        Object.keys(byTeam).forEach((k) => byTeam[k].reverse());
      }
    }
    logC = { at: Date.now(), byTeam };
  }
  return { ok: true, entries: (logC.byTeam[rmNK_(teamKey)] || []).slice(0, 100) };
}
