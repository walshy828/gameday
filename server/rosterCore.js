// server/rosterCore.js
// Roster / Team Management planner. A line-for-line port of the pure logic in the
// Registrations sheet's Apps Script (RM_Core.gs) so the app and the sheet produce the
// SAME outcomes. Nothing here touches Google Sheets: every add / rename / remove / move
// is turned into a PLAN (human-readable changes + low-level ops) that rosterSheets.js
// previews and executes.
//
// Source of truth: the "Participant List" tab. Keys the sheet already uses:
//   Team key     "Team Name (Division)"       e.g. "Ball Blasters (Grades 1-2)"
//   Lookup key   "Team Name (Division)|Name"  (Participant List + Waivers)
//   Trim name    lower-case, single-spaced name
//   History key  "2026|team|division|name"    (history tabs; punctuation stripped)
//
// A "tab" is { name, key, headerRow, cols: {header -> 0-based index}, lastCol, rows: [{r, v}] }
// where r is the 1-based sheet row and v the row's display values.

// What the change log says made the change (Apps Script writes "Team Management").
export const SOURCE_LABEL = 'Gameday App';

export const RM_CFG = {
  UPDATE_HISTORY: true,
  MAX_NAME_LENGTH: 80,
  TAB: {
    REG: 'Registrations',
    PL: 'Participant List',
    WV: 'Waivers',
    LOG: 'Roster Change Log',
    HP: 'history - participants',
    HR: 'history - registrations',
    SET: 'Season Settings',
    CI: 'Check-In Log'
  },
  HEADER_ROW: { REG: 1, PL: 2, WV: 2, LOG: 1, HP: 1, HR: 1 },
  H: {
    REG: { team: 'Team Name', div: 'Which age group is your team?', capName: 'Parent Team Captain Name (first and last)', capEmail: 'Parent Team Captain Email Address' },
    // Optional Registrations columns: looked up when needed, the action says so plainly if one is missing.
    REGX: { paid: 'Paid', sub: 'Sub Division', girls: 'Optional: Girls Only Division', type: 'Team Type', phone: 'Cell Number', regDate: 'Registration Date', ts: 'Timestamp',
             ci: 'Checked In', ciTime: 'Check-In Time', ciBy: 'Check-In By' },   // the 3 check-in columns are created on the first check-in if missing
    PL: { name: 'Participant', team: 'Team', div: 'Division', signed: 'Signed Waiver', waiverName: 'Waiver Name Found', notes: 'Notes', key: 'lookup key', trim: 'trim name', resolution: 'Resolution' },
    WV: { ts: 'Timestamp', parent: 'Your Full Name (Parent/Guardian)', typed: 'Participating Childs Name', team: 'Team Name', validated: 'Validated', found: 'Found in Participant List',
          key: 'lookup key', matched: 'Matched Roster Name', conf: 'Match Confidence', review: 'Review Status', div: 'Participating Childs Division', parentEmail: 'Your Email (Parent/Guardian)', capSent: 'Captain Email Sent' },
    LOG: { ts: 'Timestamp', team: 'Team', change: 'Change', oldv: 'Old Value', newv: 'New Value' },
    HP: { name: 'Participant', team: 'Team', div: 'Division', signed: 'Signed Waiver', year: 'Year', key: '_sync_key' },
    HR: { team: 'Team Name', div: 'Age Group', count: 'Participant Count', year: 'season_year' },
    CI: { ts: 'Timestamp', team: 'Team', div: 'Division', action: 'Action', note: 'Note', by: 'By', warn: 'Warnings at check-in' }
  }
};

/* ---------- small helpers ---------- */

export function rmClean_(s) { return String(s == null ? '' : s).replace(/[\s ]+/g, ' ').trim(); }
export function rmNK_(s) { return rmClean_(s).toLowerCase(); }
export function rmHist_(s) { return rmClean_(s).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(); }
export function rmG_(tab, row, h) { const i = tab.cols[h]; return (i == null || row.v[i] == null) ? '' : String(row.v[i]); }
export function rmCol_(tab, h) {
  const i = tab.cols[h];
  if (i == null) throw new Error('Column "' + h + '" not found on tab "' + tab.name + '".');
  return i + 1;
}
export function rmKeyName_(key) { const s = String(key || ''), i = s.lastIndexOf('|'); return i < 0 ? '' : s.substring(i + 1); }
export function rmHistKey_(year, team, div, name) { return [String(year), rmHist_(team), rmHist_(div), rmHist_(name)].join('|'); }
export function rmDivOrder_(div) { const m = String(div).match(/(\d+)/); return m ? parseInt(m[1], 10) : 99; }

export function rmPlayerCols_(tab) {
  const out = [];
  Object.keys(tab.cols).forEach((h) => {
    const m = h.match(/^player\s*(\d+)\s*name/i);
    if (m) out.push({ n: parseInt(m[1], 10), i: tab.cols[h] });
  });
  out.sort((a, b) => a.n - b.n);
  return out.map((o) => o.i);
}

export function rmValidateName_(name) {
  if (!name) return 'Enter a name.';
  if (name.length > RM_CFG.MAX_NAME_LENGTH) return 'That name is too long (max ' + RM_CFG.MAX_NAME_LENGTH + ' characters).';
  if (/^[=+\-@]/.test(name)) return 'A name can\'t start with = + - or @.';
  if (name.indexOf('|') >= 0) return 'A name can\'t contain the "|" character (it is used inside lookup keys).';
  if (!/[A-Za-zÀ-ɏ]/.test(name)) return 'A name needs at least one letter.';
  return '';
}

/* ---------- reading the model ---------- */

export function rmSetting_(ctx, label, dflt) {
  const n = parseInt((ctx.settings || {})[label], 10);
  return isNaN(n) ? dflt : n;
}

export function rmFindTeam_(ctx, teamKey) {
  const want = rmNK_(teamKey);
  let found = null;
  ctx.reg.rows.forEach((row) => {
    const team = rmClean_(rmG_(ctx.reg, row, RM_CFG.H.REG.team));
    const div = rmClean_(rmG_(ctx.reg, row, RM_CFG.H.REG.div));
    if (!team || found) return;
    if (rmNK_(team + ' (' + div + ')') === want) found = { team, division: div, key: team + ' (' + div + ')', regRow: row };
  });
  return found;
}

export function rmMembers_(ctx, t) {
  const H = RM_CFG.H.PL, out = [];
  ctx.pl.rows.forEach((row) => {
    const name = rmClean_(rmG_(ctx.pl, row, H.name));
    if (!name) return;
    if (rmNK_(rmG_(ctx.pl, row, H.team)) !== rmNK_(t.team) || rmNK_(rmG_(ctx.pl, row, H.div)) !== rmNK_(t.division)) return;
    const signedText = rmClean_(rmG_(ctx.pl, row, H.signed));
    out.push({
      row: row.r, name,
      signed: rmNK_(signedText) === 'yes',
      provisional: rmNK_(signedText).indexOf('no - not found') === 0,   // auto-added from a waiver that wasn't on the roster
      signedText,
      waiverName: rmClean_(rmG_(ctx.pl, row, H.waiverName)),
      notes: rmClean_(rmG_(ctx.pl, row, H.notes))
    });
  });
  return out;
}

export function rmTeamWaivers_(ctx, t) {
  return ctx.wv.rows.filter((row) => rmNK_(rmG_(ctx.wv, row, RM_CFG.H.WV.team)) === rmNK_(t.key));
}

export function rmIsLinked_(ctx, row) { return rmNK_(rmG_(ctx.wv, row, RM_CFG.H.WV.found)) === 'yes'; }

export function rmWaiverDesc_(ctx, row) {
  const H = RM_CFG.H.WV;
  const ts = rmClean_(rmG_(ctx.wv, row, H.ts)).split(' ')[0];
  const parent = rmClean_(rmG_(ctx.wv, row, H.parent));
  return 'waiver for "' + rmClean_(rmG_(ctx.wv, row, H.typed)) + '"' + (parent ? ' from ' + parent : '') + (ts ? ' (' + ts + ')' : '') + ' [row ' + row.r + ']';
}

/** Waivers currently attached to roster name X on team t (by key or matched name). */
export function rmLinkedWaivers_(ctx, t, name) {
  const H = RM_CFG.H.WV, nk = rmNK_(name);
  return rmTeamWaivers_(ctx, t).filter((row) =>
    rmNK_(rmKeyName_(rmG_(ctx.wv, row, H.key))) === nk || rmNK_(rmG_(ctx.wv, row, H.matched)) === nk);
}

/** Team waivers that are NOT linked to anybody on the roster. */
export function rmUnlinkedWaivers_(ctx, t) {
  return rmTeamWaivers_(ctx, t).filter((row) => !rmIsLinked_(ctx, row));
}

export function rmIsPaid_(ctx, regRow) {
  const v = rmNK_(rmG_(ctx.reg, regRow, RM_CFG.H.REGX.paid));
  return v === 'yes' || v === 'y' || v === 'paid' || v === 'true';
}
/** Check-in state of a team (Registrations "Checked In" = Yes). Time and by are what was written when the box was checked. */
export function rmCheckin_(ctx, regRow) {
  const X = RM_CFG.H.REGX, v = rmNK_(rmG_(ctx.reg, regRow, X.ci));
  const on = v === 'yes' || v === 'y' || v === 'true' || v === 'checked in';
  return { ci: on, ciTime: on ? rmClean_(rmG_(ctx.reg, regRow, X.ciTime)) : '', ciBy: on ? rmClean_(rmG_(ctx.reg, regRow, X.ciBy)) : '' };
}
/** Plain text that goes into a cell: collapse whitespace, cap the length, and keep a leading = + - @ from turning into a formula. */
export function rmSafeText_(s, max) {
  const t = String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max || 500);
  return /^[=+\-@]/.test(t) ? ' ' + t : t;
}
export function rmSubOf_(ctx, regRow) { return rmClean_(rmG_(ctx.reg, regRow, RM_CFG.H.REGX.sub)); }
/** Girls-only team: the form's "Optional: Girls Only Division" has a non-"no" answer, or Team Type says girls. */
export function rmIsGirls_(ctx, regRow) {
  const g = rmClean_(rmG_(ctx.reg, regRow, RM_CFG.H.REGX.girls)), ty = rmClean_(rmG_(ctx.reg, regRow, RM_CFG.H.REGX.type));
  if (/^girl/i.test(ty)) return true;
  return !!g && !/^(no|n|none|n\/a|na|false|0)\b/i.test(g);
}
/** Sub divisions already in use on Registrations, with how many teams use each. */
export function rmSubOptions_(ctx) {
  const seen = {}, out = [];
  ctx.reg.rows.forEach((row) => {
    if (!rmClean_(rmG_(ctx.reg, row, RM_CFG.H.REG.team))) return;
    const v = rmSubOf_(ctx, row);
    if (!v) return;
    const k = rmNK_(v);
    if (!seen[k]) { seen[k] = { name: v, count: 0 }; out.push(seen[k]); }
    seen[k].count++;
  });
  out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return out;
}

export function rmTeamList_(ctx) {
  const out = [];
  ctx.reg.rows.forEach((row) => {
    const team = rmClean_(rmG_(ctx.reg, row, RM_CFG.H.REG.team));
    const div = rmClean_(rmG_(ctx.reg, row, RM_CFG.H.REG.div));
    if (!team) return;
    const t = { team, division: div, key: team + ' (' + div + ')', regRow: row };
    const m = rmMembers_(ctx, t);
    out.push({
      key: t.key, team, division: div, count: m.length,
      signed: m.filter((x) => x.signed).length, paid: rmIsPaid_(ctx, row),
      captain: rmClean_(rmG_(ctx.reg, row, RM_CFG.H.REG.capName)),
      sub: rmSubOf_(ctx, row), girls: rmIsGirls_(ctx, row),
      ci: rmCheckin_(ctx, row).ci, ciTime: rmCheckin_(ctx, row).ciTime
    });
  });
  out.sort((a, b) => rmDivOrder_(a.division) - rmDivOrder_(b.division) || a.team.toLowerCase().localeCompare(b.team.toLowerCase()));
  return out;
}

export function rmPeople_(ctx) {
  const H = RM_CFG.H.PL, out = [];
  ctx.pl.rows.forEach((row) => {
    const n = rmClean_(rmG_(ctx.pl, row, H.name));
    if (n) out.push({ name: n, key: rmClean_(rmG_(ctx.pl, row, H.team)) + ' (' + rmClean_(rmG_(ctx.pl, row, H.div)) + ')' });
  });
  return out;
}

export function rmPlayersOf_(ctx, regRow) {
  return rmPlayerCols_(ctx.reg).map((i) => rmClean_(regRow.v[i]));
}

export function rmRoster_(ctx, teamKey) {
  const t = rmFindTeam_(ctx, teamKey);
  if (!t) throw new Error('Team not found: ' + teamKey);
  const members = rmMembers_(ctx, t);
  members.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const rosterKeys = members.map((m) => rmNK_(m.name));
  const WH = RM_CFG.H.WV;
  // a waiver flagged "not found" whose name IS on the roster is a stale flag, not a missing player — don't offer it
  const unlinked = rmUnlinkedWaivers_(ctx, t).filter((row) =>
    rosterKeys.indexOf(rmNK_(rmG_(ctx.wv, row, WH.typed))) < 0 && rosterKeys.indexOf(rmNK_(rmKeyName_(rmG_(ctx.wv, row, WH.key)))) < 0
  ).map((row) => ({
    row: row.r, typed: rmClean_(rmG_(ctx.wv, row, WH.typed)), parent: rmClean_(rmG_(ctx.wv, row, WH.parent)),
    ts: rmClean_(rmG_(ctx.wv, row, WH.ts)).split(' ')[0], review: rmClean_(rmG_(ctx.wv, row, WH.review))
  }));
  const regPlayers = rmPlayersOf_(ctx, t.regRow).filter((x) => x);
  const memberKeys = members.map((m) => rmNK_(m.name));
  const regOnly = regPlayers.filter((x) => memberKeys.indexOf(rmNK_(x)) < 0);
  const regKeys = regPlayers.map(rmNK_);
  members.forEach((m) => { m.inReg = regKeys.indexOf(rmNK_(m.name)) >= 0; });
  // who submitted each person's waiver and when
  members.forEach((m) => {
    m.waivers = rmLinkedWaivers_(ctx, t, m.name).filter((w) => rmIsLinked_(ctx, w)).map((w) => ({
      parent: rmClean_(rmG_(ctx.wv, w, WH.parent)), ts: rmClean_(rmG_(ctx.wv, w, WH.ts))
    }));
  });
  return {
    key: t.key, team: t.team, division: t.division, members, unlinkedWaivers: unlinked, regOnly,
    captain: rmClean_(rmG_(ctx.reg, t.regRow, RM_CFG.H.REG.capName)), captainEmail: rmClean_(rmG_(ctx.reg, t.regRow, RM_CFG.H.REG.capEmail)),
    captainPhone: rmClean_(rmG_(ctx.reg, t.regRow, RM_CFG.H.REGX.phone)),
    registered: rmClean_(rmG_(ctx.reg, t.regRow, RM_CFG.H.REGX.regDate)) || rmClean_(rmG_(ctx.reg, t.regRow, RM_CFG.H.REGX.ts)).split(' ')[0],
    paid: rmIsPaid_(ctx, t.regRow), paidText: rmClean_(rmG_(ctx.reg, t.regRow, RM_CFG.H.REGX.paid)), sub: rmSubOf_(ctx, t.regRow), girls: rmIsGirls_(ctx, t.regRow),
    ci: rmCheckin_(ctx, t.regRow).ci, ciTime: rmCheckin_(ctx, t.regRow).ciTime, ciBy: rmCheckin_(ctx, t.regRow).ciBy,
    hasPaidCol: ctx.reg.cols[RM_CFG.H.REGX.paid] != null, hasSubCol: ctx.reg.cols[RM_CFG.H.REGX.sub] != null, subOptions: rmSubOptions_(ctx),
    min: rmSetting_(ctx, 'Min Players Per Team', 8), max: rmSetting_(ctx, 'Max Players Per Team', 12)
  };
}

/** Everything the page shows (team list, every roster, people), built from ONE read of the sheet. */
export function rmFresh_(ctx) {
  const teams = rmTeamList_(ctx), rosters = {};
  teams.forEach((t) => { rosters[t.key] = rmRoster_(ctx, t.key); });
  return { teams, people: rmPeople_(ctx), rosters, year: ctx.year, subOptions: rmSubOptions_(ctx), loadedAt: ctx.nowMs };
}

/* ---------- plan building ---------- */

function rmNewPlan_(action) {
  return { action, title: '', confirmLabel: 'Apply', danger: false, errors: [], warnings: [], soft: [], changes: [], ops: [], meta: {}, options: {} };
}
function rmChange_(p, sheet, text) { p.changes.push({ sheet, text }); }
/** A warning the page already shows on its inline confirm line. With ack:true these don't force the review window. */
function rmSoftWarn_(p, text) { p.warnings.push(text); p.soft.push(text); }

/** Position for a new row: next to the same team's rows, else near the end of the table. */
function rmInsertSpot_(rowNumbers, lastRow) {
  const after = rowNumbers.length ? Math.max(...rowNumbers) : lastRow;
  return after < lastRow ? { mode: 'after', row: after } : { mode: 'before', row: lastRow };
}
function rmLastDataRow_(tab, h) {
  let last = tab.headerRow;
  tab.rows.forEach((row) => { if (rmClean_(rmG_(tab, row, h))) last = Math.max(last, row.r); });
  return last;
}

/** Keep history - registrations' Player columns in step with the Registrations row. */
function rmHistoryRegistrationOps_(ctx, t, newPlayers, p) {
  if (!RM_CFG.UPDATE_HISTORY || !ctx.hr) return;
  const H = RM_CFG.H.HR, year = String(ctx.year);
  const hrCols = rmPlayerCols_(ctx.hr);
  let hit = null;
  ctx.hr.rows.forEach((row) => {
    if (hit) return;
    if (rmClean_(rmG_(ctx.hr, row, H.year)) === year && rmHist_(rmG_(ctx.hr, row, H.team)) === rmHist_(t.team) &&
        rmHist_(rmG_(ctx.hr, row, H.div)) === rmHist_(t.division)) hit = row;
  });
  if (!hit) { rmChange_(p, RM_CFG.TAB.HR, 'No ' + year + ' row for this team on this tab — nothing to update.'); p.meta.hrMissing = true; return; }
  let any = false;
  hrCols.forEach((ci, i) => {
    const cur = rmClean_(hit.v[ci]), want = newPlayers[i] || '';
    if (cur !== want) {
      any = true;
      p.ops.push({ t: 'set', tab: 'HR', row: hit.r, col: ci + 1, value: want });
    }
  });
  if (any) {
    const n = newPlayers.filter((x) => x).length;
    if (ctx.hr.cols[H.count] != null) p.ops.push({ t: 'set', tab: 'HR', row: hit.r, col: ctx.hr.cols[H.count] + 1, value: n });
    rmChange_(p, RM_CFG.TAB.HR, 'Update the player cells on the ' + year + ' row for ' + t.team + '.');
  }
}

/** Which registration-form entries could the user also want to fix (names on the form not matched to anyone)? */
function rmRegOptions_(ctx, t, members, name) {
  const players = rmPlayersOf_(ctx, t.regRow).filter((x) => x);
  if (players.some((x) => rmNK_(x) === rmNK_(name))) return { regCandidates: [] };
  const memberKeys = members.map((m) => rmNK_(m.name));
  return { regCandidates: players.filter((x) => memberKeys.indexOf(rmNK_(x)) < 0) };
}

function rmLogOp_(p, team, change, oldv, newv) {
  p.ops.push({ t: 'log', values: { team, change, oldv, newv } });
  rmChange_(p, RM_CFG.TAB.LOG, change + ': ' + (oldv ? '"' + oldv + '"' : '') + (oldv && newv ? ' → ' : '') + (newv ? '"' + newv + '"' : ''));
}

const tag = () => '(' + SOURCE_LABEL + ')';

/* ----- ADD ----- */

function rmPlanAdd_(ctx, a) {
  const p = rmNewPlan_('add'), H = RM_CFG.H, T = RM_CFG.TAB;
  const t = rmFindTeam_(ctx, a.teamKey);
  if (!t) { p.errors.push('Team not found: ' + a.teamKey); return p; }
  const name = rmClean_(a.name), err = rmValidateName_(name);
  if (err) { p.errors.push(err); return p; }
  p.title = 'Add "' + name + '" to ' + t.key;
  p.confirmLabel = 'Add participant';

  const members = rmMembers_(ctx, t);
  if (members.some((m) => rmNK_(m.name) === rmNK_(name))) { p.errors.push('"' + name + '" is already on this roster.'); return p; }
  if (name.indexOf(' ') < 0) rmSoftWarn_(p, 'Only one name entered — the form asks for first and last name.');
  // same name elsewhere?
  const seen = {};
  ctx.pl.rows.forEach((row) => {
    if (rmNK_(rmG_(ctx.pl, row, H.PL.name)) !== rmNK_(name)) return;
    if (rmNK_(rmG_(ctx.pl, row, H.PL.team)) === rmNK_(t.team) && rmNK_(rmG_(ctx.pl, row, H.PL.div)) === rmNK_(t.division)) return;
    const k = rmG_(ctx.pl, row, H.PL.team) + ' (' + rmG_(ctx.pl, row, H.PL.div) + ')';
    if (!seen[k]) { seen[k] = 1; rmSoftWarn_(p, '"' + name + '" is also on ' + k + '. Add anyway only if this is a different child.'); }
  });
  const max = rmSetting_(ctx, 'Max Players Per Team', 12);
  if (members.length + 1 > max) rmSoftWarn_(p, 'This will be player ' + (members.length + 1) + ' — the registration form allows ' + max + '.');

  const newKey = t.key + '|' + name;

  // waivers that should attach to this person
  const unl = rmUnlinkedWaivers_(ctx, t), link = [];
  const picked = a.linkWaiverRow != null && a.linkWaiverRow !== '';
  unl.forEach((row) => {
    const typed = rmNK_(rmG_(ctx.wv, row, H.WV.typed)), kn = rmNK_(rmKeyName_(rmG_(ctx.wv, row, H.WV.key))), mt = rmNK_(rmG_(ctx.wv, row, H.WV.matched));
    const n = rmNK_(name);
    if (typed === n || kn === n || mt === n || (picked && Number(a.linkWaiverRow) === row.r)) link.push(row);
  });
  if (picked && !link.some((r) => r.r === Number(a.linkWaiverRow))) {
    p.errors.push('The waiver you picked (row ' + a.linkWaiverRow + ') is not an unmatched waiver for this team.'); return p;
  }
  // a waiver already linked to someone else under this typed name?
  rmTeamWaivers_(ctx, t).forEach((row) => {
    if (!rmIsLinked_(ctx, row)) return;
    if (rmNK_(rmG_(ctx.wv, row, H.WV.typed)) === rmNK_(name) && rmNK_(rmG_(ctx.wv, row, H.WV.matched)) !== rmNK_(name))
      p.warnings.push('A waiver typed "' + name + '" is already linked to "' + rmG_(ctx.wv, row, H.WV.matched) + '". If this is the same child, rename that person instead of adding a new one.');
  });
  const signed = link.length > 0 ? 'Yes' : 'No';

  // 1. Participant List row
  const plLast = rmLastDataRow_(ctx.pl, H.PL.name);
  const spot = rmInsertSpot_(members.map((m) => m.row), plLast);
  const vals = {};
  vals[H.PL.name] = name; vals[H.PL.team] = t.team; vals[H.PL.div] = t.division; vals[H.PL.signed] = signed;
  vals[H.PL.notes] = 'Added via ' + SOURCE_LABEL + ' ' + ctx.today; vals[H.PL.key] = newKey; vals[H.PL.trim] = rmNK_(name);
  p.ops.push({ t: 'insertRow', tab: 'PL', mode: spot.mode, row: spot.row, values: vals, copyFormulas: true });
  rmChange_(p, T.PL, 'Add a row: ' + name + ' · ' + t.key + ' · Signed Waiver = ' + signed + ' (lookup key and trim name filled in, formula columns copied down).');

  // 2. Waivers
  link.forEach((row) => {
    const W = H.WV, sets = {};
    sets[W.key] = newKey; sets[W.matched] = name; sets[W.validated] = 'Yes'; sets[W.found] = 'Yes'; sets[W.conf] = 1;
    sets[W.review] = 'Linked by ' + SOURCE_LABEL + ' ' + ctx.today;
    Object.keys(sets).forEach((h) => {
      if (ctx.wv.cols[h] != null) p.ops.push({ t: 'set', tab: 'WV', row: row.r, col: ctx.wv.cols[h] + 1, value: sets[h] });
    });
    rmChange_(p, T.WV, 'Link ' + rmWaiverDesc_(ctx, row) + ' to ' + name + ' (lookup key, matched name, Validated and Found = Yes).');
  });
  if (!link.length) rmChange_(p, T.WV, 'No unmatched waiver found for this name. It will show as "No waiver" until one is submitted or linked.');

  // 3. Registrations player cell
  const players = rmPlayersOf_(ctx, t.regRow), idxCols = rmPlayerCols_(ctx.reg), newPlayers = players.slice();
  if (players.some((x) => rmNK_(x) === rmNK_(name))) {
    rmChange_(p, T.REG, 'Name is already in one of the Player cells — no change.');
  } else {
    const slot = players.indexOf('');
    if (slot < 0) {
      p.warnings.push('The Registrations row already has all ' + players.length + ' Player cells filled, so this player will exist on the Participant List only (same as any extra player added after registration).');
      rmChange_(p, T.REG, 'Player cells are full — not changed.');
    } else {
      newPlayers[slot] = name;
      p.ops.push({ t: 'set', tab: 'REG', row: t.regRow.r, col: idxCols[slot] + 1, value: name });
      rmChange_(p, T.REG, 'Put the name in Player ' + (slot + 1) + ' for ' + t.team + ' (Participant Count updates itself).');
      p.meta.regChanged = true;
    }
  }

  // 4. history
  if (RM_CFG.UPDATE_HISTORY && ctx.hp) {
    const HP = H.HP, year = String(ctx.year), hk = rmHistKey_(year, t.team, t.division, name);
    let exists = null, lastYear = 0;
    const blockRows = [];
    ctx.hp.rows.forEach((row) => {
      if (rmClean_(rmG_(ctx.hp, row, HP.year)) !== year) return;
      lastYear = Math.max(lastYear, row.r);
      if (rmHist_(rmG_(ctx.hp, row, HP.team)) === rmHist_(t.team) && rmHist_(rmG_(ctx.hp, row, HP.div)) === rmHist_(t.division)) blockRows.push(row.r);
      if (rmClean_(rmG_(ctx.hp, row, HP.key)) === hk) exists = row;
    });
    if (exists) {
      if (ctx.hp.cols[HP.signed] != null && rmClean_(rmG_(ctx.hp, exists, HP.signed)) !== signed) {
        p.ops.push({ t: 'set', tab: 'HP', row: exists.r, col: ctx.hp.cols[HP.signed] + 1, value: signed });
        rmChange_(p, T.HP, 'The ' + year + ' row already exists — Signed Waiver → ' + signed + '.');
      } else rmChange_(p, T.HP, 'A ' + year + ' row already exists for this name — left as is.');
    } else {
      const hpLast = rmLastDataRow_(ctx.hp, HP.name);
      const sp = blockRows.length ? rmInsertSpot_(blockRows, hpLast) : rmInsertSpot_(lastYear ? [lastYear] : [], hpLast);
      const hv = {};
      hv[HP.name] = name; hv[HP.team] = t.team; hv[HP.div] = t.division; hv[HP.signed] = signed; hv[HP.year] = Number(year); hv[HP.key] = hk;
      p.ops.push({ t: 'insertRow', tab: 'HP', mode: sp.mode, row: sp.row, values: hv, copyFormulas: false });
      rmChange_(p, T.HP, 'Add a ' + year + ' row (key ' + hk + ').');
    }
    if (p.meta.regChanged) rmHistoryRegistrationOps_(ctx, t, newPlayers, p);
  }

  // 5. log
  rmLogOp_(p, t.key, 'Added ' + tag(), '', name + (link.length ? ' — waiver linked' : ''));
  p.meta.newKey = newKey; p.meta.name = name; p.meta.linkRows = link.map((r) => r.r); p.meta.team = t;
  return p;
}

/* ----- EDIT (rename) ----- */

function rmPlanEdit_(ctx, a) {
  const p = rmNewPlan_('edit'), H = RM_CFG.H, T = RM_CFG.TAB;
  const t = rmFindTeam_(ctx, a.teamKey);
  if (!t) { p.errors.push('Team not found: ' + a.teamKey); return p; }
  const oldName = rmClean_(a.oldName), newName = rmClean_(a.newName), err = rmValidateName_(newName);
  if (err) { p.errors.push(err); return p; }
  if (oldName === newName) { p.errors.push('The name is unchanged.'); return p; }
  p.title = 'Rename "' + oldName + '" → "' + newName + '" on ' + t.key;
  p.confirmLabel = 'Save name change';

  const members = rmMembers_(ctx, t);
  const me = members.filter((m) => rmNK_(m.name) === rmNK_(oldName))[0];
  if (!me) { p.errors.push('"' + oldName + '" is not on this roster any more — reload and try again.'); return p; }
  if (members.some((m) => m !== me && rmNK_(m.name) === rmNK_(newName))) { p.errors.push('"' + newName + '" is already on this roster.'); return p; }
  if (newName.indexOf(' ') < 0) rmSoftWarn_(p, 'Only one name entered — the form asks for first and last name.');
  const oldKey = t.key + '|' + oldName, newKey = t.key + '|' + newName;

  // 1. Participant List
  const set = (tab, row, h, val) => { p.ops.push({ t: 'set', tab, row, col: rmCol_(ctx[tab.toLowerCase()], h), value: val }); };
  const plRow = ctx.pl.rows.filter((r) => r.r === me.row)[0];
  set('PL', me.row, H.PL.name, newName);
  set('PL', me.row, H.PL.key, newKey);
  set('PL', me.row, H.PL.trim, rmNK_(newName));
  const oldNotes = rmClean_(rmG_(ctx.pl, plRow, H.PL.notes));
  set('PL', me.row, H.PL.notes, (oldNotes ? oldNotes + ' | ' : '') + 'Renamed from "' + oldName + '" ' + ctx.today);
  rmChange_(p, T.PL, 'Row ' + me.row + ': Participant, lookup key and trim name → "' + newName + '" (note added).');

  // 2. Waivers already attached to the old name
  const linkedOld = rmLinkedWaivers_(ctx, t, oldName), touched = {};
  linkedOld.forEach((row) => {
    set('WV', row.r, H.WV.key, newKey); set('WV', row.r, H.WV.matched, newName); touched[row.r] = 1;
    rmChange_(p, T.WV, 'Re-point ' + rmWaiverDesc_(ctx, row) + ' to the new name (lookup key + matched name). What the parent typed is left as is.');
  });
  // 2b. a waiver typed with the NEW spelling that was sitting unmatched?
  const newlyLinked = [];
  rmUnlinkedWaivers_(ctx, t).forEach((row) => {
    if (touched[row.r]) return;
    const typed = rmNK_(rmG_(ctx.wv, row, H.WV.typed)), kn = rmNK_(rmKeyName_(rmG_(ctx.wv, row, H.WV.key)));
    if (typed === rmNK_(newName) || kn === rmNK_(newName)) {
      newlyLinked.push(row);
      const W = H.WV, sets = {};
      sets[W.key] = newKey; sets[W.matched] = newName; sets[W.validated] = 'Yes'; sets[W.found] = 'Yes'; sets[W.conf] = 1;
      sets[W.review] = 'Linked by ' + SOURCE_LABEL + ' ' + ctx.today;
      Object.keys(sets).forEach((h) => { if (ctx.wv.cols[h] != null) p.ops.push({ t: 'set', tab: 'WV', row: row.r, col: ctx.wv.cols[h] + 1, value: sets[h] }); });
      rmChange_(p, T.WV, 'Newly match ' + rmWaiverDesc_(ctx, row) + ' — it was waiting for exactly this spelling.');
    }
  });
  if (newlyLinked.length && !me.signed) {
    set('PL', me.row, H.PL.signed, 'Yes');
    rmChange_(p, T.PL, 'Signed Waiver → Yes (a waiver now matches).');
  }
  if (!linkedOld.length && !newlyLinked.length) rmChange_(p, T.WV, 'No waiver is attached to this person — nothing to change.');

  // 3. Registrations
  const players = rmPlayersOf_(ctx, t.regRow), idxCols = rmPlayerCols_(ctx.reg), newPlayers = players.slice();
  const regTarget = rmClean_(a.regName) || oldName;
  let slot = -1;
  players.forEach((x, i) => { if (slot < 0 && rmNK_(x) === rmNK_(regTarget)) slot = i; });
  p.options = rmRegOptions_(ctx, t, members, oldName);
  if (slot >= 0) {
    newPlayers[slot] = newName;
    p.ops.push({ t: 'set', tab: 'REG', row: t.regRow.r, col: idxCols[slot] + 1, value: newName });
    rmChange_(p, T.REG, 'Player ' + (slot + 1) + ' cell: "' + players[slot] + '" → "' + newName + '".');
    p.meta.regChanged = true;
  } else {
    rmChange_(p, T.REG, 'The old name is not in a Player cell on the registration row — nothing to change there.' + (p.options.regCandidates.length ? ' (Pick the form entry below if one of these is the same child.)' : ''));
  }

  // 4. history
  if (RM_CFG.UPDATE_HISTORY && ctx.hp) {
    const HP = H.HP, year = String(ctx.year), hk = rmHistKey_(year, t.team, t.division, oldName);
    let hit = null;
    ctx.hp.rows.forEach((row) => {
      if (!hit && rmClean_(rmG_(ctx.hp, row, HP.year)) === year && rmClean_(rmG_(ctx.hp, row, HP.key)) === hk) hit = row;
    });
    const nkey = rmHistKey_(year, t.team, t.division, newName);
    if (hit) {
      set('HP', hit.r, HP.name, newName); set('HP', hit.r, HP.key, nkey);
      rmChange_(p, T.HP, 'Row ' + hit.r + ': name and key → "' + newName + '".');
    } else rmChange_(p, T.HP, 'No ' + year + ' row for the old name — nothing to change.');
    if (p.meta.regChanged) rmHistoryRegistrationOps_(ctx, t, newPlayers, p);
  }

  rmLogOp_(p, t.key, 'Renamed ' + tag(), oldName, newName);
  p.meta.newKey = newKey; p.meta.oldKey = oldKey; p.meta.newName = newName; p.meta.oldName = oldName; p.meta.team = t;
  p.meta.newlyLinked = newlyLinked.map((r) => r.r);
  return p;
}

/* ----- DELETE ----- */

function rmPlanDelete_(ctx, a) {
  const p = rmNewPlan_('delete'), H = RM_CFG.H, T = RM_CFG.TAB;
  const t = rmFindTeam_(ctx, a.teamKey);
  if (!t) { p.errors.push('Team not found: ' + a.teamKey); return p; }
  const name = rmClean_(a.name);
  p.title = 'Remove "' + name + '" from ' + t.key; p.confirmLabel = 'Remove participant'; p.danger = true;
  const members = rmMembers_(ctx, t);
  const me = members.filter((m) => rmNK_(m.name) === rmNK_(name))[0];
  if (!me) { p.errors.push('"' + name + '" is not on this roster any more — reload and try again.'); return p; }
  const min = rmSetting_(ctx, 'Min Players Per Team', 8);
  if (members.length - 1 < min) rmSoftWarn_(p, 'The team will have ' + (members.length - 1) + ' players — the minimum is ' + min + '.');

  // 1. Participant List
  p.ops.push({ t: 'deleteRow', tab: 'PL', row: me.row });
  rmChange_(p, T.PL, 'Delete the row for ' + name + ' (row ' + me.row + ').');

  // 2. Waivers
  const linked = rmLinkedWaivers_(ctx, t, name);
  const killWaivers = !!a.deleteWaivers;
  linked.forEach((row) => {
    if (killWaivers) {
      p.ops.push({ t: 'deleteRow', tab: 'WV', row: row.r });
      rmChange_(p, T.WV, 'DELETE ' + rmWaiverDesc_(ctx, row) + '. (Legal record — this can only be undone from version history.)');
    } else {
      const W = H.WV, sets = {};
      sets[W.validated] = 'No - not found on team roster'; sets[W.found] = 'No'; sets[W.review] = 'Removed from roster ' + ctx.today + ' (waiver kept)';
      Object.keys(sets).forEach((h) => { if (ctx.wv.cols[h] != null) p.ops.push({ t: 'set', tab: 'WV', row: row.r, col: ctx.wv.cols[h] + 1, value: sets[h] }); });
      rmChange_(p, T.WV, 'KEEP ' + rmWaiverDesc_(ctx, row) + ' but mark it unmatched (Found = No). If this child is added back, it re-links by itself.');
    }
  });
  if (!linked.length) rmChange_(p, T.WV, 'No waiver is attached to this person.');

  // 3. Registrations
  const players = rmPlayersOf_(ctx, t.regRow), idxCols = rmPlayerCols_(ctx.reg), newPlayers = players.slice();
  let cleared = false;
  const regTargetD = rmClean_(a.regName) || name;
  p.options = rmRegOptions_(ctx, t, members, name);
  p.options.canDeleteWaivers = linked.length > 0;
  players.forEach((x, i) => {
    if (!cleared && rmNK_(x) === rmNK_(regTargetD)) {
      newPlayers[i] = '';
      p.ops.push({ t: 'set', tab: 'REG', row: t.regRow.r, col: idxCols[i] + 1, value: '' });
      rmChange_(p, T.REG, 'Clear the Player ' + (i + 1) + ' cell (Participant Count updates itself).');
      cleared = true; p.meta.regChanged = true;
    }
  });
  if (!cleared) rmChange_(p, T.REG, 'Name is not in a Player cell — nothing to clear.' + (p.options.regCandidates.length ? ' (Pick the form entry below if one of these is the same child.)' : ''));

  // 4. history
  if (RM_CFG.UPDATE_HISTORY && ctx.hp) {
    const HP = H.HP, year = String(ctx.year), hk = rmHistKey_(year, t.team, t.division, name);
    let hit = null;
    ctx.hp.rows.forEach((row) => {
      if (!hit && rmClean_(rmG_(ctx.hp, row, HP.year)) === year && rmClean_(rmG_(ctx.hp, row, HP.key)) === hk) hit = row;
    });
    if (hit) { p.ops.push({ t: 'deleteRow', tab: 'HP', row: hit.r }); rmChange_(p, T.HP, 'Delete the ' + year + ' row (row ' + hit.r + ').'); }
    else rmChange_(p, T.HP, 'No ' + year + ' row for this name — nothing to delete.');
    if (cleared) rmHistoryRegistrationOps_(ctx, t, newPlayers, p);
  }

  rmLogOp_(p, t.key, 'Removed ' + tag(), name, killWaivers && linked.length ? 'waiver deleted' : (linked.length ? 'waiver kept' : ''));
  p.meta.name = name; p.meta.team = t; p.meta.linkRows = linked.map((r) => r.r); p.meta.killWaivers = killWaivers;
  return p;
}

/* ----- MOVE PLAYER ----- */

function rmEmptySlot_(players) { for (let i = 0; i < players.length; i++) if (!players[i]) return i; return -1; }

function rmPlanMovePlayer_(ctx, a) {
  const p = rmNewPlan_('movePlayer'), H = RM_CFG.H, T = RM_CFG.TAB, W = H.WV;
  const t = rmFindTeam_(ctx, a.teamKey), nt = rmFindTeam_(ctx, a.toTeamKey);
  if (!t) { p.errors.push('Team not found: ' + a.teamKey); return p; }
  if (!nt) { p.errors.push('Destination team not found.'); return p; }
  if (rmNK_(t.key) === rmNK_(nt.key)) { p.errors.push('Pick a different team.'); return p; }
  const name = rmClean_(a.name), members = rmMembers_(ctx, t), me = members.filter((m) => rmNK_(m.name) === rmNK_(name))[0];
  if (!me) { p.errors.push('"' + name + '" is not on this roster any more — reload and try again.'); return p; }
  const nmembers = rmMembers_(ctx, nt);
  if (nmembers.some((m) => rmNK_(m.name) === rmNK_(name))) { p.errors.push('"' + name + '" is already on ' + nt.key + '.'); return p; }
  p.title = 'Move "' + name + '" from ' + t.team + ' to ' + nt.key; p.confirmLabel = 'Move player';
  const max = rmSetting_(ctx, 'Max Players Per Team', 12), min = rmSetting_(ctx, 'Min Players Per Team', 8);
  if (rmNK_(t.division) !== rmNK_(nt.division)) rmSoftWarn_(p, 'Different division: ' + t.division + ' → ' + nt.division + '.');
  if (nmembers.length + 1 > max) rmSoftWarn_(p, nt.team + ' will have ' + (nmembers.length + 1) + ' players — the form allows ' + max + '.');
  if (members.length - 1 < min) rmSoftWarn_(p, t.team + ' will drop to ' + (members.length - 1) + ' players (minimum ' + min + ').');
  const newKey = nt.key + '|' + name;
  const plSet = (row, h, v) => { if (ctx.pl.cols[h] != null) p.ops.push({ t: 'set', tab: 'PL', row, col: ctx.pl.cols[h] + 1, value: v }); };
  const wvSet = (row, h, v) => { if (ctx.wv.cols[h] != null) p.ops.push({ t: 'set', tab: 'WV', row, col: ctx.wv.cols[h] + 1, value: v }); };

  // 1. Participant List (edit in place)
  plSet(me.row, H.PL.team, nt.team); plSet(me.row, H.PL.div, nt.division); plSet(me.row, H.PL.key, newKey);
  const plRow = ctx.pl.rows.filter((r) => r.r === me.row)[0], oldNotes = rmClean_(rmG_(ctx.pl, plRow, H.PL.notes));
  plSet(me.row, H.PL.notes, (oldNotes ? oldNotes + ' | ' : '') + 'Moved from ' + t.key + ' ' + ctx.today);
  rmChange_(p, T.PL, 'Row ' + me.row + ': Team and Division → ' + nt.key + ', lookup key updated (note added).');

  // 2. Waivers that belong to this person follow them
  const rows = rmLinkedWaivers_(ctx, t, name).slice();
  rmUnlinkedWaivers_(ctx, t).forEach((row) => {
    if (rmNK_(rmG_(ctx.wv, row, W.typed)) === rmNK_(name) && rows.indexOf(row) < 0) rows.push(row);
  });
  let gotSigned = false;
  rows.forEach((row) => {
    const wasLinked = rmIsLinked_(ctx, row);
    wvSet(row.r, W.team, nt.key); wvSet(row.r, W.div, nt.division);
    wvSet(row.r, W.key, newKey); wvSet(row.r, W.matched, name);
    if (!wasLinked) { wvSet(row.r, W.validated, 'Yes'); wvSet(row.r, W.found, 'Yes'); wvSet(row.r, W.conf, 1); gotSigned = true; }
    wvSet(row.r, W.review, 'Moved with player from ' + t.key + ' to ' + nt.key + ' ' + ctx.today);
    rmChange_(p, T.WV, 'Move ' + rmWaiverDesc_(ctx, row) + ' to ' + nt.key + (wasLinked ? '.' : ' and match it (it was unmatched).'));
  });
  if (!rows.length) rmChange_(p, T.WV, 'No waiver is attached to this person.');
  if (gotSigned && !me.signed) plSet(me.row, H.PL.signed, 'Yes');

  // 3. Registrations: clear from the old team's cell, fill the first empty cell on the new team
  const cols = rmPlayerCols_(ctx.reg), oldP = rmPlayersOf_(ctx, t.regRow), newP = rmPlayersOf_(ctx, nt.regRow);
  let oldChanged = false, newChanged = false;
  oldP.forEach((x, i) => {
    if (!oldChanged && rmNK_(x) === rmNK_(name)) {
      oldP[i] = ''; oldChanged = true;
      p.ops.push({ t: 'set', tab: 'REG', row: t.regRow.r, col: cols[i] + 1, value: '' });
      rmChange_(p, T.REG, t.team + ': clear the Player ' + (i + 1) + ' cell.');
    }
  });
  if (!oldChanged) rmChange_(p, T.REG, t.team + ': name was not in a Player cell — nothing to clear.');
  if (newP.some((x) => rmNK_(x) === rmNK_(name))) rmChange_(p, T.REG, nt.team + ': already in a Player cell.');
  else {
    const slot = rmEmptySlot_(newP);
    if (slot >= 0) {
      newP[slot] = name; newChanged = true;
      p.ops.push({ t: 'set', tab: 'REG', row: nt.regRow.r, col: cols[slot] + 1, value: name });
      rmChange_(p, T.REG, nt.team + ': put the name in Player ' + (slot + 1) + '.');
    } else rmChange_(p, T.REG, nt.team + ' already has ' + cols.length + ' names on the form — this player appears on the Participant List only.');
  }

  // 4. history
  if (RM_CFG.UPDATE_HISTORY && ctx.hp) {
    const HP = H.HP, year = String(ctx.year), hk = rmHistKey_(year, t.team, t.division, name);
    let hit = null;
    ctx.hp.rows.forEach((row) => { if (!hit && rmClean_(rmG_(ctx.hp, row, HP.year)) === year && rmClean_(rmG_(ctx.hp, row, HP.key)) === hk) hit = row; });
    if (hit) {
      [[HP.team, nt.team], [HP.div, nt.division], [HP.key, rmHistKey_(year, nt.team, nt.division, name)]].forEach((c) => {
        if (ctx.hp.cols[c[0]] != null) p.ops.push({ t: 'set', tab: 'HP', row: hit.r, col: ctx.hp.cols[c[0]] + 1, value: c[1] });
      });
      rmChange_(p, T.HP, 'Row ' + hit.r + ': team, division and key → ' + nt.key + '.');
    } else rmChange_(p, T.HP, 'No ' + year + ' row for this name — nothing to change.');
    if (oldChanged) rmHistoryRegistrationOps_(ctx, t, oldP, p);
    if (newChanged) rmHistoryRegistrationOps_(ctx, nt, newP, p);
  }
  rmLogOp_(p, nt.key, 'Player moved ' + tag(), t.key + ' | ' + name, nt.key);
  p.meta = { name, fromKey: t.key, toKey: nt.key, newKey, waiverRows: rows.map((r) => r.r), team: t };
  return p;
}

/* ----- TEAM HEADER: paid / sub division ----- */

function rmPlanSetRegCell_(ctx, a, kind) {
  const X = RM_CFG.H.REGX, hdr = kind === 'paid' ? X.paid : X.sub;
  const p = rmNewPlan_(kind === 'paid' ? 'setPaid' : 'setSub');
  const t = rmFindTeam_(ctx, a.teamKey);
  if (!t) { p.errors.push('Team not found: ' + a.teamKey); return p; }
  const ci = ctx.reg.cols[hdr];
  if (ci == null) { p.errors.push('The Registrations tab has no "' + hdr + '" column, so this can\'t be saved.'); return p; }
  const old = rmClean_(rmG_(ctx.reg, t.regRow, hdr));
  let val, logName;
  if (kind === 'paid') {
    const w = rmNK_(a.paid);
    if (w !== 'yes' && w !== 'no') { p.errors.push('Paid must be Yes or No.'); return p; }
    val = w === 'yes' ? 'Yes' : 'No';
    if (rmNK_(old) === rmNK_(val)) { p.errors.push(t.team + ' is already marked ' + (val === 'Yes' ? 'paid' : 'not paid') + '.'); return p; }
    p.title = val === 'Yes' ? 'Mark ' + t.team + ' as paid' : 'Mark ' + t.team + ' as NOT paid';
    p.confirmLabel = val === 'Yes' ? 'Mark as paid' : 'Mark as not paid';
    p.danger = val === 'No';
    logName = 'Paid status changed ' + tag();
  } else {
    val = rmClean_(a.sub);
    if (val.length > 40) { p.errors.push('A sub division name can be at most 40 characters.'); return p; }
    if (/^[=+\-@]/.test(val)) { p.errors.push('A sub division can\'t start with = + - or @.'); return p; }
    if (val.indexOf('|') >= 0) { p.errors.push('A sub division can\'t contain the "|" character.'); return p; }
    // reuse the spelling already in use ("chaos" -> "Chaos") so the list doesn't fill with near-duplicates
    const existing = rmSubOptions_(ctx).filter((o) => rmNK_(o.name) === rmNK_(val))[0];
    if (existing) val = existing.name;
    else if (val) rmChange_(p, RM_CFG.TAB.REG, '"' + val + '" is a new sub division (no other team uses it yet).');
    if (old === val) { p.errors.push('The sub division is already ' + (val ? '"' + val + '"' : 'blank') + '.'); return p; }
    p.title = val ? 'Set ' + t.team + ' to sub division "' + val + '"' : 'Clear the sub division for ' + t.team;
    p.confirmLabel = val ? 'Save sub division' : 'Clear sub division';
    logName = 'Sub division changed ' + tag();
  }
  p.ops.push({ t: 'set', tab: 'REG', row: t.regRow.r, col: ci + 1, value: val, noFormula: true });
  rmChange_(p, RM_CFG.TAB.REG, 'Row ' + t.regRow.r + ' (' + t.key + '): ' + hdr + ' ' + (old ? '"' + old + '"' : '(blank)') + ' → ' + (val ? '"' + val + '"' : '(blank)') + '.');
  rmLogOp_(p, t.key, logName, old, val);
  p.meta.team = t; p.meta.kind = kind; p.meta.value = val; p.meta.hdr = hdr;
  return p;
}

export function rmPlan_(ctx, a) {
  if (a.type === 'setPaid') return rmPlanSetRegCell_(ctx, a, 'paid');
  if (a.type === 'setSub') return rmPlanSetRegCell_(ctx, a, 'sub');
  if (a.type === 'add') return rmPlanAdd_(ctx, a);
  if (a.type === 'edit') return rmPlanEdit_(ctx, a);
  if (a.type === 'delete') return rmPlanDelete_(ctx, a);
  if (a.type === 'movePlayer') return rmPlanMovePlayer_(ctx, a);
  const p = rmNewPlan_('?');
  p.errors.push('Unknown action.');
  return p;
}

/* ---------- after-the-fact verification (run on a fresh read) ---------- */

export function rmVerify_(ctx, a, plan) {
  const checks = [], H = RM_CFG.H, ok = (good, msg) => { checks.push({ ok: !!good, msg }); };
  if (plan.action === 'setPaid' || plan.action === 'setSub') {
    const tt = rmFindTeam_(ctx, plan.meta.team.key);
    ok(!!tt, 'Team still found on Registrations');
    if (tt) ok(rmClean_(rmG_(ctx.reg, tt.regRow, plan.meta.hdr)) === plan.meta.value, plan.meta.hdr + ' on Registrations now reads ' + (plan.meta.value ? '"' + plan.meta.value + '"' : 'blank'));
    return checks;
  }
  if (plan.action === 'movePlayer') {
    const m = plan.meta, from = rmFindTeam_(ctx, m.fromKey), to = rmFindTeam_(ctx, m.toKey), W = H.WV;
    const on = (t) => t ? rmMembers_(ctx, t).filter((x) => rmNK_(x.name) === rmNK_(m.name)).length : -1;
    ok(on(to) === 1, 'On ' + m.toKey + ' exactly once'); ok(on(from) === 0, 'Gone from ' + m.fromKey);
    if (to) {
      const row = rmMembers_(ctx, to).filter((x) => rmNK_(x.name) === rmNK_(m.name))[0];
      if (row) { const r = ctx.pl.rows.filter((q) => q.r === row.row)[0]; ok(rmG_(ctx.pl, r, H.PL.key) === m.newKey, 'Lookup key is correct'); }
    }
    m.waiverRows.forEach((n) => {
      const w = ctx.wv.rows.filter((r) => r.r === Number(n))[0];
      ok(w && rmG_(ctx.wv, w, W.key) === m.newKey && rmIsLinked_(ctx, w), 'Waiver row ' + n + ' follows the player');
    });
    if (from) ok(rmPlayersOf_(ctx, from.regRow).every((x) => rmNK_(x) !== rmNK_(m.name)), 'Removed from ' + m.fromKey + ' on Registrations');
    return checks;
  }
  const t = rmFindTeam_(ctx, a.teamKey || (plan.meta.team && plan.meta.team.key));
  if (!t) { ok(false, 'Team still found on Registrations'); return checks; }
  const members = rmMembers_(ctx, t), count = (nm) => members.filter((m) => rmNK_(m.name) === rmNK_(nm));
  const players = rmPlayersOf_(ctx, t.regRow).map(rmNK_);
  const hpHas = (nm) => {
    if (!RM_CFG.UPDATE_HISTORY || !ctx.hp) return null;
    const hk = rmHistKey_(ctx.year, t.team, t.division, nm);
    let n = 0;
    ctx.hp.rows.forEach((row) => { if (rmClean_(rmG_(ctx.hp, row, H.HP.key)) === hk) n++; });
    return n;
  };
  if (plan.action === 'add') {
    const nm = plan.meta.name, mm = count(nm);
    ok(mm.length === 1, 'On the Participant List exactly once');
    if (mm.length === 1) {
      const row = ctx.pl.rows.filter((r) => r.r === mm[0].row)[0];
      ok(rmG_(ctx.pl, row, H.PL.key) === plan.meta.newKey && rmG_(ctx.pl, row, H.PL.trim) === rmNK_(nm), 'Lookup key and trim name are correct');
    }
    ok(players.indexOf(rmNK_(nm)) >= 0 || players.indexOf('') < 0, 'In a Player cell on Registrations (or the row was already full)');
    plan.meta.linkRows.forEach((r) => {
      const wr = ctx.wv.rows.filter((x) => x.r === r)[0];
      ok(wr && rmG_(ctx.wv, wr, H.WV.key) === plan.meta.newKey && rmNK_(rmG_(ctx.wv, wr, H.WV.found)) === 'yes', 'Waiver row ' + r + ' is linked');
    });
    const h1 = hpHas(nm); if (h1 !== null) ok(h1 === 1, 'History has one ' + ctx.year + ' row for this name');
  } else if (plan.action === 'edit') {
    const o = plan.meta.oldName, n2 = plan.meta.newName, caseOnly = rmNK_(o) === rmNK_(n2);
    const exact = (nm) => members.filter((m) => m.name === nm).length;
    ok(caseOnly ? exact(o) === 0 : count(o).length === 0, 'Old name is gone from the Participant List');
    ok(count(n2).length === 1, 'New name is on the Participant List once');
    ok(caseOnly || rmLinkedWaivers_(ctx, t, o).length === 0, 'No waiver still points at the old name');
    ok(caseOnly ? true : players.indexOf(rmNK_(o)) < 0, 'Old name is gone from the Registrations player cells');
    const hh = hpHas(o); if (hh !== null) ok(caseOnly ? hh === 1 : hh === 0, caseOnly ? 'History row is still there once' : 'Old history key is gone');
    if (count(n2).length === 1) {
      const r2 = ctx.pl.rows.filter((r) => r.r === count(n2)[0].row)[0];
      ok(rmG_(ctx.pl, r2, H.PL.key) === plan.meta.newKey && rmG_(ctx.pl, r2, H.PL.trim) === rmNK_(n2), 'Lookup key and trim name are correct');
    }
  } else if (plan.action === 'delete') {
    const d = plan.meta.name;
    ok(count(d).length === 0, 'Gone from the Participant List');
    ok(players.indexOf(rmNK_(d)) < 0, 'Gone from the Registrations player cells');
    const hd = hpHas(d); if (hd !== null) ok(hd === 0, 'Gone from history');
    if (!plan.meta.killWaivers) ok(rmLinkedWaivers_(ctx, t, d).every((w) => !rmIsLinked_(ctx, w)), 'Waivers kept and marked unmatched');
  }
  return checks;
}

/** Whitelist + clamp an action coming from the browser (mirrors rmCleanAction_ in RM_Server.gs). */
export function rmCleanAction_(a) {
  a = a || {};
  const out = { type: String(a.type || '') };
  ['teamKey', 'name', 'oldName', 'newName', 'regName'].forEach((k) => { if (a[k] != null) out[k] = String(a[k]).slice(0, 300); });
  if (a.paid != null) out.paid = String(a.paid).slice(0, 5);
  if (a.sub != null) out.sub = String(a.sub).slice(0, 80);
  if (a.toTeamKey != null) out.toTeamKey = String(a.toTeamKey).slice(0, 300);
  if (a.linkWaiverRow != null && a.linkWaiverRow !== '') out.linkWaiverRow = Number(a.linkWaiverRow);
  out.quick = a.quick === true; out.ack = a.ack === true; out.deleteWaivers = a.deleteWaivers === true;
  return out;
}
