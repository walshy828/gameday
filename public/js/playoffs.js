// public/js/playoffs.js
// Renders the PLAYOFFS tab's bracket, ported from the bracket widget built
// for scoreboard.html (see public/scoreboard.html's "PLAYOFF BRACKET"
// section). Reuses App.data.allScheduleData — no new data source.

const BRK = {
  BOX_H:  46,   // match card height (2 team rows)
  LEAF_H: 32,   // vertical space per entrant slot in the first column
  COL_W:  186,  // round column width
  GAP_W:  36,   // horizontal gap between rounds (connector space)
  HDR_H:  30,   // round header height
  PAD_T:  10,   // gap between headers and the first card
  MIN_SCALE: 0.4
};

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

function isReported(g) {
  const w = (g.winner || '').trim();
  return w !== '' && w !== 'TBA' && w !== '—';
}

function isPlayoff(g) {
  return /^P\s*\d/i.test((g.match || '').trim()) || /^P\d/i.test((g.roundTime || '').trim());
}

function matchNum(g) {
  const m = /^\s*P\s*(\d+)\s*$/i.exec(g.match || '');
  return m ? +m[1] : null;
}

// "Winner P3" / "Winner of P3" / "W P3" → 3
function placeholderRef(name) {
  const m = /^\s*(?:winner|w)\s*(?:of\s*)?[-:]?\s*P\s*(\d+)\s*$/i.exec(name || '');
  return m ? +m[1] : null;
}

function isBlankSlot(name) {
  const n = (name || '').trim();
  return !n || /^(tbd|tba|—|-)$/i.test(n);
}

function isByeSlot(name) {
  return /^\s*bye\s*$/i.test(name || '');
}

// A slot holding an actual team, as opposed to a bye, a blank, or an
// unresolved "Winner P3" pointer.
function isRealTeamSlot(slot) {
  return !isBlankSlot(slot.raw) && !isByeSlot(slot.raw) && placeholderRef(slot.raw) === null;
}

function normTeam(name) {
  return (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function teamSeed(name) {
  const m = /\(#(\d+)\)/.exec(name || '');
  return m ? m[1] : null;
}

function teamLabel(name) {
  return (name || '').replace(/\s*\(#\d+\)\s*$/, '').trim();
}

// "P3.Quarterfinals [1]" → "Quarterfinals"
function cleanRoundLabel(rt) {
  let s = (rt || '').trim();
  s = s.replace(/^P\s*\d+\s*[.\-:_]?\s*/i, '');
  s = s.replace(/\s*[\[(]\s*\d+\s*[\])]\s*$/, '');
  return s.trim();
}

function defaultRoundLabel(depth) {
  if (depth === 0) return 'Final';
  if (depth === 1) return 'Semifinals';
  if (depth === 2) return 'Quarterfinals';
  return `Round of ${Math.pow(2, depth + 1)}`;
}

// ── Build the bracket tree from the playoff rows ────────────────────
function buildBracketTree(pGames) {
  const nodes = [];
  pGames.forEach(g => {
    const num = matchNum(g);
    if (num === null) return;
    nodes.push({
      num, g,
      slots: [
        { raw: g.team1 || '', feeder: null },
        { raw: g.team2 || '', feeder: null }
      ],
      parent: null, depth: 0, span: 1, y: 0
    });
  });
  if (!nodes.length) return null;

  nodes.sort((a, b) => a.num - b.num);
  const byNum = new Map(nodes.map(n => [n.num, n]));

  // Winners of matches that nothing has advanced from yet, newest first.
  const unclaimed = new Map();

  nodes.forEach(node => {
    node.slots.forEach(slot => {
      const ref = placeholderRef(slot.raw);
      if (ref !== null) {
        const feeder = byNum.get(ref);
        // Only accept a backwards reference — forward/self refs would cycle.
        if (feeder && feeder.num < node.num && feeder.parent === null) {
          slot.feeder = feeder;
          feeder.parent = node;
          const list = unclaimed.get(normTeam(feeder.g.winner));
          if (list) {
            const i = list.indexOf(feeder);
            if (i >= 0) list.splice(i, 1);
          }
        }
        return;
      }
      if (isBlankSlot(slot.raw)) return;

      const list = unclaimed.get(normTeam(slot.raw));
      while (list && list.length) {
        const feeder = list.pop();
        if (feeder.num < node.num && feeder.parent === null) {
          slot.feeder = feeder;
          feeder.parent = node;
          break;
        }
      }
    });

    if (isReported(node.g)) {
      const key = normTeam(node.g.winner);
      if (key) {
        if (!unclaimed.has(key)) unclaimed.set(key, []);
        unclaimed.get(key).push(node);
      }
    }
  });

  // Depth = rounds remaining, measured from each root (a match nothing
  // advances out of — normally the final).
  const roots = nodes.filter(n => n.parent === null).sort((a, b) => b.num - a.num);
  let maxDepth = 0;
  roots.forEach(r => (function walk(node, depth) {
    node.depth = depth;
    if (depth > maxDepth) maxDepth = depth;
    node.slots.forEach(s => { if (s.feeder) walk(s.feeder, depth + 1); });
  })(r, 0));

  // ── Byes ─────────────────────────────────────────────────────────
  // A team seeded straight into a later round leaves a hole in the
  // column before it. Fill each hole with a "team vs BYE" card the team
  // has already won, so every round reads as a complete draw.
  const entrantsByCol = new Array(maxDepth + 1).fill(0);
  nodes.forEach(n => n.slots.forEach(s => {
    if (!s.feeder && isRealTeamSlot(s)) entrantsByCol[maxDepth - n.depth]++;
  }));
  let mainCol = 0;
  entrantsByCol.forEach((count, c) => { if (count > entrantsByCol[mainCol]) mainCol = c; });

  // Right to left, so a team byeing through more than one round picks
  // up a card in every round it sat out, down to the main column.
  for (let c = maxDepth; c > mainCol; c--) {
    nodes.filter(n => maxDepth - n.depth === c).forEach(node => {
      node.slots.forEach(slot => {
        if (slot.feeder || !isRealTeamSlot(slot)) return;
        const bye = {
          num: null, isBye: true, parent: node, depth: node.depth + 1, span: 2, y: 0,
          g: { team1: slot.raw, team2: 'BYE', winner: slot.raw, roundTime: '', match: '' },
          slots: [{ raw: slot.raw, feeder: null }, { raw: 'BYE', feeder: null }]
        };
        slot.feeder = bye;
        nodes.push(bye);
      });
    });
  }

  // Vertical placement: every slot without a feeder occupies one leaf
  // unit; a match sits at the midpoint of its two feed points.
  let cursor = 0;
  function place(node, offset) {
    let o = offset;
    const points = [];
    node.slots.forEach(slot => {
      if (slot.feeder) {
        place(slot.feeder, o);
        points.push(slot.feeder.y);
        o += slot.feeder.span;
      } else {
        points.push(o + 0.5);
        o += 1;
      }
    });
    node.span = Math.max(o - offset, 1);
    node.y = points.length ? points.reduce((a, b) => a + b, 0) / points.length
                           : offset + node.span / 2;
  }
  roots.forEach(r => { place(r, cursor); cursor += r.span; });

  return { nodes, roots, cols: maxDepth + 1, leaves: cursor };
}

function bracketTeamRowHTML(node, i) {
  const slot = node.slots[i];
  const raw  = slot.raw;

  let text, placeholder = false, bye = false;
  if (isByeSlot(raw)) {
    text = 'Bye';
    bye = true;
  } else if (slot.feeder && !slot.feeder.isBye && !isReported(slot.feeder.g)) {
    text = `Winner of P${slot.feeder.num}`;
    placeholder = true;
  } else if (placeholderRef(raw) !== null) {
    text = `Winner of P${placeholderRef(raw)}`;
    placeholder = true;
  } else if (isBlankSlot(raw)) {
    text = 'TBD';
    placeholder = true;
  } else {
    text = teamLabel(raw);
  }

  const decided  = isReported(node.g);
  const isWinner = decided && !placeholder && !bye && normTeam(node.g.winner) === normTeam(raw);

  let cls = 'bracket-team-row';
  if (bye) cls += ' bye';
  else if (placeholder) cls += ' placeholder';
  else if (isWinner) cls += ' winner';
  else if (decided) cls += ' eliminated';

  const seed = bye ? '–' : placeholder ? '?' : (teamSeed(raw) || '—');

  return `
    <div class="${cls}">
      <div class="bt-seed">${esc(seed)}</div>
      <div class="bt-name">${esc(text)}</div>
      ${isWinner ? '<span class="bt-win-label">W</span>' : ''}
    </div>
  `;
}

// Scale the canvas down so the whole bracket fits the view, however
// many rounds a division has. Below MIN_SCALE we let it scroll instead.
function fitBracket() {
  const fit    = document.getElementById('playoffs-bracket-fit');
  const canvas = document.getElementById('playoffs-bracket-canvas');
  if (!fit || !canvas) return;

  const natW = parseFloat(canvas.style.width);
  const natH = parseFloat(canvas.style.height);
  if (!natW || !natH) return;

  const availW = fit.clientWidth;
  if (!availW) return;
  const availH = window.innerHeight * 0.62;

  // `zoom` rather than `transform: scale()` so the scaled box still
  // drives layout — otherwise the scroll container reserves room for
  // the unscaled canvas and shows phantom scrollbars.
  const scale = Math.max(BRK.MIN_SCALE, Math.min(1, availW / natW, availH / natH));
  if (canvas.dataset.scale === String(scale)) return;
  canvas.dataset.scale = String(scale);
  canvas.style.zoom = String(scale);
}

function renderPlayoffsView() {
  const body  = document.getElementById('playoffs-bracket-body');
  const badge = document.getElementById('playoffs-match-count');
  if (!body) return;

  const schedule = App.data.allScheduleData || [];
  const tree = buildBracketTree(schedule.filter(isPlayoff));
  if (!tree) {
    if (badge) badge.textContent = '';
    body.innerHTML = '<div class="bracket-empty-state">Bracket will appear here once playoffs begin.</div>';
    return;
  }

  const { nodes, roots, cols, leaves } = tree;
  const realCount = nodes.filter(n => !n.isBye).length;
  if (badge) badge.textContent = `${realCount} MATCH${realCount !== 1 ? 'ES' : ''}`;

  // Column 0 is the earliest round, column cols-1 the final.
  const colOf   = n => cols - 1 - n.depth;
  const colX    = c => c * (BRK.COL_W + BRK.GAP_W);
  const centerY = n => BRK.HDR_H + BRK.PAD_T + n.y * BRK.LEAF_H;

  const finalNode  = roots[0];
  const champion   = finalNode && isReported(finalNode.g) ? finalNode.g.winner : null;
  const canvasW    = cols * BRK.COL_W + (cols - 1) * BRK.GAP_W + (champion ? BRK.GAP_W + BRK.COL_W : 0);
  const canvasH    = BRK.HDR_H + BRK.PAD_T + leaves * BRK.LEAF_H + BRK.BOX_H / 2 + 6;

  // ── Round headers ────────────────────────────────────────────────
  const byCol = Array.from({ length: cols }, () => []);
  nodes.forEach(n => byCol[colOf(n)].push(n));

  const headers = byCol.map((colNodes, c) => {
    // Bye cards carry no round name or match id — label the column from
    // the real games in it.
    const real = colNodes.filter(n => !n.isBye);
    const counts = new Map();
    real.forEach(n => {
      const l = cleanRoundLabel(n.g.roundTime);
      if (l) counts.set(l, (counts.get(l) || 0) + 1);
    });
    let label = defaultRoundLabel(cols - 1 - c);
    let best = 0;
    counts.forEach((v, k) => { if (v > best) { best = v; label = k; } });

    const nums = real.map(n => n.num).sort((a, b) => a - b);
    const key  = nums.length === 0 ? ''
               : nums.length > 1  ? `P${nums[0]}–P${nums[nums.length - 1]}`
                                  : `P${nums[0]}`;

    return `
      <div class="bracket-round-hdr" style="left:${colX(c)}px;top:0;width:${BRK.COL_W}px;height:${BRK.HDR_H}px">
        <span>${esc(label)}</span>
        <span class="round-key">${esc(key)}</span>
      </div>
    `;
  }).join('');

  // ── Connectors ───────────────────────────────────────────────────
  const lines = [];
  nodes.forEach(node => {
    const nx = colX(colOf(node));
    const ny = centerY(node);
    const midX = nx - BRK.GAP_W / 2;
    node.slots.forEach((slot, i) => {
      if (!slot.feeder) return;
      const fx = colX(colOf(slot.feeder)) + BRK.COL_W;
      const fy = centerY(slot.feeder);
      const slotY = ny - BRK.BOX_H / 4 + i * (BRK.BOX_H / 2);
      const decided = isReported(slot.feeder.g);
      const clr = decided ? 'rgba(224,184,99,.42)' : 'rgba(255,255,255,.16)';
      const w   = decided ? 1.6 : 1.2;
      lines.push(
        `<path d="M ${fx} ${fy} H ${midX} V ${slotY} H ${nx}" fill="none" stroke="${clr}" stroke-width="${w}"/>`
      );
    });
  });

  // ── Match cards ──────────────────────────────────────────────────
  const cards = nodes.map(node => {
    const x = colX(colOf(node));
    const y = centerY(node) - BRK.BOX_H / 2;
    const ready = !isReported(node.g) && node.slots.every(isRealTeamSlot);
    const gold  = node === finalNode && champion;
    const tag   = node.isBye ? 'BYE' : `P${node.num}`;
    return `
      <div class="bracket-match${gold ? ' champion' : ''}${ready ? ' live' : ''}${node.isBye ? ' is-bye' : ''}"
           style="left:${x}px;top:${y}px;width:${BRK.COL_W}px;height:${BRK.BOX_H}px">
        ${bracketTeamRowHTML(node, 0)}
        ${bracketTeamRowHTML(node, 1)}
      </div>
      <span class="bracket-match-tag${gold ? ' champion' : ''}${node.isBye ? ' is-bye' : ''}" style="left:${x + 8}px;top:${y - 7}px">${tag}</span>
    `;
  }).join('');

  const champHTML = champion ? `
    <div class="bracket-champ"
         style="left:${colX(cols - 1) + BRK.COL_W + BRK.GAP_W}px;top:${centerY(finalNode) - BRK.BOX_H / 2}px;width:${BRK.COL_W}px;height:${BRK.BOX_H}px">
      <span>🏆</span>
      <span class="bc-name">
        <span class="bc-label" style="display:block">CHAMPION</span>
        ${esc(teamLabel(champion))}
      </span>
    </div>
  ` : '';

  body.innerHTML = `
    <div class="bracket-fit" id="playoffs-bracket-fit">
      <div class="bracket-canvas" id="playoffs-bracket-canvas" style="width:${canvasW}px;height:${canvasH}px">
        <svg class="bracket-conn-layer" viewBox="0 0 ${canvasW} ${canvasH}" width="${canvasW}" height="${canvasH}">${lines.join('')}</svg>
        ${headers}
        ${cards}
        ${champHTML}
      </div>
    </div>
  `;

  fitBracket();
}

if (window.ResizeObserver) {
  const bracketRO = new ResizeObserver(() => fitBracket());
  document.addEventListener('DOMContentLoaded', () => {
    const b = document.getElementById('playoffs-bracket-body');
    if (b) bracketRO.observe(b);
  });
}
window.addEventListener('resize', fitBracket);

export { renderPlayoffsView };
