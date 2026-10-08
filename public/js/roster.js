// public/js/roster.js
// Roster view (superadmin): the app's version of the Registrations sheet's "Team Management" tool.
// Teams list first; tap a team for its roster, waiver status, and the remove / add / rename /
// move / Paid / Sub Division actions. All data and every write goes through /api/roster* which
// reads and edits the Registrations sheet itself, so the sheet and this view never disagree.
import { getRoster, previewRosterAction, applyRosterAction, setRosterCheckin, addRosterCheckinNote, getRosterCheckinLog } from './api.js';
import { getSocket } from './socketClient.js';

const S = {
    data: null,          // { teams, rosters, people, year, subOptions, loadedAt }
    loadedAt: 0,
    loading: false,
    error: '',
    cur: null,           // selected team key
    q: '',
    editing: null,       // member name being renamed (input open)
    ask: null,           // inline confirm: {kind:'del'|'moveSel'|'move'|'edit'|'add', name, ...}
    draft: '',           // add-player input text
    editSub: false, subAsk: null,
    confirmPaid: false, paidBusy: false,
    openWaiver: null,    // member name whose waiver detail is expanded
    busyRows: {},        // 'teamKey|name' -> label while a write is in flight
    ciOn: false,         // team check-in switched on (shared app setting, off by default)
    ciDiv: '', ciOut: false,          // counter's division picker / "only teams not checked in"
    ciAsk: null, ciReason: '', ciBusy: null,   // inline check-in confirm (team key), its note box, team being saved
    ciLog: {}, ciLoading: {}, ciNote: '', ciNoteBusy: false,   // per-team notes & history
    adding: [],          // [{team, name}] optimistic "Adding…" rows
    hl: null
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const token = () => { try { return sessionStorage.getItem('adminAuthToken'); } catch (e) { return null; } };
const body = () => document.getElementById('roster-body');

/* ---------- small formatters ---------- */

function fmtDate(s) {
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s || ''), y, mo, d;
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else { m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s || ''); if (!m) return s || ''; mo = +m[1]; d = +m[2]; y = +m[3]; }
    const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return mo >= 1 && mo <= 12 ? `${names[mo - 1]} ${d}, ${y}` : s;
}
function fmtWhen(ts) {
    const m = String(ts || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
    if (!m) return String(ts || 'date not recorded');
    const d = new Date(+m[3], +m[1] - 1, +m[2], +(m[4] || 0), +(m[5] || 0));
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) + (m[4] ? ' at ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
}
function stamp() {
    if (!S.loadedAt) return '';
    const mins = Math.max(0, Math.floor((Date.now() - S.loadedAt) / 60000));
    return `Last refreshed ${new Date(S.loadedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${mins < 1 ? 'just now' : mins < 60 ? mins + ' min ago' : Math.floor(mins / 60) + ' h ago'}`;
}
function toast(msg, bad) {
    const t = document.createElement('div');
    t.className = 'fixed left-1/2 -translate-x-1/2 bottom-24 z-[120] rounded-full px-4 py-2.5 text-[12px] font-semibold text-white shadow-lg';
    t.style.background = bad ? 'var(--mar)' : '#2b2b2e';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
}

/* ---------- shared UI snippets ---------- */

const pillBtn = 'flex-none rounded-full border border-white/20 bg-white/[.06] px-3.5 py-2.5 text-[11px] font-semibold leading-none text-white/75';
const smBtn = 'rounded-[13px] border border-white/15 bg-white/[.07] px-3 py-2 text-[11px] font-semibold text-white/80';
const goldBtn = 'rounded-[13px] px-3 py-2 text-[11px] font-semibold';
const goldStyle = 'background:linear-gradient(135deg,var(--gold) 0%,var(--gold-d) 100%);color:#2A1B08';
const dangerStyle = 'background:var(--mar);color:#fff';
const kicker = (t) => `<div class="text-[10px] tracking-[.16em] font-semibold text-white/50 uppercase">${esc(t)}</div>`;

function head(title, right) {
    return `<div class="screen-head"><h2 class="screen-title">${esc(title)}</h2>${right || ''}</div>`;
}

/* ---------- loading ---------- */

async function load(quiet, refresh) {
    if (S.loading) return;
    S.loading = true; S.error = '';
    if (!quiet) render();
    try {
        const r = await getRoster(token(), !!refresh);
        adopt(r);
    } catch (e) {
        S.error = e.message || String(e);
    } finally {
        S.loading = false;
        render();
    }
}
function adopt(d) {
    S.data = d; S.loadedAt = Date.now() - (Number(d.ageMs) || 0);      // the server may serve a cached copy: show how old the DATA is
    if (typeof d.ciOn === 'boolean') S.ciOn = d.ciOn;
    if (S.cur && !d.rosters[S.cur]) S.cur = null;
}

export function renderRoster() {
    wire();
    wireSocket();
    if (!S.data && !S.loading) { load(); return; }
    render();
}

/* ---------- list ---------- */

function renderList() {
    const q = S.q.trim().toLowerCase();
    let html = '', last = '', any = false;
    const cs = ciStats();
    S.data.teams.forEach(t => {
        if (S.ciOn && S.ciDiv && t.division !== S.ciDiv) return;   // counter's division picker
        if (S.ciOn && S.ciOut && t.ci) return;                       // "only teams not checked in"
        const byCap = !!q && !t.team.toLowerCase().includes(q) && (t.captain || '').toLowerCase().includes(q);
        if (q && !t.team.toLowerCase().includes(q) && !byCap) return;
        any = true;
        if (t.division !== last) {
            const gd = S.ciOn ? cs.by[t.division] : null;
            html += `<div class="mt-3 mb-1 flex items-baseline justify-between px-1">${kicker(t.division)}${gd ? `<span class="text-[11px] text-white/45" title="Teams checked in">${gd.ci}/${gd.n} in</span>` : ''}</div>`;
            last = t.division;
        }
        const min = S.data.rosters[t.key]?.min ?? 8;
        const low = t.count < min;
        const sub = [t.captain, t.sub].filter(Boolean).map(esc).join(' · ');
        html += `<button data-act="open" data-k="${esc(t.key)}" class="flex w-full items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[.05] px-3.5 py-3 text-left" style="${t.girls ? 'border-left:3px solid #db2777;' : ''}${S.ciOn && t.ci ? 'background:rgba(46,158,99,.14);border-color:rgba(46,158,99,.4)' : ''}">
            <span class="min-w-0"><span class="block truncate text-[14px] font-semibold text-white">${esc(t.team)}${S.ciOn && t.ci ? `<span role="img" aria-label="Checked in" title="Checked in${t.ciTime ? ' ' + esc(t.ciTime) : ''}" class="ml-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full border-2 text-[9px] font-extrabold align-middle" style="border-color:var(--ok);color:var(--ok)">✓</span>` : ''}</span>
            <span class="block truncate text-[12px] ${t.girls ? '' : 'text-white/55'}" style="${t.girls ? 'color:#f9a8d4' : ''}">${sub || '&nbsp;'}</span></span>
            <span class="flex flex-none items-center gap-2">
              ${t.paid ? '<span title="Paid" aria-label="Paid" class="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full text-[11px] font-bold text-white" style="background:var(--ok)">$</span>' : ''}
              <span title="${t.signed} of ${t.count} waivers completed" class="rounded-full px-2.5 py-1 text-[11px] font-semibold tabular-nums" style="${low ? 'background:rgba(224,184,99,.18);color:var(--gold-l)' : 'background:rgba(255,255,255,.1);color:rgba(255,255,255,.7)'}">${t.signed}/${t.count}</span>
            </span></button>`;
    });
    if (q) {
        const hits = S.data.people.filter(p => p.name.toLowerCase().includes(q)).slice(0, 25);
        if (hits.length) html += `<div class="mt-3 mb-1 px-1">${kicker('People')}</div>`;
        hits.forEach(p => {
            any = true;
            html += `<button data-act="open" data-k="${esc(p.key)}" data-n="${esc(p.name)}" class="w-full rounded-2xl border border-white/10 bg-white/[.05] px-3.5 py-2.5 text-left text-[14px] text-white">${esc(p.name)}<span class="block text-[12px] text-white/50">${esc(p.key)}</span></button>`;
        });
    }
    return `${head('Roster', `<button data-act="refresh" class="${pillBtn}" ${S.loading ? 'disabled' : ''}>↻ Refresh</button>`)}
      ${ciBox(cs)}
      <div class="mt-3.5"><input id="roster-q" type="search" value="${esc(S.q)}" placeholder="Find a team, captain or person…" autocomplete="off" aria-label="Find a team, captain or person" class="field-dark"></div>
      <div class="mt-1.5 px-1 text-[11px] text-white/40">${esc(stamp())}${S.loading ? ' · Refreshing…' : ''}</div>
      <div class="mt-1 grid gap-2">${any ? html : `<div class="py-10 text-center text-sm text-white/50">${S.q ? `Nothing matches “${esc(S.q)}”.` : (S.ciOn && S.ciOut ? 'Every team here is checked in. ✓' : 'No teams to show.')}</div>`}</div>`;
}

/* ---------- team detail ---------- */

function statChip(inner, extra) {
    return `<div class="flex items-center justify-between gap-2 rounded-2xl border border-white/10 bg-white/[.05] px-3.5 py-3 ${extra || ''}">${inner}</div>`;
}

function paidChip(r) {
    if (!r.hasPaidCol) return statChip(`<div><div class="text-[16px] font-bold text-white">—</div><div class="text-[11px] text-white/50">no “Paid” column</div></div>`);
    const color = r.paid ? 'var(--ok)' : 'var(--mar-l, #D9503C)';
    let act;
    if (S.paidBusy) act = '<span class="text-[11px] text-white/50">Saving…</span>';
    else if (S.confirmPaid) act = `<span class="flex items-center gap-1.5"><button data-act="paid-ok" class="${goldBtn}" style="${r.paid ? dangerStyle : goldStyle}">${r.paid ? 'Confirm not paid' : 'Confirm paid'}</button><button data-act="paid-no" class="${smBtn}" aria-label="Cancel">✕</button></span>`;
    else act = `<button data-act="paid" class="${smBtn}" title="${r.paid ? 'Mark as not paid' : 'Mark as paid'}" aria-label="${r.paid ? 'Mark as not paid' : 'Mark as paid'}">${r.paid ? '↺' : '$'}</button>`;
    return statChip(`<div><div class="text-[16px] font-bold" style="color:${color}">${r.paid ? 'Yes' : 'No'}</div><div class="text-[11px] text-white/50">Paid</div></div>${act}`);
}

function subChip(r) {
    if (S.editSub && r.hasSubCol) {
        const opts = r.subOptions || [], ask = S.subAsk != null;
        const known = (v) => opts.some(o => o.name.toLowerCase() === v.toLowerCase());
        const hint = ask
            ? (S.subAsk ? `Set <b>${esc(r.team)}</b> to sub division <b>${esc(S.subAsk)}</b>${r.sub ? ` (now ${esc(r.sub)})` : ''}?${known(S.subAsk) ? '' : ` “${esc(S.subAsk)}” is new — no other team uses it yet.`}` : `Clear the sub division for <b>${esc(r.team)}</b>${r.sub ? ` (now ${esc(r.sub)})` : ''}?`)
            : '';
        return `<div class="col-span-2 rounded-2xl border border-white/10 bg-white/[.05] px-3.5 py-3">
          <label for="roster-sub" class="text-[11px] text-white/50">Sub division</label>
          <div class="mt-1.5 flex flex-wrap items-center gap-2">
            <input id="roster-sub" list="roster-sub-list" value="${esc(ask ? S.subAsk : r.sub)}" ${ask ? 'readonly' : ''} maxlength="40" autocomplete="off" placeholder="Type or pick, e.g. Chaos" class="field-dark min-w-0 flex-1">
            ${ask ? `<button data-act="sub-yes" class="${goldBtn}" style="${goldStyle}">Confirm update</button><button data-act="sub-back" class="${smBtn}">Back</button>`
                  : `<button data-act="sub-ok" class="${goldBtn}" style="${goldStyle}">Update</button><button data-act="sub-cancel" class="${smBtn}">Cancel</button>`}
          </div>
          <datalist id="roster-sub-list">${opts.map(o => `<option value="${esc(o.name)}">`).join('')}</datalist>
          <div class="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-white/50">${opts.length ? 'In use:' : 'No sub divisions in use yet.'}${opts.map(o => `<button type="button" data-act="sub-chip" data-v="${esc(o.name)}" class="rounded-full border border-white/15 bg-white/[.06] px-2.5 py-1 text-white/80">${esc(o.name)} (${o.count})</button>`).join('')}</div>
          <div class="mt-1.5 min-h-[16px] text-[12px]" style="color:var(--gold-l)" aria-live="polite">${hint}</div></div>`;
    }
    return statChip(`<div><div class="text-[16px] font-bold text-white">${r.sub ? esc(r.sub) : '<span class="font-normal italic text-white/40">none</span>'}</div><div class="text-[11px] text-white/50">Sub division${r.hasSubCol ? '' : ' (no “Sub Division” column)'}</div></div>${r.hasSubCol ? `<button data-act="sub-edit" class="${smBtn}" title="Change sub division" aria-label="Change sub division">✎</button>` : ''}`);
}

function notesFor(kind, r, m, k) {
    const n = r.members.length, notes = [];
    if (kind === 'del') {
        if (m.signed) notes.push('Their waiver is kept and marked unmatched.');
        if (n - 1 < r.min) notes.push(`⚠ The team drops to ${n - 1} players (minimum ${r.min}).`);
    } else if (kind === 'move') {
        const to = S.data.teams.find(x => x.key === k.to);
        if (m.signed) notes.push('Their waiver moves with them.');
        if (to && to.division !== r.division) notes.push(`⚠ Different division: ${r.division} → ${to.division}.`);
        if (to && to.count + 1 > r.max) notes.push(`⚠ ${to.team} will have ${to.count + 1} players — the form allows ${r.max}.`);
        if (n - 1 < r.min) notes.push(`⚠ ${r.team} drops to ${n - 1} players (minimum ${r.min}).`);
    } else if (kind === 'edit') {
        if (k.nn.indexOf(' ') < 0) notes.push('⚠ Only one name entered — the form asks for first and last name.');
    }
    return notes.length ? `<div class="mt-1 text-[12px] text-white/55">${notes.map(esc).join('<br>')}</div>` : '';
}

function addNotes(r, k) {
    const notes = [], low = k.name.toLowerCase();
    if (k.name.indexOf(' ') < 0) notes.push('⚠ Only one name entered — the form asks for first and last name.');
    const other = S.data.people.filter(p => p.name.toLowerCase() === low && p.key !== r.key).map(p => p.key);
    if (other.length) notes.push(`⚠ Also on ${other.slice(0, 3).join(', ')}. Add only if this is a different child.`);
    if (r.members.length + 1 > r.max) notes.push(`⚠ That will be player ${r.members.length + 1} — the form allows ${r.max}.`);
    if (k.link) notes.push('The waiver you picked will be linked.');
    else if (r.unlinkedWaivers.some(w => w.typed.toLowerCase() === low)) notes.push('An unmatched waiver with this name will be linked.');
    return notes.length ? `<div class="mt-1 text-[12px] text-white/55">${notes.map(esc).join('<br>')}</div>` : '';
}

function memberRow(r, m, i) {
    const bk = `${r.key}|${m.name}`;
    const rowCls = 'rounded-2xl px-3 py-2.5';
    const rowBg = 'background:rgba(255,255,255,.05)';
    if (S.busyRows[bk]) {
        return `<div class="${rowCls} flex items-center justify-between gap-2" style="${rowBg}"><div class="min-w-0"><div class="text-[14px] text-white">${esc(m.name)}</div><div class="text-[12px] text-white/50">${esc(S.busyRows[bk])}</div></div></div>`;
    }
    const ask = S.ask && S.ask.name === m.name && S.ask.kind !== 'add' ? S.ask : null;
    if (ask) {
        const wrap = (inner, ok, okLabel, okStyle, noLabel) => `<div class="${rowCls}" style="background:rgba(224,184,99,.10);border:1px solid rgba(224,184,99,.35)">${inner}<div class="mt-2 flex gap-2"><button data-act="ask-ok" class="${goldBtn}" style="${okStyle}">${okLabel}</button><button data-act="ask-no" class="${smBtn}">${noLabel}</button></div></div>`;
        if (ask.kind === 'del') return wrap(`<div class="text-[14px] text-white">Remove <b>${esc(m.name)}</b> from ${esc(r.team)}?</div>${notesFor('del', r, m, ask)}`, 'ask-ok', 'Remove', dangerStyle, 'Cancel');
        if (ask.kind === 'edit') return wrap(`<div class="text-[14px] text-white">Rename <b>${esc(m.name)}</b> → <b>${esc(ask.nn)}</b>?</div>${notesFor('edit', r, m, ask)}`, 'ask-ok', 'Rename', goldStyle, 'Back');
        if (ask.kind === 'move') {
            const to = S.data.teams.find(x => x.key === ask.to);
            return wrap(`<div class="text-[14px] text-white">Move <b>${esc(m.name)}</b> to <b>${esc(to ? `${to.team} (${to.division})` : ask.to)}</b>?</div>${notesFor('move', r, m, ask)}`, 'ask-ok', 'Move player', goldStyle, 'Back');
        }
        if (ask.kind === 'moveSel') {
            let opts = '<option value="">Choose a team…</option>', lastDiv = '';
            S.data.teams.forEach(t => {
                if (t.key === r.key) return;
                if (t.division !== lastDiv) { if (lastDiv) opts += '</optgroup>'; opts += `<optgroup label="${esc(t.division)}">`; lastDiv = t.division; }
                opts += `<option value="${esc(t.key)}"${ask.to === t.key ? ' selected' : ''}>${esc(t.team)} (${t.count} players)</option>`;
            });
            return wrap(`<div class="text-[14px] text-white">Move <b>${esc(m.name)}</b> to</div><select id="roster-move-to" class="select-glass mt-2 w-full" aria-label="Team to move ${esc(m.name)} to">${opts}</optgroup></select>`, 'ask-ok', 'Move…', goldStyle, 'Cancel');
        }
    }
    if (S.editing === m.name) {
        return `<div class="${rowCls}" style="${rowBg}"><div class="flex items-center gap-2"><input id="roster-edit-name" value="${esc(m.name)}" aria-label="New name for ${esc(m.name)}" class="field-dark min-w-0 flex-1"><button data-act="edit-ok" class="${goldBtn}" style="${goldStyle}">Update</button><button data-act="edit-cancel" class="${smBtn}">Cancel</button></div></div>`;
    }
    const hl = S.hl && S.hl.toLowerCase() === m.name.toLowerCase();
    const open = S.openWaiver === m.name;
    const waiverTag = m.signed
        ? `<button data-act="waiver" data-i="${i}" class="rounded-full px-2.5 py-1 text-[11px] font-semibold" style="background:rgba(46,158,99,.18);color:#6fd6a0" aria-expanded="${open}" aria-label="Waiver received for ${esc(m.name)}. Show who submitted it and when.">Waiver ✓</button>`
        : '<span class="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-white/55">No waiver</span>';
    const detail = open ? `<div class="mt-2 rounded-xl bg-black/25 px-3 py-2 text-[12px] text-white/70">${
        (m.waivers && m.waivers.length)
            ? m.waivers.map(w => `Submitted by <b class="text-white">${esc(w.parent || 'name not recorded')}</b><br><span class="text-white/50">${esc(fmtWhen(w.ts))}</span>`).join('<hr class="my-1.5 border-white/10">')
            : 'Marked as signed on the Participant List — no waiver submission is linked to this name.'}</div>` : '';
    return `<div class="${rowCls}" style="${rowBg}">
      <div class="flex items-center gap-2">
        <div class="min-w-0 flex-1"><div class="truncate text-[14px] text-white"><span ${hl ? 'style="background:rgba(224,184,99,.3);border-radius:4px;padding:0 3px"' : ''}>${esc(m.name)}</span></div>
          ${m.waiverName && m.waiverName.toLowerCase() !== m.name.toLowerCase() ? `<div class="truncate text-[12px] text-white/50">waiver says “${esc(m.waiverName)}”</div>` : ''}
          ${m.provisional ? '<div class="text-[11px]" style="color:var(--gold-l)">Unconfirmed — waiver only</div>' : ''}</div>
        ${waiverTag}
        <button data-act="move" data-i="${i}" class="${smBtn}" title="Move to another team" aria-label="Move ${esc(m.name)} to another team">⇄</button>
        <button data-act="edit" data-i="${i}" class="${smBtn}" title="Edit name" aria-label="Edit ${esc(m.name)}">✎</button>
        <button data-act="del" data-i="${i}" class="${smBtn}" title="Remove from team" aria-label="Remove ${esc(m.name)}">🗑</button>
      </div>${detail}</div>`;
}

function renderDetail() {
    const r = S.data.rosters[S.cur];
    const n = r.members.length, signed = r.members.filter(m => m.signed).length;
    let h = head(r.team, `<button data-act="back" class="${pillBtn}">← Roster</button>`);
    h += `<section class="card-dark mt-3.5 p-4">
        <div class="text-[11px] text-white/50">${esc(r.division)}</div>
        <div class="mt-2 grid gap-1.5 text-[13px] text-white/75">
          <div class="flex flex-wrap items-center gap-2"><span class="w-24 text-white/45">Captain</span>${r.captain ? `<b class="text-white">${esc(r.captain)}</b>` : '<i class="text-white/40">none</i>'}
            ${r.captainEmail ? `<a class="${smBtn}" href="mailto:${esc(r.captainEmail)}" aria-label="Email the captain" title="${esc(r.captainEmail)}">✉</a>` : ''}
            ${r.captainPhone ? `<a class="${smBtn}" href="tel:${esc(r.captainPhone.replace(/[^\d+]/g, ''))}" aria-label="Call the captain" title="${esc(r.captainPhone)}">☎ ${esc(r.captainPhone)}</a>` : ''}</div>
          <div class="flex items-center gap-2"><span class="w-24 text-white/45">Registered</span>${r.registered ? `<b class="text-white">${esc(fmtDate(r.registered))}</b>` : '<i class="text-white/40">unknown</i>'}</div>
        </div></section>`;
    h += `<div class="mt-2.5 grid grid-cols-2 gap-2.5">${paidChip(r)}
        ${statChip(`<div><div class="text-[16px] font-bold text-white tabular-nums">${signed} / ${n}</div><div class="text-[11px] text-white/50">waivers matched</div></div>`)}
        ${subChip(r)}
        ${statChip(`<div><div class="text-[16px] font-bold" style="color:${r.girls ? '#f9a8d4' : 'white'}">${r.girls ? 'Yes' : 'No'}</div><div class="text-[11px] text-white/50">Girls only</div></div>`)}
        ${ciChip(r)}</div>`;
    h += ciAskHtml(r) + ciNotesHtml(r);
    const banner = (inner, warn) => `<div class="mt-2.5 rounded-2xl px-3.5 py-2.5 text-[12.5px] leading-snug text-white/80" style="${warn ? 'background:rgba(224,184,99,.12);border:1px solid rgba(224,184,99,.4)' : 'background:rgba(255,255,255,.06);border-left:3px solid var(--gold)'}">${inner}</div>`;
    if (n < r.min) h += banner(`Below the minimum of ${r.min} players.`, true);
    if (n > r.max) h += banner(`Over the form limit of ${r.max} players (allowed — they only appear on the Participant List).`, true);
    if (r.unlinkedWaivers.length) h += banner(`<b>${r.unlinkedWaivers.length} waiver${r.unlinkedWaivers.length > 1 ? 's' : ''} on file for this team aren’t matched to anyone:</b> ${r.unlinkedWaivers.map(w => `${esc(w.typed)} <span class="text-white/50">(${esc(w.parent)}, ${esc(w.ts)})</span>`).join('; ')}. Add that child below and the waiver is linked automatically.`);
    if (r.regOnly.length) h += banner(`The registration form lists <b>${r.regOnly.map(esc).join(', ')}</b> — no one on the roster has that exact name. If it’s a spelling difference, rename the right person and pick that entry in the review step.`);

    h += `<div class="mt-4 mb-1.5 flex items-baseline gap-2 px-1">${kicker('Roster')}<span class="text-[11px] text-white/40">${n} player${n === 1 ? '' : 's'} · A–Z</span></div><div class="grid gap-1.5" id="roster-members">`;
    if (!n) h += '<div class="rounded-2xl bg-white/[.05] px-3 py-3 text-[13px] text-white/50">No players on the Participant List yet.</div>';
    r.members.forEach((m, i) => { h += memberRow(r, m, i); });
    S.adding.filter(x => x.team === r.key).forEach(x => { h += `<div class="rounded-2xl bg-white/[.05] px-3 py-2.5"><div class="text-[14px] text-white">${esc(x.name)}</div><div class="text-[12px] text-white/50">Adding…</div></div>`; });
    h += '</div>';

    const ak = S.ask && S.ask.kind === 'add' ? S.ask : null;
    h += `<div class="mt-4 mb-1.5 px-1">${kicker('Add a player')}</div><section class="card-dark p-3.5">`;
    if (ak) {
        h += `<div class="text-[14px] text-white">Add <b>${esc(ak.name)}</b> to <b>${esc(r.team)}</b>?</div>${addNotes(r, ak)}<div class="mt-2.5 flex gap-2"><button data-act="ask-ok" class="${goldBtn}" style="${goldStyle}">Add player</button><button data-act="ask-no" class="${smBtn}">Cancel</button></div>`;
    } else {
        h += `<label for="roster-new-name" class="text-[11px] text-white/50">Name of the new player on ${esc(r.team)}</label>
          <div class="mt-1.5 flex gap-2"><input id="roster-new-name" placeholder="First Last" autocomplete="off" value="${esc(S.draft)}" class="field-dark min-w-0 flex-1"><button data-act="add" class="${goldBtn}" style="${goldStyle}">Add…</button></div>`;
        if (r.unlinkedWaivers.length) {
            h += `<div class="mt-2.5 text-[12px] text-white/60">Match to an unmatched waiver (optional)<select id="roster-link" class="select-glass mt-1 w-full"><option value="">— automatic (by name) —</option>${r.unlinkedWaivers.map(w => `<option value="${w.row}">${esc(w.typed)} — ${esc(w.parent)} (${esc(w.ts)})</option>`).join('')}</select></div>`;
        }
    }
    h += '</section>';
    return h;
}

/* ---------- team check-in (gameday) ---------- */
// Mirrors v15 of the Registrations sheet's Team Management tool. Off until switched on in Setup; while off, none of this renders.

/** Per division: how many teams, how many checked in. Order follows the team list (already sorted by division). */
function ciStats() {
    const by = {}, order = [];
    S.data.teams.forEach(t => { let d = by[t.division]; if (!d) { d = by[t.division] = { n: 0, ci: 0 }; order.push(t.division); } d.n++; if (t.ci) d.ci++; });
    return { by, order };
}

/** The counter above the team list: All divisions or one, "14 / 28 teams", a bar, and an "only not checked in" filter. */
function ciBox(cs) {
    if (!S.ciOn || !cs.order.length) return '';
    if (S.ciDiv && !cs.by[S.ciDiv]) S.ciDiv = '';
    let n = 0, c = 0, allN = 0, allC = 0;
    cs.order.forEach(k => { allN += cs.by[k].n; allC += cs.by[k].ci; if (!S.ciDiv || k === S.ciDiv) { n += cs.by[k].n; c += cs.by[k].ci; } });
    return `<section class="card-dark mt-3.5 p-3.5">
      <div class="flex items-center justify-between gap-2"><span class="text-[12px] font-semibold text-white/60">✓ Checked in</span>
        <select id="roster-ci-div" class="select-glass !w-auto max-w-[170px] !py-1.5 text-[12px]" aria-label="Show check-in for one division"><option value="">All divisions (${allC}/${allN})</option>${cs.order.map(k => `<option value="${esc(k)}"${k === S.ciDiv ? ' selected' : ''}>${esc(k)} (${cs.by[k].ci}/${cs.by[k].n})</option>`).join('')}</select></div>
      <div class="mt-1.5 text-[22px] font-bold leading-tight text-white tabular-nums">${c} / ${n} <span class="text-[12px] font-normal text-white/50">teams${n && c === n ? ' · all in ✓' : n ? ' · ' + (n - c) + ' to go' : ''}</span></div>
      <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"><i class="block h-full" style="width:${n ? Math.round(100 * c / n) : 0}%;background:var(--ok)"></i></div>
      <label class="mt-2.5 flex cursor-pointer items-center gap-2 text-[12px] text-white/70"><input type="checkbox" id="roster-ci-out"${S.ciOut ? ' checked' : ''}> Only teams not checked in</label></section>`;
}

/** Things worth a second look at the door. They never block a check-in; they are shown, and kept on the Check-In Log if you go ahead. */
function ciWarnings(r) {
    const n = r.members.length, signed = r.members.filter(m => m.signed).length, w = [];
    if (r.hasPaidCol && !r.paid) w.push('Not marked paid');
    if (n && signed < n) w.push(`${n - signed} of ${n} player${n === 1 ? ' has' : 's have'} no waiver`);
    if (r.unlinkedWaivers.length) w.push(`${r.unlinkedWaivers.length} waiver${r.unlinkedWaivers.length === 1 ? '' : 's'} on file not matched to anyone`);
    if (n < r.min) w.push(`Only ${n} player${n === 1 ? '' : 's'} on the roster (minimum ${r.min})`);
    return w;
}

function ciChip(r) {
    if (!S.ciOn) return '';
    let act;
    if (S.ciBusy === r.key) act = '<span class="text-[11px] text-white/50">Saving…</span>';
    else if (S.ciAsk === r.key) act = '';
    else act = r.ci ? `<button data-act="ci-act" class="${smBtn}" title="Undo check-in" aria-label="Undo check-in">↺</button>`
                    : `<button data-act="ci-act" class="${goldBtn}" style="${goldStyle}">Check in</button>`;
    return statChip(`<div><div class="text-[16px] font-bold" style="color:${r.ci ? 'var(--ok)' : 'white'}">${r.ci ? 'Yes' : 'No'}</div>
        <div class="text-[11px] text-white/50">Checked in${r.ci && r.ciTime ? ' · ' + esc(r.ciTime) : ''}</div>${r.ci && r.ciBy ? `<div class="text-[11px] text-white/50">by ${esc(r.ciBy)}</div>` : ''}</div>${act}`,
        'col-span-2');
}

/** The inline confirm under the cards: problems listed first, a note/reason box, then the button. */
function ciAskHtml(r) {
    if (!S.ciOn || S.ciAsk !== r.key) return '';
    const box = (warn, inner) => `<section class="mt-2.5 rounded-2xl px-3.5 py-3" style="${warn ? 'background:rgba(224,184,99,.12);border:1px solid rgba(224,184,99,.4)' : 'background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15)'}">${inner}</section>`;
    const field = (ph, okLabel, okStyle) => `<div class="mt-2.5 flex flex-wrap gap-2"><input id="roster-ci-reason" placeholder="${esc(ph)}" maxlength="300" value="${esc(S.ciReason)}" class="field-dark min-w-0 flex-1"><button data-act="ci-ok" class="${goldBtn}" style="${okStyle}">${okLabel}</button><button data-act="ci-no" class="${smBtn}">Cancel</button></div>`;
    if (r.ci) return box(false, `<div class="text-[14px] text-white">Undo the check-in for <b>${esc(r.team)}</b>? It goes back to “No”. The history keeps both entries.</div>${field('Why? (optional)', 'Undo check-in', dangerStyle)}`);
    const w = ciWarnings(r);
    return box(w.length > 0, `<div class="text-[14px] text-white">${w.length ? `Check in <b>${esc(r.team)}</b> anyway? Before you do:` : `Check in <b>${esc(r.team)}</b>?`}</div>
        ${w.length ? `<ul class="mt-1.5 list-disc pl-5 text-[12.5px] text-white/80">${w.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${field(w.length ? 'Reason for checking in anyway, or a note (optional)' : 'Note (optional)', w.length ? 'Check in anyway' : 'Check in', goldStyle)}`);
}

function ciNotesHtml(r) {
    if (!S.ciOn) return '';
    const log = S.ciLog[r.key];
    let h = `<section class="card-dark mt-2.5 p-3.5"><div class="text-[12px] font-semibold text-white/60">Check-in notes &amp; history${log && log.length ? ` · ${log.length} entr${log.length === 1 ? 'y' : 'ies'}` : ''}</div>
      <div class="mt-2 flex gap-2"><input id="roster-ci-note" placeholder="Note about the team or its captain…" maxlength="500" autocomplete="off" value="${esc(S.ciNote)}" aria-label="Check-in note for ${esc(r.team)}" class="field-dark min-w-0 flex-1"><button data-act="ci-note-add" class="${goldBtn}" style="${goldStyle}"${S.ciNoteBusy ? ' disabled' : ''}>Add note</button></div>`;
    if (log === undefined) h += '<div class="mt-2 text-[12px] text-white/45">Loading history…</div>';
    else if (!log.length) h += '<div class="mt-2 text-[12px] text-white/45">No check-in history yet.</div>';
    else h += `<div class="mt-2 max-h-[190px] overflow-auto">${log.map(e => {
        const tone = e.action === 'Checked in' ? 'background:rgba(46,158,99,.18);color:#6fd6a0' : e.action === 'Note' ? 'background:rgba(255,255,255,.1);color:rgba(255,255,255,.7)' : 'background:rgba(224,184,99,.18);color:var(--gold-l)';
        return `<div class="border-t border-white/10 py-1.5 text-[13px] text-white/80"><span class="text-[12px] text-white/45">${esc(e.time)}${e.by ? ' · ' + esc(e.by) : ''}</span> <span class="rounded-full px-2 py-0.5 text-[11px] font-semibold" style="${tone}">${esc(e.action)}</span>${e.note ? ' ' + esc(e.note) : ''}${e.warn ? `<div class="text-[12px] text-white/45">Checked in with: ${esc(e.warn)}</div>` : ''}</div>`;
    }).join('')}</div>`;
    return h + '</section>';
}

function ciWho() {
    try { return (window.App && window.App.state && window.App.state.reporterName) || 'Tournament manager'; } catch (e) { return 'Tournament manager'; }
}

function addCiEntry(key, entry) { if (entry && S.ciLog[key]) S.ciLog[key].unshift(entry); }

async function loadCiLog(key) {
    S.ciLoading[key] = true;
    try {
        const x = await getRosterCheckinLog(token(), key);
        S.ciLog[key] = x.success === false ? [] : (x.entries || []);
    } catch (e) { S.ciLog[key] = []; }
    S.ciLoading[key] = false;
    if (S.cur === key && S.ciOn) render();
}

/** Check in / undo: the page updates at once, the sheet write happens behind it, and it rolls back with a message if the write fails (same as Paid). */
async function setCheckin(want) {
    const key = S.cur, r = S.data.rosters[key], t = S.data.teams.find(x => x.key === key), yes = want === 'Yes';
    const warns = yes ? ciWarnings(r) : [], note = S.ciReason.trim(), prev = { ci: r.ci, time: r.ciTime || '', by: r.ciBy || '' };
    const apply = (v, time, by) => { r.ci = v; r.ciTime = time; r.ciBy = by; if (t) { t.ci = v; t.ciTime = time; } };
    apply(yes, yes ? new Date().toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '', yes ? ciWho() : '');
    S.ciAsk = null; S.ciReason = ''; S.ciBusy = key; render();
    const fail = (msg) => { S.ciBusy = null; apply(prev.ci, prev.time, prev.by); render(); showError(Array.isArray(msg) ? msg : [msg]); };
    let x;
    try {
        x = await setRosterCheckin(token(), { teamKey: key, want, note, warnings: warns.join('; '), by: ciWho() });
    } catch (e) {
        fail((e.body && e.body.errors) || e.message || String(e));
        return;
    }
    if (!x.ok) { fail(x.errors || ['Could not save.']); return; }
    S.ciBusy = null; apply(x.ci, x.time || '', x.by || '');
    if (!x.unchanged) addCiEntry(key, x.entry);
    render();
    toast(x.unchanged ? `${r.team} was already ${x.ci ? 'checked in' : 'not checked in'}` : `✓ ${r.team}${yes ? ' checked in' : ' check-in undone'}`);
    if (x.verified === false) showError(['The change was written, but the sheet did not read back as expected.', 'Check the Registrations row and the Check-In Log tab.']);
}

async function addCiNote() {
    const key = S.cur, inp = document.getElementById('roster-ci-note'), text = (inp ? inp.value : S.ciNote).trim();
    if (!text || S.ciNoteBusy) return;
    S.ciNoteBusy = true; render();
    try {
        const x = await addRosterCheckinNote(token(), { teamKey: key, note: text, by: ciWho() });
        S.ciNoteBusy = false;
        if (!x.ok) { render(); showError(x.errors || ['Could not save the note.']); return; }
        if (S.ciNote.trim() === text) S.ciNote = '';
        addCiEntry(key, x.entry); render(); document.getElementById('roster-ci-note')?.focus();
        toast('✓ Note saved');
    } catch (e) { S.ciNoteBusy = false; render(); showError([(e.body && e.body.error) || e.message || String(e)]); }
}

/** Called from Setup when the shared switch changes, so the Roster view follows at once. */
export function setCheckinEnabled(on) {
    on = on === true;
    if (S.ciOn === on) return;
    S.ciOn = on;
    if (!on) { S.ciDiv = ''; S.ciOut = false; S.ciAsk = null; S.ciReason = ''; }
    if (S.data) render();
}

/* ---------- render + wiring ---------- */

function render() {
    const el = body();
    if (!el) return;
    if (!S.data) {
        el.innerHTML = head('Roster', '') + (S.error
            ? `<div class="card-dark mt-3.5 p-4 text-sm text-white/80"><div class="font-semibold" style="color:var(--gold-l)">Couldn’t load the roster</div><div class="mt-1 text-white/60">${esc(S.error)}</div><button data-act="refresh" class="${smBtn} mt-3">Try again</button></div>`
            : '<div class="py-16 text-center text-sm text-white/50">Loading rosters…</div>');
        return;
    }
    const keepQ = document.activeElement && document.activeElement.id === 'roster-q';
    el.innerHTML = S.cur ? renderDetail() : renderList();
    if (keepQ) { const q = document.getElementById('roster-q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
    if (S.cur && S.ciOn && S.ciLog[S.cur] === undefined && !S.ciLoading[S.cur]) loadCiLog(S.cur);
    if (S.cur) {
        const focus = (id, sel) => { const x = document.getElementById(id); if (x) { x.focus(); if (sel) x.select(); } };
        if (S.editing) focus('roster-edit-name', true);
        else if (S.editSub && S.subAsk == null) focus('roster-sub', true);
    }
    S.hl = null;
}

function open(key, hlName) {
    S.cur = key; S.editing = null; S.ask = null; S.draft = ''; S.editSub = false; S.subAsk = null; S.confirmPaid = false; S.openWaiver = null; S.hl = hlName || null; S.ciAsk = null; S.ciReason = ''; S.ciNote = '';
    render();
    window.scrollTo?.({ top: 0 });
}

function startEdit() {
    const r = S.data.rosters[S.cur], inp = document.getElementById('roster-edit-name');
    const nn = inp.value.trim().replace(/\s+/g, ' '), on = S.editing;
    if (!nn || nn === on) { S.editing = null; render(); return; }
    if (r.members.some(m => m.name.toLowerCase() === nn.toLowerCase() && m.name !== on)) { toast(`“${nn}” is already on this roster.`, true); return; }
    S.editing = null; S.ask = { kind: 'edit', name: on, nn }; render();
}
function startAdd() {
    const r = S.data.rosters[S.cur], inp = document.getElementById('roster-new-name');
    const name = inp.value.trim().replace(/\s+/g, ' ');
    if (!name) { inp.focus(); return; }
    if (r.members.some(m => m.name.toLowerCase() === name.toLowerCase())) { toast(`“${name}” is already on this roster.`, true); return; }
    const sel = document.getElementById('roster-link');
    S.draft = name; S.ask = { kind: 'add', name, link: sel && sel.value ? sel.value : '' }; render();
}
function askBack() {
    const k = S.ask; if (!k) return;
    if (k.kind === 'move') S.ask = { kind: 'moveSel', name: k.name, to: k.to };
    else if (k.kind === 'edit') { S.editing = k.name; S.ask = null; }
    else S.ask = null;
    render();
}
function askGo() {
    const k = S.ask; if (!k) return;
    const key = S.cur;
    if (k.kind === 'del') run({ type: 'delete', teamKey: key, name: k.name }, { row: k.name, text: 'Removing…' });
    else if (k.kind === 'moveSel') {
        const v = (document.getElementById('roster-move-to') || {}).value;
        if (!v) { toast('Choose a team first', true); return; }
        S.ask = { kind: 'move', name: k.name, to: v }; render();
    } else if (k.kind === 'move') {
        const to = S.data.teams.find(x => x.key === k.to);
        run({ type: 'movePlayer', teamKey: key, name: k.name, toTeamKey: k.to }, { row: k.name, text: `Moving to ${to ? to.team : k.to}…` });
    } else if (k.kind === 'edit') run({ type: 'edit', teamKey: key, oldName: k.name, newName: k.nn }, { row: k.name, text: `Renaming to ${k.nn}…` });
    else if (k.kind === 'add') {
        const a = { type: 'add', teamKey: key, name: k.name };
        if (k.link) a.linkWaiverRow = k.link;
        S.draft = '';
        run(a, { adding: k.name });
    }
}

/* ---------- writes ---------- */

// One click (after the inline confirm) when nothing needs a second look; otherwise the server answers
// needsReview and we open the review window with the full change list.
async function run(action, ui) {
    const key = S.cur, bk = ui.row ? `${key}|${ui.row}` : null;
    S.ask = null; S.editing = null;
    if (bk) S.busyRows[bk] = ui.text;
    if (ui.adding) S.adding.push({ team: key, name: ui.adding });
    render();
    const done = () => { if (bk) delete S.busyRows[bk]; if (ui.adding) S.adding = S.adding.filter(x => !(x.team === key && x.name === ui.adding)); };
    try {
        const res = await applyRosterAction(token(), { ...action, quick: true, ack: true });
        done();
        if (res.needsReview) { render(); openReview(action, res.preview); return; }
        finish(res);
    } catch (e) {
        done(); render();
        showError([e.message || String(e)]);
    }
}

function finish(res) {
    if (!res.ok) { render(); showError(res.errors || ['Could not save.']); return; }
    if (res.fresh) adopt({ ...S.data, ...res.fresh });
    render();
    const bad = (res.checks || []).filter(c => !c.ok);
    if (bad.length) showError(['The change was written, but some checks failed:', ...bad.map(c => '✗ ' + c.msg), 'Check the sheet and the Roster Change Log.']);
    else toast('✓ ' + (res.title || 'Saved'));
}

/* ---------- modal (review + errors) ---------- */

function closeModal() { document.getElementById('roster-modal')?.remove(); }
function modal(inner) {
    closeModal();
    const m = document.createElement('div');
    m.id = 'roster-modal'; m.className = 'modal-backdrop';
    m.innerHTML = `<div class="modal-sheet-dark"><div class="p-4 grid gap-3">${inner}</div></div>`;
    m.addEventListener('click', (e) => {
        if (e.target === m || e.target.closest('[data-m="close"]')) closeModal();
    });
    document.body.appendChild(m);
    return m;
}
function showError(lines) {
    modal(`${kicker('Something went wrong')}<div class="grid gap-1.5 text-[13px] text-white/80">${lines.map(l => `<div>${esc(l)}</div>`).join('')}</div><div class="flex justify-end"><button data-m="close" class="${smBtn}">Close</button></div>`);
}

async function openReview(action, preview) {
    let p = preview;                                  // the apply call already planned it: no second read of the sheet
    if (!p) {
        modal(`${kicker('Review')}<div class="py-6 text-center text-sm text-white/50">Checking the sheet…</div>`);
        try { p = await previewRosterAction(token(), action); }
        catch (e) { showError([e.message || String(e)]); return; }
    }
    if (p.errors && p.errors.length) { showError(p.errors); return; }
    const bySheet = {};
    (p.changes || []).forEach(c => { (bySheet[c.sheet] = bySheet[c.sheet] || []).push(c.text); });
    const cands = (p.options && p.options.regCandidates) || [];
    const canKill = p.options && p.options.canDeleteWaivers;
    const m = modal(`${kicker('Review before saving')}<div class="text-[15px] font-semibold text-white">${esc(p.title)}</div>
      ${(p.warnings || []).map(w => `<div class="rounded-xl px-3 py-2 text-[12.5px] text-white/85" style="background:rgba(224,184,99,.12);border:1px solid rgba(224,184,99,.4)">⚠ ${esc(w)}</div>`).join('')}
      ${Object.keys(bySheet).map(s => `<div><div class="text-[10px] font-semibold uppercase tracking-[.12em]" style="color:var(--gold-l)">${esc(s)}</div><ul class="mt-1 list-disc pl-5 text-[12.5px] text-white/75">${bySheet[s].map(t => `<li>${esc(t)}</li>`).join('')}</ul></div>`).join('')}
      ${cands.length ? `<div class="rounded-xl bg-white/[.06] px-3 py-2.5 text-[12.5px] text-white/75">The registration form has name(s) not matched to anyone. If one is the same child, pick it so the form entry is updated too:
          <select id="roster-reg-pick" class="select-glass mt-2 w-full"><option value="">— leave the registration form alone —</option>${cands.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select></div>` : ''}
      ${canKill ? `<label class="flex items-start gap-2 text-[12.5px] text-white/75"><input type="checkbox" id="roster-kill-waivers" class="mt-0.5"><span>Also <b>delete</b> their waiver(s). Waivers are a legal record — this can only be undone from the sheet’s version history. (Unchecked: the waiver is kept and marked unmatched.)</span></label>` : ''}
      <div class="flex justify-end gap-2"><button data-m="close" class="${smBtn}">Cancel</button><button id="roster-review-ok" class="${goldBtn}" style="${p.danger ? dangerStyle : goldStyle}">${esc(p.confirmLabel || 'Apply')}</button></div>`);
    m.querySelector('#roster-review-ok').onclick = async () => {
        const a = { ...action, quick: false };
        const pick = m.querySelector('#roster-reg-pick'); if (pick && pick.value) a.regName = pick.value;
        const kill = m.querySelector('#roster-kill-waivers'); if (kill && kill.checked) a.deleteWaivers = true;
        const btn = m.querySelector('#roster-review-ok'); btn.disabled = true; btn.textContent = 'Saving…';
        try { const res = await applyRosterAction(token(), a); closeModal(); finish(res); }
        catch (e) { closeModal(); showError([e.message || String(e)]); }
    };
}

/* ---------- Paid / Sub division ---------- */

async function setPaid(want) {
    const r = S.data.rosters[S.cur], t = S.data.teams.find(x => x.key === S.cur), prev = r.paid, yes = want === 'Yes';
    const apply = (v) => { r.paid = v; if (t) t.paid = v; };
    apply(yes); S.confirmPaid = false; S.paidBusy = true; render();           // show it immediately; the sheet write happens behind it
    let res;
    try {
        res = await applyRosterAction(token(), { type: 'setPaid', teamKey: S.cur, paid: want });
    } catch (e) { S.paidBusy = false; apply(prev); render(); showError([e.message || String(e)]); return; }
    S.paidBusy = false;
    if (!res.ok) { apply(prev); render(); showError(res.errors || ['Could not save.']); return; }
    render(); toast(`✓ ${r.team} marked ${yes ? 'paid' : 'not paid'}`);
}
/** Sub divisions in use, rebuilt from the team list (so saving one needs no second trip to the sheet). */
function recomputeSubOptions() {
    const seen = {}, out = [];
    S.data.teams.forEach(t => {
        const v = (t.sub || '').trim(); if (!v) return;
        const k = v.toLowerCase();
        if (!seen[k]) { seen[k] = { name: v, count: 0 }; out.push(seen[k]); }
        seen[k].count++;
    });
    out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    S.data.subOptions = out;
    Object.keys(S.data.rosters).forEach(k => { S.data.rosters[k].subOptions = out; });
}
async function setSub(val) {
    const key = S.cur, r = S.data.rosters[key], t = S.data.teams.find(x => x.key === key);
    S.editSub = false; S.subAsk = null; render();
    let res;
    try { res = await applyRosterAction(token(), { type: 'setSub', teamKey: key, sub: val }); }
    catch (e) { showError([e.message || String(e)]); return; }
    if (!res.ok) { showError(res.errors || ['Could not save.']); return; }
    const saved = res.value != null ? res.value : val;       // the server reuses an existing spelling ("chaos" -> "Chaos")
    r.sub = saved; if (t) t.sub = saved;
    recomputeSubOptions(); render();
    toast(`✓ ${r.team}: sub division ${saved ? 'set to ' + saved : 'cleared'}`);
}

/* ---------- events (one delegated listener; wired once) ---------- */

let wired = false;
function wire() {
    const el = body();
    if (!el || wired) return;
    wired = true;
    el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]'); if (!b || b.tagName === 'A') return;
        const act = b.getAttribute('data-act');
        const r = S.cur && S.data ? S.data.rosters[S.cur] : null;
        const m = r && b.hasAttribute('data-i') ? r.members[+b.getAttribute('data-i')] : null;
        switch (act) {
            case 'open': open(b.getAttribute('data-k'), b.getAttribute('data-n')); break;
            case 'back': S.cur = null; S.ask = null; S.editing = null; render(); break;
            case 'refresh': S.ask = null; S.ciLog = {}; load(!!S.data, true); break;
            case 'waiver': S.openWaiver = S.openWaiver === m.name ? null : m.name; render(); break;
            case 'edit': S.ask = null; S.editing = m.name; render(); break;
            case 'move': S.editing = null; S.ask = { kind: 'moveSel', name: m.name, to: '' }; render(); break;
            case 'del': S.editing = null; S.ask = { kind: 'del', name: m.name }; render(); break;
            case 'edit-ok': startEdit(); break;
            case 'edit-cancel': S.editing = null; render(); break;
            case 'add': startAdd(); break;
            case 'ask-ok': askGo(); break;
            case 'ask-no': askBack(); break;
            case 'paid': S.confirmPaid = true; render(); break;
            case 'paid-no': S.confirmPaid = false; render(); break;
            case 'paid-ok': setPaid(r.paid ? 'No' : 'Yes'); break;
            case 'sub-edit': S.editSub = true; render(); break;
            case 'sub-cancel': S.editSub = false; render(); break;
            case 'sub-back': S.subAsk = null; render(); break;
            case 'sub-chip': { const i = document.getElementById('roster-sub'); if (i) { i.value = b.getAttribute('data-v'); i.focus(); } break; }
            case 'sub-ok': {
                const v = document.getElementById('roster-sub').value.trim();
                if (v === String(r.sub || '')) { S.editSub = false; render(); break; }
                S.subAsk = v; render(); break;
            }
            case 'sub-yes': { const v = S.subAsk; setSub(v); break; }
            case 'ci-act': S.ciAsk = S.cur; S.ciReason = ''; render(); document.getElementById('roster-ci-reason')?.focus(); break;
            case 'ci-no': S.ciAsk = null; S.ciReason = ''; render(); break;
            case 'ci-ok': setCheckin(r.ci ? 'No' : 'Yes'); break;
            case 'ci-note-add': addCiNote(); break;
        }
    });
    el.addEventListener('input', (e) => {
        if (e.target.id === 'roster-q') { S.q = e.target.value; const keep = e.target.selectionStart; render(); const q = document.getElementById('roster-q'); if (q) { q.focus(); q.setSelectionRange(keep, keep); } }
        else if (e.target.id === 'roster-new-name') S.draft = e.target.value;
        else if (e.target.id === 'roster-ci-reason') S.ciReason = e.target.value;
        else if (e.target.id === 'roster-ci-note') S.ciNote = e.target.value;
    });
    el.addEventListener('change', (e) => {
        if (e.target.id === 'roster-move-to' && S.ask) S.ask.to = e.target.value;
        else if (e.target.id === 'roster-ci-div') { S.ciDiv = e.target.value; render(); }
        else if (e.target.id === 'roster-ci-out') { S.ciOut = e.target.checked; render(); }
    });
    el.addEventListener('keydown', (e) => {
        if (e.target.id === 'roster-edit-name') { if (e.key === 'Enter') startEdit(); if (e.key === 'Escape') { S.editing = null; render(); } }
        else if (e.target.id === 'roster-new-name' && e.key === 'Enter') startAdd();
        else if (e.target.id === 'roster-ci-reason' && e.key === 'Enter') el.querySelector('[data-act="ci-ok"]')?.click();
        else if (e.target.id === 'roster-ci-note' && e.key === 'Enter') addCiNote();
        else if (e.target.id === 'roster-sub' && !e.target.readOnly) {
            if (e.key === 'Enter') el.querySelector('[data-act="sub-ok"]')?.click();
            if (e.key === 'Escape') { S.editSub = false; render(); }
        }
    });
}

export function initRoster() { wire(); }

// Best effort: other superadmin devices flip the shared switch through the featureSettingsUpdate socket event (local-backend mode only).
let socketWired = false;
function wireSocket() {
    if (socketWired) return;
    socketWired = true;
    try { getSocket().on('featureSettingsUpdate', (settings) => setCheckinEnabled(settings && settings.checkinEnabled === true)); }
    catch (e) { /* no socket in this mode: Refresh picks the setting up */ }
}

/** Called on logout / role change so a different login never sees cached roster data. */
export function resetRoster() {
    Object.assign(S, { ciOn: false, ciDiv: '', ciOut: false, ciAsk: null, ciReason: '', ciBusy: null, ciLog: {}, ciLoading: {}, ciNote: '', ciNoteBusy: false, data: null, loadedAt: 0, loading: false, error: '', cur: null, q: '', editing: null, ask: null, draft: '', editSub: false, subAsk: null, confirmPaid: false, paidBusy: false, openWaiver: null, busyRows: {}, adding: [] });
    const el = body(); if (el) el.innerHTML = '';
    closeModal();
}
