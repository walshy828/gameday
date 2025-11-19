// db.js
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import crypto from "crypto";
dotenv.config();

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 3000; // 3 seconds

export const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

/**
 * Attempt to connect to the database with retries.
 */
async function testConnection() {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const conn = await pool.getConnection();
      await conn.ping();
      conn.release();
      console.log("✅ Successfully connected to MariaDB");
      return true;
    } catch (err) {
      console.error(
        `⚠️  Database connection failed (attempt ${attempt}/${MAX_RETRIES}):`,
        err.message
      );
      if (attempt < MAX_RETRIES) {
        console.log(`⏳ Retrying in ${RETRY_DELAY_MS / 1000} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        console.error("❌ Could not connect to database after several attempts.");
        throw err;
      }
    }
  }
}

