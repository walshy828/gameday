import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import * as Sheets from './sheets.js';
import * as Fb from './firebase.js';
import crypto from 'crypto';
import axios from 'axios';
import { initRealtimeListeners } from './firebase-listener.js';



dotenv.config();
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

// Serve a tiny runtime config JS that the frontend can read to know API_BASE.
// Set API_BASE in your Docker/hosting environment as the full API base (e.g. https://api.example.com/api)
app.get('/config.js', (req, res) => {
  const apiBase = process.env.API_BASE || '';
  res.type('application/javascript');
  // Safely serialize the string
  const gaMeasurementId = process.env.GA_MEASUREMENT_ID || null;
  res.send(`window.__API_BASE__ = ${JSON.stringify(apiBase)};\nwindow.__GA_MEASUREMENT_ID__ = ${JSON.stringify(gaMeasurementId)};`);
});

// Utilities from env
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SUPERADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD;
const SECRET_SALT = process.env.SECRET_SALT || 'secret-salt';

// route: getAllData
app.get('/api/allData', async (req, res) => {
  try {
    const sheetName = req.query.sheetName || 'Sheet1';
    const settings = { 
      is_tie_allowed: (process.env.ALLOW_MATCH_TIE === 'true') || false,
      ga_measurement_id: process.env.GA_MEASUREMENT_ID || null
    };
    const standings = await Sheets.getStandings(sheetName);
    const schedule = await Sheets.getSchedule(sheetName);
    res.json({ settings, standings, schedule });
  } catch (e) {
    console.error('getAllData error', e);
    res.status(500).json({ error: e.toString() });
  }
});

// route: getDivisionNames
app.get('/api/divisions', async (_req, res) => {
  try {
    const names = await Sheets.getDivisionNames();
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
    const s = await Sheets.getStandings(sheetName);
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
    const firebaseToken = await Fb.createCustomToken('adminUser', { admin: true });
    return res.json({ isAdmin: true, isSuperAdmin: true, token, firebaseToken });
  }
  res.json({ isAdmin: false, isSuperAdmin: false, error: 'Invalid password.' });
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

    let sheetsResult = null;
    try {
      const t0 = Date.now();
      sheetsResult = await Sheets.saveMatchResult(matchData);
      console.log(`[${requestId}] Sheets.saveMatchResult OK`, { durationMs: Date.now() - t0, sheetsResult });
    } catch (err) {
      console.error(`[${requestId}] Sheets.saveMatchResult FAILED`, err);
      // continue to attempt other writes, but surface error
      sheetsResult = { success: false, error: err.toString() };
    }

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

    // push update to firebase realtime (also log result)
    let fbPushResult = null;
    try {
      const t0 = Date.now();
      await Fb.pushMatchUpdate(matchData.sheetName, matchData.firebaseIndex, {
        adminName: matchData.adminName,
        adminWinner: matchData.winner,
        adminPlayersRemaining: matchData.playersRemaining,
        notes: matchData.notes,
        lastUpdated: new Date().toISOString()
      });
      fbPushResult = { success: true, durationMs: Date.now() - t0 };
      console.log(`[${requestId}] Fb.pushMatchUpdate OK`, fbPushResult);
    } catch (e) {
      console.error(`[${requestId}] Fb.pushMatchUpdate FAILED`, e);
      fbPushResult = { success: false, error: e.toString() };
    }

    const totalMs = Date.now() - startTs;
    console.log(`[${requestId}] /api/saveMatchResult COMPLETE`, { totalMs, sheetsResult, dbResult, fbPushResult });

    // Return the sheetsResult to the client for compatibility
    res.json(sheetsResult);
  } catch (e) {
    console.error('saveMatchResult error', e);
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
app.listen(PORT, () => console.log(`Server started at http://localhost:${PORT}`));

// Then start Firebase listeners
initRealtimeListeners();