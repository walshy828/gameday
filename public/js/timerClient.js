// public/js/timerClient.js
// Identity of *this tab* for clock ownership. sessionStorage is per-tab and
// survives reloads, so a refresh keeps control but a second tab (even the same
// person) is a distinct controller and has to take over explicitly.
const KEY = 'timerClientId';

export function getClientId() {
  try {
    let id = sessionStorage.getItem(KEY);
    if (!id) {
      id = (crypto.randomUUID?.() || `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);
      sessionStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return 'volatile-' + Math.random().toString(36).slice(2, 12);
  }
}

export function getClientName() {
  try {
    return sessionStorage.getItem('reporterName') || 'Tournament manager';
  } catch {
    return 'Tournament manager';
  }
}
