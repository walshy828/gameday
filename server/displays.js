// server/displays.js
// Wall boards (public/scoreboard.html), controlled centrally from
// Setup → Event day → "📺 Wall boards" (superadmin).
//
// Two halves:
// - live registry, in memory: which boards are connected right now and what
//   they report showing (socket id → { boardId, name, division, phase, … }).
//   A board identifies itself with a stable boardId (its ?board= param, else a
//   random id it keeps in localStorage), so two TVs opened with the same
//   ?board= share one config — a deliberate way to group screens.
// - config, persisted through the Store (injected by server/index.js to avoid
//   an import cycle with socket.js → datastores → socket.js):
//     { nowRunning: [division…], rotateSecs, boards: { [boardId]: { name, mode, divisions, rotateSecs, view, countdown } } }
//   mode: 'follow'  show nowRunning (the board's own local setup when that's empty)
//         'pinned'  show `divisions` (local setup when empty)
//         'local'   ignore the server; the screen's own setup (today's behaviour)
//   view: 'auto' (phase-driven) | 'courts' | 'playoffs' | 'bracket' — see scoreboard.html
//   countdown: seconds of the big final-seconds overlay (0 = off, null = the
//     screen's own ?countdown= / default 10); applies in every mode, Local too
//
// Boards need no login and only ever RECEIVE config; the one thing a board may
// change is its own mode → 'local' (someone at the screen chose "Use local
// setup"), which the superadmin sees and can flip back. Everything else goes
// through the superadmin-only REST routes in server/index.js.

const MODES = ['follow', 'pinned', 'local'];
const VIEWS = ['auto', 'courts', 'playoffs', 'bracket'];
const MAX_DIVISIONS = 4;
const MAX_BOARDS = 100;
const SAVE_DEBOUNCE_MS = 1500;

let io = null;
let persist = { load: async () => null, save: async () => {} };
let config = { nowRunning: [], rotateSecs: 30, boards: {} };
let loaded = null;
let saveTimer = null;

/** socket id → live info */
const live = new Map();
/** boardId → last time any socket of that board was connected (memory only) */
const lastSeen = new Map();

const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
export const cleanBoardId = (v) => {
  const id = clip(v, 40).toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{1,39}$/.test(id) ? id : '';
};
const cleanDivisions = (list) => (Array.isArray(list) ? list : [])
  .map(d => clip(d, 100)).filter(Boolean)
  .filter((d, i, a) => a.indexOf(d) === i)
  .slice(0, MAX_DIVISIONS);
const cleanSecs = (v, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(600, n)) : dflt;
};

const cleanCountdown = (v) => {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(60, n)) : null;
};

function normalizeBoard(b = {}, fallbackName = '') {
  return {
    name: clip(b.name, 40) || fallbackName,
    mode: MODES.includes(b.mode) ? b.mode : 'follow',
    divisions: cleanDivisions(b.divisions),
    rotateSecs: b.rotateSecs == null ? null : cleanSecs(b.rotateSecs, null),
    view: VIEWS.includes(b.view) ? b.view : 'auto',
    countdown: cleanCountdown(b.countdown)
  };
}

function normalizeConfig(c) {
  const out = { nowRunning: cleanDivisions(c?.nowRunning), rotateSecs: cleanSecs(c?.rotateSecs, 30), boards: {} };
  Object.entries(c?.boards || {}).slice(0, MAX_BOARDS).forEach(([id, b]) => {
    const key = cleanBoardId(id);
    if (key) out.boards[key] = normalizeBoard(b, key);
  });
  return out;
}

export function setPersistence(p) {
  if (p && typeof p.load === 'function' && typeof p.save === 'function') persist = p;
}

async function ensureLoaded() {
  if (!loaded) {
    loaded = (async () => {
      try {
        const raw = await persist.load();
        if (raw) config = normalizeConfig(raw);
      } catch (e) {
        console.error('[displays] could not load config:', e.message);
      }
    })();
  }
  return loaded;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    persist.save(config).catch(e => console.error('[displays] could not save config:', e.message));
  }, SAVE_DEBOUNCE_MS);
}

/** What one board should do. */
export function configFor(boardId) {
  const board = config.boards[boardId] || normalizeBoard({}, boardId);
  return { boardId, board, nowRunning: config.nowRunning, rotateSecs: config.rotateSecs, at: Date.now() };
}

function pushTo(boardId) {
  io?.to(`display:${boardId}`).emit('displayConfig', configFor(boardId));
}
function pushAll() {
  const ids = new Set([...live.values()].map(l => l.boardId));
  ids.forEach(pushTo);
}
/** Data-less nudge so an open Setup → Wall boards card refetches. */
function nudgeAdmins() {
  io?.to('tier:staff').emit('displaysUpdate');
}

// --- sockets --------------------------------------------------------------------

export function initDisplays(ioServer) {
  io = ioServer;
}

export function attachDisplaySocket(socket) {
  socket.on('displayHello', async (p, ack) => {
    const boardId = cleanBoardId(p?.boardId);
    if (!boardId) { if (typeof ack === 'function') ack({ error: 'bad boardId' }); return; }
    await ensureLoaded();
    const prev = live.get(socket.id);
    if (prev && prev.boardId !== boardId) socket.leave(`display:${prev.boardId}`);
    socket.join(`display:${boardId}`);
    if (!config.boards[boardId] && Object.keys(config.boards).length < MAX_BOARDS) {
      // First sight of this board: a screen opened with an explicit ?d1= setup
      // (or ?mode=local) starts in local mode so nothing hijacks it.
      config.boards[boardId] = normalizeBoard({ name: p?.name, mode: p?.prefer === 'local' ? 'local' : 'follow' }, boardId);
      scheduleSave();
    }
    live.set(socket.id, { boardId, connectedAt: Date.now(), ...stateOf(p) });
    lastSeen.set(boardId, Date.now());
    if (typeof ack === 'function') ack(configFor(boardId));
    nudgeAdmins();
  });

  socket.on('displayState', (p) => {
    const cur = live.get(socket.id);
    if (!cur) return;
    live.set(socket.id, { ...cur, ...stateOf(p) });
    nudgeAdmins();
  });

  // Someone at the screen chose "Use local setup".
  socket.on('displayGoLocal', () => {
    const cur = live.get(socket.id);
    if (!cur || !config.boards[cur.boardId]) return;
    config.boards[cur.boardId].mode = 'local';
    scheduleSave();
    pushTo(cur.boardId);
    nudgeAdmins();
  });

  socket.on('disconnect', () => {
    const cur = live.get(socket.id);
    if (!cur) return;
    live.delete(socket.id);
    lastSeen.set(cur.boardId, Date.now());
    nudgeAdmins();
  });
}

function stateOf(p) {
  return {
    division: clip(p?.division, 100),
    divisions: cleanDivisions(p?.divisions),
    phase: clip(p?.phase, 16),
    source: p?.source === 'remote' ? 'remote' : 'local',
    screen: clip(p?.screen, 20)
  };
}

// --- superadmin API ---------------------------------------------------------------

export async function listBoards() {
  await ensureLoaded();
  const byBoard = new Map();
  for (const l of live.values()) {
    if (!byBoard.has(l.boardId)) byBoard.set(l.boardId, []);
    byBoard.get(l.boardId).push(l);
  }
  const ids = new Set([...Object.keys(config.boards), ...byBoard.keys()]);
  const boards = [...ids].map(id => {
    const screens = byBoard.get(id) || [];
    const latest = screens.sort((a, b) => b.connectedAt - a.connectedAt)[0] || null;
    return {
      boardId: id,
      ...configFor(id).board,
      online: screens.length,
      lastSeen: screens.length ? Date.now() : (lastSeen.get(id) || null),
      showing: latest ? { division: latest.division, divisions: latest.divisions, phase: latest.phase, source: latest.source, screen: latest.screen } : null
    };
  }).sort((a, b) => (b.online > 0) - (a.online > 0) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { nowRunning: config.nowRunning, rotateSecs: config.rotateSecs, boards };
}

export async function setNowRunning({ nowRunning, rotateSecs }) {
  await ensureLoaded();
  if (nowRunning !== undefined) config.nowRunning = cleanDivisions(nowRunning);
  if (rotateSecs !== undefined) config.rotateSecs = cleanSecs(rotateSecs, config.rotateSecs);
  scheduleSave();
  pushAll();
  nudgeAdmins();
  return listBoards();
}

export async function updateBoard(boardId, patch = {}) {
  await ensureLoaded();
  const id = cleanBoardId(boardId);
  if (!id) throw new Error('Unknown board.');
  if (patch.mode !== undefined && !MODES.includes(patch.mode)) throw new Error('Unknown mode.');
  if (patch.view !== undefined && !VIEWS.includes(patch.view)) throw new Error('Unknown view.');
  const cur = config.boards[id] || normalizeBoard({}, id);
  const next = { ...cur };
  if (patch.name !== undefined) next.name = clip(patch.name, 40) || cur.name;
  if (patch.mode !== undefined) next.mode = patch.mode;
  if (patch.divisions !== undefined) next.divisions = patch.divisions;
  if (patch.rotateSecs !== undefined) next.rotateSecs = patch.rotateSecs;
  if (patch.view !== undefined) next.view = patch.view;
  if (patch.countdown !== undefined) next.countdown = patch.countdown;
  config.boards[id] = normalizeBoard(next, id);
  scheduleSave();
  pushTo(id);
  nudgeAdmins();
  return listBoards();
}

export async function forgetBoard(boardId) {
  await ensureLoaded();
  const id = cleanBoardId(boardId);
  delete config.boards[id];
  lastSeen.delete(id);
  scheduleSave();
  pushTo(id); // a still-connected screen falls back to defaults
  nudgeAdmins();
  return listBoards();
}

/** identify (flash the board's name) | reload. boardId '*' = every board. */
export function command(boardId, type) {
  if (!['identify', 'reload'].includes(type)) throw new Error('Unknown command.');
  if (boardId === '*') {
    const ids = new Set([...live.values()].map(l => l.boardId));
    ids.forEach(id => io?.to(`display:${id}`).emit('displayCommand', { type, name: configFor(id).board.name }));
    return ids.size;
  }
  const id = cleanBoardId(boardId);
  if (!id) throw new Error('Unknown board.');
  io?.to(`display:${id}`).emit('displayCommand', { type, name: configFor(id).board.name });
  return [...live.values()].filter(l => l.boardId === id).length;
}
