// server/raffleReconcile.js
// Compares the database backup of raffle sales (raffleDb.js) with the Sales tab of the raffle spreadsheet,
// receipt by receipt. Read-only: it never changes either side. compare() is pure so it can be tested on its own.

const digits = (s) => String(s || '').replace(/\D/g, '');
const linesSig = (lines) => (lines || []).map((l) => `${l.roll ?? l[0]}:${l.start ?? l[2]}-${l.end ?? l[3]}`).sort().join(' | ');

// field -> [label, normalizer used for equality, value shown]
const FIELDS = [
  ['tickets', 'Tickets', (s) => Number(s.qty), (s) => s.qty],
  ['price', 'Price', (s) => Math.round(Number(s.price) * 100), (s) => '$' + Number(s.price).toFixed(2)],
  ['pay', 'Payment', (s) => String(s.pay).trim().toLowerCase(), (s) => s.pay],
  ['seller', 'Seller', (s) => String(s.seller).trim().toLowerCase(), (s) => s.seller],
  ['name', 'Buyer name', (s) => String(s.name).trim().toLowerCase(), (s) => s.name],
  ['phone', 'Phone', (s) => digits(s.phone), (s) => s.phone],
  ['email', 'Email', (s) => String(s.email).trim().toLowerCase(), (s) => s.email],
  ['ranges', 'Ticket numbers', (s) => linesSig(s.lines), (s) => linesSig(s.lines)]
];

const brief = (s) => ({ receipt: s.receipt, t: s.t, seller: s.seller, name: s.name, phone: s.phone, email: s.email, qty: s.qty, price: s.price, pay: s.pay, lines: s.lines, void: !!s.void, status: s.status, error: s.error });

/**
 * dbRows: raffleDb.listAll(). sheetSales: groupSales() output ({receipt,qty,price,void,lines:[[roll,color,start,end,qty]],...}).
 */
export function compare(dbRows, sheetSales) {
  const failed = dbRows.filter((r) => r.status === 'failed');
  const live = dbRows.filter((r) => r.status !== 'failed');
  const sheetBy = new Map(sheetSales.map((s) => [s.receipt, s]));

  // Receipt numbers restart if the sheet is reset between events, so the same receipt can appear twice in the
  // database. Match the newest one and say so.
  const byReceipt = new Map();
  live.forEach((r) => { (byReceipt.get(r.receipt) || byReceipt.set(r.receipt, []).get(r.receipt)).push(r); });
  const duplicateReceipts = [...byReceipt.entries()].filter(([, v]) => v.length > 1).map(([k]) => k);
  const newest = [...byReceipt.values()].map((v) => v[v.length - 1]);

  const missingInSheet = [], mismatched = [];
  let matched = 0;
  newest.forEach((d) => {
    const s = sheetBy.get(d.receipt);
    if (!s) { missingInSheet.push(brief(d)); return; }
    const sheetLike = { ...s, lines: s.lines };
    const diffs = [];
    FIELDS.forEach(([key, label, norm, show]) => {
      if (norm(d) !== norm(sheetLike)) diffs.push({ field: label, db: String(show(d)), sheet: String(show(sheetLike)) });
    });
    if (diffs.length) mismatched.push({ ...brief(d), diffs, voidedInSheet: !!s.void });
    else matched++;
  });
  const dbReceipts = new Set(newest.map((d) => d.receipt));
  const missingInDb = sheetSales.filter((s) => !dbReceipts.has(s.receipt)).map(brief);

  const sum = (arr, f) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);
  const dbCounted = newest.filter((d) => d.status === 'synced' || d.status === 'pending');
  const sheetCounted = sheetSales.filter((s) => !s.void);
  return {
    summary: {
      dbSales: newest.length, sheetSales: sheetSales.length, matched,
      missingInSheet: missingInSheet.length, missingInDb: missingInDb.length, mismatched: mismatched.length,
      pending: live.filter((r) => r.status === 'pending').length, failed: failed.length,
      voidedInSheet: sheetSales.filter((s) => s.void).length,
      dbRaised: Math.round(sum(dbCounted, (d) => d.price) * 100) / 100, sheetRaised: Math.round(sum(sheetCounted, (s) => s.price) * 100) / 100,
      dbTickets: sum(dbCounted, (d) => d.qty), sheetTickets: sum(sheetCounted, (s) => s.qty),
      duplicateReceipts
    },
    missingInSheet, missingInDb, mismatched, failed: failed.map(brief)
  };
}
