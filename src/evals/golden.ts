/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Golden games for the report eval harness.
 *
 * NO hand-written expected equilibria: ground truth is computed at run time from
 * the solver (computeAllNE + computeIndifference), so a fixture can never drift
 * out of sync with the code. Each matrix was verified to actually exhibit its
 * category, so the categories test something rather than being aspirational
 * labels. The category is the only claim baked in here, and it is checked
 * against the solver on load by assertCategories() below.
 *
 * Why the categories carry weight (don't "improve" them into blandness):
 *  - `no-pure` is the primary hallucination probe. Models reach for a
 *    pure-equilibrium narrative; these games have none, and inventing one is
 *    caught by both validator keys.
 *  - `degenerate` / both-indifferent is the direct test of the continuum fix:
 *    the model must collapse the enumerated corners into ONE 'continuum' claim,
 *    not enumerate them as separate pure equilibria. That path has never run
 *    against a live model — treat it as the least-trusted thing in the suite.
 *  - `near-tie` / near-boundary-mixed stresses coordinate fidelity: a model that
 *    "tidies" x=0.998 to 1.0 fails on regret, which is exactly the silent-
 *    rounding failure the harness exists to catch.
 */

import type { GamePayoffs } from '../types';
import { computeAllNE, computeIndifference } from '../utils/gameEngine';

export type GoldenCategory =
  | 'strict-dominance'
  | 'coordination'
  | 'no-pure'
  | 'degenerate'
  | 'near-tie'
  /**
   * Games whose NUMBERS are easy but whose STORY is easy to get wrong: all
   * payoffs negative, wildly mismatched scales between players, a weakly
   * dominated row, sub-unit magnitudes. Added after numeric hardening failed to
   * separate models — coordinate transcription turned out to be trivial for
   * them, while the prose was where actual errors appeared. These exist to be
   * caught by the prose checks in nashValidator, not the claim checks.
   */
  | 'adversarial';

export interface GoldenGame {
  name: string;
  category: GoldenCategory;
  payoffs: GamePayoffs;
}

/** G(a11,a12,a21,a22, b11,b12,b21,b22) — Player A payoffs first, then B. */
const G = (
  a11: number, a12: number, a21: number, a22: number,
  b11: number, b12: number, b21: number, b22: number,
): GamePayoffs => ({ a11, a12, a21, a22, b11, b12, b21, b22 });

export const GOLDEN: GoldenGame[] = [
  // strict-dominance — a single pure NE survives iterated dominance.
  { name: 'prisoners-dilemma', category: 'strict-dominance', payoffs: G(3, 0, 5, 1, 3, 5, 0, 1) }, // 1 pure (0,0)
  { name: 'row-dominant',      category: 'strict-dominance', payoffs: G(4, 3, 1, 0, 2, 1, 3, 4) }, // 1 pure (1,1)

  // coordination — two pure NE plus an interior mixed NE.
  { name: 'battle-of-sexes',   category: 'coordination',     payoffs: G(2, 0, 0, 1, 1, 0, 0, 2) }, // + mixed (0.667,0.333)
  { name: 'stag-hunt',         category: 'coordination',     payoffs: G(4, 0, 3, 3, 4, 3, 0, 3) }, // + mixed (0.75,0.75)

  // no-pure — the hallucination probe: no pure NE, only a mixed one.
  { name: 'matching-pennies',  category: 'no-pure',          payoffs: G(1, -1, -1, 1, -1, 1, 1, -1) }, // mixed (0.5,0.5)
  { name: 'asymmetric-pennies',category: 'no-pure',          payoffs: G(2, -1, -1, 1, -2, 1, 1, -1) }, // mixed (0.4,0.4)

  // degenerate — a flat-payoff player creates a continuum of equilibria.
  { name: 'A-indifferent',     category: 'degenerate',       payoffs: G(3, 1, 3, 1, 2, 4, 5, 0) }, // indiff(A)
  { name: 'B-indifferent',     category: 'degenerate',       payoffs: G(1, 4, 2, 0, 5, 5, 2, 2) }, // indiff(B)
  { name: 'both-indifferent',  category: 'degenerate',       payoffs: G(2, 2, 2, 2, 3, 3, 3, 3) }, // indiff(both), 4 corners

  // near-tie — stresses the solver's 1e-9 / r3 tolerances and model rounding.
  { name: 'tiny-margin',       category: 'near-tie',         payoffs: G(1, 0.999, 0.998, 1.001, 1, 0.998, 0.999, 1.002) }, // + mixed (0.6,0.5)
  { name: 'near-boundary-mixed',category: 'near-tie',        payoffs: G(10, 0, 0, 0.02, 0.02, 0, 0, 10) }, // + mixed (0.998,0.002)
  // (0.999, 0.001) is the practical extreme: past this, r3 rounds a coordinate
  // to 1.000 and computeMixedNE drops it for failing the strict 0<x<1 test.
  { name: 'extreme-boundary',  category: 'near-tie',         payoffs: G(100, 0, 0, 0.1, 0.1, 0, 0, 100) }, // + mixed (0.999,0.001)

  // adversarial — numbers are ordinary, the narrative is the trap.
  { name: 'all-negative',      category: 'adversarial',      payoffs: G(-1, -9, -9, -2, -2, -9, -9, -1) }, // every payoff < 0
  { name: 'asymmetric-scale',  category: 'adversarial',      payoffs: G(100, -100, -100, 100, 0.01, -0.01, -0.01, 0.01) }, // A ~10^2, B ~10^-2
  { name: 'weak-dominance',    category: 'adversarial',      payoffs: G(5, 5, 3, 1, 2, 1, 2, 4) }, // Row 1 weakly dominates
  { name: 'sub-unit-payoffs',  category: 'adversarial',      payoffs: G(0.003, 0.001, 0.001, 0.004, 0.004, 0.001, 0.001, 0.003) }, // all |payoff| < 0.01
];

/** True iff the solver says this game has a continuum (a player is indifferent). */
export function isDegenerate(g: GamePayoffs): boolean {
  return computeIndifference(g).any;
}

/**
 * Confirms each golden game still exhibits its declared category against the
 * live solver. Called once at eval start: if a solver change ever moves one of
 * these games into a different category, the run fails loudly here rather than
 * silently measuring the wrong thing. Returns the list of violations (empty = ok).
 */
export function assertCategories(games: GoldenGame[] = GOLDEN): string[] {
  const problems: string[] = [];
  for (const { name, category, payoffs } of games) {
    const ne = computeAllNE(payoffs);
    const pures = ne.filter((n) => n.type === 'pure').length;
    const hasMixed = ne.some((n) => n.type === 'mixed');
    const degenerate = isDegenerate(payoffs);
    let ok: boolean;
    switch (category) {
      case 'strict-dominance': ok = pures === 1 && !hasMixed && !degenerate; break;
      case 'coordination':     ok = pures === 2 && hasMixed && !degenerate; break;
      case 'no-pure':          ok = pures === 0 && hasMixed && !degenerate; break;
      case 'degenerate':       ok = degenerate; break;
      case 'near-tie':         ok = hasMixed && !degenerate; break;
      // Deliberately loose: these vary in shape by design (some have a mixed
      // NE, some don't). What they share is a misleading narrative, which no
      // structural assertion can express — only the prose checks catch it.
      case 'adversarial':      ok = !degenerate; break;
      default:                 ok = false;
    }
    if (!ok) {
      problems.push(
        `${name}: declared '${category}' but solver shows ${pures} pure, ` +
          `mixed=${hasMixed}, degenerate=${degenerate}`,
      );
    }
  }
  return problems;
}
