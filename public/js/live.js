// public/js/live.js
// Renders the fan-facing LIVE tab: a round-status hero card, current round's
// games grouped by court, and a top-3 standings teaser. Reuses data already
// loaded by loadData()/the division listener — no new data source, just a
// different view of App.data.allScheduleData / App.data.allStandingsData.
import { parseRoundTime } from './schedule.js';

function currentRoundLabel() {
  const el = document.getElementById('current-round-display');
  return el ? el.textContent.trim() : '';
}

function isTimerRunning() {
  const stopBtn = document.getElementById('stop-btn');
  return !!stopBtn && getComputedStyle(stopBtn).display !== 'none';
}

/** Chronologically sorted list of every distinct round in the schedule (timed rounds first, then playoff rounds). */
function allRoundsSorted() {
  const rounds = [...new Set((App.data.allScheduleData || []).map(g => g.roundTime).filter(Boolean))];
  return rounds.sort((a, b) => {
    const sa = parseRoundTime(a), sb = parseRoundTime(b);
    if (sa.isTime === sb.isTime) return sa.sortValue.localeCompare(sb.sortValue);
    return sa.isTime ? -1 : 1;
  });
}

function renderLiveView() {
  const heroTime = document.getElementById('live-round-time');
  const grid = document.getElementById('live-courts-grid');
  if (!heroTime || !grid) return;

  const round = currentRoundLabel();
  const rounds = allRoundsSorted();
  const roundIndex = rounds.indexOf(round);

  const gamesThisRound = (App.data.allScheduleData || []).filter(g => g.roundTime === round);
  const courts = [...new Set(gamesThisRound.map(g => g.court).filter(Boolean))];
  const reported = gamesThisRound.filter(g => g.winner && g.winner.trim() !== '' && g.winner.trim() !== 'TBA' && g.winner.trim() !== '—');
  const running = isTimerRunning();

  document.getElementById('live-round-label').textContent = roundIndex >= 0
    ? `ROUND ${roundIndex + 1} OF ${rounds.length} · ${App.config.currentSheetName || ''}`
    : (App.config.currentSheetName || '');
  heroTime.textContent = round || '—';
  document.getElementById('live-round-sub').textContent = gamesThisRound.length
    ? `${gamesThisRound.length} game${gamesThisRound.length === 1 ? '' : 's'} on ${courts.length} court${courts.length === 1 ? '' : 's'}`
    : '';

  const statusDot = document.getElementById('live-status-dot');
  const statusText = document.getElementById('live-status-text');
  statusDot.style.background = running ? 'var(--ok)' : '#B8873A';
  statusDot.style.animation = running ? 'glowpulse 1.6s infinite' : 'none';
  statusText.textContent = running ? 'Round running' : 'Awaiting start';

  const pct = gamesThisRound.length ? Math.round((reported.length / gamesThisRound.length) * 100) : 0;
  document.getElementById('live-reported-bar').style.width = pct + '%';
  document.getElementById('live-reported-label').textContent = `${reported.length}/${gamesThisRound.length} REPORTED`;

  const byCourt = new Map();
  gamesThisRound.forEach(g => {
    const court = g.court || '—';
    if (!byCourt.has(court)) byCourt.set(court, []);
    byCourt.get(court).push(g);
  });

  if (!byCourt.size) {
    grid.innerHTML = '<p class="text-sm text-gray-500 col-span-full text-center py-4">No games scheduled for the current round.</p>';
  } else {
    grid.innerHTML = Array.from(byCourt.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([court, games]) => {
      const rows = games.map(g => {
        const isCompleted = g.winner && g.winner.trim() !== '' && g.winner.trim() !== 'TBA' && g.winner.trim() !== '—';
        const win1 = isCompleted && g.winner.trim() === (g.team1 || '').trim();
        const win2 = isCompleted && g.winner.trim() === (g.team2 || '').trim();
        const rowStyle = (won) => won ? 'background:rgba(224,184,99,.2)' : 'background:#F5F5F6';
        const nameStyle = (dim) => dim ? 'color:#A6A6AA' : 'color:var(--ink)';
        return `
        <div class="flex items-center gap-2 px-2.5 py-2 rounded-2xl" style="${rowStyle(win1)}">
          <span class="flex-1 min-w-0 font-semibold text-sm truncate" style="${nameStyle(isCompleted && !win1)}">${escapeHtml(g.team1 || 'TBD')}</span>
          ${win1 ? '<span class="text-[9px] font-semibold tracking-[.08em] text-mar-l flex-none">WON</span>' : ''}
        </div>
        <div class="flex items-center gap-2 px-2.5 py-2 rounded-2xl -mt-1.5" style="${rowStyle(win2)}">
          <span class="flex-1 min-w-0 font-semibold text-sm truncate" style="${nameStyle(isCompleted && !win2)}">${escapeHtml(g.team2 || 'TBD')}</span>
          ${win2 ? '<span class="text-[9px] font-semibold tracking-[.08em] text-mar-l flex-none">WON</span>' : ''}
        </div>`;
      }).join('');
      const courtDone = games.every(g => g.winner && g.winner.trim() !== '' && g.winner.trim() !== 'TBA' && g.winner.trim() !== '—');
      return `<div class="card-light overflow-hidden">
        <div class="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
          <span class="font-bold text-sm text-ink">Court ${escapeHtml(court)}</span>
          <span class="text-[9px] font-semibold tracking-[.1em] px-2 py-1 rounded-full" style="${courtDone ? 'background:rgba(46,158,99,.12);color:var(--ok)' : 'background:rgba(224,184,99,.18);color:#B8873A'}">${courtDone ? 'FINAL' : 'AWAITING'}</span>
        </div>
        <div class="px-2 pb-2.5 grid gap-1.5">${rows}</div>
      </div>`;
    }).join('');
  }

  const top3 = document.getElementById('live-top3');
  const sorted = (App.data.allStandingsData || []).slice(0, 3);
  if (!sorted.length) {
    top3.innerHTML = '<p class="text-sm text-white/40">No standings yet.</p>';
  } else {
    top3.innerHTML = sorted.map((t, i) => `
      <div class="flex items-center gap-2.5 px-3 py-2.5 rounded-2xl bg-white/[.06]">
        <span class="w-6 h-6 rounded-lg text-center text-xs font-bold flex-none flex items-center justify-center" style="background:linear-gradient(140deg,var(--gold) 0%,var(--gold-d) 100%);color:#2A1B08">${i + 1}</span>
        <span class="flex-1 min-w-0 truncate font-semibold text-sm text-gray-50">${escapeHtml(t.team || '')}</span>
        <span class="text-xs text-white/45 flex-none">${escapeHtml(t.record || '')}</span>
        <span class="font-bold text-sm text-gold-l flex-none">${t.points || 0}</span>
      </div>
    `).join('');
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

export { renderLiveView };
