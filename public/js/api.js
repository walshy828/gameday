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
