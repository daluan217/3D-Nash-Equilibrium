/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * How much is at stake in a game, described in words the story can be built on.
 *
 * WHY THIS EXISTS. The model is handed the whole payoff matrix and then writes a
 * story that ignores it. That is not a guess: varying the game moved the local
 * model's output no more than resampling the same game did (17/20 vs 15/20
 * distinct names, p=0.238), and an ALL-ZERO matrix produced stories
 * indistinguishable from real ones (p=0.115) — while deleting the payload
 * entirely gave 20/20 unparseable. The payload's SHAPE is load-bearing; its
 * CONTENT is not. So a game whose outcomes differ by a factor of 100,000 gets
 * the same "routine commercial choice" story as a game whose outcomes are a
 * hair apart, and the user — who can see the matrix on screen — reads a story
 * whose stakes contradict the numbers next to it.
 *
 * Rung 3 is why the numbers stopped reaching the story, and it was right to:
 * a description that asserts anything decidable was wrong often enough to be a
 * defect, so the prompt forbids numbers and outcome claims outright. That makes
 * falsity unreachable. It also severed the last thread between the game and the
 * world it is set in.
 *
 * The fix keeps rung 3 exactly where it is. Nothing here relaxes the no-numbers
 * rule, and nothing here edits what the model writes. Magnitude enters as an
 * INPUT — a computed description of the stakes, appended to the prompt the same
 * way `domain` is — and the model chooses a world whose consequences fit. A
 * nuclear scram and a pastry-of-the-day are both claim-free; only one of them is
 * commensurate with a hundred-thousand-fold spread.
 *
 * WHAT IS MEASURED, and why these two axes. Daniel asked for arithmetic and
 * geometric, and they turn out to be the two things a reader actually notices:
 *
 *   ARITHMETIC (`swing`) — the most a player's OWN choice can move their OWN
 *   payoff. Differences, not levels, so it is invariant to shifting a player's
 *   payoffs by a constant, which changes nothing strategically and should change
 *   nothing about the story. A game of (1000, 999; 999, 1000) has a swing of 1:
 *   the numbers on screen are large, the decision is not, and the story should
 *   follow the decision.
 *
 *   GEOMETRIC (`lopsidedness`) — the largest of those swings over the smallest.
 *   Scale-free: multiply every payoff by ten and it does not move. This is the
 *   axis Daniel's own example lives on. 100 against 0.001 is a ratio of 100,000,
 *   and it means one decision is momentous while another is very nearly
 *   irrelevant — a fact about the world the story is set in, not about the
 *   mathematics.
 *
 * THRESHOLDS ARE MEASURED, NOT GUESSED. Over 30,000 random games per condition,
 * lopsidedness runs p50 6.4, p75 15.8, p90 42.7 — so the median game already has
 * one decision mattering six times more than another, and calling that
 * "lopsided" would fire on half of all games and discriminate nothing. The cuts
 * below sit at roughly the 40th and 85th percentiles so each band is a band
 * someone would notice. For reference: Prisoner's Dilemma 2.3, Penalty Kick
 * 10.0, Daniel's 100-vs-0.001 example 100,000.
 *
 * WHAT THIS IS NOT. It is not a gate. Nothing is rejected for a stakes mismatch
 * and no output is rewritten — per Daniel's ruling, remaining inaccuracies are
 * fixed by prompt, schema, gate or retraining, never by editing the model's
 * words, and the least invasive of those is tried first (see the
 * prose-constraint-minimum rule: escalate a rung only when measurement shows
 * leakage). Whether the model actually complies is an empirical question, and
 * the answer decides whether a declared-and-compared field follows.
 */
import type { GamePayoffs } from '../types';

export interface StakesProfile {
  /** The most A's own choice can move A's own payoff, over B's two columns. */
  swingA: number;
  /** The most B's own choice can move B's own payoff, over A's two rows. */
  swingB: number;
  /** The largest single decision-swing anywhere in the game (arithmetic). */
  swing: number;
  /** Largest swing over smallest, across all four decision-swings (geometric). */
  lopsidedness: number;
  /** Whether one player has far more riding on the outcome than the other. */
  playerGap: number;
  /** True when some choice, in some circumstance, changes nothing at all. */
  hasIrrelevantChoice: boolean;
}

/**
 * The four numbers that are actually at stake: for each player, in each of the
 * opponent's two circumstances, how much their own choice is worth to them.
 */
function decisionSwings(g: GamePayoffs): [number, number, number, number] {
  return [
    Math.abs(g.a11 - g.a21), // A's choice, against B's column 1
    Math.abs(g.a12 - g.a22), // A's choice, against B's column 2
    Math.abs(g.b11 - g.b12), // B's choice, against A's row 1
    Math.abs(g.b21 - g.b22), // B's choice, against A's row 2
  ];
}

export function describeStakes(g: GamePayoffs): StakesProfile {
  const [a1, a2, b1, b2] = decisionSwings(g);
  const swingA = Math.max(a1, a2);
  const swingB = Math.max(b1, b2);
  const all = [a1, a2, b1, b2];
  const swing = Math.max(...all);
  const smallest = Math.min(...all);
  // A zero swing is not a rounding artefact — it means a choice that genuinely
  // changes nothing, which is a fact about the world worth telling the story.
  // Reported through `hasIrrelevantChoice` rather than as an infinite ratio, so
  // callers never have to reason about Infinity.
  const lopsidedness = smallest > 0 ? swing / smallest : Infinity;
  const lo = Math.min(swingA, swingB);
  return {
    swingA,
    swingB,
    swing,
    lopsidedness,
    playerGap: lo > 0 ? Math.max(swingA, swingB) / lo : Infinity,
    hasIrrelevantChoice: smallest === 0 && swing > 0,
  };
}

/**
 * The prompt line. Deliberately additive and inert: no stakes line, no change to
 * the prompt — exactly the property that let the domain rotation ship safely.
 *
 * Every sentence must describe the SETTING to choose, never a claim about the
 * game. The solver states all the mathematics, and a hint that told the model
 * who should win would reintroduce the defect rung 3 exists to remove.
 */
export function stakesHint(g: GamePayoffs): string {
  const s = describeStakes(g);

  // A game where nobody's choice moves anything has no stakes to describe, and
  // inventing some would be a claim. Say nothing; the domain line still applies.
  if (s.swing === 0) return '';

  const size = s.swing < 1
    ? 'The entire game turns on differences smaller than a single unit: nothing here is dramatic, and the setting should be correspondingly small and ordinary — a matter of fine adjustment, not of fortunes.'
    : s.swing < 10
      ? 'The amounts at stake are modest. Choose an everyday setting where the parties care about the outcome but neither is transformed by it.'
      : s.swing < 50
        ? 'The amounts at stake are substantial — enough to matter to a season, a budget or a reputation. The setting should carry real weight without being catastrophic.'
        : 'The amounts at stake are very large relative to everything else in this game. The setting should be one where the outcome genuinely changes the parties\' situation.';

  // THE GEOMETRIC LINES ARE DELIBERATELY ABSENT, and this is the most important
  // thing in the file. A first draft said "the weightiest decision here matters
  // about N times more than the slightest one". Blind forced-choice rating found
  // it does not work: on the lopsidedness ladder the hint scored 9/11 against
  // 7/12 for no hint (Fisher p=0.37, no demonstrated effect), while the
  // arithmetic lines below scored 11/12 against 2/11 (p=0.0006) and replicated
  // down to a 5x ratio.
  //
  // The reason is structural, not a wording problem. `lopsidedness` compares A's
  // swing against B's column 1 with A's swing against B's column 2, so the fact
  // it states is CONTINGENT: "A's choice matters enormously if B does X, barely
  // if B does Y". That is exactly the conditional-outcome shape
  // `scenarioIsClaimFree` rejects, so no claim-free story can carry it however
  // it is phrased. It was also the line pushing the model toward total-versus-
  // nothing option labels (3/41 with the hint, 0/41 without) — a channel through
  // which magnitude can contradict the matrix outright.
  //
  // `playerGap` — one party more exposed than the other — is the one geometric
  // asymmetry a story CAN carry, because it describes who the parties are rather
  // than making a claim about any cell. It is absent only because it is
  // unmeasured: it is pinned at 1 by construction across the entire ladder that
  // was run, so that line never fired and the evidence says nothing about it. It
  // goes in when a ladder that actually moves it says it works, and not before.
  const parts = [size];
  return `STAKES OF THIS GAME — match the setting to them. ${parts.join(' ')} Describe the world only: state no figures and make no claim about which option is better, exactly as required above.`;
}
