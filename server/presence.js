// server/presence.js
// Live usage for the superadmin's Setup → Live now card: who is connected
// right now (by role, division, followed team, visible vs background) plus a
// few cheap server-health numbers. Built to cost next to nothing on game day:
//
// - Everything is in memory (a Map keyed by socket id). Nothing is written to
//   a database, the sheet or a log, and it all resets on a server restart.
// - Clients send a tiny `presence` message over the Socket.IO connection they
//   already hold, and only when something changes (sign-in, division, followed
//   team, tab hidden/shown). There is no per-client timer or heartbeat here;
//   Socket.IO's own ping drops dead connections.
// - Counts are computed only when a superadmin asks (GET /api/usage, polled
//   while the card is on screen), by one pass over the Map.
// - One 60s timer samples totals + health into a 12h ring buffer for the
//   trend line and the day's peak.
// - No IPs, names or device details are kept. The anonymous device id only
//   lets the summary tell "3 tabs on 1 phone" from "3 people"; it is a random
//   id the browser made, never sent anywhere else.
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { tierOf, getModeInfo } from './loadShield.js';

export const ROLES = ['superadmin', 'admin', 'parent', 'raffle', 'concessions', 'public'];

const SAMPLE_MS = 60 * 1000;
const HISTORY_MAX = 12 * 60;          // 12h of 1-minute samples
const MIN_UPDATE_GAP_MS = 500;        // per-socket flood guard
const MAX_CONNECTIONS_TRACKED = 5000; // hard ceiling on memory, far above real use

const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

/** socketId -> { role, division, team, court, view, visible, device, since, at } */
const conns = new Map();
let roleOf = () => null;

// --- Server health counters (all O(1) per event) ---
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
let lastCpu = process.cpuUsage();
let lastCpuAt = process.hrtime.bigint();
let reqCount = 0;
let errCount = 0;
let lastMinute = { requests: 0, errors: 0, lagP99: 0, lagMax: 0, cpuPct: 0 };
const history = [];
let peak = { total: 0, at: 0 };
let peakDay = dayKey(Date.now());
const startedAt = Date.now();

function dayKey(t) { return new Date(t).toDateString(); }

/** Wire in the token → role check from server/index.js (avoids a circular import). */
export function setRoleResolver(fn) { roleOf = typeof fn === 'function' ? fn : () => null; }

/** Express middleware: counts API requests and 5xx responses. */
export function requestCounter(req, res, next) {
  reqCount++;
  res.on('finish', () => { if (res.statusCode >= 500) errCount++; });
  next();
}

/** Called by server/socket.js for every new connection. */
export function trackSocket(socket) {
  if (conns.size >= MAX_CONNECTIONS_TRACKED) return;
  const now = Date.now();
  // Priority room (server/loadShield.js): staff get live pushes first.
  let tierRoom = 'tier:public';
  socket.join(tierRoom);
  conns.set(socket.id, { role: 'public', division: '', team: '', court: '', view: '', visible: true, device: '', since: now, at: 0 });
  notePeak(now);

  let token = null;
  socket.on('presence', (msg, ack) => {
    if (typeof ack === 'function') ack({ mode: getModeInfo().mode, pollFactor: getModeInfo().pollFactor });
    const c = conns.get(socket.id);
    if (!c || !msg || typeof msg !== 'object') return;
    const t = Date.now();
    if (t - c.at < MIN_UPDATE_GAP_MS) return;
    c.at = t;
    // Only re-check the token when it changes (one hash compare per role).
    const nextToken = clip(msg.token, 128) || null;
    if (nextToken !== token) {
      token = nextToken;
      c.role = (token && roleOf(token)) || 'public';
      const nextRoom = `tier:${tierOf(c.role)}`;
      if (nextRoom !== tierRoom) { socket.leave(tierRoom); socket.join(nextRoom); tierRoom = nextRoom; }
    }
    c.division = clip(msg.division, 80);
    c.team = clip(msg.team, 80);
    c.court = c.role === 'admin' ? clip(msg.court, 16) : '';
    c.view = clip(msg.view, 24);
    c.visible = msg.visible !== false;
    c.device = clip(msg.device, 40);
  });
  socket.on('disconnect', () => { conns.delete(socket.id); });
}

function notePeak(now) {
  const k = dayKey(now);
  if (k !== peakDay) { peakDay = k; peak = { total: 0, at: 0 }; }
  if (conns.size > peak.total) peak = { total: conns.size, at: now };
}

function sample() {
  const now = Date.now();
  const cpuNow = process.cpuUsage();
  const hr = process.hrtime.bigint();
  const elapsedUs = Number(hr - lastCpuAt) / 1000;
  const usedUs = (cpuNow.user - lastCpu.user) + (cpuNow.system - lastCpu.system);
  lastCpu = cpuNow; lastCpuAt = hr;
  lastMinute = {
    requests: reqCount,
    errors: errCount,
    lagP99: Math.round(loop.percentile(99) / 1e6),
    lagMax: Math.round(loop.max / 1e6),
    cpuPct: elapsedUs > 0 ? Math.round((usedUs / elapsedUs) * 100) : 0
  };
  reqCount = 0; errCount = 0; loop.reset();

  const byRole = {};
  for (const c of conns.values()) byRole[c.role] = (byRole[c.role] || 0) + 1;
  history.push({ t: now, total: conns.size, byRole, rssMb: Math.round(process.memoryUsage.rss() / 1048576), ...lastMinute });
  if (history.length > HISTORY_MAX) history.shift();
  notePeak(now);
}
setInterval(sample, SAMPLE_MS).unref();

/** One pass over the connections → the summary the Live now card shows. */
export function getUsageSummary() {
  const roles = {};
  for (const r of ROLES) roles[r] = { connections: 0, visible: 0, devices: new Set() };
  const divisions = new Map(); // name -> { viewers, visible, followers, teams: Map }
  const courts = new Map();
  const views = {};

  for (const c of conns.values()) {
    const r = roles[c.role] || roles.public;
    r.connections++;
    if (c.visible) r.visible++;
    if (c.device) r.devices.add(c.device);
    if (c.view) views[c.view] = (views[c.view] || 0) + 1;
    if (c.role === 'admin' && c.court) courts.set(c.court, (courts.get(c.court) || 0) + 1);
    if (c.division) {
      let d = divisions.get(c.division);
      if (!d) { d = { viewers: 0, visible: 0, followers: 0, teams: new Map() }; divisions.set(c.division, d); }
      d.viewers++;
      if (c.visible) d.visible++;
      if (c.team) { d.followers++; d.teams.set(c.team, (d.teams.get(c.team) || 0) + 1); }
    }
  }

  const allDevices = new Set();
  const byRole = {};
  for (const [name, r] of Object.entries(roles)) {
    for (const d of r.devices) allDevices.add(d);
    byRole[name] = { connections: r.connections, visible: r.visible, devices: r.devices.size };
  }
  const visible = Object.values(byRole).reduce((n, r) => n + r.visible, 0);

  const mem = process.memoryUsage();
  return {
    at: Date.now(),
    total: conns.size,
    visible,
    devices: allDevices.size,
    byRole,
    divisions: [...divisions.entries()]
      .map(([name, d]) => ({
        name, viewers: d.viewers, visible: d.visible, followers: d.followers,
        teams: [...d.teams.entries()].map(([team, count]) => ({ team, count })).sort((a, b) => b.count - a.count || a.team.localeCompare(b.team))
      }))
      .sort((a, b) => b.viewers - a.viewers || a.name.localeCompare(b.name)),
    courts: [...courts.entries()].map(([court, count]) => ({ court, count }))
      .sort((a, b) => String(a.court).localeCompare(String(b.court), undefined, { numeric: true })),
    views,
    peak,
    server: {
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      rssMb: Math.round(mem.rss / 1048576),
      heapUsedMb: Math.round(mem.heapUsed / 1048576),
      heapTotalMb: Math.round(mem.heapTotal / 1048576),
      load1: Math.round(os.loadavg()[0] * 100) / 100,
      cpus: os.cpus().length,
      lastMinute,
      // Live (partial-minute) lag so a stall shows up before the next sample.
      lagP99Now: Math.round(loop.percentile(99) / 1e6),
      requestsThisMinute: reqCount
    },
    history: history.map(h => ({ t: h.t, total: h.total, lagP99: h.lagP99, cpuPct: h.cpuPct, requests: h.requests }))
  };
}
