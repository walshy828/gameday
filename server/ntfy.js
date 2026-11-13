// server/ntfy.js
// Optional phone push via ntfy. Off unless NTFY_URL (full topic URL, e.g.
// https://ntfy.example.com/gameday) is set; NTFY_TOKEN adds a bearer token.
// Best-effort: never throws, never blocks the request that triggered it.
import axios from 'axios';

/** ntfy headers must be plain ASCII/Latin-1; strip anything else (emoji, smart quotes). */
function headerSafe(v) {
  return String(v || '').replace(/[^\x20-\x7e\xa0-\xff]/g, '').trim();
}

export function ntfyEnabled() {
  return !!process.env.NTFY_URL;
}

export async function pushNtfy({ title, body, priority = 'default', tags = '' }) {
  const url = process.env.NTFY_URL;
  if (!url) return;
  try {
    await axios.post(url, String(body || ''), {
      timeout: 5000,
      headers: {
        Title: headerSafe(title),
        Priority: priority,
        ...(tags ? { Tags: tags } : {}),
        ...(process.env.NTFY_TOKEN ? { Authorization: `Bearer ${process.env.NTFY_TOKEN}` } : {})
      }
    });
  } catch (e) {
    console.error('ntfy push failed', e.message || e);
  }
}
