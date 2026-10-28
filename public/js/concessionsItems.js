// public/js/concessionsItems.js
// Items tab (concessions staff + superadmin): edit the item list, prices, order and categories, plus the Venmo
// username and payment note. This needs a connection (it changes the shared catalog); selling never does.
// Edits are held in a local draft and saved together, so a half-edited price is never live on other phones.
import * as Store from './concessionsStore.js';
import { saveConcessionItems, saveConcessionSettings } from './api.js';
import { esc, card, goldStyle, kicker, toast, catColor, venmoUrl, qrBox } from './concessionsUi.js';

const E = { draft: null, settings: null, dirty: false, busy: false, err: '', newCat: '', preview: false };

export function resetItems() { Object.assign(E, { draft: null, settings: null, dirty: false, busy: false, err: '', newCat: '', preview: false }); }

function ensureDraft() {
    const c = Store.catalog();
    if (!c) return false;
    if (!E.draft) { E.draft = c.items.map((i) => ({ ...i })); E.dirty = false; }
    if (!E.settings) E.settings = { venmoUser: c.settings.venmoUser, venmoNote: c.settings.venmoNote };
    return true;
}

const input = 'field-dark';
const small = 'flex h-11 w-11 flex-none items-center justify-center rounded-xl border border-white/15 bg-white/[.06] text-[16px] font-bold text-white/80 disabled:opacity-30';

function html() {
    const c = Store.catalog();
    if (!ensureDraft()) return `<div class="${card} mt-4 px-4 py-4 text-[14px] text-white/80">Connect once to load the item list.</div>`;
    const cats = c.settings.categories;
    const rows = E.draft.map((it, i) => `<div class="${card} grid gap-2 p-3 ${it.active ? '' : 'opacity-60'}">
        <div class="flex items-center gap-2">
          <input data-i="${i}" data-k="name" type="text" value="${esc(it.name)}" placeholder="Item name" class="${input} min-w-0 flex-1" aria-label="Item name">
          <div class="relative w-[92px] flex-none"><span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/50">$</span>
            <input data-i="${i}" data-k="price" type="number" inputmode="decimal" min="0" step="0.25" value="${esc(it.price)}" class="${input} !pl-6" aria-label="Price"></div></div>
        <div class="flex items-center gap-2">
          <select data-i="${i}" data-k="category" class="${input} min-w-0 flex-1" aria-label="Category">${[...new Set([...cats, it.category])].map((cat) => `<option ${cat === it.category ? 'selected' : ''}>${esc(cat)}</option>`).join('')}</select>
          <button data-act="i-up" data-v="${i}" class="${small}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
          <button data-act="i-down" data-v="${i}" class="${small}" ${i === E.draft.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
          <button data-act="i-toggle" data-v="${i}" class="h-11 flex-none rounded-xl border border-white/15 bg-white/[.06] px-3 text-[12px] font-semibold text-white/75">${it.active ? 'Hide' : 'Show'}</button></div></div>`).join('');

    const catChips = cats.map((cat) => `<span class="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/[.06] px-3 py-2 text-[12px] font-semibold text-white/80"><span class="h-2.5 w-2.5 rounded-full" style="background:${catColor(cat, cats)}"></span>${esc(cat)}</span>`).join('');
    const st = E.settings;
    const previewUrl = st.venmoUser ? venmoUrl(st.venmoUser, 1, st.venmoNote) : '';

    return `<div class="mt-3.5 grid gap-4">
      <div><div class="mb-2 flex items-baseline justify-between">${kicker('Items (in the order shown when selling)')}</div>
        <div class="grid gap-2">${rows}</div>
        <button data-act="i-add" class="mt-2 w-full rounded-2xl border border-dashed border-white/25 py-3.5 text-[14px] font-semibold text-white/75">+ New item</button>
        <div class="mt-2 text-[11px] text-white/45">Hidden items disappear from the Sell screen but stay in past sales and reports. Price changes only affect new sales.</div></div>
      <div id="cn-itembar" class="sticky z-40 -mx-1 rounded-3xl p-1.5" style="bottom:calc(96px + env(safe-area-inset-bottom,0px));background:rgba(14,14,16,.82);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)">
        ${E.err ? `<div class="mb-1.5 rounded-2xl px-3 py-2 text-[12px] font-semibold text-white" style="background:var(--mar)">${esc(E.err)}</div>` : ''}
        <button data-act="i-save" ${E.dirty && !E.busy ? '' : 'disabled'} class="w-full rounded-[20px] px-4 py-4 text-[16px] font-bold leading-none ${E.dirty && !E.busy ? '' : 'opacity-50'}" style="${goldStyle}">${E.busy ? 'Saving…' : E.dirty ? 'Save item changes' : 'No unsaved changes'}</button></div>
      <div class="${card} grid gap-2 p-3.5">${kicker('Categories')}<div class="flex flex-wrap gap-2">${catChips}</div>
        <div class="flex gap-2"><input data-f="i-newcat" type="text" placeholder="New category" value="${esc(E.newCat)}" class="${input} min-w-0 flex-1" aria-label="New category"><button data-act="i-addcat" class="h-11 flex-none rounded-xl border border-white/15 bg-white/[.06] px-4 text-[13px] font-semibold text-white/80">Add</button></div></div>
      <div class="${card} grid gap-2 p-3.5">${kicker('Venmo')}
        <input data-f="i-venmoUser" type="text" autocapitalize="off" autocorrect="off" placeholder="Venmo username (no @)" value="${esc(st.venmoUser)}" class="${input}" aria-label="Venmo username">
        <input data-f="i-venmoNote" type="text" placeholder="Payment note" value="${esc(st.venmoNote)}" class="${input}" aria-label="Venmo payment note">
        <div class="text-[11px] text-white/45">The note is all the payer sees; the items are never included. The QR asks Venmo to make the payment private.</div>
        <button data-act="i-savevenmo" class="h-12 rounded-xl border border-white/15 bg-white/[.06] text-[13px] font-semibold text-white/85">Save Venmo settings</button>
        ${st.venmoUser ? `<button data-act="i-preview" class="text-left text-[12px] font-semibold text-white/55 underline underline-offset-2">${E.preview ? 'Hide' : 'Preview'} test QR ($1.00)</button>${E.preview ? `<div>${qrBox(previewUrl, 200)}</div>` : ''}` : ''}</div>
    </div>`;
}

let pane = null;
export function renderItems(el) {
    if (!el) return;
    if (el !== pane) {
        pane = el;
        el.addEventListener('click', (e) => onClick(e, el));
        el.addEventListener('input', (e) => onInput(e, el));
    }
    el.innerHTML = html();
}

const redraw = (el) => { el.innerHTML = html(); };

function markDirty(el) {
    E.dirty = true; E.err = '';
    const bar = el.querySelector('#cn-itembar'); if (bar) { const fresh = document.createElement('div'); fresh.innerHTML = html(); const nb = fresh.querySelector('#cn-itembar'); if (nb) bar.innerHTML = nb.innerHTML; }
}

function onInput(e, el) {
    const t = e.target, f = t.getAttribute('data-f'), k = t.getAttribute('data-k');
    if (f === 'i-newcat') { E.newCat = t.value; return; }
    if (f === 'i-venmoUser') { E.settings.venmoUser = t.value; return; }
    if (f === 'i-venmoNote') { E.settings.venmoNote = t.value; return; }
    if (k) {
        const it = E.draft[Number(t.getAttribute('data-i'))]; if (!it) return;
        it[k] = k === 'price' ? t.value : t.value;
        markDirty(el);
    }
}

async function onClick(e, el) {
    const b = e.target.closest('[data-act^="i-"]'); if (!b) return;
    const act = b.getAttribute('data-act'), i = Number(b.getAttribute('data-v'));
    const token = Store.authToken();
    const cats = Store.catalog().settings.categories;
    switch (act) {
        case 'i-up': if (i > 0) { [E.draft[i - 1], E.draft[i]] = [E.draft[i], E.draft[i - 1]]; E.dirty = true; } redraw(el); return;
        case 'i-down': if (i < E.draft.length - 1) { [E.draft[i + 1], E.draft[i]] = [E.draft[i], E.draft[i + 1]]; E.dirty = true; } redraw(el); return;
        case 'i-toggle': E.draft[i].active = !E.draft[i].active; E.dirty = true; redraw(el); return;
        case 'i-add': E.draft.push({ id: null, name: '', price: '', category: cats[cats.length - 1] || 'Other', active: true }); E.dirty = true; redraw(el); return;
        case 'i-preview': E.preview = !E.preview; redraw(el); return;
        case 'i-addcat': {
            const name = E.newCat.trim(); if (!name) return;
            if (cats.some((c) => c.toLowerCase() === name.toLowerCase())) { toast('That category already exists', true); return; }
            try { const c = await saveConcessionSettings(token, { categories: [...cats, name] }); Store.applyCatalog(c); E.newCat = ''; toast('Category added'); }
            catch (err) { toast(err.status === 0 ? 'You need a connection to change this' : err.message, true); }
            redraw(el); return;
        }
        case 'i-savevenmo': {
            try { const c = await saveConcessionSettings(token, { venmoUser: E.settings.venmoUser, venmoNote: E.settings.venmoNote }); Store.applyCatalog(c); E.settings = { venmoUser: c.settings.venmoUser, venmoNote: c.settings.venmoNote }; toast('Venmo settings saved'); }
            catch (err) { toast(err.status === 0 ? 'You need a connection to save' : err.message, true); }
            redraw(el); return;
        }
        case 'i-save': {
            if (E.busy) return;
            const bad = E.draft.findIndex((it) => !String(it.name).trim() || !(Number(it.price) >= 0) || String(it.price) === '');
            if (bad >= 0) { E.err = `Item ${bad + 1} needs a name and a price.`; redraw(el); return; }
            E.busy = true; E.err = ''; redraw(el);
            try {
                const c = await saveConcessionItems(token, E.draft.map((it) => ({ id: it.id, name: String(it.name).trim(), price: Number(it.price), category: it.category, active: it.active })));
                Store.applyCatalog(c); E.draft = null; E.dirty = false; toast('Items saved');
            } catch (err) { E.err = err.status === 0 ? 'You need a connection to save items. Your edits are kept here.' : err.message; }
            E.busy = false; redraw(el); return;
        }
        default:
    }
}
