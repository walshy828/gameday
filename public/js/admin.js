// Avoid importing from main.js (circular). Use the api wrapper directly.
import { validateAdmin, getDiscrepancies, dismissDiscrepancy as dismissDiscrepancyApi, saveMatchResult as apiSaveMatchResult, sendSessionHeartbeat, endSession as apiEndSession, runSheetSync, getSheetSyncConfig } from './api.js';
import {
    getFilterableTeamName, parseRoundTime,
    getRoundOrder, getRosterTeams, getByeTeams,
    isReported as isReportedOfficial
} from './schedule.js';
import { switchView, enterApp } from './navigation.js';
import { getSocket } from './socketClient.js';

// --- Result discrepancies (superadmin) -------------------------------------
// A referee-submitted result that differs from the official one. The server
// (server/discrepancies.js) scans every division and keeps dismissals shared
// between all superadmins; the client just mirrors its list in
// App.data.discrepancies and re-fetches whenever something might have changed.

const DISC_PREF_KEY = 'discrepancyAlertPref';
const DISC_POLL_MS = 30000;
let discWatching = false;

/** Per-browser alert level: 'dot' (default; tab dot only) | 'full' (adds gate badge + row chips) | 'off'. */
function getDiscrepancyPref() {
    try {
        const v = localStorage.getItem(DISC_PREF_KEY);
        return v === 'full' || v === 'off' ? v : 'dot';
    } catch { return 'dot'; }
}

function setDiscrepancyPref(value) {
    try { localStorage.setItem(DISC_PREF_KEY, value); } catch { /* storage unavailable */ }
    updateDiscrepancyBadge();
    renderAdminMatchEntryViewImpl();
}

function getOpenDiscrepancies() {
    if (!App.state.isSuperAdmin || getDiscrepancyPref() === 'off') return [];
    return Array.isArray(App.data.discrepancies) ? App.data.discrepancies : [];
}

const sameIndex = (a, b) => String(a) === String(b);
const escAttr = v => esc(v).replace(/"/g, '&quot;');

/** One delegated handler for the panel buttons and the per-row chips (keys may hold any division name). */
function wireDiscrepancyActions(listEl) {
    if (listEl.dataset.discWired) return;
    listEl.dataset.discWired = '1';
    listEl.addEventListener('click', e => {
        const btn = e.target.closest('[data-act]');
        const holder = btn && btn.closest('[data-disc-key]');
        if (!btn || !holder) return;
        const key = holder.dataset.discKey;
        const act = btn.dataset.act;
        if (act === 'use') useReportedResult(key);
        else if (act === 'keep') dismissDiscrepancy(key);
        else if (act === 'edit') reviewDiscrepancy(key);
    });
}

/** Open item for a game in the current division, if any (drives the row chip). */
function discrepancyFor(game) {
    return getOpenDiscrepancies().find(d => d.division === App.config.currentSheetName && sameIndex(d.firebaseIndex, game.firebaseIndex));
}

/** Amber dot on the ADMIN tab and a count on the gate's Admin Panel. Never moves layout. */
function updateDiscrepancyBadge() {
    const n = getOpenDiscrepancies().length;
    const pref = getDiscrepancyPref();
    const dot = document.getElementById('discrepancy-dot');
    if (dot) {
        dot.classList.toggle('hidden', n === 0);
        dot.title = n ? `${n} result${n === 1 ? '' : 's'} need review` : '';
    }
    const gate = document.getElementById('gate-discrepancy-btn');
    if (gate) {
        const show = n > 0 && pref === 'full';
        gate.classList.toggle('hidden', !show);
        const count = document.getElementById('gate-discrepancy-count');
        if (count) count.textContent = String(n);
    }
}

async function refreshDiscrepancies() {
    const authToken = sessionStorage.getItem('adminAuthToken');
    if (!App.state.isSuperAdmin || !authToken) {
        App.data.discrepancies = [];
        updateDiscrepancyBadge();
        return;
    }
    try {
        const res = await getDiscrepancies(authToken);
        App.data.discrepancies = res.success ? res.items : [];
    } catch (e) {
        console.error('Discrepancy refresh failed:', e);
        return; // keep the last known list rather than flashing it empty
    }
    updateDiscrepancyBadge();
    if (App.state.currentView === 'admin-entry') renderAdminMatchEntryViewImpl();
}

/** Starts (once) the live refresh: socket nudges + a slow poll as a fallback. */
function startDiscrepancyWatch() {
    if (!App.state.isSuperAdmin) return;
    refreshDiscrepancies();
    if (discWatching) return;
    discWatching = true;
    try {
        const socket = getSocket();
        ['discrepancyUpdate', 'syncStatusUpdate'].forEach(evt => socket.on(evt, refreshDiscrepancies));
        socket.on('connect', refreshDiscrepancies);
    } catch (e) {
        console.warn('Discrepancy live updates unavailable, polling only:', e.message);
    }
    setInterval(() => { if (!document.hidden) refreshDiscrepancies(); }, DISC_POLL_MS);
}

async function dismissDiscrepancy(key) {
    const item = (App.data.discrepancies || []).find(d => d.key === key);
    const authToken = sessionStorage.getItem('adminAuthToken');
    if (!item || !authToken) return;
    try {
        const res = await dismissDiscrepancyApi(authToken, item.division, item.firebaseIndex, App.state.reporterName || '');
        if (res.success) App.data.discrepancies = res.items;
    } catch (e) {
        console.error('Dismiss failed:', e);
        showStatus(`Could not dismiss: ${e.message}`, true);
        setTimeout(() => showStatus(null), 6000);
        return;
    }
    updateDiscrepancyBadge();
    renderAdminMatchEntryViewImpl();
}

/** Makes the referee-reported result the official one (same path as the modal's "submit as official"). */
async function useReportedResult(key) {
    const g = (App.data.discrepancies || []).find(d => d.key === key);
    const authToken = sessionStorage.getItem('adminAuthToken');
    if (!g || !authToken) return;
    if (!confirm(`Set official result to the reported one (${g.adminWinner}, ${g.adminPlayersRemaining || 0} left, reported by ${g.adminName || 'referee'})?`)) return;
    try {
        const result = await apiSaveMatchResult(authToken, {
            sheetName: g.division,
            rowIndex: g.rowIndex,
            firebaseIndex: g.firebaseIndex,
            team1: g.team1,
            team2: g.team2,
            winner: g.adminWinner,
            playersRemaining: parseInt(g.adminPlayersRemaining) || 0,
            adminName: App.state.reporterName || g.adminName || 'Tournament manager',
            notes: `Official set from result reported by ${g.adminName || 'referee'}`,
            setOfficial: true
        });
        if (!result.success) throw new Error(result.error || 'Server reported failure.');
        await loadData(App.config.currentSheetName);
        await refreshDiscrepancies();
    } catch (e) {
        console.error('Use reported failed:', e);
        showStatus(`Could not update official result: ${e.message}`, true);
        setTimeout(() => showStatus(null), 6000);
    }
}

/** Edit opens the match modal for this division, or switches to the item's division first. */
async function reviewDiscrepancy(key) {
    const d = (App.data.discrepancies || []).find(x => x.key === key);
    if (!d) return;
    if (d.division !== App.config.currentSheetName) {
        await enterApp(d.division);
        switchView('admin-entry');
    }
    const idx = (App.data.allScheduleData || []).findIndex(g => sameIndex(g.firebaseIndex, d.firebaseIndex));
    if (idx >= 0) showMatchEntryModal(idx);
}

/** Gate shortcut: jump into the first division with something to review. */
async function openDiscrepancyReview() {
    const first = getOpenDiscrepancies()[0];
    if (!first) return;
    await enterApp(first.division);
    switchView('admin-entry');
}

/** "Needs review" card pinned above the match list (superadmin only). */
function renderDiscrepancyPanel(container) {
    const open = getOpenDiscrepancies();
    if (!open.length) return;
    const card = document.createElement('section');
    card.id = 'discrepancy-panel';
    card.className = 'rounded-[26px] border p-3.5';
    card.style.background = 'rgba(224,184,99,.07)';
    card.style.borderColor = 'rgba(224,184,99,.45)';
    const fmt = (w, n) => `${esc((w || '—').toString().trim() || '—')}${n !== undefined && n !== null && n !== '' ? ` · ${esc(String(n))} left` : ''}`;
    const btn = 'rounded-[13px] px-3 py-2 text-[11px] font-semibold leading-none';
    const ghost = 'background:rgba(255,255,255,.08);color:rgba(255,255,255,.85);border:1px solid rgba(255,255,255,.14)';
    card.innerHTML = `
        <div class="text-[11px] font-semibold tracking-[.08em]" style="color:var(--gold-l)">NEEDS REVIEW (${open.length})</div>
        <div class="mt-2 grid gap-[5px]">
            ${open.map(g => {
                const other = g.division !== App.config.currentSheetName;
                return `
                <div class="rounded-2xl px-3 py-2.5" style="background:rgba(255,255,255,.05)" data-disc-key="${escAttr(g.key)}">
                    <div class="text-[11px] font-semibold" style="color:rgba(255,255,255,.86)">${other ? `${esc(g.division)} · ` : ''}${esc(g.roundTime)} · C${esc(g.court || '?')} · ${esc(g.team1)} vs ${esc(g.team2)}</div>
                    <div class="mt-1 text-[11px]" style="color:var(--ok)">Official: ${fmt(g.winner, g.playersRemaining)}</div>
                    <div class="text-[11px]" style="color:var(--gold-l)">Reported by ${esc(g.adminName || '—')}: ${fmt(g.adminWinner, g.adminPlayersRemaining)}</div>
                    <div class="mt-2 flex flex-wrap gap-1.5">
                        <button data-act="use" class="${btn}" style="background:linear-gradient(135deg,var(--gold) 0%,var(--gold-d) 100%);color:#2A1B08;border:0">Use reported</button>
                        <button data-act="edit" class="${btn}" style="${ghost}">${other ? 'Open division' : 'Edit'}</button>
                        <button data-act="keep" class="${btn}" style="${ghost}">Keep official</button>
                    </div>
                </div>`;
            }).join('')}
        </div>
    `;
    container.appendChild(card);
}

/** A game counts as reported for admin purposes once it has an admin-submitted or official result. */
function isAdminReported(game) {
    const reportedByAdmin = !!(game.adminWinner && game.adminWinner.trim() !== '' && game.adminWinner.trim() !== 'TBA' && game.adminWinner.trim() !== '—');
    return isReportedOfficial(game) || reportedByAdmin;
}

// Core renderer (kept private) — we'll expose a debounced public wrapper below
function renderAdminMatchEntryViewImpl() {
    if (!App.state.isAdmin) {
        document.getElementById('admin-match-list').innerHTML = '<p class="py-4 text-center text-sm text-white/45">Please sign in to access match entry.</p>';
        return;
    }

    const teamSelect = document.getElementById('admin-team-select');
    const courtSelect = document.getElementById('admin-court-select');
    const subDivisionSelect = document.getElementById('admin-sub-division-select');
    const hidePlayedToggle = document.getElementById('hide-played-toggle');
    const matchListDiv = document.getElementById('admin-match-list');
    const filterInfoDiv = document.getElementById('admin-filter-info');

    const selectedTeam = teamSelect?.value || 'all';
    const selectedCourt = courtSelect?.value || 'all';
    const selectedSubDivision = subDivisionSelect?.value || 'all';
    const isHidingPlayed = hidePlayedToggle?.checked || false;

    if (!matchListDiv) return;

    if (App.state.isSuperAdmin && (!App.data.allScheduleData || App.data.allScheduleData.length === 0)) {
        renderEmptyScheduleSyncBanner(matchListDiv);
        if (filterInfoDiv) filterInfoDiv.classList.add('hidden');
        return;
    }

    // Diagnostic logging to help identify why nothing is rendering
    try {
        console.log('updateAdminMatchEntryView called', {
            isAdmin: App.state.isAdmin,
            isSuperAdmin: App.state.isSuperAdmin,
            totalMatches: Array.isArray(App.data.allScheduleData) ? App.data.allScheduleData.length : 0,
            selectedTeam,
            selectedCourt,
            isHidingPlayed,
        });
    } catch (e) {
        console.log('Diagnostic log failed:', e);
    }

    // 'Hide games already reported' hides a whole round only once every game
    // in it has an admin-submitted or official result — a round with even
    // one game still outstanding stays fully visible (all its courts), so
    // the tournament manager can see the whole round in play, not just the
    // one straggler game. Computed off the full, unfiltered schedule so a
    // team/court filter can't make a round look "done" prematurely.
    const roundsFullyReported = new Set();
    {
        const byRound = new Map();
        App.data.allScheduleData.forEach(game => {
            const key = game.roundTime || 'TBD';
            if (!byRound.has(key)) byRound.set(key, []);
            byRound.get(key).push(game);
        });
        byRound.forEach((games, key) => {
            if (games.every(isAdminReported)) roundsFullyReported.add(key);
        });
    }

    // 1. Filter and Sort logic (remains the same as your part 3)
    let filteredSchedule = App.data.allScheduleData.filter(game => {
        const teamMatch = selectedTeam === 'all' ||
            getFilterableTeamName(game.team1) === selectedTeam ||
            getFilterableTeamName(game.team2) === selectedTeam;

        const courtMatch = selectedCourt === 'all' || (game.court && game.court.trim() === selectedCourt);

        const subDivisionMatch = selectedSubDivision === 'all' || game.subDivision === selectedSubDivision;

        const playedMatch = !isHidingPlayed || !roundsFullyReported.has(game.roundTime || 'TBD');

        return teamMatch && courtMatch && subDivisionMatch && playedMatch;
    });

    filteredSchedule.sort((a, b) => {
        const timeA = parseRoundTime(a.roundTime);
        const timeB = parseRoundTime(b.roundTime);

        // Case 1: Both are times
        if (timeA.isTime && timeB.isTime) {
            // Directly compare the chronological sort values (e.g., "09:05")
            return timeA.sortValue.localeCompare(timeB.sortValue);
        }

        // Case 2: Time sorts before text (P rounds)
        if (timeA.isTime && !timeB.isTime) {
            return -1; // A (time) comes before B (text)
        }
        if (!timeA.isTime && timeB.isTime) {
            return 1; // A (text) comes after B (time)
        }

        // Case 3: Both are text (P rounds or other non-time text)
        // Alpha sort ascending
        return timeA.sortValue.localeCompare(timeB.sortValue);
    });

    const groupedMatches = filteredSchedule.reduce((acc, game) => {
        const round = game.roundTime || 'TBD/Unscheduled';
        if (!acc[round]) {
            acc[round] = [];
        }
        acc[round].push(game);
        return acc;
    }, {});

    matchListDiv.innerHTML = '';
    wireDiscrepancyActions(matchListDiv);
    renderDiscrepancyPanel(matchListDiv);
    updateDiscrepancyBadge();

    // ... (Filter Info rendering logic remains the same) ...

    // Title is generic for every admin tier — the court filter is a view
    // choice, so the court only appears in the identity line below.
    const titleEl = document.getElementById('admin-title');
    if (titleEl) titleEl.textContent = 'Tournament admin';
    const whoEl = document.getElementById('admin-who');
    if (whoEl) {
        const name = App.state.reporterName || 'Staff';
        whoEl.textContent = App.state.isSuperAdmin
            ? `${name} · tournament manager · all courts`
            : `${name} · court manager · court ${App.state.selectedCourt || '?'} · ${App.config.currentSheetName}`;
    }

    let infoText = `Showing <span class="text-gold-l">${esc(App.config.currentSheetName)}</span>`;
    if (selectedTeam !== 'all') infoText += ` · team <span class="text-gold-l">${esc(selectedTeam)}</span>`;
    if (selectedCourt !== 'all') infoText += ` · court <span class="text-gold-l">${esc(selectedCourt)}</span>`;
    if (isHidingPlayed) infoText += ` · <span class="text-gold-l">reported games hidden</span>`;

    filterInfoDiv.classList.remove('hidden');
    filterInfoDiv.innerHTML = infoText;

    // Admin's own "live round": unlike the public page (official results
    // only), a round stays "ON COURT NOW" here until every game in it has
    // *either* an admin-submitted or an official result — so the tournament
    // manager can see a court is done as soon as it's reported, without
    // waiting on the official sheet sync.
    const roundOrder = getRoundOrder();
    const liveKey = roundOrder.find(key =>
        App.data.allScheduleData.some(g => (g.roundTime || 'TBD') === key && !isAdminReported(g))
    );
    const liveIndex = liveKey === undefined ? roundOrder.length : roundOrder.indexOf(liveKey);

    // Bye footers (below) are only meaningful across the whole roster — with a
    // single team selected the round already holds just that team's game.
    const showByeFooter = selectedTeam === 'all';
    const allTeams = showByeFooter ? getRosterTeams() : null;

    const dim = 'rgba(255,255,255,.38)';
    const strong = 'rgba(255,255,255,.86)';

    const fragment = document.createDocumentFragment(); //for batching updates
    Object.entries(groupedMatches).forEach(([roundTime, games]) => {
        const isLiveRound = roundTime === liveKey;
        const isDone = roundOrder.indexOf(roundTime) < liveIndex;

        // Same dark round card the public games page uses: a gold border +
        // "ON COURT NOW" chip for the live round, flat glass otherwise.
        const card = document.createElement('section');
        card.className = 'rounded-[26px] border p-3.5';
        card.style.background = isLiveRound ? 'rgba(255,255,255,.075)' : 'rgba(255,255,255,.055)';
        card.style.borderColor = isLiveRound ? 'var(--gold)' : 'rgba(255,255,255,.1)';
        card.style.boxShadow = isLiveRound
            ? '0 0 0 1px rgba(224,184,99,.35), 0 14px 36px rgba(0,0,0,.26)'
            : '0 14px 36px rgba(0,0,0,.26)';

        const chipStyle = isLiveRound
            ? 'background:linear-gradient(135deg,var(--gold) 0%,var(--gold-d) 100%);color:#2A1B08'
            : 'background:rgba(255,255,255,.08);color:rgba(255,255,255,.7)';

        const head = document.createElement('div');
        head.className = 'flex items-center gap-2.5';
        head.innerHTML = `
            <span class="rounded-full px-2.5 py-1.5 text-[11px] font-semibold leading-none tracking-[.02em]" style="${chipStyle}">${esc(roundTime)}</span>
            <span class="text-[9px] font-semibold leading-none tracking-[.12em]" style="color:${isLiveRound ? 'var(--gold)' : 'rgba(255,255,255,.4)'}">${isLiveRound ? 'ON COURT NOW' : isDone ? 'FINAL' : 'UPCOMING'}</span>
        `;
        card.appendChild(head);

        const rows = document.createElement('div');
        rows.className = 'mt-2.5 grid gap-[5px]';

        games.forEach(game => {
            // Find the original index
            const gameIndex = App.data.allScheduleData.findIndex(g =>
                g.roundTime === game.roundTime && g.court === game.court && g.team1 === game.team1 && g.team2 === game.team2
            );

            const row = document.createElement('div');
            row.id = `game-entry-${gameIndex}`;
            row.className = 'rounded-2xl px-3 py-2.5';
            row.style.background = 'rgba(255,255,255,.05)';

            const disc = getDiscrepancyPref() === 'full' ? discrepancyFor(game) : null;
            const discChip = disc
                ? `<span data-disc-key="${escAttr(disc.key)}"><button data-act="edit" title="Reported result differs from official" class="rounded-full px-1.5 py-0.5" style="background:rgba(224,184,99,.18);color:var(--gold-l);border:1px solid rgba(224,184,99,.45)">≠ review</button></span>`
                : '';
            const officialIsCompleted = isReportedOfficial(game);
            const winnerName = game.winner ? game.winner.trim() : null;
            const reportedByAdmin = !!(game.adminWinner && game.adminWinner.trim() !== '' && game.adminWinner.trim() !== '—');
            const isReported = isAdminReported(game);

            // A live-round game still awaiting a result gets the same gold
            // inset outline as an in-progress game on the public games page.
            if (isLiveRound && !isReported) {
                row.style.boxShadow = 'inset 0 0 0 1px rgba(224,184,99,.55)';
            }

            // Winner checkbox: gold + checkmark while only the admin's own
            // report has it (game.winner not yet refreshed by the sheet
            // sync); green + checkmark + players-left count once official.
            const adminWinnerVal = game.adminWinner ? game.adminWinner.trim() : '';
            const tie = App.settings.is_tie_allowed && (officialIsCompleted ? winnerName === 'tie' : adminWinnerVal === 'tie');
            const team1Name = (game.team1 || '').trim();
            const team2Name = (game.team2 || '').trim();
            const team1Official = officialIsCompleted && !tie && winnerName === team1Name;
            const team2Official = officialIsCompleted && !tie && winnerName === team2Name;
            const team1AdminOnly = !officialIsCompleted && !tie && reportedByAdmin && adminWinnerVal === team1Name;
            const team2AdminOnly = !officialIsCompleted && !tie && reportedByAdmin && adminWinnerVal === team2Name;
            const count = officialIsCompleted ? game.playersRemaining : game.adminPlayersRemaining;

            // "Updated:" line replaces the old "Team won · N left · Name"
            // stamp — who reported it and when, unofficial while game.winner
            // hasn't caught up with the admin's own report yet.
            let updatedHtml = esc('');
            let updatedColor = '#E0B863';
            if (isReported) {
                const by = game.adminName || '—';
                const when = formatUpdatedTime(game.lastUpdated);
                const suffix = officialIsCompleted ? '' : '';
                // The "when" chunk carries the raw timestamp so the ticking
                // clock (below) can refresh just this text in place, without
                // a full re-render, while it's still showing a relative time.
                const whenHtml = when
                    ? ` · <span class="js-updated-when" data-last-updated="${esc(game.lastUpdated)}">${esc(when)}</span>`
                    : '';
                updatedHtml = `${esc(`Updated: ${by}`)}${whenHtml}${esc(suffix)}`;
                updatedColor = officialIsCompleted ? 'var(--ok)' : 'var(--gold-l)';
            }

            row.innerHTML = `
                <div class="flex items-center gap-2.5">
                    <span class="flex-none w-[26px] h-[26px] rounded-[9px] text-center text-[10px] font-bold leading-[26px]"
                          style="background:${isLiveRound ? 'rgba(224,184,99,.14)' : 'rgba(255,255,255,.08)'};color:${isLiveRound ? 'var(--gold-l)' : 'rgba(255,255,255,.6)'}">C${esc(game.court || '?')}</span>
                    <span class="flex-1 min-w-0 grid gap-[2px]">
                        ${adminTeamLine(game.team1, team1Official, team1AdminOnly, count, dim, strong)}
                        ${adminTeamLine(game.team2, team2Official, team2AdminOnly, count, dim, strong)}
                    </span>
                    <button onclick="showMatchEntryModal(${gameIndex})"
                            class="flex-none rounded-[13px] px-3 py-2 text-[11px] font-semibold leading-none"
                            style="${isReported ? 'background:rgba(255,255,255,.08);color:rgba(255,255,255,.85);border:1px solid rgba(255,255,255,.14)' : 'background:linear-gradient(135deg,var(--gold) 0%,var(--gold-d) 100%);color:#2A1B08;border:0'}">
                        ${isReported ? 'Edit' : 'Report'}
                    </button>
                </div>
                <div class="mt-1.5 flex items-center justify-between gap-2 pl-[34px]">
                    <span class="flex items-center gap-1.5 text-[9px] font-semibold leading-none tracking-[.08em]" style="color:${dim}">
                        ${game.match ? esc(`M${game.match}`) : ''}
                        ${game.subDivision ? `<span class="rounded-full px-1.5 py-0.5" style="background:rgba(255,255,255,.08);color:rgba(255,255,255,.6)">${esc(game.subDivision)}</span>` : ''}
                        ${discChip}
                    </span>
                    <span class="text-right text-[10px] font-medium leading-[1.3]" style="color:${updatedColor}">${updatedHtml}</span>
                </div>
            `;

            rows.appendChild(row);
        });

        card.appendChild(rows);

        // --- Teams sitting this round out, same as the public games page ---
        if (allTeams) {
            const byeTeams = getByeTeams(roundTime, allTeams);
            if (byeTeams.length) {
                const footer = document.createElement('div');
                footer.className = 'mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-2.5';
                footer.style.borderColor = 'rgba(255,255,255,.08)';
                footer.innerHTML = `
                    <span class="text-[9px] font-semibold leading-none tracking-[.12em]" style="color:rgba(255,255,255,.4)">ON BYE</span>
                    ${byeTeams.map(t => `
                        <span class="rounded-full px-2 py-1 text-[11px] font-medium leading-none" style="background:rgba(255,255,255,.06);color:rgba(255,255,255,.6)">${esc(t)}</span>
                    `).join('')}
                `;
                card.appendChild(footer);
            }
        }

        fragment.appendChild(card);
    });

    matchListDiv.appendChild(fragment);
}

/**
 * Shown on the Admin tab in place of the match list when a superadmin picks
 * a division that exists but has never been synced (or hasn't been synced
 * since its tab was added to the sheet). Reuses the exact same sync
 * mechanism as Settings → Sync Now (POST /api/sheetSync/run) so there's only
 * one sync code path — this is just a closer-at-hand trigger for it.
 */
function renderEmptyScheduleSyncBanner(container) {
    container.innerHTML = '';
    const banner = document.createElement('div');
    banner.className = 'rounded-2xl border p-4 text-center';
    banner.style.background = 'rgba(224,184,99,.07)';
    banner.style.borderColor = 'rgba(224,184,99,.4)';
    banner.innerHTML = `
        <p class="text-sm font-semibold" style="color:var(--gold-l)">No schedule data yet for ${esc(App.config.currentSheetName)}.</p>
        <p class="mt-1 text-xs text-white/50">Pull the latest standings and schedule from the Google Sheet to get started.</p>
    `;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mt-3 rounded-[13px] px-4 py-2 text-[12px] font-semibold leading-none';
    btn.style.background = 'linear-gradient(135deg,var(--gold) 0%,var(--gold-d) 100%)';
    btn.style.color = '#2A1B08';
    btn.textContent = '🔄 Sync from Google Sheet';
    btn.onclick = async () => {
        const authToken = sessionStorage.getItem('adminAuthToken');
        if (!authToken) return;
        btn.disabled = true;
        btn.textContent = 'Syncing…';
        try {
            const result = await runSheetSync(authToken);
            if (result.success) {
                showStatus(`Sync complete: ${result.divisions} divisions, ${result.matchesCount} matches.`, false);
                setTimeout(() => showStatus(null), 4000);
                await loadData(App.config.currentSheetName);
            } else {
                showStatus('Sync failed: ' + (result.error || 'Unknown error'), true);
                btn.disabled = false;
                btn.textContent = '🔄 Sync from Google Sheet';
            }
        } catch (e) {
            console.error('Inline sync failed', e);
            showStatus('Sync failed: ' + e.message, true);
            btn.disabled = false;
            btn.textContent = '🔄 Sync from Google Sheet';
        }
    };
    banner.appendChild(btn);
    container.appendChild(banner);
}

/**
 * One team line in the admin match list. A winning team gets a checkbox-style
 * badge: gold while only the admin's own report carries it (game.winner not
 * yet refreshed by the sheet sync), green with the players-remaining count
 * once that official result is in — otherwise the team name renders plain
 * against the dark row, same as the public games page.
 */
function adminTeamLine(name, official, adminOnly, count, dim, strong) {
    const label = esc(name || 'TBD');
    if (!official && !adminOnly) {
        return `<span class="min-w-0 truncate text-[13px] font-semibold leading-[1.4]" style="color:${strong}">${label}</span>`;
    }
    const bg = official ? 'var(--ok)' : 'var(--gold)';
    const fg = official ? '#fff' : '#2A1B08';
    const nameColor = official ? 'var(--ok)' : 'var(--gold-l)';
    return `
        <span class="flex items-center gap-1.5">
            <span class="min-w-0 truncate text-[13px] font-bold leading-[1.4]" style="color:${nameColor}">${label}</span>
            <span class="flex-none inline-flex items-center gap-1 rounded-full px-1.5 h-[15px] text-[9px] font-bold leading-[15px]" style="background:${bg};color:${fg}">✓ ${esc(count ?? 0)}</span>
        </span>
    `;
}

/**
 * "Updated" timestamp for a reported game: a relative "N min ago" while the
 * report is fresh (≤10 minutes old), otherwise the actual date/time it was
 * reported — so a stale "unofficial" result doesn't read as just-now.
 */
function formatUpdatedTime(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';

    const diffMin = Math.floor((Date.now() - then) / 60000);
    if (diffMin <= 0) return 'just now';
    if (diffMin <= 10) return `${diffMin} min ago`;

    return new Date(then).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
}

// While a report is under 5 minutes old its "Updated" stamp reads as a
// relative time ("2 min ago") that would otherwise go stale on screen until
// the next full render. Refresh just that text in place every 10s so a
// tournament manager watching the board sees it tick forward live.
if (typeof window !== 'undefined') {
    setInterval(() => {
        document.querySelectorAll('.js-updated-when[data-last-updated]').forEach(el => {
            const iso = el.dataset.lastUpdated;
            const then = new Date(iso).getTime();
            if (Number.isNaN(then)) return;
            if (Date.now() - then >= 5 * 60000) return; // 5+ min: leave the (now-static) relative/absolute text alone
            el.textContent = formatUpdatedTime(iso);
        });
    }, 10000);
}

/** Escapes a value for safe interpolation into a template-literal row. */
function esc(str) {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
}

// Simple debounce utility to coalesce rapid calls into a single render
function debounce(fn, wait = 50) {
    let timer = null;
    return function (...args) {
        // If a full data load is in progress, skip scheduling renders; the loader
        // will call `renderAdminMatchEntryNow()` once it's finished.
        if (App && App.refresh && App.refresh.isLoadingData) return;

        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            try { fn.apply(this, args); } catch (e) { console.error('Debounced render error', e); }
        }, wait);
    };
}

// Public debounced function exported/used throughout the app and referenced by inline handlers.
const updateAdminMatchEntryView = debounce(renderAdminMatchEntryViewImpl, 40);

// Immediate render helper to be called when we want to force a single render
// (for example after the initial load completes). This bypasses the debounce
// and is safe to call repeatedly.
function renderAdminMatchEntryNow() {
    try {
        renderAdminMatchEntryViewImpl();
    } catch (e) {
        console.error('Immediate render error', e);
    }
}

// Expose immediate renderer to global so other modules (main.js) can call it
if (typeof window !== 'undefined') window.renderAdminMatchEntryNow = renderAdminMatchEntryNow;


/** Points the gate's Admin Panel "Google Sheet" link at the configured spreadsheet (hidden if none). */
async function loadGateSheetLink() {
    const link = document.getElementById('gate-sheet-link');
    const authToken = sessionStorage.getItem('adminAuthToken');
    if (!link || !authToken) return;
    try {
        const cfg = await getSheetSyncConfig(authToken);
        if (cfg && cfg.spreadsheetUrl) {
            link.href = cfg.spreadsheetUrl;
            link.classList.remove('hidden');
        } else {
            link.classList.add('hidden');
        }
    } catch (e) {
        console.error('Failed to load sheet link', e);
    }
}

/**
 * Shows login state on the division gate (Admin login button vs. Log out +
 * "Signed in as …") and a small signed-in badge in the app header.
 */
function updateGateAdminUI(loggedIn) {
    const btn = document.getElementById('gate-admin-btn');
    const who = document.getElementById('gate-admin-who');
    const adminPanel = document.getElementById('gate-admin-panel');
    const badge = document.getElementById('header-staff-badge');
    const badgeName = document.getElementById('header-staff-name');
    const name = App.state.reporterName || 'Staff';
    const role = App.state.isSuperAdmin ? 'Tournament manager'
        : App.state.isAdmin ? `Court manager${App.state.selectedCourt ? ' · court ' + App.state.selectedCourt : ''}`
        : 'Parent';

    if (btn) {
        btn.textContent = loggedIn ? 'Log out' : 'Admin login';
        btn.onclick = loggedIn ? logoutAdmin : showAdminLoginModal;
    }
    const showPanel = !!(loggedIn && App.state.isSuperAdmin);
    if (adminPanel) adminPanel.classList.toggle('hidden', !showPanel);
    if (showPanel) loadGateSheetLink();
    if (who) {
        who.classList.toggle('hidden', !loggedIn);
        who.textContent = loggedIn ? `Signed in as ${name} · ${role}` : '';
    }
    if (badge) {
        badge.classList.toggle('hidden', !loggedIn);
        badge.classList.toggle('inline-flex', loggedIn);
        if (badgeName) badgeName.textContent = loggedIn ? name : '';
        badge.title = loggedIn ? `Signed in as ${name} · ${role}` : '';
    }
}

/**
 * Updates the visual state of the Admin button and conditional UI elements.
 */
function updateAdminUI() {
    const adminButton = document.getElementById('admin-button');
    const adminStatusText = document.getElementById('admin-status-text');
    const adminEntryTab = document.getElementById('admin-entry-tab');
    const adminControls = document.getElementById('admin-controls');
    const setupGear = document.getElementById('admin-setup-gear');
    const chatSetupGear = document.getElementById('chat-setup-gear');
    const chatTab = document.getElementById('chat-tab');
    const scheduleTab = document.getElementById('schedule-tab');

    if (!adminButton || !adminStatusText || !adminEntryTab) return;

    const loggedIn = App.state.isAdmin || App.state.isParent;

    updateGateAdminUI(loggedIn);
    if (App.state.isSuperAdmin && loggedIn) startDiscrepancyWatch(); else { App.data.discrepancies = []; updateDiscrepancyBadge(); }
    window.syncChatRole?.();

    if (loggedIn) {
        adminStatusText.textContent = 'Logout';
        adminButton.classList.remove('bg-gray-700', 'hover:bg-gray-600', 'text-accent');
        adminButton.classList.add('bg-gold', 'hover:bg-gold-d', 'text-white');
        adminButton.onclick = logoutAdmin;
        // Match entry stays referee/superadmin-only; parents only get chat.
        if (App.state.isAdmin) {
            adminEntryTab.classList.remove('hidden'); // Show Admin Tab
            // The Admin tab duplicates the Games/schedule view, so hide Games for admins/superadmins.
            if (scheduleTab) {
                scheduleTab.classList.add('hidden');
                if (App.state.currentView === 'schedule') switchView('admin-entry');
            }
        } else {
            adminEntryTab.classList.add('hidden');
            if (scheduleTab) scheduleTab.classList.remove('hidden');
        }
        if (chatTab) chatTab.classList.remove('hidden'); // Show Chat Tab (staff + parents)
        if (App.state.isSuperAdmin) {
            if (setupGear) setupGear.classList.remove('hidden');
            if (chatSetupGear) chatSetupGear.classList.remove('hidden');
        }
    } else {
        adminStatusText.textContent = 'Admin';
        adminButton.classList.remove('bg-gold', 'hover:bg-gold-d', 'text-white');
        adminButton.classList.add('bg-gray-700', 'hover:bg-gray-600', 'text-accent');
        adminButton.onclick = showAdminLoginModal;
        adminEntryTab.classList.add('hidden'); // Hide Admin Tab
        if (scheduleTab) scheduleTab.classList.remove('hidden'); // Restore Games Tab
        if (adminControls) adminControls.classList.add('hidden');
        if (setupGear) setupGear.classList.add('hidden');
        if (chatSetupGear) chatSetupGear.classList.add('hidden');
        if (chatTab) chatTab.classList.add('hidden');
        window.closeTimerOverlay?.();
    }
}

const SESSION_HEARTBEAT_INTERVAL_MS = 45000;

/**
 * Keeps the server's session record "online" for this login while the tab
 * is open — see /api/session/heartbeat and the Setup page's "Signed-in
 * users" module. Safe to call repeatedly; clears any previous interval.
 */
function startSessionHeartbeat() {
    stopSessionHeartbeat();
    const token = sessionStorage.getItem('adminAuthToken');
    const sessionId = sessionStorage.getItem('sessionId');
    if (!token || !sessionId) return;
    const beat = () => sendSessionHeartbeat(token, sessionId).catch(err => console.error('Session heartbeat failed:', err));
    beat();
    App.state.sessionHeartbeatInterval = setInterval(beat, SESSION_HEARTBEAT_INTERVAL_MS);

    // Mobile browsers throttle/suspend setInterval while a tab is
    // backgrounded (screen locked, app switched away) — the next tick can
    // land well past SESSION_HEARTBEAT_INTERVAL_MS after it resumes, during
    // which the presence dot reads stale/offline even though the person is
    // actively using the app again. Firing immediately on visibility regain
    // closes that gap.
    if (!App.state.sessionHeartbeatVisibilityListener) {
        App.state.sessionHeartbeatVisibilityListener = () => {
            if (document.visibilityState === 'visible' && App.state.sessionHeartbeatInterval) beat();
        };
        document.addEventListener('visibilitychange', App.state.sessionHeartbeatVisibilityListener);
    }
}

function stopSessionHeartbeat() {
    if (App.state.sessionHeartbeatInterval) {
        clearInterval(App.state.sessionHeartbeatInterval);
        App.state.sessionHeartbeatInterval = null;
    }
}

function showAdminLoginModal() {
    const modal = document.getElementById('admin-login-modal');
    const passwordInput = document.getElementById('admin-password-input');
    const nameInput = document.getElementById('admin-name-field');
    const message = document.getElementById('admin-login-message');

    // Show the modal
    modal.classList.remove('hidden');

    // Clear previous input and messages
    passwordInput.value = '';
    try {
        const saved = JSON.parse(localStorage.getItem('savedAdminPassword') || 'null');
        if (saved && saved.p && Date.now() - saved.t < 24 * 60 * 60 * 1000) passwordInput.value = saved.p;
        else if (saved) localStorage.removeItem('savedAdminPassword');
    } catch (e) { /* ignore */ }
    nameInput.value = localStorage.getItem('lastAdminName') || '';
    message.classList.add('hidden');

    renderLoginCourtPicker();

    // Returning user (name remembered): skip straight to the password field.
    setTimeout(() => (nameInput.value ? passwordInput : nameInput).focus(), 50);
}

/**
 * Renders the "Your Court" 4-up picker in the login modal. Only meaningful
 * for the court-manager role — ignored server-side/client-side if the
 * password turns out to belong to the tournament manager.
 */
function renderLoginCourtPicker() {
    const wrap = document.getElementById('login-court-picker');
    if (!wrap) return;
    wrap.innerHTML = '';

    if (!App.state.selectedCourt) App.state.selectedCourt = localStorage.getItem('lastAdminCourt') || '1';
    const selected = App.state.selectedCourt;
    ['1', '2', '3', '4'].forEach(court => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'C' + court;
        const isActive = court === selected;
        btn.setAttribute('aria-pressed', isActive);
        // Selected court is a solid maroon pill with white text; the rest stay flat/muted.
        btn.className = 'rounded-[14px] py-2.5 text-[13px] leading-none transition-colors ' +
            (isActive ? 'font-bold text-white shadow-[0_3px_10px_rgba(123,29,43,.45)] ring-2 ring-offset-1 ring-[#7B1D2B]'
                : 'font-semibold text-mute hover:bg-white/60');
        if (isActive) btn.style.background = 'linear-gradient(135deg,var(--mar-l) 0%,var(--mar) 100%)';
        btn.onclick = () => {
            App.state.selectedCourt = court;
            renderLoginCourtPicker();
        };
        wrap.appendChild(btn);
    });
}

function hideAdminLoginModal() {
    document.getElementById('admin-login-modal').classList.add('hidden');
}

async function loginAdmin() {
    const passwordInputEl = document.getElementById('admin-password-input');
    const nameInputEl = document.getElementById('admin-name-field');
    const loginMessage = document.getElementById('admin-login-message');
    const loginButton = document.getElementById('login-button');

    // Defensive checks: if the modal elements are missing, abort and log helpful info
    if (!passwordInputEl || !loginMessage || !loginButton) {
        console.error('loginAdmin: required DOM elements missing', {
            passwordInputEl: !!passwordInputEl,
            loginMessage: !!loginMessage,
            loginButton: !!loginButton
        });
        return;
    }

    const password = passwordInputEl.value;
    const reporterName = (nameInputEl?.value || '').trim();
    loginMessage.classList.add('hidden');

    if (!reporterName) {
        loginMessage.textContent = 'Your name is required.';
        loginMessage.classList.remove('hidden');
        return;
    }

    loginButton.disabled = true;
    loginButton.textContent = 'Verifying…';

    const sessionId = crypto.randomUUID();

    try {
        // Use the API helper which returns the validation result
        const result = await validateAdmin(password, reporterName, App.state.selectedCourt, sessionId);

        // One-day tournament: remember the password on this device (expires after 24h).
        if (result && (result.isParent || (result.isAdmin && !result.isSuperAdmin))) {
            // Superadmin password is never stored on the device.
            try { localStorage.setItem('savedAdminPassword', JSON.stringify({ p: password, t: Date.now() })); } catch (e) { /* storage unavailable */ }
        }

        if (result && result.isParent) {
            App.state.isParent = true;
            App.state.reporterName = reporterName;
            localStorage.setItem('lastAdminName', reporterName);
            sessionStorage.setItem('reporterName', reporterName);
            sessionStorage.setItem('isParent', 'true');
            sessionStorage.setItem('adminAuthToken', result.token);
            sessionStorage.setItem('sessionId', sessionId);
            startSessionHeartbeat();

            hideAdminLoginModal();
            updateAdminUI();
            switchView('chat');
            showStatus(`Signed in as ${reporterName} (Parent).`, false);
            setTimeout(() => showStatus(null), 3000);

        } else if (result && result.isAdmin) {
            App.state.isAdmin = true;
            App.state.reporterName = reporterName;
            localStorage.setItem('lastAdminName', reporterName);
            sessionStorage.setItem('reporterName', reporterName);
            if (App.state.selectedCourt) localStorage.setItem('lastAdminCourt', App.state.selectedCourt);

            //store this for persitstance
            sessionStorage.setItem('isAdmin', 'true');
            sessionStorage.setItem('isSuperAdmin', 'false');
            sessionStorage.setItem('isParent', 'false');
            sessionStorage.setItem('adminAuthToken', result.token);
            sessionStorage.setItem('sessionId', sessionId);
            startSessionHeartbeat();
            if (result.isSuperAdmin) {
                // Firebase custom-token sign-in is only meaningful (and only
                // returned by the server) when DATA_BACKEND=firebase — local
                // mode's superadmin auth relies solely on the SHA-256 authToken.
                if (result.firebaseToken && window.__DATA_BACKEND__ !== 'local') {
                    try {
                        await firebase.auth().signInWithCustomToken(result.firebaseToken);
                        console.log('Super admin signed in to Firebase successfully');
                    } catch (err) {
                        console.error('Firebase sign-in error:', err);
                    }
                    sessionStorage.setItem('firebaseToken', result.firebaseToken);
                }
                App.state.isSuperAdmin = true;
                sessionStorage.setItem('isSuperAdmin', 'true');
                // initialize/move timer overlay for superadmin (if present)
                if (typeof window.initTimerOverlay === 'function') window.initTimerOverlay();
                window.gtag?.('event', 'login', {
                    method: 'web', // or 'google', 'facebook', etc.
                    success: true,
                    user_id: 'superadmin' // optional, only if you have one
                });
            } else {
                // Court manager — the court picked in the login modal scopes
                // their Admin tab's results list (see admin-court-select
                // default in main.js's loadData()).
                const court = App.state.selectedCourt || '1';
                App.state.selectedCourt = court;
                sessionStorage.setItem('selectedCourt', court);
                window.gtag?.('event', 'login', {
                    method: 'web', // or 'google', 'facebook', etc.
                    success: true,
                    user_id: 'admin' // optional, only if you have one
                });
            }

            hideAdminLoginModal();
            updateAdminUI();

            if (App.state.isSuperAdmin && (!App.data.allDivisionNames || !App.data.allDivisionNames.length)) {
                // Bypass gate and redirect to settings
                App.state.screen = 'app';
                document.getElementById('gate-screen')?.classList.add('hidden');
                document.getElementById('app-screen')?.classList.remove('hidden');
                document.getElementById('bottom-tab-bar')?.classList.remove('hidden');
                switchView('settings');
                showStatus('Please configure and run Google Sheets sync to populate divisions.', false);
            } else {
                switchView('admin-entry'); // Go straight to admin view after login
                showStatus(`Signed in as ${reporterName}.`, false);
                setTimeout(() => showStatus(null), 3000);
            }

        } else {
            App.state.isAdmin = false;
            App.state.isParent = false;
            loginMessage.textContent = 'Invalid password.';
            sessionStorage.removeItem('adminAuthToken'); // Clear any old token
            try { localStorage.removeItem('savedAdminPassword'); } catch (e) { /* ignore */ }
            loginMessage.classList.remove('hidden');
            window.gtag?.('event', 'login_failed', {
                method: 'web',
                success: false
            });
        }

    } catch (error) {
        console.error("Admin Login Error:", error);
        loginMessage.textContent = 'An error occurred during login verification.';
        loginMessage.classList.remove('hidden');
    } finally {
        loginButton.disabled = false;
        loginButton.textContent = 'Sign in →';
    }
}

function logoutAdmin() {
    stopSessionHeartbeat();
    const token = sessionStorage.getItem('adminAuthToken');
    const sessionId = sessionStorage.getItem('sessionId');
    if (token && sessionId) {
        apiEndSession(token, sessionId).catch(err => console.error('Session logout failed:', err));
    }

    App.state.isAdmin = false;
    App.state.isSuperAdmin = false;
    App.state.isParent = false;
    App.state.reporterName = '';
    App.state.selectedCourt = '';
    //remove admin persistance
    sessionStorage.removeItem('isAdmin');
    sessionStorage.removeItem('isSuperAdmin');
    sessionStorage.removeItem('isParent');
    sessionStorage.removeItem('firebaseToken');
    sessionStorage.removeItem('reporterName');
    sessionStorage.removeItem('selectedCourt');
    sessionStorage.removeItem('adminAuthToken');
    sessionStorage.removeItem('sessionId');
    if (window.__DATA_BACKEND__ !== 'local') {
        firebase.auth().signOut();
    }
    // The timer controls live in the header-clock popover now; updateAdminUI()
    // closes it for non-superadmins.
    updateAdminUI();
    // If the user was in a staff-only tab, switch them out
    if (['admin-entry', 'settings', 'chat'].includes(App.state.currentView)) {
        switchView('standings');
    }
    showStatus('Logged out of Admin Mode.', false);
    setTimeout(() => showStatus(null), 3000);
}

// --- NEW: MODAL AND MATCH RESULT SAVING FUNCTIONS ---

/**
 * Populates and shows the match entry modal.
 * @param {number} gameIndex - The index of the game in the allScheduleData array.
 */
function showMatchEntryModal(gameIndex) {
    const modal = document.getElementById('match-entry-modal');
    const matchInfoDisplay = document.getElementById('match-info-display');
    const winnerSelect = document.getElementById('modal-winner-select');
    const playersInput = document.getElementById('modal-players-input');
    const notesTextarea = document.getElementById('modal-notes-textarea');
    const saveMessage = document.getElementById('modal-save-message');
    const adminNameInput = document.getElementById('admin-name-input');

    const game = App.data.allScheduleData[gameIndex];
    if (!game) return console.error('Game data not found for index:', gameIndex);

    App.admin.currentGameIndex = gameIndex;

    // Clear previous state and message
    saveMessage.classList.add('hidden');

    // 1. Populate Match Info Display
    matchInfoDisplay.textContent = `Court ${game.court || '—'} · ${game.roundTime} · ${App.config.currentSheetName}`;

    // 2. Set the current winner, then paint the tiles for it
    const currentWinner = (game.adminWinner && game.adminWinner.trim() !== 'TBA') ? game.adminWinner.trim() : '—';
    winnerSelect.value = currentWinner;
    renderWinnerTiles(game);

    playersInput.value = game.adminPlayersRemaining || 0;
    notesTextarea.value = game.notes || '';

    // Default to the name captured at login (falls back to the last name
    // typed anywhere, for sessions that predate the login name field).
    adminNameInput.value = App.state.reporterName || localStorage.getItem('lastAdminName') || '';

    // Read-only official result, for context while reporting.
    const officialEl = document.getElementById('modal-official-display');
    if (officialEl) {
        const officialWinner = (game.winner || '').trim();
        officialEl.textContent = officialWinner
            ? `${officialWinner}${officialWinner === 'tie' ? '' : ` · ${game.playersRemaining || 0} left`}`
            : 'Not official yet';
    }

    // Superadmin only: "also submit as official". Defaults to on when the
    // auto-update setting is on (their report then flows to official), off
    // otherwise (opt in per entry).
    const officialToggleWrap = document.getElementById('modal-official-toggle-wrap');
    if (officialToggleWrap) {
        officialToggleWrap.classList.toggle('hidden', !App.state.isSuperAdmin);
        document.getElementById('modal-official-toggle').checked = !!App.settings.autoUpdateOfficialResultsEnabled;
    }

    // 4. Show the modal
    modal.classList.remove('hidden');
}

/**
 * "Who won?" choice tiles (design §10). Replaces the old <select> — the value
 * still lives on the hidden #modal-winner-select input so the save path and
 * its validation are unchanged.
 */
function renderWinnerTiles(game) {
    const wrap = document.getElementById('modal-winner-tiles');
    const winnerSelect = document.getElementById('modal-winner-select');
    if (!wrap || !winnerSelect) return;

    const options = [game.team1, game.team2]
        .filter(t => t && t.trim() !== '')
        .map(t => ({ value: t, label: t }));

    if (App.settings.is_tie_allowed) {
        options.push({ value: 'tie', label: '🤝 Horn sounded even — tie' });
    }

    wrap.innerHTML = '';
    options.forEach(opt => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tile-dark';
        btn.textContent = opt.label;
        btn.dataset.selected = String(winnerSelect.value === opt.value);
        btn.onclick = () => {
            // Tapping the selected tile clears it, matching the old "—" option.
            winnerSelect.value = winnerSelect.value === opt.value ? '—' : opt.value;
            renderWinnerTiles(game);
        };
        wrap.appendChild(btn);
    });
}

function hideMatchEntryModal() {
    document.getElementById('match-entry-modal').classList.add('hidden');
    App.admin.currentGameIndex = null;
}

/**
 * Saves the match result using data from the modal.
 */
async function saveMatchResultFromModal() {
    if (App.admin.currentGameIndex === null) return console.error('No game selected for saving.');

    const game = App.data.allScheduleData[App.admin.currentGameIndex];
    const winnerSelect = document.getElementById('modal-winner-select');
    const playersInput = document.getElementById('modal-players-input');
    const notesTextarea = document.getElementById('modal-notes-textarea');
    const adminNameInput = document.getElementById('admin-name-input');
    const saveButton = document.getElementById('modal-save-button');
    const messageElement = document.getElementById('modal-save-message');

    const adminName = adminNameInput.value.trim();
    const winner = winnerSelect.value;
    const playersRemaining = parseInt(playersInput.value) || 0;
    const notes = notesTextarea.value.trim();


    // Validation
    if (!adminName) {
        messageElement.textContent = 'Admin Name is required.';
        messageElement.classList.remove('hidden');
        return;
    }
    if (winner === '—' && playersRemaining !== 0) {
        messageElement.textContent = 'Players Remaining must be 0 if no winner is selected.';
        messageElement.classList.remove('hidden');
        return;
    }

    const setOfficial = App.state.isSuperAdmin && !!document.getElementById('modal-official-toggle')?.checked;
    if (setOfficial && winner === '—' && !confirm('No winner selected — this will clear the official result. Continue?')) return;

    // Store admin name locally for session convenience
    localStorage.setItem('lastAdminName', adminName);

    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    messageElement.classList.add('hidden');
    messageElement.textContent = '';

    // --- 1. GET THE AUTH TOKEN ---
    const authToken = sessionStorage.getItem('adminAuthToken');
    //console.log(`AuthToken: ${authToken}`) ;

    if (!authToken) {
        messageElement.textContent = 'Authentication error - Please log in again.';
        messageElement.classList.remove('hidden');
        messageElement.style.color = 'var(--warn)';

        saveButton.disabled = false;
        saveButton.textContent = 'Submit result';
        return
    }

    // Prepare the data payload for the Apps Script
    const matchData = {
        sheetName: App.config.currentSheetName,
        // The row index in the spreadsheet for the Apps Script to find the game
        rowIndex: game.rowIndex,
        firebaseIndex: game.firebaseIndex,
        team1: game.team1,
        team2: game.team2,
        winner: winner === '—' ? '' : winner, // Clear winner if '—' is selected
        playersRemaining: playersRemaining,
        adminName: adminName, // NEW
        notes: notes, // NEW
        setOfficial // superadmin only; the server re-checks the token
    };

    const payload = {
        authToken: authToken,
        matchData: matchData
    };


    try {
        // Use the API helper to save match result
        // apiSaveMatchResult expects (authToken, matchData)
        const result = await apiSaveMatchResult(authToken, matchData);

        if (result.success) {
            messageElement.textContent = 'Result saved!';
            messageElement.classList.remove('hidden');
            messageElement.style.color = 'var(--ok)';

            // Best-effort sheet write failed: the result is saved in the app
            // but the sheet (system of record) didn't get it.
            if (result.sheetsMirror && !result.sheetsMirror.success && !result.sheetsMirror.skipped) {
                // The modal closes right after, so surface this in the page-level status bar.
                showStatus('Saved, but the Google Sheet update failed: ' + (result.sheetsMirror.error || 'unknown error') + ' — tell the tournament manager.', true);
                setTimeout(() => showStatus(null), 10000);
            }

            // Reload all data to refresh standings and schedule
            await loadData(App.config.currentSheetName);

            // Give user a moment to see the success message before closing
            setTimeout(hideMatchEntryModal, 500);

        } else {
            // Server responded but indicated failure
            const errMsg = result.error || 'Server reported failure.';
            messageElement.textContent = 'ERROR: ' + errMsg;
            messageElement.classList.remove('hidden');
            messageElement.style.color = 'var(--warn)';
            // If the server flagged logout, clear token and force re-login
            if (result.logout) {
                sessionStorage.removeItem('adminAuthToken');
                logoutAdmin();
            }
            throw new Error(errMsg);
        }
    } catch (error) {
        console.error('Save failed:', error);
        // If the error came from a failed HTTP response, inspect it
        if (error && error.status === 401) {
            // Authentication failed — ensure local token is cleared and force re-login
            sessionStorage.removeItem('adminAuthToken');
            logoutAdmin();
            messageElement.textContent = 'Session expired. Please log in again.';
        } else if (error && error.body && error.body.error) {
            messageElement.textContent = 'ERROR: ' + error.body.error;
        } else {
            messageElement.textContent = 'ERROR: ' + (error.message || 'Unknown error');
        }
        messageElement.classList.remove('hidden');
        messageElement.style.color = 'var(--warn)';
    } finally {
        saveButton.disabled = false;
        saveButton.textContent = 'Submit result';
    }
}


/* Increments or decrements the value in the "Players Remaining" input field, 
* respecting the min (0) and max (8) boundaries.
* @param {number} delta - The amount to change the value by (usually +1 or -1).
*/
function changePlayers(delta) {
    const inputField = document.getElementById('modal-players-input');

    // Ensure the element exists and the value is treated as a number
    if (!inputField) return;

    let currentValue = parseInt(inputField.value) || 0;
    const newValue = currentValue + delta;

    const minVal = parseInt(inputField.min) || 0;
    const maxVal = parseInt(inputField.max) || 8;

    // Boundary check
    if (newValue >= minVal && newValue <= maxVal) {
        inputField.value = newValue;
    } else if (newValue < minVal) {
        // Stop at the minimum value
        inputField.value = minVal;
    } else if (newValue > maxVal) {
        // Stop at the maximum value
        inputField.value = maxVal;
    }
}

function checkLoginStatus() {
    const isAdmin = sessionStorage.getItem('isAdmin');
    const isSuperAdmin = sessionStorage.getItem('isSuperAdmin');
    const isParent = sessionStorage.getItem('isParent');
    const firebaseToken = sessionStorage.getItem('firebaseToken');

    // Normalize stored strings to booleans for app state
    App.state.isSuperAdmin = (isSuperAdmin === 'true');
    if (firebaseToken) App.state.firebaseToken = firebaseToken;
    App.state.isAdmin = (isAdmin === 'true');
    App.state.isParent = (isParent === 'true');
    App.state.reporterName = sessionStorage.getItem('reporterName') || '';
    App.state.selectedCourt = sessionStorage.getItem('selectedCourt') || '';

    // Resume the heartbeat after a page reload so the session doesn't go
    // stale in the Setup page's "Signed-in users" view.
    if (App.state.isAdmin || App.state.isParent) startSessionHeartbeat();

    // The updateAdminUI() call below will handle showing the correct buttons.
}

Object.assign(window, { openDiscrepancyReview, setDiscrepancyPref });
window.getDiscrepancyPref = getDiscrepancyPref;

export {
    updateAdminMatchEntryView,
    updateAdminUI,
    showAdminLoginModal,
    hideAdminLoginModal,
    loginAdmin,
    logoutAdmin,
    showMatchEntryModal,
    hideMatchEntryModal,
    saveMatchResultFromModal,
    changePlayers,
    checkLoginStatus
};