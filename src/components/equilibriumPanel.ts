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
  fmtPayoffPair,
  fmtPayoff,
  payoffTexRhs,
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
  /**
   * The operator each side's own value is stated under: `=` for an ordinary
   * value, `<`/`>` for one whose r3 rounds to zero without being zero — the
   * same directional form `payoffTexRhs` uses, so `${pRel} ${pStr}` is what
   * `payoffTexRhs` returns for the identical quantity. Always `=` under a
   * strict relation, where `fmtPayoffPair` already exists to tell two values
   * apart.
   */
  pRel: string;
  qRel: string;
  /** The complete TeX for the line. */
  tex: string;
}

/**
 * 3dp for display, split from its operator.
 *
 * Delegates entirely to `payoffTexRhs` rather than re-deriving 3dp formatting
 * (`r3(-1e-9)` is `-0`, and `(-0).toFixed(3)` is "0.000" while
 * `(-1e-9).toFixed(3)` is "-0.000" — the same trap `payoffTexRhs` already
 * closed one layer up) so a nonzero value whose r3 rounds to zero gets `<`/`>`
 * and its threshold magnitude instead of `=` and a false "0.000": the
 * headline (`payoffTexRhs`, in `App.tsx`) and this line can never disagree,
 * because they are now the same call.
 */
function threeRel(v: number): { str: string; rel: string } {
  const s = payoffTexRhs(v);
  const i = s.indexOf(' ');
  return i < 0 ? { str: s, rel: '=' } : { rel: s.slice(0, i), str: s.slice(i + 1) };
}

/**
 * Render one relation.
 *
 * WHERE `≈` COMES FROM (director decision, 2026-09-02, "Option B" — see
 * `neTolerancePlayer` in `gameEngine.ts` and the design note it links).
 * -----------------------------------------------------------------------
 * This function used to take the ≈-vs-strict decision as an input
 * (`indifferent: boolean`, supplied by `indifferenceAt`, i.e. by
 * `neTolerancePlayer` — 0.002 x that player's own payoff spread). That
 * constant is right for its OTHER job (deciding whether a run's QUANTISED
 * coordinate still names a genuine equilibrium — see `neTolerance`'s
 * docstring) but wrong for this one: it is scale-dependent, so on a
 * large-spread game it can exceed a full display unit, and the panel could
 * print "≈" between two numbers that read differently at the resolution
 * shown — MEASURED at 0.04-0.09% of mixed-panel renderings when fed
 * arbitrary (non-live-run) profiles (`_gen/blueapp_renderer_reach.ts`,
 * `equilibriumpanel.test.ts` §7's vertex-corpus fixture).
 *
 * The panel's `≈` now answers a DIFFERENT, DISPLAY-anchored question,
 * independent of payoff scale: would the two sides print the SAME digits?
 * Decided from `p`/`q` alone, as `Math.abs(p - q) < 5e-4` — half of
 * `fmtPayoff`'s own 3dp unit, the same constant this function already used
 * for the "share the midpoint" case below, just now also gating the
 * ≈-vs-strict choice itself rather than only the rendering inside it. This
 * makes "≈ between two different printed numbers" impossible by
 * construction for any caller, not merely absent from the one caller that
 * exists today: if `|p - q| >= 5e-4`, the two sides are asserted with a
 * STRICT relation, however small that gap is relative to the game's own
 * payoff spread. `neTolerancePlayer`/`neTolerance`/`indifferenceAt`
 * themselves are UNCHANGED — job 1 (regret-based convergence) still uses
 * them, unaffected by this file.
 *
 * The precision rule below is asymmetric ON PURPOSE, and the asymmetry is
 * the point:
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
  anchor?: number,
): IndifferenceLine {
  // Under `≈`, a difference SMALLER than the display resolution is rendered from
  // a single SHARED value so both sides print one number — ALWAYS, not only
  // when neither side individually needs `<`/`>` sub-resolution wording.
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
  // PREVIOUSLY (before RED-MATH-5's finding 001) this collapse was gated on
  // `pBase.rel === '=' && qBase.rel === '='` — i.e. skipped whenever EITHER
  // side itself rounded to a sub-resolution "< 0.001"/"> -0.001". The comment
  // that gated it defended that as "a statement about `<`/`>` magnitude
  // wording, not a misprint of a genuine number" — reasoning about a
  // CONTRIVED case (p=0.0002, q=-0.0002, a real ~4e-4 gap). It does not hold
  // for the case that actually shows up in real games: a genuine mixed-NE
  // indifference point whose TRUE value is mathematically EXACTLY 0 (that is
  // what "indifferent" means), where `eRow1`/`eRow2` are two *different*
  // floating-point expressions for that same exact zero and ~1e-16 rounding
  // noise alone can land them on OPPOSITE sides of zero — each independently
  // picking up `payoffTexRhs`'s directional `<`/`>` wording and producing two
  // genuinely different printed strings ("-0.001" and "0.001") joined by
  // `\approx`. Repro: A=[[-3,2],[6,-4]], B=[[5,1],[-7,1]] at its mixed NE
  // (x*=0.667, y*=0.4) — `_gen/redmath5_minimal_repro.ts`.
  //
  // `indifferent` is this line's OWN decision now (see the docstring above),
  // not an input: identical printed digits, at display resolution, and
  // nothing else. And once it is true, the two sides ALWAYS share one
  // rendering — never two independently-rounded strings, sub-resolution or
  // not — which is what makes "≈ between two different printed numbers"
  // actually impossible by construction, not merely absent from the one
  // branch the previous fix covered.
  const indifferent = Math.abs(p - q) < 5e-4;
  // `anchor`, when supplied, is the SAME combined quantity the panel's own
  // headline renders (`EA`/`EB` — see `indifferenceLines` below) rather than
  // the plain average of this line's two independently-rounded inputs. Using
  // it means the row/col line and the headline three lines above it are not
  // merely close, they are the identical computation, so "the headline states
  // the exact value" and "the line under it states the exact value" can never
  // read as two different claims about one quantity. Callers that pass no
  // anchor (isolated unit tests exercising `indifferenceLine` directly) fall
  // back to the plain midpoint, unchanged from before this fix.
  const shared = anchor !== undefined ? anchor : (p + q) / 2;
  const strict = indifferent ? null : fmtPayoffPair(p, q);
  // ONE format call under `≈`, reused for both sides — the two rendered
  // objects are the SAME object, not merely equal, so `pStr === qStr` and
  // `pRel === qRel` cannot drift apart by future edits to either branch.
  const sharedFmt = indifferent ? threeRel(shared) : null;
  const pf = indifferent ? sharedFmt! : { str: strict!.p, rel: '=' };
  const qf = indifferent ? sharedFmt! : { str: strict!.q, rel: '=' };
  const relation = indifferent ? '\\approx' : (p > q ? '>' : '<');
  return {
    indifferent,
    relation,
    p,
    q,
    pStr: pf.str,
    qStr: qf.str,
    pRel: pf.rel,
    qRel: qf.rel,
    tex: `\\mathbb{E}[\\text{${left}}] ${pf.rel} ${pf.str} ${relation} \\mathbb{E}[\\text{${right}}] ${qf.rel} ${qf.str}`,
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
  // `indifferenceAt` (job 1's tolerance-based test) is deliberately NOT
  // consulted here any more — see `indifferenceLine`'s docstring. Each line
  // decides its own ≈-vs-strict split from its own two payoffs.
  const eRow1 = y * g.a11 + (1 - y) * g.a12;
  const eRow2 = y * g.a21 + (1 - y) * g.a22;
  const eCol1 = x * g.b11 + (1 - x) * g.b21;
  const eCol2 = x * g.b12 + (1 - x) * g.b22;
  // `EA`/`EB` are the SAME (x, y) combined into the ONE weighted expression
  // the panel's headline row renders (`payoffTexRhs(EA(resolved.x, resolved.y,
  // payoffs))` in App.tsx). Passed as the anchor, an indifferent line's shared
  // rendering is that identical computation rather than a fresh average of
  // `eRow1`/`eRow2` — so a line that reads "≈" can never diverge from what the
  // headline three lines above it already stated for the same quantity (see
  // `indifferenceLine`'s docstring for why this also happens to be what closes
  // RED-MATH-5 finding 001).
  return {
    a: indifferenceLine('Row 1', 'Row 2', eRow1, eRow2, EA(x, y, g)),
    b: indifferenceLine('Col 1', 'Col 2', eCol1, eCol2, EB(x, y, g)),
  };
}
