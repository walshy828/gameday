// public/js/concessionsUi.js
// Small formatting/markup helpers shared by the concessions screens (sell/history, report, items).

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const moneyShort = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
export const cents = (n) => Math.round(Number(n) * 100);

export const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const fmtDay = (t) => new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
export const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export const card = 'rounded-2xl border border-white/10 bg-white/[.05]';
export const pillBtn = 'flex-none rounded-full border border-white/20 bg-white/[.06] px-3.5 py-2.5 text-[11px] font-semibold leading-none text-white/75';
export const goldStyle = 'background:linear-gradient(135deg,var(--gold) 0%,var(--gold-d) 100%);color:#2A1B08';
export const kicker = (t) => `<div class="text-[10px] tracking-[.16em] font-semibold text-white/50 uppercase">${esc(t)}</div>`;

export function chip(label, on, attrs, extra) {
    return `<button type="button" ${attrs} class="flex-none rounded-full border px-4 py-3 text-[13px] font-semibold leading-none ${on ? 'border-transparent' : 'border-white/15 bg-white/[.06] text-white/80'} ${extra || ''}" style="${on ? goldStyle : ''}">${label}</button>`;
}

export function toast(msg, bad, action) {
    document.querySelectorAll('[data-cn-toast]').forEach((x) => x.remove());
    const t = document.createElement('div');
    t.setAttribute('data-cn-toast', '');
    t.className = 'rounded-full px-4 py-2.5 text-[13px] font-semibold text-white shadow-lg';
    t.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(180px + env(safe-area-inset-bottom,0px));z-index:120;display:flex;align-items:center;gap:12px;white-space:nowrap;max-width:92vw;';
    t.style.background = bad ? 'var(--mar)' : '#2b2b2e';
    t.append(msg);
    if (action) {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = action.label;
        b.className = 'font-bold underline';
        b.style.color = 'var(--gold)';
        b.onclick = () => { t.remove(); action.run(); };
        t.appendChild(b);
    }
    document.body.appendChild(t);
    setTimeout(() => t.remove(), action ? 6000 : 3200);
}

// Category colors for charts and badges: fixed for the usual ones, a cycle for any the manager adds.
const CAT_COLORS = { Pizza: '#f97316', Drinks: '#38bdf8', Candy: '#ec4899', Other: '#a3a3a3' };
const SPARE = ['#a78bfa', '#34d399', '#fbbf24', '#f87171', '#60a5fa'];
export function catColor(name, all) {
    if (CAT_COLORS[name]) return CAT_COLORS[name];
    const extra = (all || []).filter((c) => !CAT_COLORS[c]);
    return SPARE[Math.max(0, extra.indexOf(name)) % SPARE.length];
}

/** Venmo payment link for the amount. audience=private asks Venmo to default the post to private; the note never lists items. */
export function venmoUrl(user, total, note) {
    const u = encodeURIComponent(String(user || '').replace(/^@/, ''));
    return `https://venmo.com/${u}?txn=pay&amount=${(cents(total) / 100).toFixed(2)}&note=${encodeURIComponent(note || 'Concessions').replace(/%20/g, '+')}&audience=private`;
}

/** SVG QR for a URL, drawn locally by the vendored generator (works with no network). */
export function qrSvg(url) {
    try {
        const qr = window.qrcode(0, 'M');
        qr.addData(url);
        qr.make();
        const svg = qr.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
        return svg.replace('<svg ', '<svg class="h-full w-full" role="img" aria-label="Venmo payment QR code" ');
    } catch (e) {
        return '<div class="p-4 text-center text-sm text-black">QR code unavailable</div>';
    }
}

export const qrBox = (url, size = 260) => `<div class="mx-auto rounded-2xl bg-white p-3" style="width:${size}px;height:${size}px">${qrSvg(url)}</div>`;
