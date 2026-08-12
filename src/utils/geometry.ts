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
  /** Both surfaces level simultaneously at an interior point. */
  hasInteriorFlatSpot: boolean;
  /** B's surface is the exact negative of A's. */
  zeroSum: boolean;
  /** a+b is the same constant in every cell — a mirror up to a vertical offset. */
  constantSum: boolean;
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

  return {
    twistA,
    twistB,
    yStar,
    xStar,
    yStarInRange: inUnit(yStar),
    xStarInRange: inUnit(xStar),
    hasInteriorFlatSpot: inUnit(xStar) && inUnit(yStar),
    zeroSum,
    constantSum,
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

  lines.push(
    Math.abs(geo.twistA) < EPS
      ? `  A's surface is a FLAT PLANE (twist = 0): A's payoff does not depend on what B does, so there is no strategic interaction to describe.`
      : `  A's surface is WARPED (twist = ${geo.twistA}): the players' choices genuinely interact.`,
  );

  lines.push(
    geo.zeroSum
      ? `  The game is zero-sum, so B's surface is the exact upside-down copy of A's.`
      : geo.constantSum
        ? `  The game is constant-sum, so B's surface is A's flipped, offset by a constant.`
        : `  The game is NOT zero-sum: B's surface is its own shape, NOT a mirror of A's. Do not describe it as one.`,
  );

  lines.push(
    geo.yStarInRange
      ? `  A's surface goes LEVEL along A's axis when B plays y = ${rw(geo.yStar)} — that flat shelf is A's indifference.`
      : `  There is NO flat shelf for A on the board: the level point would be at y = ${r(geo.yStar)}, outside [0,1]. A's surface always tilts one way. Do not describe a shelf.`,
  );

  lines.push(
    geo.hasInteriorFlatSpot
      ? `  Both surfaces are level at the same interior point (x = ${rw(geo.xStar)}, y = ${rw(geo.yStar)}) — the joint flat spot, which is the mixed equilibrium.`
      : `  There is NO interior joint flat spot. The equilibrium sits on an edge or corner of the square, where a player is pinned to one action rather than balanced between two.`,
  );

  // WHO AUTHORS WHOSE INDIFFERENCE. This is a fact, not a flourish: x* is
  // derived from B's payoff numbers alone and y* from A's alone. A player's own
  // payoffs never appear in their own equilibrium mix. It reads as the paper's
  // point that self-interest does not locate the equilibrium — and unlike that
  // slogan, it is checkable, which is why it belongs in the briefing rather than
  // in an instruction to write a certain way.
  if (geo.hasInteriorFlatSpot) {
    lines.push(
      `  Note which numbers produce which coordinate: A's equilibrium mix x = ${rw(geo.xStar)} is computed`,
      `  entirely from B's payoffs, and B's mix y = ${rw(geo.yStar)} entirely from A's. Neither player's own`,
      `  payoffs appear in their own mix. Each player's mixture is doing a job for the OPPONENT — holding`,
      `  the opponent level — so a player following only their own payoffs would never arrive at it.`,
    );
  }

  return lines.join('\n');
}
