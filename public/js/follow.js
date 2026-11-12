// public/js/follow.js
// "Follow a team" — no login. A parent or coach picks the team they care
// about once per division; it's remembered on this phone only (localStorage,
// never sent anywhere) and drives the "My team" card (myTeam.js) plus the
// gold highlights in standings, schedule and the playoff bracket.
//
// Changing the choice fires a window 'followchange' event; main.js re-renders
// the views on it.
import { getFilterableTeamName } from './schedule.js';

const KEY = (division) => `followTeam:${division}`;
const SKIPPED = '__none__';
const memory = {}; // fallback when localStorage is blocked

function read(division) {
    if (!division) return null;
    try {
        const v = localStorage.getItem(KEY(division));
        if (v !== null) return v;
    } catch (e) { /* storage blocked */ }
    return memory[division] ?? null;
}

function write(division, value) {
    memory[division] = value;
    try { localStorage.setItem(KEY(division), value); } catch (e) { /* per-session only */ }
}

function currentDivision() {
    return App.config?.currentSheetName || '';
}

/** The followed team's base name for a division (default: the one being viewed), or null. */
export function getFollowed(division = currentDivision()) {
    const v = read(division);
    return v && v !== SKIPPED ? v : null;
}

/** True once the person has followed a team or said "not now" for this division. */
export function hasChosen(division = currentDivision()) {
    return read(division) !== null;
}

/** Base team name, lowercased: "Ducks (#1)" → "ducks". Null for placeholders/BYE. */
export function normBase(name) {
    const base = getFilterableTeamName(name || '');
    return base ? base.toLowerCase().replace(/\s+/g, ' ') : null;
}

/** Does this schedule/standings/bracket name refer to the followed team? */
export function isFollowed(name, followed = getFollowed()) {
    if (!followed) return false;
    const n = normBase(name);
    return !!n && n === normBase(followed);
}

export function setFollowed(team, division = currentDivision()) {
    write(division, team ? team : SKIPPED);
    window.dispatchEvent(new CustomEvent('followchange', { detail: { division, team: team || null } }));
}

function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function closeFollowPicker() {
    document.getElementById('follow-picker')?.remove();
}

/** Bottom sheet: pick a team to follow (or not now / unfollow). */
export function openFollowPicker(division = currentDivision()) {
    closeFollowPicker();
    const teams = [...(App.data?.teamNames || [])].filter(t => !/^(tbd|tba|bye|—|-)$/i.test(t.trim())).sort((a, b) => a.localeCompare(b));
    if (!teams.length) return;
    const current = getFollowed(division);
    const wrap = document.createElement('div');
    wrap.id = 'follow-picker';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', 'Follow a team');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:130;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.55)';
    wrap.innerHTML = `
        <div class="w-full max-w-md rounded-t-[26px] border border-white/10 p-4" style="background:#241318;max-height:80vh;display:flex;flex-direction:column;padding-bottom:calc(1rem + env(safe-area-inset-bottom,0px))">
            <div class="text-[10px] tracking-[.16em] font-semibold text-white/50 uppercase">${esc(division)}</div>
            <div class="mt-1 text-[17px] font-extrabold text-white">Follow a team?</div>
            <div class="mt-1 text-[12px] leading-[1.4] text-white/55">See where they play next, byes, playoffs and when to head to court, right at the top. Saved on this phone only.</div>
            <div class="mt-3 grid grid-cols-2 gap-2 overflow-y-auto" style="min-height:0">
                ${teams.map(t => {
                    const on = current && normBase(t) === normBase(current);
                    return `<button type="button" data-team="${esc(t)}" class="rounded-[14px] px-3 py-3 text-left text-[13px] font-bold leading-[1.25]"
                        style="${on ? 'background:linear-gradient(135deg,var(--gold) 0%,var(--gold-d) 100%);color:#2A1B08' : 'background:rgba(255,255,255,.07);color:#fff;border:1px solid rgba(255,255,255,.12)'}">${on ? '★ ' : ''}${esc(t)}</button>`;
                }).join('')}
            </div>
            <button type="button" data-none class="mt-3 w-full rounded-full border border-white/15 bg-white/[.06] py-3 text-[13px] font-semibold text-white/70">${current ? 'Stop following' : 'Not now'}</button>
        </div>`;
    wrap.addEventListener('click', (ev) => {
        if (ev.target === wrap) return closeFollowPicker();
        const btn = ev.target.closest('button');
        if (!btn) return;
        closeFollowPicker();
        if ('none' in btn.dataset) setFollowed(null, division);
        else if (btn.dataset.team) setFollowed(btn.dataset.team, division);
    });
    document.body.appendChild(wrap);
}

/** After picking a division on the gate: ask once (skippable) if nothing was chosen yet. */
export function maybeAskFollow(division = currentDivision()) {
    if (hasChosen(division)) return;
    if (!(App.data?.teamNames || []).length) return;
    openFollowPicker(division);
}
