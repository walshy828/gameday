// public/js/wallboards.js
// Setup → Event day → "📺 Wall boards" (superadmin): run every TV showing
// /scoreboard.html from here. Server side is server/displays.js.
//
// - Now running: the divisions on court right now. Boards set to Follow show
//   these (rotating between them when there are two or more).
// - Per board: Follow / Pinned (its own divisions) / Local (the screen's own
//   setup), a View override (Auto follows the tournament phase), rename,
//   Identify (flashes the name on that screen), Reload, Forget (offline only).
//
// Reads GET /api/displays when Setup opens, on the staff-only data-less
// `displaysUpdate` socket nudge (debounced) and every 15s, only while Setup is
// on screen in a visible tab.
import { getDisplays, postDisplays, getDivisions } from './api.js';
import { getSocket } from './socketClient.js';

const POLL_MS = 15000;
const MODES = [
    { mode: 'follow', label: 'Follow', desc: 'Shows “Now running”' },
    { mode: 'pinned', label: 'Pinned', desc: 'Shows the divisions picked here' },
    { mode: 'local', label: 'Local', desc: 'Uses the screen’s own setup' }
];
const VIEWS = [
    { view: 'auto', label: 'Auto (follows the day)' },
    { view: 'courts', label: 'Courts + standings' },
    { view: 'playoffs', label: 'Bracket + courts' },
    { view: 'bracket', label: 'Bracket only' }
];
const PHASES = { pool: 'Pool play', preview: 'Playoffs soon', playoffs: 'Playoffs', done: 'Final results' };
const ROTATE = [15, 30, 45, 60, 90];

let data = null;
let divisions = [];
let fetching = false;
let busy = false;
let failed = false;
let nudgeTimer = null;
const openBoards = new Set();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const token = () => sessionStorage.getItem('adminAuthToken');
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const el = () => document.getElementById('setup-wallboards');

function isOnScreen() {
    return App.state.isSuperAdmin && App.state.currentView === 'settings' && document.visibilityState !== 'hidden';
}

export async function refreshWallboards() {
    if (fetching || !isOnScreen() || !el()) return;
    const t = token();
    if (!t) return;
    fetching = true;
    try {
        const [d, divs] = await Promise.all([getDisplays(t), divisions.length ? divisions : getDivisions().catch(() => [])]);
        data = d;
        divisions = Array.isArray(divs) ? divs : divisions;
        failed = !d || !Array.isArray(d.boards);
    } catch (e) {
        failed = true;
    } finally {
        fetching = false;
    }
    render();
}

export function initWallboards() {
    setInterval(refreshWallboards, POLL_MS);
    document.addEventListener('visibilitychange', refreshWallboards);
    try {
        getSocket().on('displaysUpdate', () => {
            clearTimeout(nudgeTimer);
            nudgeTimer = setTimeout(refreshWallboards, 600);
        });
    } catch (e) { /* no socket: the poll still runs */ }
    el()?.addEventListener('click', onClick);
    el()?.addEventListener('change', onChange);
}

// --- actions ------------------------------------------------------------------

async function send(action, body) {
    if (busy) return;
    busy = true;
    el()?.classList.add('opacity-70');
    try {
        const res = await postDisplays(action, body, token());
        if (res && Array.isArray(res.boards)) data = res;
        if (action === 'command' && window.showStatus) {
            const n = res?.screens ?? 0;
            window.showStatus(n ? `Sent to ${n} screen${n === 1 ? '' : 's'}` : 'That board is offline', !n);
        }
    } catch (e) {
        window.showStatus?.(`Couldn’t update the wall boards: ${e.body?.error || e.message}`, true);
    } finally {
        busy = false;
        el()?.classList.remove('opacity-70');
        render();
    }
}

function toggled(list, name) {
    return list.includes(name) ? list.filter(d => d !== name) : [...list, name].slice(0, 4);
}

function onClick(e) {
    const b = e.target.closest('[data-wb]');
    if (!b || !data) return;
    const { wb: act, board: boardId, div } = b.dataset;
    const board = data.boards.find(x => x.boardId === boardId);
    switch (act) {
        case 'now':
            return send('nowRunning', { nowRunning: toggled(data.nowRunning, div) });
        case 'now-clear':
            return send('nowRunning', { nowRunning: [] });
        case 'mode': {
            const mode = b.dataset.mode;
            // Pinned with nothing picked would drop the screen back to its own
            // setup — start it on what it's showing now (else Now running).
            const pre = mode === 'pinned' && board && !board.divisions.length
                ? (board.showing?.divisions?.length ? board.showing.divisions : data.nowRunning) : null;
            return send('board', pre?.length ? { boardId, mode, divisions: pre } : { boardId, mode });
        }
        case 'pin':
            return board && send('board', { boardId, divisions: toggled(board.divisions, div) });
        case 'identify':
        case 'reload':
            return send('command', { boardId, type: act });
        case 'identify-all':
            return send('command', { boardId: '*', type: 'identify' });
        case 'rename': {
            const name = window.prompt('Name this screen (e.g. “Gym North” or “Lobby TV”)', board?.name || '');
            if (name && name.trim()) send('board', { boardId, name: name.trim() });
            return;
        }
        case 'forget':
            if (window.confirm(`Forget “${board?.name}”? It will start fresh (Follow) if it connects again.`)) send('forget', { boardId });
            return;
        case 'toggle':
            if (openBoards.has(boardId)) openBoards.delete(boardId); else openBoards.add(boardId);
            return render();
    }
}

function onChange(e) {
    const s = e.target.closest('[data-wb-select]');
    if (!s || !data) return;
    const kind = s.dataset.wbSelect;
    if (kind === 'rotate') send('nowRunning', { rotateSecs: Number(s.value) });
    if (kind === 'view') send('board', { boardId: s.dataset.board, view: s.value });
    if (kind === 'board-rotate') send('board', { boardId: s.dataset.board, rotateSecs: s.value === '' ? null : Number(s.value) });
}

// --- rendering -------------------------------------------------------------------

function chip(label, on, attrs) {
    const cls = on
        ? 'border-transparent bg-[#E0B863] text-[#2A1B08]'
        : 'border-white/15 bg-white/[.04] text-white/70 hover:text-white';
    return `<button type="button" ${attrs} class="rounded-full border px-3 py-1.5 text-xs font-bold transition ${cls}">${on ? '✓ ' : ''}${esc(label)}</button>`;
}

function rotateSelect(value, attrs, inherit) {
    const opts = (inherit ? [`<option value="" ${value == null ? 'selected' : ''}>Event default</option>`] : [])
        .concat(ROTATE.map(s => `<option value="${s}" ${Number(value) === s ? 'selected' : ''}>${s} s</option>`));
    return `<select ${attrs} class="rounded-lg border border-white/15 bg-gray-800 px-2 py-1 text-xs text-white">${opts.join('')}</select>`;
}

function showingLine(b) {
    if (!b.online) return b.lastSeen ? `Offline · last seen ${clock(b.lastSeen)}` : 'Offline';
    const s = b.showing;
    if (!s || !s.divisions?.length) return 'Online · waiting for a division';
    const what = s.divisions.length > 1 ? `${s.division} (rotating ${s.divisions.length})` : s.division;
    const phase = PHASES[s.phase] ? ` · ${PHASES[s.phase]}` : '';
    const src = s.source === 'local' && b.mode !== 'local' ? ' · own setup' : '';
    return `Showing ${what}${phase}${src}`;
}

function boardRow(b) {
    const open = openBoards.has(b.boardId);
    const dot = b.online ? 'bg-emerald-400' : 'bg-white/25';
    const modeBtns = MODES.map(m => `
        <button type="button" data-wb="mode" data-board="${esc(b.boardId)}" data-mode="${m.mode}" title="${esc(m.desc)}"
            class="flex-1 rounded-lg px-2 py-1.5 text-xs font-bold transition ${b.mode === m.mode ? 'bg-[#E0B863] text-[#2A1B08]' : 'text-white/60 hover:text-white'}">${m.label}</button>`).join('');
    const pinNote = b.mode === 'pinned' && !b.divisions.length
        ? '<p class="text-[11px] text-amber-300/90">Pick at least one division — until then it uses the screen’s own setup.</p>' : '';
    const pins = b.mode === 'pinned' ? `
        <div class="space-y-1.5">
            <div class="text-[11px] font-bold uppercase tracking-wider text-white/40">Divisions on this screen</div>
            <div class="flex flex-wrap gap-1.5">${divisions.map(d => chip(d, b.divisions.includes(d), `data-wb="pin" data-board="${esc(b.boardId)}" data-div="${esc(d)}"`)).join('')}</div>
            ${pinNote}
        </div>` : '';
    const followNote = b.mode === 'follow' && !data.nowRunning.length
        ? '<p class="text-[11px] text-white/45">Nothing in “Now running” yet — it uses the screen’s own setup.</p>' : '';
    const details = open ? `
        <div class="mt-3 space-y-3 border-t border-white/10 pt-3">
            <div class="flex rounded-xl border border-white/10 bg-black/20 p-1">${modeBtns}</div>
            ${followNote}${pins}
            ${b.mode === 'local' ? '<p class="text-[11px] text-white/45">Local: the screen keeps its own divisions and layout. Switch to Follow or Pinned to run it from here.</p>' : `<div class="grid grid-cols-2 gap-3">
                <label class="space-y-1 text-[11px] font-bold uppercase tracking-wider text-white/40">View
                    <select data-wb-select="view" data-board="${esc(b.boardId)}" class="mt-1 block w-full rounded-lg border border-white/15 bg-gray-800 px-2 py-1 text-xs normal-case tracking-normal text-white">
                        ${VIEWS.map(v => `<option value="${v.view}" ${b.view === v.view ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}
                    </select>
                </label>
                <label class="space-y-1 text-[11px] font-bold uppercase tracking-wider text-white/40">Rotate every
                    <span class="mt-1 block normal-case tracking-normal">${rotateSelect(b.rotateSecs, `data-wb-select="board-rotate" data-board="${esc(b.boardId)}"`, true)}</span>
                </label>
            </div>`}
            <div class="flex flex-wrap gap-2">
                <button type="button" data-wb="identify" data-board="${esc(b.boardId)}" class="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-bold text-white/80" ${b.online ? '' : 'disabled'}>Identify</button>
                <button type="button" data-wb="reload" data-board="${esc(b.boardId)}" class="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-bold text-white/80" ${b.online ? '' : 'disabled'}>Reload</button>
                <button type="button" data-wb="rename" data-board="${esc(b.boardId)}" class="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-bold text-white/80">Rename</button>
                ${b.online ? '' : `<button type="button" data-wb="forget" data-board="${esc(b.boardId)}" class="ml-auto rounded-lg border border-red-400/30 px-3 py-1.5 text-xs font-bold text-red-300">Forget</button>`}
            </div>
            <p class="text-[11px] text-white/35">Board id <span class="font-mono">${esc(b.boardId)}</span> · open <span class="font-mono">/scoreboard.html?board=${esc(b.boardId)}</span> on another TV to give it the same settings.</p>
        </div>` : '';
    const modeTag = { follow: 'Follow', pinned: 'Pinned', local: 'Local' }[b.mode];
    const viewTag = b.mode !== 'local' && b.view && b.view !== 'auto' ? ` · ${VIEWS.find(v => v.view === b.view)?.label}` : '';
    return `
        <div class="rounded-xl border border-white/10 bg-white/[.04] px-3 py-2.5 ${b.online ? '' : 'opacity-70'}">
            <button type="button" data-wb="toggle" data-board="${esc(b.boardId)}" class="flex w-full items-center gap-3 text-left">
                <span class="h-2.5 w-2.5 flex-none rounded-full ${dot}"></span>
                <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm font-bold text-white">${esc(b.name)}${b.online > 1 ? ` <span class="text-white/45">· ${b.online} screens</span>` : ''}</span>
                    <span class="block truncate text-[12px] text-white/55">${esc(showingLine(b))}</span>
                </span>
                <span class="flex-none rounded-full border border-white/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white/60">${modeTag}${esc(viewTag)}</span>
                <span class="flex-none text-white/40">${open ? '▴' : '▾'}</span>
            </button>
            ${details}
        </div>`;
}

function render() {
    const root = el();
    if (!root) return;
    const pill = document.getElementById('wallboards-count-pill');
    const nowEl = document.getElementById('wallboards-now');
    const listEl = document.getElementById('wallboards-list');
    if (failed || !data) {
        if (pill) pill.textContent = '…';
        listEl.innerHTML = `<p class="text-sm text-white/50">${failed ? 'Couldn’t load the wall boards.' : 'Loading…'}</p>`;
        return;
    }
    const online = data.boards.filter(b => b.online).length;
    if (pill) pill.textContent = `${online} online`;

    const followers = data.boards.filter(b => b.mode === 'follow').length;
    nowEl.innerHTML = `
        <div class="flex items-center justify-between gap-2">
            <div class="text-[11px] font-bold uppercase tracking-wider text-white/40">Now running</div>
            ${data.nowRunning.length ? '<button type="button" data-wb="now-clear" class="text-[11px] font-bold text-white/45 hover:text-white">Clear</button>' : ''}
        </div>
        <div class="flex flex-wrap gap-1.5">
            ${divisions.length ? divisions.map(d => chip(d, data.nowRunning.includes(d), `data-wb="now" data-div="${esc(d)}"`)).join('') : '<span class="text-sm text-white/45">No divisions yet.</span>'}
        </div>
        <div class="flex flex-wrap items-center justify-between gap-2 text-[12px] text-white/50">
            <span>${data.nowRunning.length
                ? `${followers} board${followers === 1 ? '' : 's'} on Follow show ${data.nowRunning.length > 1 ? 'these, rotating' : 'this'}.`
                : 'Pick what’s on court — every board on Follow switches to it.'}</span>
            ${data.nowRunning.length > 1 ? `<label class="flex items-center gap-2">Rotate every ${rotateSelect(data.rotateSecs, 'data-wb-select="rotate"', false)}</label>` : ''}
        </div>`;

    listEl.innerHTML = data.boards.length
        ? data.boards.map(boardRow).join('') + (online > 1
            ? '<button type="button" data-wb="identify-all" class="w-full rounded-lg border border-white/10 py-2 text-xs font-bold text-white/60 hover:text-white">Identify every screen</button>' : '')
        : '<p class="text-sm text-white/50">No boards yet. Open <a href="/scoreboard.html" target="_blank" rel="noopener" class="underline">/scoreboard.html</a> on a TV and it shows up here.</p>';
}
