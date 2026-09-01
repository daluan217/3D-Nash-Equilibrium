/**
 * BLUE — WINDOW 3 REACH MEASUREMENT for the OPTION-LABEL CHANNEL.
 *
 * RED 2 measured that all six label/name-borne magnitude claims reach the user,
 * AND that magnitude-BEARING label pairs occur in 16-40% of cloud output and
 * 36-56% of local. Those two facts together define the whole problem: the channel
 * is wide open, and the obvious gate would reject a third of good output.
 *
 * So this script does not propose a gate. It MEASURES, over every stored
 * scenario this campaign has collected, how often each candidate PREDICATE fires
 * on real, gate-passing model output. A predicate that fires on real output is a
 * predicate that would reject real output, because with post-hoc rewriting closed
 * a gate's only action is to reject.
 *
 * Every hit is printed in full, with its source row, so the question "is that a
 * false positive?" is answerable by reading rather than by trusting a rate.
 *
 *   npx tsx _gen/blue_w3_reach.mjs
 */
import { readFileSync, existsSync } from 'node:fs';

const SCRATCH = '/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad';
const CORPORA = [
  // RED 1 — 344 draws, adversarial matrix tags, carries the matrix as `g`
  [`${SCRATCH}/rt1.jsonl`, 'rt1'],
  [`${SCRATCH}/rt2.jsonl`, 'rt2'],
  [`${SCRATCH}/pilot.jsonl`, 'rt1pilot'],
  // RED 2 — domain rotation corpora, matrix as `game`
  ['/tmp/rt2_local.jsonl', 'r2local'],
  ['/tmp/rt2_cloud.jsonl', 'r2cloud'],
  ['/tmp/rt2_pilot.jsonl', 'r2pilot'],
  ['/tmp/rt2_cloudpilot.jsonl', 'r2cloudpilot'],
  // RED 2 — the STAKES corpora, the ones the label finding was measured on
  ['/tmp/rt2_stakes_local.jsonl', 'stlocal'],
  ['/tmp/rt2_stakes_cloud.jsonl', 'stcloud'],
  ['/tmp/rt2_stakes_cloud_hint.jsonl', 'sthint'],
  ['/tmp/rt2_stakes_pilot.jsonl', 'stpilot'],
];

const rows = [];
for (const [f, tag] of CORPORA) {
  if (!existsSync(f)) { console.log(`  (missing ${f})`); continue; }
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r.sc) continue;
    rows.push({ src: tag, i: r.i ?? r.pair, sc: r.sc, g: r.g ?? r.game ?? null, gate: r.gate ?? null });
  }
}
// A predicate is only a FALSE POSITIVE risk on output the gate already accepts:
// a draw the gate already rejects cannot be newly rejected by anything.
const passing = rows.filter((r) => r.gate?.ok !== false && r.gate?.passes !== false);
console.log(`corpora loaded: ${rows.length} stored scenarios, ${passing.length} of them gate-passing\n`);
const bySrc = new Map();
for (const r of passing) bySrc.set(r.src, (bySrc.get(r.src) ?? 0) + 1);
console.log('  ' + [...bySrc].map(([k, v]) => `${k}=${v}`).join('  ') + '\n');

// ── CANDIDATE PREDICATES ────────────────────────────────────────────────────
// Each is a candidate for the SHIPPING gate. None of them is in the product yet.
const NUMWORD = String.raw`(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)`;

const CANDIDATES = [
  // ── DECIDABLE: a digit that is not a matrix-checked payoff annotation ──
  ['A1  digit anywhere in an option label', (sc) =>
    ['row1', 'row2', 'col1', 'col2'].filter((k) => /\d/.test(String(sc[k] ?? '')))],
  ['A2  digit in an option label, OUTSIDE parentheses', (sc) =>
    ['row1', 'row2', 'col1', 'col2'].filter((k) => /\d/.test(String(sc[k] ?? '').replace(/\([^)]*\)/g, '')))],
  ['A3  digit in the NAME', (sc) => (/\d/.test(String(sc.name ?? '')) ? ['name'] : [])],

  // ── DECIDABLE: explicit multiplier morphology, any authored field ──
  ['B1  N-fold, number stem only', (sc) => fields(sc).filter(([, v]) =>
    new RegExp(String.raw`\b${NUMWORD}\s?fold\b|\b\d+\s?-?fold\b`, 'i').test(v)).map(([k]) => k)],
  ['B2  Nx / N times more|less|larger|... ', (sc) => fields(sc).filter(([, v]) =>
    new RegExp(String.raw`\b\d+\s?[x×]\b|\b(?:${NUMWORD}|\d+)\s+times\s+(?:more|less|larger|smaller|greater|bigger|higher|lower|worse|better|as\s+\w+)\b`, 'i').test(v)).map(([k]) => k)],
  ['B3  orders of magnitude', (sc) => fields(sc).filter(([, v]) =>
    /\borders?\s+of\s+magnitude\b/i.test(v)).map(([k]) => k)],
  ['B4  percent / percentage', (sc) => fields(sc).filter(([, v]) =>
    /\bper\s?cent(?:age)?\b|%/i.test(v)).map(([k]) => k)],

  // ── NOT DECIDABLE — measured only to show WHY they are excluded. ──
  ['X1  (excluded) total-vs-nothing label pair', (sc) => {
    const TOT = /\b(?:full|total|complete|entire|maximum|max|all|everything)\b/i;
    const NIL = /\b(?:no|none|zero|nothing|nil|neither)\b/i;
    const out = [];
    for (const [a, b, nm] of [[sc.row1, sc.row2, 'row'], [sc.col1, sc.col2, 'col']]) {
      if (!a || !b) continue;
      if ((TOT.test(a) && NIL.test(b)) || (NIL.test(a) && TOT.test(b))) out.push(nm);
    }
    return out;
  }],
  ['X2  (excluded) any magnitude-ish modifier in a label pair', (sc) => {
    const M = /\b(?:full|total|complete|entire|maximum|max|all|none|no|zero|nothing|large|small|bulk|premium|budget|economy|express|priority|high|low|surge|routine|deep|light|heavy|reduce|maintain|extra|minimal|intensive|rush|standard)\b/i;
    return ['row1', 'row2', 'col1', 'col2'].filter((k) => M.test(String(sc[k] ?? '')));
  }],
];

function fields(sc) {
  return [['name', String(sc.name ?? '')], ['row1', String(sc.row1 ?? '')], ['row2', String(sc.row2 ?? '')],
    ['col1', String(sc.col1 ?? '')], ['col2', String(sc.col2 ?? '')], ['description', String(sc.description ?? '')]];
}

console.log('── REACH of each candidate against gate-PASSING real output ──');
console.log('   (a hit here is output this predicate would REJECT if it shipped)\n');
for (const [label, pred] of CANDIDATES) {
  const hits = [];
  for (const r of passing) {
    let where; try { where = pred(r.sc); } catch (e) { where = [`THREW:${e.message}`]; }
    if (where.length) hits.push({ r, where });
  }
  const pct = (100 * hits.length / passing.length).toFixed(2);
  console.log(`${label}\n    ${hits.length}/${passing.length} = ${pct}%`);
  const show = label.startsWith('X') ? 6 : hits.length;
  for (const h of hits.slice(0, show)) {
    const s = h.r.sc;
    console.log(`      ${h.r.src}#${h.r.i} [${h.where.join(',')}]  "${s.name}"  ${s.row1} / ${s.row2}  |  ${s.col1} / ${s.col2}`);
    if (h.where.includes('description')) console.log(`         desc: ${String(s.description).slice(0, 220)}`);
  }
  if (hits.length > show) console.log(`      … ${hits.length - show} more not printed`);
  console.log('');
}
