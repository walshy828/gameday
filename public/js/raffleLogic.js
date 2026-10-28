// public/js/raffleLogic.js
// Pure raffle rules (no I/O), shared by the browser (live price / ticket preview) and the server
// (server/raffleSheets.js, which decides what actually gets written). Ported from the Raffle Manager
// Apps Script (bestPrice_, allocate_, strip_) so a sale made here comes out the same as one ticked in
// a Station tab. Keep it in step with that script.

/** Cheapest price for exactly `qty` tickets using any mix of bundles. null if impossible. */
export function bestPrice(qty, bundles) {
  const INF = 1e15, dp = [0];
  for (let i = 1; i <= qty; i++) {
    dp[i] = INF;
    for (const b of bundles) {
      const cents = Math.round(b.price * 100);
      if (b.qty <= i && dp[i - b.qty] + cents < dp[i]) dp[i] = dp[i - b.qty] + cents;
    }
  }
  return dp[qty] >= INF ? null : dp[qty] / 100;
}

/**
 * Quantity and price of a sale. `bundleQty` is a tapped bundle; `customQty` / `customPrice` override it.
 * Returns { qty, price } or { error }.
 */
export function priceSale({ bundleQty, customQty, customPrice }, bundles) {
  const hasCq = customQty !== '' && customQty != null;
  const hasCp = customPrice !== '' && customPrice != null;
  const qty = hasCq ? Number(customQty) : Number(bundleQty);
  if (!(qty > 0) || qty % 1 !== 0 || qty > 5000) return { error: 'Pick a bundle (or enter a whole-number custom quantity).' };
  let price;
  if (hasCp) price = Number(customPrice);
  else if (!hasCq) {
    const exact = bundles.find((b) => b.qty === qty);
    price = exact ? exact.price : bestPrice(qty, bundles);
  } else price = bestPrice(qty, bundles);
  if (price === null || !Number.isFinite(price) || price < 0) return { error: `Can't price ${qty} tickets from the bundles - enter a Custom price.` };
  return { qty, price };
}

/**
 * Split `qty` tickets across rolls, starting with `rollId`, then other Active rolls (same color first).
 * rolls: [{id,color,status,end,next}]
 */
export function allocate(qty, rollId, rolls) {
  const first = rolls.find((r) => r.id === rollId);
  if (!first) return { error: `Roll "${rollId}" not found on the Rolls tab.` };
  if (first.status !== 'Active') return { error: `Roll "${rollId}" is ${first.status}, not Active.` };
  const others = rolls.filter((r) => r.id !== rollId && r.status === 'Active');
  const same = others.filter((r) => r.color === first.color);
  const diff = others.filter((r) => r.color !== first.color);
  const order = [first].concat(same, diff), lines = [];
  let need = qty;
  for (let i = 0; i < order.length && need > 0; i++) {
    const r = order[i], rem = r.end - r.next + 1;
    if (rem <= 0) continue;
    const take = Math.min(rem, need);
    lines.push({ roll: r.id, color: r.color, start: r.next, end: r.next + take - 1, qty: take });
    need -= take;
  }
  if (need > 0) return { error: `Not enough tickets left on Active rolls (short by ${need}). Add or activate a roll on the Rolls tab.` };
  return { lines };
}

/**
 * Pre-torn strip: the seller names the first ticket (and optionally the color).
 * rolls: [{id,color,status,start,end}]  issued: [{roll,start,end,receipt}]
 */
export function strip(start, qty, color, rolls, issued) {
  const end = start + qty - 1;
  const hits = rolls.filter((r) =>
    (r.status === 'Active' || r.status === 'Pre-torn') && r.start <= start && start <= r.end && (color === '' || r.color === color));
  if (hits.length === 0) return { error: `No Active or Pre-torn roll${color ? ' of color ' + color : ''} contains ticket ${start}.` };
  if (hits.length > 1) return { error: `Ticket ${start} is on more than one roll - pick the Color.` };
  const r = hits[0];
  if (end > r.end) return { error: `Tickets ${start}-${end} run past the end of ${r.id} (last ticket ${r.end}). Check the first number or the quantity.` };
  for (const x of issued) {
    if (x.roll === r.id && !(x.end < start || x.start > end)) {
      return { error: `Tickets ${x.start}-${x.end} on ${r.id} were already sold on receipt ${x.receipt}.` };
    }
  }
  return { lines: [{ roll: r.id, color: r.color, start, end, qty }] };
}

/**
 * Raw Sales rows (already parsed to objects, in sheet order) -> receipts, newest first.
 * A receipt split over two rolls has several rows; only the first carries bundle qty and price.
 * Voided tickets stay "used" (never reissued), so `maxEnd` counts them; sold/revenue do not.
 */
export function groupSales(rows) {
  const byReceipt = new Map();
  for (const r of rows) {
    let s = byReceipt.get(r.receipt);
    if (!s) {
      s = { receipt: r.receipt, t: r.t, seller: r.seller, name: r.name, phone: r.phone, email: r.email,
        pay: r.pay, price: 0, qty: 0, void: false, notes: r.notes, lines: [] };
      byReceipt.set(r.receipt, s);
    }
    if (r.price !== '' && r.price != null) s.price += Number(r.price) || 0;
    s.qty += Number(r.tickets) || 0;
    if (r.void) s.void = true;
    s.lines.push([r.roll, r.color, r.start, r.end, r.tickets]);
  }
  return [...byReceipt.values()].reverse();
}
