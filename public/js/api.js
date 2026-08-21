// public/js/api.js
// API base can be injected at runtime via `window.__API_BASE__` (set by server/config)
// Fallback to a relative path so same-origin deployments work without configuration.
//const API_BASE = (window.__API_BASE__ && window.__API_BASE__.length > 0) ? window.__API_BASE__ : '/api';

async function apiGet(endpoint) {
  try {
    const baseURL = window.location.origin;  // Dynamic host:port
    const response = await fetch(`${baseURL}/api${endpoint}`);  // Add /api prefix
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
  const baseURL = window.location.origin;
  const res = await fetch(`${baseURL}/api${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
  const baseURL = window.location.origin;
  const res = await fetch(`${baseURL}/api${endpoint}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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

export async function validateAdmin(password) {
  return await apiPost(`/validateAdmin`, { password });
}

export async function saveMatchResult(authToken, matchData) {
  return await apiPost(`/saveMatchResult`, { authToken, matchData });
}

export async function getSheetSyncConfig(authToken) {
  return await apiGet(`/sheetSync/config?authToken=${encodeURIComponent(authToken)}`);
}

export async function runSheetSync(authToken) {
  return await apiPost(`/sheetSync/run`, { authToken });
}

export async function pruneSheetSyncDivisions(authToken) {
  return await apiPost(`/sheetSync/prune`, { authToken });
}

export async function getSheetSyncStatus(authToken) {
  return await apiGet(`/sheetSync/status?authToken=${encodeURIComponent(authToken)}`);
}

export async function updateSheetSyncSettings(authToken, patch) {
  return await apiPost(`/sheetSync/settings`, { authToken, ...patch });
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

export async function postChatMessage(authToken, text, reporterName, court) {
  return await apiPost(`/chat`, { authToken, text, reporterName, court });
}

export async function deleteChatMessage(authToken, id) {
  return await apiDelete(`/chat/${id}`, { authToken });
}
