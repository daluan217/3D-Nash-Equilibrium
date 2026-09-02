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

/**
 * SOFT STAKES (2026-09-02, Daniel's call). The absolute-swing cut above makes
 * register track PAYOFF SCALE, not the decision — the same strategic game,
 * typed in different units, gets a maximally different-register story
 * (measured: the current cut's band changes under pure rescaling on 72.9% of
 * (game, scale) pairs, `_gen/blue3_stakes_scale_invariance.ts`), and RED-CLOUD-3
 * independently confirmed the absolute cut WORKS mechanically — 20/20 blind
 * register separation at a 1000x rescale (round3/notes/RED-CLOUD-3). Both are
 * true at once: the mechanism is reliable, and what it is reliable ABOUT is an
 * arbitrary unit choice. Daniel's ruling: payoff scale should INFLUENCE the
 * story, not DETERMINE it. This is not a rewording — the wording is softened
 * too — but the ONLY instrument here is the INPUT to the model, same as the
 * `no-rewriting-rung3-ceiling` rule requires: gate, prompt, retrain, never the
 * model's own words.
 *
 * TWO INDEPENDENT SOFTENING MECHANISMS, deliberately decoupled so each can be
 * reasoned about (and reverted) on its own:
 *
 *   1. STRENGTH — the graded size line fires only `SIZE_STRONG_P` of the time;
 *      the rest of the time the hint says nothing about magnitude and leaves
 *      the register to the story's own logic. This is what turns a 1000x
 *      rescale from 20/20 separation into PARTIAL separation, uniformly
 *      regardless of how extreme the rescale is — a game deep in the "tiny"
 *      band and a game deep in the "very large" band are equally likely to
 *      draw the silent branch, so blind-rank on extreme pairs is bounded well
 *      below 100% by construction, not by chance.
 *   2. BOUNDARY BLEND — near a band cut (within `BOUNDARY_WINDOW` log10 units)
 *      the STRONG branch sometimes reaches for the NEIGHBOURING band's wording
 *      instead of the exact one, ramping from 0 at the window's edge to 50/50
 *      exactly on the cut. This is the literal "stochastic overlap between
 *      adjacent bands" — a game whose swing sits at 9.5 (just under the
 *      modest/substantial cut at 10) can draw either register, honestly,
 *      because 9.5 and 10.5 are not meaningfully different decisions.
 *
 * WINDOW IS DELIBERATELY NARROW (0.15 log10 units, about a 1.4x margin either
 * side of a cut) so the #55 arithmetic-axis fidelity ladder — the four
 * magnitudes (`_gen/stakes_ab.ts`'s mag:0.2/3/15/45, log-distances 0.398 /
 * 0.222 / 0.222 / 0.255 from their nearest cuts) — sits OUTSIDE the window on
 * every rung and so keeps drawing its exact band whenever the STRONG branch
 * fires. Mechanism 2 changes nothing about #55's own measurement; only
 * mechanism 1 (whether the line fires at all) can move that number, and it
 * moves it by attenuation, not by reversing the direction.
 *
 * `pick` is injectable, matching `pickScenarioDomain`/`pickFromBank`: a caller
 * (or NASH_REPRODUCIBLE mode, once wired) supplies a seeded generator and the
 * same (game, seed) sequence always produces the same hint — see
 * `scenariostakes.test.ts`'s determinism section, mutation-tested against a
 * `Math.random`-shaped stub that is NOT stable across calls.
 */
const SIZE_STRONG_P = 0.6;
const SIZE_BOUNDARIES_LOG = [0, 1, Math.log10(50)]; // swing cuts at 1, 10, 50
const BOUNDARY_WINDOW = 0.15;

const SIZE_WORDING = [
  'Stakes lean tiny here, more a matter of fine adjustment than of fortunes.',
  'Stakes lean modest here, an everyday matter where both parties care but neither is transformed.',
  'Stakes lean substantial here, enough to matter to a season, a budget or a reputation.',
  'Stakes lean very large here — this could genuinely change the parties\' situation.',
] as const;
// Says nothing about magnitude at all. This is the branch that keeps register
// from being DETERMINED by scale: the model is reminded stakes exist, not told
// how big they are.
const SIZE_NEUTRAL = 'How big a deal this is can follow the setting\'s own logic.';

/**
 * The exact band from the absolute-swing cuts, unchanged from the deterministic
 * design — this is what `SIZE_WORDING` is indexed by and what `scenarioBank`'s
 * `stakesBand` still matches, so nothing downstream needs to know softening
 * exists.
 */
function exactSizeBand(swing: number): number {
  return swing < 1 ? 0 : swing < 10 ? 1 : swing < 50 ? 2 : 3;
}

/**
 * Reach into the neighbouring band near a cut, honestly — see the block
 * comment above. Consumes `pick()` only when the swing is close enough to a
 * cut to matter; deep-interior games (most of them) never pay for it and
 * never move.
 */
function blendedSizeBand(exact: number, swing: number, pick: () => number): number {
  if (swing <= 0) return exact;
  const x = Math.log10(swing);
  let nearestDist = Infinity, nearestIdx = -1;
  for (let i = 0; i < SIZE_BOUNDARIES_LOG.length; i++) {
    const d = Math.abs(x - SIZE_BOUNDARIES_LOG[i]);
    if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
  }
  if (nearestDist >= BOUNDARY_WINDOW) return exact;
  const belowBand = nearestIdx;      // band on the low side of this cut
  const aboveBand = nearestIdx + 1;  // band on the high side
  const isBelow = x < SIZE_BOUNDARIES_LOG[nearestIdx];
  const flipProb = 0.5 * (1 - nearestDist / BOUNDARY_WINDOW);
  if (pick() < flipProb) return isBelow ? aboveBand : belowBand;
  return exact;
}

export function stakesHint(g: GamePayoffs, pick: () => number = Math.random): string {
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
  // twelve users and nothing at all for the thirteenth is a bad trade. Every
  // branch below (SIZE_WORDING and SIZE_NEUTRAL alike) stays under that same
  // budget — softening the determinism must not reopen the length cost.
  const size = pick() < SIZE_STRONG_P
    ? SIZE_WORDING[blendedSizeBand(exactSizeBand(s.swing), s.swing, pick)]
    : SIZE_NEUTRAL;

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
  // INFINITE ASYMMETRY IS THE STRONGEST CASE, AND IT USED TO BE THE ONLY ONE
  // EXCLUDED. `playerGap` is Infinity when the smaller swing is exactly 0, so
  // the guard `Number.isFinite(playerGap)` silently dropped the games where one
  // party's choice provably does nothing at all — 0.55% of random games over a
  // 200,000-game sweep — while a mere 4x gap got the line. That is the opposite
  // of the intended behaviour.
  //
  // The both-swings-zero game is also an infinite ratio, and there the parties
  // are equally unexposed rather than maximally unequal — but it never reaches
  // this line: all four decision swings are 0, so `swing` is 0 and the function
  // has already returned an empty hint above. I first guarded it here with
  // `swingA !== swingB` and wrote a test for it; mutation testing showed the
  // test could not fail, because the case never arrives. The guard was dead code
  // and the comment justifying it was false, so both are gone.
  // THE WORDS AND THE STATISTIC HAVE TO NAME THE SAME PARTY, OR THE LINE IS
  // WITHHELD. This is the only guard here that was added because we were caught
  // AUTHORING a falsehood rather than failing to catch the model's.
  //
  // "far more riding on this" is, in ordinary English, about exposure to the
  // OUTCOME. `swingA`/`swingB` measure something else: how far a party's OWN
  // choice moves their own payoff. Usually those coincide. When they do not,
  // this line told the model to build the wrong party as the exposed one, and
  // the model obeyed perfectly.
  //
  // THE CASE THAT FORCED THIS, measured end to end on gpt-5.6-luna through the
  // product path: A = [[-8, 6], [-8, 7]], B = [[3, 8], [4, 3]]. A's outcomes
  // span -8..7; B's span 3..8, so B CANNOT LOSE under any pair of choices. But
  // swingA = 1 and swingB = 5, so the old line named B as the exposed party. Of
  // 9 draws, 8 asserted in prose that the column party was the more exposed one
  // ("whose livelihood is more exposed", "has the larger financial commitment",
  // "carries most of the operational exposure"), 0 named the row party, and ALL
  // NINE passed validateScenario and scenarioIsClaimFree. A decidable
  // comparative, contradicted by the matrix printed beside it, that every
  // shipped screen accepts — because the screens check the model against us,
  // and here we were the ones who were wrong.
  //
  // WHY NOT SIMPLY SWITCH TO THE RANGE READING: the whole measured benefit of
  // this line (87% at gap 25, 93% at gap 4) was obtained with the exposure
  // WORDING, and swapping the statistic under it would invalidate that without
  // re-measuring. WHY NOT REWORD IT TO DESCRIBE `swing`: "one party's own
  // decision moves their fortunes more than the other's" is a much weaker thing
  // to build a character on, and it is also untested. Requiring AGREEMENT keeps
  // the measured wording and the measured threshold exactly as they were, and
  // pays for it only on the games where the two readings conflict.
  //
  // COST, corpora named (_gen/blue_in3_gap.mjs): the line fires on 11.6% ->
  // 10.3% of hand-typed int[-9,9] games, and the hint is BYTE-IDENTICAL on
  // 99.999% of games overall — every game where the readings already agreed,
  // which is every game outside the conflicting ~11% of the ~12% that fire.
  const exposedBySwing = s.swingA >= s.swingB ? 'A' : 'B';
  // Exposure to the outcome: the span of everything that can happen to a party,
  // regardless of who caused it. A tie names nobody, which counts as disagreement.
  const rangeA = Math.max(g.a11, g.a12, g.a21, g.a22) - Math.min(g.a11, g.a12, g.a21, g.a22);
  const rangeB = Math.max(g.b11, g.b12, g.b21, g.b22) - Math.min(g.b11, g.b12, g.b21, g.b22);
  const exposedByRange = rangeA > rangeB ? 'A' : rangeB > rangeA ? 'B' : null;
  const readingsAgree = exposedByRange === exposedBySwing;
  const gap = s.playerGap >= PLAYER_GAP_NOTABLE && readingsAgree
    ? `${exposedBySwing === 'A' ? 'Player A has far more riding on this than Player B' : 'Player B has far more riding on this than Player A'} — make that difference in exposure part of who the two parties are. Never write "Player A", "Player B", "the players" or a bare letter in the description itself.`
    : '';

  const parts = [size, gap].filter(Boolean);
  return `MATCH THE SETTING TO THE STAKES. ${parts.join(' ')} Still no figures and no claims.`;
}
