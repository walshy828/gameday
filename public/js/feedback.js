// public/js/feedback.js
// Feedback from parents/coaches (no login) to the tournament manager.
//
// Everyone: a "💬 Feedback" card on the Info tab with three one-tap choices
//   (Compliment / Complaint / Suggestion). Each opens a sheet with the choice,
//   a note and an optional name; the division being viewed and the followed
//   team go along automatically. POST /api/feedback.
// Superadmin: Setup → Event day → "💬 Feedback" inbox (#feedback-inbox): kind
//   filters, newest first, tap a row to read the whole note, then Resolve /
//   Mark unread / Delete. A NEW COMPLAINT pops a banner at the top of every
//   view (with Review → opens it in Setup) and puts a red count on the Admin
//   ⚙ gear; compliments and suggestions only show up in the inbox count.
//   Live via the staff-only `feedbackUpdate` socket nudge + a POLL_MS poll.
//
// Server: server/feedback.js (stored in the Store; complaint → ntfy push).
import { submitFeedback, getFeedback, feedbackAction } from './api.js';
import { getSocket } from './socketClient.js';
import { toast } from './concessionsUi.js';
import { getFollowed } from './follow.js';

const POLL_MS = 60000;
const MAX_LEN = 1000;
const ALERTED_KEY = 'feedbackAlerted';     // complaint ids already bannered (this browser)
const FILTER_KEY = 'feedbackFilter';

export const KINDS = [
    { key: 'complaint', icon: '😟', label: 'Complaint', plural: 'Complaints', prompt: 'What happened? Court, time or team helps us sort it quickly.' },
    { key: 'suggestion', icon: '💡', label: 'Suggestion', plural: 'Suggestions', prompt: 'What would make the day better?' },
    { key: 'compliment', icon: '👏', label: 'Compliment', plural: 'Compliments', prompt: 'What went well? We pass it on.' }
];
const kindOf = (k) => KINDS.find(x => x.key === k) || KINDS[1];

let items = [];
let watching = false;
let wired = false;
let pollTimer = null;
let openId = null;            // inbox row expanded
let filter = readFilter();    // 'all' | kind
let showResolved = false;
let banner = null;            // complaint currently bannered

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

function myName() {
    return App.state.reporterName || 'MC';
}

function readFilter() {
    try { return localStorage.getItem(FILTER_KEY) || 'all'; } catch (e) { return 'all'; }
}

function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m ago`;
    return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function clock(ts) {
    return ts ? new Date(ts).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
}

function alerted() {
    try { return new Set(JSON.parse(localStorage.getItem(ALERTED_KEY) || '[]')); } catch (e) { return new Set(); }
}

function markAlerted(id) {
    const s = alerted();
    s.add(id);
    try { localStorage.setItem(ALERTED_KEY, JSON.stringify([...s].slice(-200))); } catch (e) { /* per-session */ }
}

// --- public: the form ------------------------------------------------------------

function closeForm() {
    document.getElementById('feedback-sheet')?.remove();
}

/** Opens the feedback sheet, optionally with a kind already picked. */
export function openFeedback(kind) {
    closeForm();
    if (!feedbackEnabled()) return toast('Feedback is turned off right now.', true);
    let picked = KINDS.some(k => k.key === kind) ? kind : '';
    const division = App.config?.currentSheetName || '';
    const team = division ? getFollowed(division) || '' : '';
    const wrap = document.createElement('div');
    wrap.id = 'feedback-sheet';
    wrap.className = 'modal-backdrop';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'feedback-title');
    const context = [division, team].filter(Boolean).map(esc).join(' · ');
    wrap.innerHTML = `
        <div class="modal-sheet">
            <div class="modal-head">
                <div class="kicker !tracking-[.16em] text-gold">Feedback</div>
                <div id="feedback-title" class="mt-2 text-[17px] font-bold leading-[1.3] tracking-[-.02em] text-[#F7F7F8]">Tell the organizers</div>
                <div class="mt-1 text-[12px] text-white/60">Goes straight to the tournament manager. Anonymous unless you add your name.</div>
            </div>
            <form class="modal-body" novalidate>
                <div class="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Type of feedback">
                    ${KINDS.map(k => `<button type="button" role="radio" data-kind="${k.key}" class="tile-light !px-2 !py-3 flex flex-col items-center gap-1 !text-center !text-[12.5px]"><span class="text-[22px] leading-none" aria-hidden="true">${k.icon}</span>${k.label}</button>`).join('')}
                </div>
                <div>
                    <textarea data-msg rows="4" maxlength="${MAX_LEN}" class="field-light resize-none" aria-label="Your note" placeholder="Pick a type above, then tell us more."></textarea>
                    <div class="mt-1 flex justify-between gap-2 text-[11px] text-[#8a8a8e]"><span data-hint></span><span data-count>0 / ${MAX_LEN}</span></div>
                </div>
                <input data-name type="text" maxlength="80" autocomplete="name" class="field-light" placeholder="Your name or team (optional)" aria-label="Your name or team (optional)">
                <input data-hp type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0">
                ${context ? `<p class="-mt-1 text-[11px] text-[#8a8a8e]">Sent with: ${context}</p>` : ''}
                <p data-err class="hidden text-[12px] font-semibold" style="color:var(--mar)"></p>
                <div class="grid grid-cols-[1fr_1.7fr] gap-2">
                    <button type="button" data-cancel class="rounded-[18px] border bg-[#F3F3F4] p-4 text-[13px] font-semibold leading-none text-ink" style="border-color:var(--line)">Cancel</button>
                    <button type="submit" data-send class="btn-primary !rounded-[18px] p-4 text-[13px] leading-none disabled:opacity-40" disabled>Send feedback</button>
                </div>
            </form>
        </div>`;
    const $ = (sel) => wrap.querySelector(sel);
    const msg = $('[data-msg]');
    const send = $('[data-send]');
    const err = $('[data-err]');
    const sync = () => {
        wrap.querySelectorAll('[data-kind]').forEach(b => {
            const on = b.dataset.kind === picked;
            b.dataset.selected = on ? 'true' : 'false';
            b.setAttribute('aria-checked', on ? 'true' : 'false');
        });
        const k = picked ? kindOf(picked) : null;
        msg.placeholder = k ? k.prompt : 'Pick a type above, then tell us more.';
        $('[data-hint]').textContent = picked === 'complaint' ? 'The tournament manager is alerted right away.' : '';
        $('[data-count]').textContent = `${msg.value.length} / ${MAX_LEN}`;
        send.disabled = !picked || msg.value.trim().length < 3;
    };
    wrap.addEventListener('click', (ev) => {
        if (ev.target === wrap || ev.target.closest('[data-cancel]')) return closeForm();
        const tile = ev.target.closest('[data-kind]');
        if (tile) { picked = tile.dataset.kind; err.classList.add('hidden'); sync(); msg.focus(); }
    });
    msg.addEventListener('input', sync);
    $('form').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (send.disabled) return;
        send.disabled = true;
        send.textContent = 'Sending…';
        err.classList.add('hidden');
        try {
            await submitFeedback({ kind: picked, message: msg.value, name: $('[data-name]').value, division, team, website: $('[data-hp]').value });
            showThanks(wrap, picked);
        } catch (e) {
            const offline = e.name === 'AbortError' || !e.status;
            err.textContent = offline ? 'No connection — not sent yet. Try again in a moment.' : (e.body?.error || 'Could not send. Please try again.');
            err.classList.remove('hidden');
            send.textContent = 'Send feedback';
            sync();
        }
    });
    document.addEventListener('keydown', function onKey(e) {
        if (e.key !== 'Escape') return;
        closeForm();
        document.removeEventListener('keydown', onKey);
    });
    document.body.appendChild(wrap);
    sync();
    if (picked) msg.focus();
}

function showThanks(wrap, kind) {
    const body = wrap.querySelector('.modal-body');
    const line = kind === 'complaint'
        ? 'Sorry about that. The tournament manager has been alerted and will look into it.'
        : kind === 'compliment' ? 'That made our day. We\'ll pass it on.' : 'Thanks for the idea — the organizers will read it.';
    body.innerHTML = `
        <div class="py-2 text-center">
            <div class="text-[34px] leading-none" aria-hidden="true">✓</div>
            <div class="mt-2 text-[16px] font-bold text-ink">Feedback sent</div>
            <p class="mt-1 text-[13px] text-[#5a5a5e]">${esc(line)}</p>
        </div>
        <button type="button" data-cancel class="btn-primary !rounded-[18px] p-4 text-[13px] leading-none">Done</button>`;
    body.querySelector('[data-cancel]').focus();
}

// --- superadmin: sync ----------------------------------------------------------------

async function refresh() {
    const t = token();
    if (!isMc() || !t) return;
    try {
        const res = await getFeedback(t);
        if (!res?.success) return;
        items = Array.isArray(res.items) ? res.items : [];
        noticeComplaints();
        render();
    } catch (e) {
        console.warn('Feedback refresh failed:', e.message);
    }
}

/** Starts (once) live updates for the superadmin. Safe to call often. */
export function ensureFeedbackWatch() {
    if (!isMc()) return;
    if (watching) { render(); return; }
    watching = true;
    refresh();
    if (!wired) {
        wired = true;
        try {
            const socket = getSocket();
            socket.on('feedbackUpdate', () => { if (watching) refresh(); });
            socket.on('connect', () => { if (watching) refresh(); });
        } catch (e) {
            console.warn('Feedback live updates unavailable, polling only:', e.message);
        }
        document.addEventListener('visibilitychange', () => { if (watching && !document.hidden) refresh(); });
    }
    pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
}

/** On sign-out: stop and clear. */
export function stopFeedback() {
    watching = false;
    clearInterval(pollTimer); pollTimer = null;
    items = []; openId = null; banner = null;
    render();
}

// --- superadmin: complaint alert ---------------------------------------------------------

function chime() {
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        [[0, 740], [0.18, 554]].forEach(([t, f]) => {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.frequency.value = f;
            g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
            g.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + t + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.2);
            o.connect(g).connect(ctx.destination);
            o.start(ctx.currentTime + t);
            o.stop(ctx.currentTime + t + 0.22);
        });
        setTimeout(() => ctx.close(), 800);
    } catch (e) { /* best-effort */ }
}

function noticeComplaints() {
    const seen = alerted();
    // Only unread complaints from the last 12h get a banner (older ones just sit in the inbox).
    const fresh = items.filter(i => i.kind === 'complaint' && i.status === 'new' && !seen.has(i.id) && Date.now() - i.createdAt < 12 * 3600 * 1000);
    if (banner && !items.some(i => i.id === banner.id && i.status === 'new')) banner = null;
    if (!fresh.length) return;
    banner = fresh[0]; // newest
    fresh.forEach(i => markAlerted(i.id));
    chime();
    try { navigator.vibrate && navigator.vibrate([120, 80, 120]); } catch (e) { /* unsupported */ }
    try {
        if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
            new Notification('😟 New complaint', { body: banner.message.slice(0, 120), tag: 'feedback-complaint' });
        }
    } catch (e) { /* best-effort */ }
}

function bannerEl() {
    let el = document.getElementById('feedback-alert');
    if (!el) {
        el = document.createElement('div');
        el.id = 'feedback-alert';
        el.setAttribute('role', 'alert');
        el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:calc(env(safe-area-inset-top,0px) + 10px);z-index:116;width:min(30rem,calc(100vw - 16px));display:none';
        el.addEventListener('click', (ev) => {
            const b = ev.target.closest('button');
            if (!b) return;
            const id = banner?.id;
            banner = null;
            renderBanner();
            if ('fbReview' in b.dataset && id) reviewItem(id);
        });
        document.body.appendChild(el);
    }
    return el;
}

function renderBanner() {
    const el = bannerEl();
    if (!isMc() || !banner) {
        el.style.display = 'none';
        el.innerHTML = '';
        return;
    }
    const others = items.filter(i => i.kind === 'complaint' && i.status === 'new').length - 1;
    const where = [banner.division, banner.team].filter(Boolean).join(' · ');
    el.style.display = 'block';
    el.innerHTML = `
        <div class="rounded-[18px] border p-3 shadow-xl" style="background:rgba(92,20,14,.97);border-color:rgba(255,120,100,.9)">
            <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                    <div class="text-[13px] font-extrabold text-white">😟 New complaint${others > 0 ? ` <span class="font-semibold text-white/70">+${others} more</span>` : ''}</div>
                    <div class="mt-0.5 text-[10.5px] text-white/60">${esc(where || 'No division')} · ${ago(banner.createdAt)}${banner.name ? ` · ${esc(banner.name)}` : ''}</div>
                    <div class="mt-1 text-[12px] leading-snug text-white/90 line-clamp-2">${esc(banner.message)}</div>
                </div>
                <div class="flex flex-none flex-col gap-1.5">
                    <button type="button" data-fb-review class="rounded-full px-3 py-2 text-[11px] font-extrabold" style="background:linear-gradient(135deg,var(--gold) 0%,var(--gold-d) 100%);color:#2A1B08">Review</button>
                    <button type="button" data-fb-later class="rounded-full border border-white/25 bg-white/[.08] px-3 py-2 text-[11px] font-bold text-white">Later</button>
                </div>
            </div>
        </div>`;
}

/** Opens Setup on the inbox with this item expanded (marks it read). */
export function reviewItem(id) {
    filter = 'all';
    showResolved = true;
    openId = id;
    if (App.state.currentView !== 'settings') window.switchView?.('settings');
    render();
    markRead(id);
    requestAnimationFrame(() => {
        document.querySelector(`[data-fb-row="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            || document.getElementById('setup-feedback')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
}

// --- superadmin: actions --------------------------------------------------------------

async function act(id, action, body, okMsg) {
    try {
        await feedbackAction(token(), id, action, { by: myName(), ...body });
        if (okMsg) toast(okMsg);
    } catch (e) {
        const offline = e.name === 'AbortError' || !e.status;
        toast(offline ? 'No connection — not saved.' : `Couldn't update: ${e.body?.error || e.message}`, true);
    }
    refresh();
}

function setLocalStatus(id, status) {
    const it = items.find(i => i.id === id);
    if (it) { it.status = status; it.handledBy = myName(); it.handledAt = Date.now(); }
}

function markRead(id) {
    const it = items.find(i => i.id === id);
    if (!it || it.status !== 'new') return;
    setLocalStatus(id, 'read');
    render();
    act(id, 'status', { status: 'read' });
}

// --- superadmin: render -------------------------------------------------------------------

function counts() {
    const open = items.filter(i => i.status !== 'resolved');
    return {
        unread: items.filter(i => i.status === 'new').length,
        unreadComplaints: items.filter(i => i.status === 'new' && i.kind === 'complaint').length,
        open: open.length,
        byKind: Object.fromEntries(KINDS.map(k => [k.key, open.filter(i => i.kind === k.key).length]))
    };
}

function renderGearBadge() {
    const gear = document.getElementById('admin-setup-gear');
    if (!gear) return;
    let b = document.getElementById('feedback-gear-badge');
    const n = isMc() ? counts().unreadComplaints : 0;
    if (!n) { b?.remove(); return; }
    if (!b) {
        b = document.createElement('span');
        b.id = 'feedback-gear-badge';
        b.style.cssText = 'position:absolute;top:-4px;right:-4px;min-width:17px;height:17px;padding:0 4px;border-radius:999px;background:var(--warn);color:#fff;font-size:10px;font-weight:800;line-height:17px;text-align:center;box-shadow:0 0 0 2px rgba(0,0,0,.5)';
        gear.style.position = 'relative';
        gear.appendChild(b);
    }
    b.textContent = String(n);
    b.title = `${n} new complaint${n === 1 ? '' : 's'}`;
}

function rowHtml(i) {
    const k = kindOf(i.kind);
    const isOpen = openId === i.id;
    const isNew = i.status === 'new';
    const resolved = i.status === 'resolved';
    const accent = i.kind === 'complaint' && !resolved ? 'rgba(255,120,100,.75)' : 'rgba(255,255,255,.12)';
    const where = [i.division, i.team].filter(Boolean).map(esc).join(' · ');
    const meta = [where, i.name ? esc(i.name) : '', ago(i.createdAt)].filter(Boolean).join(' · ');
    return `
        <div data-fb-row="${esc(i.id)}" class="rounded-2xl border ${resolved ? 'opacity-60' : ''}" style="border-color:${accent};background:rgba(255,255,255,.04)">
            <button type="button" data-fb-toggle="${esc(i.id)}" aria-expanded="${isOpen}" class="flex w-full items-start gap-2.5 p-3 text-left">
                <span class="flex-none text-[20px] leading-none" aria-hidden="true">${k.icon}</span>
                <span class="min-w-0 flex-1">
                    <span class="flex items-center gap-1.5 text-[13px] font-bold text-white">${k.label}
                        ${isNew ? '<span class="rounded-full px-1.5 py-[1px] text-[9px] font-extrabold tracking-wider text-white" style="background:var(--warn)">NEW</span>' : ''}
                        ${resolved ? '<span class="rounded-full border border-white/20 px-1.5 py-[1px] text-[9px] font-bold tracking-wider text-white/70">RESOLVED</span>' : ''}
                    </span>
                    <span class="mt-0.5 block text-[11px] text-white/50">${meta}</span>
                    ${isOpen ? '' : `<span class="mt-1 block text-[12.5px] leading-snug text-white/80 line-clamp-2">${esc(i.message)}</span>`}
                </span>
                <span class="flex-none text-white/40 text-[12px]" aria-hidden="true">${isOpen ? '▾' : '▸'}</span>
            </button>
            ${isOpen ? `
            <div class="px-3 pb-3">
                <p class="whitespace-pre-wrap break-words rounded-xl bg-black/25 p-3 text-[13.5px] leading-relaxed text-white/90">${esc(i.message)}</p>
                <p class="mt-1.5 text-[10.5px] text-white/40">Sent ${esc(clock(i.createdAt))}${i.handledBy && i.status !== 'new' ? ` · ${resolved ? 'resolved' : 'read'} by ${esc(i.handledBy)}` : ''}</p>
                <div class="mt-2 flex flex-wrap gap-1.5">
                    ${resolved
                        ? `<button type="button" data-fb-status="read" data-id="${esc(i.id)}" class="rounded-full border border-white/20 bg-white/[.06] px-3 py-1.5 text-[11.5px] font-semibold text-white">Reopen</button>`
                        : `<button type="button" data-fb-status="resolved" data-id="${esc(i.id)}" class="pill-gold px-3 py-1.5 text-[11.5px] font-bold">✓ Mark resolved</button>`}
                    ${isNew || resolved ? '' : `<button type="button" data-fb-status="new" data-id="${esc(i.id)}" class="rounded-full border border-white/20 bg-white/[.06] px-3 py-1.5 text-[11.5px] font-semibold text-white">Mark unread</button>`}
                    <button type="button" data-fb-delete="${esc(i.id)}" class="ml-auto rounded-full border px-3 py-1.5 text-[11.5px] font-semibold" style="border-color:rgba(255,120,100,.4);color:#FFB4A6">Delete</button>
                </div>
            </div>` : ''}
        </div>`;
}

function renderInbox() {
    const box = document.getElementById('feedback-inbox');
    const pill = document.getElementById('feedback-count-pill');
    if (!box) return;
    if (!isMc()) { box.innerHTML = ''; return; }
    const c = counts();
    if (pill) {
        pill.textContent = c.unread ? `${c.unread} new` : `${c.open} open`;
        pill.style.background = c.unreadComplaints ? 'var(--warn)' : '';
        pill.style.color = c.unreadComplaints ? '#fff' : '';
    }
    const chips = [{ key: 'all', label: 'All', n: c.open }, ...KINDS.map(k => ({ key: k.key, label: `${k.icon} ${k.plural}`, n: c.byKind[k.key] }))];
    const list = items
        .filter(i => filter === 'all' || i.kind === filter)
        .filter(i => showResolved || i.status !== 'resolved' || i.id === openId);
    const resolvedCount = items.filter(i => i.status === 'resolved' && (filter === 'all' || i.kind === filter)).length;
    box.innerHTML = `
        <div class="flex gap-1.5 overflow-x-auto pb-0.5" role="tablist" aria-label="Filter feedback">
            ${chips.map(ch => `<button type="button" role="tab" aria-selected="${filter === ch.key}" data-fb-filter="${ch.key}" class="flex-none rounded-full border px-3 py-1.5 text-[11.5px] font-semibold ${filter === ch.key ? 'text-[#2A1B08]' : 'text-white/75'}" style="${filter === ch.key ? 'background:var(--gold);border-color:var(--gold)' : 'border-color:rgba(255,255,255,.18);background:rgba(255,255,255,.05)'}">${ch.label}${ch.n ? ` · ${ch.n}` : ''}</button>`).join('')}
        </div>
        <div class="grid gap-1.5">
            ${list.length ? list.map(rowHtml).join('') : `<p class="py-3 text-center text-sm text-white/45">${items.length ? 'Nothing open here.' : 'No feedback yet. Parents and coaches can send it from the Info tab.'}</p>`}
        </div>
        ${resolvedCount ? `<button type="button" data-fb-resolved class="text-[11.5px] font-medium text-white/55 underline decoration-white/25 underline-offset-2">${showResolved ? 'Hide' : 'Show'} ${resolvedCount} resolved</button>` : ''}`;
    if (!box.dataset.wired) {
        box.dataset.wired = '1';
        box.addEventListener('click', onInboxClick);
    }
}

function onInboxClick(ev) {
    const b = ev.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.fbFilter) {
        filter = d.fbFilter;
        try { localStorage.setItem(FILTER_KEY, filter); } catch (e) { /* per-session */ }
        return render();
    }
    if ('fbResolved' in d) { showResolved = !showResolved; return render(); }
    if (d.fbToggle) {
        openId = openId === d.fbToggle ? null : d.fbToggle;
        render();
        if (openId) markRead(openId);
        return;
    }
    if (d.fbStatus) {
        setLocalStatus(d.id, d.fbStatus);
        if (d.fbStatus === 'resolved' && !showResolved) openId = null;
        render();
        return act(d.id, 'status', { status: d.fbStatus }, d.fbStatus === 'resolved' ? '✓ Marked resolved' : null);
    }
    if (d.fbDelete) {
        if (!confirm('Delete this feedback for good? This can\'t be undone.')) return;
        items = items.filter(i => i.id !== d.fbDelete);
        if (openId === d.fbDelete) openId = null;
        render();
        return act(d.fbDelete, 'delete', {}, 'Feedback deleted');
    }
}

export function render() {
    renderInbox();
    renderBanner();
    renderGearBadge();
}

// --- on/off switch (Setup → Feedback, shared feature setting `feedbackEnabled`) --------

export function feedbackEnabled() {
    return App.settings?.feedbackEnabled !== false;
}

/** Shows/hides the Info tab's feedback card (and closes an open form) to match the setting. */
export function applyFeedbackSetting() {
    const on = feedbackEnabled();
    document.getElementById('info-feedback')?.classList.toggle('hidden', !on);
    document.getElementById('feedback-off-note')?.classList.toggle('hidden', on);
    if (!on && document.querySelector('#feedback-sheet [data-msg]')) closeForm();
}

/** Every tab follows the switch live via the featureSettingsUpdate socket event. */
export function initFeedbackSetting() {
    applyFeedbackSetting();
    try {
        getSocket().on('featureSettingsUpdate', (s) => {
            if (!s) return;
            App.settings = App.settings || {};
            App.settings.feedbackEnabled = s.feedbackEnabled !== false;
            applyFeedbackSetting();
        });
    } catch (e) { /* no live updates: the next data load applies it */ }
}
