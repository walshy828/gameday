#!/usr/bin/env node
// server/scripts/stressTest.js
// Simulates a game-day crowd against a running server: each virtual user does
// what a parent's phone does (open the app, load a division, hold a live
// connection, poll the My team card, re-sync the clock, occasionally come
// back from the lock screen), and the script reports response times, errors
// and live-connection health as it goes.
//
//   npm run stress -- --url http://localhost:8888 --users 150
//
// Options (all optional):
//   --url <base>        server to test (default http://localhost:8888)
//   --users <n>         virtual users (default 150)
//   --ramp <sec>        spread the arrivals over this long (default 30)
//   --duration <sec>    how long to run after ramp-up (default 300)
//   --burst             halfway through, every user reloads at the same moment
//                       (worst case: an announcement makes everyone refresh)
//   --staff-token <t>   or STRESS_STAFF_TOKEN: a referee/superadmin token. The
//                       script then also times a "staff" load every 5s, which
//                       should stay fast even when the crowd is throttled.
//
// It only READS. It never saves results or changes settings, so it is safe to
// point at a server holding real data. Don't run it against the live server
// during the event: it is meant to be run beforehand. Virtual users show up in
// Setup → Live now as participants (device ids start with "stress-").
import { io } from 'socket.io-client';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const BASE = String(opt('url', 'http://localhost:8888')).replace(/\/$/, '');
const USERS = Number(opt('users', 150));
const RAMP_S = Number(opt('ramp', 30));
const DURATION_S = Number(opt('duration', 300));
const BURST = opt('burst', false) === true;
const STAFF_TOKEN = opt('staff-token', process.env.STRESS_STAFF_TOKEN || '') || '';

const lat = new Map(); // endpoint -> number[] (ms) for the current window
const allLat = new Map(); // endpoint -> number[] for the whole run
const counts = { requests: 0, errors: 0, status: {}, connectErrors: 0, disconnects: 0, divisionUpdate: 0, timerUpdate: 0 };
const sockets = [];
const timers = [];
let stopping = false;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (ms) => ms * (0.75 + Math.random() * 0.5);
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};
function record(name, ms) {
  for (const m of [lat, allLat]) { if (!m.has(name)) m.set(name, []); m.get(name).push(ms); }
}

async function get(name, path, token) {
  const t0 = performance.now();
  counts.requests++;
  try {
    const res = await fetch(BASE + path, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(15000) });
    counts.status[res.status] = (counts.status[res.status] || 0) + 1;
    const body = await res.text();
    record(name, performance.now() - t0);
    if (!res.ok) { counts.errors++; return null; }
    try { return JSON.parse(body); } catch { return null; }
  } catch (e) {
    counts.errors++;
    counts.status[e.name === 'TimeoutError' ? 'timeout' : 'network'] = (counts.status[e.name === 'TimeoutError' ? 'timeout' : 'network'] || 0) + 1;
    record(name, performance.now() - t0);
    return null;
  }
}

const enc = encodeURIComponent;
async function loadDivision(division) {
  await Promise.all([
    get('allData', `/api/allData?sheetName=${enc(division)}`),
    get('timer', `/api/timer?sheetName=${enc(division)}`),
    get('announcements', '/api/announcements')
  ]);
}

async function virtualUser(i, divisions) {
  const division = divisions[i % divisions.length];
  const following = Math.random() < 0.7; // most parents follow their kid's team
  await get('divisions', '/api/divisions');
  await loadDivision(division);
  get('time', '/api/time');

  const socket = io(BASE, { reconnection: true, forceNew: true });
  sockets.push(socket);
  socket.on('connect', () => {
    socket.emit('presence', { token: '', division, team: following ? `Stress team ${(i % 6) + 1}` : '', view: 'standings', visible: true, device: `stress-${i}` }, () => {});
    socket.emit('joinDivision', division, () => {});
  });
  socket.on('connect_error', () => { counts.connectErrors++; });
  socket.on('disconnect', () => { if (!stopping) counts.disconnects++; });
  socket.on('divisionUpdate', () => { counts.divisionUpdate++; });
  socket.on('timerUpdate', () => { counts.timerUpdate++; });

  // My team card poll (30s), server clock (60s), lock-screen resume (every few minutes).
  if (following) timers.push(setInterval(() => get('courtStatus', `/api/courtStatus/public?division=${enc(division)}`), jitter(30000)));
  timers.push(setInterval(() => get('time', '/api/time'), jitter(60000)));
  timers.push(setInterval(() => loadDivision(division), jitter(180000)));
}

function report(label) {
  const conn = sockets.filter(s => s.connected).length;
  const rows = [...lat.entries()].map(([k, v]) => `${k} p50 ${pct(v, 50)} p95 ${pct(v, 95)} p99 ${pct(v, 99)} (${v.length})`);
  console.log(`[${label}] sockets ${conn}/${sockets.length} · requests ${counts.requests} · errors ${counts.errors} · pushes div ${counts.divisionUpdate} timer ${counts.timerUpdate}`);
  for (const r of rows) console.log('    ' + r);
  lat.clear();
}

async function main() {
  console.log(`Stress test → ${BASE}: ${USERS} users over ${RAMP_S}s, then ${DURATION_S}s${BURST ? ', with a reload burst halfway' : ''}${STAFF_TOKEN ? ', timing staff loads' : ''}.`);
  const divisions = await get('divisions', '/api/divisions');
  const list = Array.isArray(divisions) && divisions.length ? divisions.map(d => (typeof d === 'string' ? d : d.name)).filter(Boolean) : ['Sheet1'];
  console.log(`Divisions: ${list.join(', ')}`);
  const started = Date.now();
  const reporter = setInterval(() => report(`${Math.round((Date.now() - started) / 1000)}s`), 10000);

  if (STAFF_TOKEN) {
    timers.push(setInterval(() => get('STAFF allData', `/api/allData?sheetName=${enc(list[0])}`, STAFF_TOKEN), 5000));
  }

  const gap = (RAMP_S * 1000) / Math.max(1, USERS);
  for (let i = 0; i < USERS; i++) {
    virtualUser(i, list);
    await sleep(gap);
  }
  console.log(`All ${USERS} users arrived.`);

  if (BURST) {
    await sleep((DURATION_S * 1000) / 2);
    console.log('>>> Burst: every user reloads now');
    await Promise.all(Array.from({ length: USERS }, (_, i) => get('divisions', '/api/divisions').then(() => loadDivision(list[i % list.length]))));
    console.log('<<< Burst done');
    await sleep((DURATION_S * 1000) / 2);
  } else {
    await sleep(DURATION_S * 1000);
  }

  stopping = true;
  clearInterval(reporter);
  for (const t of timers) clearInterval(t);
  report('final window');
  console.log('\n=== Whole run ===');
  let worstP95 = 0;
  for (const [k, v] of allLat) {
    const p95 = pct(v, 95);
    if (!k.startsWith('STAFF')) worstP95 = Math.max(worstP95, p95);
    console.log(`${k.padEnd(16)} n=${String(v.length).padStart(6)}  p50 ${pct(v, 50)}ms  p95 ${p95}ms  p99 ${pct(v, 99)}ms  max ${pct(v, 100)}ms`);
  }
  const errRate = counts.requests ? counts.errors / counts.requests : 0;
  console.log(`Requests ${counts.requests}, errors ${counts.errors} (${(errRate * 100).toFixed(2)}%), status ${JSON.stringify(counts.status)}`);
  console.log(`Socket connect errors ${counts.connectErrors}, unexpected disconnects ${counts.disconnects}`);
  console.log(`Live pushes received: ${counts.divisionUpdate} division updates, ${counts.timerUpdate} clock updates${counts.divisionUpdate ? '' : ' (none: nobody saved a result during the run)'}`);
  const verdict = errRate > 0.01 || counts.disconnects > USERS * 0.05 ? 'PROBLEM: errors or dropped connections — check the server logs and Setup → Live now.'
    : worstP95 > 1000 ? 'SLOW: 95% of requests took over 1s. Try again with Ease on, or give the server more CPU/RAM.'
      : worstP95 > 300 ? 'OK but busy: usable, keep an eye on it on the day.'
        : 'GOOD: fast with no errors at this load.';
  console.log(`Verdict: ${verdict}`);
  for (const s of sockets) s.close();
  process.exit(0);
}

process.on('SIGINT', () => { stopping = true; report('interrupted'); for (const s of sockets) s.close(); process.exit(130); });
main().catch(e => { console.error(e); process.exit(1); });
