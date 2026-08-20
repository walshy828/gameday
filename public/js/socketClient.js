// public/js/socketClient.js
// Lazily-created singleton Socket.IO client, used only when
// window.__DATA_BACKEND__ === 'local' (see public/index.html for the CDN
// script that provides the global `io` function).
let socket = null;

export function getSocket() {
  if (!socket) {
    if (typeof io !== 'function') {
      throw new Error('Socket.IO client not loaded — expected the global `io` from the CDN script in index.html.');
    }
    socket = io();
  }
  return socket;
}
