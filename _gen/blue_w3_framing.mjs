/**
 * BLUE — WINDOW 3: the FRAMING family, 4 of RED 1's 9 remaining oracle holes.
 *
 *   ZERO-SUM + cooperative framing     "work together toward the same goal"
 *   ZERO-SUM + explicit shared goal     on a matrix that is exactly +100/-100
 *   COMMON INTEREST + adversarial       "fight for the same order" where the two
 *                                       players' payoffs are IDENTICAL in every cell
 *   A-FLAT + "B determines A's outcome" where A earns the same in all four cells
 *
 * These belong together because the MATRIX SIDE IS EXACT, not heuristic:
 *   zero-sum        a_ij + b_ij is the same constant in all four cells
 *   common interest a_ij == b_ij in all four cells
 *   A-flat          a11 == a12 and a21 == a22 (B's column cannot move A)
 * There is no tolerance to tune and no equilibrium to compute. That bounds the
 * false-positive risk structurally: the rule cannot fire at all on an ordinary
 * matrix, however the sentence is worded.
 *
 * So the only open question is the LANGUAGE side, and this script prices it the
 * way the negotiation window was priced — against every stored draw, printing
 * hits, and separately against the subset of draws whose matrix actually meets
 * the condition, which is the only place a rule would fire.
 *
 *   npx tsx _gen/blue_w3_framing.mjs
 */
import { readFileSync, existsSync } from 'node:fs';

const S = '/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad';
const stakesGame = (k) => ({ a11: k, a12: 0, a21: 0, a22: k, b11: 0, b12: k, b21: k, b22: 0 });
const CORPORA = [
  [`${S}/rt1.jsonl`, 'rt1'], [`${S}/rt2.jsonl`, 'rt2'], [`${S}/pilot.jsonl`, 'rt1pilot'],
  ['/tmp/rt2_local.jsonl', 'r2local'], ['/tmp/rt2_cloud.jsonl', 'r2cloud'],
  ['/tmp/rt2_pilot.jsonl', 'r2pilot'], ['/tmp/rt2_cloudpilot.jsonl', 'r2cloudpilot'],
  ['/tmp/rt2_stakes_local.jsonl', 'stlocal'], ['/tmp/rt2_stakes_cloud.jsonl', 'stcloud'],
  ['/tmp/rt2_stakes_cloud_hint.jsonl', 'sthint'], ['/tmp/rt2_stakes_pilot.jsonl', 'stpilot'],
];
const rows = [];
for (const [f, tag] of CORPORA) {
  if (!existsSync(f)) continue;
  for (const l of readFileSync(f, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (!r.sc) continue;
    const g = r.g ?? r.game ?? (r.spread != null ? stakesGame(r.spread) : null);
    rows.push({ src: tag, i: r.i ?? r.pair, sc: r.sc, d: String(r.sc.description ?? ''), g });
  }
}
const withG = rows.filter((r) => r.g);
console.log(`corpus: ${rows.length} stored scenarios, ${withG.length} with a matrix\n`);

// ── The exact matrix predicates ─────────────────────────────────────────────
const eq = (x, y) => Math.abs(x - y) < 1e-9;
const isZeroSum = (g) => {
  const k = g.a11 + g.b11;
  return eq(g.a12 + g.b12, k) && eq(g.a21 + g.b21, k) && eq(g.a22 + g.b22, k);
};
const isCommon = (g) => eq(g.a11, g.b11) && eq(g.a12, g.b12) && eq(g.a21, g.b21) && eq(g.a22, g.b22);
const aFlat = (g) => eq(g.a11, g.a12) && eq(g.a21, g.a22);
const bFlat = (g) => eq(g.b11, g.b21) && eq(g.b12, g.b22);

const zs = withG.filter((r) => isZeroSum(r.g));
const ci = withG.filter((r) => isCommon(r.g));
const af = withG.filter((r) => aFlat(r.g) || bFlat(r.g));
console.log('── How often does each matrix condition even HOLD in the corpus? ──');
console.log(`  exactly zero-sum (constant-sum)      : ${zs.length}/${withG.length}`);
console.log(`  exactly common interest (a == b)     : ${ci.length}/${withG.length}`);
console.log(`  one player's payoffs FLAT in the other's choice: ${af.length}/${withG.length}\n`);

// ── The language side ───────────────────────────────────────────────────────
const COOP = /\b(?:work(?:s|ing)?\s+together|the\s+same\s+goal|a\s+shared\s+goal|common\s+goal|mutual\s+benefit|both\s+benefit|jointly\s+benefit|shared\s+interest|same\s+interest|allies|partnership\s+goal|for\s+their\s+mutual)\b/i;
const ADVERSARIAL = /\b(?:fight(?:s|ing)?\s+(?:for|over)|compet(?:e|es|ing)\s+(?:for|over|against)|rival|battle(?:s|ing)?\s+(?:for|over)|contest(?:s|ing)?|outbid|beat\s+the\s+other|at\s+odds|opposed\s+interests|conflicting\s+interests)\b/i;
const DETERMINES = /\b(?:determines?|dictates?|drives?|controls?|sets?)\b[^.;]{0,40}?\b(?:outcome|payoff|return|result|position)\b|\b(?:outcome|payoff|return|result)\b[^.;]{0,30}?\b(?:is|are)\s+determined\s+by\b/i;

const LANG = [
  ['COOP  cooperative / shared-goal framing', COOP],
  ['ADV   adversarial / competitive framing', ADVERSARIAL],
  ['DET   "X determines the outcome"', DETERMINES],
];
console.log('── LANGUAGE reach across the WHOLE corpus (not yet conditioned) ──');
for (const [label, re] of LANG) {
  const hits = rows.filter((r) => re.test(r.d));
  console.log(`${label}\n    ${hits.length}/${rows.length} = ${(100 * hits.length / rows.length).toFixed(2)}%`);
  for (const h of hits.slice(0, 8)) console.log(`      ${h.src}#${h.i}: ${h.d.slice(0, 200)}`);
  if (hits.length > 8) console.log(`      … ${hits.length - 8} more`);
  console.log('');
}

// ── THE ACTUAL RULE: language AND the matrix condition that makes it false ──
console.log('── CONDITIONED: what a shipped rule would actually reject ──');
const RULES = [
  ['R1  cooperative framing on an exactly ZERO-SUM matrix', (r) => isZeroSum(r.g) && COOP.test(r.d)],
  ['R2  adversarial framing on an exactly COMMON-INTEREST matrix', (r) => isCommon(r.g) && ADVERSARIAL.test(r.d)],
  ['R3  "determines the outcome" where that player\'s choice provably cannot',
    (r) => DETERMINES.test(r.d) && (aFlat(r.g) || bFlat(r.g))],
];
for (const [label, pred] of RULES) {
  const hits = withG.filter(pred);
  console.log(`${label}\n    ${hits.length}/${withG.length} = ${(100 * hits.length / withG.length).toFixed(2)}%`);
  for (const h of hits) console.log(`      ${h.src}#${h.i}: ${h.d.slice(0, 260)}`);
  console.log('');
}

// ── The oracle's own cases must be caught, and its controls must not be. ────
const G = (a11, b11, a12, b12, a21, b21, a22, b22) => ({ a11, a12, a21, a22, b11, b12, b21, b22 });
const MP = G(100, -100, -100, 100, -100, 100, 100, -100);
const COORD = G(4, 4, 0, 0, 0, 0, 2, 2);
const AFLAT = G(5, 0, 5, 3, 5, -3, 5, 1);
const PLAIN = G(3, 1, 0, 4, 5, 2, 1, 6);
console.log('── RED 1 oracle cases against these predicates ──');
const CASES = [
  ['HOLE  zero-sum + cooperative framing', MP, 'An antique store and a restoration company are coordinating a new display. The store books a slot while the restorer books a window.', true],
  ['HOLE  zero-sum + explicit shared goal', MP, 'A store and a restorer work together toward the same goal for the display. Each books its own slot for the season.', true],
  ['HOLE  common interest + adversarial framing', COORD, 'A textile company and a competing manufacturer fight for the same order. Each books its own dyeing slot for the run.', true],
  ['HOLE  A-flat + "B determines A\'s outcome"', AFLAT, 'A roastery picks its supplier for the season. The distribution partner\'s decision will determine the handling and pricing outcome for the roastery.', true],
  ['CTRL  competitive framing on a STRICTLY OPPOSED matrix', MP, 'A store and a competing restorer contest the same display. One books an Early Slot or a Late Slot; the other books a Shared Window or a Separate Window.', false],
  ['CTRL  "their choices determine the payoffs" on an ORDINARY matrix', PLAIN, 'A mill books an Early Slot or a Late Slot for the run. A haulier books a Shared Window or a Separate Window. Their choices determine the resulting payoffs.', false],
  ['CTRL  "the other side\'s choice affects the outcome" where it does', PLAIN, 'A mill books an Early Slot or a Late Slot. A haulier books a Shared Window or a Separate Window, and that choice affects what the mill takes home.', false],
  ['CTRL  a shared physical resource, on an opposed matrix', MP, 'Two hauliers share one loading dock. One books an Early Slot or a Late Slot; the other books a Shared Window or a Separate Window.', false],
  ['CTRL  coordination language on a genuine COORDINATION game', COORD, 'Two rink operators book one resurfacer. Each has an incentive to match the opponent\'s choice of Early Slot or Late Slot.', false],
];
for (const [tag, g, d, shouldFire] of CASES) {
  const fired = [
    isZeroSum(g) && COOP.test(d) ? 'R1' : null,
    isCommon(g) && ADVERSARIAL.test(d) ? 'R2' : null,
    DETERMINES.test(d) && (aFlat(g) || bFlat(g)) ? 'R3' : null,
  ].filter(Boolean);
  const good = shouldFire ? fired.length > 0 : fired.length === 0;
  console.log(`  ${good ? 'ok  ' : 'BAD '} ${fired.length ? fired.join(',') : '--'}   ${tag}`);
}

// ── THE FOURTH HOLE: "coordinating" on an exactly zero-sum matrix. ─────────
// Priced separately because it is the DANGEROUS one: 382 of 890 stored draws
// are exactly constant-sum, so any language this arm gates is gated on 43% of
// the corpus. The other three arms are safe precisely because their matrix
// conditions are rare.
console.log('\n── THE FOURTH HOLE, priced: cooperation language x zero-sum ──');
const COOPWORDS = [
  ['bare "coordinat*"', /\bcoordinat/i],
  ['"coordinating"/"cooperating" as the two actors\' activity', /\b(?:are|is)\s+(?:coordinating|cooperating|collaborating)\b/i],
  ['"joint" / "together" / "partner*"', /\bjoint\b|\btogether\b|\bpartner/i],
  ['COOP (the arm already measured)', COOP],
];
for (const [label, re] of COOPWORDS) {
  const all = rows.filter((r) => re.test(r.d));
  const zsHits = withG.filter((r) => isZeroSum(r.g) && re.test(r.d));
  console.log(`  ${label}`);
  console.log(`      whole corpus     ${all.length}/${rows.length} = ${(100 * all.length / rows.length).toFixed(2)}%`);
  console.log(`      AND zero-sum     ${zsHits.length}/${withG.length} = ${(100 * zsHits.length / withG.length).toFixed(2)}%   <-- what this arm would reject`);
  for (const h of zsHits.slice(0, 6)) console.log(`        ${h.src}#${h.i}: ${h.d.slice(0, 190)}`);
  if (zsHits.length > 6) console.log(`        … ${zsHits.length - 6} more`);
}

// ── SHIPPED-PREDICATE REACH: the real validator, not the drafts above. ─────
console.log('\n══ SHIPPED validateScenario: reach of the three framing rules ══');
{
  const V = await import('../src/utils/nashValidator.ts');
  const NEWMSG = /share a goal, but the matrix is constant-sum|frames the two players as rivals|determines the outcome, but/;
  // SELF-TEST: the detector must be able to fire, or its 0% means nothing.
  const probes = [
    [{ a11: 100, a12: -100, a21: -100, a22: 100, b11: -100, b12: 100, b21: 100, b22: -100 },
      'A store and a restorer work together toward the same goal for the display. Each books its own slot for the season.'],
    [{ a11: 4, a12: 0, a21: 0, a22: 2, b11: 4, b12: 0, b21: 0, b22: 2 },
      'A textile company and a competing manufacturer fight for the same order. Each books its own dyeing slot for the run.'],
    [{ a11: 5, a12: 5, a21: 5, a22: 5, b11: 0, b12: 3, b21: -3, b22: 1 },
      "A roastery picks its supplier. The partner's decision will determine the pricing outcome for the roastery."],
  ];
  for (const [g, d] of probes) {
    const sc = { name: 'P', row1: 'Early Slot', row2: 'Late Slot', col1: 'Shared Window', col2: 'Separate Window', storyClaims: null, description: d };
    const iss = (V.validateScenario(sc, g).issues ?? []).filter((s) => NEWMSG.test(s));
    if (!iss.length) { console.error(`INSTRUMENT BROKEN — probe not detected: ${d.slice(0, 60)}`); process.exit(1); }
  }
  console.log('  instrument self-test: all 3 shipped rules reachable\n');
  let n = 0;
  for (const r of withG) {
    const iss = (V.validateScenario(r.sc, r.g).issues ?? []).filter((s) => NEWMSG.test(s));
    if (iss.length) { n++; console.log(`   ${r.src}#${r.i}: ${iss.join('; ')}\n      ${r.d.slice(0, 200)}`); }
  }
  console.log(`  SHIPPED framing rules reject ${n}/${withG.length} = ${(100 * n / withG.length).toFixed(2)}% of real draws`);
}
