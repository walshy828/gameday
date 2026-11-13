// server/socket.js
// Holds the Socket.IO server instance and division-room broadcast helpers.
// Split out from server/index.js so server/datastores/localStore.js can
// trigger broadcasts after a write without a circular import.
import { Server } from 'socket.io';
import { trackSocket } from './presence.js';
import { getMode, getModeInfo, pushDelay, invalidate } from './loadShield.js';

let io = null;

export function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: true }
  });

  io.on('connection', (socket) => {
    // Live usage (Setup → Live now): in-memory only, see server/presence.js.
    trackSocket(socket);
    // Tell the tab the current traffic level so public clients can slow their polling.
    socket.emit('trafficMode', trafficPayload());
    // A tab watches one division at a time: joining one leaves the others, and
    // the ack tells the client it is now subscribed (so it can fetch current
    // state without missing an update that lands between fetch and join).
    socket.on('joinDivision', (divisionName, ack) => {
      if (!divisionName) return;
      for (const room of socket.rooms) {
        if (room.startsWith('division:') && room !== `division:${divisionName}`) socket.leave(room);
      }
      socket.join(`division:${divisionName}`);
      if (typeof ack === 'function') ack();
    });
  });

  return io;
}

// --- Traffic priority (server/loadShield.js) ---
// Every socket sits in one tier room (tier:staff / tier:parent / tier:public,
// kept by server/presence.js). In Normal a division update goes to the whole
// division room at once. In Ease/Protect staff still get it instantly, while
// parents/public get the latest snapshot batched (trailing) per division.
const TIERS = ['staff', 'parent', 'public'];
const pending = new Map(); // `${division}|${tier}` -> { timer, msg }

function trafficPayload() {
  const { mode, pollFactor } = getModeInfo();
  return { mode, pollFactor };
}

function emitToTier(room, tier, event, msg) {
  io.to(room).except(TIERS.filter(t => t !== tier).map(t => `tier:${t}`)).emit(event, msg);
}

/** Send any batched public/parent updates now (used when the level is lowered). */
export function flushPendingDivisionUpdates() {
  for (const [key, p] of pending) {
    clearTimeout(p.timer);
    const [division, tier] = key.split('|');
    emitToTier(`division:${division}`, tier, 'divisionUpdate', p.msg);
  }
  pending.clear();
}

export function broadcastTrafficMode() {
  if (!io) return;
  io.emit('trafficMode', trafficPayload());
}

export function broadcastDivisionUpdate(divisionName, payload) {
  invalidate(`allData:${divisionName}`);
  invalidate('divisions');
  if (!io || !divisionName) return;
  const room = `division:${divisionName}`;
  const msg = { division: divisionName, ...payload };
  if (getMode() === 'normal' && !pending.size) { io.to(room).emit('divisionUpdate', msg); return; }
  for (const tier of TIERS) {
    const delay = pushDelay(tier);
    const key = `${divisionName}|${tier}`;
    if (!delay) { emitToTier(room, tier, 'divisionUpdate', msg); continue; }
    const p = pending.get(key);
    if (p) { p.msg = msg; continue; } // keep the timer, send the newest snapshot
    const entry = { msg, timer: null };
    entry.timer = setTimeout(() => { pending.delete(key); emitToTier(room, tier, 'divisionUpdate', entry.msg); }, delay);
    entry.timer.unref?.();
    pending.set(key, entry);
  }
}

export function broadcastTimerUpdate(divisionName, state) {
  if (!io || !divisionName) return;
  io.to(`division:${divisionName}`).emit('timerUpdate', { division: divisionName, ...state });
}

// Google Sheet sync status (settings/log) isn't division-scoped and only the
// Settings page listens for it, so this broadcasts to every connected
// client rather than a room — used for both DATA_BACKEND=firebase and
// =local so the Settings page gets the same realtime behavior either way.
export function broadcastSyncStatus(status) {
  invalidate('divisions');
  if (!io) return;
  io.emit('syncStatusUpdate', status);
}

// Announcements and crew chat are tournament-wide (not division-scoped), so
// — like sync status — they broadcast to every connected client rather than
// a division room. Only DATA_BACKEND=local emits these; in firebase mode the
// browser listens to the RTDB nodes directly instead (see firebaseStore.js).
export function broadcastAnnouncementUpdate(announcements) {
  invalidate('announcements');
  if (!io) return;
  io.emit('announcementUpdate', announcements);
}

export function broadcastChatUpdate(chat) {
  if (!io) return;
  io.emit('chatUpdate', chat);
}

// Leadership-channel chat is superadmin/parent-only, so the broadcast carries
// no message data (it would reach referees' sockets too) — it's just a nudge
// for authorized clients to refetch GET /api/chat/lead.
export function broadcastChatLeadPing() {
  if (!io) return;
  io.emit('chatLeadPing');
}

// Result discrepancies (referee-reported vs official) are superadmin-only, so
// like the leadership chat ping this carries no data — it's only a nudge for
// superadmin clients to refetch GET /api/discrepancies.
export function broadcastDiscrepancyPing() {
  if (!io) return;
  io.emit('discrepancyUpdate');
}

// Feature toggles (e.g. champion celebration) are tournament-wide, so they
// broadcast to every connected client rather than a division room.
export function broadcastFeatureSettingsUpdate(settings) {
  invalidate('allData:');
  if (!io) return;
  io.emit('featureSettingsUpdate', settings);
}

// Auto-sync switches itself off after a fixed run time (see
// server/syncScheduler.js). Superadmin clients listen for this to warn
// before it happens ({ type: 'warning' }) and when it has ({ type: 'expired' }).
export function broadcastAutoSyncNotice(notice) {
  if (!io) return;
  io.emit('autoSyncNotice', notice);
}

// Court readiness board (see server/courtStatus.js). Goes to every client
// (the public "My team" card follows it too), so it carries no data — just a
// nudge to refetch (staff: GET /api/courtStatus, public: /api/courtStatus/public).
export function broadcastCourtStatusUpdate() {
  if (!io) return;
  io.emit('courtStatusUpdate');
}

// Court issue flags (see server/courtIssues.js). Data-less nudge: staff
// refetch GET /api/courtIssues; public clients don't listen for it.
export function broadcastCourtIssueUpdate() {
  if (!io) return;
  io.emit('courtIssueUpdate');
}
