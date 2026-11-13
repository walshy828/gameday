// public/js/courtIssues.js
// Court issue flags — a referee "raises their hand" for their court (dispute,
// injury, or other), and the MC (superadmin) is alerted on every screen until
// it's handled.
//
// Referee (admin, not superadmin): #court-issue-panel at the top of Admin —
//   a "✋ Flag an issue on Court N" button → bottom sheet where one tap on a
//   reason raises it → a red card "Flag up · waiting for the MC" /
//   "✓ <whoever acknowledged> is on the way" with
//   "Take flag down".
// MC (superadmin): a red stack pinned above the tab bar on every view, with
//   "On my way" (acknowledge) and "Resolved" (clear). Beeps/vibrates on a new
//   flag and again every REMIND_MS while one is still unacknowledged.
//
// Server: server/courtIssues.js (in-memory, one flag per physical court).
// Live via the data-less `courtIssueUpdate` socket nudge + a POLL_MS poll.
import { getCourtIssues, courtIssueAction } from './api.js';
import { getSocket } from './socketClient.js';
import { toast } from './concessionsUi.js';

const POLL_MS = 20000;
const REMIND_MS = 45000;

export const REASONS = [
    { key: 'dispute', icon: '🗣️', label: 'Dispute' },
    { key: 'injury', icon: '🩹', label: 'Injury' },
    { key: 'other', icon: '✋', label: 'Other' }
];
const reasonOf = (k) => REASONS.find(r => r.key === k) || REASONS[REASONS.length - 1];

let issues = [];          // open flags [{ id, court, division, reason, by, at, ackBy, ackAt }]
let recent = [];          // recently cleared, newest first
let watching = false;
let wired = false;
let pollTimer = null;
let tickTimer = null;
let remindTimer = null;
let busy = false;
let collapsed = false;    // MC stack minimised (re-opens on a new flag)
let seen = new Set();     // MC: flag ids already alerted
let mine = null;          // referee: last known flag on their court (to notice ack / clear)

// --- basics ------------------------------------------------------------------

function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function token() {
    return sessionStorage.getItem('adminAuthToken');
}

function isMc() {
    return !!App.state.isSuperAdmin;
}

function isRef() {
    return !!App.state.isAdmin && !App.state.isSuperAdmin;
}

function myCourt() {
    return String(App.state.selectedCourt || '').trim();
}

function myName() {
    return App.state.reporterName || localStorage.getItem('lastAdminName') || '';
}

function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

function buzz(pattern) {
    try { navigator.vibrate && navigator.vibrate(pattern); } catch (e) { /* unsupported */ }
}

/** Three rising tones — distinct from the court board's two-beep alerts. */
function alarm() {
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        [[0, 660], [0.17, 880], [0.34, 1100]].forEach(([t, f]) => {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.frequency.value = f;
            g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
            g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + t + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.15);
            o.connect(g).connect(ctx.destination);
            o.start(ctx.currentTime + t);
            o.stop(ctx.currentTime + t + 0.16);
        });
        setTimeout(() => ctx.close(), 900);
    } catch (e) { /* audio is best-effort */ }
}

function notify(title, body) {
    try {
        if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification(title, { body, tag: 'court-issue' });
    } catch (e) { /* best-effort */ }
}

// --- queries used by other modules --------------------------------------------

/** Open flag on a court, if any (the court board marks its tile). */
export function courtIssueFor(court) {
    const c = String(court ?? '').trim();
    return c ? issues.find(i => i.court === c) || null : null;
}

/** True when this referee's own court has a flag up (its card takes the sticky spot). */
export function refFlagUp() {
    return isRef() && !!courtIssueFor(myCourt());
}

// --- server sync ---------------------------------------------------------------

function apply(data) {
    if (!data) return;
    issues = Array.isArray(data.issues) ? data.issues : [];
    recent = Array.isArray(data.recent) ? data.recent : [];
    noticeChanges();
    render();
    window.dispatchEvent(new Event('courtissues'));
}

async function refresh() {
    const t = token();
    if (!App.state.isAdmin || !t) return;
    try {
        const res = await getCourtIssues(t);
        if (res?.success) apply(res);
    } catch (e) {
        console.warn('Court issues refresh failed:', e.message);
    }
}

/** Starts (once) live updates for referees and the MC. Safe to call often. */
export function ensureCourtIssueWatch() {
    if (!App.state.isAdmin) return;
    if (watching) { render(); return; }
    watching = true;
    refresh();
    if (!wired) {
        // Listeners outlive sign-out (they check `watching`), so attach them once.
        wired = true;
        try {
            const socket = getSocket();
            socket.on('courtIssueUpdate', () => { if (watching) refresh(); });
            socket.on('connect', () => { if (watching) refresh(); });
        } catch (e) {
            console.warn('Court issue live updates unavailable, polling only:', e.message);
        }
        document.addEventListener('visibilitychange', () => { if (watching && !document.hidden) refresh(); });
        window.addEventListener('resize', positionStack);
    }
    pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
    // Keeps "2m ago" honest without a fetch.
    tickTimer = setInterval(() => { if (issues.length && !document.hidden) render(); }, 30000);
}

/** On sign-out: stop and clear everything. */
export function stopCourtIssues() {
    watching = false;
    clearInterval(pollTimer); pollTimer = null;
    clearInterval(tickTimer); tickTimer = null;
    clearInterval(remindTimer); remindTimer = null;
    issues = []; recent = []; seen = new Set(); mine = null; collapsed = false;
    closeSheet();
    render();
}

// --- alerts / referee feedback -----------------------------------------------------

function noticeChanges() {
    if (isMc()) {
        const fresh = issues.filter(i => !seen.has(i.id));
        fresh.forEach(i => seen.add(i.id));
        if (fresh.length) {
            collapsed = false;
            alarm();
            buzz([200, 100, 200, 100, 200]);
            const i = fresh[0];
            notify(`✋ Court ${i.court} needs you`, `${reasonOf(i.reason).label} · ${i.by}`);
        }
        // Keep nudging while a flag is still unacknowledged.
        const unacked = issues.some(i => !i.ackAt);
        if (unacked && !remindTimer) {
            remindTimer = setInterval(() => {
                if (!issues.some(i => !i.ackAt)) { clearInterval(remindTimer); remindTimer = null; return; }
                if (!document.hidden) { alarm(); buzz([150, 80, 150]); }
            }, REMIND_MS);
        } else if (!unacked && remindTimer) {
            clearInterval(remindTimer); remindTimer = null;
        }
        return;
    }
    if (!isRef()) return;
    const cur = courtIssueFor(myCourt());
    if (mine && cur && cur.id === mine.id && cur.ackAt && !mine.ackAt) {
        buzz([80, 60, 80]);
        toast(`✓ ${cur.ackBy || 'The MC'} is on the way to Court ${cur.court}`);
    } else if (mine && !cur) {
        const done = recent.find(r => r.id === mine.id);
        if (done?.clearedByMc) {
            buzz(60);
            toast(`✓ ${done.clearedBy || 'The MC'} took the flag down on Court ${done.court}`);
        }
    }
    mine = cur ? { id: cur.id, ackAt: cur.ackAt } : null;
}

// --- actions ---------------------------------------------------------------------------

async function act(action, body, okMsg) {
    if (busy) return null;
    busy = true;
    render();
    try {
        const res = await courtIssueAction(token(), action, { by: myName() || (isMc() ? 'MC' : 'Referee'), ...body });
        if (okMsg) toast(okMsg);
        apply(res);
        return res;
    } catch (e) {
        const offline = e.name === 'AbortError' || !e.status;
        toast(offline ? 'No connection — not sent. Tap again.' : `Couldn't update the flag: ${e.body?.error || e.message}`, true);
        refresh(); // it may still have landed
        return null;
    } finally {
        busy = false;
        render();
    }
}

async function raise(reason) {
    const court = myCourt();
    if (!court) return toast('Pick your court first', true);
    const res = await act('raise', { court, division: App.config?.currentSheetName || '', reason }, null);
    if (res) {
        buzz(60);
        toast(res.already ? `Court ${court} flag updated` : `✋ Flag raised on Court ${court} · the MC has been alerted`);
    }
}

function lowerMine() {
    const cur = courtIssueFor(myCourt());
    if (!cur) return;
    if (!confirm(`Take the flag down on Court ${cur.court}? Only if it's sorted.`)) return;
    act('clear', { court: cur.court, id: cur.id }, `Flag down on Court ${cur.court}`);
}

// --- referee: raise sheet -----------------------------------------------------------------

function closeSheet() {
    document.getElementById('court-issue-sheet')?.remove();
}

export function openIssueSheet() {
    if (!isRef()) return;
    const court = myCourt();
    if (!court) return toast('Pick your court first', true);
    closeSheet();
    const wrap = document.createElement('div');
    wrap.id = 'court-issue-sheet';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', `Flag an issue on Court ${court}`);
    wrap.style.cssText = 'position:fixed;inset:0;z-index:130;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.55)';
    // One tap on a reason raises the flag — no extra confirm step.
    const tiles = REASONS.map(r => `<button type="button" data-reason="${r.key}" class="flex flex-col items-center justify-center gap-1.5 rounded-[16px] px-2 py-4 text-[14px] font-extrabold leading-none text-white" `
        + `style="background:rgba(217,80,60,.22);border:1.5px solid rgba(255,150,130,.6)">`
        + `<span class="text-[24px] leading-none">${r.icon}</span><span>${esc(r.label)}</span></button>`).join('');
    wrap.innerHTML = `
        <div class="w-full max-w-md rounded-t-[26px] border border-white/10 p-4" style="background:#241318;padding-bottom:calc(1rem + env(safe-area-inset-bottom,0px))">
            <div class="text-[10px] tracking-[.16em] font-semibold uppercase" style="color:#FFB4A6">✋ Flag Court ${esc(court)}</div>
            <div class="mt-1 text-[16px] font-extrabold text-white">What's going on?</div>
            <div class="mt-0.5 text-[12px] text-white/55">Tap one — the MC is alerted right away.</div>
            <div class="mt-3 grid grid-cols-3 gap-2">${tiles}</div>
            <button type="button" data-cancel class="mt-3 w-full rounded-full border border-white/15 bg-white/[.06] py-3 text-[13px] font-semibold text-white/70">Cancel</button>
        </div>`;
    wrap.addEventListener('click', (ev) => {
        if (ev.target === wrap || ev.target.closest('[data-cancel]')) return closeSheet();
        const tile = ev.target.closest('[data-reason]');
        if (tile) {
            closeSheet();
            raise(tile.dataset.reason);
        }
    });
    document.addEventListener('keydown', function onKey(e) {
        if (e.key === 'Escape') { closeSheet(); document.removeEventListener('keydown', onKey); }
    });
    document.body.appendChild(wrap);
}

// --- render: referee panel ----------------------------------------------------------------

function renderRefPanel() {
    const panel = document.getElementById('court-issue-panel');
    if (!panel) return;
    const court = myCourt();
    if (!isRef() || !court) {
        panel.innerHTML = '';
        panel.classList.add('hidden');
        panel.style.position = '';
        return;
    }
    const cur = courtIssueFor(court);
    panel.classList.remove('hidden');
    if (!cur) {
        panel.style.position = '';
        panel.innerHTML = `
            <button type="button" data-ci-open ${busy ? 'disabled' : ''} class="flex w-full items-center justify-center gap-2 rounded-full border px-4 py-2.5 text-[12px] font-bold disabled:opacity-60"
                style="border-color:rgba(217,80,60,.55);background:rgba(217,80,60,.08);color:#FFB4A6">
                <span aria-hidden="true">✋</span> Flag an issue on Court ${esc(court)}
            </button>`;
        return;
    }
    const r = reasonOf(cur.reason);
    const status = cur.ackAt
        ? `<div class="mt-1.5 text-[13px] font-extrabold" style="color:#B9F0D0">✓ ${esc(cur.ackBy || 'The MC')} is on the way</div>`
        : `<div class="mt-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-white/80"><span class="inline-block h-2 w-2 animate-pulse rounded-full" style="background:var(--warn)"></span>Waiting for the MC…</div>`;
    // Stays in reach (under the sticky header) while the referee scrolls.
    const header = document.querySelector('header.app-header');
    panel.style.position = 'sticky';
    panel.style.top = `${(header?.offsetHeight || 0) + 8}px`;
    panel.style.zIndex = '41';
    panel.innerHTML = `
        <section class="rounded-[22px] border p-3.5 shadow-lg" style="background:rgba(70,18,14,.96);border-color:rgba(217,80,60,.8)">
            <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                    <div class="text-[10px] tracking-[.16em] font-semibold uppercase" style="color:#FFB4A6">✋ Flag up · Court ${esc(cur.court)}</div>
                    <div class="mt-0.5 text-[14px] font-extrabold text-white">${r.icon} ${esc(r.label)}</div>
                    <div class="mt-0.5 text-[10px] text-white/45">Raised by ${esc(cur.by)} · ${ago(cur.at)}${cur.ackAt ? ` · seen ${ago(cur.ackAt)}` : ''}</div>
                    ${status}
                </div>
                <button type="button" data-ci-lower ${busy ? 'disabled' : ''} class="flex-none rounded-full border border-white/25 bg-white/[.08] px-3 py-2 text-[11px] font-bold text-white disabled:opacity-60">Take flag down</button>
            </div>
        </section>`;
}

// --- render: MC alert stack (every view) ---------------------------------------------------

function stackEl() {
    let el = document.getElementById('court-issue-alerts');
    if (!el) {
        el = document.createElement('div');
        el.id = 'court-issue-alerts';
        el.setAttribute('role', 'alert');
        el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);z-index:115;width:min(30rem,calc(100vw - 16px));display:none';
        el.addEventListener('click', onStackClick);
        document.body.appendChild(el);
    }
    return el;
}

function positionStack() {
    const el = document.getElementById('court-issue-alerts');
    if (!el) return;
    const bar = document.getElementById('bottom-tab-bar');
    // The bar is position:fixed (no offsetParent), so check its box, not offsetParent.
    const rect = bar && getComputedStyle(bar).display !== 'none' ? bar.getBoundingClientRect() : null;
    const bottom = rect && rect.height && rect.top < window.innerHeight ? Math.max(8, window.innerHeight - rect.top + 8) : 12;
    el.style.bottom = `${bottom}px`;
}

function issueRow(i) {
    const r = reasonOf(i.reason);
    const acked = !!i.ackAt;
    return `
        <div class="rounded-[18px] border p-3 shadow-xl" style="background:${acked ? 'rgba(58,36,10,.97)' : 'rgba(92,20,14,.97)'};border-color:${acked ? 'rgba(224,184,99,.7)' : 'rgba(255,120,100,.9)'}">
            <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                    <div class="text-[14px] font-extrabold text-white">✋ Court ${esc(i.court)} <span class="font-semibold text-white/75">· ${r.icon} ${esc(r.label)}</span></div>
                    <div class="mt-0.5 text-[10px] text-white/55">${esc(i.by)}${i.division ? ` · ${esc(i.division)}` : ''} · ${ago(i.at)}</div>
                    ${acked ? `<div class="mt-0.5 text-[11px] font-bold" style="color:var(--gold-l)">→ ${esc(i.ackBy || 'MC')} on the way · ${ago(i.ackAt)}</div>` : ''}
                </div>
                <div class="flex flex-none flex-col gap-1.5">
                    ${acked ? '' : `<button type="button" data-ci-ack="${esc(i.court)}" ${busy ? 'disabled' : ''} class="rounded-full px-3 py-2 text-[11px] font-extrabold disabled:opacity-60" style="background:linear-gradient(135deg,var(--gold) 0%,var(--gold-d) 100%);color:#2A1B08">On my way</button>`}
                    <button type="button" data-ci-clear="${esc(i.court)}" data-id="${esc(i.id)}" ${busy ? 'disabled' : ''} class="rounded-full border border-white/25 bg-white/[.08] px-3 py-2 text-[11px] font-bold text-white disabled:opacity-60">Resolved ✓</button>
                </div>
            </div>
        </div>`;
}

function renderMcStack() {
    const el = stackEl();
    if (!isMc() || !issues.length) {
        el.style.display = 'none';
        el.innerHTML = '';
        return;
    }
    el.style.display = 'block';
    positionStack();
    const unacked = issues.filter(i => !i.ackAt).length;
    if (collapsed) {
        el.innerHTML = `
            <div class="flex justify-end">
                <button type="button" data-ci-expand class="rounded-full px-4 py-2.5 text-[12px] font-extrabold text-white shadow-xl ${unacked ? 'animate-pulse' : ''}" style="background:${unacked ? 'var(--warn)' : 'rgba(58,36,10,.97)'};border:1px solid rgba(255,255,255,.2)">
                    ✋ ${issues.length} court flag${issues.length === 1 ? '' : 's'} · ${issues.map(i => 'C' + esc(i.court)).join(', ')}
                </button>
            </div>`;
        return;
    }
    el.innerHTML = `
        <div class="mb-1.5 flex items-center justify-between px-1">
            <span class="rounded-full px-2.5 py-1 text-[10px] font-extrabold tracking-[.12em] uppercase text-white" style="background:rgba(0,0,0,.55)">✋ Courts need you · ${issues.length}</span>
            <button type="button" data-ci-collapse class="rounded-full px-2.5 py-1 text-[11px] font-semibold text-white/80" style="background:rgba(0,0,0,.55)">Minimise</button>
        </div>
        <div class="grid max-h-[45vh] gap-1.5 overflow-y-auto">${issues.map(issueRow).join('')}</div>`;
}

function onStackClick(ev) {
    const el = ev.target.closest('button');
    if (!el) return;
    if ('ciCollapse' in el.dataset) { collapsed = true; return render(); }
    if ('ciExpand' in el.dataset) { collapsed = false; return render(); }
    if (el.dataset.ciAck) return act('ack', { court: el.dataset.ciAck }, `Court ${el.dataset.ciAck} told you're on the way`);
    if (el.dataset.ciClear) return act('clear', { court: el.dataset.ciClear, id: el.dataset.id }, `✓ Court ${el.dataset.ciClear} flag cleared`);
}

// --- render ------------------------------------------------------------------------------

export function render() {
    renderRefPanel();
    renderMcStack();
    const panel = document.getElementById('court-issue-panel');
    if (panel && !panel.dataset.wired) {
        panel.dataset.wired = '1';
        panel.addEventListener('click', (ev) => {
            const el = ev.target.closest('button');
            if (!el) return;
            if ('ciOpen' in el.dataset) openIssueSheet();
            else if ('ciLower' in el.dataset) lowerMine();
        });
    }
}
