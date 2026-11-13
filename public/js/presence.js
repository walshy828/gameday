// public/js/presence.js
// Tells the server what this tab is doing, for the superadmin's Setup →
// Live now card (server/presence.js). Deliberately tiny:
//
// - Rides the Socket.IO connection the app already holds (in firebase mode
//   this opens one idle socket per tab, which costs the server ~nothing).
// - Sends only when something changed: sign-in role, division, followed team,
//   court, tab, or the tab being hidden/shown. A 5s local check (no network)
//   catches changes made elsewhere in the app without wiring every module.
// - Carries no names or personal data: the sign-in token (so the server can
//   tell the role itself), the division and followed team, and a random
//   per-browser id so the card can count phones as well as tabs.
import { getSocket } from './socketClient.js';
import { getFollowed } from './follow.js';

const DEVICE_KEY = 'presenceDevice';
const CHECK_MS = 5000;

let socket = null;
let lastSig = '';

function deviceId() {
    try {
        let id = localStorage.getItem(DEVICE_KEY);
        if (!id) {
            id = (crypto.randomUUID?.() || String(Math.random()).slice(2)).slice(0, 36);
            localStorage.setItem(DEVICE_KEY, id);
        }
        return id;
    } catch (e) { return ''; }
}

function snapshot() {
    const inApp = App.state.screen === 'app';
    const division = inApp ? (App.config.currentSheetName || '') : '';
    return {
        token: sessionStorage.getItem('adminAuthToken') || '',
        division,
        team: division ? (getFollowed(division) || '') : '',
        court: App.state.isAdmin && !App.state.isSuperAdmin ? (App.state.selectedCourt || '') : '',
        view: inApp ? (App.state.currentView || '') : 'gate',
        visible: document.visibilityState !== 'hidden',
        device: deviceId()
    };
}

function report(force = false) {
    if (!socket || !socket.connected) return;
    const snap = snapshot();
    const sig = JSON.stringify(snap);
    if (!force && sig === lastSig) return;
    lastSig = sig;
    socket.emit('presence', snap);
}

export function initPresence() {
    try { socket = getSocket(); } catch (e) { return; } // Socket.IO not loaded: no tracking, app unaffected
    // Each (re)connect is a new server-side entry, so always resend then.
    socket.on('connect', () => report(true));
    if (socket.connected) report(true);
    window.addEventListener('followchange', () => report());
    document.addEventListener('visibilitychange', () => report());
    setInterval(() => report(), CHECK_MS);
}
