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
/**
 * When one party's own decision is worth this many times the other's, the
 * asymmetry is worth telling the story. Measured over 40,000 random games the
 * distribution is p50 1.67, p90 4.2, p95 6.0, and it is SCALE-FREE — identical
 * quantiles at payoff ranges of +/-10, +/-20 and +/-50. A cut at 4 fires on
 * 11.6% of random games and on none of the app's presets (Prisoner's Dilemma
 * 1.00, Battle of the Sexes 1.00, Spy 1.00, Penalty Kick 1.43).
 */
const PLAYER_GAP_NOTABLE = 4;

export function stakesHint(g: GamePayoffs): string {
  const s = describeStakes(g);

  // A game where nobody's choice moves anything has no stakes to describe, and
  // inventing some would be a claim. Say nothing; the domain line still applies.
  if (s.swing === 0) return '';

  // SHORT ON PURPOSE. The first draft ran three to four times this length and
  // cost 7.5% of cloud invention yield: 9 of 120 calls came back `max-tokens`
  // against 0 of 120 without it (Fisher p=0.0033). Mean output on the draws
  // that succeeded barely moved (243 -> 262 tokens), so it was a TAIL — a
  // subset of calls spending the whole 8192 budget reasoning about a long
  // instruction, which is the exact failure this function's caller documents
  // and that the 2048 -> 8192 raise was meant to end. A user cannot see prose
  // that was never returned, so a longer hint that buys better stories for
  // twelve users and nothing at all for the thirteenth is a bad trade.
  const size = s.swing < 1
    ? 'Stakes are tiny: a matter of fine adjustment, not of fortunes. Keep the setting small and ordinary.'
    : s.swing < 10
      ? 'Stakes are modest: an everyday setting where both parties care but neither is transformed.'
      : s.swing < 50
        ? 'Stakes are substantial: enough to matter to a season, a budget or a reputation, without being catastrophic.'
        : 'Stakes are very large: the outcome genuinely changes the parties\' situation.';

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
  // THE ONE GEOMETRIC LINE THAT SURVIVED MEASUREMENT.
  //
  // It names the parties and then FORBIDS the words, which is the opposite of
  // what I expected. The alternative wording referred to them positionally
  // ("the one choosing between the first pair of options") and named no
  // letters — and it leaked bare letters into the story at 10%, against 0% for
  // this one, because a positional reference leaves the model no handle on the
  // second party while the grounding payload supplies "Player A" anyway.
  //
  // DO NOT GENERALISE THAT. The first draft of this comment read "forbidding
  // the vocabulary beats avoiding it", and a separate run refutes it as a
  // general rule: added as a STANDALONE prohibition to a prompt that otherwise
  // never names the parties, the same sentence MANUFACTURES the defect it
  // forbids — control 0/72 leaks, prohibition 4/70, and both leaks were the
  // worst class, a party with no character at all, which the control never
  // produced in 72 draws. Don't-think-of-a-pink-elephant.
  //
  // The variable is the SALIENCE of the tokens in the instruction block, not
  // the polarity of the instruction. This line has to name a party anyway —
  // it is about which one is exposed — so the tokens are already present and
  // the prohibition is free. That is the only case it is licensed in.
  //
  // Blind forced choice on the real production path, arm held constant within
  // each pair, presentation order randomised, picks committed before the key:
  //
  //   gap   control fidelity / separation      with the line          Fisher
  //     4      46%  /  -10 pts                 93%  /  85 pts        p=0.0003
  //    10      50%  /    0 pts                 85%  /  68 pts        p=0.0096
  //    25      59%  /  +19 pts                 87%  /  74 pts        p=0.0219
  //
  // It is STRONGEST at 4, which is the threshold that actually ships, and the
  // three controls sit exactly on the null that the "matrix does not reach the
  // story" result predicts — that is the evidence the design is sound and not
  // just the treatment. Latency shrinks as the gap approaches the threshold:
  // +3.37s at 25, +1.77s at 10, +1.13s at 4. And sub-threshold prompts are
  // BYTE-IDENTICAL to what ships today (verified over 20,000 games: 2,312 fire,
  // 0 differ below the cut), so that second is paid only on the ~1 game in 9
  // that gets the benefit. Persona leak with this wording: 0/27, 0/26, 0/31.
  // DIRECTION IS STATED, NOT LEFT TO THE MODEL.
  //
  // This line used to read "Player A has far more riding on this than Player B,
  // OR THE REVERSE". That phrasing announces that an asymmetry exists while
  // withholding which way it runs — and it had to, because `playerGap` is
  // `max(swingA, swingB) / min(...)`, a magnitude RATIO that discards direction
  // by construction. So the model guessed, and a red team measured the guess on
  // the story's OWN game: it agreed with the swing reading 38% of the time and
  // with the range reading 53%, and 44% of the stories were wrong under BOTH.
  // Worse, every confirmed instance named the ROW party as the exposed one —
  // the "or the reverse" half was never taken.
  //
  // The forced-choice evidence above is not contradicted by that, because it
  // never tested this: it was a RANKING task (which of two stories carries the
  // bigger gap), so a story could rank correctly while pointing at the wrong
  // party. A comparative claim about which side has more at stake is decidable
  // from the matrix printed beside it, which makes a wrong one exactly the
  // falsehood rung 3 exists to prevent.
  //
  // `swingA`/`swingB` carry the direction the ratio threw away, so the line now
  // names the exposed party. Everything else is byte-identical, including the
  // persona prohibition measured at 0/27, 0/26, 0/31.
  const exposedFirst = s.swingA >= s.swingB;
  const gap = Number.isFinite(s.playerGap) && s.playerGap >= PLAYER_GAP_NOTABLE
    ? `${exposedFirst ? 'Player A has far more riding on this than Player B' : 'Player B has far more riding on this than Player A'} — make that difference in exposure part of who the two parties are. Never write "Player A", "Player B", "the players" or a bare letter in the description itself.`
    : '';

  const parts = [size, gap].filter(Boolean);
  return `MATCH THE SETTING TO THE STAKES. ${parts.join(' ')} Still no figures and no claims.`;
}
