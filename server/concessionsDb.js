// server/concessionsDb.js
// Concessions stand storage (MariaDB only, no spreadsheet): the item catalog, small settings (Venmo username,
// payment note, categories) and every sale. Phones queue sales locally while offline and post them here later,
// so a sale is idempotent on its client-generated `client_id` (a retry or double sync returns the original row).
// Sale lines store the item name/price AS SOLD, so changing a price never rewrites history.
import { pool } from './db.js';
import * as Seasons from './seasons.js';

/** A problem with what the phone sent (permanent: retrying won't help), as opposed to a database/network failure. */
export class UserError extends Error {}

export function isDbConfigured() {
  return !!(process.env.DB_USER && process.env.DB_NAME);
}

const DEFAULT_CATEGORIES = ['Pizza', 'Drinks', 'Candy', 'Other'];
const SEED_ITEMS = [
  ['Pizza slice', 3, 'Pizza'], ['Donut', 2, 'Other'], ['Gatorade', 3, 'Drinks'], ['Drink', 2, 'Drinks'],
  ['Candy', 2, 'Candy'], ['Ring pop', 1, 'Candy'], ['Chips', 1, 'Other']
];

let ready = null;
function ensureTables() {
  if (!ready) {
    ready = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS concession_items (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(80) NOT NULL,
          price DECIMAL(10,2) NOT NULL,
          category VARCHAR(40) NOT NULL DEFAULT 'Other',
          sort_order INT NOT NULL DEFAULT 0,
          active TINYINT(1) NOT NULL DEFAULT 1
        )`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS concession_settings (
          k VARCHAR(64) PRIMARY KEY,
          v TEXT
        )`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS concession_sales (
          id INT AUTO_INCREMENT PRIMARY KEY,
          client_id VARCHAR(64) NOT NULL UNIQUE,
          season_id INT NOT NULL,
          seq INT NOT NULL,
          seller VARCHAR(191),
          line_items TEXT NOT NULL,
          total DECIMAL(10,2) NOT NULL,
          payment VARCHAR(16) NOT NULL,
          sold_at BIGINT NOT NULL,
          created_at BIGINT NOT NULL,
          voided TINYINT(1) NOT NULL DEFAULT 0,
          void_by VARCHAR(191) NULL,
          void_at BIGINT NULL,
          void_reason VARCHAR(191) NULL,
          INDEX idx_cs_season (season_id, sold_at)
        )`);
      const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM concession_items');
      if (!n) {
        for (let i = 0; i < SEED_ITEMS.length; i++) {
          const [name, price, category] = SEED_ITEMS[i];
          await pool.query('INSERT INTO concession_items (name, price, category, sort_order) VALUES (?,?,?,?)', [name, price, category, i]);
        }
      }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// Sequence numbers are per season; the single Node process serializes inserts so two syncing phones can't collide.
let chain = Promise.resolve();
const serialized = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

const shapeItem = (r) => ({ id: r.id, name: r.name, price: Number(r.price), category: r.category, active: !!r.active });
const shapeSale = (r) => ({
  id: r.id, clientId: r.client_id, seasonId: r.season_id, seq: r.seq, seller: r.seller || '',
  lines: (() => { try { return JSON.parse(r.line_items || '[]'); } catch (e) { return []; } })(),
  total: Number(r.total), payment: r.payment, t: Number(r.sold_at), createdAt: Number(r.created_at),
  voided: !!r.voided, voidBy: r.void_by || '', voidAt: r.void_at == null ? null : Number(r.void_at), voidReason: r.void_reason || ''
});

async function readSettings() {
  const [rows] = await pool.query('SELECT k, v FROM concession_settings');
  const m = Object.fromEntries(rows.map((r) => [r.k, r.v]));
  let categories = DEFAULT_CATEGORIES;
  try { const c = JSON.parse(m.categories || 'null'); if (Array.isArray(c) && c.length) categories = c; } catch (e) { /* keep defaults */ }
  return { venmoUser: m.venmoUser || '', venmoNote: m.venmoNote || 'Concessions', categories };
}

/** Everything a phone needs to run the stand: items (inactive ones included for the Items screen), settings, seasons. */
export async function getCatalog() {
  await ensureTables();
  const [items] = await pool.query('SELECT * FROM concession_items ORDER BY sort_order ASC, id ASC');
  const [settings, seasons] = await Promise.all([readSettings(), Seasons.list()]);
  return { items: items.map(shapeItem), settings, seasons, season: seasons.find((s) => s.current) || seasons[0], serverTime: Date.now() };
}

/** Saves the whole ordered item list (position = sort order). Items are hidden, never deleted, so old sales keep their names. */
export async function saveItems(list) {
  await ensureTables();
  const settings = await readSettings();
  const errors = [];
  if (!Array.isArray(list) || !list.length) throw new UserError('Send at least one item.');
  if (list.length > 200) throw new UserError('Too many items.');
  const clean = list.map((it, i) => {
    const name = String(it?.name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
    const price = Math.round(Number(it?.price) * 100) / 100;
    const category = String(it?.category ?? '').trim().slice(0, 40) || 'Other';
    if (!name) errors.push(`Item ${i + 1} needs a name.`);
    if (!Number.isFinite(price) || price < 0 || price > 1000) errors.push(`${name || 'Item ' + (i + 1)} needs a price between $0 and $1000.`);
    return { id: Number.isInteger(it?.id) ? it.id : null, name, price, category, active: it?.active === false ? 0 : 1 };
  });
  if (errors.length) throw new UserError(errors.join(' '));
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (let i = 0; i < clean.length; i++) {
      const c = clean[i];
      if (c.id) await conn.query('UPDATE concession_items SET name=?, price=?, category=?, active=?, sort_order=? WHERE id=?', [c.name, c.price, c.category, c.active, i, c.id]);
      else await conn.query('INSERT INTO concession_items (name, price, category, active, sort_order) VALUES (?,?,?,?,?)', [c.name, c.price, c.category, c.active, i]);
    }
    // Any new category used by an item joins the list so it shows up in the pickers.
    const cats = [...settings.categories];
    clean.forEach((c) => { if (!cats.includes(c.category)) cats.push(c.category); });
    if (cats.length !== settings.categories.length) {
      await conn.query('INSERT INTO concession_settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', ['categories', JSON.stringify(cats)]);
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return getCatalog();
}

export async function saveSettings(patch) {
  await ensureTables();
  const out = {};
  if (patch.venmoUser !== undefined) {
    const u = String(patch.venmoUser).trim().replace(/^@/, '');
    if (u && !/^[A-Za-z0-9_-]{2,40}$/.test(u)) throw new UserError('Venmo username can only contain letters, numbers, - and _.');
    out.venmoUser = u;
  }
  if (patch.venmoNote !== undefined) out.venmoNote = String(patch.venmoNote).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60) || 'Concessions';
  if (patch.categories !== undefined) {
    const cats = [...new Set((Array.isArray(patch.categories) ? patch.categories : []).map((c) => String(c).trim().slice(0, 40)).filter(Boolean))];
    if (!cats.length) throw new UserError('Keep at least one category.');
    out.categories = JSON.stringify(cats);
  }
  for (const [k, v] of Object.entries(out)) {
    await pool.query('INSERT INTO concession_settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [k, v]);
  }
  return getCatalog();
}

/** Validates a queued sale from a phone and stores it (idempotent on clientId). Returns { sale } or throws a user-facing Error. */
export function addSale(b, seller) {
  return serialized(async () => {
    await ensureTables();
    const clientId = String(b?.clientId || '');
    if (!/^[A-Za-z0-9-]{8,64}$/.test(clientId)) throw new UserError('Missing sale id.');
    const [[dupe]] = await pool.query('SELECT * FROM concession_sales WHERE client_id = ?', [clientId]);
    if (dupe) return { sale: shapeSale(dupe), duplicate: true };

    const payment = b.payment === 'venmo' ? 'venmo' : b.payment === 'cash' ? 'cash' : null;
    if (!payment) throw new UserError('Payment must be cash or Venmo.');
    if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 60) throw new UserError('A sale needs at least one item.');
    const lines = b.lines.map((l) => ({
      id: Number.isInteger(l?.id) ? l.id : null,
      name: String(l?.name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80),
      price: Math.round(Number(l?.price) * 100) / 100,
      qty: Number(l?.qty),
      category: String(l?.category ?? 'Other').trim().slice(0, 40) || 'Other'
    }));
    for (const l of lines) {
      if (!l.name || !Number.isFinite(l.price) || l.price < 0 || l.price > 1000 || !Number.isInteger(l.qty) || l.qty < 1 || l.qty > 99) throw new UserError('A sale line is invalid.');
    }
    const total = Math.round(lines.reduce((a, l) => a + l.price * l.qty, 0) * 100) / 100;   // never trust a client-sent total
    if (total > 5000) throw new UserError('That total looks wrong.');
    const soldAt = Number(b.soldAt);
    const now = Date.now();
    // A phone clock can be off; keep the sale time inside a sane window around the server's clock.
    const t = Number.isFinite(soldAt) && soldAt > now - 14 * 864e5 && soldAt < now + 3600e3 ? Math.round(soldAt) : now;

    const season = await Seasons.resolve(b.seasonId);
    const [[{ m }]] = await pool.query('SELECT COALESCE(MAX(seq), 0) AS m FROM concession_sales WHERE season_id = ?', [season.id]);
    const [r] = await pool.query(
      'INSERT INTO concession_sales (client_id, season_id, seq, seller, line_items, total, payment, sold_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [clientId, season.id, m + 1, seller, JSON.stringify(lines), total, payment, t, now]);
    const [[row]] = await pool.query('SELECT * FROM concession_sales WHERE id = ?', [r.insertId]);
    return { sale: shapeSale(row) };
  });
}

/** Voids a sale (kept in the log, excluded from totals). Idempotent. */
export async function voidSale(clientId, by, reason, at) {
  await ensureTables();
  const [[row]] = await pool.query('SELECT * FROM concession_sales WHERE client_id = ?', [String(clientId || '')]);
  if (!row) throw new UserError('Sale not found.');
  if (!row.voided) {
    const t = Number(at);
    await pool.query('UPDATE concession_sales SET voided=1, void_by=?, void_at=?, void_reason=? WHERE id=?',
      [by, Number.isFinite(t) && t > 0 ? Math.round(t) : Date.now(), String(reason || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 190) || null, row.id]);
  }
  const [[fresh]] = await pool.query('SELECT * FROM concession_sales WHERE id = ?', [row.id]);
  return shapeSale(fresh);
}

/** All sales in a season, oldest first (a season is a few hundred rows, so the phone filters/reports locally). */
export async function listSales(seasonId) {
  await ensureTables();
  const season = await Seasons.resolve(seasonId);
  const [rows] = await pool.query('SELECT * FROM concession_sales WHERE season_id = ? ORDER BY sold_at ASC, id ASC', [season.id]);
  return { season, sales: rows.map(shapeSale) };
}

/** TEST DATA RESET: permanently deletes every concession sale in every season. Items, prices and settings are kept. */
export async function clearAllSales() {
  await ensureTables();
  const [r] = await pool.query('DELETE FROM concession_sales');
  return r.affectedRows || 0;
}
