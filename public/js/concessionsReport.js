// public/js/concessionsReport.js
// Report tab: day summary, sales by hour (stacked by category), and what is selling. Computed on the phone from
// the same local copy of the sales the Sell/History tabs use, so it works offline and costs the server nothing.
// A past season can be picked (online only); that fetch is not cached.
import * as Store from './concessionsStore.js';
import { esc, money, moneyShort, fmtDay, dayKey, card, goldStyle, kicker, chip, catColor } from './concessionsUi.js';

const R = { day: 'today', metric: 'usd', seasonId: null, past: null, loading: false, error: '' };

export function resetReport() { Object.assign(R, { day: 'today', metric: 'usd', seasonId: null, past: null, loading: false, error: '' }); }

const hourLabel = (h) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });

function currentSales() {
    const cur = Store.currentSeasonId();
    return R.seasonId && R.seasonId !== cur ? (R.past || []) : Store.sales();
}

function tallyBy(live, keyFn) {
    const m = new Map();
    live.forEach((s) => { const k = keyFn(s); const o = m.get(k) || { usd: 0, n: 0 }; o.usd += s.total; o.n += 1; m.set(k, o); });
    return m;
}

function bars(rows, fmt, max) {
    return `<div class="grid gap-1.5">${rows.map(([label, val, sub]) => `<div class="grid grid-cols-[88px_1fr_70px] items-center gap-2 text-[12px]">
      <span class="truncate text-white/65">${esc(label)}</span>
      <span class="h-5 overflow-hidden rounded-md bg-white/[.06]"><span class="block h-full rounded-md" style="width:${Math.max(val ? 2 : 0, Math.round(val / (max || 1) * 100))}%;background:linear-gradient(90deg,var(--gold-d),var(--gold))"></span></span>
      <span class="text-right font-semibold tabular-nums text-white">${fmt(val)}${sub ? `<span class="block text-[10px] font-medium text-white/40">${esc(sub)}</span>` : ''}</span></div>`).join('')}</div>`;
}

function html() {
    const c = Store.catalog();
    const cats = c ? c.settings.categories : [];
    const all = currentSales().filter((s) => !s.voided && !s.failed);
    const days = [...new Set(all.map((s) => dayKey(s.t)))].sort().reverse();
    const sel = R.day === 'all' ? null : R.day === 'today' ? dayKey(Date.now()) : R.day;
    const live = sel ? all.filter((s) => dayKey(s.t) === sel) : all;

    const seasons = c ? c.seasons : [];
    const seasonPick = seasons.length > 1 ? `<select data-f="r-season" class="field-dark mt-3" aria-label="Season">${seasons.map((s) => `<option value="${s.id}" ${(R.seasonId || Store.currentSeasonId()) === s.id ? 'selected' : ''}>Season ${esc(s.label)}${s.current ? ' (current)' : ''}</option>`).join('')}</select>` : '';
    const dayChips = `<div class="-mx-1 mt-3 flex gap-2 overflow-x-auto px-1 pb-1">${chip('Today', R.day === 'today', 'data-act="r-day" data-v="today"', '!px-3.5 !py-2.5 !text-[12px]')}${chip('Whole season', R.day === 'all', 'data-act="r-day" data-v="all"', '!px-3.5 !py-2.5 !text-[12px]')}${days.filter((d) => d !== dayKey(Date.now())).slice(0, 14).map((d) => { const [y, m, dd] = d.split('-').map(Number); return chip(esc(fmtDay(new Date(y, m - 1, dd))), R.day === d, `data-act="r-day" data-v="${d}"`, '!px-3.5 !py-2.5 !text-[12px]'); }).join('')}</div>`;
    const head = `${seasonPick}${dayChips}${R.loading ? '<div class="mt-2 text-[12px] text-white/45">Loading…</div>' : ''}${R.error ? `<div class="mt-2 text-[12px] text-red-300">${esc(R.error)}</div>` : ''}`;

    const kpi = (label, v) => `<div class="${card} px-3.5 py-3"><div class="text-[22px] font-bold leading-none tabular-nums text-white">${v}</div><div class="mt-1.5 text-[11px] font-semibold uppercase tracking-[.1em] text-white/45">${label}</div></div>`;
    if (!live.length) return `${head}<div class="mt-3.5 grid grid-cols-2 gap-2">${kpi('Revenue', '$0')}${kpi('Sales', '0')}</div><div class="py-10 text-center text-sm text-white/50">No sales for this selection yet.</div>`;

    const revenue = live.reduce((a, s) => a + s.total, 0);
    const units = live.reduce((a, s) => a + s.lines.reduce((x, l) => x + l.qty, 0), 0);
    const voided = currentSales().filter((s) => s.voided && (!sel || dayKey(s.t) === sel)).length;

    // Hours: every hour between first and last sale, so quiet stretches show.
    const byHour = new Map();   // key = day|hour → { cat → {usd, qty} }
    const multiDay = new Set(live.map((s) => dayKey(s.t))).size > 1;
    live.forEach((s) => {
        const d = new Date(s.t); d.setMinutes(0, 0, 0);
        const k = d.getTime();
        const o = byHour.get(k) || {};
        s.lines.forEach((l) => { const x = o[l.category] || { usd: 0, qty: 0 }; x.usd += l.price * l.qty; x.qty += l.qty; o[l.category] = x; });
        byHour.set(k, o);
    });
    const keys = [...byHour.keys()].sort((a, b) => a - b);
    const rows = [];
    if ((keys[keys.length - 1] - keys[0]) / 3600e3 < 30) for (let k = keys[0]; k <= keys[keys.length - 1]; k += 3600e3) rows.push([k, byHour.get(k) || {}]);
    else keys.forEach((k) => rows.push([k, byHour.get(k)]));
    const val = (x) => (R.metric === 'usd' ? x.usd : x.qty);
    const rowTotal = (o) => Object.values(o).reduce((a, x) => a + val(x), 0);
    const maxRow = Math.max(1, ...rows.map(([, o]) => rowTotal(o)));
    const fmt = (n) => (R.metric === 'usd' ? moneyShort(n) : String(n));
    const usedCats = [...new Set(live.flatMap((s) => s.lines.map((l) => l.category)))];
    const legend = usedCats.map((k) => `<span class="inline-flex items-center gap-1.5 text-[11px] text-white/65"><span class="h-2.5 w-2.5 rounded-full" style="background:${catColor(k, cats)}"></span>${esc(k)}</span>`).join('');
    const hourChart = `<div class="grid gap-1.5">${rows.map(([k, o]) => {
        const tot = rowTotal(o), d = new Date(k);
        const label = (multiDay ? d.toLocaleDateString([], { weekday: 'short' }) + ' ' : '') + hourLabel(d.getHours());
        const segs = usedCats.filter((cat) => o[cat]).map((cat) => `<span class="block h-full" style="width:${val(o[cat]) / maxRow * 100}%;background:${catColor(cat, cats)}" title="${esc(cat)}"></span>`).join('');
        return `<div class="grid grid-cols-[64px_1fr_56px] items-center gap-2 text-[12px]"><span class="text-white/65">${esc(label)}</span>
          <span class="flex h-5 overflow-hidden rounded-md bg-white/[.06]">${segs}</span><span class="text-right font-semibold tabular-nums text-white">${tot ? fmt(tot) : '—'}</span></div>`;
    }).join('')}</div>`;
    const peak = rows.reduce((b, r) => (rowTotal(r[1]) > rowTotal(b[1]) ? r : b), rows[0]);

    const byCat = [...tallyCats(live)].sort((a, b) => b[1].usd - a[1].usd);
    const byItem = [...tallyItems(live)].sort((a, b) => b[1].qty - a[1].qty);
    const byPay = [...tallyBy(live, (s) => (s.payment === 'venmo' ? 'Venmo' : 'Cash'))].sort((a, b) => b[1].usd - a[1].usd);
    const bySeller = [...tallyBy(live, (s) => s.seller || '—')].sort((a, b) => b[1].usd - a[1].usd);
    const section = (title, inner) => `<div class="${card} p-3.5">${kicker(title)}<div class="mt-3">${inner}</div></div>`;
    const mBtn = (v, l) => chip(l, R.metric === v, `data-act="r-metric" data-v="${v}"`, '!px-3.5 !py-2.5 !text-[12px]');

    return `${head}<div class="mt-3.5 grid grid-cols-2 gap-2">${kpi('Revenue', money(revenue))}${kpi('Sales', live.length)}${kpi('Avg sale', money(revenue / live.length))}${kpi('Items sold', units)}</div>
      <div class="mt-3 grid gap-3">
        ${section('Sales by hour', `<div class="mb-3 flex flex-wrap gap-2">${mBtn('usd', '$ Revenue')}${mBtn('qty', 'Items')}</div>${hourChart}
          <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">${legend}</div>
          <div class="mt-2 text-[11px] text-white/45">Busiest: ${esc((multiDay ? new Date(peak[0]).toLocaleDateString([], { weekday: 'short' }) + ' ' : '') + hourLabel(new Date(peak[0]).getHours()))} · ${fmt(rowTotal(peak[1]))}</div>`)}
        ${section('By category', bars(byCat.map(([k, o]) => [k, o.usd, `${o.qty} sold`]), money, Math.max(1, ...byCat.map((r) => r[1].usd))))}
        ${section('By item', bars(byItem.map(([k, o]) => [k, o.qty, money(o.usd)]), String, Math.max(1, ...byItem.map((r) => r[1].qty))))}
        ${section('By payment', bars(byPay.map(([k, o]) => [k, o.usd, `${o.n} sales`]), money, Math.max(1, ...byPay.map((r) => r[1].usd))))}
        ${section('By seller', bars(bySeller.map(([k, o]) => [k, o.usd, `${o.n} sales`]), money, Math.max(1, ...bySeller.map((r) => r[1].usd))))}
      </div>${voided ? `<div class="mt-3 text-center text-[11px] text-white/40">${voided} voided ${voided === 1 ? 'sale is' : 'sales are'} not counted.</div>` : ''}`;
}

function tallyCats(live) {
    const m = new Map();
    live.forEach((s) => s.lines.forEach((l) => { const o = m.get(l.category) || { usd: 0, qty: 0 }; o.usd += l.price * l.qty; o.qty += l.qty; m.set(l.category, o); }));
    return m;
}
function tallyItems(live) {
    const m = new Map();
    live.forEach((s) => s.lines.forEach((l) => { const o = m.get(l.name) || { usd: 0, qty: 0 }; o.usd += l.price * l.qty; o.qty += l.qty; m.set(l.name, o); }));
    return m;
}

let pane = null;
export function renderReport(el, quiet) {
    if (!el) return;
    if (el !== pane) {
        pane = el;
        el.addEventListener('click', (e) => {
            const b = e.target.closest('[data-act^="r-"]'); if (!b) return;
            const act = b.getAttribute('data-act'), v = b.getAttribute('data-v');
            if (act === 'r-day') R.day = v;
            else if (act === 'r-metric') R.metric = v;
            el.innerHTML = html();
        });
        el.addEventListener('change', async (e) => {
            if (e.target.getAttribute('data-f') !== 'r-season') return;
            const id = Number(e.target.value);
            R.seasonId = id; R.day = 'all'; R.error = '';
            if (id !== Store.currentSeasonId()) {
                R.loading = true; R.past = null; el.innerHTML = html();
                try { R.past = await Store.fetchSeasonSales(id); } catch (err) { R.error = err.status === 0 ? 'Past seasons need a connection.' : err.message; R.seasonId = null; }
                R.loading = false;
            }
            el.innerHTML = html();
        });
    }
    if (quiet && R.loading) return;
    el.innerHTML = html();
}
