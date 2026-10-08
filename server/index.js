import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { Store } from './datastores/index.js';
import * as SheetsMirror from './sheetsMirror.js';
import * as SheetsSync from './sheetsSync.js';
import { applySyncSettings, computeAutoSyncExpiry, initSyncScheduler, scheduleResultSync } from './syncScheduler.js';
import { initSocket, broadcastDiscrepancyPing } from './socket.js';
import { listOpenDiscrepancies, dismissDiscrepancy, notifyIfHighImpact } from './discrepancies.js';
import * as Roster from './rosterSheets.js';
import { controlTimer, initTimerControl, TimerError, TIMER_ACTION_NAMES } from './timerControl.js';
import crypto from 'crypto';
import axios from 'axios';



dotenv.config();

// Fail fast on missing/weak secrets: an unset password would otherwise let a
// request with no password (undefined === undefined) log in, and an unset salt
// falls back to a publicly known default.
{
  const problems = [];
  const need = (name, min) => {
    const v = process.env[name];
    if (!v) problems.push(`${name} is not set`);
    else if (v.length < min) problems.push(`${name} must be at least ${min} characters`);
  };
  need('ADMIN_PASSWORD', 8);
  need('SUPERADMIN_PASSWORD', 8);
  need('SECRET_SALT', 16);
  if (process.env.PARENT_PASSWORD) need('PARENT_PASSWORD', 8);
  if (process.env.SECRET_SALT === 'secret-salt') problems.push('SECRET_SALT must not be the default value');
  const pws = [process.env.ADMIN_PASSWORD, process.env.SUPERADMIN_PASSWORD, process.env.PARENT_PASSWORD].filter(Boolean);
  if (new Set(pws).size !== pws.length) problems.push('ADMIN_PASSWORD, SUPERADMIN_PASSWORD and PARENT_PASSWORD must all differ');
  if (problems.length) {
    console.error('Refusing to start — fix your .env:\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
}

const DATA_BACKEND = (process.env.DATA_BACKEND || 'firebase').toLowerCase();

const app = express();
// Only trust X-Forwarded-For when you run behind a reverse proxy/tunnel you
// control: set TRUST_PROXY=1 (number of proxy hops). Left unset, client IPs
// come from the socket and can't be spoofed with a header.
const TRUST_PROXY = process.env.TRUST_PROXY;
app.set('trust proxy', TRUST_PROXY ? (/^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY === 'true' ? 1 : TRUST_PROXY) : false);
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, '../public')));

// Fallback route to serve the generated Tailwind CSS with correct MIME type.
// Some hosting setups may rewrite unknown paths to index.html which results in
// the CSS being served with text/html. This explicit route ensures the CSS is
// delivered as text/css when present.
app.get('/dist/output.css', (req, res, next) => {
  const cssPath = path.join(__dirname, '../public/dist/output.css');
  res.sendFile(cssPath, (err) => {
    if (err) {
      // Let the static middleware or other handlers deal with the error
      next(err);
    }
  });
});

// Serve a tiny runtime config JS that the frontend can read to know API_BASE
// and which data backend (firebase | local) the server is running against.
// Set API_BASE in your Docker/hosting environment as the full API base (e.g. https://api.example.com/api)
app.get('/config.js', (req, res) => {
  const apiBase = process.env.API_BASE || '';
  res.type('application/javascript');
  // Safely serialize the string
  const gaMeasurementId = process.env.GA_MEASUREMENT_ID || null;
  res.send(`window.__API_BASE__ = ${JSON.stringify(apiBase)};\nwindow.__GA_MEASUREMENT_ID__ = ${JSON.stringify(gaMeasurementId)};\nwindow.__DATA_BACKEND__ = ${JSON.stringify(DATA_BACKEND)};`);
});

// Utilities from env
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SUPERADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD;
const PARENT_PASSWORD = process.env.PARENT_PASSWORD;
const SECRET_SALT = process.env.SECRET_SALT;

// route: getAllData
app.get('/api/allData', async (req, res) => {
  try {
    const sheetName = req.query.sheetName || 'Sheet1';
    const featureSettings = await Store.getFeatureSettings();
    const settings = {
      is_tie_allowed: (process.env.ALLOW_MATCH_TIE === 'true') || false,
      ga_measurement_id: process.env.GA_MEASUREMENT_ID || null,
      championCelebrationEnabled: featureSettings.championCelebrationEnabled,
      autoUpdateOfficialResultsEnabled: featureSettings.autoUpdateOfficialResultsEnabled,
      checkinEnabled: featureSettings.checkinEnabled
    };
    const standings = await Store.getStandings(sheetName);
    const schedule = await Store.getSchedule(sheetName);
    const scheduleConfig = await Store.getScheduleConfig(sheetName);
    res.json({ settings, standings, schedule, scheduleConfig });
  } catch (e) {
    console.error('getAllData error', e);
    res.status(500).json({ error: e.toString() });
  }
});

// route: getDivisionNames
app.get('/api/divisions', async (_req, res) => {
  try {
    const names = await Store.getDivisionNames();
    res.json(await SheetsSync.orderDivisionsBySheet(names));
  } catch (e) {
    console.error('getDivisionNames', e);
    res.status(500).json({ error: e.toString() });
  }
});

// route: getStandings (if needed separately)
app.get('/api/standings', async (req, res) => {
  const sheetName = req.query.sheetName || 'Sheet1';
  try {
    const s = await Store.getStandings(sheetName);
    res.json(s);
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

// Lightweight User-Agent parsing for session tracking — no dependency needed
// for the granularity we want (OS/device family + browser family).
function parseUserAgent(ua = '') {
  let os = 'Other';
  if (/iPad/i.test(ua)) os = 'iPad';
  else if (/iPhone/i.test(ua)) os = 'iPhone';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Macintosh/i.test(ua)) os = 'Mac';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let browser = 'Other';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/CriOS/i.test(ua) || (/Chrome\//i.test(ua) && !/Chromium/i.test(ua))) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';

  const device = (os === 'iPhone' || os === 'iPad' || os === 'Android') ? 'Mobile' : 'Desktop';

  return { os, browser, device };
}

function clientIp(req) {
  // req.ip already honors the `trust proxy` setting above.
  return String(req.ip || req.socket.remoteAddress || '').slice(0, 64);
}

// --- Input hygiene helpers ---
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Auth token from `Authorization: Bearer <token>` (preferred), falling back to
// a body `authToken` (used by timerLocal.js). Never read from the URL.
function getAuthToken(req) {
  const h = req.headers.authorization;
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7).trim();
  return typeof req.body?.authToken === 'string' ? req.body.authToken : undefined;
}

// Strips control characters and caps length; non-strings become ''.
function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

const SESSION_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const MAX_CHAT_LEN = 500;
const MAX_ANNOUNCEMENT_LEN = 1000;

// Failed-login throttle (per client IP): LOGIN_MAX_FAILS failures inside
// LOGIN_WINDOW_MS locks that IP out until the window passes. In-memory is fine
// for a one-day single-process deployment.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = Number(process.env.LOGIN_MAX_FAILS) || 15;
const loginFails = new Map(); // ip -> { count, resetAt }

function loginLockedOut(ip) {
  const e = loginFails.get(ip);
  if (!e) return 0;
  if (Date.now() > e.resetAt) { loginFails.delete(ip); return 0; }
  return e.count >= LOGIN_MAX_FAILS ? Math.ceil((e.resetAt - Date.now()) / 1000) : 0;
}
function recordLoginFailure(ip) {
  const now = Date.now();
  const e = loginFails.get(ip);
  if (!e || now > e.resetAt) loginFails.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  else e.count++;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of loginFails) if (now > e.resetAt) loginFails.delete(ip);
}, 5 * 60 * 1000).unref();

// route: validateAdminPassword
app.post('/api/validateAdmin', async (req, res) => {
  const { password } = req.body || {};
  const reporterName = cleanText(req.body?.reporterName, 40);
  const court = /^[A-Za-z0-9 ._-]{1,16}$/.test(req.body?.court ?? '') ? req.body.court : null;
  const sessionId = SESSION_ID_RE.test(req.body?.sessionId ?? '') ? req.body.sessionId : null;

  const ip = clientIp(req);
  const retryAfter = loginLockedOut(ip);
  if (retryAfter) {
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ isAdmin: false, isSuperAdmin: false, isParent: false, error: `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} min.` });
  }
  if (typeof password !== 'string' || !password) {
    return res.status(400).json({ isAdmin: false, isSuperAdmin: false, isParent: false, error: 'Password is required.' });
  }

  async function recordLoginIfPossible(role) {
    if (!sessionId) return;
    try {
      let ua = String(req.headers['user-agent'] || '');
      const { os, browser, device } = parseUserAgent(ua);
      ua = ua.slice(0, 500);
      await Store.recordLogin({
        sessionId,
        role,
        name: reporterName || 'Unknown',
        court: role === 'admin' ? (court || null) : null,
        ip,
        userAgent: ua,
        os,
        browser,
        device
      });
    } catch (e) {
      console.error('recordLogin failed', e);
    }
  }

  if (safeEqual(password, ADMIN_PASSWORD)) {
    const token = computeToken(ADMIN_PASSWORD);
    await recordLoginIfPossible('admin');
    return res.json({ isAdmin: true, isSuperAdmin: false, token });
  }
  if (safeEqual(password, SUPERADMIN_PASSWORD)) {
    const token = computeToken(SUPERADMIN_PASSWORD);
    // Firebase custom auth tokens are only meaningful when the browser talks
    // to Firebase RTDB directly (firebase mode) — local mode relies solely on
    // this SHA-256 authToken for all admin/superadmin writes.
    const firebaseToken = DATA_BACKEND !== 'local'
      ? await Store.createCustomToken('adminUser', { admin: true })
      : undefined;
    await recordLoginIfPossible('superadmin');
    return res.json({ isAdmin: true, isSuperAdmin: true, token, firebaseToken });
  }
  if (PARENT_PASSWORD && safeEqual(password, PARENT_PASSWORD)) {
    const token = computeToken(PARENT_PASSWORD);
    // Parents can post in the crew chat (identified as "Parent") but get no
    // match-entry, timer, or superadmin privileges — see requireChatAuth.
    await recordLoginIfPossible('parent');
    return res.json({ isAdmin: false, isSuperAdmin: false, isParent: true, token });
  }
  recordLoginFailure(ip);
  res.json({ isAdmin: false, isSuperAdmin: false, isParent: false, error: 'Invalid password.' });
});

// Validates and normalizes the match-result payload. Returns { value } or { error }.
async function validateMatchData(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'matchData is required.' };

  const sheetName = typeof raw.sheetName === 'string' ? raw.sheetName : '';
  const divisions = await Store.getDivisionNames();
  if (!divisions.includes(sheetName)) return { error: 'Unknown division.' };

  const intOrNull = (v, label, { required } = {}) => {
    if (v === undefined || v === null || v === '') return required ? { err: `${label} is required.` } : { v: null };
    const n = typeof v === 'string' && /^\d{1,6}$/.test(v) ? Number(v) : v;
    if (!Number.isInteger(n) || n < 0 || n > 100000) return { err: `${label} is invalid.` };
    return { v: n };
  };
  const fi = intOrNull(raw.firebaseIndex, 'firebaseIndex', { required: true });
  if (fi.err) return { error: fi.err };
  const ri = intOrNull(raw.rowIndex, 'rowIndex');
  if (ri.err) return { error: ri.err };

  const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '');
  const pr = raw.playersRemaining;
  if (pr !== undefined && pr !== null && pr !== '' && !(Number.isFinite(Number(pr)) && Number(pr) >= 0 && Number(pr) <= 999)) {
    return { error: 'playersRemaining is invalid.' };
  }

  return {
    value: {
      sheetName,
      firebaseIndex: fi.v,
      rowIndex: ri.v,
      team1: str(raw.team1, 191),
      team2: str(raw.team2, 191),
      winner: str(raw.winner, 191),
      playersRemaining: pr === undefined || pr === null || pr === '' ? '' : Number(pr),
      adminName: str(raw.adminName, 64),
      notes: str(raw.notes, 1000),
      setOfficial: raw.setOfficial === true
    }
  };
}

// route: saveMatchResult
app.post('/api/saveMatchResult', async (req, res) => {
  try {
    const authToken = getAuthToken(req);
    if (!isValidToken(authToken)) return res.status(401).json({ success: false, error: 'Authentication failed.' });

    // Whitelist + validate the payload: sheetName/indexes end up in RTDB paths
    // and Google Sheets A1 ranges, so a referee must not be able to aim them
    // at arbitrary locations.
    const clean = await validateMatchData(req.body?.matchData);
    if (clean.error) return res.status(400).json({ success: false, error: clean.error });
    const matchData = clean.value;

    // Detailed logging for save flow
    const requestId = crypto.randomBytes(4).toString('hex');
    const startTs = Date.now();
    console.log(`[${requestId}] /api/saveMatchResult START`, { sheetName: matchData?.sheetName, firebaseIndex: matchData?.firebaseIndex, rowIndex: matchData?.rowIndex, adminName: matchData?.adminName });

    // Superadmin ticked "also submit as official result": the sheet's official
    // columns get overwritten (not just filled when blank). Honored only for
    // the superadmin token, and only for a winner that's actually in the match.
    const forceOfficial = matchData.setOfficial === true && safeEqual(authToken, computeToken(SUPERADMIN_PASSWORD));
    if (forceOfficial) {
      const winner = (matchData.winner || '').trim();
      const game = Number.isInteger(matchData.rowIndex)
        ? (await Store.getSchedule(matchData.sheetName)).find(m => m.rowIndex === matchData.rowIndex)
        : null;
      if (!game) return res.status(404).json({ success: false, error: 'Match not found for official result — run a sync.' });
      if (![(game.team1 || '').trim(), (game.team2 || '').trim(), 'tie', ''].includes(winner)) {
        return res.status(400).json({ success: false, error: 'Winner must be one of the match teams, "tie", or blank.' });
      }
    }

    // Primary write — Firebase RTDB or local MariaDB, depending on DATA_BACKEND.
    let storeResult = null;
    try {
      const t0 = Date.now();
      storeResult = await Store.saveMatchResult(matchData);
      console.log(`[${requestId}] Store.saveMatchResult OK`, { durationMs: Date.now() - t0, storeResult });
    } catch (err) {
      console.error(`[${requestId}] Store.saveMatchResult FAILED`, err);
      storeResult = { success: false, error: err.toString() };
    }

    // Audit-log insert — independent of DATA_BACKEND, always attempted.
    let dbResult = null;
    try {
      const t0 = Date.now();
      const mariadb = await import('./mariadb.js');
      if (mariadb && typeof mariadb.submitGameDB === 'function') {
        dbResult = await mariadb.submitGameDB(matchData);
        console.log(`[${requestId}] mariadb.submitGameDB OK`, { durationMs: Date.now() - t0, dbResult });
      } else {
        console.log(`[${requestId}] mariadb.submitGameDB skipped (no export)`);
      }
    } catch (err) {
      console.error(`[${requestId}] mariadb.submitGameDB FAILED`, err);
      dbResult = { success: false, error: err.toString() };
    }

    // Google Sheets mirror — independent of DATA_BACKEND, best-effort, only
    // actually writes if Sheets env vars are configured.
    let sheetsMirrorResult = null;
    try {
      const t0 = Date.now();
      const featureSettings = await Store.getFeatureSettings();
      sheetsMirrorResult = await SheetsMirror.saveMatchResult({
        ...matchData,
        autoUpdateOfficialResults: !!featureSettings.autoUpdateOfficialResultsEnabled,
        forceOfficial
      });
      // The sheet recalculates official results/standings; pull them back
      // once the round's submissions settle (debounced, divisions only).
      if (sheetsMirrorResult.success) {
        if (forceOfficial) {
          // The superadmin is waiting on this — pull now so the response (and
          // the client's reload) already carries the official result/standings.
          await SheetsSync.syncDivisions([matchData.sheetName], 'override');
        } else if (featureSettings.autoUpdateOfficialResultsEnabled) {
          scheduleResultSync(matchData.sheetName);
        }
      }
      console.log(`[${requestId}] SheetsMirror.saveMatchResult`, { durationMs: Date.now() - t0, sheetsMirrorResult });
    } catch (e) {
      console.error(`[${requestId}] SheetsMirror.saveMatchResult FAILED`, e);
      sheetsMirrorResult = { success: false, error: e.toString() };
    }

    // A save can open, change or clear a discrepancy: nudge superadmin clients
    // to refetch, and push (if configured) for playoff games.
    broadcastDiscrepancyPing();
    notifyIfHighImpact(matchData.sheetName, matchData.firebaseIndex);

    const totalMs = Date.now() - startTs;
    console.log(`[${requestId}] /api/saveMatchResult COMPLETE`, { totalMs, storeResult, dbResult, sheetsMirrorResult });

    // Return the primary store's result to the client, plus whether the sheet
    // write landed — it's best-effort, so a failure doesn't fail the save,
    // but the client should warn (the official result never reaches the sheet
    // and a later pull would never bring it back). `skipped` = no sheet set up.
    res.json({
      ...storeResult,
      sheetsMirror: {
        success: !!sheetsMirrorResult?.success,
        ...(sheetsMirrorResult?.skipped ? { skipped: true } : {}),
        ...(sheetsMirrorResult?.error ? { error: sheetsMirrorResult.error } : {})
      }
    });
  } catch (e) {
    console.error('saveMatchResult error', e);
    res.status(500).json({ success: false, error: e.toString() });
  }
});

// --- Result discrepancies (referee-reported vs official), superadmin only ---

app.get('/api/discrepancies', async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    res.json({ success: true, items: await listOpenDiscrepancies() });
  } catch (e) {
    console.error('discrepancies error', e);
    res.status(500).json({ success: false, error: e.toString() });
  }
});

app.post('/api/discrepancies/dismiss', async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const division = cleanText(req.body?.division, 191);
    const firebaseIndex = req.body?.firebaseIndex;
    if (!division || firebaseIndex === undefined || firebaseIndex === null || firebaseIndex === '') {
      return res.status(400).json({ success: false, error: 'division and firebaseIndex are required' });
    }
    const by = cleanText(req.body?.by, 80);
    const result = await dismissDiscrepancy(division, firebaseIndex, by);
    if (!result.ok) return res.status(404).json({ success: false, error: result.error });
    broadcastDiscrepancyPing();
    res.json({ success: true, items: await listOpenDiscrepancies() });
  } catch (e) {
    console.error('dismiss discrepancy error', e);
    res.status(500).json({ success: false, error: e.toString() });
  }
});

// --- Roster / Team Management (Registrations sheet), superadmin only ---

function rosterGuard(req, res) {
  if (!requireSuperAdmin(req, res)) return false;
  if (!Roster.isRosterConfigured()) {
    res.status(503).json({ success: false, error: 'Roster is not configured (set ROSTER_SPREADSHEET_ID and share the sheet with the service account).' });
    return false;
  }
  return true;
}

app.get('/api/roster', async (req, res) => {
  if (!rosterGuard(req, res)) return;
  try {
    const [data, features] = await Promise.all([Roster.getRosterData({ refresh: req.query.refresh === '1' }), Store.getFeatureSettings()]);
    res.json({ success: true, ...data, ciOn: features.checkinEnabled === true });
  } catch (e) {
    console.error('roster load error', e);
    res.status(500).json({ success: false, error: e.message || e.toString() });
  }
});

app.post('/api/roster/checkin', async (req, res) => {
  if (!rosterGuard(req, res)) return;
  try {
    const b = req.body || {};
    const result = await Roster.setCheckin({
      teamKey: cleanText(b.teamKey, 300), want: cleanText(b.want, 5), note: cleanText(b.note, 500), warnings: cleanText(b.warnings, 300), by: cleanText(b.by, 80)
    });
    if (!result.ok) return res.status(400).json({ success: false, error: (result.errors || []).join(' '), errors: result.errors });
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('roster checkin error', e);
    res.status(500).json({ success: false, error: e.message || e.toString() });
  }
});

app.post('/api/roster/checkin/note', async (req, res) => {
  if (!rosterGuard(req, res)) return;
  try {
    const b = req.body || {};
    const result = await Roster.addCheckinNote({ teamKey: cleanText(b.teamKey, 300), note: cleanText(b.note, 500), by: cleanText(b.by, 80) });
    if (!result.ok) return res.status(400).json({ success: false, error: (result.errors || []).join(' '), errors: result.errors });
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('roster checkin note error', e);
    res.status(500).json({ success: false, error: e.message || e.toString() });
  }
});

app.get('/api/roster/checkin/log', async (req, res) => {
  if (!rosterGuard(req, res)) return;
  try {
    res.json({ success: true, ...(await Roster.getCheckinLog(cleanText(req.query.teamKey, 300))) });
  } catch (e) {
    console.error('roster checkin log error', e);
    res.status(500).json({ success: false, error: e.message || e.toString() });
  }
});

app.post('/api/roster/preview', async (req, res) => {
  if (!rosterGuard(req, res)) return;
  try {
    res.json({ success: true, ...(await Roster.previewAction(req.body?.action)) });
  } catch (e) {
    console.error('roster preview error', e);
    res.status(500).json({ success: false, error: e.message || e.toString() });
  }
});

app.post('/api/roster/apply', async (req, res) => {
  if (!rosterGuard(req, res)) return;
  try {
    const result = await Roster.applyAction(req.body?.action);
    if (!result.ok && !result.needsReview) return res.status(400).json({ success: false, error: (result.errors || []).join(' '), errors: result.errors });
    res.json({ success: result.ok, ...result });
  } catch (e) {
    console.error('roster apply error', e);
    res.status(500).json({ success: false, error: e.message || e.toString() });
  }
});

// --- Timer control endpoints (local mode only) ---
// In firebase mode the browser talks to Firebase RTDB directly for all timer
// state, so these endpoints exist purely for DATA_BACKEND=local, where the
// server is the source of truth and pushes updates over Socket.IO. All
// transitions (and clock expiry) live in server/timerControl.js.

// Millisecond server time for client clock-offset estimation (see
// public/js/serverClock.js). Must never be cached.
app.get('/api/time', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ now: Date.now() });
});

app.get('/api/timer', async (req, res) => {
  try {
    const sheetName = req.query.sheetName;
    const state = await Store.getTimerState(sheetName);
    res.json(state);
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

// Legacy route names from before setRound existed.
const TIMER_ACTION_ALIASES = { nextRound: 'setRound', prevRound: 'setRound' };

app.post('/api/timer/:action', async (req, res) => {
  if (DATA_BACKEND !== 'local') {
    return res.status(501).json({ success: false, error: 'Timer API is only available with DATA_BACKEND=local.' });
  }
  if (!requireSuperAdmin(req, res)) return;

  const action = TIMER_ACTION_ALIASES[req.params.action] || req.params.action;
  if (!TIMER_ACTION_NAMES.includes(action)) {
    return res.status(404).json({ success: false, error: 'Unknown timer action.' });
  }

  const { sheetName, clientId, clientName, ...params } = req.body || {};
  if (typeof clientId !== 'string' || clientId.length < 8 || clientId.length > 64) {
    return res.status(400).json({ success: false, error: 'clientId is required.' });
  }
  const client = { id: clientId, name: String(clientName || 'Tournament manager').slice(0, 64) };

  try {
    const { state } = await controlTimer(action, sheetName, client, params);
    res.json({ success: true, state });
  } catch (e) {
    if (e instanceof TimerError) {
      return res.status(e.status).json({ success: false, error: e.code, ...e.extra });
    }
    console.error(`timer/${action} failed`, e);
    res.status(500).json({ success: false, error: e.toString() });
  }
});

// --- Announcements (tournament-manager authored, tournament-wide) ---
// Reads are public (fans see the banner); writes require the superadmin
// ("tournament manager") token. Works identically on either DATA_BACKEND —
// all persistence/broadcast differences are inside the Store implementation.

app.get('/api/announcements', async (_req, res) => {
  try {
    const list = await Store.getAnnouncements();
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

app.post('/api/announcements', async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const text = cleanText(req.body?.text, MAX_ANNOUNCEMENT_LEN);
    if (!text) return res.status(400).json({ success: false, error: 'text is required' });
    const announcements = await Store.createAnnouncement(text);
    res.json({ success: true, announcements });
  } catch (e) {
    res.status(500).json({ success: false, error: e.toString() });
  }
});

app.post('/api/announcements/:id', async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const id = Number(req.params.id);
    const patch = {};
    if (typeof req.body?.text === 'string') patch.text = cleanText(req.body.text, MAX_ANNOUNCEMENT_LEN);
    if (typeof req.body?.on === 'boolean') patch.on = req.body.on;
    const announcements = await Store.updateAnnouncement(id, patch);
    res.json({ success: true, announcements });
  } catch (e) {
    res.status(500).json({ success: false, error: e.toString() });
  }
});

app.delete('/api/announcements/:id', async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const id = Number(req.params.id);
    const announcements = await Store.deleteAnnouncement(id);
    res.json({ success: true, announcements });
  } catch (e) {
    res.status(500).json({ success: false, error: e.toString() });
  }
});

// --- Crew chat (staff + parents; UI-gated, same posture as other staff views) ---
// `who`/`mgr` are derived server-side from the validated authToken + the
// client-supplied display name/court, never trusted directly from the body.

function requireChatAuth(req, res) {
  const authToken = getAuthToken(req);
  const isParent = !!PARENT_PASSWORD && safeEqual(authToken, computeToken(PARENT_PASSWORD));
  if (!isValidToken(authToken) && !isParent) {
    res.status(401).json({ success: false, error: 'Authentication failed.' });
    return false;
  }
  return true;
}

// Two channels: 'crew' (everyone — referees, superadmin, parents) and 'lead'
// (superadmin + parents only; referees are refused on both read and write).
const CHAT_CHANNELS = ['crew', 'lead'];

function chatChannelOf(value) {
  return CHAT_CHANNELS.includes(value) ? value : 'crew';
}

function chatRoleOf(authToken) {
  if (!authToken || typeof authToken !== 'string') return null;
  if (safeEqual(authToken, computeToken(SUPERADMIN_PASSWORD))) return 'superadmin';
  if (PARENT_PASSWORD && safeEqual(authToken, computeToken(PARENT_PASSWORD))) return 'parent';
  if (safeEqual(authToken, computeToken(ADMIN_PASSWORD))) return 'admin';
  return null;
}

function canUseLeadChat(role) {
  return role === 'superadmin' || role === 'parent';
}

// Crew channel stays readable without a token, same as before.
app.get('/api/chat', async (_req, res) => {
  try {
    const list = await Store.getChatMessages('crew');
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

app.get('/api/chat/lead', async (req, res) => {
  if (!canUseLeadChat(chatRoleOf(getAuthToken(req)))) {
    return res.status(403).json({ success: false, error: 'Leadership chat is restricted.' });
  }
  try {
    res.json(await Store.getChatMessages('lead'));
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

app.post('/api/chat', async (req, res) => {
  if (!requireChatAuth(req, res)) return;
  try {
    const text = cleanText(req.body?.text, MAX_CHAT_LEN);
    if (!text) return res.status(400).json({ success: false, error: 'text is required' });

    const role = chatRoleOf(getAuthToken(req));
    const channel = chatChannelOf(req.body?.channel);
    if (channel === 'lead' && !canUseLeadChat(role)) {
      return res.status(403).json({ success: false, error: 'Leadership chat is restricted.' });
    }
    const isMgr = role === 'superadmin';
    const isParent = role === 'parent';
    const reporterName = cleanText(req.body?.reporterName, 40) || 'Staff';
    const court = /^[A-Za-z0-9 ._-]{1,16}$/.test(req.body?.court ?? '') ? req.body.court : null;
    const who = isMgr ? `Admin · ${reporterName}` : isParent ? `Parent · ${reporterName}` : `Court ${court || '?'} · ${reporterName}`;

    const chat = await Store.postChatMessage({ who, mgr: isMgr, text, channel });
    res.json({ success: true, chat });

    // Sending a message is itself proof of activity — refresh the session's
    // presence watermark so it doesn't wait on the client's separate 45s
    // heartbeat interval, which can stall for a while after a backgrounded
    // mobile tab resumes (see the chat presence dot / ONLINE_THRESHOLD_MS).
    const sessionId = req.body?.sessionId;
    if (SESSION_ID_RE.test(sessionId ?? '')) Store.touchSession(sessionId).catch(err => console.error('Failed to touch session on chat send:', err));
  } catch (e) {
    res.status(500).json({ success: false, error: e.toString() });
  }
});

app.delete('/api/chat/:id', async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const id = Number(req.params.id);
    const chat = await Store.deleteChatMessage(id, chatChannelOf(req.body?.channel));
    res.json({ success: true, chat });
  } catch (e) {
    res.status(500).json({ success: false, error: e.toString() });
  }
});

// How long since a session's last heartbeat before we consider it "offline"
// rather than "online" — shared by the chat presence bubbles and the Setup
// page's Signed-in users table.
const ONLINE_THRESHOLD_MS = 90 * 1000;

// Must match the `who` string POST /api/chat computes, so a chat message's
// sender lines up with their live session for the presence dot.
function presenceWho({ role, name, court }) {
  const label = (name || '').trim() || 'Staff';
  if (role === 'superadmin') return `Admin · ${label}`;
  if (role === 'parent') return `Parent · ${label}`;
  return `Court ${court || '?'} · ${label}`;
}

// Lightweight presence feed for the chat view (any signed-in staff/parent,
// not just superadmins) — just enough to color a status dot next to each
// sender's name, without exposing IP/device details like /api/session/active
// does for the superadmin-only Setup page.
app.get('/api/presence', async (req, res) => {
  if (!requireChatAuth(req, res)) return;
  try {
    const sessions = await Store.getActiveSessions();
    const now = Date.now();
    const byWho = new Map();
    for (const s of sessions) {
      const who = presenceWho(s);
      const online = (now - (s.lastActivityAt || 0)) < ONLINE_THRESHOLD_MS;
      const existing = byWho.get(who);
      // A person can have more than one active session (e.g. two tabs); if
      // any of them is online, show them as online.
      if (!existing || (online && !existing.online)) byWho.set(who, { who, online });
    }
    res.json(Array.from(byWho.values()));
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

// --- Session tracking (who's signed in, sign-in history) ---
// Sessions are created by /api/validateAdmin (see recordLoginIfPossible
// above) and kept alive by a client-side heartbeat while logged in. "Online"
// is derived by the client/superadmin view from lastActivityAt rather than
// stored — a session that stops heartbeating just goes stale until it's
// explicitly ended by logout.

app.post('/api/session/heartbeat', async (req, res) => {
  if (!requireChatAuth(req, res)) return;
  try {
    const { sessionId } = req.body || {};
    if (!SESSION_ID_RE.test(sessionId ?? '')) return res.status(400).json({ success: false, error: 'valid sessionId is required' });
    await Store.touchSession(sessionId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.toString() });
  }
});

app.post('/api/session/logout', async (req, res) => {
  if (!requireChatAuth(req, res)) return;
  try {
    const { sessionId } = req.body || {};
    if (!SESSION_ID_RE.test(sessionId ?? '')) return res.status(400).json({ success: false, error: 'valid sessionId is required' });
    await Store.endSession(sessionId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.toString() });
  }
});

app.get('/api/session/active', async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const sessions = await Store.getActiveSessions();
    const now = Date.now();
    const withOnline = sessions
      .map(s => ({ ...s, online: (now - (s.lastActivityAt || 0)) < ONLINE_THRESHOLD_MS }))
      .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
    res.json(withOnline);
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

app.get('/api/session/history', async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const history = await Store.getLoginHistory();
    res.json(history);
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

// --- Google Sheet sync endpoints (superadmin only) ---
// Settings/status/log are persisted via the Store abstraction (Firebase RTDB
// or MariaDB, depending on DATA_BACKEND — see server/datastores/) and
// broadcast to clients over Socket.IO, so these routes behave the same
// regardless of backend. Only /run and /config need the service-account
// Sheets client, which lives in sheetsSync.js.

function requireSuperAdmin(req, res) {
  const authToken = getAuthToken(req);
  if (!authToken || !safeEqual(authToken, computeToken(SUPERADMIN_PASSWORD))) {
    res.status(403).json({ success: false, error: 'Superadmin access required.' });
    return false;
  }
  return true;
}

app.get('/api/sheetSync/config', async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const configured = await SheetsSync.isConfigured();
    const availableDivisions = configured ? await SheetsSync.getAvailableDivisions() : [];
    res.json({
      configured,
      spreadsheetUrl: await SheetsSync.getSpreadsheetUrl(),
      availableDivisions
    });
  } catch (e) {
    console.error('sheetSync/config error', e);
    res.status(500).json({ error: e.toString() });
  }
});

app.post('/api/sheetSync/run', async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const result = await SheetsSync.syncAll('manual');
    res.json(result);
  } catch (e) {
    console.error('sheetSync/run error', e);
    res.status(500).json({ success: false, error: e.toString() });
  }
});

// One-shot cleanup: delete every stored division that isn't a tab in the
// spreadsheet SPREADSHEET_ID currently points at. syncAll() does this
// automatically when it detects the id changed, but that only works from the
// first sync onward — this route clears out divisions left behind by a
// spreadsheet swap that happened before the app started tracking the id.
app.post('/api/sheetSync/prune', async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const result = await SheetsSync.pruneStaleDivisions();
    res.json(result);
  } catch (e) {
    console.error('sheetSync/prune error', e);
    res.status(500).json({ success: false, error: e.toString() });
  }
});

app.get('/api/sheetSync/status', async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const status = await SheetsSync.getStatus();
    res.json(status);
  } catch (e) {
    console.error('sheetSync/status error', e);
    res.status(500).json({ error: e.toString() });
  }
});

app.post('/api/sheetSync/settings', async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const { autoSyncEnabled, intervalSeconds, syncScope, selectedDivisions, googleSheetId } = req.body || {};
    const patch = {};
    if (typeof autoSyncEnabled === 'boolean') {
      patch.autoSyncEnabled = autoSyncEnabled;
      // Turning auto-sync on starts a fresh time-limit window; off clears it.
      patch.autoSyncExpiresAt = autoSyncEnabled ? computeAutoSyncExpiry() : null;
    }
    if (intervalSeconds != null) patch.intervalSeconds = Math.max(Number(intervalSeconds) || 300, 10);
    if (syncScope === 'all' || syncScope === 'selected') patch.syncScope = syncScope;
    if (Array.isArray(selectedDivisions)) patch.selectedDivisions = selectedDivisions.filter(d => typeof d === 'string' && d.trim()).map(d => d.trim());
    if (typeof googleSheetId === 'string' && googleSheetId.trim()) patch.googleSheetId = googleSheetId.trim();

    const status = await SheetsSync.updateSettings(patch);
    await applySyncSettings(status.settings);
    res.json(status);
  } catch (e) {
    console.error('sheetSync/settings error', e);
    res.status(500).json({ success: false, error: e.toString() });
  }
});

app.post('/api/featureSettings', async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const { championCelebrationEnabled, autoUpdateOfficialResultsEnabled, checkinEnabled } = req.body || {};
    const patch = {};
    if (typeof championCelebrationEnabled === 'boolean') patch.championCelebrationEnabled = championCelebrationEnabled;
    if (typeof autoUpdateOfficialResultsEnabled === 'boolean') patch.autoUpdateOfficialResultsEnabled = autoUpdateOfficialResultsEnabled;
    if (typeof checkinEnabled === 'boolean') patch.checkinEnabled = checkinEnabled;

    const settings = await Store.updateFeatureSettings(patch);
    res.json(settings);
  } catch (e) {
    console.error('featureSettings error', e);
    res.status(500).json({ success: false, error: e.toString() });
  }
});

// utility functions
function computeToken(password) {
  const hash = crypto.createHash('sha256').update(password + SECRET_SALT).digest('hex');
  return hash;
}
function isValidToken(tokenFromClient) {
  if (!tokenFromClient || typeof tokenFromClient !== 'string') return false;
  // Accept either admin or superadmin token
  return safeEqual(tokenFromClient, computeToken(ADMIN_PASSWORD)) || safeEqual(tokenFromClient, computeToken(SUPERADMIN_PASSWORD));
}


const GA_MEASUREMENT_ID = process.env.GA_MEASUREMENT_ID;
const GA_API_SECRET = process.env.GA_API_SECRET;

export async function trackServerEvent(eventName, params = {}, clientId = 'system') {
  if (!GA_MEASUREMENT_ID || !GA_API_SECRET) {
    console.log('Google Analytics not configured — skipping event');
    return;
  }

  try {
    await axios.post(
      `https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`,
      {
        client_id: clientId,
        events: [
          {
            name: eventName,
            params
          }
        ]
      }
    );
    console.log(`✅ Sent GA event: ${eventName}`);
  } catch (err) {
    console.error('❌ Failed to send GA event:', err.response?.data || err.message);
  }
}

const PORT = process.env.PORT || 8888;
const httpServer = http.createServer(app);
initSocket(httpServer);
httpServer.listen(PORT, () => console.log(`Server started at http://localhost:${PORT} (DATA_BACKEND=${DATA_BACKEND})`));

// Firebase's realtime listener stub is only relevant (and only safely
// importable) when running against Firebase RTDB.
if (DATA_BACKEND === 'local') {
  // Re-arm expiry for any clock that was running across a restart.
  await initTimerControl();
} else {
  const { initRealtimeListeners } = await import('./firebase-listener.js');
  initRealtimeListeners();
}

// Google Sheet auto-sync works against either backend (Store abstraction),
// so it's started unconditionally — it's a no-op if Sheets creds aren't set.
initSyncScheduler();
