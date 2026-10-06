// public/js/gameManagerUI.js
// Game Management view (superadmin): renders gameManager.js's assessment of
// the viewed division against the live round clock.
import { assess, formatClockMinutes } from './gameManager.js';
import { getTimerSnapshot } from './timerSnapshot.js';

const REFRESH_MS = 15000;
const ALLOWANCES = [0, 5, 10, 15, 30];

const STATUS = {
    'ahead':         { label: 'Ahead of schedule', color: '#2E9E63' },
    'on-track':      { label: 'On track',          color: '#2E9E63' },
    'behind':        { label: 'Behind',            color: '#E0B863' },
    'really-behind': { label: 'Really behind',     color: '#D9503C' },
    'unknown':       { label: 'No pace estimate',  color: '#9CA3AF' }
};

let allowanceMin = 0;
let refreshTimer = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = (ms) => { const d = new Date(ms); return formatClockMinutes(d.getHours() * 60 + d.getMinutes()); };
const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
const mins = (m) => `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
const fmtVal = (unit, v) => (unit === 'sec' ? mmss(v) : mins(v));

function card(inner) {
    return `<section class="card-dark p-4">${inner}</section>`;
}
const kicker = (t) => `<div class="text-[10px] tracking-[.16em] font-semibold text-white/50 uppercase">${esc(t)}</div>`;
const row = (k, v) => `<div class="flex items-baseline justify-between gap-3 text-sm"><span class="text-white/55">${esc(k)}</span><span class="font-semibold text-white tabular-nums text-right">${v}</span></div>`;

function paceText(a) {
    const d = a.deltaMin;
    if (d == null) return 'Planned times for the next round are missing from the sheet.';
    const abs = Math.round(Math.abs(d));
    if (abs < 1) return `The next round is projected to start right on time.`;
    return `The next round is projected to start ${abs} min ${d < 0 ? 'early' : 'late'}.`;
}

function leverLine(l) {
    const names = {
        gap: 'Between-round break', game: 'Pool game length',
        playoff: 'Playoff game length', intro: 'Playoff intro'
    };
    const verb = l.to < l.from ? 'Cut' : 'Keep';
    const tail = l.enough ? '' : ' <span class="text-white/45">(not enough on its own)</span>';
    return `<li>${verb} <b>${names[l.key]}</b> from ${fmtVal(l.unit, l.from)} to <b>${fmtVal(l.unit, l.to)}</b>${tail}</li>`;
}

function recommendations(a) {
    const deadline = clock(a.deadlineMs);
    const allowance = a.allowanceMin ? ` (+${a.allowanceMin} min allowance)` : '';
    if (a.fits) {
        const slack = Math.round((a.deadlineMs + a.allowanceMin * 60000 - a.projectedEndMs) / 60000);
        return `<p class="text-sm text-white/85">✓ At the current pace everything finishes by <b>${clock(a.projectedEndMs)}</b>, `
            + `${slack} min inside the ${deadline} end${allowance}. No changes needed.</p>`;
    }
    const lines = [`<p class="text-sm text-white/85">At the current pace play ends at <b>${clock(a.projectedEndMs)}</b>, `
        + `<b>${Math.ceil(a.overrunMin)} min</b> past the ${deadline} end${allowance}.</p>`];

    const single = a.levers.filter(l => l.enough);
    if (single.length) {
        lines.push(kicker('Any one of these gets you there'));
        lines.push(`<ul class="list-disc pl-5 space-y-1 text-sm text-white/85">${single.map(leverLine).join('')}</ul>`);
    }
    const c = a.combined;
    if (c && c.steps.length && (!single.length || c.steps.length > 1)) {
        lines.push(kicker(c.fits ? 'Or combine' : 'Best you can do with those'));
        lines.push(`<ul class="list-disc pl-5 space-y-1 text-sm text-white/85">${c.steps.map(leverLine).join('')}</ul>`);
        if (!c.fits) {
            lines.push(`<p class="text-sm" style="color:#F3DCA9">Even with all of that you'd finish about ${c.lateByMin} min late (${clock(c.end)}).</p>`);
        }
    }
    if (!single.length && !(c && c.steps.length)) {
        lines.push(`<p class="text-sm text-white/70">The time can't be recovered by shortening games or breaks (they're already at their minimums).</p>`);
    }
    lines.push(`<p class="text-xs text-white/50">Or finish late: at this pace you'd need <b>+${a.lateNeededMin} min</b> past ${deadline}. Playoff rounds are never dropped.</p>`);
    return lines.join('');
}

export function setGameManagerAllowance(min) {
    allowanceMin = Number(min) || 0;
    renderGameManager();
}

export function renderGameManager() {
    const body = document.getElementById('game-manager-body');
    if (!body) return;
    ensureRefresh();

    const division = App.config.currentSheetName;
    if (!division || App.data.scheduleDivision !== division) {
        body.innerHTML = card('<p class="text-sm text-white/55">Loading division…</p>');
        return;
    }

    const snap = getTimerSnapshot(division);
    const a = assess({
        cfg: App.data.scheduleConfig,
        schedule: App.data.allScheduleData,
        timer: snap?.state,
        nowMs: snap?.nowMs ?? Date.now(),
        allowanceMin
    });

    const header = `<div class="px-1 text-[11px] text-white/45">Division: <b class="text-white/70">${esc(division)}</b> · change it with the chip at the top</div>`;

    if (!a.ok) {
        const msg = {
            'no-config': 'This division\'s sheet has no schedule config block (GONK_SHEET_CONFIG), so there are no planned times to compare against. Run a sheet sync after updating the schedule template.',
            'no-rounds': 'This division has no scheduled rounds yet.',
            'no-end-time': 'The sheet config has no usable <code>division_end</code> time.'
        }[a.reason];
        body.innerHTML = header + card(`<p class="text-sm text-white/70">${msg}</p>`);
        return;
    }

    const st = STATUS[a.status];
    const banner = card(`
        ${kicker('Pace')}
        <div class="mt-1 text-2xl font-bold" style="color:${st.color}">${st.label}</div>
        <p class="mt-1 text-sm text-white/70">${paceText(a)}</p>
        ${a.nextRound ? `<p class="mt-1 text-xs text-white/50">Next up: ${esc(a.nextRound)}</p>` : '<p class="mt-1 text-xs text-white/50">All rounds have started.</p>'}
        ${snap ? '' : '<p class="mt-2 text-xs" style="color:#F3DCA9">Round clock not loaded yet — assuming the first round hasn\'t started.</p>'}`);

    const p = a.plan;
    const timeline = card(`
        ${kicker('Timeline')}
        <div class="mt-2 grid gap-1.5">
            ${row('Must finish by', clock(a.deadlineMs))}
            ${row('Projected finish', `<span style="color:${a.fits ? '#2E9E63' : '#D9503C'}">${clock(a.projectedEndMs)}</span>`)}
            ${a.playoffLeft > 0 || p.hasPlayoffs ? row('Pool play ends', clock(a.projectedPoolEndMs)) : ''}
            ${row('Rounds left', `${a.poolLeft} pool${p.hasPlayoffs ? ` + ${a.playoffLeft} playoff` : ''}`)}
            ${row('Pace', `${mmss(a.current.gameSec)} game + ${mmss(a.current.gapSec)} break${p.hasPlayoffs ? ` · ${a.current.playoffMin} min playoffs` : ''}`)}
        </div>
        ${a.sheetOverbooked ? `<p class="mt-2 text-xs" style="color:#F3DCA9">Heads up: the sheet's own playoff end (${formatClockMinutes(a.plannedPlayoffEndMin)}) is after the division end, so the plan is overbooked even if everything runs on time.</p>` : ''}`);

    const chips = ALLOWANCES.map(m => {
        const on = m === allowanceMin;
        return `<button type="button" onclick="setGameManagerAllowance(${m})" class="rounded-full border px-3 py-1.5 text-xs font-semibold"
            style="${on ? 'background:var(--gold);color:#2A1B08;border-color:var(--gold)' : 'border-color:rgba(255,255,255,.2);color:rgba(255,255,255,.75)'}">${m ? '+' + m : 'On time'}</button>`;
    }).join('');
    const allowance = card(`
        ${kicker('If we run late…')}
        <p class="mt-1 text-xs text-white/50">Allow the day to finish this many minutes past ${clock(a.deadlineMs)}:</p>
        <div class="mt-2 flex flex-wrap gap-2">${chips}</div>`);

    const recs = card(`${kicker('Recommendations')}<div class="mt-2 grid gap-2">${recommendations(a)}</div>`);

    body.innerHTML = header + banner + timeline + allowance + recs;
}

// Re-render while the view is open: the projection moves with the wall clock.
function ensureRefresh() {
    if (refreshTimer) return;
    const tick = () => {
        if (App.state.currentView === 'game-manager') renderGameManager();
    };
    refreshTimer = setInterval(tick, REFRESH_MS);
    window.addEventListener('timersnapshot', tick);
}
