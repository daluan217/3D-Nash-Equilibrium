/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GamePayoffs, SimState, NashEquilibrium, PresetGame, PathSegment } from '../types';

/**
 * Player-colored spans for preset descriptions. TRUSTED, app-authored HTML —
 * these strings are injected via dangerouslySetInnerHTML, which is exactly why
 * user- and model-written text never goes through this path (it is rendered as
 * plain text and colored by the ColorCoded component instead).
 * Classes match the matrix editor's player coloring and adapt to dark mode,
 * unlike the hard-coded hex spans they replace.
 */
const spanA = (t: string) => `<span class="text-player-a-ink dark:text-player-a-ink-dark font-semibold">${t}</span>`;
const spanB = (t: string) => `<span class="text-player-b-ink dark:text-player-b-ink-dark font-semibold">${t}</span>`;

export const PRESETS: Record<string, PresetGame> = {
  search: {
    key: 'search',
    name: 'Search Game',
    a11: 2, b11: -2,  a12: 0, b12: 0,
    a21: 0, b21: 0,   a22: 1, b22: -1,
    row1Label: 'Search L', row2Label: 'Search R',
    col1Label: 'Hide L',   col2Label: 'Hide R',
    actorA: ['searcher'], actorB: ['hider'],
    desc: `<strong>Search Game:</strong> A ${spanA('searcher')} chooses to look ${spanA('Left (Row 1)')} or ${spanA('Right (Row 2)')}; `
        + `a ${spanB('hider')} simultaneously picks ${spanB('Left (Col 1)')} or ${spanB('Right (Col 2)')}. `
        + `The ${spanA('searcher')} wins 2 by finding the ${spanB('hider')} at the left door, and 1 at the right door. `
        + `The ${spanB("hider's")} payoffs are the exact negatives (zero-sum). Neither player has a dominant strategy; both must randomize. `
        + `The unique Nash Equilibrium is mixed: ${spanA('Searcher plays Left with probability 1/3')}, ${spanB('Hider hides Left with probability 1/3')}. `
        + 'Notice the flat spot in both expected-payoff surfaces at (x*, y*)=(1/3, 1/3).'
  },
  bos: {
    key: 'bos',
    name: 'Battle of the Sexes',
    a11: 2, b11: 1,  a12: 0, b12: 0,
    a21: 0, b21: 0,  a22: 1, b22: 2,
    actorA: ['Opera'], actorB: ['Football'],
    desc: '<strong>Battle of the Sexes:</strong> Two partners want to spend the evening together but prefer different activities. '
        + `Player A prefers the ${spanA('Opera (Row 1)')}, `
        + `Player B prefers ${spanB('Football (Col 2)')}. `
        + 'Being together matters to both, but each would rather be at their favourite venue. '
        + `Payoffs: (Opera,Opera)=(${spanA('2')},${spanB('1')}), (Opera,Football)=(${spanA('0')},${spanB('0')}), `
        + `(Football,Opera)=(${spanA('0')},${spanB('0')}), (Football,Football)=(${spanA('1')},${spanB('2')}).`
  },
  pd: {
    key: 'pd',
    name: 'Prisoners Dilemma',
    a11: 3, b11: 3,  a12: 0, b12: 5,
    a21: 5, b21: 0,  a22: 1, b22: 1,
    desc: '<strong>Prisoner\'s Dilemma:</strong> Two suspects are arrested and held in separate cells. '
        + `Each can Cooperate (${spanA('Row 1')}/${spanB('Col 1')}) with their partner by remaining silent, or Defect (${spanA('Row 2')}/${spanB('Col 2')}) by confessing. `
        + 'Defecting is a strictly dominant strategy for both players, leading them inexorably to the unique dominant strategy Nash Equilibrium of '
        + `mutual defection (${spanA('1')},${spanB('1')}), `
        + `even though mutual cooperation would have yielded a much higher payoff (${spanA('3')},${spanB('3')}) for both.`
  },
  cnr: {
    key: 'cnr',
    name: 'Cops & Robbers',
    a11: 3, b11: 2,  a12: 3, b12: 3,
    a21: 2, b21: 4,  a22: 4, b22: 1,
    actorA: ['robber'], actorB: ['cop'],
    desc: `<strong>Cops &amp; Robbers:</strong> A ${spanA('robber')} chooses to ${spanA('Stay at Home (Row 1)')} or ${spanA('Commit a Crime (Row 2)')}. `
        + `A ${spanB('cop')} simultaneously decides to ${spanB('Patrol (Col 1)')} or ${spanB('Eat Donuts (Col 2)')}. `
        + `The ${spanA('robber')} wants to commit crime undetected, while the ${spanB('cop')} wants to patrol and catch them. `
        + `${spanA("Robber's payoff")} is maximized (${spanA('4')}) when they commit crime while the cop eats donuts; `
        + `${spanB("cop's payoff")} is maximized (${spanB('4')}) when patrolling while a crime is committed. `
        + `Payoffs (clockwise from top-left): (${spanA('3')},${spanB('2')}), (${spanA('3')},${spanB('3')}), (${spanA('4')},${spanB('1')}), (${spanA('2')},${spanB('4')}).`
  },
  spy: {
    key: 'spy',
    name: 'Spy vs. Analyst',
    a11: 3, b11: -3,  a12: -2, b12: 2,
    a21: -1, b21: 1,  a22: 0, b22: 0,
    actorA: ['spy'], actorB: ['analyst'],
    desc: `<strong>Spy vs. Analyst:</strong> A ${spanA('spy')} chooses to ${spanA('leak classified intel (Row 1)')} or ${spanA('stay silent (Row 2)')}. `
        + `An ${spanB('analyst')} simultaneously decides to ${spanB('publish a story (Col 1)')} or ${spanB('hold it (Col 2)')}. `
        + `The ${spanA('spy')} gains from publication when leaking but loses credibility if silent and published. `
        + `The ${spanB('analyst')} profits from a confirmed scoop but risks backlash if they publish without a leak. `
        + 'This zero-sum-adjacent game has no pure Nash Equilibrium — both players must mix their strategies. '
        + `Payoffs (clockwise from top-left): (${spanA('3')},${spanB('−3')}), (${spanA('−2')},${spanB('2')}), (${spanA('0')},${spanB('0')}), (${spanA('−1')},${spanB('1')}).`
  },
  penalty: {
    key: 'penalty',
    name: 'Penalty Kick',
    // Built for the guided tour's regret act, tuned by brute force for the
    // parallel-contraction dynamics: dY = -22 with roots y* = 4/11 and
    // x* = 1/11. The strategy lines sit at the corridor midpoints (0.5), so
    // A's line starts leaning 3 payoff units (12.5% of the z-range) and B's 9
    // (37.5%) — and because y* is 3x nearer the midpoint than x*, y declares
    // first (4% regret-declare threshold) while B's line still holds ~2.5
    // units of lean (10%). Both leaning at the start, one still leaning at
    // the first find: measured as the practical maximum for a zero-sum 2x2
    // under these dynamics (equalized optimum ~13%).
    a11: -12, b11: 12,  a12: 8, b12: -8,
    a21: 2, b21: -2,  a22: 0, b22: 0,
    row1Label: 'Aim Left', row2Label: 'Aim Right',
    col1Label: 'Dive Left', col2Label: 'Dive Right',
    actorA: ['kicker'], actorB: ['goalie'],
    desc: `<strong>Penalty Kick:</strong> A ${spanA('kicker')} picks a side to shoot (${spanA('Row 1 = Aim Left')}, ${spanA('Row 2 = Aim Right')}); `
        + `the ${spanB('goalie')} simultaneously picks a side to dive (${spanB('Col 1 = Dive Left')}, ${spanB('Col 2 = Dive Right')}). `
        + `The ${spanA("kicker's")} left-side strike is lethal when the ${spanB('goalie')} guesses wrong but easily smothered when read; `
        + 'the right side is safer but weaker. Zero-sum with no pure Nash Equilibrium — both players must mix. '
        + `Payoffs (clockwise from top-left): (${spanA('−12')},${spanB('12')}), (${spanA('8')},${spanB('−8')}), (${spanA('0')},${spanB('0')}), (${spanA('2')},${spanB('−2')}).`
  },
  custom: {
    key: 'custom',
    name: 'Custom',
    desc: 'Enter your own payoff values in the matrix below.'
  }
};

// ── Payoff functions ─────────────────────────────────────────────────────────
export function EA(x: number, y: number, g: GamePayoffs): number {
  return x * y * g.a11 + x * (1 - y) * g.a12 + (1 - x) * y * g.a21 + (1 - x) * (1 - y) * g.a22;
}

export function EB(x: number, y: number, g: GamePayoffs): number {
  return x * y * g.b11 + x * (1 - y) * g.b12 + (1 - x) * y * g.b21 + (1 - x) * (1 - y) * g.b22;
}

// ── Regret (independent NE oracle) ────────────────────────────────────────────
// A profile (x,y) is a Nash equilibrium iff neither player has positive regret.
// These are computed straight from the payoff matrix and share NO code with
// computeAllNE, so they are a genuine independent oracle: the fuzz suite and the
// report validator can cross-check computeAllNE's output against them.
// INVARIANT: computeAllNE must never call these — doing so would collapse the two
// computations into one and destroy that independence.
export function regretA(x: number, y: number, g: GamePayoffs): number {
  const rA1 = y * g.a11 + (1 - y) * g.a12;
  const rA2 = y * g.a21 + (1 - y) * g.a22;
  return Math.max(rA1, rA2) - (x * rA1 + (1 - x) * rA2);
}

export function regretB(x: number, y: number, g: GamePayoffs): number {
  const rB1 = x * g.b11 + (1 - x) * g.b21;
  const rB2 = x * g.b12 + (1 - x) * g.b22;
  return Math.max(rB1, rB2) - (y * rB1 + (1 - y) * rB2);
}

export function r3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// ── Typed-field input ────────────────────────────────────────────────────────
/**
 * The ONE conversion from a typed or pasted field to a number.
 *
 * Every numeric control used to answer "is this string a number?" for itself,
 * and the same question got wrong answers pointing in OPPOSITE directions:
 *
 *  - The matrix editor's onChange normalised unicode minus signs; its onBlur
 *    did not. A pasted "−4" (U+2212, what PDF/Word/LaTeX produce) was
 *    accepted on change — every panel recomputed and named the equilibrium for
 *    −4 — then silently reset to 0 on the way out of the cell, which is what
 *    clicking Run does before the run starts. On A=[[−4,4],[2,0]],
 *    B=[[1,0],[0,2]] the report went from the true (x*=0.667, y*=0.400,
 *    E[A]=0.800) to a different game's (0.667, 0.667, 1.333).
 *
 *  - The start-point fields used `parseFloat(x0) || 0.217`, and 0 is falsy. So
 *    x0 = 0 — advertised by the input's own min="0.0", and where the down
 *    button lands from 0.010 — ran from 0.217, and the log opened
 *    "Start (0.217, 0.500)" above a box reading 0.
 *
 * Both vanish once there is exactly one parser AND it signals "not a number" as
 * `null` rather than as a substitute value: a legitimate 0 can never be mistaken
 * for absent, and a normalisation cannot be present at one site and missing at
 * the next. Callers choose their own fallback, explicitly.
 *
 * parseFloat semantics are kept deliberately: Number() would read "" as 0 and
 * "0x10" as 16. Only the normalisation and the null contract are new.
 */
// U+2212 minus, U+2013/2014/2015 dashes, U+2012 figure dash, U+2010/2011
// hyphens, U+2043 hyphen bullet, U+02D7 modifier minus, U+FF0D fullwidth,
// U+FE63/FE58 small forms. Escapes, not glyphs: the literal characters are
// mutually indistinguishable in a monospace diff, and this file has been bitten
// by that five times.
const NUMERIC_INPUT_MINUS = /[\u2212\u2013\u2014\u2015\u2012\u2010\u2011\u2043\u02D7\uFF0D\uFE63\uFE58]/g;
const NUMERIC_INPUT_PLUS = /[\uFF0B\uFE62]/g;

export function parseNumericInput(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string') return null;
  const canonical = raw.replace(NUMERIC_INPUT_MINUS, '-').replace(NUMERIC_INPUT_PLUS, '+');
  const v = parseFloat(canonical);
  return Number.isFinite(v) ? v : null;
}

/** What a matrix cell commits, given exactly the string the input holds. */
export function commitPayoffInput(raw: string | null | undefined): number {
  const v = parseNumericInput(raw);
  return Math.max(-100, Math.min(100, r3(v === null ? 0 : v)));
}

/**
 * What a start coordinate commits. Only a genuinely unparseable field falls
 * back — 0 is a legal start point, not a missing one.
 */
export function commitStartCoordinate(raw: string | null | undefined, fallback = 0.217): number {
  const v = parseNumericInput(raw);
  return Math.max(0, Math.min(1, v === null ? fallback : v));
}

/**
 * What the shrink step / regret weight commits. Non-positive is not a legal
 * setting for either mode, so an unusable field keeps the value in force.
 */
export function commitStepSize(raw: string | null | undefined, current: number): number {
  const v = parseNumericInput(raw);
  if (v === null || v <= 0) return current;
  return Math.min(0.999, Math.max(0.001, r3(v)));
}

/** What the "Go to step" box commits: a step index, or null if unusable. */
export function commitStepIndex(raw: string | null | undefined): number | null {
  const v = parseNumericInput(raw);
  return v === null ? null : Math.trunc(v);
}

/**
 * The minus-sign normaliser for PROSE, which needs a narrower rule than a
 * numeric field does.
 *
 * The validators used to decide this per regex, so the set of characters
 * treated as a minus varied by call site — and failed in both directions:
 * three checks missed 100% of false claims written with any unicode minus
 * (measured, 400/400 x 5 spellings), while the comparative check, whose class
 * omits U+2014/U+FF0D/U+2010, read "—4" as 4 and flagged 35% of TRUE claims
 * as false.
 *
 * In prose an en/em dash is usually punctuation, so normalising it blindly
 * would invent negative numbers. U+2212/U+FF0D/U+2010/U+2011/U+02D7 can only be
 * arithmetic or a hyphen and convert unconditionally; an en/em dash converts
 * only in SIGN POSITION — after start, whitespace or an opening/operator
 * character, and immediately before a digit. So "3–5" stays a range and
 * "5 — and" stays punctuation. \s already covers U+00A0 and U+202F.
 */
const PROSE_UNAMBIGUOUS_MINUS = /[\u2212\uFF0D\u2010\u2011\u02D7]/g;
const PROSE_SIGNED_DASH = /(^|[\s(\[{$=≈≃~,:;])[\u2013\u2014\u2015\u2012](?=\d)/g;

export function normalizeProseMinus(text: string): string {
  if (typeof text !== 'string') return text;
  return text.replace(PROSE_UNAMBIGUOUS_MINUS, '-').replace(PROSE_SIGNED_DASH, '$1-');
}

/**
 * How much regret a QUANTISED coordinate can carry while still naming a genuine
 * equilibrium.
 *
 * The simulation reports coordinates through `r3`, so each is up to 5e-4 from
 * the true value. Regret is bilinear, so that displacement admits a residual of
 * roughly (coordinate error) x (payoff spread) per player. Comparing against a
 * flat 1e-6 — as this check first did — declared the app's OWN flagship preset
 * "Settled (not an NE)": the Search Game's (1/3, 1/3) carries 6.67e-4 of purely
 * quantisation-induced regret, and 87.8% of converged mixed runs tripped it,
 * including guided-tour step 15. Scale the tolerance to the thing that causes
 * it instead of guessing a constant.
 */
export function neTolerance(g: GamePayoffs): number {
  return Math.max(neTolerancePlayer(g, 'A'), neTolerancePlayer(g, 'B'));
}

/**
 * Tolerance for ONE player, scaled by THAT player's own payoff range.
 *
 * The global-spread version was not invariant under rescaling a SINGLE player's
 * payoffs: on A=[[0,100],[0,-100]], B=[[0,0.399],[10,9.99]] the spread came from
 * A's ±100, inflating the tolerance applied to B's regret 100x (0.02 -> 0.4) and
 * certifying (1,1) — where B gains 0.399 by switching — as a pure equilibrium.
 * Divide A's payoffs by 100 (which cannot move either player's equilibrium set)
 * and the identical point was correctly refused. A player's own regret must be
 * judged against a tolerance built from that player's own payoffs.
 */
export function neTolerancePlayer(g: GamePayoffs, who: 'A' | 'B'): number {
  const vals = who === 'A' ? [g.a11, g.a12, g.a21, g.a22] : [g.b11, g.b12, g.b21, g.b22];
  const spread = Math.max(...vals) - Math.min(...vals);
  return Math.max(1e-9, 4 * 5e-4 * spread);
}


/**
 * The solution-concept noun for a realised profile, decided from the
 * COORDINATES rather than from which code path arrived or from the nearest
 * listed equilibrium.
 *
 * EXACT vertex test — deliberately NOT the 3dp-rounded one. Deciding this on
 * rounded values announced "PURE STRATEGY NASH EQUILIBRIUM REACHED" on
 * A=[[100,0],[-100,0.09]], B=[[0,0.09],[100,-100]], whose unique equilibrium is
 * strictly mixed at x*=200/200.09, y*=0.09/200.09 and which has NO pure
 * equilibrium at all (every corner has a deviator). Both coordinates round to a
 * vertex, so the rounded test called it pure. That is the exact collapse
 * `fmtProb` refuses to perform three lines up; performing it here handed the
 * user a false solution concept. Rounding is for DISPLAY, never for deciding
 * what is true — render the coordinates with `fmtProb` so the printed numbers
 * ("more than 0.999") agree with the noun instead of contradicting it.
 */
/**
 * The equilibrium the run converged to — exact coordinates, exact concept.
 *
 * Naming the point the run STOPPED at is wrong: the shrink search can lock on
 * the domain boundary at (1,0) while the only equilibrium is mixed at 0.99937,
 * and the regret there IS the rounding error (0.00062 of coordinate x a slope
 * of 40 = 0.025), so it passes the gate and the box announced a PURE
 * equilibrium on a game with none.
 *
 * Recovering it by testing whether `r3(cx)` matched `r3(mixedNE.x)` was worse —
 * a coincidence test that failed in both directions: it missed on the boundary
 * lock (reprinting the same lie) and it hit SPURIOUSLY when a genuine pure NE
 * at (1,1) shared three decimals with the mixed NE, printing the mixed NE's
 * coordinates beside the pure point's payoffs.
 *
 * One rule instead: project the exact converged point onto the exact
 * equilibrium set and report the nearest member. At a true pure NE the distance
 * is 0 and the point names itself; near a mixed NE the projection lands on the
 * mixed NE. No rounding participates in the decision.
 */
export function resolveProfile(g: GamePayoffs, s: Pick<SimState, 'exactX' | 'exactY'>): { x: number; y: number; concept: 'pure' | 'mixed' } {
  const px = s.exactX, py = s.exactY;
  let best: { x: number; y: number; d: number } | null = null;
  for (const r of equilibriumSet(g)) {
    const x = Math.max(r.x0, Math.min(r.x1, px));
    const y = Math.max(r.y0, Math.min(r.y1, py));
    const d = Math.hypot(x - px, y - py);
    if (!best || d < best.d) best = { x, y, d };
  }
  if (!best) return { x: px, y: py, concept: profileConcept(px, py) };
  return { x: best.x, y: best.y, concept: profileConcept(best.x, best.y) };
}



export function profileConcept(x: number, y: number): 'pure' | 'mixed' {
  const atVertex = (v: number) => v === 0 || v === 1;
  return atVertex(x) && atVertex(y) ? 'pure' : 'mixed';
}

/**
 * Which players are ACTUALLY indifferent at (x, y).
 *
 * The converged box used to assume that a "mixed" profile means both players
 * are indifferent, and printed both indifference equations. On a CONTINUUM only
 * one player is indifferent — the other strictly prefers the pure strategy it
 * is sitting on, which is precisely why it sits there. That box printed
 * "A indifferent: E[Row 1] = 3.783 ≈ E[Row 2] = -0.698" — a 4.481 gap asserted
 * as an approximate equality. Ask, never assume.
 */
/**
 * `fmtProb` for KaTeX. Its non-numeric forms ("more than 0.999") are PROSE, and
 * dropping prose into math mode renders it as concatenated italic variables —
 * "x∗=morethan0.999". Wrap those in \text{} so the honest form stays readable;
 * plain numbers pass through as maths.
 */
export function texProb(v: number): string {
  const s = fmtProb(v);
  return /^-?[0-9.]+$/.test(s) ? s : `\\text{${s}}`;
}

export function indifferenceAt(g: GamePayoffs, x: number, y: number): { a: boolean; b: boolean } {
  // Per-player: the combined tolerance let A's +/-100 spread decide that B was
  // "indifferent" across a gap of 0.3599 — 90% of B's entire payoff range.
  const tolA = neTolerancePlayer(g, 'A');
  const tolB = neTolerancePlayer(g, 'B');
  const eRow1 = y * g.a11 + (1 - y) * g.a12;
  const eRow2 = y * g.a21 + (1 - y) * g.a22;
  const eCol1 = x * g.b11 + (1 - x) * g.b21;
  const eCol2 = x * g.b12 + (1 - x) * g.b22;
  return { a: Math.abs(eRow1 - eRow2) <= tolA, b: Math.abs(eCol1 - eCol2) <= tolB };
}

// ── NE computation ───────────────────────────────────────────────────────────
export function computeMixedNE(g: GamePayoffs): { x: number; y: number } | null {
  const dY = g.a11 - g.a12 - g.a21 + g.a22;
  const dX = g.b11 - g.b21 - g.b12 + g.b22;
  if (Math.abs(dY) < 1e-9 || Math.abs(dX) < 1e-9) return null;
  const yE = (g.a22 - g.a12) / dY;
  const xE = (g.b22 - g.b21) / dX;
  // Test the EXACT coordinate, then round only for reporting. Testing the
  // ROUNDED one deleted genuine equilibria: on a=[[-2,5],[-1,3]],
  // b=[[8.002,8],[3,7]] the equilibrium sits at x* = 0.9995002 with regret
  // exactly 0, but r3 lifts it to 1.000 so "xS >= 1" fired and the app told the
  // user "No standard NE found in real dimensions" while the prose named it.
  // Same 3-decimal blind spot as the renderer's probability bug, one layer down.
  if (xE <= 0 || xE >= 1 || yE <= 0 || yE >= 1) return null;
  // EXACT coordinates, not rounded. Rounding here made the reported tuple
  // (x, y, eA, eB) describe a point that is not the equilibrium, and it was the
  // root of the prose/solver digit disagreement: the prose computed payoffs at
  // the exact point while the label computed them at the rounded one, so the
  // same quantity was reported as 2.316 and 2.315. One source of truth now —
  // the exact equilibrium — with rounding applied only at DISPLAY, identically
  // on both surfaces, so they cannot disagree.
  return { x: xE, y: yE };
}

/**
 * Display formatter for a probability, shared by the solver's label and the
 * template prose so the two can never print the same quantity differently.
 * Never collapses a strictly-interior probability onto 0 or 1 — that turned a
 * mixed equilibrium into a pure profile that is not an equilibrium.
 */
export function fmtProb(v: number): string {
  if (v === 0 || v === 1) return String(v);
  const s = r3(v);
  if (s === 0) return 'less than 0.001';
  if (s === 1) return 'more than 0.999';
  return String(s);
}

// NOTE (adversarial round 1, 2026-08-29): the mixed NE is reported at 3-dp
// ROUNDED coordinates, and eA/eB are the expected payoffs AT THAT ROUNDED
// PROFILE — so the tuple (x, y, eA, eB) is self-consistent, which `npm test`'s
// soundness check enforces. The template prose instead states the payoff at the
// EXACT equilibrium, so the two can differ in the third decimal: on
// {a:[[6,-4],[-1,8]], b:[[-9,6],[-1,-8]]} the prose says E[A] = 2.316 (44/19)
// and the solver label says 2.315 (at 0.318, 0.632).
// Computing eA/eB from exact coordinates while displaying rounded ones was
// tried and REVERTED: it made the reported tuple inconsistent and failed 99
// test groups. Reporting exact coordinates instead would change which
// equilibria survive the strict 0<x<1 gate (see evals/golden.ts). Both numbers
// are defensible and internally consistent; this is a display difference, not
// a false statement.

export function computeAllNE(g: GamePayoffs): NashEquilibrium[] {
  const nes: NashEquilibrium[] = [];
  const corners = [[0, 0], [1, 0], [0, 1], [1, 1]];
  corners.forEach(([x, y]) => {
    const rA1 = y * g.a11 + (1 - y) * g.a12;
    const rA2 = y * g.a21 + (1 - y) * g.a22;
    const rB1 = x * g.b11 + (1 - x) * g.b21;
    const rB2 = x * g.b12 + (1 - x) * g.b22;
    
    // Is A's chosen action (Row 1 if x === 1, Row 2 if x === 0) a best response to y?
    const isABestResponse = (x === 1) ? (rA1 >= rA2 - 1e-9) : (rA2 >= rA1 - 1e-9);
    // Is B's chosen action (Col 1 if y === 1, Col 2 if y === 0) a best response to x?
    const isBBestResponse = (y === 1) ? (rB1 >= rB2 - 1e-9) : (rB2 >= rB1 - 1e-9);

    if (isABestResponse && isBBestResponse) {
      nes.push({
        x,
        y,
        type: 'pure',
        label: `Pure NE (Row${x === 1 ? '1' : '2'}, Col${y === 1 ? '1' : '2'})`,
        eA: r3(EA(x, y, g)),
        eB: r3(EB(x, y, g))
      });
    }
  });

  const mn = computeMixedNE(g);
  if (mn) {
    nes.push({
      x: mn.x,
      y: mn.y,
      type: 'mixed',
      label: `Mixed NE (x*=${fmtProb(mn.x)}, y*=${fmtProb(mn.y)})`,
      eA: r3(EA(mn.x, mn.y, g)),
      eB: r3(EB(mn.x, mn.y, g))
    });
  }
  return nes;
}

// ── Indifference / degenerate-payoff status ──────────────────────────────────
// When a player's payoffs are flat (identical across their own choices) the game
// admits NE continua that computeAllNE's corner+interior model does not enumerate
// (it returns [] for the fully-flat case). Callers that need the complete
// ground-truth picture — the report grounding payload especially — must pair
// computeAllNE with this. Kept a pure function so the server/eval can reuse it.
export interface IndifferenceStatus {
  aIndifferent: boolean;
  bIndifferent: boolean;
  any: boolean;
  both: boolean;
}

export function computeIndifference(g: GamePayoffs): IndifferenceStatus {
  const aIndifferent = g.a11 === g.a21 && g.a12 === g.a22;
  const bIndifferent = g.b11 === g.b12 && g.b21 === g.b22;
  return {
    aIndifferent,
    bIndifferent,
    any: aIndifferent || bIndifferent,
    both: aIndifferent && bIndifferent,
  };
}

/**
 * Exact Nash-equilibrium SET for a 2x2 game, continua included.
 *
 * computeAllNE enumerates corners plus the interior mixed point, which is
 * complete only when no player has a weak best reply. With a payoff tie the
 * equilibrium set can be a segment (a whole edge) or the entire unit square,
 * and prose written from the corner list is then describing a fraction of the
 * truth. This returns the set as a union of axis-aligned rectangles in
 * (x, y) = (P[A plays Row 1], P[B plays Col 1]) space; a point is a degenerate
 * rectangle, an edge is a rectangle of zero width.
 *
 * Best replies come from the sign of a linear function:
 *   DA(y) = y*(a11-a21) + (1-y)*(a12-a22)   > 0 -> x = 1, < 0 -> x = 0, = 0 -> any x
 *   DB(x) = x*(b11-b12) + (1-x)*(b21-b22)   > 0 -> y = 1, < 0 -> y = 0, = 0 -> any y
 */
export interface Rect { x0: number; x1: number; y0: number; y1: number }

const NE_EPS = 1e-9;

/** Rectangles covering { (x,y) : x is a best reply to y }. */
function brA(g: GamePayoffs): Rect[] {
  const slope = (g.a11 - g.a21) - (g.a12 - g.a22);   // DA(y) = slope*y + c
  const c = g.a12 - g.a22;
  const out: Rect[] = [];
  if (Math.abs(slope) < NE_EPS) {
    if (Math.abs(c) < NE_EPS) return [{ x0: 0, x1: 1, y0: 0, y1: 1 }];   // indifferent everywhere
    return [c > 0 ? { x0: 1, x1: 1, y0: 0, y1: 1 } : { x0: 0, x1: 0, y0: 0, y1: 1 }];
  }
  const root = -c / slope;                                            // DA(root) = 0
  const interior = root > NE_EPS && root < 1 - NE_EPS;
  const onSquare = root >= -NE_EPS && root <= 1 + NE_EPS;                   // a root AT y=0 or y=1 is
  const sgnAt = (y: number) => slope * y + c;                         // still a real indifference
  for (const [lo, hi] of (interior ? [[0, root], [root, 1]] : [[0, 1]]) as [number, number][]) {
    const mid = (lo + hi) / 2;
    const x = sgnAt(mid) > 0 ? 1 : 0;
    out.push({ x0: x, x1: x, y0: lo, y1: hi });
  }
  if (onSquare) { const r = Math.min(1, Math.max(0, root)); out.push({ x0: 0, x1: 1, y0: r, y1: r }); }
  return out;
}

/** Rectangles covering { (x,y) : y is a best reply to x }. */
function brB(g: GamePayoffs): Rect[] {
  const slope = (g.b11 - g.b12) - (g.b21 - g.b22);
  const c = g.b21 - g.b22;
  const out: Rect[] = [];
  if (Math.abs(slope) < NE_EPS) {
    if (Math.abs(c) < NE_EPS) return [{ x0: 0, x1: 1, y0: 0, y1: 1 }];
    return [c > 0 ? { x0: 0, x1: 1, y0: 1, y1: 1 } : { x0: 0, x1: 1, y0: 0, y1: 0 }];
  }
  const root = -c / slope;
  const interior = root > NE_EPS && root < 1 - NE_EPS;
  const onSquare = root >= -NE_EPS && root <= 1 + NE_EPS;
  const sgnAt = (x: number) => slope * x + c;
  for (const [lo, hi] of (interior ? [[0, root], [root, 1]] : [[0, 1]]) as [number, number][]) {
    const mid = (lo + hi) / 2;
    const y = sgnAt(mid) > 0 ? 1 : 0;
    out.push({ x0: lo, x1: hi, y0: y, y1: y });
  }
  if (onSquare) { const r = Math.min(1, Math.max(0, root)); out.push({ x0: r, x1: r, y0: 0, y1: 1 }); }
  return out;
}

const intersect = (p: Rect, q: Rect): Rect | null => {
  const x0 = Math.max(p.x0, q.x0), x1 = Math.min(p.x1, q.x1);
  const y0 = Math.max(p.y0, q.y0), y1 = Math.min(p.y1, q.y1);
  return x0 <= x1 + NE_EPS && y0 <= y1 + NE_EPS ? { x0, x1: Math.max(x0, x1), y0, y1: Math.max(y0, y1) } : null;
};
const contains = (big: Rect, small: Rect) =>
  big.x0 <= small.x0 + NE_EPS && big.x1 >= small.x1 - NE_EPS && big.y0 <= small.y0 + NE_EPS && big.y1 >= small.y1 - NE_EPS;

export function equilibriumSet(g: GamePayoffs): Rect[] {
  const parts: Rect[] = [];
  for (const p of brA(g)) for (const q of brB(g)) { const r = intersect(p, q); if (r) parts.push(r); }
  // Drop any component contained in another (a corner sitting on an edge).
  return parts.filter((r, i) => !parts.some((o, j) => j !== i && contains(o, r) && (o.x1 - o.x0 + o.y1 - o.y0 > r.x1 - r.x0 + r.y1 - r.y0 + NE_EPS)))
    .filter((r, i, a) => a.findIndex((o) => Math.abs(o.x0 - r.x0) < NE_EPS && Math.abs(o.x1 - r.x1) < NE_EPS && Math.abs(o.y0 - r.y0) < NE_EPS && Math.abs(o.y1 - r.y1) < NE_EPS) === i);
}

export const kindOf = (r: Rect): 'point' | 'segment' | 'area' =>
  r.x1 - r.x0 < NE_EPS && r.y1 - r.y0 < NE_EPS ? 'point' : (r.x1 - r.x0 > NE_EPS && r.y1 - r.y0 > NE_EPS ? 'area' : 'segment');

/**
 * Plain-language description of the equilibrium COMPONENTS that the corner
 * model cannot express — the segments and areas returned by equilibriumSet.
 * Isolated points are already listed by computeAllNE, so they are skipped:
 * this exists to stop the report from silently under-reporting a continuum
 * (a whole edge is an equilibrium set on 3 of every 4 games with a payoff tie).
 * x = P(A plays Row 1), y = P(B plays Col 1), matching computeAllNE's labels.
 */
export function describeContinua(g: GamePayoffs): string[] {
  // Use the SHARED formatter. This function carried its own copy, so every
  // invariant won for `tieProse` and the solver label skipped it: pct(0.00049975)
  // returned "0", and the line then claimed "x anywhere from 0 to 1" on a set
  // that starts at 0.00049975 — at (0,1) regretB is 0.1, so the stated interval
  // began at a NON-equilibrium. Found by an adversarial red team; 3.3% of random
  // 3-dp matrices with a continuum print an interior coordinate as 0 or 1.
  const pct = fmtProb;
  // `fmtProb` may return a THRESHOLD phrase rather than a number, which reads
  // wrong after "=" ("y = less than 0.001"). Use a preposition in that form.
  const at = (axis: string, v: number) => {
    const t = fmtProb(v);
    return t.startsWith('less') ? `${axis} below 0.001`
      : t.startsWith('more') ? `${axis} above 0.999`
      : `${axis} = ${t}`;
  };
  const fixedRow = (x: number) => `Row ${x === 1 ? '1' : '2'}`;
  const fixedCol = (y: number) => `Col ${y === 1 ? '1' : '2'}`;
  const out: string[] = [];
  for (const r of equilibriumSet(g)) {
    const kind = kindOf(r);
    if (kind === 'point') continue;
    if (kind === 'area') {
      out.push('Every pair of mixtures in the whole [0, 1] × [0, 1] space is an equilibrium — both players are indifferent everywhere.');
      continue;
    }
    const xFixed = r.x1 - r.x0 < NE_EPS;
    if (xFixed) {
      const aPart = r.x0 === 0 || r.x0 === 1 ? `A plays ${fixedRow(r.x0)}` : `A mixes at ${at('x', r.x0)}`;
      const bPart = r.y0 === 0 && r.y1 === 1
        ? 'B plays ANY mixture (y anywhere in [0, 1])'
        : `B mixes with y anywhere from ${pct(r.y0)} to ${pct(r.y1)}`;
      out.push(`A continuum of equilibria: ${aPart} while ${bPart}.`);
    } else {
      const bPart = r.y0 === 0 || r.y0 === 1 ? `B plays ${fixedCol(r.y0)}` : `B mixes at ${at('y', r.y0)}`;
      const aPart = r.x0 === 0 && r.x1 === 1
        ? 'A plays ANY mixture (x anywhere in [0, 1])'
        : `A mixes with x anywhere from ${pct(r.x0)} to ${pct(r.x1)}`;
      out.push(`A continuum of equilibria: ${bPart} while ${aPart}.`);
    }
  }
  return out;
}

// ── Random game generation ───────────────────────────────────────────────────
// Rejection-sample integer matrices until the SOLVER (not a heuristic) agrees
// the game has the requested equilibrium structure:
//   'pure'  — at least one pure NE, so best-response dynamics settle on a corner.
//   'mixed' — no pure NE at all and a fully-interior mixed NE, the cycling
//             games where the ghost-coordinate machinery earns its keep.
// Ties in a player's own payoffs are rejected up front: a tie makes a best
// response weak, which admits NE continua that computeAllNE's corner+interior
// model cannot enumerate — exactly the games the report validator refuses.
export function generateRandomGame(kind: 'pure' | 'mixed'): GamePayoffs {
  for (let tries = 0; tries < 5000; tries++) {
    const cell = () => Math.floor(Math.random() * 19) - 9; // integers in [-9, 9]
    const g: GamePayoffs = {
      a11: cell(), a12: cell(), a21: cell(), a22: cell(),
      b11: cell(), b12: cell(), b21: cell(), b22: cell(),
    };
    if (g.a11 === g.a21 || g.a12 === g.a22 || g.b11 === g.b12 || g.b21 === g.b22) continue;
    const nes = computeAllNE(g);
    const pureCount = nes.filter((n) => n.type === 'pure').length;
    const hasMixed = nes.some((n) => n.type === 'mixed');
    if (kind === 'mixed' ? pureCount === 0 && hasMixed : pureCount > 0) return g;
  }
  // Statistically unreachable (each draw succeeds well over 10% of the time);
  // matching pennies / prisoner's dilemma keep the return type total anyway.
  return kind === 'mixed'
    ? { a11: 1, a12: -1, a21: -1, a22: 1, b11: -1, b12: 1, b21: 1, b22: -1 }
    : { a11: -1, a12: -3, a21: 0, a22: -2, b11: -1, b12: 0, b21: -3, b22: -2 };
}

export function chooseBestPureNEForMover(mover: 'A' | 'B', pureNEs: NashEquilibrium[]): NashEquilibrium | null {
  if (pureNEs.length === 0) return null;
  if (pureNEs.length === 1) return pureNEs[0];
  return pureNEs.reduce((best, ne) => {
    const myP   = mover === 'A' ? ne.eA   : ne.eB;
    const bestP = mover === 'A' ? best.eA : best.eB;
    return myP > bestP ? ne : best;
  });
}

// ── Payoff equation string builder ───────────────────────────────────────────
export function buildPolyStr(cXY: number, cX: number, cY: number, cC: number): string {
  const terms: string[] = [];
  function addTerm(coef: number, v: string) {
    const c = r3(coef);
    if (Math.abs(c) < 1e-9) return;
    const sign = c > 0 ? '+' : '-';
    const abs  = Math.abs(c);
    const cs   = (Math.abs(abs - 1) < 1e-9 && v !== '') ? '' : abs.toString();
    if (terms.length === 0) terms.push((c < 0 ? '-' : '') + cs + v);
    else terms.push(' ' + sign + ' ' + cs + v);
  }
  addTerm(cXY, 'xy');
  addTerm(cX, 'x');
  addTerm(cY, 'y');
  addTerm(cC, '');
  return terms.length === 0 ? '0' : terms.join('');
}

// ── Bisection helper: adjusts domain on Phase 1 cycle detection ──────────────
// Records the best-response sign pattern from the first cycle. On subsequent
// cycles, if the pattern is unchanged the domain shrinks normally. When the
// pattern flips (domain overshot the NE coordinate) we bisect between the last
// known-good domain and the current bad domain until the EPS check fires.
function applyBisectCycleStep(s: SimState, g: GamePayoffs, defaultStep: number, mover: 'A' | 'B'): void {
  const sAFn = (y: number) => y * (g.a11 - g.a21) + (1 - y) * (g.a12 - g.a22);
  const sBFn = (x: number) => x * (g.b11 - g.b12) + (1 - x) * (g.b21 - g.b22);
  const pat = {
    aHi: sAFn(s.domainHi), aLo: sAFn(s.domainLo),
    bHi: sBFn(s.domainHi), bLo: sBFn(s.domainLo),
  };

  const EPS_PAT = 1e-4;
  const patternOK = s.cyclePattern === null || (
    !(Math.abs(pat.aHi) > EPS_PAT && Math.sign(pat.aHi) !== Math.sign(s.cyclePattern.aHi)) &&
    !(Math.abs(pat.aLo) > EPS_PAT && Math.sign(pat.aLo) !== Math.sign(s.cyclePattern.aLo)) &&
    !(Math.abs(pat.bHi) > EPS_PAT && Math.sign(pat.bHi) !== Math.sign(s.cyclePattern.bHi)) &&
    !(Math.abs(pat.bLo) > EPS_PAT && Math.sign(pat.bLo) !== Math.sign(s.cyclePattern.bLo))
  );

  let newLo: number;
  let newHi: number;

  if (!s.bisecting) {
    if (patternOK) {
      // Forward phase: store reference on first cycle, update good bounds, shrink normally
      if (s.cyclePattern === null) s.cyclePattern = pat;
      s.bisectGoodLo = s.domainLo;
      s.bisectGoodHi = s.domainHi;
      newLo = r3(s.domainLo + defaultStep);
      newHi = r3(s.domainHi - defaultStep);
    } else {
      // First overshoot: enter bisect mode, try midpoint between last good and current bad
      s.bisecting = true;
      s.bisectBadLo = s.domainLo;
      s.bisectBadHi = s.domainHi;
      newLo = r3((s.bisectGoodLo + s.bisectBadLo) / 2);
      newHi = r3((s.bisectGoodHi + s.bisectBadHi) / 2);
    }
  } else {
    // Bisect phase: update good or bad boundary based on current pattern result
    if (patternOK) {
      s.bisectGoodLo = s.domainLo;
      s.bisectGoodHi = s.domainHi;
    } else {
      s.bisectBadLo = s.domainLo;
      s.bisectBadHi = s.domainHi;
    }
    newLo = r3((s.bisectGoodLo + s.bisectBadLo) / 2);
    newHi = r3((s.bisectGoodHi + s.bisectBadHi) / 2);
    // If rounding made no progress (stuck at bisectGood), use the bad boundary instead
    // so the EPS check can fire at the correct rounded coordinate.
    if (newLo === s.bisectGoodLo && newHi === s.bisectGoodHi) {
      newLo = s.bisectBadLo;
      newHi = s.bisectBadHi;
    }
  }

  s.domainLo = newLo;
  s.domainHi = newHi;

  if (s.domainLo >= s.domainHi - 0.0005) {
    s.domainLo = s.domainHi = r3((s.domainLo + s.domainHi) / 2);
  }

  s.cx    = r3(Math.max(s.domainLo, Math.min(s.domainHi, s.cx)));
  s.cy    = r3(Math.max(s.domainLo, Math.min(s.domainHi, s.cy)));
  s.calcX = r3(Math.max(s.domainLo, Math.min(s.domainHi, s.calcX ?? s.cx)));
  s.calcY = r3(Math.max(s.domainLo, Math.min(s.domainHi, s.calcY ?? s.cy)));
  // Squeeze the strategy-line representative into the contracted corridor so it
  // eases toward the NE coordinate as the bracket closes (gradual flattening).
  s.stratX = r3(Math.max(s.domainLo, Math.min(s.domainHi, s.stratX)));
  s.stratY = r3(Math.max(s.domainLo, Math.min(s.domainHi, s.stratY)));

  // Retroactively snap only the mover's axis in the last recorded path point.
  // The non-mover axis stays at its pre-clamp value so the NEXT step (opposite mover)
  // changes only that axis — keeping the path axis-aligned with no diagonals.
  if (s.pathSegmentsA.length > 0) {
    const lastA = s.pathSegmentsA[s.pathSegmentsA.length - 1];
    const nA = lastA.xs.length - 1;
    if (nA >= 0) {
      if (mover === 'A') lastA.xs[nA] = s.cx;
      else lastA.ys[nA] = s.cy;
      lastA.zs[nA] = r3(EA(lastA.xs[nA], lastA.ys[nA], g));
    }
  }
  if (s.pathSegmentsB.length > 0) {
    const lastB = s.pathSegmentsB[s.pathSegmentsB.length - 1];
    const nB = lastB.xs.length - 1;
    if (nB >= 0) {
      if (mover === 'A') lastB.xs[nB] = s.cx;
      else lastB.ys[nB] = s.cy;
      lastB.zs[nB] = r3(EB(lastB.xs[nB], lastB.ys[nB], g));
    }
  }
}

// ── Phase 2 ghost corridor bisection ─────────────────────────────────────────
// Contracts the search corridor [domainLo, domainHi] onto the second mixed
// coordinate — the single root of the unfound axis's indifference line.
//
// The line is monotone and, at Phase-2 entry, is bracketed by [lo,hi] with
// OPPOSITE signs (doStep resets the corridor to [0,1] if the Phase-1 bracket was
// lost). A single root can only be approached from one side per bound, so the old
// scheme — stepping BOTH bounds inward symmetrically — marched to the corridor
// CENTRE and stalled (or collapsed to the wrong point) whenever the root sat
// off-centre. This version moves each bound TOWARD THE ROOT instead: it advances a
// bound by the largest step ≤ defaultStep that does not cross the root (same sign),
// halving the step on overshoot. Small step ⇒ linear creep; large step ⇒
// overshoot-and-halve ≡ classical bisection — the v2 contraction schedule of
// RESEARCH_PLAN §2.1. The converged coordinate is read off the live indifference
// signal (smallest |fn| on the grid), never a precomputed root, per the design
// ethos ("found by dynamics, not precomputed").
function applyGhostBisectCycleStep(s: SimState, g: GamePayoffs, defaultStep: number): void {
  // foundAxis='x': x* found → searching y* → sA(y) = y*(a11-a21)+(1-y)*(a12-a22)
  // foundAxis='y': y* found → searching x* → sB(x) = x*(b11-b12)+(1-x)*(b21-b22)
  const fn = s.foundAxis === 'x'
    ? (v: number) => v * (g.a11 - g.a21) + (1 - v) * (g.a12 - g.a22)
    : (v: number) => v * (g.b11 - g.b12) + (1 - v) * (g.b21 - g.b22);

  const lo = s.domainLo;
  const hi = s.domainHi;
  const sLo = fn(lo);
  const sHi = fn(hi);

  // Advance `from` toward the opposite bound `toward` by the largest step
  // ≤ defaultStep that keeps fn's sign (i.e. does not cross the root). Halve the
  // step on overshoot; return `from` unchanged once no sub-step clears the root.
  const advance = (from: number, toward: number, keepSign: number): number => {
    const dir = Math.sign(toward - from);
    if (dir === 0) return from;
    let step = defaultStep;
    for (let k = 0; k < 24 && step >= 1e-4; k++) {
      const cand = r3(from + dir * step);
      const beyond = dir > 0 ? cand >= toward : cand <= toward;
      if (!beyond && Math.sign(fn(cand)) === keepSign) return cand;
      step /= 2;
    }
    return from;
  };

  let newLo: number;
  let newHi: number;
  if (sLo === 0) {
    // Root sits exactly on lo — collapse there, not the midpoint. (Unreachable in
    // the mixed-NE-only path: sLo===0 needs a12===a22, which drives the root to a
    // boundary and makes computeMixedNE return null so Phase 2 is never entered.
    // Guarded anyway because the failure mode would be a silent wrong answer.)
    newLo = newHi = r3(lo);
  } else if (sHi === 0) {
    newLo = newHi = r3(hi);
  } else if (Math.sign(sLo) !== Math.sign(sHi)) {
    newLo = advance(lo, hi, Math.sign(sLo));
    newHi = advance(hi, lo, Math.sign(sHi));
    if (newLo > newHi) { const m = r3((newLo + newHi) / 2); newLo = m; newHi = m; }
  } else {
    // Bracket lost (same sign at both ends): collapse to the midpoint.
    newLo = newHi = r3((lo + hi) / 2);
  }

  s.domainLo = newLo;
  s.domainHi = newHi;

  // Tight bracket → snap to the grid point carrying the smallest live indifference
  // signal (the root) and collapse. Read purely off the signal, not a precomputed
  // coordinate, so a half-grid boundary can't round onto the wrong cell.
  if (s.domainHi - s.domainLo <= 0.0025) {
    let root = r3(s.domainLo);
    for (let v = r3(s.domainLo); v <= s.domainHi + 1e-9; v = r3(v + 0.001)) {
      if (Math.abs(fn(v)) < Math.abs(fn(root))) root = r3(v);
    }
    s.domainLo = s.domainHi = root;
  }

  s.calcX = r3(Math.max(s.domainLo, Math.min(s.domainHi, s.calcX ?? s.cx)));
  s.calcY = r3(Math.max(s.domainLo, Math.min(s.domainHi, s.calcY ?? s.cy)));
  // Squeeze the strategy-line representative into the contracted corridor.
  s.stratX = r3(Math.max(s.domainLo, Math.min(s.domainHi, s.stratX)));
  s.stratY = r3(Math.max(s.domainLo, Math.min(s.domainHi, s.stratY)));
}

// ── Algorithm control parameters ─────────────────────────────────────────────
export function pickShrinkStep(
  lo: number, 
  hi: number, 
  mixedNE: NashEquilibrium | undefined, 
  defaultStep: number,
  foundAxis: 'x' | 'y' | null = null
): number {
  if (!mixedNE) return 0.001;
  
  let dists: number[] = [];
  if (foundAxis === 'x') {
    // x is found, so we are searching for y. Check only distance of lo and hi to y*
    dists = [
      Math.abs(lo - mixedNE.y),
      Math.abs(hi - mixedNE.y),
    ];
  } else if (foundAxis === 'y') {
    // y is found, so we are searching for x. Check only distance of lo and hi to x*
    dists = [
      Math.abs(lo - mixedNE.x),
      Math.abs(hi - mixedNE.x),
    ];
  } else {
    // Both/neither found
    dists = [
      Math.abs(lo - mixedNE.x), Math.abs(hi - mixedNE.x),
      Math.abs(lo - mixedNE.y), Math.abs(hi - mixedNE.y),
    ];
  }
  
  const minDist = Math.min(...dists);
  if (minDist <= 0.01) return 0.001;
  if (minDist <= defaultStep) return 0.01;
  return defaultStep;
}

// ── Helper to append points into paths ────────────────────────────────────────
export function pushToSegs(
  state: SimState,
  x: number,
  y: number,
  zA: number,
  zB: number,
  mover: 'A' | 'B'
) {
  if (state.pathSegmentsA.length === 0 || state.pathSegmentsA[state.pathSegmentsA.length - 1].mover !== mover) {
    const prevSeg = state.pathSegmentsA[state.pathSegmentsA.length - 1];
    const nsA: PathSegment = { xs: [], ys: [], zs: [], mover };
    if (prevSeg && prevSeg.xs.length > 0) {
      const n = prevSeg.xs.length - 1;
      nsA.xs.push(prevSeg.xs[n]);
      nsA.ys.push(prevSeg.ys[n]);
      nsA.zs.push(prevSeg.zs[n]);
    } else {
      nsA.xs.push(x);
      nsA.ys.push(y);
      nsA.zs.push(zA);
    }
    state.pathSegmentsA.push(nsA);
  }
  const currSegA = state.pathSegmentsA[state.pathSegmentsA.length - 1];
  currSegA.xs.push(x);
  currSegA.ys.push(y);
  currSegA.zs.push(zA);

  if (state.pathSegmentsB.length === 0 || state.pathSegmentsB[state.pathSegmentsB.length - 1].mover !== mover) {
    const prevSeg = state.pathSegmentsB[state.pathSegmentsB.length - 1];
    const nsB: PathSegment = { xs: [], ys: [], zs: [], mover };
    if (prevSeg && prevSeg.xs.length > 0) {
      const n = prevSeg.xs.length - 1;
      nsB.xs.push(prevSeg.xs[n]);
      nsB.ys.push(prevSeg.ys[n]);
      nsB.zs.push(prevSeg.zs[n]);
    } else {
      nsB.xs.push(x);
      nsB.ys.push(y);
      nsB.zs.push(zB);
    }
    state.pathSegmentsB.push(nsB);
  }
  const currSegB = state.pathSegmentsB[state.pathSegmentsB.length - 1];
  currSegB.xs.push(x);
  currSegB.ys.push(y);
  currSegB.zs.push(zB);
}

// ── Correct Ghost steps in Phase 2 ───────────────────────────────────────────
// Updates exactly ONE axis depending on who moves:
// - If foundAxis === 'x': y is unfound axis (controlled by B).
//   - When B moves: B flips y to the opposite corridor boundary (lo <-> hi).
//   - When A moves: A best-responds with x to the current y boundary.
// - If foundAxis === 'y': x is unfound axis (controlled by A).
//   - When A moves: A flips x to the opposite corridor boundary (lo <-> hi).
//   - When B moves: B best-responds with y to the current x boundary.
export function ghostStep(g: GamePayoffs, state: SimState, mover: 'A' | 'B') {
  const lo = state.domainLo;
  const hi = state.domainHi;

  const Dx = g.b11 - g.b12 - g.b21 + g.b22;
  const Dy = g.a11 - g.a12 - g.a21 + g.a22;
  const EPS_B = Math.abs(Dx) > 1e-9 ? Math.abs(Dx) * 0.00065 : 0.00065;
  const EPS_A = Math.abs(Dy) > 1e-9 ? Math.abs(Dy) * 0.00065 : 0.00065;

  let newX = state.calcX ?? state.cx;
  let newY = state.calcY ?? state.cy;

  if (state.foundAxis === 'x') {
    // y is unfound axis. Player B controls y, Player A controls x.
    if (mover === 'B') {
      // Flip y mechanically to opposite corridor boundary
      newY = (Math.abs(newY - lo) < Math.abs(newY - hi)) ? hi : lo;

      // Check discovery of y*: does newY make Player A indifferent?
      const sAcheck = newY * (g.a11 - g.a21) + (1 - newY) * (g.a12 - g.a22);
      if (Math.abs(sAcheck) < EPS_A && state.discoveredMixedY === null) {
        state.discoveredMixedY = r3(newY);
      }
    } else {
      // Player A moves and reacts on x-axis by best-responding to current y
      const sA = newY * (g.a11 - g.a21) + (1 - newY) * (g.a12 - g.a22);
      newX = sA > 1e-9 ? hi : (sA < -1e-9 ? lo : newX);
    }
  } else {
    // x is unfound axis. Player A controls x, Player B controls y.
    if (mover === 'A') {
      // Flip x mechanically to opposite corridor boundary
      newX = (Math.abs(newX - lo) < Math.abs(newX - hi)) ? hi : lo;

      // Check discovery of x*: does newX make Player B indifferent?
      const sBcheck = newX * (g.b11 - g.b12) + (1 - newX) * (g.b21 - g.b22);
      if (Math.abs(sBcheck) < EPS_B && state.discoveredMixedX === null) {
        state.discoveredMixedX = r3(newX);
      }
    } else {
      // Player B moves and reacts on y-axis by best-responding to current x
      const sB = newX * (g.b11 - g.b12) + (1 - newX) * (g.b21 - g.b22);
      newY = sB > 1e-9 ? hi : (sB < -1e-9 ? lo : newY);
    }
  }

  state.calcX = r3(newX);
  state.calcY = r3(newY);
}

// ── Step logic ───────────────────────────────────────────────────────────────
export function doStep(
  g: GamePayoffs,
  s: SimState,
  firstMover: 'A' | 'B',
  defaultShrinkStep: number,
  allNE: NashEquilibrium[],
  committedNE: NashEquilibrium | null,
  addLog: (msg: string) => void,
  onCycleDetected: () => void,
  onConverged: () => void,
  stepMode: 'shrink' | 'regret' = 'shrink'
) {
  if (s.converged) return;

  // The convergence delta check below needs exactly TWO NUMBERS: this step's
  // pre-move position. It used to get them from `s.historyStack.push(
  // createSnapshot(s))` — a deep clone of the entire trajectory, twelve array
  // clones per path segment across four segment arrays. Shrink mode opens a new
  // segment every step, so step k cloned ~k segments: O(N^2) allocation, run
  // SYNCHRONOUSLY inside a click handler. Measured on
  // A=[[7,-6],[-7,0]] B=[[-7,-4],[1,-6]] at the slider's own minimum lambda:
  // 69MB at 500 steps, 559MB at 1500, 2.7GB at 3000, and an OOM at 5000 even
  // with an 8GB heap. In the browser the renderer died outright, with ZERO
  // console errors — a single Step click was enough, which is what isolates it
  // to this precompute rather than to Plotly.
  //
  // Nothing else in the codebase ever read the stack: App.tsx only ever wrote
  // `historyStack: []`, and Back/"Go to step" are implemented by replayToStep,
  // not by undo. So the stack had exactly one consumer, reading exactly the
  // element it had just pushed.
  const prevCx = s.cx, prevCy = s.cy;

  const pureNEs = allNE.filter(n => n.type === 'pure');
  const mixedNE = allNE.find(n => n.type === 'mixed');
  const mover: 'A' | 'B' = (s.stepCount % 2 === 0) ? firstMover : (firstMover === 'A' ? 'B' : 'A');
  s.stepCount++;

  let nx = s.cx;
  let ny = s.cy;

  if (pureNEs.length > 1 && committedNE) {
    if (mover === firstMover) {
      // The first mover commits to its own preferred pure NE coordinate,
      // forcing the other player to best-respond into that equilibrium.
      if (mover === 'A') nx = committedNE.x;
      else ny = committedNE.y;
    } else if (mover === 'A') {
      // Follower A best-responds to the current y.
      const valRow1 = s.cy * g.a11 + (1 - s.cy) * g.a12;
      const valRow2 = s.cy * g.a21 + (1 - s.cy) * g.a22;
      nx = valRow1 >= valRow2 ? 1 : 0;
    } else {
      // Follower B best-responds to the current x.
      const valCol1 = s.cx * g.b11 + (1 - s.cx) * g.b21;
      const valCol2 = s.cx * g.b12 + (1 - s.cx) * g.b22;
      ny = valCol1 >= valCol2 ? 1 : 0;
    }
  } else if (pureNEs.length >= 1) {
    // Alternating best response: each mover best-responds to the opponent's
    // CURRENT strategy (s.cy / s.cx), not a frozen reference. (calcX/calcY are
    // kept in sync below; previously they were read here but never updated, so
    // both players forever best-responded to the START point — converging to the
    // mutual best response to the start rather than the equilibrium.)
    if (mover === 'A') {
      const sY = s.cy;
      const sA = sY * (g.a11 - g.a21) + (1 - sY) * (g.a12 - g.a22);
      if (sA > 1e-9) nx = s.domainHi;
      else if (sA < -1e-9) nx = s.domainLo;
      else if (mixedNE) nx = Math.max(s.domainLo, Math.min(s.domainHi, mixedNE.x));
    } else {
      const sX = s.cx;
      const sB = sX * (g.b11 - g.b12) + (1 - sX) * (g.b21 - g.b22);
      if (sB > 1e-9) ny = s.domainHi;
      else if (sB < -1e-9) ny = s.domainLo;
      else if (mixedNE) ny = Math.max(s.domainLo, Math.min(s.domainHi, mixedNE.y));
    }
    // Keep the best-response reference current for the next step and for the
    // cycle-detection / bisection helpers (mirrors the mixed-NE Phase-1 branch).
    s.calcX = r3(nx);
    s.calcY = r3(ny);
  } else {
    // ── Mixed NE only: Domain shrinking dynamics ────────────────────────────
    const Dx = g.b11 - g.b12 - g.b21 + g.b22;
    const Dy = g.a11 - g.a12 - g.a21 + g.a22;
    const EPS_B = Math.abs(Dx) > 1e-9 ? Math.abs(Dx) * 0.00065 : 0.00065;
    const EPS_A = Math.abs(Dy) > 1e-9 ? Math.abs(Dy) * 0.00065 : 0.00065;

    // We are in the no-pure-NE branch (the corner best-response checks found none).
    // By Nash's theorem a non-degenerate 2×2 game with no pure NE must have an
    // interior mixed NE — so the best responses cycle and the regret search is
    // valid WITHOUT ever consulting the precomputed mixed coordinate. Dx,Dy ≠ 0
    // just rules out a degenerate game where a player is indifferent everywhere.
    const regretEligible = stepMode === 'regret'
      && Math.abs(Dx) > 1e-9 && Math.abs(Dy) > 1e-9;

    if (regretEligible) {
      // ── Two-domain regret contraction (genuinely regret-driven) ───────────
      // Each player keeps their OWN domain. Every cycle a bound steps by the LIVE
      // regret signal evaluated THERE — the opponent's indifference gap — never by
      // distance to a precomputed root:
      //   sB(x) = E[Col1]−E[Col2] at x   (B's regret signal; zero ⇒ B indifferent)
      //   sA(y) = E[Row1]−E[Row2] at y   (A's regret signal; zero ⇒ A indifferent)
      // The step is a damped Newton move on that signal, step = λ·s / s′ (s′ = Dx
      // or Dy, the signal's own slope from the payoffs). Its direction is the sign
      // of the signal (which way reduces the opponent's regret) and its magnitude
      // scales with |s| — so it decelerates as the line flattens. The indifference
      // point is DISCOVERED where the signal crosses zero (detected by a sign flip
      // and pinned by secant), not supplied in advance. The midpoint (hi+lo)/2,
      // where the strategy line is drawn, eases flat one cycle at a time.
      const lambda = Math.max(0.001, Math.min(0.95, defaultShrinkStep));
      const regretGlide = (b: number, sfn: (v: number) => number, slope: number): number => {
        const sHere = sfn(b);
        if (Math.abs(sHere) < 1e-12) return b; // already indifferent here
        let step = lambda * sHere / slope; // damped Newton on the live regret signal
        if (Math.abs(step) < 0.001) step = Math.sign(step) * 0.001; // grid-unit floor → progress
        let nb = b - step;
        const sNext = sfn(nb);
        // Sign flip ⇒ the step crossed the indifference point; land on the zero by
        // secant (still derived only from the live signal, no precomputed root).
        if (sHere * sNext < 0) nb = b - sHere * (nb - b) / (sNext - sHere);
        return r3(Math.max(0, Math.min(1, nb)));
      };
      const sBfn = (x: number) => x * (g.b11 - g.b12) + (1 - x) * (g.b21 - g.b22);
      const sAfn = (y: number) => y * (g.a11 - g.a21) + (1 - y) * (g.a12 - g.a22);

      // Best-response cycling: each mover flips its OWN axis to a domain corner in
      // response to the opponent's CURRENT corner (s.cx / s.cy), so the path rotates
      // around the box perimeter exactly like shrink mode. (Using the midpoint here
      // would freeze it at one corner — no rotation.)
      if (mover === 'A') {
        nx = sAfn(s.cy) > 0 ? s.domXHi : s.domXLo;
        ny = s.cy;
      } else {
        ny = sBfn(s.cx) > 0 ? s.domYHi : s.domYLo;
        nx = s.cx;
      }
      s.calcX = r3(nx);
      s.calcY = r3(ny);

      // One contraction per full perimeter loop: step each domain's bounds by the
      // opponent's live regret. As the signal → 0 the steps shrink, so the domain
      // closes and its midpoint's strategy line flattens. The converged coordinate
      // is read off the collapsed domain — found by the dynamics, not precomputed.
      const rkey = r3(nx).toFixed(3) + ',' + r3(ny).toFixed(3);
      if (s.visitedPositions.includes(rkey)) {
        // A revisited best-response corner means the dynamics cycle — proof there
        // is no pure-strategy NE, so a mixed-strategy NE must exist to find.
        if (s.cycleCount === 0) {
          addLog('↻ Best responses cycle — no pure NE, so a mixed NE must exist. Contracting on it via regret.');
        }
        s.cycleCount++;
        s.visitedPositions = [];
        // Both corridors contract IN PARALLEL, every cycle. A brief revision
        // contracted one at a time ("steepest first") so the waiting line kept
        // its lean until its turn — but a line frozen mid-search reads as
        // rigged, and the same separation falls out honestly from the
        // declaration criterion below: with a widened declare threshold, the
        // coordinate whose root sits nearer the corridor midpoint reaches
        // indifference first while the other still has visible lean left.
        if (s.discoveredMixedX === null) { s.domXLo = regretGlide(s.domXLo, sBfn, Dx); s.domXHi = regretGlide(s.domXHi, sBfn, Dx); }
        if (s.discoveredMixedY === null) { s.domYLo = regretGlide(s.domYLo, sAfn, Dy); s.domYHi = regretGlide(s.domYHi, sAfn, Dy); }
        s.stratX = r3((s.domXLo + s.domXHi) / 2);
        s.stratY = r3((s.domYLo + s.domYHi) / 2);
        // A domain has converged once its remaining regret span is negligible.
        // Pin it to the neighbouring grid point with the smallest LIVE regret
        // (so a half-grid midpoint like r3(0.1675) can't round to the wrong cell) —
        // still read purely off the signal, not a precomputed root.
        /**
         * Declare once the midpoint's signal is within a few percent of zero,
         * and LAND by one undamped Newton step — exact for a linear signal, so
         * the declared value is the true root, not a 4%-off approximation. The
         * old criterion (|s| < |D|*0.00065) required the corridor to grind to
         * within a pixel of the root before declaring; by then the OTHER
         * line's lean had decayed by the same factor and the "first
         * coordinate found" moment showed nothing left to contrast against
         * (measured 0.2-0.3% of range, every game). Declaring at 4% keeps the
         * other line's lean visible at the first find — that is the entire
         * reason for the constant. Still blind: signal and slope both come
         * from the payoffs alone. The ±1-grid scan guards r3 rounding.
         */
        const REGRET_DECLARE = 0.04;
        const landOnIndifference = (mid: number, sfn: (v: number) => number, slope: number): number => {
          const landed = r3(Math.max(0, Math.min(1, mid - sfn(mid) / slope)));
          const cands = [r3(landed - 0.001), landed, r3(landed + 0.001)].filter(v => v >= 0 && v <= 1);
          return cands.reduce((best, v) => Math.abs(sfn(v)) < Math.abs(sfn(best)) ? v : best, landed);
        };
        const xDone = Math.abs(s.domXHi - s.domXLo) < 0.0015 || Math.abs(sBfn(s.stratX)) < Math.abs(Dx) * REGRET_DECLARE;
        const yDone = Math.abs(s.domYHi - s.domYLo) < 0.0015 || Math.abs(sAfn(s.stratY)) < Math.abs(Dy) * REGRET_DECLARE;
        // Declare EACH coordinate the moment its own criterion fires, exactly
        // like shrink mode does. This used to declare both atomically "to avoid
        // a transient exactly-one-found state" — but that transient IS the
        // discovery event: without it regret mode never logs a first
        // coordinate, never sets foundAxis, and the "1st NE Coord" jump stays
        // dead no matter the game. The ghost renderer (the reason for the old
        // caution) is shrink-phase furniture and is now gated off in regret.
        if (xDone) {
          s.stratX = landOnIndifference(s.stratX, sBfn, Dx); s.domXLo = s.stratX; s.domXHi = s.stratX;
          if (s.discoveredMixedX === null) {
            s.discoveredMixedX = s.stratX;
            if (s.foundAxis === null) s.foundAxis = 'x';
            // The Newton landing can sit exactly ON a grid endpoint (0) while
            // the coordinate it discovered is 0.0004 — state the exact root,
            // as every other discovery message does.
            const _rx = computeMixedNE(g);
            addLog('✓ x-coordinate discovered: ' + fmtProb(_rx ? _rx.x : s.stratX));
          }
        }
        if (yDone) {
          s.stratY = landOnIndifference(s.stratY, sAfn, Dy); s.domYLo = s.stratY; s.domYHi = s.stratY;
          if (s.discoveredMixedY === null) {
            s.discoveredMixedY = s.stratY;
            if (s.foundAxis === null) s.foundAxis = 'y';
            const _ry = computeMixedNE(g);
            addLog('✓ y-coordinate discovered: ' + fmtProb(_ry ? _ry.y : s.stratY));
          }
        }
        addLog(`↺ Cycle ${s.cycleCount} → A∈[${r3(s.domXLo).toFixed(3)},${r3(s.domXHi).toFixed(3)}] B∈[${r3(s.domYLo).toFixed(3)},${r3(s.domYHi).toFixed(3)}] (regretλ=${r3(lambda)})`);
        onCycleDetected();
      } else {
        s.visitedPositions.push(rkey);
      }
    } else {

    const inPhase2 = (s.discoveredMixedX !== null) !== (s.discoveredMixedY !== null);

    if (!inPhase2) {
      // ── Phase 1: standard best-response cycling ───────────────────────────
      nx = s.calcX ?? s.cx;
      ny = s.calcY ?? s.cy;
      if (mover === 'A') {
        const sA3 = ny * (g.a11 - g.a21) + (1 - ny) * (g.a12 - g.a22);
        nx = sA3 > 0 ? s.domainHi : s.domainLo;
        const sB3 = nx * (g.b11 - g.b12) + (1 - nx) * (g.b21 - g.b22);
        if (Math.abs(sB3) < EPS_B && s.discoveredMixedX === null) {
          s.discoveredMixedX = r3(nx);
          // Speak from the EXACT solver root, not the grid landing: discovery
          // fires when the landing is within tolerance of the root, so nx can
          // BE 0.000 (a grid point) while the coordinate it discovered is
          // 0.0004 — printing the landing calls a mixed coordinate 0.
          const _p1x = computeMixedNE(g);
          addLog('✓ x-coordinate discovered: ' + fmtProb(_p1x ? _p1x.x : nx));
        }
      } else {
        const sB3 = nx * (g.b11 - g.b12) + (1 - nx) * (g.b21 - g.b22);
        ny = sB3 > 0 ? s.domainHi : s.domainLo;
        const sA3 = ny * (g.a11 - g.a21) + (1 - ny) * (g.a12 - g.a22);
        if (Math.abs(sA3) < EPS_A && s.discoveredMixedY === null) {
          s.discoveredMixedY = r3(ny);
          const _p1y = computeMixedNE(g);
          addLog('✓ y-coordinate discovered: ' + fmtProb(_p1y ? _p1y.y : ny));
        }
      }
      s.calcX = r3(nx);
      s.calcY = r3(ny);
    } else {
      // ── Phase 2: ghost cycles freely; large sphere inches along unfound axis ─
      if (s.foundAxis === null) {
        s.foundAxis = s.discoveredMixedX !== null ? 'x' : 'y';
        s.phase1PtsA = s.pathSegmentsA.reduce((n, seg) => n + seg.xs.length, 0);
        s.phase1PtsB = s.pathSegmentsB.reduce((n, seg) => n + seg.xs.length, 0);
        // Use the Phase 1 domain as the starting corridor if it brackets the
        // second NE coordinate (opposite signs of the indifference function at
        // lo and hi). If the bracket is lost, EXTEND ONLY the bound on the
        // root's side — never the whole corridor back to [0,1].
        //
        // The [0,1] reset erased Phase 1's work on camera: on the tab-wedge
        // fixture A=[[7,-6],[-7,0]] B=[[-7,-4],[1,-6]] (x*=0.7, y*=0.3) Phase 1
        // contracts the domain to exactly [y*, x*] = [0.3, 0.7] — the second
        // root sits ON the lo boundary, so fn(lo)·fn(hi) = 0 and the old
        // `>= 0` test read a PERFECT bracket as lost, snapping the corridor
        // back to the full cube right after the green box had narrowed. It
        // also made the run 3500 steps longer than the geometry needs, which
        // is why that fixture "needs exactly 5000".
        //
        // A boundary root needs no reset at all: ghostStep's first flip to
        // that boundary is within the discovery tolerance and declares the
        // coordinate. The tolerance here is the SAME one ghostStep uses, so
        // "keep the corridor" and "discovery will fire" can never disagree.
        // When the root is strictly outside AND far from both bounds, the
        // indifference line is linear with a root strictly inside (0,1) —
        // this path only runs for games with an interior mixed NE — so the
        // root lies beyond the bound with the smaller |fn|; extending just
        // that bound to 0 or 1 always restores a bracket while the other
        // bound keeps everything Phase 1 narrowed.
        const _axis = s.discoveredMixedX !== null ? 'x' : 'y';
        const _fn = _axis === 'x'
          ? (v: number) => v * (g.a11 - g.a21) + (1 - v) * (g.a12 - g.a22)
          : (v: number) => v * (g.b11 - g.b12) + (1 - v) * (g.b21 - g.b22);
        const _det = _axis === 'x'
          ? g.a11 - g.a12 - g.a21 + g.a22
          : g.b11 - g.b12 - g.b21 + g.b22;
        const _eps = Math.abs(_det) > 1e-9 ? Math.abs(_det) * 0.00065 : 0.00065;
        const _sLo = _fn(s.domainLo);
        const _sHi = _fn(s.domainHi);
        if (Math.abs(_sLo) >= _eps && Math.abs(_sHi) >= _eps && _sLo * _sHi > 0) {
          if (Math.abs(_sLo) < Math.abs(_sHi)) s.domainLo = 0;
          else s.domainHi = 1;
          // VERIFY the extension restored a bracket. It always does when the
          // corridor has positive width (proof above), but Phase 1 can also
          // contract the corridor all the way to a POINT — A[[0,1],[5,-3]]
          // B[[-3,-5],[-5,-3]] narrows to [0.5, 0.5] with the second root
          // y*=0.444 on the far side of the point: both |fn| are equal, the
          // tie-break extends the wrong side, and ghost bisection then cycles
          // on a bracket-less corridor forever (caught by the fuzz suite).
          // A point corridor carries no narrowing information to preserve, so
          // widening fully is honest — and a linear fn with an interior root
          // always brackets over [0,1].
          if (_fn(s.domainLo) * _fn(s.domainHi) > 0) {
            s.domainLo = 0;
            s.domainHi = 1;
          }
        }
        s.calcX = s.domainHi;
        s.calcY = s.domainHi;
        s.ghostVisitedPositions = [];
        s.ghostPathSegmentsA = [];
        s.ghostPathSegmentsB = [];
        s.ghostCyclePattern = null;
        s.ghostBisecting = false;
        s.ghostBisectGoodLo = s.domainLo;
        s.ghostBisectGoodHi = s.domainHi;
        s.ghostBisectBadLo = 0;
        s.ghostBisectBadHi = 1;
        addLog(`Phase 2: ${s.foundAxis}* locked, searching ${s.foundAxis === 'x' ? 'y' : 'x'}*`);
      }

      const prevGX = s.calcX!;
      const prevGY = s.calcY!;

      // Run ghost step (flips unfound axis, checks discovery)
      ghostStep(g, s, mover);

      const nextGX = s.calcX!;
      const nextGY = s.calcY!;

      // Find the mover of this ghost step based on which coordinate changed
      const isAMove = Math.abs(prevGX - nextGX) > 1e-7;
      const isBMove = Math.abs(prevGY - nextGY) > 1e-7;
      if (isAMove || isBMove) {
        const ghMover = isAMove ? 'A' : 'B';
        const ea1 = r3(EA(prevGX, prevGY, g));
        const ea2 = r3(EA(nextGX, nextGY, g));
        const eb1 = r3(EB(prevGX, prevGY, g));
        const eb2 = r3(EB(nextGX, nextGY, g));

        s.ghostPathSegmentsA.push({
          xs: [prevGX, nextGX],
          ys: [prevGY, nextGY],
          zs: [ea1, ea2],
          mover: ghMover
        });
        s.ghostPathSegmentsB.push({
          xs: [prevGX, nextGX],
          ys: [prevGY, nextGY],
          zs: [eb1, eb2],
          mover: ghMover
        });
      }

      // The stored coordinate is r3-collapsed, so printing it directly calls a
      // sub-resolution root (y* = 0.0004) "0.000". Speak from the EXACT solver
      // root, exactly as the convergence message below does; fall back to the
      // stored value only if the closed form is unavailable.
      const _gExact = computeMixedNE(g);
      if (s.discoveredMixedY !== null && s.foundAxis === 'x') {
        addLog('✓ y-coordinate discovered: ' + fmtProb(_gExact ? _gExact.y : s.discoveredMixedY));
      }
      if (s.discoveredMixedX !== null && s.foundAxis === 'y') {
        addLog('✓ x-coordinate discovered: ' + fmtProb(_gExact ? _gExact.x : s.discoveredMixedX));
      }

      // Large sphere: locked coord stays fixed; unfound coord snaps visually
      // to nearest corridor boundary to showcase shrinking progress.
      const currentDisplayX = s.displayX ?? s.cx;
      const currentDisplayY = s.displayY ?? s.cy;
      if (s.foundAxis === 'x') {
        nx = s.discoveredMixedX!;
        ny = (Math.abs(currentDisplayY - s.domainLo) <= Math.abs(currentDisplayY - s.domainHi))
          ? s.domainLo : s.domainHi;
      } else {
        ny = s.discoveredMixedY!;
        nx = (Math.abs(currentDisplayX - s.domainLo) <= Math.abs(currentDisplayX - s.domainHi))
          ? s.domainLo : s.domainHi;
      }

      // Ghost cycle detection: checks coordinates (calcX, calcY)
      const ghostKey = s.calcX!.toFixed(3) + ',' + s.calcY!.toFixed(3);
      if (s.ghostVisitedPositions.includes(ghostKey)) {
        s.cycleCount++;
        s.ghostVisitedPositions = [];

        applyGhostBisectCycleStep(s, g, defaultShrinkStep);

        // Snap large sphere's visual position to the updated boundaries
        if (s.foundAxis === 'x') {
          nx = s.discoveredMixedX!;
          ny = (Math.abs(ny - s.domainLo) <= Math.abs(ny - s.domainHi))
            ? s.domainLo : s.domainHi;
        } else {
          ny = s.discoveredMixedY!;
          nx = (Math.abs(nx - s.domainLo) <= Math.abs(nx - s.domainHi))
            ? s.domainLo : s.domainHi;
        }

        const searchMover = s.foundAxis === 'x' ? 'B' : 'A';
        addLog(`↺ Ghost cycle ${s.cycleCount} (${searchMover}) → corridor [${r3(s.domainLo).toFixed(3)},${r3(s.domainHi).toFixed(3)}]${s.ghostBisecting ? ' [bisecting]' : ` (step=${defaultShrinkStep})`}`);
        onCycleDetected();
      } else {
        s.ghostVisitedPositions.push(ghostKey);
      }
    }
    } // end shrink/bisection branch (non-regret)
  }

  // ── Update display position ──────────────────────────────────────────────
  s.displayX = s.discoveredMixedX !== null ? s.discoveredMixedX : r3(nx);
  s.displayY = s.discoveredMixedY !== null ? s.discoveredMixedY : r3(ny);
  s.cx = s.displayX;
  s.cy = s.displayY;
  // Keep the UNROUNDED coordinate. r3 here is a display decision; recording only
  // the rounded value left downstream code unable to tell 0.99937 from 1.
  s.exactX = s.discoveredMixedX !== null ? s.discoveredMixedX : nx;
  s.exactY = s.discoveredMixedY !== null ? s.discoveredMixedY : ny;

  const eA = r3(EA(s.cx, s.cy, g));
  const eB = r3(EB(s.cx, s.cy, g));
  pushToSegs(s, s.displayX, s.displayY, eA, eB, mover);

  const domStr = (s.domainLo > 0.0005 || s.domainHi < 0.9995)
    ? ' [' + r3(s.domainLo).toFixed(3) + ',' + r3(s.domainHi).toFixed(3) + ']' : '';
  addLog(`Step ${s.stepCount} (${mover})${domStr}: x=${s.cx.toFixed(3)}, y=${s.cy.toFixed(3)}  E[A]=${eA.toFixed(3)}  E[B]=${eB.toFixed(3)}`);

  // Check convergence conditions
  if (pureNEs.length > 0) {
    // Identical values to the old snapshot read: the snapshot was taken at the
    // top of THIS call, before any mutation, so prev.cx was s.cx at that moment.
    const dx = Math.abs(s.cx - prevCx);
    const dy = Math.abs(s.cy - prevCy);
    // Require both players to have moved at least once (stepCount >= 2) before
    // declaring convergence. Otherwise, if the first mover starts exactly on its
    // own indifference line (sA=0 / sB=0 → it legitimately doesn't move), this
    // delta check would fire after a single non-move and freeze at the start
    // point before the opponent ever responds.
    if (s.stepCount >= 2 && dx < 0.0003 && dy < 0.0003) {
      s.converged = true;
      const finalEA = r3(EA(s.cx, s.cy, g));
      const finalEB = r3(EB(s.cx, s.cy, g));
      // STATIONARY IS NOT EQUILIBRIUM. Check the independent regret oracle
      // before using the words "Nash equilibrium": the path can go stationary
      // at a point a player would leave (regret 18 on the fixture in types.ts).
      const rq = Math.max(Math.abs(regretA(s.cx, s.cy, g)), Math.abs(regretB(s.cx, s.cy, g)));
      s.convergedIsNE = Math.abs(regretA(s.cx, s.cy, g)) <= neTolerancePlayer(g, 'A')
        && Math.abs(regretB(s.cx, s.cy, g)) <= neTolerancePlayer(g, 'B');
      // The noun comes from WHERE IT LANDED, not from the fact that this is the
      // pure/shrink branch. This path can converge onto a continuum at a
      // strictly interior probability, where "Pure NE" is simply false.
      addLog(s.convergedIsNE
        ? `━━ ${profileConcept(s.cx, s.cy) === 'pure' ? 'Pure' : 'Mixed'} NE: x=${fmtProb(s.cx)}, y=${fmtProb(s.cy)}  E[A]=${finalEA.toFixed(3)}  E[B]=${finalEB.toFixed(3)}`
        : `━━ Settled at x=${fmtProb(s.cx)}, y=${fmtProb(s.cy)} — NOT an equilibrium (a player still gains ${rq.toFixed(3)} by switching)  E[A]=${finalEA.toFixed(3)}  E[B]=${finalEB.toFixed(3)}`);
      onConverged();
      return;
    }
  } else {
    if (s.discoveredMixedX !== null && s.discoveredMixedY !== null) {
      s.cx = s.discoveredMixedX;
      s.cy = s.discoveredMixedY;
      s.displayX = s.cx;
      s.displayY = s.cy;
      s.exactX = s.discoveredMixedX;
      s.exactY = s.discoveredMixedY;
      s.converged = true;
      const finalEA = r3(EA(s.cx, s.cy, g));
      const finalEB = r3(EB(s.cx, s.cy, g));
      const rqm = Math.max(Math.abs(regretA(s.cx, s.cy, g)), Math.abs(regretB(s.cx, s.cy, g)));
      s.convergedIsNE = Math.abs(regretA(s.cx, s.cy, g)) <= neTolerancePlayer(g, 'A')
        && Math.abs(regretB(s.cx, s.cy, g)) <= neTolerancePlayer(g, 'B');
      // Format from the EXACT solver coordinate, not from s.cx: the state is
      // already r3-collapsed, so fmtProb(s.cx) was a dead no-op — a sub-
      // resolution x printed as "0", reading as a pure strategy. And the log
      // must fork on the flag exactly as the pure branch does; it previously
      // always said "Mixed NE" regardless.
      const exact = computeMixedNE(g);
      const lx = fmtProb(exact ? exact.x : s.cx);
      const ly = fmtProb(exact ? exact.y : s.cy);
      addLog(s.convergedIsNE
        ? `━━ Mixed NE: x=${lx}, y=${ly}  E[A]=${finalEA.toFixed(3)}  E[B]=${finalEB.toFixed(3)}`
        : `━━ Settled at x=${lx}, y=${ly} — NOT an equilibrium (a player still gains ${rqm.toFixed(3)} by switching)  E[A]=${finalEA.toFixed(3)}  E[B]=${finalEB.toFixed(3)}`);
      onConverged();
      return;
    }
  }

  // ── Phase 1 cycle detection ────────────────────────────────────────────────
  // Regret mode handles its own per-cycle contraction inline above, so skip the
  // shared-corridor cycle detection here.
  const inPhase2Now = (s.discoveredMixedX !== null) !== (s.discoveredMixedY !== null);
  if (pureNEs.length === 0 && !inPhase2Now && stepMode !== 'regret') {
    const posKey = s.cx.toFixed(3) + ',' + s.cy.toFixed(3);
    if (s.visitedPositions.includes(posKey)) {
      s.cycleCount++;
      s.visitedPositions = [];
      applyBisectCycleStep(s, g, defaultShrinkStep, mover);
      addLog(`↺ Cycle ${s.cycleCount} → domain [${r3(s.domainLo).toFixed(3)},${r3(s.domainHi).toFixed(3)}]${s.bisecting ? ' [bisecting]' : ` (step=${defaultShrinkStep})`}`);
      onCycleDetected();
      return;
    }
    s.visitedPositions.push(posKey);
  }

  // ── Pure NE cycle detection ────────────────────────────────────────────────
  if (pureNEs.length > 0) {
    const posKey = s.cx.toFixed(3) + ',' + s.cy.toFixed(3);
    if (s.visitedPositions.includes(posKey)) {
      s.cycleCount++;
      s.visitedPositions = [];
      applyBisectCycleStep(s, g, defaultShrinkStep, mover);
      s.exactX = s.discoveredMixedX !== null ? s.discoveredMixedX : Math.max(s.domainLo, Math.min(s.domainHi, s.exactX));
      s.exactY = s.discoveredMixedY !== null ? s.discoveredMixedY : Math.max(s.domainLo, Math.min(s.domainHi, s.exactY));
      s.cx = s.discoveredMixedX !== null ? s.discoveredMixedX : r3(Math.max(s.domainLo, Math.min(s.domainHi, s.cx)));
      s.cy = s.discoveredMixedY !== null ? s.discoveredMixedY : r3(Math.max(s.domainLo, Math.min(s.domainHi, s.cy)));
      addLog(`↺ Cycle ${s.cycleCount} → domain [${r3(s.domainLo).toFixed(3)},${r3(s.domainHi).toFixed(3)}]${s.bisecting ? ' [bisecting]' : ` (step=${defaultShrinkStep})`}`);
      onCycleDetected();
      return;
    }
    s.visitedPositions.push(posKey);
  }
}

// ── Precomputed run history ──────────────────────────────────────────────────
/**
 * These three are pure simulation helpers with no React in them. They live here
 * rather than in App.tsx so the step cap and its truncation report can be
 * exercised by a unit test with an injected cap — the real cap now has roughly
 * 4x headroom over the worst reachable run (measured max 4,754 steps across
 * ~8,400 configurations), so the truncation path is unreachable from the UI and
 * would otherwise be untested code that renders user-visible text.
 */
/**
 * Was 5000, which the crash fixture converges at EXACTLY step 5000 — so the
 * moment the O(N^2) snapshot cost was fixed and that run could finish, the cap
 * would have cut it one step short and shown a full progress bar with Step
 * disabled: a completed-looking UI over an unfinished run.
 */
export const DEFAULT_MAX_STEPS = 20000;

export interface ThinSnapshot {
  cx: number; cy: number;
  calcX: number | null; calcY: number | null;
  discoveredMixedX: number | null; discoveredMixedY: number | null;
  foundAxis: 'x' | 'y' | null;
  domainLo: number; domainHi: number;
  converged: boolean; stepCount: number; cycleCount: number;
}

export function toThin(s: SimState): ThinSnapshot {
  return {
    cx: s.cx, cy: s.cy, calcX: s.calcX, calcY: s.calcY,
    discoveredMixedX: s.discoveredMixedX, discoveredMixedY: s.discoveredMixedY,
    foundAxis: s.foundAxis,
    domainLo: s.domainLo, domainHi: s.domainHi,
    converged: s.converged, stepCount: s.stepCount, cycleCount: s.cycleCount,
  };
}

export function precomputeThinHistory(
  initState: SimState,
  payoffs: GamePayoffs, firstMover: 'A' | 'B', shrinkStep: number,
  allNE: NashEquilibrium[], committedNE: NashEquilibrium | null,
  stepMode: 'shrink' | 'regret' = 'shrink',
  maxSteps: number = DEFAULT_MAX_STEPS
): { snaps: ThinSnapshot[], neState: SimState | null, truncated: boolean } {
  const snaps: ThinSnapshot[] = [toThin(initState)];
  const state: SimState = {
    ...initState,
    visitedPositions: [...initState.visitedPositions],
    ghostVisitedPositions: [...initState.ghostVisitedPositions],
    pathSegmentsA: initState.pathSegmentsA.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] })),
    pathSegmentsB: initState.pathSegmentsB.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] })),
    phase1PtsA: null, phase1PtsB: null,
    ghostPathSegmentsA: [], ghostPathSegmentsB: []
  };
  let neState: SimState | null = null;
  // Was 5000, which the red-team's own crash fixture converges at EXACTLY step
  // 5000 — so the moment the O(N^2) snapshot cost was fixed and that run could
  // finish, the cap would have silently cut it one step short and shown
  // "4999 / 4999" with Step disabled and no pill: a completed-looking progress
  // bar over an unfinished run. Fixing the crash would have converted a dead
  // defect into a live one. At ~3us/step post-fix, 20000 costs ~60ms.
  const MAX_STEPS = maxSteps;
  while (!state.converged && snaps.length < MAX_STEPS) {
    doStep(payoffs, state, firstMover, shrinkStep, allNE, committedNE, () => {}, () => {}, () => { state.running = false; }, stepMode);
    snaps.push(toThin(state));
    if (neState === null && (state.discoveredMixedX !== null || state.discoveredMixedY !== null)) {
      neState = {
        ...state,
        visitedPositions: [...state.visitedPositions],
        ghostVisitedPositions: [...state.ghostVisitedPositions],
        pathSegmentsA: state.pathSegmentsA.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] })),
        pathSegmentsB: state.pathSegmentsB.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] })),
        ghostPathSegmentsA: [], ghostPathSegmentsB: [], running: false
      };
    }
  }
  // A cap is still a cap. Report when it bound, so the caller can say so rather
  // than let a full-looking progress bar imply the run finished.
  return { snaps, neState, truncated: !state.converged };
}

export function replayToStep(
  initState: SimState, targetStep: number,
  payoffs: GamePayoffs, firstMover: 'A' | 'B', shrinkStep: number,
  allNE: NashEquilibrium[], committedNE: NashEquilibrium | null,
  stepMode: 'shrink' | 'regret' = 'shrink'
): SimState {
  const state: SimState = {
    ...initState,
    visitedPositions: [...initState.visitedPositions],
    ghostVisitedPositions: [...initState.ghostVisitedPositions],
    pathSegmentsA: initState.pathSegmentsA.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] })),
    pathSegmentsB: initState.pathSegmentsB.map((s): PathSegment => ({ ...s, xs: [...s.xs], ys: [...s.ys], zs: [...s.zs] })),
    phase1PtsA: null, phase1PtsB: null,
    ghostPathSegmentsA: [], ghostPathSegmentsB: []
  };
  for (let i = 0; i < targetStep; i++) {
    doStep(payoffs, state, firstMover, shrinkStep, allNE, committedNE, () => {}, () => {}, () => { state.running = false; }, stepMode);
  }
  return state;
}
