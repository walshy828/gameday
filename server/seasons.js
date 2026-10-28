// server/seasons.js
// "Seasons" separate one year's concessions/raffle records from the next when the same database is reused.
// Exactly one season is current; new sales are stamped with it and reports default to it. Older seasons stay
// in the database and can still be viewed. Only the superadmin starts a new season (index.js enforces that).
import { pool } from './db.js';

let ready = null;
function ensureTable() {
  if (!ready) {
    ready = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS seasons (
          id INT AUTO_INCREMENT PRIMARY KEY,
          label VARCHAR(64) NOT NULL UNIQUE,
          created_at BIGINT NOT NULL,
          is_current TINYINT(1) NOT NULL DEFAULT 0
        )`);
      const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM seasons');
      if (!n) await pool.query('INSERT INTO seasons (label, created_at, is_current) VALUES (?, ?, 1)', [String(new Date().getFullYear()), Date.now()]);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const shape = (r) => ({ id: r.id, label: r.label, createdAt: Number(r.created_at), current: !!r.is_current });

export async function list() {
  await ensureTable();
  const [rows] = await pool.query('SELECT * FROM seasons ORDER BY id DESC');
  return rows.map(shape);
}

export async function current() {
  const all = await list();
  return all.find((s) => s.current) || all[0];
}

/** Ends the current season and starts a new one. Throws a user-facing Error if the label is blank or already used. */
export async function start(label) {
  const clean = String(label || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 64);
  if (!clean) throw new Error('Give the new season a name, e.g. 2027.');
  await ensureTable();
  const [[dupe]] = await pool.query('SELECT id FROM seasons WHERE label = ?', [clean]);
  if (dupe) throw new Error(`A season named "${clean}" already exists.`);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('UPDATE seasons SET is_current = 0');
    await conn.query('INSERT INTO seasons (label, created_at, is_current) VALUES (?, ?, 1)', [clean, Date.now()]);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return list();
}

/** Resolves a requested season id to a real season (falls back to the current one). */
export async function resolve(id) {
  const all = await list();
  const n = Number(id);
  return all.find((s) => s.id === n) || all.find((s) => s.current) || all[0];
}
