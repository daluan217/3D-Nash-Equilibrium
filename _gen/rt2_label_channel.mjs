/**
 * GAP 3 — THE OPTION-LABEL CHANNEL.
 *
 * Rung 3's no-numbers rule governs the DESCRIPTION: scenarioIsClaimFree reads
 * `sc.description` and nothing else. validateScenario touches the labels only to
 * check (a) that a player's two options are distinct and (b) that a payoff pair
 * annotated INSIDE PARENTHESES is one the matrix actually holds. So an invented
 * option NAME is free to assert a magnitude, and free to assert one the matrix
 * contradicts.
 *
 * THE RULE THIS SCRIPT OBEYS. Nothing here answers "is that covered?" from a
 * detector of mine. Every candidate is pushed through the SHIPPING gate —
 * validateScenario + scenarioIsClaimFree imported from src/utils/nashValidator —
 * exactly as server.ts calls it. A predecessor of mine told the blue team five
 * sentences were screened; blue ran them and all five reached the user, because
 * the "screen" was a regex in a scratch file. That is not repeated here.
 *
 * KNOWN-NEGATIVE FIXTURES run first: three scenarios the real gate MUST reject.
 * If any of them passes, this harness is not wired to the real gate and the
 * whole run is void. That is the counterpart of the rater's known-positive
 * fixture: there, a check had to fire; here, a gate has to bite.
 *
 *   npx tsx _gen/rt2_label_channel.mjs
 */
import { readFileSync } from 'node:fs';

const { validateScenario, scenarioIsClaimFree, validateProseDirections } = await import('../src/utils/nashValidator.ts');

/**
 * The shipping gate, called the way the server calls it — server.ts:910-912.
 *
 * The FIRST draft of this function had only validateScenario + claim-free, and
 * would have let me report "reaches the user" from a gate production does not
 * run. Production also runs validateProseDirections, because NASH_DIRECTION_
 * CHECKS=1 is live on Cloud Run (revision 00170-czp, 16 env vars). Reproducing
 * two thirds of a gate and calling the result a bypass is the precise error the
 * header warns about, one level down.
 */
function realGate(sc, g) {
  const v = validateScenario(sc, g);
  const cf = scenarioIsClaimFree(sc);
  const dirs = validateProseDirections(sc.description ?? '', sc, g);
  return {
    ok: !!(v.ok && cf.ok !== false && dirs.length === 0),
    why: [
      v.ok ? null : (v.reason ?? v.issues?.join('; ') ?? 'invalid'),
      cf.ok === false ? cf.reason : null,
      dirs.length ? `direction check: ${dirs.join('; ')}` : null,
    ].filter(Boolean).join(' | '),
  };
}

// The game every adversarial case is judged against: a 0.001-spread matching
// pennies. Every choice moves a player's own payoff by one thousandth of a unit.
// Nothing in this world is momentous. It is the exact left-hand end of Daniel's
// 100-vs-0.001 example.
const TINY = { a11: 0.001, a12: 0, a21: 0, a22: 0.001, b11: 0, b12: 0.001, b21: 0.001, b22: 0 };
// And a flat one, where the labels have nothing at all to be true about.
const FLAT = { a11: 5, a12: 5, a21: 5, a22: 5, b11: 5, b12: 5, b21: 5, b22: 5 };

const NEUTRAL_DESC =
  'A regional operator chooses between two courses of action for the coming season. A second operator independently chooses between two courses of action for the same season.';

// ── KNOWN NEGATIVES: the real gate must reject all three. ───────────────────
const MUST_FAIL = [
  { label: 'digit in the description',
    g: TINY,
    sc: { name: 'Digit Probe', row1: 'Alpha', row2: 'Beta', col1: 'Gamma', col2: 'Delta',
      description: 'An operator weighs 2 courses of action while a second operator weighs two of its own.' } },
  { label: 'row labels not distinct',
    g: TINY,
    sc: { name: 'Same Label Probe', row1: 'Early Run', row2: 'Early Run', col1: 'Gamma', col2: 'Delta',
      description: NEUTRAL_DESC } },
  { label: 'parenthetical payoff pair the matrix does not hold',
    g: TINY,
    sc: { name: 'Annotation Probe', row1: 'Early Run (77, 88)', row2: 'Late Run', col1: 'Gamma', col2: 'Delta',
      description: NEUTRAL_DESC } },
];

// ── THE ADVERSARIAL CASES. Each asserts a magnitude the matrix contradicts. ──
const CASES = [
  { id: 'L1 number inside an option label',
    note: 'The digit screen reads sc.description only. A bare number in a LABEL is unparenthesised, so the payoff-annotation rule never looks at it.',
    g: TINY,
    sc: { name: 'Capital Programme', row1: 'Commit 1000 Units', row2: 'Commit 1 Unit',
      col1: 'Fund 1000 Units', col2: 'Fund 1 Unit', description: NEUTRAL_DESC } },
  { id: 'L2 explicit ratio in an option label',
    note: 'States a hundred-thousand-fold difference between the two options of a game whose every swing is one thousandth of a unit.',
    g: TINY,
    sc: { name: 'Expansion Decision', row1: 'Hundredfold Expansion', row2: 'No Change',
      col1: 'Hundredfold Backing', col2: 'No Backing', description: NEUTRAL_DESC } },
  { id: 'L3 catastrophe-vs-formality label pair',
    note: 'The shape the stakes rater was built to catch, attached to the tiniest game in the ladder.',
    g: TINY,
    sc: { name: 'Valley Breach Watch', row1: 'Full Evacuation', row2: 'No Evacuation',
      col1: 'Open Spillway', col2: 'Seal Gates', description: NEUTRAL_DESC } },
  { id: 'L4 magnitude asserted in the NAME field',
    note: 'The name is not screened at all — not by the digit rule, not by the claim rules.',
    g: TINY,
    sc: { name: 'The 100000x Decision', row1: 'Alpha', row2: 'Beta', col1: 'Gamma', col2: 'Delta',
      description: NEUTRAL_DESC } },
  { id: 'L5 spelled-out magnitude in the DESCRIPTION',
    note: 'The description-side digit screen is /\\d/. Spelled-out numbers carry the same claim and contain no digit.',
    g: TINY,
    sc: { name: 'Season Stakes', row1: 'Alpha', row2: 'Beta', col1: 'Gamma', col2: 'Delta',
      description: 'A regional operator faces a choice worth a hundred thousand times more than the other party’s, a decision that will decide whether the cooperative survives the season at all. The second party is making a choice of almost no consequence to itself.' } },
  { id: 'L6 magnitude on a FLAT matrix',
    note: 'Every cell identical, so no choice moves anything for anyone. The labels still say one option is total and the other is nothing.',
    g: FLAT,
    sc: { name: 'Shutdown Decision', row1: 'Full Shutdown', row2: 'No Shutdown',
      col1: 'Evacuate Site', col2: 'Keep Working', description: NEUTRAL_DESC } },
];

console.log('── KNOWN NEGATIVES (the real gate must reject every one) ──');
let wired = true;
for (const c of MUST_FAIL) {
  const r = realGate(c.sc, c.g);
  console.log(`  ${r.ok ? 'PASSED  <-- GATE NOT WIRED' : 'rejected'}  ${c.label}${r.ok ? '' : `  [${r.why}]`}`);
  if (r.ok) wired = false;
}
if (!wired) {
  console.log('\nHARNESS VOID — a scenario the shipping gate is known to reject came back clean.');
  console.log('That means this script is not calling the real gate, and every result below is meaningless.');
  process.exit(1);
}
console.log('  HARNESS OK — the gate under test is the shipping gate and it bites.\n');

console.log('── ADVERSARIAL CASES: does a label-borne magnitude claim reach the user? ──');
let through = 0;
for (const c of CASES) {
  const r = realGate(c.sc, c.g);
  if (r.ok) through++;
  console.log(`  ${r.ok ? 'REACHES THE USER' : 'blocked         '}  ${c.id}`);
  console.log(`      labels: ${c.sc.row1} / ${c.sc.row2}  |  ${c.sc.col1} / ${c.sc.col2}`);
  if (!r.ok) console.log(`      blocked by: ${r.why}`);
  console.log(`      ${c.note}`);
}
console.log(`\n  ${through}/${CASES.length} adversarial magnitude claims pass the shipping gate.\n`);

// ── REACH: does this shape occur in real output, or only in my fixtures? ─────
// A fixture proves the channel is OPEN. Only real output proves anyone walks
// through it. Both are repo policy.
const MAGNITUDE_LABEL = /\b(full|total|complete|entire|maximum|max|all|none|no|zero|nothing|large|small|bulk|split|premium|budget|economy|express|priority|high|low|surge|routine|deep|light|heavy|reduce|maintain|extra|minimal|intensive|rush|standard)\b/i;
const DIGIT_LABEL = /\d/;
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['/tmp/rt2_stakes_cloud.jsonl', '/tmp/rt2_stakes_local.jsonl', '/tmp/rt2_stakes_cloud_hint.jsonl'];
console.log('── REACH: magnitude-bearing labels in real, gate-passed output ──');
for (const f of files) {
  let rows;
  try { rows = readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch { console.log(`  (skipped ${f})`); continue; }
  const by = new Map();
  for (const r of rows) {
    const sc = r.sc ?? (r.name ? { name: r.name, row1: r.row1, row2: r.row2, col1: r.col1, col2: r.col2, description: r.description } : null);
    if (!sc) continue;
    const k = r.spread ?? r.cell ?? 'all';
    if (!by.has(k)) by.set(k, { n: 0, mag: 0, digits: 0, examples: [] });
    const b = by.get(k);
    b.n++;
    const pairs = [[sc.row1, sc.row2], [sc.col1, sc.col2]];
    let hit = false;
    for (const [a, bb] of pairs) {
      if (!a || !bb) continue;
      if (MAGNITUDE_LABEL.test(a) || MAGNITUDE_LABEL.test(bb)) hit = true;
      if (DIGIT_LABEL.test(a) || DIGIT_LABEL.test(bb)) b.digits++;
    }
    if (hit) { b.mag++; if (b.examples.length < 3) b.examples.push(`${sc.row1} / ${sc.row2} | ${sc.col1} / ${sc.col2}`); }
  }
  console.log(`  ${f}`);
  for (const k of [...by.keys()].sort((a, x) => (Number(a) || 0) - (Number(x) || 0))) {
    const b = by.get(k);
    console.log(`     ${String(k).padEnd(8)} n=${String(b.n).padEnd(4)} magnitude-bearing label pair in ${b.mag} (${(100 * b.mag / b.n).toFixed(0)}%)  digits in a label: ${b.digits}`);
    for (const e of b.examples) console.log(`        e.g. ${e}`);
  }
}
