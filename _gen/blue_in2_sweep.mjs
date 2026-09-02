/**
 * BLUE-INPUT — the strictly-competitive predicate, its reach, and the
 * over-firing check that my FIRST oracle failed.
 *
 * MY FIRST ORACLE WAS WRONG AND MY OWN CONTROL CAUGHT IT. "the game has a
 * value" defined as `unique NE payoff to A == A's maximin` FIRES ON PRISONER'S
 * DILEMMA (unique NE pays A -2; A's maximin is also -2, because Row 2 is
 * dominant). That condition is NECESSARY, not sufficient — it is satisfied
 * whenever both players have a dominant strategy, competitive or not. Using it
 * as the predicate would have been the twentieth over-firing rule of this
 * campaign. It is kept below as a DIAGNOSTIC only.
 *
 * THE PREDICATE ACTUALLY PROPOSED is cardinal and decidable: B's payoffs are a
 * DECREASING affine function of A's, b = k*a + c with k < 0, across all four
 * cells. Then alpha = -1/k > 0 rescales B's von Neumann-Morgenstern utility so
 * that a + (alpha*b + beta) is constant — the game is a zero-sum game in
 * different units, which is precisely when the minimax framing is right.
 *
 * k = -1 is the constant-sum case the code already has, so the NEW ground is
 * k < 0 and k != -1.
 *
 *   npx tsx _gen/blue_in2_sweep.mjs
 */
import { describeGeometry } from '../src/utils/geometry.ts';
import { computeAllNE, generateRandomGame } from '../src/utils/gameEngine.ts';

const EPS = 1e-9;
const EA = (g, x, y) => x * y * g.a11 + x * (1 - y) * g.a12 + (1 - x) * y * g.a21 + (1 - x) * (1 - y) * g.a22;

/**
 * b = k*a + c with k < 0, fitted exactly (not least-squares — an approximate
 * fit is not a strategic equivalence).
 *
 * The fit needs two cells with DIFFERENT a to pin k, so a game where all four
 * of A's payoffs are equal is excluded: k is undefined there, A is indifferent
 * everywhere, and "strictly competitive" is not a thing to claim about it.
 */
export function strictlyCompetitive(g) {
  const a = [g.a11, g.a12, g.a21, g.a22];
  const b = [g.b11, g.b12, g.b21, g.b22];
  let i0 = 0, i1 = -1;
  for (let i = 1; i < 4; i++) if (Math.abs(a[i] - a[i0]) > EPS) { i1 = i; break; }
  if (i1 < 0) return false;                       // A flat everywhere: k undefined
  const k = (b[i1] - b[i0]) / (a[i1] - a[i0]);
  if (!(k < -EPS)) return false;                  // k >= 0: aligned, not competitive
  const c = b[i0] - k * a[i0];
  return a.every((ai, i) => Math.abs(b[i] - (k * ai + c)) <= 1e-9 * (1 + Math.abs(b[i])));
}

function maximinA(g, steps = 200000) {
  let best = -Infinity;
  for (let i = 0; i <= steps; i++) { const x = i / steps; const v = Math.min(EA(g, x, 0), EA(g, x, 1)); if (v > best) best = v; }
  return best;
}
/** DIAGNOSTIC ONLY — see the header. Necessary, not sufficient. */
function neEqualsMaximin(g) {
  const pays = computeAllNE(g).map((ne) => EA(g, ne.x, ne.y));
  if (!pays.length) return false;
  return (Math.max(...pays) - Math.min(...pays) < 1e-4) && Math.abs(pays[0] - maximinA(g)) < 1e-3;
}

// ── 1. the predicate separates on hand cases ─────────────────────────────────
const HAND = [
  ['RED-INPUT case 1  b = -(1/3)a - 4', { a11: -3, a12: -9, a21: -6, a22: 6, b11: -3, b12: -1, b21: -2, b22: -6 }, true],
  ['RED-INPUT case 2  b = -2a - 1', { a11: 0, a12: -2, a21: -1, a22: -2, b11: -1, b12: 3, b21: 1, b22: 3 }, true],
  ['zero-sum matching pennies', { a11: 1, a12: -1, a21: -1, a22: 1, b11: -1, b12: 1, b21: 1, b22: -1 }, true],
  ['constant-sum, sum 5', { a11: 3, a12: 1, a21: 4, a22: 2, b11: 2, b12: 4, b21: 1, b22: 3 }, true],
  ['NEGATIVE Battle of the Sexes', { a11: 2, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 2 }, false],
  ['NEGATIVE prisoners dilemma (the one my first oracle got wrong)', { a11: -1, a12: -3, a21: 0, a22: -2, b11: -1, b12: 0, b21: -3, b22: -2 }, false],
  ['NEGATIVE common interest b = +2a (k > 0)', { a11: 1, a12: 2, a21: 3, a22: 4, b11: 2, b12: 4, b21: 6, b22: 8 }, false],
  ['NEGATIVE A flat everywhere (k undefined)', { a11: 2, a12: 2, a21: 2, a22: 2, b11: 1, b12: 4, b21: -2, b22: 7 }, false],
  ['NEGATIVE near-miss: one cell off by 0.01', { a11: -3, a12: -9, a21: -6, a22: 6, b11: -3, b12: -1, b21: -2, b22: -5.99 }, false],
];
let bad = 0;
for (const [name, g, want] of HAND) {
  const got = strictlyCompetitive(g) || describeGeometry(g).constantSum;
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: predicate=${got} want=${want}  [diagnostic ne==maximin: ${neEqualsMaximin(g)}]`);
}
console.log(bad ? `${bad} hand cases FAILED\n` : 'all hand cases separate\n');

// ── 2. reach, corpora named ──────────────────────────────────────────────────
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

/** NEW ground only: the sentence is wrong exactly where this is true. */
const newlyTrue = (g) => { const geo = describeGeometry(g); return !geo.minimaxApplies && strictlyCompetitive(g); };

const CORPORA = {
  "generateRandomGame('mixed') — the app's random button": [20000, () => generateRandomGame('mixed')],
  "generateRandomGame('pure')": [20000, () => generateRandomGame('pure')],
  'uniform int[-9,9] (hand-typed range)': [50000, () => ({ a11: ri(-9, 9), a12: ri(-9, 9), a21: ri(-9, 9), a22: ri(-9, 9), b11: ri(-9, 9), b12: ri(-9, 9), b21: ri(-9, 9), b22: ri(-9, 9) })],
  'uniform int[-3,3] (narrow, collisions likelier)': [50000, () => ({ a11: ri(-3, 3), a12: ri(-3, 3), a21: ri(-3, 3), a22: ri(-3, 3), b11: ri(-3, 3), b12: ri(-3, 3), b21: ri(-3, 3), b22: ri(-3, 3) })],
  'constructed b = k*a + c, k<0, k != -1 (the class itself)': [20000, () => {
    const k = -(1 + Math.floor(rnd() * 5) + rnd()); const c = ri(-9, 9);
    const a = { a11: ri(-9, 9), a12: ri(-9, 9), a21: ri(-9, 9), a22: ri(-9, 9) };
    return { ...a, b11: k * a.a11 + c, b12: k * a.a12 + c, b21: k * a.a21 + c, b22: k * a.a22 + c };
  }],
};
for (const [name, [n, mk]] of Object.entries(CORPORA)) {
  let hit = 0;
  for (let i = 0; i < n; i++) if (newlyTrue(mk())) hit++;
  console.log(`${String(hit).padStart(6)} / ${n}  = ${((hit / n) * 100).toFixed(3)}%   ${name}`);
}

// ── 3. the six shipped presets ───────────────────────────────────────────────
const { PRESETS } = await import('../src/utils/gameEngine.ts');
const rows = Object.entries(PRESETS).map(([k, p]) => {
  const g = p;
  const geo = describeGeometry(g);
  return `  ${k.padEnd(10)} zeroSum=${String(geo.zeroSum).padEnd(5)} constantSum=${String(geo.constantSum).padEnd(5)} newlyTrue=${newlyTrue(g)}`;
});
console.log(`\npresets (${rows.length}):\n${rows.join('\n')}`);
