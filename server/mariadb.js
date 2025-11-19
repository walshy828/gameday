// mariadb.js
import { pool } from "./db.js";
import crypto from 'crypto';

// In-memory admin token store (token -> expiry timestamp ms)

export async function submitGameDB(matchData) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();



    // 2️⃣ Insert new order
    await conn.query(
      "INSERT INTO gameday_submissions (name,winner,playersremaining, notes,Date,division,rowindex) VALUES (?, ?, ?, ?, ?, ?,?)",
      [matchData.adminName, matchData.winner, matchData.playersRemaining, matchData.notes, new Date(), matchData.sheetName,matchData.rowIndex]
    );
    await conn.commit();
    return { success: true };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

