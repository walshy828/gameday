// server/raffleSheets.js
// Google Sheets adapter for the Raffle Manager (raffle sellers sell tickets from their phones; the same
// "Gonk Dodgeball - Raffle Manager" spreadsheet the Station tabs write to stays the source of truth).
// Reads Config / Rolls / Sales and appends a sale to Sales the way the sheet's Apps Script does (submitSale_),
// so the in-sheet Station tabs, the Drawing tab and the Dashboard tab all keep working.
//
// Built to stay well inside the Sheets quota (about 60 reads and 60 writes per minute for the service account,
// shared with the roster and everything else, see sheetsQuota.js):
//   * ONE batchGet reads Config + Rolls + Sales together. That single snapshot feeds the sell form, the sales
//     list, search and the reports, so opening any screen costs nothing once it is cached.
//   * The snapshot is cached for RAFFLE_CACHE_SECONDS (default 60) or until someone presses Refresh, so any
//     number of phones polling still costs at most ~1 read a minute.
//   * A sale costs ONE read (taken inside the lock, because ticket numbers must come from the sheet's current
//     state, never from the cache) and ONE write (values.batchUpdate: the Sales rows plus any roll flipped to
//     Full). That read becomes the new cache, with the sale patched in, so no re-read afterward.
//   * Every sale is also saved to the database (raffleDb.js) before the sheet write and marked synced / failed after,
//     so a sheet problem never loses a sale. The superadmin can reconcile the two (raffleReconcile.js).
//   * Retrying the same submission (a double tap, a flaky connection) returns the first result instead of
//     selling twice.
//
// Requires RAFFLE_SPREADSHEET_ID and the existing Google service account (GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY),
// with the sheet shared to that account as Editor.
import dotenv from 'dotenv';
import { call, sheetsClient as sheets, serialNow } from './sheetsQuota.js';
import { priceSale, allocate, strip, groupSales } from '../public/js/raffleLogic.js';
import * as RaffleDb from './raffleDb.js';
dotenv.config();

export function isRaffleConfigured() {
  return !!(sheets && process.env.RAFFLE_SPREADSHEET_ID);
}
const sid = () => process.env.RAFFLE_SPREADSHEET_ID;

/* ---------- the sheet's layout (mirrors the Apps Script constants) ---------- */

const LAST = 3000;          // last Sales row the sheet's formulas look at
const ROLL_ROWS = 60;       // roll slots on the Rolls tab
const S = { RECEIPT: 0, TIME: 1, SELLER: 2, NAME: 3, PHONE: 4, EMAIL: 5, BUNDLE: 6, PRICE: 7, PAY: 8, ROLL: 9, COLOR: 10, START: 11, END: 12, QTY: 13, VOID: 14, NOTES: 15 };
const S_COLS = 16;
const RANGES = ['Config!A2:J20', `Rolls!A2:E${ROLL_ROWS + 1}`, `Sales!A2:P${LAST}`];

const MAX_AGE_MS = (Number(process.env.RAFFLE_CACHE_SECONDS) || 60) * 1000;
const MIN_REFRESH_MS = 10000;    // a Refresh within this of the last read reuses it
const DONE_TTL_MS = 10 * 60 * 1000;

/* ---------- reading ---------- */

const str = (v) => (v == null ? '' : String(v).trim());
const num = (v) => (v === '' || v == null ? 0 : Number(v) || 0);

function parseConfig(rows) {
  const bundles = [], payments = [], colors = [], settings = {};
  rows.forEach((r, i) => {
    if (r[0] !== '' && r[0] != null && r[1] !== '' && r[1] != null && Number(r[0]) > 0) bundles.push({ qty: Number(r[0]), price: Number(r[1]) });
    if (str(r[4])) payments.push(str(r[4]));
    if (str(r[6])) colors.push(str(r[6]));
    if (i < 9 && str(r[8])) settings[str(r[8])] = str(r[9]);
  });
  return {
    event: settings['Event name'] || 'Raffle',
    bundles, payments, colors,
    require: {
      name: settings['Require buyer name'] !== 'No',
      contact: settings['Require phone or email'] !== 'No',
      pay: settings['Require payment method'] !== 'No'
    }
  };
}

/** Sales rows -> objects. `t` is the wall-clock time in the sheet's zone as ms (read it with UTC getters). */
function parseSales(rows) {
  const out = [];
  rows.forEach((r, i) => {
    if (r[S.RECEIPT] === '' || r[S.RECEIPT] == null) return;
    const ts = r[S.TIME];
    out.push({
      row: i + 2,
      receipt: str(r[S.RECEIPT]),
      t: typeof ts === 'number' ? Math.round((ts - 25569) * 86400000) : (Date.parse(String(ts)) || 0),
      seller: str(r[S.SELLER]), name: str(r[S.NAME]), phone: str(r[S.PHONE]), email: str(r[S.EMAIL]),
      price: r[S.PRICE], pay: str(r[S.PAY]),
      roll: str(r[S.ROLL]), color: str(r[S.COLOR]),
      start: num(r[S.START]), end: num(r[S.END]), tickets: num(r[S.QTY]),
      void: r[S.VOID] === true, notes: str(r[S.NOTES])
    });
  });
  return out;
}

function parseRolls(rows, sales) {
  const maxEnd = {}, used = {}, sold = {};
  sales.forEach((s) => {                       // voided tickets stay burned
    if (!s.roll) return;
    if (s.end > (maxEnd[s.roll] || 0)) maxEnd[s.roll] = s.end;
    used[s.roll] = (used[s.roll] || 0) + s.tickets;
    if (!s.void) sold[s.roll] = (sold[s.roll] || 0) + s.tickets;
  });
  const rolls = [];
  rows.forEach((r, i) => {
    if (r[0] === '' || r[0] == null) return;
    const id = str(r[0]), start = Number(r[2]), end = Number(r[3]);
    rolls.push({
      id, color: str(r[1]), start, end, status: str(r[4]), row: i + 2,
      next: Math.max(start - 1, maxEnd[id] || 0) + 1,
      sold: sold[id] || 0,
      remaining: Math.max(0, end - start + 1 - (used[id] || 0))
    });
  });
  return rolls;
}

async function readSheet() {
  const r = await call('read', () => sheets.spreadsheets.values.batchGet({
    spreadsheetId: sid(), ranges: RANGES, valueRenderOption: 'UNFORMATTED_VALUE', majorDimension: 'ROWS'
  }));
  const v = r.data.valueRanges || [];
  const cfgRows = (v[0] && v[0].values) || [], rollRows = (v[1] && v[1].values) || [], saleRows = (v[2] && v[2].values) || [];
  const sales = parseSales(saleRows);
  return { config: parseConfig(cfgRows), rolls: parseRolls(rollRows, sales), sales, lastRow: sales.reduce((m, s) => Math.max(m, s.row), 1) };
}

let tzC = null;
async function getTz() {
  if (process.env.RAFFLE_TZ) return process.env.RAFFLE_TZ;
  if (tzC) return tzC;
  const r = await call('read', () => sheets.spreadsheets.get({ spreadsheetId: sid(), fields: 'properties.timeZone' }));
  tzC = r.data.properties.timeZone || 'America/New_York';
  return tzC;
}

/* ---------- the display cache (never used to place a write) ---------- */

let snap = null;            // { ctx, at }
let snapInflight = null;
let outMemo = null;         // { of, data } - the client payload built from snap

function setSnap(ctx) { snap = { ctx, at: Date.now() }; outMemo = null; }

async function getSnapshot({ refresh = false, force = false } = {}) {
  const age = snap ? Date.now() - snap.at : Infinity;
  if (!force && snap && (refresh ? age < MIN_REFRESH_MS : age < MAX_AGE_MS)) return snap.ctx;
  if (snapInflight) return snapInflight;
  snapInflight = (async () => {
    try { const ctx = await readSheet(); setSnap(ctx); return ctx; }
    finally { snapInflight = null; }
  })();
  return snapInflight;
}

const publicRoll = (r) => ({ id: r.id, color: r.color, status: r.status, start: r.start, end: r.end, next: r.next, sold: r.sold, remaining: r.remaining });

/** The roll a seller should have selected: the first Active one (a given roll if it is still sellable). */
function defaultRoll(rolls, prefer) {
  const active = rolls.filter((r) => r.status === 'Active' && r.remaining > 0);
  return (active.find((r) => r.id === prefer) || active[0] || {}).id || '';
}

function payload(ctx) {
  return {
    ...ctx.config,
    rolls: ctx.rolls.map(publicRoll),
    sales: groupSales(ctx.sales),
    defaultRoll: defaultRoll(ctx.rolls)
  };
}

/** Every sale on the Sales tab as receipts (for the superadmin reconciliation). Always reads the sheet fresh (one Sheets read). */
export async function getSheetSales() {
  const ctx = await getSnapshot({ force: true });
  return groupSales(ctx.sales);
}

export async function getRaffleData({ refresh = false } = {}) {
  const ctx = await getSnapshot({ refresh });
  if (!outMemo || outMemo.of !== snap.at) outMemo = { of: snap.at, data: payload(ctx) };
  return { ok: true, ...outMemo.data, tz: await getTz(), ageMs: Date.now() - snap.at };
}

/* ---------- selling ---------- */

let chain = Promise.resolve();      // one sale at a time (the Apps Script LockService equivalent; the app is a single process)
function withLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

const done = new Map();             // clientId -> { at, result }
function sweepDone() { const now = Date.now(); for (const [k, v] of done) if (now - v.at > DONE_TTL_MS) done.delete(k); }

const clip = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) : '');
/** The time a phone says a sale happened, kept only if it is plausible (not in the future, not older than 3 days). */
function soldDate(ms) {
  const t = Number(ms), now = Date.now();
  return t > now - 3 * 86400000 && t <= now ? new Date(t) : new Date(now);
}

/** Validates ticket ranges a phone allocated for itself against the Rolls tab. */
function deviceLines(raw, qty, rolls) {
  const lines = [];
  for (const l of raw.slice(0, 20)) {
    const r = rolls.find((x) => x.id === clip(String(l.roll ?? ''), 40));
    const start = Number(l.start), end = Number(l.end);
    if (!r) return { error: `Roll "${l.roll}" is not on the Rolls tab.` };
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) return { error: `Bad ticket range ${l.start}-${l.end} on ${r.id}.` };
    if (start < r.start || end > r.end) return { error: `Tickets ${start}-${end} are outside ${r.id} (${r.start}-${r.end}).` };
    lines.push({ roll: r.id, color: r.color, start, end, qty: end - start + 1 });
  }
  const total = lines.reduce((a, l) => a + l.qty, 0);
  if (total !== qty) return { error: `Ticket ranges add up to ${total}, not ${qty}.` };
  return { lines };
}

/** Which already-sold ranges (voided ones stay burned) the given lines overlap. */
function overlaps(lines, issued) {
  const out = [];
  lines.forEach((ln) => issued.forEach((x) => {
    if (x.roll === ln.roll && !(x.end < ln.start || x.start > ln.end)) out.push({ roll: x.roll, start: x.start, end: x.end, receipt: x.receipt });
  }));
  return out;
}

const pad4 = (n) => String(n).padStart(4, '0');
const fail = (msg) => ({ ok: false, errors: [msg] });

/**
 * Sells tickets. `seller` is the signed-in raffle manager's name (decided by the route, never trusted from here).
 * in: { clientId, rollId, bundleQty, customQty, customPrice, preStart, preColor, name, phone, email, pay, notes }
 */
export async function sell(seller, input) {
  const clientId = clip(input.clientId, 64);
  sweepDone();
  if (clientId && done.has(clientId)) return done.get(clientId).result;
  return withLock(async () => {
    if (clientId && done.has(clientId)) return done.get(clientId).result;     // a duplicate that queued behind the first
    const result = await sellLocked(seller, input, clientId);
    if (clientId && result.ok) done.set(clientId, { at: Date.now(), result });
    return result;
  });
}

async function sellLocked(seller, input, clientId) {
  seller = clip(seller, 60);
  if (!seller) return fail('Enter your name in "Seller".');
  const ctx = await readSheet();                       // fresh state, inside the lock
  const { config, rolls, sales } = ctx;

  // A retry of a sale the server already took (its response was lost, or the server restarted since): the database
  // knows the clientId. 'synced' means it is on the sheet; 'pending' means the write's outcome was unknown, so look
  // for its receipt on the sheet we just read. Either way answer with what was recorded instead of selling again.
  const prior = clientId ? await RaffleDb.findByClientId(clientId) : null;
  if (prior && (prior.status === 'synced' || (prior.status === 'pending' && sales.some((s) => s.receipt === prior.receipt)))) {
    if (prior.status === 'pending') await RaffleDb.setStatus(prior.id, 'synced');
    const rows = sales.filter((s) => s.receipt === prior.receipt);
    return {
      ok: true, receipt: prior.receipt, qty: prior.qty, price: prior.price, pay: prior.pay, manual: false, conflicts: [], duplicate: true,
      backup: 'saved', lines: prior.lines, split: prior.lines.length > 1, noRollLeft: false, suggestedRoll: defaultRoll(rolls),
      sale: rows.length ? groupSales(rows)[0] : null, rolls: rolls.map(publicRoll)
    };
  }

  const rollId = clip(input.rollId, 40);
  const name = clip(input.name, 100), phone = clip(input.phone, 30), email = clip(input.email, 120);
  const pay = clip(input.pay, 40);
  let notes = clip(input.notes, 300);
  const preStartRaw = input.preStart === '' || input.preStart == null ? '' : Number(input.preStart);
  const preColor = clip(input.preColor, 40);
  const manual = preStartRaw !== '';
  if (manual && !(preStartRaw > 0 && preStartRaw % 1 === 0)) return fail('Pre-torn first ticket # must be a whole number.');
  if (preColor && config.colors.length && !config.colors.includes(preColor)) return fail('Unknown ticket color.');
  if (pay && config.payments.length && !config.payments.includes(pay)) return fail('Unknown payment method.');

  const priced = priceSale({ bundleQty: input.bundleQty, customQty: input.customQty, customPrice: input.customPrice }, config.bundles);
  if (priced.error) return fail(priced.error);
  const { qty, price } = priced;
  if (!rollId && !manual) return fail('Pick a roll (or enter a pre-torn first ticket #).');
  if (config.require.name && !name) return fail('Enter the buyer name.');
  if (config.require.contact && !phone && !email) return fail('Enter a phone number or email.');
  if (config.require.pay && !pay) return fail('Pick a payment method.');

  if (ctx.lastRow >= LAST - 12) return fail('Sales log is nearly full - contact the admin.');

  let maxReceipt = 0;
  const issued = [];
  sales.forEach((s) => {
    const n = parseInt(s.receipt.replace(/\D/g, ''), 10);
    if (n > maxReceipt) maxReceipt = n;
    if (s.roll) issued.push({ roll: s.roll, start: s.start, end: s.end, qty: s.tickets, receipt: s.receipt });
  });

  // A phone that sold with no connection already tore specific tickets, so its numbers are recorded as given.
  const device = Array.isArray(input.lines) && input.lines.length > 0;
  let conflicts = [];
  let alloc;
  if (device) {
    alloc = deviceLines(input.lines, qty, rolls);
    if (!alloc.error) conflicts = overlaps(alloc.lines, issued);
  } else {
    alloc = manual ? strip(preStartRaw, qty, preColor, rolls, issued) : allocate(qty, rollId, rolls);
  }
  if (alloc.error) return fail(alloc.error);
  // Tickets already handed to the buyer can't be un-torn, so an overlap is recorded and flagged, never refused.
  if (conflicts.length) notes = clip(`CHECK TICKETS: overlaps ${conflicts.map((c) => `${c.roll} ${c.start}-${c.end} (${c.receipt})`).join(', ')}${notes ? ' | ' + notes : ''}`, 300);

  // --- the rows to append ---
  const tz = await getTz();
  const receipt = 'R' + pad4(maxReceipt + 1);
  const serial = serialNow(tz, soldDate(input.soldAt)), nowWall = Math.round((serial - 25569) * 86400000);
  const firstRow = ctx.lastRow + 1;
  const newSales = alloc.lines.map((ln, i) => ({
    row: firstRow + i, receipt, t: nowWall, seller, name, phone, email,
    price: i === 0 ? price : '', pay, roll: ln.roll, color: ln.color, start: ln.start, end: ln.end, tickets: ln.qty, void: false, notes
  }));
  const values = alloc.lines.map((ln, i) => [receipt, serial, seller, name, phone, email,
    i === 0 ? qty : '', i === 0 ? price : '', pay, ln.roll, ln.color, ln.start, ln.end, ln.qty, false, notes]);

  // --- roll memory: mark Full ---
  const data = [{ range: `Sales!A${firstRow}:P${firstRow + values.length - 1}`, values }];
  const rollById = Object.fromEntries(rolls.map((r) => [r.id, r]));
  alloc.lines.forEach((ln) => {
    const r = rollById[ln.roll];
    let used = ln.qty;
    issued.forEach((x) => { if (x.roll === ln.roll) used += x.qty; });
    if (manual || device ? used >= r.end - r.start + 1 : ln.end >= r.end) {
      data.push({ range: `Rolls!E${r.row}`, values: [['Full']] });
      r.status = 'Full';
    }
  });

  // Backup first: if the sheet write then fails or its outcome is unknown, the database still has the sale.
  const dbId = await RaffleDb.insertPending({
    clientId: clip(input.clientId, 64), receipt, seller, name, phone, email, qty, price, pay, notes, lines: alloc.lines, soldWall: nowWall
  });
  try {
    await call('write', () => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sid(), requestBody: { valueInputOption: 'RAW', data }
    }));
  } catch (e) {
    await RaffleDb.setStatus(dbId, 'failed', e.message || e);     // the sheet refused it, so this sale did not happen
    throw e;
  }
  await RaffleDb.setStatus(dbId, 'synced');

  // --- the write is the only truth we add: patch it into what we just read and keep that as the cache ---
  const nextSales = sales.concat(newSales);
  const nextCtx = { config, sales: nextSales, lastRow: firstRow + values.length - 1, rolls: parseRolls(
    rolls.map((r) => [r.id, r.color, r.start, r.end, r.status]), nextSales).map((r, i) => ({ ...r, row: rolls[i].row })) };
  setSnap(nextCtx);

  let nextRoll = manual || device ? rollId : alloc.lines[alloc.lines.length - 1].roll;
  const cur = nextCtx.rolls.find((r) => r.id === nextRoll);
  if (!manual && (!cur || cur.status !== 'Active')) {
    const nxt = nextCtx.rolls.find((r) => r.status === 'Active' && cur && r.color === cur.color) || nextCtx.rolls.find((r) => r.status === 'Active');
    nextRoll = nxt ? nxt.id : '';
  }
  return {
    ok: true, receipt, qty, price, pay, manual, conflicts,
    backup: !RaffleDb.isDbConfigured() ? 'off' : dbId ? 'saved' : 'unavailable',
    lines: alloc.lines,
    split: alloc.lines.length > 1,
    noRollLeft: !manual && !nextRoll,
    suggestedRoll: nextRoll,
    sale: groupSales(newSales)[0],
    rolls: nextCtx.rolls.map(publicRoll)
  };
}
