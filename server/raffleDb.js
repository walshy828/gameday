// server/raffleDb.js
// Database backup of every raffle sale made through the app (MariaDB, table raffle_sales), so a sale is still on
// record if the spreadsheet write or a later sync goes wrong. Same posture as the match-result audit log
// (mariadb.js): best-effort, never blocks a sale when the database is down, and skipped silently when no DB
// is configured. The table is created on first use (schema.sql has it too for fresh installs).
//
// A sale is saved here as 'pending' BEFORE the sheet write, then flipped to 'synced' (sheet write confirmed)
// or 'failed' (sheet refused it, so the sale did not happen). A row left 'pending' means the sheet write's outcome
// is unknown (crash / timeout), which is exactly what the superadmin reconciliation looks for.
import { pool } from './db.js';
import * as Seasons from './seasons.js';

const TIMEOUT_MS = 4000;

const withTimeout = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('database timed out')), TIMEOUT_MS))]);

let ready = null;
function ensureTable() {
  if (!ready) {
    ready = pool.query(`
      CREATE TABLE IF NOT EXISTS raffle_sales (
        id INT AUTO_INCREMENT PRIMARY KEY,
        client_id VARCHAR(64) NULL UNIQUE,
        receipt VARCHAR(16) NOT NULL,
        seller VARCHAR(191),
        buyer_name VARCHAR(191),
        phone VARCHAR(64),
        email VARCHAR(191),
        tickets INT NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        payment VARCHAR(64),
        notes TEXT,
        \`lines\` TEXT,
        sold_wall BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        sync_status VARCHAR(16) NOT NULL DEFAULT 'pending',
        sync_error TEXT NULL,
        INDEX idx_raffle_receipt (receipt)
      )`).then(() => pool.query('ALTER TABLE raffle_sales ADD COLUMN IF NOT EXISTS season_id INT NULL'))
      .catch((e) => { ready = null; throw e; });
  }
  return ready;
}

export function isDbConfigured() {
  return !!(process.env.DB_USER && process.env.DB_NAME);
}

/** Saves a sale as 'pending'. Returns the row id, or null if the database is unavailable (the sale still goes ahead). */
export async function insertPending(s) {
  if (!isDbConfigured()) return null;
  try {
    return await withTimeout((async () => {
      await ensureTable();
      const season = await Seasons.current();
      const [r] = await pool.query(
        `INSERT INTO raffle_sales (client_id, receipt, seller, buyer_name, phone, email, tickets, price, payment, notes, \`lines\`, sold_wall, created_at, season_id, sync_status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending')
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), receipt=VALUES(receipt), seller=VALUES(seller), buyer_name=VALUES(buyer_name),
           phone=VALUES(phone), email=VALUES(email), tickets=VALUES(tickets), price=VALUES(price), payment=VALUES(payment), notes=VALUES(notes),
           \`lines\`=VALUES(\`lines\`), sold_wall=VALUES(sold_wall), sync_status='pending', sync_error=NULL`,
        [s.clientId || null, s.receipt, s.seller, s.name, s.phone, s.email, s.qty, s.price, s.pay, s.notes, JSON.stringify(s.lines), s.soldWall, Date.now(), season.id]);
      return r.insertId;
    })());
  } catch (e) {
    console.error('raffle backup insert failed (sale continues):', e.message || e);
    return null;
  }
}

/** The saved row for a clientId (a retried submission), or null. Used so a retry after a lost response never sells twice. */
export async function findByClientId(clientId) {
  if (!isDbConfigured() || !clientId) return null;
  try {
    return await withTimeout((async () => {
      await ensureTable();
      const [rows] = await pool.query('SELECT * FROM raffle_sales WHERE client_id = ? LIMIT 1', [clientId]);
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id, receipt: r.receipt, status: r.sync_status, qty: r.tickets, price: Number(r.price), pay: r.payment || '',
        lines: (() => { try { return JSON.parse(r.lines || '[]'); } catch (e) { return []; } })()
      };
    })());
  } catch (e) {
    console.error('raffle backup lookup failed:', e.message || e);
    return null;
  }
}

export async function setStatus(id, status, error) {
  if (!id) return;
  try {
    await withTimeout(pool.query('UPDATE raffle_sales SET sync_status=?, sync_error=? WHERE id=?', [status, error ? String(error).slice(0, 500) : null, id]));
  } catch (e) {
    console.error('raffle backup status update failed:', e.message || e);
  }
}

/**
 * Saved sales, oldest first. With a seasonId only that season's rows (sales saved before seasons existed count as
 * the oldest season); without one, every row (reconcile compares against the whole sheet).
 * Throws if the database cannot be read (callers show that to the superadmin).
 */
export async function listAll(seasonId) {
  if (!isDbConfigured()) throw new Error('No database is configured (DB_HOST / DB_USER / DB_PASSWORD / DB_NAME).');
  await withTimeout(ensureTable());
  let rows;
  if (seasonId != null) {
    const seasons = await withTimeout(Seasons.list());
    const oldest = seasons[seasons.length - 1];
    [rows] = await withTimeout(pool.query('SELECT * FROM raffle_sales WHERE season_id = ? OR (season_id IS NULL AND ? = ?) ORDER BY id ASC', [seasonId, seasonId, oldest.id]));
  } else {
    [rows] = await withTimeout(pool.query('SELECT * FROM raffle_sales ORDER BY id ASC'));
  }
  return rows.map((r) => ({
    id: r.id, receipt: r.receipt, seller: r.seller || '', name: r.buyer_name || '', phone: r.phone || '', email: r.email || '',
    qty: r.tickets, price: Number(r.price), pay: r.payment || '', notes: r.notes || '',
    lines: (() => { try { return JSON.parse(r.lines || '[]'); } catch (e) { return []; } })(),
    t: Number(r.sold_wall), createdAt: Number(r.created_at), status: r.sync_status, error: r.sync_error || ''
  }));
}

/** TEST DATA RESET: permanently deletes every raffle backup row in every season. The raffle sheet is not touched. */
export async function clearAllSales() {
  await ensureTable();
  const [r] = await pool.query('DELETE FROM raffle_sales');
  return r.affectedRows || 0;
}
