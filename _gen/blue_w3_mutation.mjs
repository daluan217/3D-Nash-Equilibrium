/* WINDOW 3 mutation evidence for the OPTION-LABEL / NAME channel.
 *
 * A fixture suite that passes against the defect proves nothing — the camera-
 * flash round shipped three such assertions and mutation testing showed all
 * three green against the live bug. So every claim below is checked against a
 * mutant that gets it wrong in the specific way a plausible author would.
 *
 * MUTANT A = the COMMITTED gate (1e1b4d3), which screens the description only
 *            -> every POSITIVE must go undetected. This is what makes the
 *               positives real rather than tautological.
 * MUTANT B = the same screen written `/\d/`, the ASCII-only form this repo has
 *            already shipped once
 *            -> a fullwidth numeral must walk through it.
 * MUTANT C = the over-broad gate the hard constraint forbids: "these labels
 *            sound dramatic", as a magnitude word list
 *            -> must wrongly reject real gate-passing output IN BULK.
 * MUTANT D = the same screen placed in validateScenario (which runs at EVERY
 *            rung) instead of scenarioIsClaimFree (rung 3 only)
 *            -> must wrongly reject an ordinary rung-0 label like "Gate 12".
 *
 *   npx tsx _gen/blue_w3_mutation.mjs
 */
import { writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const NEW = await import('../src/utils/nashValidator.ts');
// Materialised from git rather than kept as a copy: a checked-in snapshot of
// "before" goes stale without saying so, and this mutant's whole job is to be
// genuinely the previous behaviour.
const BASE = process.env.BASE_REF || '1e1b4d3';
const TMP = new URL('../src/utils/nashValidator.__w3base.ts', import.meta.url).pathname;
let OLD;
try {
  writeFileSync(TMP, execFileSync('git', ['show', `${BASE}:src/utils/nashValidator.ts`], { encoding: 'utf8' }));
  OLD = await import('../src/utils/nashValidator.__w3base.ts');
} finally { try { rmSync(TMP); } catch {} }

const TINY = { a11: 0.001, a12: 0, a21: 0, a22: 0.001, b11: 0, b12: 0.001, b21: 0.001, b22: 0 };
const L = (o) => ({ name: 'Regional Allocation', row1: 'Alpha', row2: 'Beta', col1: 'Gamma', col2: 'Delta', ...o });

// The full shipping gate, as server.ts composes it.
const gate = (mod, sc, g = TINY) => {
  const v = mod.validateScenario(sc, g);
  const cf = mod.scenarioIsClaimFree(sc);
  const d = mod.validateProseDirections(sc.description ?? '', sc, g);
  return { ok: !!(v.ok && cf.ok !== false && d.length === 0), why: cf.reason ?? (v.issues ?? []).join('; ') ?? '' };
};

// ── POSITIVES: the new gate must reject; MUTANT A must let every one through ──
const POSITIVES = [
  ['L1  bare number in an option label', L({ row1: 'Commit 1000 Units', row2: 'Commit 1 Unit' })],
  ['L2  explicit ratio in an option label', L({ row1: 'Hundredfold Expansion', row2: 'No Change' })],
  ['L4  magnitude in the NAME', L({ name: 'The 100000x Decision' })],
  ['L5  spelled-out multiple in the DESCRIPTION', L({
    description: 'A regional operator weighs a choice worth a hundred thousand times more than the other party\'s, in the same season.' })],
  // The keystroke that makes validateScenario's parenthetical rule blind. Kept
  // VERBATIM from the C11 draw the rule was written for, U+2212 and all: a
  // paraphrased regression test passed while the real defect shipped.
  ['C11 unparenthesised, the shape the annotation rule cannot see',
    L({ row1: 'Signal −1/−1', row2: 'Signal +1/+1' })],
  // ASCII-only screens have shipped here before. Fullwidth digits, then
  // Arabic-Indic, in a label and in the description.
  ['U+FF10 fullwidth numeral in a label', L({ row1: 'Commit １０００ Units', row2: 'Beta' })],
  ['U+0660 Arabic-Indic numeral in the description',
    L({ description: 'A regional operator commits ١٠٠ crates while a second operator commits its own.' })],
  ['orders of magnitude, in a label', L({ row1: 'Orders of Magnitude Expansion', row2: 'Hold' })],
];

// ── CONTROLS: real, gate-passing output. None may be newly rejected. ─────────
const CONTROLS = [
  ['real draw, magnitude-bearing pair (rt1#3)', L({ name: 'Antique Restoration Bidding', row1: 'Full Repairs', row2: 'Minor Repairs', col1: 'Open Call', col2: 'Reserve' })],
  ['real draw, the only total-vs-nothing pair in 883 (r2local#108)', L({ name: 'Cheese Cave Ripping', row1: 'Early Ripening', row2: 'Late Ripening', col1: 'Full Monitoring', col2: 'No Monitoring' })],
  ['real draw, premium/discount (stcloud)', L({ name: 'Bakery Pricing', row1: 'Premium Price', row2: 'Discount Price', col1: 'Bulk Flour', col2: 'Specialty Flour' })],
  ['real draw, surge/routine (stlocal)', L({ name: 'Ward Staffing', row1: 'Surge Team', row2: 'Routine Team', col1: 'Float Nurses', col2: 'Core Nurses' })],
  // The -fold alternation requires a numeral stem; the engine part must pass.
  ['"Manifold" is not a multiple', L({ row1: 'Manifold Assembly', row2: 'Valve Assembly' })],
  ['"double shift" asserts no ratio', L({ row1: 'Double Shift', row2: 'Single Shift' })],
  ['"many times" asserts no ratio', L({ description: 'A regional operator has run this route many times before, and a second operator is new to it.' })],
  ['plain scene-setting, no labels at issue', L({ description: 'A regional operator chooses between two courses of action for the coming season. A second operator independently chooses between two courses of action for the same season.' })],
];

let fail = 0;
const ok = (c, msg) => { if (!c) { fail++; console.log(`  FAIL  ${msg}`); } };

console.log('── POSITIVES: new gate rejects, MUTANT A (committed) does not ──');
for (const [tag, sc] of POSITIVES) {
  const n = gate(NEW, sc), o = gate(OLD, sc);
  console.log(`  new=${n.ok ? 'PASS ' : 'block'}  baseline=${o.ok ? 'PASS ' : 'block'}   ${tag}`);
  if (!n.ok) console.log(`        -> ${n.why}`);
  ok(!n.ok, `${tag}: the new gate must reject it`);
  ok(o.ok, `${tag}: MUTANT A must let it through, or this fixture is not a new positive`);
}

console.log('\n── CONTROLS: neither gate may reject ──');
for (const [tag, sc] of CONTROLS) {
  const n = gate(NEW, sc), o = gate(OLD, sc);
  console.log(`  new=${n.ok ? 'pass' : 'BLOCK'}  baseline=${o.ok ? 'pass' : 'BLOCK'}   ${tag}`);
  if (!n.ok) console.log(`        -> ${n.why}`);
  ok(n.ok, `${tag}: control wrongly rejected by the new gate`);
  ok(n.ok === o.ok, `${tag}: the new gate changed a control's verdict`);
}

// ── MUTANT B: /\d/ instead of /\p{N}/ ───────────────────────────────────────
console.log('\n── MUTANT B: the ASCII-only screen this repo has shipped before ──');
{
  const MB = /\d/;
  const fields = (sc) => ['name', 'row1', 'row2', 'col1', 'col2', 'description'].map((k) => String(sc[k] ?? ''));
  for (const tag of ['U+FF10 fullwidth numeral in a label', 'U+0660 Arabic-Indic numeral in the description']) {
    const sc = POSITIVES.find(([t]) => t === tag)[1];
    const caught = fields(sc).some((v) => MB.test(v));
    console.log(`  mutant B ${caught ? 'CATCHES' : 'misses '}   ${tag}`);
    ok(!caught, `MUTANT B must miss ${tag}, or \\p{N} is not what is doing the work`);
    ok(!gate(NEW, sc).ok, `the shipped screen must catch ${tag}`);
  }
}

// ── MUTANT C: the forbidden over-broad gate, priced against the real corpus ──
console.log('\n── MUTANT C: "these labels sound dramatic", priced on real output ──');
{
  const MC = /\b(?:full|total|complete|entire|maximum|max|all|none|no|zero|nothing|large|small|bulk|premium|budget|economy|express|priority|high|low|surge|routine|deep|light|heavy|reduce|maintain|extra|minimal|intensive|rush|standard)\b/i;
  const S = '/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad';
  const rows = [];
  for (const f of [`${S}/rt1.jsonl`, `${S}/rt2.jsonl`, '/tmp/rt2_local.jsonl', '/tmp/rt2_cloud.jsonl',
    '/tmp/rt2_stakes_local.jsonl', '/tmp/rt2_stakes_cloud.jsonl', '/tmp/rt2_stakes_cloud_hint.jsonl']) {
    if (!existsSync(f)) continue;
    for (const l of readFileSync(f, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { const r = JSON.parse(l); if (r.sc) rows.push(r.sc); } catch { /* skip */ }
    }
  }
  const mc = rows.filter((sc) => ['row1', 'row2', 'col1', 'col2'].some((k) => MC.test(String(sc[k] ?? '')))).length;
  const mine = rows.filter((sc) => NEW.scenarioIsClaimFree(sc).ok === false
    && /^(?:the scenario name|the option label ")/.test(NEW.scenarioIsClaimFree(sc).reason ?? '')).length;
  console.log(`  mutant C rejects ${mc}/${rows.length} real draws (${(100 * mc / rows.length).toFixed(1)}%)`);
  console.log(`  shipped screen rejects ${mine}/${rows.length} (${(100 * mine / rows.length).toFixed(1)}%)`);
  ok(mc / rows.length > 0.2, 'MUTANT C must be shown to be expensive, or the constraint it violates is not demonstrated');
  ok(mine === 0, 'the shipped screen must reject none of the real corpus');
}

// ── MUTANT D: the screen placed where it runs at every rung ─────────────────
console.log('\n── MUTANT D: rung-3 rule placed in the all-rung validator ──');
{
  // At rung 0 the model writes the numbers itself, so a numbered label is
  // ordinary. The screen must live on the rung-3-only function, and the
  // all-rung one must stay silent about it.
  const numbered = L({ name: 'Airport Gate Assignment', row1: 'Gate 12', row2: 'Gate 7', col1: 'Stand A', col2: 'Stand B' });
  const vs = NEW.validateScenario(numbered, TINY);
  const cf = NEW.scenarioIsClaimFree(numbered);
  console.log(`  validateScenario (every rung) : ${vs.ok ? 'passes' : 'REJECTS'}  ${(vs.issues ?? []).join('; ')}`);
  console.log(`  scenarioIsClaimFree (rung 3)  : ${cf.ok === false ? `rejects — ${cf.reason}` : 'passes'}`);
  ok(vs.ok, 'MUTANT D: validateScenario must NOT carry the rung-3 numeral rule — "Gate 12" is a fine rung-0 label');
  ok(cf.ok === false, 'the rung-3 screen must still reject it');
  // And a matrix-checked parenthetical annotation must stay validateScenario's
  // business at every rung: it is decidable there, so it must not have moved.
  const wrong = L({ row1: 'Early Run (77, 88)', row2: 'Late Run' });
  const vw = NEW.validateScenario(wrong, TINY);
  console.log(`  parenthetical-vs-matrix rule still in validateScenario: ${vw.ok ? 'LOST' : 'kept'}`);
  ok(!vw.ok && (vw.issues ?? []).some((s) => /annotates a payoff pair/.test(s)),
    'the matrix-checked annotation rule must remain in validateScenario');
}

console.log(`\n${fail ? `MUTATION FAILURES: ${fail}` : 'ALL MUTATION CHECKS PASSED'}`);
process.exit(fail ? 1 : 0);
