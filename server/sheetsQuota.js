// server/sheetsQuota.js
// One shared throttle for the Google Sheets calls the Roster and Raffle adapters make. They use the same
// service account, and Google counts about 60 reads + 60 writes per minute for the whole account, so each
// adapter keeping its own counter could add up to twice the quota. Calls here are queued under the limit
// and retried with backoff on "too many requests".
import dotenv from 'dotenv';
dotenv.config();

const QUOTA_PER_MIN = Number(process.env.SHEETS_MAX_REQUESTS_PER_MIN || process.env.ROSTER_MAX_REQUESTS_PER_MIN) || 50;   // stay under Google's 60 per kind per minute
const MAX_QUEUE_WAIT_MS = 25000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
export const statusOf = (e) => e && (e.code || (e.response && e.response.status));

/** Reads retry on 429 and 5xx. Writes retry only on 429 (not processed), so an action is never applied twice. */
export async function call(kind, fn) {
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

/* ---------- shared client + wall-clock helpers (the adapters write in the spreadsheet's own time zone) ---------- */

import { google } from 'googleapis';

export let sheetsClient = null;
if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
  try {
    const jwt = new google.auth.JWT({
      email: process.env.GOOGLE_CLIENT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    sheetsClient = google.sheets({ version: 'v4', auth: jwt });
  } catch (e) {
    console.warn('Sheets client not initialized:', e.message || e);
  }
}

export function wall(tz, d = new Date()) {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(d).forEach((x) => { p[x.type] = x.value; });
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour % 24, mm: +p.minute, ss: +p.second };
}
/** Sheets date-time serial for the wall-clock time in tz. */
export function serialNow(tz, d = new Date()) {
  const w = wall(tz, d);
  return Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss) / 86400000 + 25569;
}
