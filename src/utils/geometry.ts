/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Decidable geometric facts about a 2x2 game.
 *
 * The app plots two expected-payoff surfaces over the strategy square, and the
 * paper reads the equilibrium off their shape: indifference is a level shelf,
 * the equilibrium is the joint flat spot, strategic interaction is visible warp.
 * Until now the explainer never saw any of that — it received the payoff matrix
 * and the equilibrium list, so it could only talk algebra about a picture the
 * reader is looking at.
 *
 * Everything here is a NUMBER the solver can check, which is what separates
 * these claims from the interpretive ones. "Is this game's surface warped?" has
 * an answer; "is a mixed strategy a pure strategy in disguise?" does not, and
 * that one stays with a human. This file exists so the validator can gain real
 * checks without repeating the deleted `prose-false-pure` regex — see
 * nashValidator.ts for why lexical semantic checks were removed.
 *
 * CONVENTION: x is A's probability on Row 1, y is B's probability on Col 1.
 */

import type { GamePayoffs } from '../types';

export interface Geometry {
  /** A's twist. Zero means A's surface is a flat plane: no strategic interaction. */
  twistA: number;
  /** B's twist, computed from B's OWN payoffs. */
  twistB: number;
  /**
   * The opponent mix that makes A indifferent — where A's surface goes level
   * along A's own axis. NaN when twistA is 0 (no such point exists).
   */
  yStar: number;
  /** The mix that makes B indifferent. NaN when twistB is 0. */
  xStar: number;
  /** Is yStar an actual point on the board, rather than an extrapolation? */
  yStarInRange: boolean;
  xStarInRange: boolean;
  /**
   * Is A's surface level along A's OWN axis anywhere in the interior?
   *
   * NOT the same question as `yStarInRange`, and conflating the two rejected
   * true model claims. dE_A/dx = y*(a11-a21) + (1-y)*(a12-a22) is linear in y
   * with `twistA` as its slope, so a zero twist makes it the CONSTANT
   * (a11 - a21): level EVERYWHERE if that is zero, level NOWHERE if it is not.
   * `yStarInRange` collapses those two into "no shelf" because yStar is NaN in
   * both. Measured against a sign-change scan of the real E_A — a magnitude
   * grid cannot see a transversal crossing and disagrees with the truth 45% of
   * the time — `yStarInRange`-as-shelf is wrong on 0.278% of int[-9,9] games
   * and 2.022% of int[-3,3]; this predicate is wrong on 0 of 400,000, and is
   * identical to `yStarInRange` wherever the twist is non-zero.
   */
  hasFlatShelfForA: boolean;
  /** The same question for B, whose own axis is y and whose twist is twistB. */
  hasFlatShelfForB: boolean;
  /** Both surfaces level simultaneously at an interior point. */
  hasInteriorFlatSpot: boolean;
  /** B's surface is the exact negative of A's. */
  zeroSum: boolean;
  /** a+b is the same constant in every cell — a mirror up to a vertical offset. */
  constantSum: boolean;
  /**
   * Is the minimax / "value of the game" framing available at all?
   *
   * Zero-sum is the textbook precondition; constant-sum qualifies because it is
   * zero-sum after an affine shift, which moves the value without changing the
   * strategies. Anything else has no single value to be the minimax OF.
   */
  minimaxApplies: boolean;
  /** A has a row that beats their other row against every column B can play. */
  dominantRowA: boolean;
  /** B has a column that beats their other column against every row A can play. */
  dominantColB: boolean;
}

const EPS = 1e-9;

/**
 * xStar MUST be computed from B's payoffs, not A's.
 *
 * A widely-quoted shortcut writes xStar = (a22 - a21) / twistA. That is
 * zero-sum-only: it happens to coincide when B = -A, and is wrong otherwise. On
 * Battle of the Sexes it returns 0.333 where the true value is 0.667 — silently
 * wrong on exactly the non-zero-sum games these checks exist to catch.
 *
 * The derivation: B is indifferent between columns when
 *   b11*x + b21*(1-x) = b12*x + b22*(1-x)
 * which rearranges to x = (b22 - b21) / (b11 - b12 - b21 + b22).
 */
export function describeGeometry(g: GamePayoffs): Geometry {
  const twistA = g.a11 - g.a12 - g.a21 + g.a22;
  const twistB = g.b11 - g.b12 - g.b21 + g.b22;

  const yStar = Math.abs(twistA) < EPS ? NaN : (g.a22 - g.a12) / twistA;
  const xStar = Math.abs(twistB) < EPS ? NaN : (g.b22 - g.b21) / twistB;

  const inUnit = (v: number) => Number.isFinite(v) && v > EPS && v < 1 - EPS;

  const sums = [g.a11 + g.b11, g.a12 + g.b12, g.a21 + g.b21, g.a22 + g.b22];
  const zeroSum = sums.every((s) => Math.abs(s) < EPS);
  const constantSum = sums.every((s) => Math.abs(s - sums[0]) < EPS);

  // STRICT dominance only. With weak dominance a tie in one column would count,
  // and "Row 1 is always at least as good" is a materially weaker statement than
  // the one the prose makes when it says a strategy dominates. Keeping it strict
  // means the check fires only on claims that are unambiguously wrong.
  const dominantRowA =
    (g.a11 > g.a21 + EPS && g.a12 > g.a22 + EPS) ||
    (g.a21 > g.a11 + EPS && g.a22 > g.a12 + EPS);
  // B compares COLUMNS, so the pairs are (b11 vs b12) and (b21 vs b22) — B's own
  // payoffs, held against each of A's rows.
  const dominantColB =
    (g.b11 > g.b12 + EPS && g.b21 > g.b22 + EPS) ||
    (g.b12 > g.b11 + EPS && g.b22 > g.b21 + EPS);

  // A's own-axis slope is CONSTANT when the twist vanishes (see hasFlatShelfForA):
  // level everywhere iff a11 = a21, level nowhere otherwise. Same for B with
  // b11 = b12. `yStarInRange` / `xStarInRange` are left exactly as they were —
  // they answer "is the indifference ROOT an interior point", which is the right
  // question for the coordinate sentences and for the strict boundary rule.
  const hasFlatShelfForA = Math.abs(twistA) >= EPS ? inUnit(yStar) : Math.abs(g.a11 - g.a21) < EPS;
  const hasFlatShelfForB = Math.abs(twistB) >= EPS ? inUnit(xStar) : Math.abs(g.b11 - g.b12) < EPS;

  return {
    twistA,
    twistB,
    yStar,
    xStar,
    yStarInRange: inUnit(yStar),
    xStarInRange: inUnit(xStar),
    hasFlatShelfForA,
    hasFlatShelfForB,
    hasInteriorFlatSpot: hasFlatShelfForA && hasFlatShelfForB,
    zeroSum,
    constantSum,
    minimaxApplies: zeroSum || constantSum,
    dominantRowA,
    dominantColB,
  };
}

/**
 * The geometric facts, phrased for the explainer.
 *
 * Deliberately states what is NOT true as well as what is: a model told only
 * "the flat spot is at (0.6, 0.4)" will happily invent a flat spot for a game
 * that has none, which is precisely the failure the new validator checks catch.
 */
export function geometryBriefing(g: GamePayoffs): string {
  const geo = describeGeometry(g);
  // Round for the prompt. Full float precision invites the model to quote
  // coordinates to 16 digits, which reads badly and is not more true.
  const r = (v: number) => (Number.isFinite(v) ? String(Math.round(v * 1e4) / 1e4) : 'undefined');

  /**
   * Render a value as digits AND, for the common fractions, in words.
   *
   * Permission was not enough: the system prompt already allows the prose to say
   * "a third", but the model kept writing 0.3333 because THIS BRIEFING wrote
   * 0.3333. It copies the format of the material it is given, exactly as it
   * copied the vocabulary. So the words have to appear here, not in a rule.
   */
  const WORDS: [number, string][] = [
    [1 / 2, 'a half'], [1 / 3, 'a third'], [2 / 3, 'two-thirds'],
    [1 / 4, 'a quarter'], [3 / 4, 'three-quarters'], [1 / 5, 'a fifth'],
    [2 / 5, 'two-fifths'], [3 / 5, 'three-fifths'], [4 / 5, 'four-fifths'],
  ];
  const rw = (v: number) => {
    if (!Number.isFinite(v)) return 'undefined';
    const hit = WORDS.find(([n]) => Math.abs(v - n) < 5e-4);
    return hit ? `${r(v)} (${hit[1]})` : r(v);
  };
  const lines: string[] = ['Geometry of the two expected-payoff surfaces (computed, authoritative):'];

  /**
   * A's surface, written out, because four of the sentences below are about its
   * coefficients and three of them used to read the wrong one:
   *
   *   E_A(x, y) = a22 + x*(a12 - a22) + y*(a21 - a22) + x*y*twistA
   *
   * so `aOwnTilt` is how A's payoff moves with A's OWN mix (at y = 0),
   * `aOppTilt` is how it moves with B's mix (at x = 0), and `twistA` is only
   * the INTERACTION between them. A zero twist says the two tilts do not
   * modulate each other; it says nothing about either tilt being zero.
   */
  const aOwnTilt = g.a12 - g.a22;
  const aOppTilt = g.a21 - g.a22;
  const flatPlaneA = Math.abs(geo.twistA) < EPS;
  /** A is indifferent between the rows at EVERY y — the whole board is a shelf. */
  const aIndifferentEverywhere = flatPlaneA && Math.abs(aOwnTilt) < EPS;

  lines.push(
    !flatPlaneA
      ? `  A's surface is WARPED (twist = ${geo.twistA}): the players' choices genuinely interact.`
      // TWIST ZERO IS NOT INDEPENDENCE. This branch said "A's payoff does not
      // depend on what B does", which is false whenever a21 != a22: on
      // a=[[-5,-1],[-5,-1]], b=[[-6,-6],[0,6]] the payoff is E_A = -1 - 4y, a
      // function of B's mix ALONE. Measured on 100,000 games per corpus: 1.87%
      // of "New random game" draws, 3.27% of hand-typed int[-9,9] matrices,
      // 7.59% on a [-3,3] alphabet. The true reading of twist = 0 is that the
      // two tilts are independent of each other, not that one of them is zero.
      : Math.abs(aOppTilt) < EPS
        ? `  A's surface is a FLAT PLANE (twist = 0): A's payoff does not depend on what B does, so there is no strategic interaction to describe.`
        : `  A's surface is a FLAT PLANE (twist = 0): there is no strategic INTERACTION to describe — how much A's own choice is worth is the same whatever B does. A's payoff does still move with B's choice (by ${r(aOppTilt)} as B shifts from Col 2 to Col 1), by the same amount whichever row A picks.`,
  );

  lines.push(
    geo.zeroSum
      ? `  The game is zero-sum, so B's surface is the exact upside-down copy of A's.`
      : geo.constantSum
        ? `  The game is constant-sum, so B's surface is A's flipped, offset by a constant.`
        : `  The game is NOT zero-sum: B's surface is its own shape, NOT a mirror of A's. Do not describe it as one.`,
  );

  // THE SHELF SENTENCE, in four cases rather than two.
  //
  // The old else-branch was one string covering three different situations and
  // was false in two of them. "The level point would be at y = 0, outside
  // [0,1]" is a self-contradiction — 0 is IN [0,1]; the root is on the edge of
  // the board, not off it. And when twistA is 0 there is no level point to
  // report at all, so the sentence printed "y = undefined, outside [0,1]" and
  // then asserted "A's surface always tilts one way" on boards where A is
  // indifferent between the rows everywhere, i.e. where the whole surface is a
  // shelf. Measured on 100,000 games per corpus: the boundary-or-undefined case
  // is 2.03% of "New random game" draws, 13.51% of hand-typed int[-9,9]
  // matrices and 34.20% on a [-3,3] alphabet; the indifferent-everywhere case
  // cannot arise from the random button at all (`generateRandomGame` rejects
  // within-player ties) but is 2.00% of [-3,3] matrices.
  //
  // The PREDICATE is unchanged and stays strict: a root on the boundary is not
  // an interior shelf, which is what `yStarInRange` is for and what
  // `nashValidator` checks against. Only the sentence changes.
  const onBoundary = Number.isFinite(geo.yStar)
    && ((Math.abs(geo.yStar) <= EPS) || (Math.abs(geo.yStar - 1) <= EPS));
  lines.push(
    geo.yStarInRange
      ? `  A's surface goes LEVEL along A's axis when B plays y = ${rw(geo.yStar)} — that flat shelf is A's indifference.`
      : aIndifferentEverywhere
        ? `  A is indifferent between the two rows EVERYWHERE on the board: A's surface is level along A's own axis at every y, so the whole surface is a shelf rather than one line. A's payoff is decided entirely by B. Do not describe A as preferring a row.`
        : flatPlaneA
          ? `  There is NO flat shelf for A: A's surface tilts the same way at every y — A is always better off from ${aOwnTilt > 0 ? 'Row 1' : 'Row 2'}, by ${r(Math.abs(aOwnTilt))}, whatever B does. Do not describe a shelf.`
          : onBoundary
            ? `  There is NO flat shelf INSIDE the board: A's surface goes level only at y = ${r(geo.yStar)}, which is the edge of the square (B playing ${geo.yStar > 0.5 ? 'Col 1' : 'Col 2'} outright), not a mix. At every genuine mixture A's surface tilts one way. Do not describe an interior shelf.`
            : `  There is NO flat shelf for A on the board: the level point would be at y = ${r(geo.yStar)}, outside [0,1]. A's surface always tilts one way. Do not describe a shelf.`,
  );

  // THE FLAT-SPOT SENTENCE.
  //
  // This else-branch used to assert "The equilibrium sits on an edge or corner"
  // on games whose equilibrium set contains strictly interior points — on
  // a=[[-2,2],[4,-5]], b=[[3,3],[4,4]] the set contains the whole segment
  // [0,1] x {7/13}, and (0.5, 7/13) has zero regret for both players. I first
  // fixed that by asking `equilibriumSet` for an interior point and writing a
  // third sentence for the case.
  //
  // THAT FIX IS GONE, because it was a symptom and the cause was one level down.
  // An equilibrium with BOTH coordinates strictly interior means each player is
  // mixing, which means each player is indifferent, which IS a joint flat spot.
  // The case could only appear because `hasInteriorFlatSpot` was blind to the
  // degenerate shelf (see `hasFlatShelfForA`). With the predicate corrected the
  // shape is not rare — it is impossible: 0 of 400,000 games across four
  // alphabets, and `testGeometryBriefingTruth` asserts the implication against
  // the REGRET definition rather than against the solver that produces the
  // sentence. A third branch here would now be a guard whose deletion changes
  // no result, which is the class this codebase keeps finding.
  // THE NaN MIRROR. `hasInteriorFlatSpot` is now true in the degenerate case
  // where a player is level along their own axis at EVERY opponent mix — and in
  // exactly that case their root is NaN, so the coordinate form of this sentence
  // would print "x = undefined", the twin of the "y = undefined" defect fixed
  // three sentences up. A player who is level everywhere has no single
  // coordinate to name, so name the freedom instead.
  const bothRootsNamed = geo.xStarInRange && geo.yStarInRange;
  lines.push(
    geo.hasInteriorFlatSpot && bothRootsNamed
      ? `  Both surfaces are level at the same interior point (x = ${rw(geo.xStar)}, y = ${rw(geo.yStar)}) — the joint flat spot, which is the mixed equilibrium.`
      : geo.hasInteriorFlatSpot
        ? `  Both surfaces are level at the same interior profiles — the joint flat spot, which is the mixed equilibrium. A's surface is level ${geo.yStarInRange ? `when B plays y = ${rw(geo.yStar)}` : `at EVERY y, because A is indifferent between the rows whatever B does`}, and B's surface is level ${geo.xStarInRange ? `when A plays x = ${rw(geo.xStar)}` : `at EVERY x, because B is indifferent between the columns whatever A does`}. There is a whole ${geo.xStarInRange || geo.yStarInRange ? 'line' : 'region'} of them, not one point, so do not name a single mixture as THE equilibrium.`
        : `  There is NO interior joint flat spot. The equilibrium sits on an edge or corner of the square, where a player is pinned to one action rather than balanced between two.`,
  );

  // MINIMAX AND DOMINANCE. Stated here rather than left to the model's judgement
  // for the reason this whole file exists: an explainer that was merely PERMITTED
  // to use a framing ignored it entirely (0% uptake in the framing pilot), while
  // one handed a framing under instruction asserted von Neumann's minimax about a
  // game that was not zero-sum. Both facts are one comparison away from the
  // matrix, so both are supplied and both are checked.
  lines.push(
    geo.minimaxApplies
      ? `  This game is ${geo.zeroSum ? 'zero-sum' : 'constant-sum'}, so it HAS a value in von Neumann's sense and the minimax framing applies.`
      : `  This game is NOT zero-sum or constant-sum, so there is NO single "value of the game" and the minimax framing does NOT apply. Do not call the equilibrium a minimax value.`,
  );

  // WEAK DOMINANCE. `dominantRowA` / `dominantColB` are deliberately STRICT and
  // stay that way — the validator checks a claim of dominance against them, and
  // loosening them would let "Row 1 dominates" pass on a game where the rows
  // merely tie. The defect was in the NEGATIVE sentence, which read the absence
  // of STRICT dominance as "which option is better depends on what the opponent
  // does". On a=[[-7,-5],[-7,7]], b=[[-3,-1],[-6,-8]] Row 2 is never worse than
  // Row 1 and is strictly better against Col 2, so nothing about A's choice
  // depends on B. Measured: 0% of "New random game" draws (that generator
  // rejects the within-player ties weak dominance requires), 10.33% of
  // hand-typed int[-9,9] matrices, 26.66% on a [-3,3] alphabet.
  const weakRow = (g.a11 >= g.a21 && g.a12 >= g.a22) ? 1 : (g.a21 >= g.a11 && g.a22 >= g.a12) ? 2 : 0;
  const weakCol = (g.b11 >= g.b12 && g.b21 >= g.b22) ? 1 : (g.b12 >= g.b11 && g.b22 >= g.b21) ? 2 : 0;
  const bIndifferentEverywhere = g.b11 === g.b12 && g.b21 === g.b22;
  const weakNotes: string[] = [];
  if (!geo.dominantRowA && weakRow) {
    weakNotes.push(aIndifferentEverywhere
      ? `A is indifferent between the rows against every column, so neither of A's options is ever the better one`
      : `A's Row ${weakRow} is never worse than Row ${3 - weakRow} and is strictly better against at least one column — it WEAKLY dominates`);
  }
  if (!geo.dominantColB && weakCol) {
    weakNotes.push(bIndifferentEverywhere
      ? `B is indifferent between the columns against every row, so neither of B's options is ever the better one`
      : `B's Col ${weakCol} is never worse than Col ${3 - weakCol} and is strictly better against at least one row — it WEAKLY dominates`);
  }
  const dom = [geo.dominantRowA ? 'A' : null, geo.dominantColB ? 'B' : null].filter(Boolean);
  lines.push(
    dom.length
      ? `  Dominant strategy present for ${dom.join(' and ')} — one option beats the other whatever the opponent does.`
      : weakNotes.length
        ? `  Neither player has a STRICTLY dominant strategy, but ${weakNotes.join('; and ')}. Do not call any option strictly dominant, and do not say that for every player the better option depends on the opponent.`
        : `  NEITHER player has a dominant strategy: for each player, which option is better depends on what the opponent does. Do not claim one dominates.`,
  );

  // WHO AUTHORS WHOSE INDIFFERENCE. This is a fact, not a flourish: x* is
  // derived from B's payoff numbers alone and y* from A's alone. A player's own
  // payoffs never appear in their own equilibrium mix. It reads as the paper's
  // point that self-interest does not locate the equilibrium — and unlike that
  // slogan, it is checkable, which is why it belongs in the briefing rather than
  // in an instruction to write a certain way.
  // Guarded on the ROOTS, not on the flat spot: the widened flat-spot predicate
  // is true in the degenerate case where a root is NaN, and this block prints
  // both coordinates. The claim it makes is still true there — a player's own
  // payoffs never appear in their own mix — but there is no single mix to name,
  // so it is dropped rather than rendered as "x = undefined".
  if (geo.hasInteriorFlatSpot && bothRootsNamed) {
    lines.push(
      `  Note which numbers produce which coordinate: A's equilibrium mix x = ${rw(geo.xStar)} is computed`,
      `  entirely from B's payoffs, and B's mix y = ${rw(geo.yStar)} entirely from A's. Neither player's own`,
      `  payoffs appear in their own mix. Each player's mixture is doing a job for the OPPONENT — holding`,
      `  the opponent level — so a player following only their own payoffs would never arrive at it.`,
    );
  }

  return lines.join('\n');
}
