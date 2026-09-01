/**
 * BLUE — WINDOW 5: price the two DECIDABLE label holes RED 1's newer oracle
 * (rt_label_gate_oracle) still shows reaching the user, both in a channel this
 * branch already owns (the numeral/multiple screen in scenarioIsClaimFree).
 *
 *   L10  "Order-of-Magnitude Expansion" as a LABEL.
 *        MULTIPLIER_CLAIM already contains `orders?\s+of\s+magnitude`. It is
 *        written with `\s+`, so the HYPHENATED spelling walks through a rule
 *        that already exists to stop exactly this claim. Same shape as the
 *        U+2212 minus that has bitten this repo three times: not a missing
 *        rule, a rule defeated by punctuation.
 *
 *   L7   "Ten Thousand Crates / One Crate" as LABELS on a matrix whose every
 *        swing is one thousandth of a unit. A bare large quantity, no digit, no
 *        "-fold", no "times more" — so no branch of MULTIPLIER_CLAIM sees it
 *        and the \p{N} screen sees no numeral.
 *
 * RED 1 scored a "big spelled quantity anywhere" predicate (their D4) at 0/527
 * false positives. This prices it over all 3,254 draws instead of the 531-row
 * label corpus, and prices the SCOPE separately (labels+name vs description
 * too), because the collision risk is not the same in the two places.
 *
 * NOTE red's D4 cannot be adopted as written: its `\w+fold` matches "Manifold",
 * and this suite already pins "Manifold is not a multiple" as a control.
 *
 *   npx tsx _gen/blue_w5_spelledprice.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
const V = await import('../src/utils/nashValidator.ts');

const S = '/private/tmp/claude-501/-Users-danielluan-Desktop-3D-Nash-Equilibrium/5d5d682e-2a27-4687-ac2f-801e07672846/scratchpad';
const REPO = '/Users/danielluan/Desktop/3D-Nash-Equilibrium';
const files = [];
for (const d of ['/tmp', S, `${REPO}/_gen`, `${REPO}/_gen/results`]) {
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d)) if (f.endsWith('.jsonl')) files.push(`${d}/${f}`);
}
files.sort();
const stakesGame = (k) => ({ a11: k, a12: 0, a21: 0, a22: k, b11: 0, b12: k, b21: k, b22: 0 });
const rows = []; const seen = new Set();
for (const f of files) {
  const src = f.split('/').pop().replace('.jsonl', '');
  for (const l of readFileSync(f, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    const sc = r.sc ?? r.scenario;
    if (!sc || typeof sc.description !== 'string') continue;
    const key = `${sc.name} ${sc.description} ${sc.row1} ${sc.col1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ src, i: r.i ?? r.pair ?? r.line, sc, g: r.g ?? r.game ?? (r.spread != null ? stakesGame(r.spread) : null) });
  }
}
const pass = rows.filter((r) => {
  if (V.scenarioIsClaimFree(r.sc).ok === false) return false;
  if (!r.g) return true;
  return !(V.validateScenario(r.sc, r.g).issues ?? []).length;
});
console.log(`${files.length} files · ${rows.length} unique draws · ${pass.length} gate-passing\n`);

const labels = (sc) => [sc.row1, sc.row2, sc.col1, sc.col2].filter((x) => typeof x === 'string');
const nameAndLabels = (sc) => [sc.name, ...labels(sc)].filter((x) => typeof x === 'string');
const desc = (sc) => String(sc.description ?? '');

// ── The candidate predicates ──
const HYPHEN_OOM = /\borders?[-\s]+of[-\s]+magnitude\b/i;
// Deliberately NARROWER than red's D4. Excluded, each for a measured reason:
//   \w+fold  — matches "Manifold", already pinned as a control here
//   twice    — "a twice-weekly delivery" is a SCHEDULE, not a magnitude
//   dozens   — "dozens of crates" is ordinary scene-setting
// Kept: the large round quantities, which in a LABEL under rung 3 are a
// magnitude assertion about a matrix the label cannot see.
const BIG_QTY = /\b(?:hundreds?|thousands?|millions?|billions?|trillions?)\b/i;
const RED_D4 = /\b(?:hundreds?|thousands?|millions?|billions?|dozens?|twice|thrice|\w+fold)\b/i;

const score = (tag, pred) => {
  const h = pass.filter((r) => pred(r.sc));
  console.log(`  ${tag.padEnd(52)} ${String(h.length).padStart(4)} / ${pass.length} = ${(100 * h.length / pass.length).toFixed(3)}%`);
  for (const r of h.slice(0, 6)) {
    console.log(`        [${r.src}#${r.i}] labels: ${labels(r.sc).join(' / ')}`);
    console.log(`          ${desc(r.sc).replace(/\s+/g, ' ').slice(0, 165)}`);
  }
  return h;
};

console.log('── What each candidate would newly REJECT among gate-passing draws ──');
score('L10 fix: order-of-magnitude, any punctuation', (sc) => HYPHEN_OOM.test([...nameAndLabels(sc), desc(sc)].join(' ')));
score('L7 A: big quantity in NAME or a LABEL', (sc) => nameAndLabels(sc).some((t) => BIG_QTY.test(t)));
score('L7 B: big quantity in the DESCRIPTION too', (sc) => BIG_QTY.test(desc(sc)));
score("red's D4 as written (anywhere)", (sc) => RED_D4.test([...nameAndLabels(sc), desc(sc)].join(' ')));
score("red's D4 restricted to NAME+LABELS", (sc) => nameAndLabels(sc).some((t) => RED_D4.test(t)));

// ── Known-positives: both holes must actually be closed by the candidates ──
console.log('\n── Known-positive check (the oracle holes themselves) ──');
const L10 = { name: 'N', row1: 'Order-of-Magnitude Expansion', row2: 'Token Expansion', col1: 'Order-of-Magnitude Backing', col2: 'Token Backing', description: 'A studio and a backer each pick a scale for the run.' };
const L7 = { name: 'N', row1: 'Ten Thousand Crates', row2: 'One Crate', col1: 'Ten Thousand Slots', col2: 'One Slot', description: 'A depot and a yard each pick a volume for the shipment.' };
console.log(`  L10 caught by the hyphen fix : ${HYPHEN_OOM.test(nameAndLabels(L10).join(' '))}`);
console.log(`  L7  caught by big-quantity   : ${nameAndLabels(L7).some((t) => BIG_QTY.test(t))}`);
console.log(`  L10 caught by the SHIPPED gate today : ${V.scenarioIsClaimFree(L10).ok === false} (${V.scenarioIsClaimFree(L10).reason ?? '-'})`);
console.log(`  L7  caught by the SHIPPED gate today : ${V.scenarioIsClaimFree(L7).ok === false} (${V.scenarioIsClaimFree(L7).reason ?? '-'})`);

// ── The collision controls this branch already holds ──
console.log('\n── Collision controls (must NOT be caught) ──');
for (const [tag, t] of [['Manifold', 'Manifold Expansion'], ['twice-weekly', 'a twice-weekly delivery run'],
  ['dozens of crates', 'dozens of crates move through the depot'], ['Batch One/Two', 'Batch One']]) {
  console.log(`  ${tag.padEnd(18)} BIG_QTY=${String(BIG_QTY.test(t)).padEnd(5)} redD4=${RED_D4.test(t)}`);
}
