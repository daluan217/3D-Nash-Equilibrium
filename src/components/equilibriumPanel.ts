/**
 * The two indifference equations printed inside the "Nash Equilibrium Reached"
 * panel, built as pure data so they can be asserted without a browser.
 *
 * WHY THIS IS A MODULE AND NOT AN INLINE IIFE IN App.tsx
 * ------------------------------------------------------
 * The defect it exists to close was invisible to every test in the repo because
 * the strings were assembled inside JSX: `npm test` could check `indifferenceAt`
 * and `resolveProfile` separately, both were correct, and the panel still
 * contradicted itself — because the CALL SITE fed them two different
 * coordinates. A defect that lives in the wiring needs the wiring to be a
 * callable thing.
 *
 * THE DEFECT
 * ----------
 * The panel's headline numbers (x*, y*, E[A], E[B]) are evaluated at `resolved`
 * — the solver's EXACT projection onto the equilibrium set. The two indifference
 * lines a few centimetres below them were evaluated at `simState.cx`/`cy`, which
 * `doStep` has already pushed through `r3`. On the app's own Search Game preset
 * that is the difference between 1/3 and 0.333, and the panel read:
 *
 *     x* = 0.333   y* = 0.333   E[A] = 0.667   E[B] = -0.667
 *     A indifferent:  E[Row 1] = 0.666 ≈ E[Row 2] = 0.667
 *     B indifferent:  E[Col 1] = -0.666 ≈ E[Col 2] = -0.667
 *
 * Two separate falsehoods in three lines. E[A] IS E[Row 1] IS E[Row 2] at a
 * mixed equilibrium — that indifference is the whole reason the mix is an
 * equilibrium — so 0.667 and 0.666 cannot both be printed. And "indifferent" was
 * asserted, with `≈`, between two visibly different numbers. Search Game's
 * answer is exactly 2/3; there was nothing to round away.
 *
 * Measured over random integer games in [-10, 10]: 555 of 830 rendered
 * "indifferent" lines printed two different numbers (66.9%), 25 of them
 * differing by 0.01 or more. At the ±100 input clamp the worst reached was
 * `E[Row 1] = 23.220 ≈ E[Row 2] = 23.420`.
 *
 * ONE COORDINATE SOURCE PER PANEL. Callers pass the same (x, y) the headline
 * numbers used, and everything in the box is then a statement about one point.
 */
import {
  indifferenceAt,
  fmtPayoffPair,
  fmtPayoff,
  r3,
  EA,
  EB,
} from '../utils/gameEngine';
import type { GamePayoffs, NashEquilibrium } from '../types';

/**
 * The `E[A]=…, E[B]=…` pair printed beside an equilibrium in the report list
 * and in the two commitment lines.
 *
 * TWO defects in one expression, and the second is why `fmtPayoff(ne.eA)` is
 * NOT the fix:
 *
 * 1. Those sites called `.toFixed(3)` while `fmtPayoff` — which exists exactly
 *    to stop a payoff claiming a value it does not have — sat imported in the
 *    same file and correctly used a hundred lines above. So a genuinely
 *    non-zero payoff printed as "0.000".
 *
 * 2. `computeAllNE` stores `eA: r3(EA(...))`, i.e. ALREADY rounded. `r3` of a
 *    tiny negative is `-0`, and `-0 === 0` in JavaScript, so `fmtPayoff` would
 *    take its exact-zero branch and answer "0". That changes the SPELLING of a
 *    false zero without fixing it. Recompute from the equilibrium's own
 *    coordinates and the sub-resolution branch can fire.
 *
 * MEASURED on 200,000 random games per scale, payoffs on the matrix editor's
 * own 3-dp grid: at ±0.1 this reaches 989 of 251,172 NE-list entries (0.394%,
 * all of them mixed = 1.01% of mixed equilibria); ±1 0.039%, ±3 0.015%, ±10
 * 0.005%; integer payoffs never. `fmtPayoff(ne.eA)` alone fixes 0 of 989 of
 * them. Recomputing fixes all 989. Verified against the reported repro
 * a=[[-0.017,0.01],[0.077,-0.049]], b=[[-0.034,0.048],[0.048,0.034]], whose
 * mixed NE has E[A] = -0.000412 and printed "E[A]=0.000".
 *
 * The profile is unchanged — same `ne.x`, `ne.y` — so the self-consistency of
 * the reported tuple that `gameEngine`'s note protects is untouched. Only the
 * needless pre-rounding is gone.
 */
export function neValues(ne: Pick<NashEquilibrium, 'x' | 'y'>, g: GamePayoffs): { a: string; b: string } {
  return { a: fmtPayoff(EA(ne.x, ne.y, g)), b: fmtPayoff(EB(ne.x, ne.y, g)) };
}

/** One rendered relation, with the raw values kept for assertions. */
export interface IndifferenceLine {
  /** Whether the panel asserts approximate equality (`≈`) rather than `>`/`<`. */
  indifferent: boolean;
  /** The TeX relation actually drawn: `\approx`, `>` or `<`. */
  relation: string;
  /** Exact left/right expected payoffs, before any display rounding. */
  p: number;
  q: number;
  /** The two rendered numbers, exactly as KaTeX receives them. */
  pStr: string;
  qStr: string;
  /** The complete TeX for the line. */
  tex: string;
}

/**
 * 3dp for display, with JavaScript's negative zero collapsed.
 *
 * `r3(-1e-9)` is `-0`, and `(-0).toFixed(3)` is "0.000" while
 * `(-1e-9).toFixed(3)` is "-0.000"; going through `r3` first is what keeps the
 * minus sign off a quantity that is not negative at display resolution. Same
 * rule `fmtPayoff` applies one layer up.
 */
function three(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const s = r3(v);
  return (Object.is(s, -0) ? 0 : s).toFixed(3);
}

/**
 * Render one relation.
 *
 * The precision rule is asymmetric ON PURPOSE, and the asymmetry is the point:
 *
 * - Under a STRICT relation, `fmtPayoffPair` widens precision until the two
 *   sides read differently, because "0.030 > 0.030" is self-contradictory.
 * - Under `≈`, widening is not merely unnecessary, it is actively wrong. Two
 *   expected payoffs that are equal in exact arithmetic are routinely one ulp
 *   apart in floating point — on Search Game, `2*(1/3)` is 0.6666666666666666
 *   and `1-(1/3)` is 0.6666666666666667 — so a widening formatter would chase
 *   that dust down to `6.67e-1 ≈ 6.67e-1` (its 8dp fallback) and put exponential
 *   notation on the app's flagship preset to display a difference of one part in
 *   1e16. Under `≈` the honest render is plain 3dp on both sides.
 *
 * The widening is therefore kept, and scoped to the branch whose docstring in
 * `gameEngine` says it is for: "two payoffs that a STRICT relation is asserted
 * between".
 */
export function indifferenceLine(
  left: string,
  right: string,
  p: number,
  q: number,
  indifferent: boolean,
): IndifferenceLine {
  // Under `≈`, a difference SMALLER than the display resolution is rendered from
  // the midpoint so both sides print one number.
  //
  // Not cosmetic. The two values straddle a rounding boundary often enough to
  // matter: on a=[[-25,-32],[64,-55]], b=[[29,-97],[-76,4]] both row payoffs are
  // -30.5625 and differ by 3.6e-15 of floating-point dust — but -30.5625 sits
  // exactly on `r3`'s half-way point, and `Math.round` breaks that tie towards
  // +∞, so the dust decides which side of the tie each value lands on and the
  // panel printed "-30.562 ≈ -30.563". Rounding half a display unit in opposite
  // directions is not information about the game. Below 5e-4 the difference is
  // not representable at 3dp at all, so there is nothing to lose by showing the
  // one number both values round to.
  //
  // A gap at or above 5e-4 is deliberately left visible on both sides. That is
  // the only remaining way `≈` can print two different numbers, and it is a real
  // statement about `neTolerancePlayer` (0.002 x spread), not about rounding —
  // hiding it would bury the question.
  //
  // HOW REACHABLE THAT IS, stated as the conditional it actually is. Through the
  // converged run it is UNREACHED: 0 of 1,896 adversarial mixed panels, and 0
  // across two further independent sweeps. The tempting next sentence — "and
  // unreachable, because the run commits to a corner, so `resolveProfile`
  // projects there and `profileConcept` returns 'pure'" — is a claim about the
  // CALL PATH, and it stops being true the moment a second caller exists.
  // Measured rather than argued (`_gen/blueapp_renderer_reach.ts`): hand this
  // renderer ARBITRARY profiles instead of run output — 578,526 of them, over
  // games with manufactured continua and near-degeneracy — and 716 of 217,652
  // mixed-panel renderings, 0.33%, DO print `≈` between two different numbers.
  // Every one sits at a resolved point with a coordinate at a vertex: a player
  // holding a pure strategy inside an equilibrium region, non-indifferent by
  // less than its own tolerance.
  //
  // So it is a property of THE ONE CALLER, not of this function. Today `App.tsx`
  // is that caller and it passes `resolveProfile` of the converged run. A saved
  // game, an NE-list click or a jumped-to equilibrium rendered here would expose
  // the 0.33% at once — `computeAllNE` hands out exact interior coordinates
  // through no projection at all. `src/equilibriumpanel.test.ts` §7 fails if a
  // second production caller appears, so this is a checked condition rather than
  // an assumption.
  const mid = (p + q) / 2;
  const f = indifferent
    ? (Math.abs(p - q) < 5e-4 ? { p: three(mid), q: three(mid) } : { p: three(p), q: three(q) })
    : fmtPayoffPair(p, q);
  const relation = indifferent ? '\\approx' : (p > q ? '>' : '<');
  return {
    indifferent,
    relation,
    p,
    q,
    pStr: f.p,
    qStr: f.q,
    tex: `\\mathbb{E}[\\text{${left}}] = ${f.p} ${relation} \\mathbb{E}[\\text{${right}}] = ${f.q}`,
  };
}

/**
 * Both lines of the panel, evaluated at ONE point.
 *
 * `x` and `y` must be the same coordinates the panel's headline row uses —
 * i.e. `resolveProfile`'s exact output, never `simState.cx`/`cy`. Row payoffs
 * depend on B's mix `y`; column payoffs depend on A's mix `x`.
 */
export function indifferenceLines(
  g: GamePayoffs,
  x: number,
  y: number,
): { a: IndifferenceLine; b: IndifferenceLine } {
  const at = indifferenceAt(g, x, y);
  const eRow1 = y * g.a11 + (1 - y) * g.a12;
  const eRow2 = y * g.a21 + (1 - y) * g.a22;
  const eCol1 = x * g.b11 + (1 - x) * g.b21;
  const eCol2 = x * g.b12 + (1 - x) * g.b22;
  return {
    a: indifferenceLine('Row 1', 'Row 2', eRow1, eRow2, at.a),
    b: indifferenceLine('Col 1', 'Col 2', eCol1, eCol2, at.b),
  };
}
