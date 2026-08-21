import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { Store } from './datastores/index.js';
import * as SheetsMirror from './sheetsMirror.js';
import * as SheetsSync from './sheetsSync.js';
import { applySyncSettings, initSyncScheduler } from './syncScheduler.js';
import { initSocket } from './socket.js';
import crypto from 'crypto';
import axios from 'axios';



dotenv.config();

const DATA_BACKEND = (process.env.DATA_BACKEND || 'firebase').toLowerCase();

const app = express();
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
const SECRET_SALT = process.env.SECRET_SALT || 'secret-salt';

// route: getAllData
app.get('/api/allData', async (req, res) => {
  try {
    const sheetName = req.query.sheetName || 'Sheet1';
    const settings = {
      is_tie_allowed: (process.env.ALLOW_MATCH_TIE === 'true') || false,
      ga_measurement_id: process.env.GA_MEASUREMENT_ID || null
    };
    const standings = await Store.getStandings(sheetName);
    const schedule = await Store.getSchedule(sheetName);
    res.json({ settings, standings, schedule });
  } catch (e) {
    console.error('getAllData error', e);
    res.status(500).json({ error: e.toString() });
  }
});

// route: getDivisionNames
app.get('/api/divisions', async (_req, res) => {
  try {
    const names = await Store.getDivisionNames();
    res.json(names);
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

// route: validateAdminPassword
app.post('/api/validateAdmin', async (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) {
    const token = computeToken(ADMIN_PASSWORD);
    return res.json({ isAdmin: true, isSuperAdmin: false, token });
  }
  if (password === SUPERADMIN_PASSWORD) {
    const token = computeToken(SUPERADMIN_PASSWORD);
    // Firebase custom auth tokens are only meaningful when the browser talks
    // to Firebase RTDB directly (firebase mode) — local mode relies solely on
    // this SHA-256 authToken for all admin/superadmin writes.
    const firebaseToken = DATA_BACKEND !== 'local'
      ? await Store.createCustomToken('adminUser', { admin: true })
      : undefined;
    return res.json({ isAdmin: true, isSuperAdmin: true, token, firebaseToken });
  }
  if (PARENT_PASSWORD && password === PARENT_PASSWORD) {
    const token = computeToken(PARENT_PASSWORD);
    // Parents can post in the crew chat (identified as "Parent") but get no
    // match-entry, timer, or superadmin privileges — see requireChatAuth.
    return res.json({ isAdmin: false, isSuperAdmin: false, isParent: true, token });
  }
  res.json({ isAdmin: false, isSuperAdmin: false, isParent: false, error: 'Invalid password.' });
});

// route: saveMatchResult
app.post('/api/saveMatchResult', async (req, res) => {
  try {
    const { authToken, matchData } = req.body || {};

    // DEBUG: In dev, log token checks to help diagnose 401 issues for superadmin
    if (process.env.NODE_ENV !== 'production') {
      try {
        const expectedAdmin = computeToken(process.env.ADMIN_PASSWORD || '');
        const expectedSuper = computeToken(process.env.SUPERADMIN_PASSWORD || '');
        const adminMatch = authToken === expectedAdmin;
        const superMatch = authToken === expectedSuper;
        console.log('[DEBUG] /api/saveMatchResult token check:', {
          tokenSnippet: authToken ? authToken.slice(0, 8) : null,
          adminMatch,
          superMatch
        });
      } catch (dbgErr) {
        console.error('[DEBUG] token check failed', dbgErr);
      }
    }

    if (!isValidToken(authToken)) return res.status(401).json({ success: false, error: 'Authentication failed.' });

    // Detailed logging for save flow
    const requestId = crypto.randomBytes(4).toString('hex');
    const startTs = Date.now();
    console.log(`[${requestId}] /api/saveMatchResult START`, { sheetName: matchData?.sheetName, firebaseIndex: matchData?.firebaseIndex, rowIndex: matchData?.rowIndex, adminName: matchData?.adminName });

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
      sheetsMirrorResult = await SheetsMirror.saveMatchResult(matchData);
      console.log(`[${requestId}] SheetsMirror.saveMatchResult`, { durationMs: Date.now() - t0, sheetsMirrorResult });
    } catch (e) {
      console.error(`[${requestId}] SheetsMirror.saveMatchResult FAILED`, e);
      sheetsMirrorResult = { success: false, error: e.toString() };
    }

    const totalMs = Date.now() - startTs;
    console.log(`[${requestId}] /api/saveMatchResult COMPLETE`, { totalMs, storeResult, dbResult, sheetsMirrorResult });

    // Return the primary store's result to the client for compatibility.
    res.json(storeResult);
  } catch (e) {
    console.error('saveMatchResult error', e);
    res.status(500).json({ success: false, error: e.toString() });
  }
});

// --- Timer control endpoints (local mode only) ---
// In firebase mode the browser talks to Firebase RTDB directly for all timer
// state, so these endpoints exist purely for DATA_BACKEND=local, where the
// server is the source of truth and pushes updates over Socket.IO.

app.get('/api/timer', async (req, res) => {
  try {
    const sheetName = req.query.sheetName;
    const state = await Store.getTimerState(sheetName);
    res.json(state);
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

function requireAdmin(req, res) {
  const authToken = req.body?.authToken || req.query?.authToken;
  if (!isValidToken(authToken)) {
    res.status(401).json({ success: false, error: 'Authentication failed.' });
    return false;
  }
  return true;
}

app.post('/api/timer/start', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { sheetName, afterRound } = req.body;
    const current = await Store.getTimerState(sheetName);
    const state = afterRound
      ? await Store.setTimerState(sheetName, {
          running: true,
          startTime: Date.now(),
          duration: current.afterRoundDuration || 60,
          startAfterRoundRunning: true
        })
      : await Store.setTimerState(sheetName, {
          running: true,
          startTime: Date.now(),
          duration: current.duration || current.lastSetDuration || 300
        });
    res.json({ success: true, state });
  } catch (e) {
    res.status(500).json({ success: false, error: e.toString() });
  }
});

app.post('/api/timer/stop', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { sheetName } = req.body;
    const current = await Store.getTimerState(sheetName);
    let remaining = current.duration;
    if (current.running && current.startTime) {
      const elapsed = Math.floor((Date.now() - current.startTime) / 1000);
      remaining = Math.max((current.duration || 0) - elapsed, 0);
    }
    const state = await Store.setTimerState(sheetName, { running: false, duration: remaining });
    res.json({ success: true, state });
  } catch (e) {
    res.status(500).json({ success: false, error: e.toString() });
  }
});

app.post('/api/timer/reset', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { sheetName } = req.body;
    const current = await Store.getTimerState(sheetName);
    const state = await Store.setTimerState(sheetName, {
      running: false,
      duration: current.lastSetDuration || 300,
      startAfterRoundRunning: false
    });
    res.json({ success: true, state });
  } catch (e) {
    res.status(500).json({ success: false, error: e.toString() });
  }
});

app.post('/api/timer/adjust', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { sheetName, deltaSeconds } = req.body;
    const state = await Store.adjustTimer(sheetName, Number(deltaSeconds) || 0);
    res.json({ success: true, state });
  } catch (e) {
    res.status(500).json({ success: false, error: e.toString() });
  }
});

app.post('/api/timer/nextRound', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { sheetName, round } = req.body;
    const state = await Store.setTimerState(sheetName, { currentRound: round });
    res.json({ success: true, state });
  } catch (e) {
    res.status(500).json({ success: false, error: e.toString() });
  }
});

app.post('/api/timer/prevRound', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { sheetName, round } = req.body;
    const state = await Store.setTimerState(sheetName, { currentRound: round });
    res.json({ success: true, state });
  } catch (e) {
    res.status(500).json({ success: false, error: e.toString() });
  }
});

app.post('/api/timer/afterRoundDuration', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { sheetName, afterRoundDuration } = req.body;
    const state = await Store.setTimerState(sheetName, { afterRoundDuration: Number(afterRoundDuration) || 60 });
    res.json({ success: true, state });
  } catch (e) {
    res.status(500).json({ success: false, error: e.toString() });
  }
});

app.post('/api/timer/showClock', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { sheetName, showClock } = req.body;
    const state = await Store.setTimerState(sheetName, { showClock: !!showClock });
    res.json({ success: true, state });
  } catch (e) {
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
    const text = (req.body?.text || '').trim();
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
    if (typeof req.body?.text === 'string') patch.text = req.body.text.trim();
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
  const authToken = req.body?.authToken || req.query?.authToken;
  const expectedParent = computeToken(process.env.PARENT_PASSWORD || '');
  const isParent = !!process.env.PARENT_PASSWORD && authToken === expectedParent;
  if (!isValidToken(authToken) && !isParent) {
    res.status(401).json({ success: false, error: 'Authentication failed.' });
    return false;
  }
  return true;
}

app.get('/api/chat', async (_req, res) => {
  try {
    const list = await Store.getChatMessages();
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

app.post('/api/chat', async (req, res) => {
  if (!requireChatAuth(req, res)) return;
  try {
    const text = (req.body?.text || '').trim();
    if (!text) return res.status(400).json({ success: false, error: 'text is required' });

    const authToken = req.body?.authToken;
    const isMgr = authToken === computeToken(process.env.SUPERADMIN_PASSWORD || '');
    const isParent = !!process.env.PARENT_PASSWORD && authToken === computeToken(process.env.PARENT_PASSWORD || '');
    const reporterName = (req.body?.reporterName || '').trim() || 'Staff';
    const court = req.body?.court;
    const who = isMgr ? `Admin · ${reporterName}` : isParent ? `Parent · ${reporterName}` : `Court ${court || '?'} · ${reporterName}`;

    const chat = await Store.postChatMessage({ who, mgr: isMgr, text });
    res.json({ success: true, chat });
  } catch (e) {
    res.status(500).json({ success: false, error: e.toString() });
  }
});

app.delete('/api/chat/:id', async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const id = Number(req.params.id);
    const chat = await Store.deleteChatMessage(id);
    res.json({ success: true, chat });
  } catch (e) {
    res.status(500).json({ success: false, error: e.toString() });
  }
});

// --- Google Sheet sync endpoints (superadmin only) ---
// Settings/status/log are persisted via the Store abstraction (Firebase RTDB
// or MariaDB, depending on DATA_BACKEND — see server/datastores/) and
// broadcast to clients over Socket.IO, so these routes behave the same
// regardless of backend. Only /run and /config need the service-account
// Sheets client, which lives in sheetsSync.js.

function requireSuperAdmin(req, res) {
  const authToken = req.body?.authToken || req.query?.authToken;
  const expectedSuper = computeToken(process.env.SUPERADMIN_PASSWORD || '');
  if (!authToken || authToken !== expectedSuper) {
    res.status(403).json({ success: false, error: 'Superadmin access required.' });
    return false;
  }
  return true;
}

app.get('/api/sheetSync/config', async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const configured = SheetsSync.isConfigured();
    const availableDivisions = configured ? await SheetsSync.getAvailableDivisions() : [];
    res.json({
      configured,
      spreadsheetUrl: SheetsSync.getSpreadsheetUrl(),
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
    const { autoSyncEnabled, intervalSeconds, syncScope, selectedDivisions } = req.body || {};
    const patch = {};
    if (typeof autoSyncEnabled === 'boolean') patch.autoSyncEnabled = autoSyncEnabled;
    if (intervalSeconds != null) patch.intervalSeconds = Math.max(Number(intervalSeconds) || 300, 10);
    if (syncScope === 'all' || syncScope === 'selected') patch.syncScope = syncScope;
    if (Array.isArray(selectedDivisions)) patch.selectedDivisions = selectedDivisions.filter(d => typeof d === 'string' && d.trim()).map(d => d.trim());

    const status = await SheetsSync.updateSettings(patch);
    applySyncSettings(status.settings);
    res.json(status);
  } catch (e) {
    console.error('sheetSync/settings error', e);
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
  const expectedAdmin = computeToken(process.env.ADMIN_PASSWORD || '');
  const expectedSuper = computeToken(process.env.SUPERADMIN_PASSWORD || '');
  // Accept either admin or superadmin token
  return tokenFromClient === expectedAdmin || tokenFromClient === expectedSuper;
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
if (DATA_BACKEND !== 'local') {
  const { initRealtimeListeners } = await import('./firebase-listener.js');
  initRealtimeListeners();
}

// Google Sheet auto-sync works against either backend (Store abstraction),
// so it's started unconditionally — it's a no-op if Sheets creds aren't set.
initSyncScheduler();
