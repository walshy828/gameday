// public/js/usage.js
// Setup → Live now (superadmin): how many people are connected right now, by
// role, division and followed team, plus server health. Reads GET /api/usage
// (in-memory counts from server/presence.js) every 10s, but only while the
// Setup page is on screen in a visible tab, so it costs nothing otherwise.
import { getUsage } from './api.js';

const POLL_MS = 10000;
const ROLE_ROWS = [
    { key: 'public', label: 'Participants & parents', note: 'no sign-in' },
    { key: 'admin', label: 'Referees', note: 'court managers' },
    { key: 'superadmin', label: 'Tournament admins', note: '' },
    { key: 'parent', label: 'Crew chat parents', note: 'parent sign-in' },
    { key: 'raffle', label: 'Raffle', note: '' },
    { key: 'concessions', label: 'Concessions', note: '' }
];
const VIEW_LABELS = {
    gate: 'Picking a division', standings: 'Standings', schedule: 'Schedule', playoffs: 'Playoffs',
    'admin-entry': 'Admin', settings: 'Setup', chat: 'Chat', roster: 'Roster', raffle: 'Raffle',
    concessions: 'Concessions', 'game-manager': 'Game management', 'raffle-backup': 'Raffle backup'
};

let last = null;
let fetching = false;
let failed = false;
const open = new Set(); // detail panels kept open across re-renders
const openDivisions = new Set();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function isOnScreen() {
    return App.state.isSuperAdmin && App.state.currentView === 'settings' && document.visibilityState !== 'hidden';
}

export async function refreshUsage() {
    if (fetching || !isOnScreen()) return;
    const token = sessionStorage.getItem('adminAuthToken');
    if (!token) return;
    fetching = true;
    try {
        last = await getUsage(token);
        failed = !last || typeof last.total !== 'number';
    } catch (e) {
        failed = true;
    } finally {
        fetching = false;
    }
    render();
}

export function initUsage() {
    setInterval(refreshUsage, POLL_MS);
    document.addEventListener('visibilitychange', refreshUsage);
}

const HEALTH = [
    { label: 'Healthy', icon: '●', cls: 'bg-green-600/20 text-green-300 border-green-500/40' },
    { label: 'Busy', icon: '▲', cls: 'bg-yellow-600/20 text-yellow-200 border-yellow-500/40' },
    { label: 'Strained', icon: '■', cls: 'bg-red-600/25 text-red-200 border-red-500/50' }
];

/** Healthy / Busy / Strained from the last full minute (plus live lag). */
function health(server) {
    const m = server.lastMinute || {};
    const lag = Math.max(m.lagP99 || 0, server.lagP99Now || 0);
    const reasons = [];
    let level = 0;
    if (lag >= 250) { level = 2; reasons.push(`responses delayed ${lag} ms`); }
    else if (lag >= 80) { level = Math.max(level, 1); reasons.push(`responses delayed ${lag} ms`); }
    if ((m.cpuPct || 0) >= 85) { level = 2; reasons.push(`CPU ${m.cpuPct}%`); }
    else if ((m.cpuPct || 0) >= 60) { level = Math.max(level, 1); reasons.push(`CPU ${m.cpuPct}%`); }
    if ((m.errors || 0) > 0) { level = Math.max(level, 1); reasons.push(plural(m.errors, 'server error')); }
    return { ...HEALTH[level], reasons };
}

/** Single-series sparkline with a per-point hover title. */
function sparkline(points, key, fmt, height = 44) {
    if (!points || points.length < 2) return '<p class="text-[11px] text-white/40">The trend fills in after a couple of minutes.</p>';
    const W = 300, H = height, pad = 3;
    const max = Math.max(1, ...points.map(p => p[key] || 0));
    const x = (i) => pad + (i * (W - pad * 2)) / (points.length - 1);
    const y = (v) => H - pad - ((v || 0) / max) * (H - pad * 2);
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');
    const step = (W - pad * 2) / (points.length - 1);
    const hits = points.map((p, i) => `<rect x="${(x(i) - step / 2).toFixed(1)}" y="0" width="${Math.max(step, 1).toFixed(1)}" height="${H}" fill="transparent"><title>${esc(clock(p.t))} · ${esc(fmt(p[key] || 0))}</title></rect>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="w-full block" style="height:${H}px" role="img" aria-label="Trend">
        <line x1="0" x2="${W}" y1="${H - pad}" y2="${H - pad}" stroke="rgb(255 255 255 / .12)" stroke-width="1" vector-effect="non-scaling-stroke"/>
        <path d="${d}" fill="none" stroke="#E7B84B" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>${hits}</svg>`;
}

function panelLink(id, label) {
    const isOpen = open.has(id);
    return `<button type="button" class="setup-link ${isOpen ? 'open' : ''}" data-usage-panel="${id}"><span class="chev">▸</span> ${label}</button>`;
}

function stat(value, label, sub = '') {
    return `<div class="rounded-xl border border-white/10 bg-white/[.04] px-3 py-2.5">
        <div class="text-2xl font-extrabold text-white leading-none tabular-nums">${value}</div>
        <div class="mt-1 text-[11px] font-semibold uppercase tracking-wider text-white/55">${label}</div>
        ${sub ? `<div class="text-[11px] text-white/40">${sub}</div>` : ''}</div>`;
}

function rolesHtml(u) {
    return `<div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5">${ROLE_ROWS.map(r => {
        const v = u.byRole[r.key] || { connections: 0, visible: 0, devices: 0 };
        if (!v.connections && r.key !== 'public' && r.key !== 'admin' && r.key !== 'superadmin') return '';
        const dim = v.connections ? '' : 'opacity-50';
        return `<div class="flex items-center justify-between gap-3 rounded-lg bg-white/[.03] px-3 py-2 ${dim}">
            <div class="min-w-0"><div class="text-sm font-semibold text-white">${r.label}</div>
                <div class="text-[11px] text-white/45">${v.connections ? `${v.visible} on screen · ${plural(v.devices, 'device')}` : (r.note || 'none connected')}</div></div>
            <div class="text-xl font-extrabold tabular-nums text-white">${v.connections}</div></div>`;
    }).join('')}</div>`;
}

function divisionsHtml(u) {
    if (!u.divisions.length) return '<p class="text-sm text-white/45">Nobody is viewing a division right now.</p>';
    const top = Math.max(1, ...u.divisions.map(d => d.viewers));
    return `<div class="grid gap-1.5">${u.divisions.map(d => {
        const isOpen = openDivisions.has(d.name);
        const pct = Math.round((d.followers / Math.max(1, d.viewers)) * 100);
        const teams = d.teams.length
            ? `<div class="mt-2 grid gap-1">${d.teams.map(t => `<div class="flex items-center gap-2 text-[13px]">
                    <span class="w-6 text-right tabular-nums text-white/80 font-semibold">${t.count}</span>
                    <span class="h-1.5 rounded-full bg-[#E7B84B]" style="width:${Math.max(4, Math.round((t.count / d.teams[0].count) * 90))}px"></span>
                    <span class="text-white/80 truncate">${esc(t.team)}</span></div>`).join('')}</div>`
            : '<p class="mt-2 text-[12px] text-white/40">Nobody here follows a team yet.</p>';
        return `<div class="rounded-lg bg-white/[.03] px-3 py-2">
            <button type="button" class="w-full text-left" data-usage-division="${esc(d.name)}">
                <div class="flex items-center justify-between gap-3">
                    <span class="text-sm font-semibold text-white truncate"><span class="text-white/40">${isOpen ? '▾' : '▸'}</span> ${esc(d.name)}</span>
                    <span class="text-sm tabular-nums text-white font-bold">${d.viewers}</span></div>
                <div class="mt-1 h-1 rounded-full bg-white/10"><div class="h-1 rounded-full bg-white/50" style="width:${Math.round((d.viewers / top) * 100)}%"></div></div>
                <div class="mt-1 text-[11px] text-white/45">${d.visible} on screen · ${d.followers} following a team (${pct}%)</div>
            </button>${isOpen ? teams : ''}</div>`;
    }).join('')}</div>`;
}

function detailsHtml(u) {
    const courts = u.courts.length
        ? u.courts.map(c => `<span class="rounded-full border border-white/15 px-2.5 py-1 text-[12px] text-white/80">Court ${esc(c.court)} · ${c.count}</span>`).join('')
        : '<span class="text-[12px] text-white/40">No referees connected.</span>';
    const views = Object.entries(u.views).sort((a, b) => b[1] - a[1])
        .map(([v, n]) => `<span class="rounded-full border border-white/15 px-2.5 py-1 text-[12px] text-white/80">${esc(VIEW_LABELS[v] || v)} · ${n}</span>`).join('')
        || '<span class="text-[12px] text-white/40">—</span>';
    return `<div class="space-y-3">
        <div><div class="text-[11px] font-semibold uppercase tracking-wider text-white/55 mb-1.5">Referees by court</div><div class="flex flex-wrap gap-1.5">${courts}</div></div>
        <div><div class="text-[11px] font-semibold uppercase tracking-wider text-white/55 mb-1.5">What people have open</div><div class="flex flex-wrap gap-1.5">${views}</div></div>
        <button type="button" class="setup-link text-sm" data-usage-jump="signed-in-users-card">Names, devices &amp; sign-in history → Signed-in users</button>
    </div>`;
}

function serverHtml(u, h) {
    const s = u.server, m = s.lastMinute || {};
    const up = s.uptimeSec >= 3600 ? `${Math.floor(s.uptimeSec / 3600)}h ${Math.floor((s.uptimeSec % 3600) / 60)}m` : `${Math.floor(s.uptimeSec / 60)}m`;
    const row = (k, v, hint) => `<div class="flex items-baseline justify-between gap-3 py-1 border-b border-white/5"><span class="text-[13px] text-white/70">${k}${hint ? ` <span class="text-[11px] text-white/35">${hint}</span>` : ''}</span><span class="text-[13px] font-semibold tabular-nums text-white">${v}</span></div>`;
    return `<div class="space-y-3">
        ${h.reasons.length ? `<p class="text-[12px] text-yellow-200/90">${h.icon} ${esc(h.reasons.join(' · '))}</p>` : ''}
        <div>
            ${row('Response delay (p99)', `${Math.max(m.lagP99 || 0, s.lagP99Now || 0)} ms`, 'under 50 is good')}
            ${row('Server CPU', `${m.cpuPct || 0}%`, `${s.cpus} cores · load ${s.load1}`)}
            ${row('Memory', `${s.rssMb} MB`, `heap ${s.heapUsedMb}/${s.heapTotalMb} MB`)}
            ${row('API requests', `${m.requests || 0}/min`, `${s.requestsThisMinute} so far this minute`)}
            ${row('Server errors', `${m.errors || 0}/min`, '')}
            ${row('Up for', up, '')}
        </div>
        <div><div class="text-[11px] font-semibold uppercase tracking-wider text-white/55 mb-1">Response delay, last ${Math.max(1, u.history.length)} min</div>${sparkline(u.history, 'lagP99', v => `${v} ms`, 36)}</div>
        <div><div class="text-[11px] font-semibold uppercase tracking-wider text-white/55 mb-1">API requests per minute</div>${sparkline(u.history, 'requests', v => `${v}/min`, 36)}</div>
        <p class="text-[11px] text-white/40">Counts are kept in server memory only and reset when the server restarts. Each open tab or phone is one connection; a phone with the screen off drops off within a minute.</p>
    </div>`;
}

function render() {
    const body = document.getElementById('usage-body');
    const pill = document.getElementById('usage-health');
    if (!body) return;
    if (failed && !last) { body.innerHTML = '<p class="text-sm text-white/50">Couldn’t load live usage. Retrying…</p>'; return; }
    if (!last) return;
    const u = last;
    const h = health(u.server);
    if (pill) {
        pill.className = `flex-none rounded-full border px-2.5 py-1 text-[11px] font-bold ${h.cls}`;
        pill.textContent = `${h.icon} Server ${h.label.toLowerCase()}`;
        pill.title = h.reasons.join(' · ') || 'Response times, CPU and errors look normal';
    }
    const following = u.divisions.reduce((n, d) => n + d.followers, 0);
    body.innerHTML = `
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
            ${stat(u.total, 'Connected', `${u.visible} on screen`)}
            ${stat(u.devices, 'Devices', 'phones / computers')}
            ${stat(following, 'Following a team', '')}
            ${stat(u.peak.total, 'Peak today', u.peak.at ? `at ${clock(u.peak.at)}` : '')}
        </div>
        ${rolesHtml(u)}
        <div><div class="text-[11px] font-semibold uppercase tracking-wider text-white/55 mb-1">Connected, last ${Math.max(1, u.history.length)} min</div>${sparkline(u.history, 'total', v => plural(v, 'connection'))}</div>
        <div class="flex flex-wrap gap-x-5 gap-y-1 text-sm">
            ${panelLink('divisions', 'Divisions &amp; followed teams')}
            ${panelLink('details', 'Courts &amp; screens')}
            ${panelLink('server', 'Server health')}
        </div>
        ${open.has('divisions') ? `<div class="pt-3 border-t border-gray-800">${divisionsHtml(u)}</div>` : ''}
        ${open.has('details') ? `<div class="pt-3 border-t border-gray-800">${detailsHtml(u)}</div>` : ''}
        ${open.has('server') ? `<div class="pt-3 border-t border-gray-800">${serverHtml(u, h)}</div>` : ''}
        <p class="text-[11px] text-white/35">Updated ${clock(u.at)}${failed ? ' · last refresh failed, retrying' : ''} · refreshes every 10s while this page is open</p>`;
}

// One delegated listener survives the 10s re-renders.
document.addEventListener('click', (e) => {
    const p = e.target.closest?.('[data-usage-panel]');
    if (p) { const id = p.dataset.usagePanel; open.has(id) ? open.delete(id) : open.add(id); render(); return; }
    const d = e.target.closest?.('[data-usage-division]');
    if (d) { const n = d.dataset.usageDivision; openDivisions.has(n) ? openDivisions.delete(n) : openDivisions.add(n); render(); return; }
    const sj = e.target.closest?.('[data-setup-jump]');
    if (sj) { e.preventDefault(); document.querySelector(sj.getAttribute('href'))?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    const j = e.target.closest?.('[data-usage-jump]');
    if (j) document.getElementById(j.dataset.usageJump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
