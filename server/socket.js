// server/socket.js
// Holds the Socket.IO server instance and division-room broadcast helpers.
// Split out from server/index.js so server/datastores/localStore.js can
// trigger broadcasts after a write without a circular import.
import { Server } from 'socket.io';

let io = null;

export function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: true }
  });

  io.on('connection', (socket) => {
    socket.on('joinDivision', (divisionName) => {
      if (!divisionName) return;
      socket.join(`division:${divisionName}`);
    });
  });

  return io;
}

export function broadcastDivisionUpdate(divisionName, payload) {
  if (!io || !divisionName) return;
  io.to(`division:${divisionName}`).emit('divisionUpdate', { division: divisionName, ...payload });
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
  if (!io) return;
  io.emit('syncStatusUpdate', status);
}

// Announcements and crew chat are tournament-wide (not division-scoped), so
// — like sync status — they broadcast to every connected client rather than
// a division room. Only DATA_BACKEND=local emits these; in firebase mode the
// browser listens to the RTDB nodes directly instead (see firebaseStore.js).
export function broadcastAnnouncementUpdate(announcements) {
  if (!io) return;
  io.emit('announcementUpdate', announcements);
}

export function broadcastChatUpdate(chat) {
  if (!io) return;
  io.emit('chatUpdate', chat);
}

// Feature toggles (e.g. champion celebration) are tournament-wide, so they
// broadcast to every connected client rather than a division room.
export function broadcastFeatureSettingsUpdate(settings) {
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
