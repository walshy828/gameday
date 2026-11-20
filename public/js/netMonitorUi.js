// public/js/netMonitorUi.js
// The signed-in badge's dot in the app header doubles as this device's
// connection light for referees and tournament admins: green steady, amber a
// problem in the last 5 min, red disconnected / offline right now. Tapping the
// badge opens "This device's connection" (log kept by netMonitor.js on this
// device only). Purely local: rendering this sends nothing.
import { onNetStatus, netSummary, describe, clearNetLog, isNetMonitorRunning } from './netMonitor.js';

const COLORS = ['#22c55e', '#eab308', '#ef4444'];
const LABELS = ['Steady', 'Shaky', 'Down'];
const WINDOW_MS = 2 * 60 * 60 * 1000;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const dur = (ms) => { const s = Math.round((ms || 0) / 1000); return s < 90 ? `${s}s` : `${Math.round(s / 60)} min`; };
const secs1 = (ms) => `${((ms || 0) / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;

let timer = null;

function updateDot(s) {
    const dot = document.getElementById('header-net-dot');
    const badge = document.getElementById('header-staff-badge');
    if (!dot || !badge) return;
    dot.style.backgroundColor = COLORS[s.level] || COLORS[0];
    dot.classList.toggle('animate-pulse', s.level === 2);
    badge.title = `Connection: ${s.text} (tap for details)`;
    if (document.getElementById('net-sheet')) renderSheet();
}

function timeline(events) {
    const t = Date.now(), from = t - WINDOW_MS, W = 300, H = 22;
    const x = (v) => ((Math.max(from, v) - from) / WINDOW_MS) * W;
    const bars = events.filter(e => (e.at + (e.ms || 0)) >= from).map(e => {
        const red = e.type === 'drop' || e.type === 'offline' || e.type === 'firebase' || e.type === 'fail';
        const fill = e.bg ? 'rgb(255 255 255 / .25)' : red ? '#ef4444' : '#eab308';
        const x0 = x(e.at), w = Math.max(2, x(e.at + (e.ms || 0)) - x0);
        return `<rect x="${x0.toFixed(1)}" y="2" width="${w.toFixed(1)}" height="${H - 4}" rx="1" fill="${fill}"><title>${esc(clock(e.at))} · ${esc(describe(e))}</title></rect>`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="w-full block" style="height:${H}px" role="img" aria-label="Connection problems over the last 2 hours">
        <rect x="0" y="2" width="${W}" height="${H - 4}" rx="3" fill="rgb(34 197 94 / .18)"/>${bars}</svg>
        <div class="flex justify-between text-[10px] text-white/35 mt-0.5"><span>2h ago</span><span>1h</span><span>now</span></div>`;
}

function renderSheet() {
    const box = document.querySelector('#net-sheet [data-body]');
    if (!box) return;
    if (!isNetMonitorRunning()) { box.innerHTML = '<p class="text-sm text-white/60">Starts when you sign in as a referee or tournament admin.</p>'; return; }
    const s = netSummary();
    const stat = (v, k) => `<div class="rounded-lg bg-white/[.05] px-2 py-2 text-center"><div class="text-lg font-extrabold tabular-nums text-white leading-none">${v}</div><div class="mt-1 text-[10px] uppercase tracking-wider text-white/50">${k}</div></div>`;
    const row = (k, v) => `<div class="flex justify-between gap-3 py-1 border-b border-white/5 text-[13px]"><span class="text-white/65">${k}</span><span class="font-semibold tabular-nums text-white">${v}</span></div>`;
    const net = s.network ? `${esc(s.network.type || '?')}${s.network.rtt ? ` · ~${s.network.rtt} ms` : ''}${s.network.downlink ? ` · ${s.network.downlink} Mb/s` : ''}` : 'not reported by this browser';
    const list = s.events.slice(0, 25).map(e => `<li class="flex gap-2 text-[12px] ${e.bg ? 'text-white/35' : 'text-white/80'}">
            <span class="tabular-nums text-white/45 flex-none">${esc(clock(e.at))}</span><span>${esc(describe(e))}${e.bg ? ' · app in background (not counted)' : ''}</span></li>`).join('')
        || '<li class="text-[12px] text-white/45">Nothing logged. No drops, stalls or failed requests.</li>';
    box.innerHTML = `
        <div class="flex items-center gap-2"><span class="w-2.5 h-2.5 rounded-full" style="background:${COLORS[s.status.level]}"></span>
            <span class="text-[15px] font-bold text-white">${LABELS[s.status.level]}</span><span class="text-[13px] text-white/60 truncate">${esc(s.status.text)}</span></div>
        <div class="mt-3">${timeline(s.events)}</div>
        <div class="mt-3 text-[10px] font-semibold uppercase tracking-wider text-white/50">Last hour</div>
        <div class="mt-1 grid grid-cols-4 gap-1.5">${stat(s.lastHour.drops, 'drops')}${stat(dur(s.lastHour.downMs), 'offline')}${stat(s.lastHour.stalls + s.lastHour.slow, 'slow')}${stat(s.lastHour.fails, 'failed')}</div>
        <div class="mt-3">
            ${row('Typical response (15 min)', s.sampleCount ? `${secs1(s.typicalMs)} · slowest 10% ${secs1(s.p90Ms)}` : '—')}
            ${row('Score saves (last 20)', s.saves.count ? `${secs1(s.saves.typicalMs)} typical · worst ${secs1(s.saves.worstMs)}` : 'none yet')}
            ${row('Last 12h', `${s.today.drops} ${s.today.drops === 1 ? 'drop' : 'drops'} · ${dur(s.today.downMs)} offline · ${s.today.fails} failed`)}
            ${row('Network', net)}
        </div>
        <div class="mt-3 text-[10px] font-semibold uppercase tracking-wider text-white/50">Log</div>
        <ul class="mt-1 space-y-1 max-h-[28vh] overflow-y-auto">${list}</ul>
        <p class="mt-3 text-[11px] text-white/40">Measured on this device from traffic the app already sends; nothing extra goes over the network.
            Under 1s is good. Several seconds or drops while the screen is on usually means the Wi-Fi, not the app.
            Kept on this device for 12 hours.</p>`;
}

export function openNetSheet() {
    closeNetSheet();
    const wrap = document.createElement('div');
    wrap.id = 'net-sheet';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', 'This device’s connection');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:130;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.55)';
    wrap.innerHTML = `
        <div class="w-full max-w-md rounded-t-[26px] border border-white/10 p-4" style="background:#241318;padding-bottom:calc(1rem + env(safe-area-inset-bottom,0px))">
            <div class="text-[10px] tracking-[.16em] font-semibold text-white/50 uppercase">This device’s connection</div>
            <div data-body class="mt-2"></div>
            <div class="mt-3 flex gap-2">
                <button type="button" data-clear class="flex-none rounded-full border border-white/15 bg-white/[.04] px-4 py-3 text-[13px] font-semibold text-white/60">Clear log</button>
                <button type="button" data-cancel class="flex-1 rounded-full border border-white/15 bg-white/[.06] py-3 text-[13px] font-semibold text-white/80">Close</button>
            </div>
        </div>`;
    wrap.addEventListener('click', (ev) => {
        if (ev.target === wrap || ev.target.closest('[data-cancel]')) return closeNetSheet();
        if (ev.target.closest('[data-clear]') && confirm('Clear this device’s connection log?')) { clearNetLog(); renderSheet(); }
    });
    document.body.appendChild(wrap);
    renderSheet();
    timer = setInterval(renderSheet, 5000);
}

export function closeNetSheet() {
    document.getElementById('net-sheet')?.remove();
    if (timer) { clearInterval(timer); timer = null; }
}

export function initNetUi() {
    onNetStatus(updateDot);
    document.getElementById('header-staff-badge')?.addEventListener('click', () => {
        if (App.state.isAdmin || App.state.isSuperAdmin) openNetSheet();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNetSheet(); });
}
