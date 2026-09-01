/**
 * BLUE-INPUT — independent re-derivation of RED-INPUT's minimax finding.
 *
 * geometry.ts:293-294 hands the model, under the header "computed,
 * authoritative", either
 *   TRUE  branch: "...is zero-sum/constant-sum, so it HAS a value..."
 *   FALSE branch: "...is NOT zero-sum or constant-sum, so there is NO single
 *                  'value of the game' and the minimax framing does NOT apply."
 * gated on `minimaxApplies = zeroSum || constantSum`.
 *
 * THE CLAIM UNDER TEST: a game with b = k*a + c and k < 0 is strictly
 * competitive — B's utility is a NEGATIVE affine function of A's — and von
 * Neumann-Morgenstern utilities are defined only up to a POSITIVE affine
 * transformation. Rescale B by alpha = -1/k > 0 and a + b' is constant, so the
 * game IS a zero-sum game wearing different units: it has a value, every
 * equilibrium pays A that value, and minimax is exactly the right framing.
 * The briefing asserts the opposite.
 *
 * The oracle is deliberately NOT `describeGeometry` — it is A's maximin,
 * computed from first principles, against the NE payoffs from `computeAllNE`.
 * Two things must both hold for "the game has a value":
 *   (1) every equilibrium pays A the same amount, and
 *   (2) that amount equals A's maximin (security) level.
 *
 *   npx tsx _gen/blue_in2_minimax.mjs
 */
import { describeGeometry } from '../src/utils/geometry.ts';
import { computeAllNE } from '../src/utils/gameEngine.ts';

const EA = (g, x, y) => x * y * g.a11 + x * (1 - y) * g.a12 + (1 - x) * y * g.a21 + (1 - x) * (1 - y) * g.a22;

/** A's maximin over mixed x, minimising over B's mixed y (linear in y => a corner). */
function maximinA(g, steps = 400000) {
  let best = -Infinity, argx = 0;
  for (let i = 0; i <= steps; i++) {
    const x = i / steps;
    const v = Math.min(EA(g, x, 0), EA(g, x, 1));
    if (v > best) { best = v; argx = x; }
  }
  return { value: best, x: argx };
}

function nePayoffsA(g) {
  // EA is recomputed at the EXACT coordinates rather than read off `eA`, which
  // gameEngine rounds to 3 dp for the screen.
  return computeAllNE(g).map((ne) => ({ ne, ea: EA(g, ne.x, ne.y) }));
}

function verdict(g) {
  const geo = describeGeometry(g);
  const pays = nePayoffsA(g).map((p) => p.ea);
  const spread = pays.length ? Math.max(...pays) - Math.min(...pays) : 0;
  const mm = maximinA(g);
  // "Has a value" = every equilibrium pays A the same, and it is the maximin.
  const hasValue = pays.length > 0 && spread < 1e-4 && Math.abs(pays[0] - mm.value) < 1e-3;
  return { geo, pays, spread, maximin: mm.value, hasValue };
}

const CASES = [
  ['RED-INPUT case 1  b = -(1/3)a - 4', { a11: -3, a12: -9, a21: -6, a22: 6, b11: -3, b12: -1, b21: -2, b22: -6 }, true],
  ['RED-INPUT case 2  b = -2a - 1', { a11: 0, a12: -2, a21: -1, a22: -2, b11: -1, b12: 3, b21: 1, b22: 3 }, true],
  ['CONTROL Battle of the Sexes', { a11: 2, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 2 }, false],
  ['CONTROL matching pennies (zero-sum)', { a11: 1, a12: -1, a21: -1, a22: 1, b11: -1, b12: 1, b21: 1, b22: -1 }, true],
  ['CONTROL prisoners dilemma', { a11: -1, a12: -3, a21: 0, a22: -2, b11: -1, b12: 0, b21: -3, b22: -2 }, false],
  ['CONTROL constant-sum (sum 5)', { a11: 3, a12: 1, a21: 4, a22: 2, b11: 2, b12: 4, b21: 1, b22: 3 }, true],
];

let bad = 0;
for (const [name, g, expectValue] of CASES) {
  const v = verdict(g);
  const says = v.geo.minimaxApplies ? 'HAS a value' : 'has NO value';
  const truth = v.hasValue ? 'HAS a value' : 'has NO value';
  const agree = (v.geo.minimaxApplies === v.hasValue);
  if (!agree) bad++;
  console.log(
    `${agree ? 'ok  ' : 'FALSE'} ${name}\n`
    + `        briefing says: ${says}   (zeroSum=${v.geo.zeroSum} constantSum=${v.geo.constantSum})\n`
    + `        oracle  says: ${truth}   NE payoffs to A = [${v.pays.map((p) => p.toFixed(4)).join(', ')}], spread ${v.spread.toExponential(2)}, maximin ${v.maximin.toFixed(6)}\n`
    + `        expected-by-hand: ${expectValue ? 'HAS a value' : 'has NO value'}${(v.hasValue === expectValue) ? '' : '   <-- ORACLE DISAGREES WITH HAND EXPECTATION'}`,
  );
}
console.log(bad ? `\n${bad} of ${CASES.length} cases: the briefing sentence is FALSE` : '\nno disagreement');
