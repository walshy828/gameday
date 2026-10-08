// public/js/api.js
// API base can be injected at runtime via `window.__API_BASE__` (set by server/config)
// Fallback to a relative path so same-origin deployments work without configuration.
//const API_BASE = (window.__API_BASE__ && window.__API_BASE__.length > 0) ? window.__API_BASE__ : '/api';

// Auth tokens travel in the Authorization header, never in URLs (which end up
// in access logs) — the server also still accepts a body `authToken`.
function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Pulls `authToken` out of a request body so it's sent as a header instead.
function splitToken(body) {
  const { authToken, ...rest } = body || {};
  return { token: authToken, rest };
}

async function apiGet(endpoint, authToken) {
  try {
    const baseURL = window.location.origin;  // Dynamic host:port
    const response = await fetch(`${baseURL}/api${endpoint}`, { headers: authHeaders(authToken) });  // Add /api prefix
    if (!response.ok) {
      throw new Error(`GET /api${endpoint} failed: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error(error);
    throw error;
  }
}

async function apiPost(endpoint, body) {
  const { token, rest } = splitToken(body);
  const baseURL = window.location.origin;
  const res = await fetch(`${baseURL}/api${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify(rest),
  });
  if (!res.ok) {
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { parsed = text; }
    const err = new Error(`POST ${endpoint} failed: ${res.status} ${parsed && parsed.error ? parsed.error : text}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return await res.json();
}

async function apiDelete(endpoint, body) {
  const { token, rest } = splitToken(body);
  const baseURL = window.location.origin;
  const res = await fetch(`${baseURL}/api${endpoint}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify(rest),
  });
  if (!res.ok) {
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { parsed = text; }
    const err = new Error(`DELETE ${endpoint} failed: ${res.status} ${parsed && parsed.error ? parsed.error : text}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return await res.json();
}

// Expose functions your app can use
export async function getAllData(sheetName) {
  return await apiGet(`/allData?sheetName=${encodeURIComponent(sheetName)}`);
}

export async function getDivisions() {
  return await apiGet(`/divisions`);
}

export async function validateAdmin(password, reporterName, court, sessionId) {
  return await apiPost(`/validateAdmin`, { password, reporterName, court, sessionId });
}

export async function sendSessionHeartbeat(authToken, sessionId) {
  return await apiPost(`/session/heartbeat`, { authToken, sessionId });
}

export async function endSession(authToken, sessionId) {
  return await apiPost(`/session/logout`, { authToken, sessionId });
}

export async function getActiveSessions(authToken) {
  return await apiGet(`/session/active`, authToken);
}

export async function getLoginHistory(authToken) {
  return await apiGet(`/session/history`, authToken);
}

export async function getPresence(authToken) {
  return await apiGet(`/presence`, authToken);
}

export async function saveMatchResult(authToken, matchData) {
  return await apiPost(`/saveMatchResult`, { authToken, matchData });
}

export async function getSheetSyncConfig(authToken) {
  return await apiGet(`/sheetSync/config`, authToken);
}

export async function runSheetSync(authToken) {
  return await apiPost(`/sheetSync/run`, { authToken });
}

export async function pruneSheetSyncDivisions(authToken) {
  return await apiPost(`/sheetSync/prune`, { authToken });
}

export async function getSheetSyncStatus(authToken) {
  return await apiGet(`/sheetSync/status`, authToken);
}

export async function updateSheetSyncSettings(authToken, patch) {
  return await apiPost(`/sheetSync/settings`, { authToken, ...patch });
}

export async function updateFeatureSettings(authToken, patch) {
  return await apiPost(`/featureSettings`, { authToken, ...patch });
}

export async function getDiscrepancies(authToken) {
  return await apiGet(`/discrepancies`, authToken);
}

export async function dismissDiscrepancy(authToken, division, firebaseIndex, by) {
  return await apiPost(`/discrepancies/dismiss`, { authToken, division, firebaseIndex, by });
}

// Roster (Team Management) — superadmin only. getRoster uses fetch directly so a 503
// "not configured" / 500 message from the server reaches the UI instead of a bare status.
export async function getRoster(authToken, refresh = false) {
  const res = await fetch(`${window.location.origin}/api/roster${refresh ? '?refresh=1' : ''}`, { headers: authHeaders(authToken) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) throw new Error(body.error || `Roster failed to load (${res.status})`);
  return body;
}

export async function previewRosterAction(authToken, action) {
  return await apiPost(`/roster/preview`, { authToken, action });
}

// Resolves with the server body even for 400s (validation errors) so callers can show `errors`.
export async function applyRosterAction(authToken, action) {
  try {
    return await apiPost(`/roster/apply`, { authToken, action });
  } catch (e) {
    if (e.body && typeof e.body === 'object') return { ok: false, ...e.body, errors: e.body.errors || [e.body.error || e.message] };
    throw e;
  }
}

export async function setRosterCheckin(authToken, body) {
  return await apiPost(`/roster/checkin`, { authToken, ...body });
}

export async function addRosterCheckinNote(authToken, body) {
  return await apiPost(`/roster/checkin/note`, { authToken, ...body });
}

export async function getRosterCheckinLog(authToken, teamKey) {
  return await apiGet(`/roster/checkin/log?teamKey=${encodeURIComponent(teamKey)}`, authToken);
}

export async function getAnnouncements() {
  return await apiGet(`/announcements`);
}

export async function createAnnouncement(authToken, text) {
  return await apiPost(`/announcements`, { authToken, text });
}

export async function updateAnnouncement(authToken, id, patch) {
  return await apiPost(`/announcements/${id}`, { authToken, ...patch });
}

export async function deleteAnnouncement(authToken, id) {
  return await apiDelete(`/announcements/${id}`, { authToken });
}

export async function getChatMessages() {
  return await apiGet(`/chat`);
}

// Superadmin/parent only — the server refuses referee tokens.
export async function getLeadChatMessages(authToken) {
  return await apiGet(`/chat/lead`, authToken);
}

export async function postChatMessage(authToken, text, reporterName, court, sessionId, channel = 'crew') {
  return await apiPost(`/chat`, { authToken, text, reporterName, court, sessionId, channel });
}

export async function deleteChatMessage(authToken, id, channel = 'crew') {
  return await apiDelete(`/chat/${id}`, { authToken, channel });
}
