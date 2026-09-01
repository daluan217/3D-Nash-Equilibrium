/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Validates a model-generated report against the solver's ground truth.
 *
 * PURE MODULE — no SDK import, no network, no DOM. Client, server, and the
 * eval harness all import this, so it must stay dependency-free beyond
 * gameEngine.
 *
 * Every claim is checked with TWO INDEPENDENT KEYS:
 *
 *   1. regretA/regretB ≈ 0, computed straight from the payoff matrix.
 *      This shares no code with computeAllNE, so it is a genuine second
 *      opinion rather than a restatement of the first.
 *   2. computeAllNE lists the profile (when the solver enumerates any).
 *
 * Keeping those two computations separate is load-bearing. If computeAllNE
 * ever starts calling regretA/regretB, this check silently becomes circular
 * and stops proving anything — see the invariant comment in gameEngine.ts.
 *
 * Range checks live here rather than in the JSON schema because structured
 * outputs do not support numeric constraints (no minimum/maximum). The schema
 * constrains shape; this module constrains truth.
 */

import type {
  ClaimedEquilibrium,
  GamePayoffs,
  GeometryClaims,
  LlmReport,
  Mismatch,
  MismatchKind,
  NashEquilibrium,
  ProseActionClaims,
  SuggestedScenario,
  ValidationResult,
} from '../types';
import { computeAllNE, computeIndifference, regretA, regretB, equilibriumSet, normalizeProseMinus, EA, EB} from './gameEngine';
// Pure like gameEngine — types in, numbers out, no I/O. Importing it keeps this
// module dependency-free in the sense the header means.
import { describeGeometry } from './geometry';

/** Matches the solver's own r3 rounding, so tolerance is consistent. */
const COORD_TOL = 0.0015;

/**
 * Regret is a payoff difference, evaluated at the solver's r3-rounded
 * coordinates — never the exact (generally irrational) mixed NE. A coordinate
 * off by δ becomes regret as large as δ·|swing|, where the swing is
 * dY = a11−a12−a21+a22 for A and dX = b11−b21−b12+b22 for B (each up to ~400
 * with payoffs clamped to ±100). A fixed 1e-6 tolerance therefore rejects
 * almost every *correct* mixed-NE report — the model can only ever echo the
 * 3-decimal coordinates it was given. So the tolerance is scaled per game by
 * the relevant swing, using the coordinate-match slack plus the r3 rounding on
 * top of it. This stays a genuine oracle: a truly-wrong claim is off by far
 * more than COORD_TOL and is caught by the coordsMatch key regardless.
 */
const REGRET_COORD_SLACK = COORD_TOL + 5e-4;
function regretTol(swing: number): number {
  return 1e-9 + REGRET_COORD_SLACK * Math.abs(swing);
}

function coordsMatch(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.abs(a.x - b.x) <= COORD_TOL && Math.abs(a.y - b.y) <= COORD_TOL;
}

function inUnitSquare(c: ClaimedEquilibrium): boolean {
  return (
    Number.isFinite(c.x) && Number.isFinite(c.y) &&
    c.x >= -COORD_TOL && c.x <= 1 + COORD_TOL &&
    c.y >= -COORD_TOL && c.y <= 1 + COORD_TOL
  );
}

function fmt(p: { x: number; y: number }): string {
  return `(${p.x}, ${p.y})`;
}

/**
 * Checks the PROSE — the only part of the report a user actually reads.
 *
 * The claim-level checks above validate a JSON array; a model can satisfy them
 * completely and still write a factually wrong sentence next to it (observed:
 * "at (x=0, y=0) ... B's Col 1 works best", when y=0 means Col 2). Nothing else
 * in the pipeline looks at this text before it is rendered.
 *
 * Deliberately tuned for very low false positives, because a noisy check would
 * corrupt the consistency metric it feeds:
 *  - Payoffs are matched against a GENEROUS allowlist — every cell in the matrix
 *    plus every equilibrium payoff — so only genuinely invented numbers flag.
 *    Legitimate counterfactuals ("switching drops A to 0") cite real cells.
 *  - Coordinates 0 and 1 are always allowed (they name pure strategies), and
 *    the check is skipped entirely on degenerate games, where every point in
 *    the region really is an equilibrium.
 */
function checkProse(
  prose: string,
  g: GamePayoffs,
  truth: NashEquilibrium[],
  degenerate: boolean,
): Mismatch[] {
  const out: Mismatch[] = [];
  if (!prose) return out;

  // Generous: any payoff printed in the matrix, or any equilibrium payoff.
  const allowedPayoffs = [
    g.a11, g.a12, g.a21, g.a22, g.b11, g.b12, g.b21, g.b22,
    ...truth.flatMap((t) => [t.eA, t.eB]),
  ];
  // Absolute floor plus a relative term so large payoffs aren't held to an
  // unreasonably tight match when the model rounds them for readability.
  // An approx operator (≈ ≃ ~ — observed live: "x≈0.909") announces a rounded
  // value, so it earns a looser but still bounded tolerance; without that,
  // "x ≈ 0.33" for x*=1/3 would flag and corrupt the metric with a false
  // positive, which this file's philosophy forbids.
  const near = (v: number, allowed: number[], approx = false) =>
    allowed.some((a) =>
      Math.abs(a - v) <= (approx ? Math.max(0.05, Math.abs(a) * 0.02) : Math.max(0.01, Math.abs(a) * 0.005)));

  // E[A]/E[B] forms are matched too — `\b([AB])=` can never see them (the `]`
  // blocks the word boundary), so those citations went unvalidated. Their
  // legitimate values (equilibrium payoffs) are already in the allowlist; a
  // model citing an off-equilibrium expectation would flag, but zero E[]-with-
  // value citations appeared across a 54-call QA sweep, so the false-positive
  // exposure is nil in practice.
  for (const m of prose.matchAll(/(?:\bE\[([AB])\]|\b([AB]))\s*([=≈≃~])\s*(-?\d+(?:\.\d+)?)/g)) {
    const value = Number(m[4]);
    if (!Number.isFinite(value) || near(value, allowedPayoffs, m[3] !== '=')) continue;
    const who = m[1] ? `E[${m[1]}]` : m[2];
    out.push({
      kind: 'prose-bad-payoff',
      claimed: null,
      expected: null,
      detail: `prose cites ${who}=${m[4]}, which is not a payoff anywhere in this game`,
    });
  }

  if (!degenerate) {
    // Indifference values are legitimate citations even when they are not
    // equilibrium coordinates: the grounding briefing itself tells the model
    // "A's surface goes level when B plays y = 0.5" (C7 draw 15 withheld a
    // fully true explanation for citing exactly that).
    const dA = g.a11 - g.a12 - g.a21 + g.a22, dB = g.b11 - g.b12 - g.b21 + g.b22;
    const yInd = dA !== 0 ? (g.a22 - g.a12) / dA : NaN;   // B's mix that levels A
    const xInd = dB !== 0 ? (g.b22 - g.b21) / dB : NaN;   // A's mix that levels B
    const allowedX = [0, 1, ...truth.map((t) => t.x), ...(xInd >= 0 && xInd <= 1 ? [xInd] : [])];
    const allowedY = [0, 1, ...truth.map((t) => t.y), ...(yInd >= 0 && yInd <= 1 ? [yInd] : [])];
    // The lookbehind skips complement notation: "1−x=0.833" is a TRUE
    // statement about Row 2's share, but the bare regex saw "x=0.833" inside
    // it and demoted correct prose (caught live on Spy vs. Analyst — a
    // checker false positive latent since the check shipped). A minus before
    // the letter means the citation is about 1−x/1−y, which the equilibrium
    // coordinate allowlist must not judge; a bare wrong "x=0.833" still
    // flags exactly as before.
    for (const m of prose.matchAll(/(?<![−-]\s?)\b([xy])\s*\*?\s*([=≈≃~])\s*(-?\d+(?:\.\d+)?)/gi)) {
      const axis = m[1].toLowerCase();
      const value = Number(m[3]);
      if (!Number.isFinite(value)) continue;
      // "x=0.333 on Row 2" / "y=0.667 for Col 2": the letter is being used for
      // the SECOND option's share — judge it as the complement (C10 draw 7).
      const tail = prose.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 16);
      const onSecond = /^\s*(?:on|for|to|at)\s+(?:Row|Col|Column)\s*2\b/i.test(tail);
      const allowed = axis === 'x' ? allowedX : allowedY;
      if (near(onSecond ? 1 - value : value, allowed, m[2] !== '=')) continue;
      out.push({
        kind: 'prose-bad-coordinate',
        claimed: null,
        expected: null,
        detail: `prose cites ${axis}=${m[3]}, which is not an equilibrium coordinate`,
      });
    }

    // REMOVED: a "does the prose falsely assert a pure equilibrium?" check.
    //
    // It was implemented as `/\bpure\b/` minus a negation-word window, and it
    // produced false positives on correct prose — "if the opponent played a
    // single pure strategy" (a counterfactual) and "neither side can commit to
    // a single pure action" (which asserts the exact opposite) both flagged.
    // Distinguishing an existence claim from a counterfactual or a negation is
    // a semantic judgement, not a lexical one, and a regex cannot do it. A
    // check that misfires on correct output is worse than no check: it corrupts
    // the consistency metric it feeds, and a false positive is indistinguishable
    // from a model regression.
    //
    // The underlying failure is already covered where it IS decidable: a model
    // that actually claims a nonexistent pure equilibrium must put it in
    // claimedEquilibria, where 'nonzero-regret' and 'not-in-solver' catch it
    // against ground truth. Only the numeric prose checks above survive here,
    // because "is this number in the allowlist?" is decidable and testable.
  }

  return out;
}

/**
 * Checks the DECLARED geometry against the computed geometry.
 *
 * The explainer is given the shape of the two payoff surfaces and told to
 * describe the equilibrium in those terms — a level shelf, a warp, the joint
 * flat spot. That widens what the prose can get wrong, and none of it was
 * covered: the older checks all validate coordinates and payoffs.
 *
 * The claims are checked HERE, in the structured output, and never by reading
 * the prose. That is deliberate and is the lesson recorded in checkProse above:
 * "does this sentence assert a flat shelf?" is a semantic judgement a regex
 * cannot make, so the model is required to state the claim as a boolean where
 * comparing it is a lookup.
 *
 * Checked in BOTH directions. The briefing states every one of these facts
 * explicitly, in the positive AND the negative ("A's surface is WARPED" /
 * "is a FLAT PLANE"), so the model is not guessing and a disagreement in either
 * direction means it contradicted material it was handed. Declining to declare
 * is the escape hatch — a null geometryClaims is skipped, not failed.
 */
function checkGeometry(
  claims: GeometryClaims | null | undefined,
  g: GamePayoffs,
): Mismatch[] {
  if (!claims) return [];
  const geo = describeGeometry(g);
  const EPS = 1e-9;

  const rows: {
    kind: MismatchKind;
    claimed: boolean;
    actual: boolean;
    yes: string;
    no: string;
  }[] = [
    {
      kind: 'geometry-bad-twist',
      claimed: claims.surfacesInteract,
      actual: Math.abs(geo.twistA) >= EPS,
      yes: "A's surface is warped",
      no: "A's surface is a flat plane",
    },
    {
      kind: 'geometry-bad-mirror',
      // Constant-sum counts: the briefing calls it "A's flipped, offset by a
      // constant", which is still a mirror. Only a genuinely non-constant-sum
      // game makes the claim false.
      claimed: claims.opponentSurfaceIsMirror,
      actual: geo.zeroSum || geo.constantSum,
      yes: "B's surface mirrors A's",
      no: "B's surface is its own shape",
    },
    {
      kind: 'geometry-bad-shelf',
      // yStarInRange is false when twistA is 0 (yStar is NaN), so this single
      // predicate covers both ways a shelf can fail to exist.
      claimed: claims.hasFlatShelfForA,
      actual: geo.yStarInRange,
      yes: 'A has a flat shelf on the board',
      no: 'A has no flat shelf on the board',
    },
    {
      kind: 'geometry-bad-flatspot',
      claimed: claims.equilibriumIsInteriorFlatSpot,
      actual: geo.hasInteriorFlatSpot,
      yes: 'the equilibrium is an interior joint flat spot',
      no: 'the equilibrium sits on an edge or corner',
    },
    {
      // The hole this check exists to close was observed, not hypothesised: a
      // report asserted "the mixed-strategy equilibrium is von Neumann's minimax
      // logic" about a game that is not zero-sum, and passed every other check at
      // 100% because each NUMBER in it was correct. Minimax is a claim about the
      // game's STRUCTURE, and structure is exactly what the other checks ignore.
      kind: 'geometry-bad-minimax',
      claimed: claims.invokesMinimax,
      actual: geo.minimaxApplies,
      yes: 'the minimax / value-of-the-game framing applies',
      no: 'the game is not constant-sum, so it has no single value to be a minimax of',
    },
    {
      kind: 'geometry-bad-dominance',
      claimed: claims.claimsDominantStrategy,
      actual: geo.dominantRowA || geo.dominantColB,
      yes: 'some player has a dominant strategy',
      no: 'neither player has a dominant strategy',
    },
  ];

  /**
   * ASYMMETRY, on purpose. The first four are checked both ways: the briefing
   * states each of those facts positively AND negatively, so disagreeing in
   * either direction contradicts material the model was handed.
   *
   * The last two are checked in ONE direction only — claiming them when they are
   * false. Declining to call a zero-sum game a minimax problem, or not
   * mentioning an available dominant strategy, is a stylistic choice in a
   * two-to-four sentence explanation, not an error. Flagging silence would make
   * the check fire on correct output, which is the failure mode this file exists
   * to avoid.
   */
  const oneWay = new Set<MismatchKind>(['geometry-bad-minimax', 'geometry-bad-dominance']);
  return rows
    .filter((r) => (oneWay.has(r.kind) ? r.claimed && !r.actual : r.claimed !== r.actual))
    .map((r) => ({
      kind: r.kind,
      claimed: null,
      expected: null,
      detail: `report declares ${r.claimed ? r.yes : r.no}, but ${r.actual ? r.yes : r.no}`,
    }));
}

export interface ScenarioValidation {
  ok: boolean;
  /** Human-readable reasons, empty when ok. */
  issues: string[];
}

// Cell accessors and the shared best-reply check, used by both the scenario
// story gate and the prose action gate — one comparison, one tolerance, so
// the two gates can never disagree about what "does better against" means.
const cellAOf = (g: GamePayoffs, r: number, c: number) => (r === 1 ? (c === 1 ? g.a11 : g.a12) : (c === 1 ? g.a21 : g.a22));
const cellBOf = (g: GamePayoffs, r: number, c: number) => (r === 1 ? (c === 1 ? g.b11 : g.b12) : (c === 1 ? g.b21 : g.b22));
const isOpt12 = (n: unknown): n is 1 | 2 => n === 1 || n === 2;

function bestReplyIssues(
  replies: Array<{ player: string; opponentOption: number; bestOption: number; bestPays?: number | null; altPays?: number | null }>,
  g: GamePayoffs,
  source: 'story' | 'prose',
): string[] {
  const issues: string[] = [];
  const near = (v: number, a: number) => Math.abs(a - v) <= Math.max(0.01, Math.abs(a) * 0.005);
  for (const r of replies) {
    if ((r.player !== 'A' && r.player !== 'B') || !isOpt12(r.opponentOption) || !isOpt12(r.bestOption)) {
      issues.push(`best-reply claim is malformed (player=${r.player}, opponent=${r.opponentOption}, best=${r.bestOption})`);
      continue;
    }
    const other = r.bestOption === 1 ? 2 : 1;
    // A's option indexes rows against B's fixed column; B's indexes columns
    // against A's fixed row.
    const mine = r.player === 'A' ? cellAOf(g, r.bestOption, r.opponentOption) : cellBOf(g, r.opponentOption, r.bestOption);
    const alt = r.player === 'A' ? cellAOf(g, other, r.opponentOption) : cellBOf(g, r.opponentOption, other);
    // Strictly worse fails; a tie passes (a weakly-best claim is not a lie).
    if (mine < alt - 1e-9) {
      issues.push(
        `${source} says ${r.player}'s option ${r.bestOption} does better against opponent option ${r.opponentOption}, but it pays ${mine} vs ${alt}`,
      );
    }
    // Declared compared payoffs must belong to the compared cells. Catches
    // the live seam where "gets 9 rather than −9" cited two REAL payoffs
    // (so every allowlist passed) welded onto the wrong row.
    if (r.bestPays !== null && r.bestPays !== undefined && (!Number.isFinite(r.bestPays) || !near(r.bestPays, mine))) {
      issues.push(
        `${source} pairs ${r.player}'s option ${r.bestOption} against opponent option ${r.opponentOption} with payoff ${r.bestPays}; that cell pays ${mine}`,
      );
    }
    if (r.altPays !== null && r.altPays !== undefined && (!Number.isFinite(r.altPays) || !near(r.altPays, alt))) {
      issues.push(
        `${source} pairs the alternative option ${other} against opponent option ${r.opponentOption} with payoff ${r.altPays}; that cell pays ${alt}`,
      );
    }
  }
  return issues;
}

/**
 * Checks an INVENTED scenario's declared story claims against the matrix.
 *
 * Same design as checkGeometry: "does this sentence claim Upload beats
 * Compress?" is a semantic judgement no regex can make (see the removed
 * /pure/ check above), so the model is required to restate each claim as
 * data — a (row, col) → (a, b) citation, or a (player, opponent option,
 * better option) best-reply — where checking is a lookup. A QA sweep found
 * ~1 in 4 invented descriptions asserting a backwards pairing or citing a
 * real payoff pair against the wrong cell, all invisible to the numeric
 * allowlist because the numbers themselves were real.
 *
 * Deliberately NOT part of validateReport: the report's prose is already
 * validated, and a bad optional story should cost the story, not demote the
 * whole report to the deterministic panel. Keeping it separate also leaves
 * the eval sweep's consistency metric untouched — the server gates on this,
 * the eval never crosses it.
 *
 * Residual (stated honestly): a claim the model makes in the description but
 * fails to DECLARE is only caught when it is payoff-anchored ("A=9"); a bare
 * "they get 8 and 3" or an undeclared "works best against" needs the model
 * to follow the declaration rule, which the prompt demands and the server's
 * one retry backs up.
 */
/**
 * An explicit MULTIPLE, spelled out. The digit screens catch "100000x"; this
 * catches the same claim written in words, which contains no digit at all —
 * "a choice worth a hundred thousand times more than the other party's",
 * "Hundredfold Expansion / No Change" as an option pair on a game whose every
 * swing is a thousandth of a unit.
 *
 * Scoped to constructions that carry a NUMBER, because that is the half that is
 * decidable. "twice", "double", "half" and "many times" are all left alone:
 * they are ordinary English ("a double shift", "half day"), they assert no
 * specific ratio, and a screen for them is the word list this file's other
 * comments spend their length arguing against. "manifold" is unreachable by
 * construction — the -fold alternation requires a numeral stem, so the engine
 * part and the adjective both pass.
 *
 * WHICH BRANCH ACTUALLY EARNS ITS PLACE. The numeral-bearing alternatives
 * ("10-fold", "10x", "12 times larger") are redundant against the caller as it
 * stands: every site that consults this constant screens for a numeral FIRST
 * and returns before reaching it. They are kept so the predicate is true to its
 * own name when read or called on its own, and they are marked here rather than
 * left to imply coverage they are not currently providing. The branch that
 * closes a real hole is the SPELLED-OUT one — "hundredfold", "a hundred
 * thousand times more", "orders of magnitude" — which contains no numeral and
 * is therefore invisible to every screen that runs before it.
 *
 * Reach: 0 of 890 stored real draws, in every field.
 */
const MULTIPLIER_CLAIM = new RegExp(
  [
    // twofold … thousandfold, and 10-fold. A numeral stem is required.
    String.raw`\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)[-\s]?fold\b`,
    String.raw`\b\p{N}+[-\s]?fold\b`,
    // 10x, 100 x. Not "3x3" — the trailing boundary fails against a digit.
    String.raw`\b\p{N}+\s?x\b`,
    String.raw`\p{N}\s?[×]`,
    // "a hundred thousand times more", "12 times larger", "ten times as costly"
    String.raw`\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|\p{N}+)\s+times\s+(?:more|less|larger|smaller|greater|bigger|higher|lower|worse|better|as\s+\w+)\b`,
    // `[-\s]+`, not `\s+`. RED 1's label oracle (hole L10) put the identical
    // claim in a label as "Order-of-Magnitude Expansion" and it walked straight
    // through this rule, because the rule was written for the spaced spelling
    // only. Not a missing screen — an EXISTING screen defeated by punctuation,
    // the same shape as the U+2212 minus this file normalizes, which has bitten
    // this repo three times. Cost of the widening, measured over 3,245
    // gate-passing draws across every corpus: zero.
    String.raw`\borders?[-\s]+of[-\s]+magnitude\b`,
  ].join('|'),
  'iu',
);

/**
 * A BARE LARGE QUANTITY IN A NAME OR AN OPTION LABEL.
 *
 * RED 1's label oracle, hole L7: rows "Ten Thousand Crates" / "One Crate" on a
 * matrix whose every swing is one thousandth of a unit. There is no digit, so
 * the `\p{N}` screen sees nothing; there is no "-fold", no "times more" and no
 * "orders of magnitude", so no branch of MULTIPLIER_CLAIM sees it either. The
 * label asserts a magnitude about a matrix it cannot see, and under rung 3 the
 * rendered paragraph beside it states the real number.
 *
 * SCOPE IS NAME AND LABELS ONLY, DELIBERATELY. Both scopes measure 0 false
 * positives today, but they are not the same bet on future output: a
 * DESCRIPTION may legitimately set a scene at scale ("a depot handling
 * thousands of crates"), whereas a large round number in a strategy NAME is an
 * assertion about the payoff. The description already carries the multiplier
 * screen for the form that is actually a claim ("a hundred thousand times
 * more", RED 2's case L5). Keeping the description free is the minimum
 * constraint that closes the hole.
 *
 * NARROWER THAN RED'S OWN D4 PREDICATE, and the differences are the point.
 * Theirs is `hundreds?|thousands?|millions?|billions?|dozens?|twice|thrice|
 * \w+fold`. Three of those are scene-noun collisions of exactly the kind this
 * campaign has hit four times:
 *   `\w+fold` matches "Manifold", which this suite already pins as a control
 *             ("Manifold is not a multiple — the -fold rule requires a numeral
 *             stem"); adopting D4 as written would have broken a passing test.
 *   `twice`   matches "a twice-weekly delivery", a SCHEDULE, not a magnitude.
 *   `dozens`  matches "dozens of crates", ordinary scene-setting.
 * None of the three appears in the 3,296 draws on this box, so all of them
 * measure 0% today. They are excluded on the shape of the word rather than on
 * a rate, because the rate is what would have hidden them.
 *
 * Reach: 0 of 3,245 gate-passing draws across 49 corpora
 * (_gen/blue_w5_spelledprice.mjs). CONTAINMENT, not detection — recorded that
 * way for the same reason the numeral screen is.
 */
const BIG_SPELLED_QUANTITY = /\b(?:hundreds?|thousands?|millions?|billions?|trillions?)\b/i;

/**
 * META VOCABULARY — the prompt's own words, and the mathematical object itself,
 * appearing in user-facing fiction.
 *
 * This is a REGISTER defect, not a falsehood. "Player A chooses between Early
 * Harvest and Late Harvest" asserts nothing false; it simply is not a story. It
 * is the app's own scaffolding shown to a reader who was promised a scenario,
 * and it is the largest remaining defect class with real reach on observed
 * output — the truth classes are measured at or near zero.
 *
 * NOT INHERITED FROM THE TEACHER. Measured per surface over 3,363 gate-passing
 * draws (_gen/blue_w6_metaprice.mjs, _gen/blue_w6_metadesign.mjs) — these are
 * two different populations and pooling them hides the finding:
 *
 *   sub-form                              local     cloud
 *   "Player A" / "Player B"                6.1%      6.2%    <- the one that IS equal
 *   a BARE LETTER as a character           4.0%      1.2%
 *   "the two players" / "each player"      3.0%      0.2%
 *   "the game" as the object               0.6%      0.0%
 *   ------------------------------------------------------
 *   union of the four                     14.0%      7.0%
 *
 * TWO TRAPS, both handed over already measured, both built in from the first
 * draft rather than discovered after shipping.
 *
 * TRAP A — "THE GAME" IS A PRODUCT IN THIS CORPUS. The domain rotation contains
 * film, software and theatre settings, and of 31 META hits in an earlier
 * training corpus TWELVE were video-game scenarios ("a game studio chooses…
 * for distributing the game") — not one game-theoretic. A bare "the game" rule
 * deletes a whole domain. TWO independent guards, and the measurement shows
 * each one spares a case the other does not:
 *   - the hyphen boundary `(?![-\w])` alone spares the real cloud draw
 *     "…Solo Sales for the GAME-DAY menu", which a bare `\bthe game\b` matches
 *     because `\b` sits happily before a hyphen. Same punctuation class as the
 *     `orders?\s+of\s+magnitude` hole and the U+2212 minus.
 *   - the product-vocabulary test alone spares "a small game studio chooses
 *     whether to give the game a Featured Slot", which the hyphen guard does
 *     NOT spare.
 * So the rule fires only where a sentence names the game AND carries
 * game-theory vocabulary AND carries no game-product vocabulary.
 *
 * TRAP B — THE BARE-LETTER FORM NEEDS A NEGATIVE LOOKBEHIND, and this is the
 * single most expensive thing in this screen to get wrong. `\b[AB]\s+chooses`
 * matches "Operator A chooses… while Operator B chooses…", which is ordinary
 * English for two indistinguishable parties and is CLOUD'S GOOD SHAPE.
 * Measured here, on this corpus:
 *
 *   naive, no lookbehind : local 4.8%   CLOUD 20.0%
 *   with the lookbehind  : local 4.0%   cloud  1.2%
 *
 * 229 draws separate those two numbers and every one inspected is the good
 * shape — "Agency A chooses Prime Slot or Off-Prime Slot, while Operator B
 * chooses…". RED 1's first draft of this predicate reported 20.4% on cloud and
 * 13 of 14 hand-checked matches were that shape. A rule that rejects a fifth of
 * all cloud output would have looked like a huge win right up until someone
 * read the rejections.
 *
 * WHAT IS DELIBERATELY NOT HERE. The word "payoff" is the fifth sub-form of
 * this class and it is NOT screened, because doing so contradicts a control
 * that RED 1'S OWN ORACLE scores: "their choices determine the resulting
 * payoffs" is asserted there as the vacuous closer the model writes constantly,
 * true on any matrix whose payoffs vary. Both readings are defensible and
 * neither instrument is broken — the oracle asks whether the sentence is FALSE
 * (it is not) and this screen asks whether it is IN REGISTER (it is not). That
 * is a scoreboard question, not a validator question, so it is escalated rather
 * than decided here. Cost of leaving it out, measured: the word "payoff" is the
 * ONLY meta marker in 1.2% of local draws and 0.0% of cloud draws.
 *
 * `\p{N}` forms ("Player 1") are not listed because they are unreachable: the
 * numeral screens above return first, in labels and in the description alike.
 * Marked rather than left to imply coverage they do not provide.
 */
const META_PROMPT_CAST = /\bplayers?\s+(?:[AB]|one|two)\b/i;
const META_GAME_CAST = /\b(?:the\s+two\s+players|both\s+players|each\s+player)\b/i;
// "the players" BARE is excluded on SHAPE, not on rate. It is the one member
// with an ordinary non-game meaning — "the players" is the acting company, and
// the domain rotation contains "puppet theatre touring". It measures 0.1% local
// and 0.0% cloud, and the only two draws it uniquely catches are already caught
// by another form. W5's D4 refusal is the precedent: a zero rate is not grounds
// for including a word whose shape collides.
const META_BARE_LETTER =
  /(?<![\p{L}\p{N}][ \t]|[\p{L}\p{N}])\b[AB]\b\s+(?:chooses?|choosing|picks?|decides?|selects?|plays?|prefers?|is|are|will|must|can|has|have)\b/u;
const GAME_THEORY_VOCAB = /\b(?:payoffs?|equilibri\w+|strateg\w+|players?|matrix|matrices|dominant|zero[\s-]sum|simultaneous\w*|normal[\s-]form|best\s+response|moves?)\b/i;
const GAME_PRODUCT_VOCAB = /\b(?:video\s?games?|game\s+studio|game\s+developer|gaming|console|arcade|board\s+games?|playtest\w*|publisher|storefront|featured\s+slot|download\w*|app\s+store|steam)\b/i;

/** TRAP A, per sentence: the game as the OBJECT, never the game as a product. */
function namesTheGameItself(text: string): boolean {
  for (const s of text.split(/(?<=[.;•])\s+/)) {
    if (!/\bthe\s+game\b(?![-\w])/i.test(s)) continue;
    if (GAME_PRODUCT_VOCAB.test(s)) continue;
    if (GAME_THEORY_VOCAB.test(s)) return true;
  }
  return false;
}

/**
 * TWO DISTINCT CHOOSERS — the cast analysis behind three of the structural
 * rules in scenarioIsClaimFree.
 *
 * Every game this app models has exactly two players, each holding exactly one
 * pair of options. A description that hands both pairs to one actor, or hands
 * the second pair to nobody, shows the reader a game the product cannot model —
 * and it is the most user-visible defect class left, because the whole subject
 * of the app is two players choosing simultaneously.
 *
 * These are FUNCTIONS rather than entries in the CLAIMY regex table because
 * every one of them is conditioned on the description's OWN CAST, not on a
 * word. That distinction is the entire design: the first draft of each rule was
 * a vocabulary match, and each produced a false positive on real output that
 * only the cast could rule out.
 */
const CAST_AUX = /^(?:is|are|was|were|will|must|can|could|would|should|may|might|has|have|had|been|be|also|then)$/i;
const CAST_STOP = new Set(['the', 'a', 'an', 'its', 'their', 'his', 'her', 'this', 'that', 'these', 'those',
  'same', 'each', 'both', 'either', 'neither', 'must', 'will', 'also', 'then', 'and', 'or',
  'independently', 'simultaneously']);
// Clause boundaries: sentence ends, and the connectives that introduce a second
// actor's clause. "X chooses A, WHILE Y chooses B" is two choosers in one
// sentence, and a splitter that missed that would see one.
const castClauses = (d: string) => d.split(/(?<=[.;!?])\s+|\s*,?\s+(?=while\b|whereas\b)/i).filter((c) => c.trim());
// Actor-introducing verbs, deliberately broader than the choosing verbs. An
// actor is often introduced with "is planning" or "operates" and only chooses
// in a later clause; counting only choosing verbs made "A regional airline is
// PLANNING a series of flights… It chooses… while the glacier manager
// chooses…" look like a one-actor description. It has two.
const CAST_VERB = String.raw`(?:chooses|choose|choosing|picks|pick|picking|decides|decide|deciding|selects|select|selecting|opts|opt|books|book|plans|plan|planning|operates|operate|operating|runs|run|running|schedules|schedule|scheduling|weighs|weigh|weighing|considers|consider|considering|manages|manage|managing|faces|face|facing|serves|serve|serving|sets|set|setting|holds|hold|holding|must|is|are)`;

function describedCast(desc: string): { nouns: Set<string>; pronouns: string[] } {
  const nouns = new Set<string>();
  const pronouns: string[] = [];
  for (const clause of castClauses(desc)) {
    const m = new RegExp(String.raw`^(.*?)\b(?:will\s+|must\s+|then\s+|also\s+|independently\s+|simultaneously\s+)*${CAST_VERB}\b`, 'i').exec(clause);
    if (!m) continue;
    const subj = m[1].trim().replace(/\s+(?:will|must|also|then|independently|simultaneously)\s*$/i, '');
    if (!subj) continue;
    const words = subj.split(/\s+/).filter(Boolean);
    const last = (words[words.length - 1] ?? '').replace(/[^A-Za-z'’-]/g, '');
    if (/^(?:it|he|she|they)$/i.test(last) && words.length <= 2) { pronouns.push(last.toLowerCase()); continue; }
    if (!last || CAST_AUX.test(last) || CAST_STOP.has(last.toLowerCase())) continue;
    nouns.add(last.toLowerCase().replace(/s$/, ''));
  }
  return { nouns, pronouns };
}

/**
 * One actor taking a SECOND decision: "The airport will ALSO choose between…"
 * when the airport already chose. Found in the wild (rt1#71, and rt2 stakes
 * pilot's "Each manager also chooses between Deep Irrigation and Surface
 * Irrigation" — each manager holding both pairs).
 *
 * The subject test is the whole rule. "A smaller independent distributor is
 * ALSO choosing between an open slot and a crowded slot" is CORRECT output:
 * there "also" means "likewise", and the subject is the second actor, newly
 * introduced. Same word, opposite meaning. The first draft captured the
 * auxiliary "is" as the subject and flagged it.
 */
function oneActorTakesASecondDecision(desc: string): boolean {
  const re = /\b([A-Za-z][\w'’-]*)\s+(?:is|are|will|must|can|would|should|may)?\s*also\s+(?:choose|chooses|choosing|decide|decides|deciding|pick|picks|picking|select|selects|selecting)\b/gi;
  for (const m of desc.matchAll(re)) {
    const w = m[1];
    if (CAST_AUX.test(w) || CAST_STOP.has(w.toLowerCase())) continue;
    const head = w.toLowerCase();
    // Singular/plural tolerated ("managers" earlier, "manager also chooses"
    // later). Only stemmed when the word is long enough that the trailing s is
    // plausibly a plural — stripping it from "is" produced "i", which matched
    // everything, and that was the first draft's false positive.
    const sing = head.length > 3 ? head.replace(/s$/, '') : head;
    if (new RegExp(String.raw`\b${sing}s?\b`, 'i').test(desc.slice(0, m.index))) return true;
  }
  return false;
}

/**
 * The second option pair handed to a SINGULAR pronoun when no second player was
 * ever named: "A dairy co-op is deciding between Premium Pricing and Cost-Plus
 * Pricing… IT chooses either Local Sales or Online Sales." Two draws in the
 * wild. "They" is excluded on purpose — a plural pronoun refers to both players
 * and is the correct way to say they choose simultaneously.
 */
function secondPairHandedToAPronoun(desc: string): boolean {
  const { nouns, pronouns } = describedCast(desc);
  return pronouns.some((p) => /^(?:it|he|she)$/.test(p)) && nouns.size < 2;
}

/**
 * A claim that one player's move IS the other's: "…while the coordinator
 * chooses THE SAME TIMING." The players move independently, so their moves
 * cannot be asserted equal.
 *
 * The discriminator is that the shared noun is NOT already in the scene. "The
 * co-op chooses one, while the market buyer chooses THE SAME PRODUCT" shares a
 * thing that was named earlier — scene-setting, not a claim about the move.
 * "The same timing" names nothing earlier, so "the same" can only be anaphoric
 * to the other player's choice. Decision-nouns are excluded outright, because
 * "makes the same scheduling CHOICE" is the ordinary "faces the same kind of
 * decision" reading, and "makes" is excluded for the same reason.
 */
function assertsTheSameMove(desc: string): boolean {
  const re = /\b(?:chooses?|choosing|picks?|picking|selects?|selecting)\s+(?:exactly\s+)?the\s+same\s+((?:[a-z'’-]+\s+){0,2}?)([a-z'’-]+)\b/gi;
  for (const m of desc.matchAll(re)) {
    const noun = m[2].toLowerCase();
    if (/^(?:choices?|options?|decisions?|kinds?|types?|calls?|sorts?|ones?|way|ways)$/.test(noun)) continue;
    const before = desc.slice(0, m.index);
    const stem = noun.length > 4 ? noun.replace(/(?:ing|s)$/, '') : noun;
    if (new RegExp(String.raw`\b${stem}`, 'i').test(before)) continue;
    const mods = (m[1] || '').trim().split(/\s+/).filter(Boolean);
    if (mods.some((w) => new RegExp(String.raw`\b${w.slice(0, Math.max(4, w.length - 3))}`, 'i').test(before))) continue;
    return true;
  }
  return false;
}

/**
 * CLAIM-FREE screen for the rung-3 configuration.
 *
 * When the solver renders the mathematics, the model's only job is to invent a
 * world — and round T1 measured that a model asked ONLY for a scenario puts MORE
 * assertions into it (11.4% false, higher than the free-prose build's 0-of-43).
 * Every one of those four defects passed validateScenario and the direction
 * checks, because they are not payoff claims: they are claims about who responds
 * to whom, who the players are, and what the options mean.
 *
 * Checking such claims is the hard problem this whole campaign has been chasing.
 * Requiring their ABSENCE is easy, and it is exactly the form the local model
 * already produces naturally (storyClaims null on every story, zero story
 * defects across four rounds). So: a description may set a scene and name the
 * options, and may not assert anything decidable about the game.
 *
 * WHY THE NAME AND THE OPTION LABELS ARE SCREENED HERE AND NOT IN
 * validateScenario. The no-numbers rule is a RUNG-3 rule: it is true only
 * because the solver states every number, which is only so when the template
 * renders the mathematics. validateScenario runs at every rung, and at rung 0
 * the model writes the numbers itself — "Gate 12 / Gate 7" is an ordinary pair
 * of option names there, and a numeral screen living in validateScenario would
 * reject it. This function is called on the rung-3 paths and nowhere else, so
 * it is the only place the justification actually holds. The matrix-checked
 * parenthetical-annotation rule stays in validateScenario, where it belongs:
 * that one is decidable at any rung because the matrix settles it.
 */
export function scenarioIsClaimFree(sc: SuggestedScenario): { ok: boolean; reason?: string } {
  // A NUMBER, OR AN EXPLICIT MULTIPLE, IN THE NAME OR AN OPTION LABEL.
  //
  // validateScenario treats a number in a label as a claim that has to match
  // the matrix — but only INSIDE PARENTHESES. Drop the brackets and the
  // identical assertion is examined by nothing. The C11 draw that rule cites as
  // its motivation, rows "Signal (−1/−1)" / "Signal (+1/+1)", is one keystroke
  // from being invisible to it: written "Signal −1/−1" / "Signal +1/+1" the two
  // labels are distinct, no parenthetical exists, and the whole gate passes.
  // RED 2 walked the same channel from the other end — "Commit 1000 Units /
  // Commit 1 Unit" on a game whose every swing is one thousandth of a unit, and
  // "The 100000x Decision" in the NAME, a field no screen read at all.
  //
  // NO EXEMPTION for a parenthetical the matrix verifies. One was written and
  // then removed as dead code: across 890 stored draws, 4,450 authored fields,
  // not one name or option label contains a numeral OR a parenthetical of any
  // kind. Under rung 3 a correct payoff annotation in a label is redundant
  // anyway, because the rendered paragraph beside it states the same number.
  //
  // WHAT IS DELIBERATELY NOT GATED, and why this is not a word list.
  // Magnitude-BEARING label pairs — "Full Support / Lean Support", "Premium
  // Price / Discount Price", "Reduce Catch / Maintain Catch" — occur in 32.16%
  // of gate-passing real draws (284 of 883; _gen/blue_w3_reach.mjs), and the
  // rate does not track the payoff spread. Gating "these labels sound dramatic"
  // would reject a third of all good output to catch something no instrument
  // can decide. Even the far narrower total-vs-nothing pair fires on real
  // output ("Full Monitoring / No Monitoring", a perfectly good pair of
  // options) and is excluded for that reason alone. Two of RED 2's six
  // adversarial cases — "Full Evacuation / No Evacuation" and "Full Shutdown /
  // No Shutdown" — are in that undecidable class and REMAIN OPEN on purpose.
  //
  // REACH, honestly stated: 0 of 890 stored draws, and 0 across RED 1's 30
  // deliberately magnitude-provoking matrix families (±100, "huge stakes",
  // "epsilon", "asym magnitude", "huge vs tiny mix"). So this is CONTAINMENT,
  // not detection — it costs the current two models nothing and catches them
  // nothing. It earns its place because the channel is demonstrably walkable
  // (6 of 6 hand-built claims reached the user through the shipping gate) and
  // the distribution is not fixed: the local model is being retrained, and
  // REPORT_MODEL is an env var that has already changed under this product
  // twice without anyone noticing.
  for (const key of ['name', 'row1', 'row2', 'col1', 'col2'] as const) {
    const raw = typeof sc[key] === 'string' ? (sc[key] as string).trim() : '';
    if (!raw) continue;
    const where = key === 'name' ? 'the scenario name' : `the option label "${raw}"`;
    // `\p{N}` rather than `\d`: `\d` is ASCII-only in JavaScript, so a fullwidth
    // or Arabic-Indic numeral walks straight through a rule that exists to stop
    // numerals. Same class of hole as the U+2212 minus this file normalizes,
    // which has bitten the repo three times.
    if (/\p{N}/u.test(raw)) return { ok: false, reason: `${where} cites a number` };
    if (MULTIPLIER_CLAIM.test(raw)) return { ok: false, reason: `${where} asserts a multiple` };
    // The numeral written as a WORD. See BIG_SPELLED_QUANTITY above: name and
    // labels only, and narrower than the predicate RED 1 scored, because three
    // of theirs collide with ordinary scene vocabulary.
    if (BIG_SPELLED_QUANTITY.test(raw)) return { ok: false, reason: `${where} cites a large quantity` };
  }
  const desc = normalizeProseMinus((sc.description ?? '').trim());
  if (!desc) return { ok: true };
  // `\p{N}`, for the reason given on the label screen above: `\d` is ASCII-only
  // in JavaScript. This rule shipped as `/\d/` and a fullwidth numeral walked
  // straight through the rule that exists to stop numerals.
  if (/\p{N}/u.test(desc)) return { ok: false, reason: 'the description cites a number' };
  // The spelled-out multiple contains no numeral, so the rule above cannot see
  // it, and none of the comparative rules below reach it either: "worth a
  // hundred thousand times more than the other party's" uses no payoff word and
  // no comparative from their vocabulary. Measured reaching the user through
  // the full shipping gate (RED 2, case L5).
  if (MULTIPLIER_CLAIM.test(desc)) return { ok: false, reason: 'the description asserts a multiple' };
  const CLAIMY: [RegExp, string][] = [
    // "payoffs" as a bare NOUN asserts nothing — "the matrix records their
    // strategic payoffs", "their payoffs represent the resulting commercial
    // success" — and dropping on the word alone cost 1,269 of 4,462 GOLD
    // scenarios (28.4%), which is an off switch, not a filter. The same
    // word-not-claim error as the joint-payoff check. So the bare noun is
    // allowed and rule 1b below drops it once it is ATTACHED to a comparison.
    // `equilibrium` stays claimy on sight: naming where the equilibrium is IS
    // an assertion, and a scenario has no business making it.
    [/\b(?:better|worse|best|worst|prefers?|favou?rs?|dominant|dominates?|optimal|advantage|equilibri(?:um|a)|indifferent|gains?\s+more|loses?\s+more)\b/i, 'a comparative or payoff word'],
    [/\b(?:payoffs?|returns?|rewards?)\b[^.;]{0,40}?\b(?:higher|lower|greater|larger|smaller|bigger|more|less|equal|same|highest|lowest|maximis\w*|maximiz\w*|minimis\w*|minimiz\w*|exceed\w*|outweigh\w*)\b|\b(?:higher|lower|greater|larger|smaller|bigger|highest|lowest|equal|same)\b[^.;]{0,40}?\b(?:payoffs?|returns?|rewards?)\b/i, 'a payoff word attached to a comparison'],
    [/\b(?:respond(?:s|ing)?|reacts?(?:ing)?|depend(?:s|ing)?\s+on|hinges?\s+on|based\s+on|in\s+(?:response|reaction)(?:\s+to)?|in\s+turn|afterwards?|after\s+seeing|having\s+seen|once\s+(?:A|B|the\s+\w+)\s+(?:has\s+)?(?:chosen|picked|played|moved)|best\s+move|should\s+(?:choose|pick|play))\b/i, 'a claim about how one player answers the other'],
    [/\b(?:if|when|whenever|unless|whichever|whatever|regardless\s+of|no\s+matter)\b[^.;]{0,60}?\b(?:then\s+)?(?:gains?|loses?|wins?|earns?|is\s+better|does\s+better|pays?\s+off)\b/i, 'a conditional outcome claim'],
    // MOVE ORDER. "A chooses X before B chooses Y" asserts a sequence the game
    // does not have — found in adversarial round 2 (#48, and #6 which then
    // contradicted itself with "simultaneously"). The distinction is decidable
    // and must be kept: "before the inspection" names an EVENT and is fine;
    // "before a port manager chooses" names the OTHER PLAYER'S MOVE and is not.
    // So the trigger is before/after followed closely by a CHOOSING verb.
    [/\b(?:before|after)\b[^.;]{0,45}?\b(?:chooses?|choosing|picks?|picking|decides?|deciding|selects?|selecting|plays?|playing|moves?|commits?)\b/i, 'a claim about who moves first'],
    // The rule above keys on the WORDS before/after. A red team found five other
    // ways to assert the same sequence, all of which passed — captured in the
    // wild as "…with the row hospital choosing FIRST and the column hospital
    // choosing SECOND", which self-contradicts "independently choose" in the
    // same sentence. Ordinal, observation and follow phrasings are the same claim.
    [/\b(?:goes?|moves?|chooses?|choosing|picks?|acts?|plays?)\s+(?:first|second)\b|\b(?:first|second)\s+(?:mover|player\s+to\s+(?:move|choose|act))\b|\bobserv\w+\b[^.;]{0,40}?\b(?:then|before)\b|\b(?:then|and)\s+(?:B|A|the\s+\w+)\s+(?:follows?|responds?|replies|counters?)\b|\bcommits?\s+(?:first|initially)\b|\b(?:follows?|replies|responds?)\s+(?:to\s+)?the\s+(?:first|other)\b/i, 'a claim about who moves first'],

    // NEGOTIATION — a PROTOCOL the game does not have. RED 1's largest oracle
    // hole: "The two yards negotiate over the rack calendar. One side offers an
    // Early Slot or a Late Slot and the other accepts a Shared Window or a
    // Separate Window in exchange." An offer answered by an acceptance asserts
    // a sequence and a reciprocal trade; a one-shot simultaneous normal-form
    // game has neither. Same defect class as the two rules above, in vocabulary
    // they do not share — which is why it walked through both.
    //
    // THE WORD "NEGOTIATE" IS NOT THE CLAIM, and that is the whole design here.
    // It appears in 10 of 890 real draws (1.12%), always as scene-setting with
    // a correct sentence after it — "Two fishing cooperatives are negotiating
    // how to manage a shared seasonal catch quota. The North Fleet chooses
    // between Firm quota and Flexible quota, while the South Fleet
    // INDEPENDENTLY chooses…" Two parties in a negotiation who each pick a
    // stance simultaneously is exactly what this app models. Gating the word
    // would reject those ten, most of them from the cloud production path.
    // The pieces are no better on their own: bare "offer" is 1.12% of real
    // draws (a supplier "chooses between offering Bulk Flour or Specialty
    // Flour"), bare "accept" 0.22% ("chooses whether to Accept Bid or Reject
    // Bid"), and contract/deal/terms 6.18% — ordinary scenario nouns, all.
    //
    // So the rule is a CONJUNCTION, not a list: one side OFFERS *and* another
    // ACCEPTS or REJECTS. Acceptance is acceptance OF the offer, so it places
    // B's move after A's — the sequence claim, arrived at from the other side.
    // Written with lookaheads to keep it in this table with every other claim
    // rule instead of becoming a special case above the loop.
    // Measured: 0 of 890 stored draws, cloud and local.
    // The offer side covers SUBMITTING a bid and PROPOSING as well as offering,
    // because those are the same speech act and the model uses them
    // interchangeably. r2cloud#11 is the draw that forced it: "A courier company
    // chooses whether to SUBMIT a Premium Route or a Budget Route BID for a
    // delivery contract. A logistics platform chooses whether to ACCEPT BID or
    // REJECT BID." B's options are answers to A's move, which is the sequence
    // claim in the vocabulary the narrow rule did not cover. Cost of the
    // widening, measured over 1,808 draws across every corpus: that one draw.
    [/^(?=[\s\S]*\b(?:offer|propose|tender|submit)(?:s|ed|ing)?\b|[\s\S]*\bbids?\b)(?=[\s\S]*\b(?:accept|reject|decline|approve)(?:s|ed|ing)?\b)/i,
      'a claim that one player offers and the other accepts'],

    // The second half of the same claim: that this game ENDS IN AN AGREEMENT.
    // Bargaining to a binding deal is a cooperative solution concept, and the
    // app models a non-cooperative game — nothing here can bind anyone.
    // Deliberately NOT the bare noun: "a licensing agreement", "a Premium
    // Contract" name a thing in the world and are common, good output. Only
    // REACHING one, or the reciprocity that implies one, is the assertion.
    // Measured: 0 of 890. `agree on/to` and `in exchange|in return` are the
    // least certain members — both are ordinary English that could in
    // principle set a scene ("the two firms agreed on a shared calendar last
    // year"), and 890 draws of two models on one prompt cannot rule that out.
    // They are kept because a prior binding agreement between these two players
    // is itself a claim about this game, and dropped at the first real draw
    // either one costs.
    [/\b(?:reach(?:es|ed)?|strikes?|struck|settles?\s+on|settled\s+on|comes?\s+to|came\s+to)\s+(?:an?\s+)?(?:agreement|deal|terms|accord)\b|\bcome\s+to\s+terms\b|\bagree(?:s|d)?\s+(?:on|to|upon)\b|\bbinding\b|\benforceabl\w*\b|\bin\s+(?:exchange|return)\b/i,
      'a claim that the game ends in a binding agreement'],
  ];
  for (const [re, why] of CLAIMY) if (re.test(desc)) return { ok: false, reason: why };

  // TWO DISTINCT CHOOSERS. Unlike everything else in this function, these three
  // have REACH on observed output: 5 defects across 1,808 gate-passing draws
  // from every corpus this campaign holds, RED 1's newest 928 included, with
  // zero false positives (_gen/blue_w4_refine.mjs). They are the first checks
  // here that catch what the models are actually doing rather than containing a
  // channel nobody has walked.
  // META VOCABULARY. Screened over EVERY authored field, not just the
  // description: "Player A" is exactly as much a leak in the scenario name or
  // an option label, and the name is a field no screen read at all before this
  // campaign. See the block comment on META_PROMPT_CAST for the per-surface
  // rates and for the two traps this predicate is shaped around.
  const authored = ['name', 'row1', 'row2', 'col1', 'col2'] as const;
  const metaText = normalizeProseMinus([...authored.map((k) => (typeof sc[k] === 'string' ? sc[k] as string : '')), desc].join(' • '));
  const META: [RegExp | ((t: string) => boolean), string][] = [
    [META_PROMPT_CAST, "the prompt's own cast names (\"Player A\") in the story"],
    [META_BARE_LETTER, 'a bare letter standing in for a character'],
    [META_GAME_CAST, 'the game\'s cast ("the two players") named in the story'],
    [namesTheGameItself, 'the game itself named as an object in the story'],
  ];
  for (const [test, why] of META) {
    if (typeof test === 'function' ? test(metaText) : test.test(metaText)) return { ok: false, reason: why };
  }

  const STRUCTURAL: [(t: string) => boolean, string][] = [
    [oneActorTakesASecondDecision, 'a second decision given to a player who already made one'],
    [secondPairHandedToAPronoun, "a second set of options given to a pronoun when only one player is named"],
    [assertsTheSameMove, "a claim that one player's move is the same as the other's"],
  ];
  for (const [fires, why] of STRUCTURAL) if (fires(desc)) return { ok: false, reason: why };

  return { ok: true };
}

export function validateScenario(sc: SuggestedScenario, g: GamePayoffs): ScenarioValidation {
  const issues: string[] = [];
  // Same tolerance shape as checkProse: tight, the citation restates a matrix
  // number the model was handed verbatim.
  const near = (v: number, a: number) => Math.abs(a - v) <= Math.max(0.01, Math.abs(a) * 0.005);

  // Label hygiene (C11 draw 15: rows "Signal (−1/−1)" / "Signal (+1/+1)"):
  // a player's two options must be distinct once parentheticals are
  // stripped, and a payoff pair annotated inside a label must be a pair the
  // matrix actually holds for that option (its payoffs across the opponent's
  // two options, or a cell's (a, b)). "(Row 1)"-style tags carry one number
  // and are ignored.
  {
    const base = (l?: string) => (l ?? '').replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    // PRESENCE BEFORE DISTINCTNESS. Every check below asks whether two labels
    // DIFFER, and each one short-circuits on a falsy label — so a player with an
    // option that has no name at all was examined by nothing. Caught in the wild
    // (RED 1 F11): the model emitted col1 plus invented keys day1/day2, leaving
    // col2 ABSENT, and the whole gate passed it. The suggestion card then renders
    // "B: Night Work / ", and useSuggestedScenario (App.tsx) interpolates the
    // hole into what the user SAVES — "B chooses between Night Work and
    // undefined."
    //
    // The test must be falsy, not `=== ''`: the observed defect had col2
    // MISSING rather than empty, and a check written against the empty string
    // would have reported clean on the exact draw it was written for.
    //
    // OFFLINE-ONLY in practice — the cloud path sends strict structured outputs
    // with additionalProperties:false, which rejects both the missing key and
    // the invented ones. The local llama-server honours no schema, so `required`
    // is advisory there and this is the only thing standing in the way.
    for (const key of ['row1', 'row2', 'col1', 'col2'] as const) {
      const v = sc[key];
      if (typeof v !== 'string' || !v.trim()) {
        issues.push(`option label ${key} is missing — every option must be named`);
      }
    }
    if (base(sc.row1) && base(sc.row1) === base(sc.row2)) issues.push(`row labels are not distinct ("${sc.row1}" / "${sc.row2}")`);
    if (base(sc.col1) && base(sc.col1) === base(sc.col2)) issues.push(`column labels are not distinct ("${sc.col1}" / "${sc.col2}")`);
    const cells = [[g.a11, g.b11], [g.a12, g.b12], [g.a21, g.b21], [g.a22, g.b22]];
    const pairsFor = {
      row1: [...cells, [g.a11, g.a12], [g.b11, g.b12]],
      row2: [...cells, [g.a21, g.a22], [g.b21, g.b22]],
      col1: [...cells, [g.b11, g.b21], [g.a11, g.a21]],
      col2: [...cells, [g.b12, g.b22], [g.a12, g.a22]],
    } as const;
    for (const key of ['row1', 'row2', 'col1', 'col2'] as const) {
      const par = /\(([^)]*)\)/.exec(sc[key] ?? '');
      if (!par) continue;
      const nums = par[1].replace(/[−–]/g, '-').match(/[-+]?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      if (nums.length !== 2) continue;
      if (!pairsFor[key].some(([p, q]) => near(nums[0], p) && near(nums[1], q))) {
        issues.push(`label "${sc[key]}" annotates a payoff pair the matrix does not hold for that option`);
      }
    }

  }

  // A provider without strict structured outputs can hand actorA/actorB back as
  // a bare string, a number, or an array with non-string members. `?? []` guards
  // only null/undefined, so DeepSeek-V4-Flash's non-array actorA threw
  // "(list ?? []).map is not a function" and took down the WHOLE gate mid-battery
  // (row 12 of 40) — the exact failure mode the storyClaims guards below exist to
  // prevent, surviving one field over. A malformed shape must fail the scenario,
  // never throw.
  const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const actorShapeBad = (v: unknown) => v != null && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'));
  if (actorShapeBad(sc.actorA) || actorShapeBad(sc.actorB)) {
    issues.push('actorA/actorB is not an array of strings — malformed declaration shape');
  }

  const claims = sc.storyClaims ?? null;
  // Same shape guards as validateProseClaims: a provider without strict
  // structured outputs can hand these back as non-arrays, and the gate must
  // fail, not throw.
  const citationList = Array.isArray(claims?.cellCitations) ? claims.cellCitations : null;
  const storyReplyList = Array.isArray(claims?.bestReplies) ? claims.bestReplies : null;
  if (claims && (citationList === null || storyReplyList === null)) {
    issues.push('storyClaims fields are not arrays — malformed declaration shape');
  }
  if (claims) {
    for (const c of citationList ?? []) {
      if (!isOpt12(c.row) || !isOpt12(c.col)) {
        issues.push(`citation names cell (Row ${c.row}, Col ${c.col}), which does not exist`);
        continue;
      }
      if (!Number.isFinite(c.a) || !Number.isFinite(c.b) || !near(c.a, cellAOf(g, c.row, c.col)) || !near(c.b, cellBOf(g, c.row, c.col))) {
        issues.push(
          `story says cell (Row ${c.row}, Col ${c.col}) pays (${c.a}, ${c.b}); the matrix says (${cellAOf(g, c.row, c.col)}, ${cellBOf(g, c.row, c.col)})`,
        );
      }
    }
    issues.push(...bestReplyIssues(storyReplyList ?? [], g, 'story'));
  }

  // Undeclared-citation guard: any payoff-anchored number in the description
  // ("A=9", "E[B]≈3") must be covered by a declared citation, otherwise the
  // declaration rule was skipped and nothing above ever looked at that claim.
  const declared = (citationList ?? []).flatMap((c) => [c.a, c.b]);
  const desc = normalizeProseMinus(sc.description ?? '');

  // An option attributed to the player who does not own it: "the gatekeeper
  // chooses Ford River", where Ford River is A's row (round L8 draw 68, and
  // 3 of 49 prose draws in L9 — 6.1%, one of them in the seeded stream). It is
  // only decidable once the ROLE NOUNS are mapped to players, which is why the
  // prompt now requires actorA/actorB; with no actors declared this check
  // simply does not run, so it can never regress a story that omits them.
  {
    const roles = (list: unknown, other: unknown) =>
      strList(list).map((x) => x.trim().toLowerCase()).filter((x) => x.length > 2 && !strList(other).map((y) => y.trim().toLowerCase()).includes(x));
    const aRoles = roles(sc.actorA, sc.actorB), bRoles = roles(sc.actorB, sc.actorA);
    const ownLabels = { A: [sc.row1, sc.row2], B: [sc.col1, sc.col2] } as const;
    if (aRoles.length && bRoles.length) {
      const VERB = String.raw`(?:choos\w*|us\w*|play\w*|pick\w*|select\w*|takes?|hunts?|opts?\s+for|goes?\s+(?:with|for))`;
      for (const [who, myRoles] of [['A', aRoles], ['B', bRoles]] as const) {
        const theirs = ownLabels[who === 'A' ? 'B' : 'A'];
        for (const role of myRoles) {
          const re = new RegExp(String.raw`\b(?:the\s+)?${escapeRe(role)}\s+${VERB}\s+(?:the\s+|an?\s+)?([\w' -]{2,40}?)\s*(?=[,.;]|\band\b|\bwhile\b|$)`, 'gi');
          for (const m of desc.matchAll(re)) {
            const named = m[1].trim();
            const isTheirs = theirs.some((l) => l && new RegExp(`^(?:${labelPattern(l)})$`, 'i').test(named));
            const isMine = ownLabels[who].some((l) => l && new RegExp(`^(?:${labelPattern(l)})$`, 'i').test(named));
            if (isTheirs && !isMine) {
              issues.push(`description has ${role} (player ${who}) choosing "${named}", which is player ${who === 'A' ? 'B' : 'A'}'s option`);
            }
          }
        }
      }
    }
  }


  // THE LETTER FORM of the same misattribution (RED 1 F12).
  //
  // The check above only ever fires on ROLE NOUNS, by construction — it exists
  // for descriptions that name the players as "the gatekeeper" INSTEAD of as A
  // and B, and it is gated on actorA/actorB being declared. The letter form was
  // left unscreened because it was assumed unambiguous, and that assumption was
  // measured rather than argued ("when the model names the letters it gets the
  // mapping right") until a counterexample turned up: "Player A chooses when to
  // release water", where Release Water is B's column.
  //
  // Two reasons this is worth screening where the role-noun version struggles.
  // "Player A" is an unambiguous token, so there is no actor mapping and no
  // dependence on actorA/actorB — fields the cloud schema forbids, which is why
  // the check above has never executed on a model-invented scenario. And the
  // lookup is the same shape the file already trusts elsewhere: does the option
  // named next belong to the other player?
  //
  // ANCHORING IS THE WHOLE DIFFICULTY. "An orchard manager, Player A, chooses
  // between Early Harvest and Late Harvest" is CORRECT prose and appears in most
  // letter-using draws, so the screen must key on a letter ADJACENT to a
  // choosing verb and then on the option actually named — never on the letters
  // appearing somewhere in the sentence. The enumerating form ("chooses between
  // X and Y") is skipped outright: it names both of that player's own options
  // and is the shape correct prose takes.
  {
    const LETTER_VERB = String.raw`(?:choos\w*|us\w*|play\w*|pick\w*|select\w*|takes?|opts?\s+for|goes?\s+(?:with|for))`;
    const ownLabels = { A: [sc.row1, sc.row2], B: [sc.col1, sc.col2] } as const;
    const re = new RegExp(
      String.raw`\b(?:player\s+)?([AB])\b\s+${LETTER_VERB}\s+(?:when\s+to\s+|whether\s+to\s+|how\s+to\s+|to\s+)?(?:the\s+|an?\s+)?([\w' -]{2,40}?)\s*(?=[,.;]|\band\b|\bwhile\b|\bwith\b|$)`,
      'g',
    );
    for (const m of desc.matchAll(re)) {
      const who = m[1] as 'A' | 'B';
      const named = m[2].trim();
      // "between X and Y" enumerates that player's OWN pair — the correct form.
      if (/^between\b/i.test(named)) continue;
      const theirs = ownLabels[who === 'A' ? 'B' : 'A'];
      const isTheirs = theirs.some((l) => l && new RegExp(`^(?:${labelPattern(l)})$`, 'i').test(named));
      const isMine = ownLabels[who].some((l) => l && new RegExp(`^(?:${labelPattern(l)})$`, 'i').test(named));
      if (isTheirs && !isMine) {
        issues.push(`description has Player ${who} choosing "${named}", which is player ${who === 'A' ? 'B' : 'A'}'s option`);
      }
    }
  }

  // Wordless outcome talk: a CONDITIONAL sentence attributing gain/loss to a
  // specific action combination, in a digit-free description with no declared
  // best-reply claims, is invisible to every check above — the live "the
  // quitter loses and the cooperator gains" inversion (a moral prior imported
  // over the actual numbers) rode exactly this shape. Unverifiable is treated
  // as unshowable; the server's retry usually lands a compliant draw. Kept
  // deliberately narrow — conditional frame AND outcome verb AND no digits
  // AND empty bestReplies — so zero-sum framing sentences ("what hurts A
  // helps B") and any story that quantifies itself never trip it.
  const OUTCOME_TALK = /\b(?:if|when|while|unless|whenever)\b[^.!?]{0,140}?\b(?:pays? off|loses?|gains?|wins?|profits?|suffers?|is (?:punished|rewarded|costly|cheap|expensive|harmful|beneficial|wasted|worthwhile))\b|\b(?:is|are)\s+(?:costly|cheap|expensive|harmful|beneficial|wasted|worthwhile)\s+(?:unless|if|when|whenever)\b/i;
  // Outcome ATTRIBUTION screen (C1 draw 17 "mismatches hurt both", C1 draw 53
  // "advertising is costly unless B inspects", C3 draw 4 "both receive the
  // smaller mutual payoff", C3 draw 53 "if both align, one side gains while
  // the other loses"): a sentence that attributes an outcome to a specific
  // action combination in words, with no number in it, is unverifiable by any
  // declaration — declarations carry numbers and best replies, not adjectives.
  // Withheld regardless of storyClaims. Option-label words are not outcome
  // words ("Lower Pass"); a sentence with a digit quantifies itself.
  {
    const ATTR_FRAME = /\b(?:if|when|whenever|unless|once|should|mismatch\w*|match\w*|coordinat\w*|align\w*|both\s+(?:choose|pick|play|go|opt|select)|(?:the\s+)?(?:same|opposite|different)\s+(?:choice|option|move|action|route|plan)s?)\b/i;
    const ATTR_OUT = /\b(?:gains?|loses?|losing|hurts?|harms?|suffers?|is\s+(?:costly|cheap|expensive|punished|rewarded|wasted)|costly|favou?rable|unfavou?rable|better\s+off|worse\s+off|the\s+(?:smaller|larger|lower|higher|bigger|biggest|smallest|best|worst)\s+(?:mutual\s+)?(?:payoffs?|outcomes?|returns?|rewards?)|pays?\s+off|wins?|zero\s+for)\b/i;
    const labelWords = new Set([sc.row1, sc.row2, sc.col1, sc.col2].flatMap((l) => (l ?? '').toLowerCase().split(/\s+/)));
    for (const sentence of desc.split(/(?<=[.!?])\s+|;\s+/)) {
      if (/\d/.test(sentence) || !ATTR_FRAME.test(sentence)) continue;
      const m = ATTR_OUT.exec(sentence);
      if (!m || labelWords.has(m[0].toLowerCase().split(/\s+/)[0])) continue;
      issues.push(`description attributes an outcome in words ("${sentence.trim().slice(0, 80)}…") without numbers — unverifiable`);
      break;
    }
  }
  if (OUTCOME_TALK.test(desc) && !/\d/.test(desc) && (storyReplyList ?? []).length === 0) {
    issues.push(
      'description attributes gains/losses to an action combination without numbers or declared best-reply claims — unverifiable',
    );
  }
  // Dependence framing: "how B should respond depends on A" / "each player's
  // better response depends on what the other does" is false for a player
  // with a dominant strategy (C4 draws 14/44 on qual-punish and the PD).
  {
    const domA = (g.a11 > g.a21 && g.a12 > g.a22) || (g.a21 > g.a11 && g.a22 > g.a12);
    const domB = (g.b11 > g.b12 && g.b21 > g.b22) || (g.b12 > g.b11 && g.b22 > g.b21);
    const DEP = String.raw`(?:depends|hinges|turns|responds|reacts|adapts)\s+(?:on|to|with)|(?:shifts?|changes?|varies|flips?)\s+(?:with|depending)`;
    const EACH = new RegExp(String.raw`\b(?:each|both|either)\s+(?:player|side|firm|party|agent)['’]?s?\s+["“”']?(?:best|better|optimal|preferred)\s+(?:response|reply|choice|move|option|action)["“”']?\s+(?:${DEP})\b`, 'i');
    // "A's best choice responds to what B does" / "which grain the miller should prefer shifts with…" — per player.
    // Stories name roles, not letters ("the analyst's best response depends on
    // what the manager does" — C12 draw 52). actorA/actorB are the nouns the
    // model declared for this scenario; a noun claimed by both sides is dropped.
    // The story usually introduces its own roles ("Player A is a junior analyst
    // choosing whether to …"); scenarioOnly draws carry no actor arrays at all
    // (C12 draw 52), so the mapping is read out of the description as well.
    const introduced: Record<'A' | 'B', string[]> = { A: [], B: [] };
    for (const m of desc.matchAll(/\b(?:player\s+)?([AB])\b\s+(?:is|plays|acts\s+as|represents)\s+(?:an?|the)\s+([A-Za-z][A-Za-z' -]{2,40}?)(?=[,.;:]|\s+(?:who|whose|which|that|choosing|deciding|selecting|and|with|in|at|for|weighing)\b)/g)) {
      const words = m[2].trim().toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      if (words.length) introduced[m[1] as 'A' | 'B'].push(words[words.length - 1], m[2].trim().toLowerCase());
    }
    const nounsA = [...strList(sc.actorA), ...introduced.A].map((x) => x.trim().toLowerCase()).filter((x) => x.length > 2);
    const nounsB = [...strList(sc.actorB), ...introduced.B].map((x) => x.trim().toLowerCase()).filter((x) => x.length > 2);
    const who = (p: 'A' | 'B') => {
      const own = p === 'A' ? nounsA : nounsB, other = p === 'A' ? nounsB : nounsA;
      return [p, ...own.filter((n) => !other.includes(n))].map(escapeRe).join('|');
    };
    const PL = (p: 'A' | 'B') => new RegExp(String.raw`\b(?:player\s+|the\s+)?(?:${who(p)})['’]s\s+["“”']?(?:best|better|optimal|preferred)\s+(?:response|reply|choice|move|option|action)["“”']?\s+(?:${DEP})\b|\b(?:how|what|whether|which)\b[^.;]{0,40}?\b(?:player\s+|the\s+)?(?:${who(p)})\s+(?:should\s+)?(?:respond|reply|choose|play|prefer|do)\b|\b(?:shifts?|changes?|alters?|determines?)\s+which\b[^.;]{0,40}?\b(?:player\s+|the\s+)?(?:${who(p)})\b|\bwhich\s+of\s+(?:player\s+|the\s+)?(?:${who(p)})['’]s\s+(?:actions?|options?|moves?|choices?)\s+(?:is|are)\s+(?:best|better|optimal)\b`, 'i');
    const NEG = /\b(?:does\s+not|doesn['’]t|never|regardless|no\s+matter|whatever|independent|dominant)\b/i;
    const sentencesD = desc.split(/(?<=[.!?])\s+|;\s+/);
    for (const sent of sentencesD) {
      if (NEG.test(sent)) continue;
      if (EACH.test(sent) && (domA || domB)) { issues.push(`description says each player's best response depends on the other, but ${domA ? 'A' : 'B'} has a dominant strategy`); break; }
      if (domB && PL('B').test(sent) && /\b(?:affects?|changes?|determines?|shapes?|depends|responds|shifts?|reacts)\b/i.test(sent)) { issues.push("description says B's response depends on A's choice, but B has a dominant strategy"); break; }
      if (domA && PL('A').test(sent) && /\b(?:affects?|changes?|determines?|shapes?|depends|responds|shifts?|reacts)\b/i.test(sent)) { issues.push("description says A's response depends on B's choice, but A has a dominant strategy"); break; }
    }
  }
  // Game-shape framing: a description that casts the game as COORDINATION
  // ("incentive to match the opponent's choice", "both want to coordinate")
  // must describe a game whose pure equilibria actually sit on matching or
  // mismatching pairs (two pure NE, both diagonal or both anti-diagonal). C2
  // draw 5 put a coordination template on the Prisoner's Dilemma.
  {
    const pure = computeAllNE(g).filter((t) => t.type === 'pure');
    const diag = pure.filter((t) => (t.x === 1 && t.y === 1) || (t.x === 0 && t.y === 0)).length;
    const anti = pure.filter((t) => (t.x === 1 && t.y === 0) || (t.x === 0 && t.y === 1)).length;
    // THE OR WAS THE HOLE (RED 1 F1). This read `diag === pure.length || anti
    // === pure.length`, which conflates two different questions: "does this game
    // have a matching-or-mismatching structure?" and "is MATCHING language true
    // here?". On a game whose every pure equilibrium is a MISMATCH the first is
    // yes and the second is no — and the `||` made the screen skip exactly those
    // games. "Both cooperatives want to match the opponent's choice" passed the
    // gate clean on A=[[0,3],[2,0]] B=[[0,2],[3,0]].
    //
    // Matching language is warranted only when the matching diagonal IS the
    // whole pure equilibrium set, which is the precise mirror of the
    // anti-coordination screen below — that one already fires only when
    // `diag === pure.length`. Restoring the symmetry is the entire fix.
    //
    // This can only WIDEN the screen onto all-mismatch games, where matching
    // language is false by construction, so it adds no false positive: every
    // other game reaches the same verdict it did before.
    const matchingShape = pure.length >= 2 && diag === pure.length;
    const COORD_TALK = /\b(?:(?:incentive|reason|want|wants|try|tries|aim|aims|prefer|prefers)\s+to\s+(?:match|coordinate|mirror|align\s+with|copy|imitate)|coordinat(?:e|ion)\s+(?:game|problem)|match(?:ing)?\s+(?:the\s+)?(?:opponent|other)['’]?s?\s+(?:likely\s+)?(?:choice|move|action|pick))\b/i;
    const NEGATED = /\b(?:no|not|never|little|without|rather\s+than)\s+(?:\w+\s+){0,2}(?:incentive|reason|want|need)/i;
    // THE ABSTRACT-PLAYER FORM of the same false claim.
    //
    // COORD_TALK's vocabulary requires "want/incentive to coordinate",
    // "coordination game/problem", or "matching the opponent's choice". The
    // local model writes none of those — RED 1 measured COORD_TALK against 341
    // real gate-passing draws and it matched ZERO. What the model actually
    // writes is "the two players coordinate their choices", which asserts the
    // same thing and was entirely unscreened.
    //
    // THE DISCRIMINATOR IS THE SUBJECT, NOT THE VERB, and that distinction is
    // the whole reason this is shippable. Gating on "coordinate" itself has
    // 11.9% precision — eight correct scenarios rejected per defect caught, and
    // 7.6% of local draws rejected merely for containing the JOB TITLE
    // "coordinator". Now that rewriting model output is closed and gates are the
    // only instrument left, a blunt gate is the one way to make the product
    // worse while trying to improve it.
    //
    // Measured on the corpus: every genuine claim carries an ABSTRACT-PLAYER
    // subject ("the two players", "the two institutions"); not one of the 38
    // vacuous uses does — those name real actors or use "coordinating" as a
    // purpose adjunct. So the rule keys on a game-theoretic subject noun, never
    // on a story noun: "cooperatives", "firms" and "operators" are deliberately
    // NOT in the list, because those are what a scenario legitimately calls its
    // characters.
    //
    // THE SUBJECT MUST GOVERN THE VERB, not merely precede it. A proximity
    // window ("subject … within 80 characters … coordinat") reads the flat
    // ACTIVITY form as a claim whenever an abstract subject happens to sit in
    // front of it: measured false positive rt2#129, "The two players are
    // choosing how their shared grid will respond to a COORDINATED demand
    // period" — the players' verb there is "are choosing", and "coordinated"
    // modifies a noun in the world. So the bridge between subject and verb is
    // a CLOSED GRAMMATICAL CLASS (auxiliaries, modals, adverbs, and verbs of
    // intention), never arbitrary text. Any bridge with its own clause breaks
    // subject-hood and the screen stays silent.
    //
    // Three licensed forms, and nothing else:
    //   1  the two players (aux)* coordinate | are coordinating
    //   2  the two players (aux)* PLAN/AGREE/WANT (to|how|on)* coordinate
    //   3  the two players (aux)* PLAN a|their COORDINATED <noun>
    // Form 3 needs a verb of intention before the determiner precisely so that
    // "the two players are THE COORDINATING body" cannot reach it.
    //
    // "coordinator"/"coordinators" is unreachable by construction: the verb
    // alternation ends at (e|es|ing) and the participle at "coordinated", so
    // the job title matches nothing. That is what keeps the 7.6% job-title
    // rejection rate off this check.
    const ABSTRACT_PLAYER = String.raw`(?:the\s+two|both)\s+(?:players?|parties|sides|institutions?|participants?|agents?|actors?)`;
    const AUX = String.raw`(?:will|would|shall|should|must|can|could|may|might|are|is|were|was|also|then|now|still|already|simply|jointly|closely|each|both)`;
    const INTENT = String.raw`(?:plans?|planning|try|tries|trying|aims?|aiming|seeks?|seeking|agrees?|agreeing|wants?|needs?|hopes?|hoping|intends?|attempts?|attempting|prepares?|preparing|arranges?|arranging|decides?|deciding|chooses?|choosing|works?|working)`;
    const CO_VERB = String.raw`coordinat(?:e|es|ing)\b`;
    const CO_PART = String.raw`coordinated\b`;
    const ABSTRACT_COORD = new RegExp(
      String.raw`\b${ABSTRACT_PLAYER}(?:\s+${AUX})*(?:\s+${CO_VERB}|(?:\s+${INTENT})(?:\s+(?:to|how|on|whether))*(?:\s+${CO_VERB}|\s+(?:a|an|the|their)\s+${CO_PART}))`, 'i');
    // A WEAKER CLAIM FALSIFIED BY A WEAKER CONDITION. "Both want to coordinate"
    // (COORD_TALK, below) asserts the game IS a coordination game, which needs
    // two matching equilibria to be true. "The two players coordinate their
    // choices" asserts only that agreeing is what equilibrium play produces —
    // true as soon as ANY pure equilibrium sits on a matching pair. So this
    // screen fires only when NONE does, which is strictly narrower than
    // `!matchingShape` and keeps the issue string literally true of the game.
    // Deliberately narrower: on the 635-draw corpus `!matchingShape` would also
    // have rejected three scenarios whose single pure equilibrium IS a matching
    // pair, under an issue string that was false about those games.
    if (diag === 0 && ABSTRACT_COORD.test(desc) && !NEGATED.test(desc)) {
      issues.push('description says the two players coordinate their choices, but no pure equilibrium of this game sits on a matching pair');
    }
    if (!matchingShape && COORD_TALK.test(desc) && !NEGATED.test(desc)) {
      // The wording had to change with the predicate. It used to read "do not
      // sit on matching OR MISMATCHING pairs", which was true of the old
      // `||` condition and is now false of the commonest case this screen
      // catches — an all-MISMATCH game, whose equilibria do sit on mismatching
      // pairs. An issue string is a claim about the game like any other.
      issues.push('description frames the game as coordination (matching the opponent), but its pure equilibria do not all sit on matching pairs');
    }
    // The mirror case (C13 draw 25): a pure COORDINATION game — every pure
    // equilibrium on the matching diagonal — described as one where you want
    // to counter or avoid the opponent's choice. The original screen exits as
    // soon as the game is coordination-shaped, so this framing had no check at
    // all. Only fired when the matching diagonal is the WHOLE equilibrium set,
    // so games that genuinely reward mismatching somewhere are untouched.
    const ANTI_TALK = /\b(?:(?:incentive|reason|want|wants|need|needs|try|tries|prefer|prefers|better|best)\s+to\s+(?:counter|mismatch|differ|avoid\s+match\w*|do\s+the\s+opposite|choose\s+the\s+opposite|go\s+the\s+other\s+way|pick\s+differently)|anti[- ]coordination|(?:want|wants|prefer|prefers)\s+(?:to\s+)?(?:the\s+)?opposite\b|avoid\s+(?:matching|the\s+same)\b)/i;
    if (pure.length >= 2 && diag === pure.length && ANTI_TALK.test(desc) && !NEGATED.test(desc)) {
      issues.push('description frames the game as anti-coordination (countering the opponent), but every pure equilibrium sits on a matching pair');
    }
  }

  // INTEREST ALIGNMENT, which is a different question from equilibrium shape.
  // The rules above ask where the equilibria SIT; these ask whether the two
  // players' interests are aligned or opposed, and the matrix answers that
  // EXACTLY — no tolerance, no equilibrium computation, nothing to tune:
  //
  //   constant-sum   a+b is the same in all four cells: one side's gain is
  //                  precisely the other's loss, in every outcome.
  //   common interest a == b in every cell: the two never disagree about
  //                  anything, so there is nothing to compete over.
  //   flat           a player's payoff does not move with the opponent's
  //                  column at all, so that opponent cannot affect it.
  //
  // That exactness is what makes these shippable: the screens CANNOT fire on an
  // ordinary matrix however the sentence is worded, so the false-positive risk
  // is bounded by the matrix rather than by the vocabulary. Measured reach on
  // 890 stored draws: 0 for all three. (The corpus is if anything pessimistic —
  // 382 of its 890 games are constant-sum, because the adversarial stakes
  // corpora are matching-pennies-shaped. Real user matrices are far less often
  // exactly constant-sum, so these fire even less in production.)
  {
    const near0 = (x: number, y: number) => Math.abs(x - y) < 1e-9;
    // Negation guard. The NEGATED constant above is scoped to
    // incentive/reason/want/need and does not reach this vocabulary, so these
    // rules carry their own.
    //
    // Scoped to the phrase's OWN CLAUSE, not the paragraph and not a fixed
    // character window. A blanket scan switches the rule off whenever any "not"
    // appears anywhere; a fixed window reaches back across the full stop into
    // the previous sentence, which is the same bug in miniature \u2014 the unit test
    // caught exactly that, on "The display is not yet booked. A store and a
    // restorer work together toward the same goal." Negation binds inside its
    // clause, so the lookback stops at the last sentence or clause break.
    const negatedBefore = (re: RegExp) => {
      const m = re.exec(desc);
      if (!m) return false;
      const before = desc.slice(0, m.index);
      const cut = Math.max(before.lastIndexOf('.'), before.lastIndexOf(';'), before.lastIndexOf('!'), before.lastIndexOf('?'));
      const clause = before.slice(cut + 1).slice(-60);
      return /\b(?:no|not|never|neither|nor|without|rather\s+than|far\s+from|cannot)\b|n['\u2019]t\b/i.test(clause);
    };
    const k = g.a11 + g.b11;
    const constantSum = near0(g.a12 + g.b12, k) && near0(g.a21 + g.b21, k) && near0(g.a22 + g.b22, k);
    const commonInterest = near0(g.a11, g.b11) && near0(g.a12, g.b12)
      && near0(g.a21, g.b21) && near0(g.a22, g.b22);
    const aFlat = near0(g.a11, g.a12) && near0(g.a21, g.a22);
    const bFlat = near0(g.b11, g.b21) && near0(g.b12, g.b22);

    // A SHARED GOAL, asserted on a game where the payoffs are exactly opposed.
    // Deliberately NOT the word "coordinating", which is the trap here: 103 of
    // 890 real draws pair some form of "coordinat*" with a constant-sum matrix
    // (38 with the tight "are coordinating" form), and they read as perfectly
    // good output — "An antique store and a restoration company are
    // coordinating a new display", then two independent choices. Parties who
    // cooperate on an activity while competing over its terms are ordinary, and
    // the corpus cannot separate them from RED 1's probe, which has the same
    // shape. So that arm is LEFT OPEN, priced, rather than shipped at a 4-12%
    // cost. What is gated is only the assertion of a shared PAYOFF interest,
    // which constant-sum refutes outright.
    const SHARED_GOAL = /\b(?:work(?:s|ing)?\s+together|the\s+same\s+goal|an?\s+shared\s+goal|common\s+goal|mutual\s+benefit|both\s+benefit|jointly\s+benefit|shared\s+interests?|same\s+interests?|for\s+their\s+mutual\b)/i;
    if (constantSum && !commonInterest && SHARED_GOAL.test(desc) && !negatedBefore(SHARED_GOAL)) {
      issues.push('description says the two players share a goal, but the matrix is constant-sum: one player gains exactly what the other loses in every outcome');
    }

    // The mirror: rivalry asserted where the two players' payoffs are IDENTICAL
    // in every cell, so they never disagree about anything and there is nothing
    // to win from each other. `competing/rival/contest` alone is 1.57% of real
    // draws and legitimate almost everywhere — it is the common-interest matrix
    // that makes it false, and that matrix holds in 76 of 890.
    // `rivals` only as a PREDICATE NOUN ("the two are rivals"), never
    // attributively. The first version had a bare `rivals?\b` and RED 1's newer
    // corpus caught it rejecting two real draws — "B is a RIVAL fisherman
    // choosing between Open Fish and Keep Fish" and "A RIVAL event
    // coordinator…". There the word names WHO THE ACTOR IS, exactly the
    // job-title-is-not-a-claim lesson the F1 screen above is built on, and
    // which this file's own comment warned about two rules earlier. Two rival
    // firms can face a decision where their interests happen to align
    // perfectly; that is a coherent scene, not a false statement about the
    // game. Every other member already requires a preposition or an object for
    // the same reason ("competing FOR", "fight OVER"), so only this one leaked.
    const RIVALRY = /\b(?:fight(?:s|ing)?\s+(?:for|over)|compet(?:e|es|ing)\s+(?:for|over|against)|are\s+rivals\b|\brivalry\b|battl(?:e|es|ing)\s+(?:for|over)|outbid|beat\s+the\s+other|at\s+odds\b|opposed\s+interests|conflicting\s+interests)/i;
    if (commonInterest && RIVALRY.test(desc) && !negatedBefore(RIVALRY)) {
      issues.push('description frames the two players as rivals, but their payoffs are identical in every cell: they never disagree about any outcome');
    }

    // "B's decision determines A's outcome" where A's payoff is the same in
    // both of B's columns. The dominant-strategy rules above catch a related
    // claim, but only when a player HAS a dominant strategy; a flat payoff row
    // is a different and stronger fact. Kept narrow: it needs an outcome noun
    // AND a determining verb, so the corpus's constant "their choices determine
    // the payoffs" closer — true wherever both players' payoffs vary — is
    // untouched, and is asserted as a control.
    const DETERMINES = /\b(?:determines?|dictates?|drives?|controls?|sets?)\b[^.;]{0,40}?\b(?:outcome|payoff|return|result|position)\b|\b(?:outcome|payoff|return|result)\b[^.;]{0,30}?\b(?:is|are)\s+determined\s+by\b/i;
    if ((aFlat || bFlat) && DETERMINES.test(desc) && !negatedBefore(DETERMINES)) {
      const who = aFlat ? 'A' : 'B';
      issues.push(`description says one player's choice determines the outcome, but ${who}'s payoff is the same whichever option the opponent takes`);
    }
  }
  for (const m of desc.matchAll(/(?:\bE\[[AB]\]|\b[AB])\s*[=≈≃~]\s*(-?\d+(?:\.\d+)?)/g)) {
    const v = Number(m[1]);
    if (!Number.isFinite(v)) continue;
    if (!declared.some((a) => Math.abs(a - v) <= Math.max(0.05, Math.abs(a) * 0.02))) {
      issues.push(`description cites ${m[0].replace(/\s+/g, ' ')} but no declared cellCitation covers it`);
    }
  }
  // Payoff-like numbers attached to an outcome verb ("gets only 2", "receives
  // 7", "earns -3") are citations too — C2 draw 18 said "B gets … only 2 when
  // Inspect meets Publicize" (cell pays 0) with storyClaims null. Probabilities
  // and dimensions ("2x2", "0.5") are not payoffs and are skipped.
  for (const m of desc.matchAll(/\b(?:gets?|receives?|earns?|pays?|scores?|collects?|nets?|loses?)\b[^.;\d−–-]{0,25}?([-−–]?\d+)(?![.\d×x%])/gi)) {
    const v = Number(m[1]);   // already normalised at the entry point
    if (!Number.isFinite(v)) continue;
    const allCells = [g.a11, g.a12, g.a21, g.a22, g.b11, g.b12, g.b21, g.b22];
    if (!declared.some((a) => Math.abs(a - v) <= 1e-9) && !(declared.length === 0 && allCells.some((a) => Math.abs(a - v) <= 1e-9) && false)) {
      issues.push(`description says a player ${m[0].trim().split(/\s+/)[0]} ${v} but no declared cellCitation covers ${v}`);
    }
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Checks the PROSE's declared action-level claims against the solver.
 *
 * Closes the F2 finding: prose whose every number validated could still name
 * the wrong action beside a correct coordinate ("B plays Silent with
 * probability 1 (y=0)" when y=0 is the other column, observed live). Which
 * label a sentence names is a semantic judgement, so — as with storyClaims
 * and geometryClaims — the model declares the option INDEX it means and the
 * check is a lookup: an equilibriumAction (player, option) is true iff some
 * equilibrium gives that option positive probability (x is A's probability
 * of Row 1, y is B's of Col 1), and bestReplies use the same shared
 * comparison as the scenario gate.
 *
 * Kept OUTSIDE validateReport for the same reasons as validateScenario: the
 * eval's consistency metric must not shift, and the server decides the
 * consequence (retry once, then withhold the prose). Skipped on degenerate
 * games, where the continuum makes "the equilibrium action" ill-posed —
 * mirroring checkProse's coordinate skip.
 *
 * Residual (stated honestly): the gate catches a model that consistently
 * BELIEVES the wrong mapping (it declares what it wrote, the lookup fails —
 * the observed failure mode). A model that declares correctly while wording
 * the prose wrongly slips through; that mismatch is the semantic gap no
 * declared-claims design can close.
 */
export function validateProseClaims(
  claims: ProseActionClaims | null,
  rawProse: string,
  g: GamePayoffs,
  truth: NashEquilibrium[],
  degenerate: boolean,
  labels?: OptionLabels | null,
): ScenarioValidation {
  // ONE normalisation, here, for every check below. Deciding this per regex gave
  // seven sites seven different ideas of what a minus is, and the validators
  // failed in BOTH directions: three checks missed 100% of false claims written
  // with any unicode minus (measured 400/400 across 5 spellings), while the
  // comparative check, whose class omits U+2014/U+FF0D/U+2010, read "\u20144" as 4
  // and flagged 35% of TRUE claims as false. normalizeProseMinus explains why the
  // prose rule is deliberately narrower than the numeric-field one.
  const prose = normalizeProseMinus(rawProse);
  const issues: string[] = [];

  // Shape guards, not just null guards: a provider without strict structured
  // outputs (probed live with Phi-4) can return these fields as non-arrays,
  // and a crashed validator would 500 the route instead of failing the gate.
  const actionList = Array.isArray(claims?.equilibriumActions) ? claims.equilibriumActions : null;
  const replyList = Array.isArray(claims?.bestReplies) ? claims.bestReplies : null;
  if (claims && (actionList === null || replyList === null)) {
    issues.push('proseClaims fields are not arrays — malformed declaration shape');
  }

  // Undeclared-comparison screen — the dual of the scenario's wordless-
  // outcome screen, and the missing-declaration half of the declaration-
  // fidelity pair: a plain-BoS draw was SHOWN saying "B wants Tone 2 against
  // A's Talk" (both directions inverted) because proseClaims was null and a
  // null declaration passes vacuously. A sentence that pairs a preference
  // verb with an opponent frame IS a better-against claim; with no declared
  // bestReplies at all there is nothing to check it against, so it is
  // withheld as unverifiable (server retry as recovery). Exemption is any
  // non-empty bestReplies — partial coverage can't be mapped sentence-to-
  // entry, and the declared-set path is where compliance already lives.
  // With option labels available, a comparison the direction check can parse
  // and verify is no longer "unverifiable" — the screen only fires when the
  // label-aware parser found nothing to check (C6 draw 26: four true
  // conditional preferences withheld because bestReplies was empty).
  // With labels the label-aware parser is the judge of comparisons; the
  // screen is the pre-parser stopgap and only applies when labels are absent
  // (C7 draw 22: a true "tradeoff … depending on how much weight B puts on
  // Col 1" sentence withheld by the screen with nothing for the parser to read).
  if (labels && prose) issues.push(...validateProseDirections(prose, labels, g));
  if ((replyList ?? []).length === 0 && prose && !labels) {
    const VERB = /\b(?:prefers?|wants?|favou?rs?|does\s+(?:best|better)|works\s+(?:best|better)|best\s+(?:response|reply|move|option)|best\s+off|better\s+off)\b/i;
    const FRAME = /\b(?:against|versus|vs\.?|when\s+(?:the\s+opponent|[AB])\b|if\s+(?:the\s+opponent|[AB])\b|no\s+matter\s+(?:what|whether|which))\b/i;
    for (const sentence of prose.split(/(?<=[.!?])\s+/)) {
      if (VERB.test(sentence) && FRAME.test(sentence)) {
        issues.push(
          `prose makes a better-against claim ("${sentence.trim().slice(0, 90)}…") but declares no bestReplies — unverifiable`,
        );
        break;
      }
    }
  }

  // Statements the declared claims cannot carry, read from the prose itself.
  if (prose) {
    // "There is no pure equilibrium" on a game that has one (L2 case 31,
    // a fully-indifferent player: the continuum's corners ARE pure equilibria).
    if (/\b(?:no|without\s+(?:a|any))\s+pure(?:-strategy)?\s+(?:nash\s+)?equilibri(?:um|a)\b|\bhas\s+no\s+pure\b/i.test(prose)
      && truth.some((t) => t.type === 'pure')) {
      issues.push(`prose says there is no pure equilibrium, but the solver lists ${truth.filter((t) => t.type === 'pure').length}`);
    }
    // "gives both A and B a payoff of 1" — a joint payoff statement must name
    // a cell where both players actually receive that value (L2 case 9).
    // TWO false-positive sources, both measured: this check flagged 21 of the
    // 4,462 training golds and produced L15's only correct-withheld.
    //  (a) "both" often binds the ACTION, not the payoff, and the sentence then
    //      goes on to give the two payoffs SEPARATELY: "the corner where A and B
    //      both choose Automate, giving payoffs 3 and 9" was read as "both
    //      receive 3". So if a DIFFERENT figure follows in the same clause, the
    //      sentence is stating a pair, not a joint value — not this check's business.
    //  (b) the unicode minus again: "giving payoffs of −1 and −5" (L15) captured
    //      1 rather than −1, because U+2212 is not the ASCII hyphen the pattern
    //      expects and passes straight through the gap class. Normalise first.
    const flat = prose.replace(/[\u2212\u2013\u2012\u2014]/g, '-');
    for (const m of flat.matchAll(/\b(?:both|each)\b[^.;]{0,60}?\b(?:payoffs?|receives?|gets?|earns?)\b[^.;\d-]{0,20}?(-?\d+(?:\.\d+)?)/gi)) {
      const v = Number(m[1]);
      if (!Number.isFinite(v)) continue;
      //  (d) the figure belongs to an OPTION NAME, not to a payoff: "for both of
      //      B's possible columns, A gets a higher payoff by choosing Row 2 over
      //      Row 1" and "A and B both get pinned to Row 2 and Col 2" both had
      //      the 2 of "Row 2" read as a joint payoff (2 of nano's 213 rows —
      //      a 0.94% correct-withheld). Guard (a) cannot see these: in the
      //      second, BOTH figures are 2, so no differing figure follows.
      const before = flat.slice(0, (m.index ?? 0) + m[0].length - m[1].length);
      if (/\b(?:row|col|column|option|strategy|action|choice|player|profile)\s+$/i.test(before)) continue;
      const tail = flat.slice((m.index ?? 0) + m[0].length).split(/[.;]/)[0].slice(0, 60);
      const next = tail.match(/(?:\band\b|,|\/|\bversus\b|\bvs\.?\b)[^\d-]{0,25}(-?\d+(?:\.\d+)?)/i);
      if (next && Math.abs(Number(next[1]) - v) > 1e-9) continue;   // a PAIR was stated, not a joint value
      //  (c) "both" can range over ONE PLAYER'S TWO OPTIONS rather than over the
      //      two players — "both processes give the factory the same payoff of
      //      -1", "Broadcast and Stay Silent both give the controller a payoff
      //      of 0". Those are TIE sentences, and true ones (3 more golds). The
      //      tell is grammatical and decidable: "both" is the GIVER, with a
      //      single named recipient after the verb, so it is not the receiver.
      //      A real joint claim puts the verb first — "gives both A and B a
      //      payoff of 1" — leaving no giving verb between "both" and the figure.
      if (/\b(?:both|each)\b[^.;]{0,60}?\b(?:gives?|giving|yields?|pays?|leaves?)\b[^.;]{0,30}?\b(?:payoffs?|receives?|gets?|earns?)\b/i.test(m[0])) continue;
      const cells = [[g.a11, g.b11], [g.a12, g.b12], [g.a21, g.b21], [g.a22, g.b22]];
      if (!cells.some(([a, b]) => Math.abs(a - v) < 1e-9 && Math.abs(b - v) < 1e-9)) {
        issues.push(`prose says both players receive ${v}, but no cell pays (${v}, ${v})`);
      }
    }
  }

  // Which options can carry positive probability at SOME equilibrium. On a
  // degenerate game (a fully indifferent player) the solver enumerates only
  // corners, so the set is derived directly: the indifferent player may play
  // anything; the other player's option is admissible iff it is a best reply
  // at one end of the indifferent player's axis (best-reply advantage is
  // linear in the mix, so the endpoints suffice).
  const ind = computeIndifference(g);
  const admissible = (player: 'A' | 'B', option: 1 | 2): boolean => {
    if (!degenerate) return truth.some((t) => ((player === 'A' ? t.x : t.y) === undefined ? false : ((option === 1 ? (player === 'A' ? t.x : t.y) : 1 - (player === 'A' ? t.x : t.y)) > 1e-3)));
    if (player === 'A' && ind.aIndifferent) return true;
    if (player === 'B' && ind.bIndifferent) return true;
    if (player === 'A') {
      // A's advantage of option vs alt as a function of B's mix y ∈ {0,1}.
      const adv = (y: number) => (option === 1 ? 1 : -1) * ((g.a11 - g.a21) * y + (g.a12 - g.a22) * (1 - y));
      return adv(0) >= -1e-9 || adv(1) >= -1e-9;
    }
    const adv = (x: number) => (option === 1 ? 1 : -1) * ((g.b11 - g.b12) * x + (g.b21 - g.b22) * (1 - x));
    return adv(0) >= -1e-9 || adv(1) >= -1e-9;
  };

  if (claims) {
    for (const a of actionList ?? []) {
      if ((a.player !== 'A' && a.player !== 'B') || !isOpt12(a.option)) {
        issues.push(`equilibrium-action claim is malformed (player=${a.player}, option=${a.option})`);
        continue;
      }
      if (degenerate) {
        if (!admissible(a.player, a.option as 1 | 2)) {
          issues.push(`prose says ${a.player} plays option ${a.option} at an equilibrium, but on this game's equilibrium continuum that option is never a best reply`);
        }
        continue;
      }
      // Valid iff SOME equilibrium gives this option positive probability.
      // The calibration pilot showed the model declares entries for
      // mixed-probability statements too ("A plays Row 1 with probability
      // 0.8" → declares (A, 1)); a pure-NE-only rule demoted every mixed
      // game — 100% false positives. Positive-probability semantics keep
      // full power where it matters (a pure NE at x=0 still refuses (A, 1),
      // which is the live Silent/Broadcast catch) and never punish a true
      // statement about a mixed equilibrium, where both options are played.
      // Read positive probability off the EXACT equilibrium set, not off
      // `truth`. `computeAllNE` enumerates corners and is documented incomplete
      // on tie games, and the `degenerate` flag above only catches FULL
      // indifference — so a PARTIAL tie (weak dominance) produces a continuum
      // that neither sees. On {a11:1,a12:0,a21:0,a22:1,b11:0,b12:1,b21:0,b22:0}
      // the set is the segment x=0, y in [0,0.5]: B's option 1 really is played
      // with probability up to 0.5, while `computeAllNE` reports only the point
      // (0,0) and the claim was withheld. 2,624 such withholdings in a 53,512-
      // rendering sweep of the deterministic renderer's own true output.
      // Identical to the old test wherever the set is points (x0 === x1), so
      // the live Silent/Broadcast catch is preserved: a pure NE at x=0 gives
      // rect x1 = 0 and still refuses (A, 1).
      const rects = equilibriumSet(g);
      const matches = rects.some((r) => {
        const [lo, hi] = a.player === 'A' ? [r.x0, r.x1] : [r.y0, r.y1];
        return (a.option === 1 ? hi : 1 - lo) > 1e-3;
      });
      if (!matches) {
        issues.push(
          `prose says ${a.player} plays option ${a.option} at an equilibrium, but every equilibrium gives that option probability 0`,
        );
      }
    }
  }
  issues.push(...bestReplyIssues(replyList ?? [], g, 'prose'));
  return { ok: issues.length === 0, issues };
}

export function validateReport(rawReport: LlmReport, g: GamePayoffs): ValidationResult {
  // ONE normalisation, here, for every check below. Deciding this per regex gave
  // seven sites seven different ideas of what a minus is, and the validators
  // failed in BOTH directions: three checks missed 100% of false claims written
  // with any unicode minus (measured 400/400 across 5 spellings), while the
  // comparative check, whose class omits U+2014/U+FF0D/U+2010, read "\u20144" as 4
  // and flagged 35% of TRUE claims as false. normalizeProseMinus explains why the
  // prose rule is deliberately narrower than the numeric-field one.
  const report: LlmReport = typeof rawReport?.prose === 'string'
    ? { ...rawReport, prose: normalizeProseMinus(rawReport.prose) }
    : rawReport;
  const checks: string[] = [];
  const mismatches: Mismatch[] = [];

  // Shape guard: a provider that ignores the schema (probed live with
  // Phi-4-mini — suggestedScenario as a bare string, no claimedEquilibria at
  // all) must fail validation, not crash the route. Everything below assumes
  // claimedEquilibria is an array and prose a string.
  if (!Array.isArray(report.claimedEquilibria) || typeof (report.prose ?? '') !== 'string') {
    return {
      ok: false,
      checks: ['FAIL: report shape is malformed (claimedEquilibria missing or not an array)'],
      mismatches: [{
        kind: 'omitted',
        claimed: null,
        expected: null,
        detail: 'report shape is malformed — no claim list to validate',
      }],
    };
  }

  const truth = computeAllNE(g);
  const indifference = computeIndifference(g);
  // Mixed-equilibrium template beside pure-only claims (C7 draw 18: "each
  // player picks a strategy that makes the other indifferent", then two pure
  // corners at which nobody is indifferent). Judged against what the report
  // itself claims, not against the solver: the game may have a mixed
  // equilibrium the report never mentions.
  if (typeof report.prose === 'string'
    && /\b(?:makes?|making|leaves?|leaving|keeps?|keeping|holds?|holding|renders?)\s+(?:the\s+)?(?:other|opponent|rival)(?:\s+(?:player|side|firm|party))?\s+(?:exactly\s+|precisely\s+)?indifferent\b/i.test(report.prose)
    && !report.claimedEquilibria.some((c) => c.type === 'mixed' || c.type === 'continuum') && !indifference.any) {
    mismatches.push({ kind: 'prose-bad-coordinate', claimed: null, expected: null, detail: 'prose says a player mixes to make the other indifferent, but the report claims only pure equilibria' });
    checks.push('FAIL prose: mixing-to-indifference template beside pure-only equilibria');
  }
  // A player with flat payoffs is indifferent between their own actions, so a
  // whole line (or the entire square) is in equilibrium. computeAllNE only
  // enumerates the CORNERS of that set, never its interior — so for these games
  // the solver's list is incomplete by construction, and each claim is checked
  // by the regret oracle alone instead of against that list.
  //
  // The trigger is indifference itself, NOT an empty solver list: an indifferent
  // player always yields at least one corner NE, so `truth.length === 0` here is
  // a dead condition (verified over millions of games). computeAllNE is normally
  // non-empty for a degenerate game; its corners are simply subsumed by the
  // continuum and ignored below.
  const degenerate = indifference.any;

  // Per-game regret tolerances (see REGRET_COORD_SLACK above): each scales with
  // the payoff swing that turns a rounded coordinate into nonzero regret.
  const tolA = regretTol(g.a11 - g.a12 - g.a21 + g.a22);
  const tolB = regretTol(g.b11 - g.b21 - g.b12 + g.b22);

  checks.push(
    degenerate
      ? `solver: continuum of equilibria (degenerate; ${truth.length} corner${truth.length === 1 ? '' : 's'} enumerated)`
      : `solver: ${truth.length} equilibri${truth.length === 1 ? 'um' : 'a'}`,
  );

  const matchedTruth = new Set<number>();

  for (const claim of report.claimedEquilibria) {
    // --- range ---------------------------------------------------------
    if (!inUnitSquare(claim)) {
      mismatches.push({
        kind: 'out-of-range',
        claimed: claim,
        expected: null,
        detail: `${fmt(claim)} is outside the unit square`,
      });
      checks.push(`FAIL ${fmt(claim)}: out of range`);
      continue;
    }

    // --- key 1: independent regret oracle -------------------------------
    const rA = regretA(claim.x, claim.y, g);
    const rB = regretB(claim.x, claim.y, g);
    if (Math.abs(rA) > tolA || Math.abs(rB) > tolB) {
      mismatches.push({
        kind: 'nonzero-regret',
        claimed: claim,
        expected: null,
        detail: `${fmt(claim)} has regret A=${rA.toPrecision(3)}, B=${rB.toPrecision(3)}; not an equilibrium`,
      });
      checks.push(`FAIL ${fmt(claim)}: nonzero regret`);
      continue;
    }

    // --- key 2: the solver lists it -------------------------------------
    // Skipped for degenerate games: there the solver enumerates only the corners
    // of a continuum, so the regret oracle above is the whole check.
    if (degenerate) {
      if (claim.type !== 'continuum') {
        mismatches.push({
          kind: 'wrong-type',
          claimed: claim,
          expected: null,
          detail: `${fmt(claim)} sits on a continuum of equilibria but was labelled '${claim.type}'`,
        });
        checks.push(`FAIL ${fmt(claim)}: should be 'continuum'`);
      } else {
        checks.push(`ok ${fmt(claim)}: on the equilibrium continuum`);
      }
      continue;
    }

    const idx = truth.findIndex((t) => coordsMatch(t, claim));
    if (idx === -1) {
      mismatches.push({
        kind: 'not-in-solver',
        claimed: claim,
        expected: null,
        detail: `${fmt(claim)} has zero regret but the solver does not list it`,
      });
      checks.push(`FAIL ${fmt(claim)}: not in solver output`);
      continue;
    }

    matchedTruth.add(idx);
    if (truth[idx].type !== claim.type) {
      mismatches.push({
        kind: 'wrong-type',
        claimed: claim,
        expected: truth[idx],
        detail: `${fmt(claim)} is '${truth[idx].type}' but was labelled '${claim.type}'`,
      });
      checks.push(`FAIL ${fmt(claim)}: wrong type`);
    } else {
      checks.push(`ok ${fmt(claim)}: ${claim.type}, verified by solver and regret`);
    }
  }

  // --- completeness -----------------------------------------------------
  // A report that silently drops an equilibrium is wrong in the way that
  // matters most for a teaching tool, so omissions fail the report.
  if (!degenerate) {
    truth.forEach((t, i) => {
      if (!matchedTruth.has(i)) {
        mismatches.push({
          kind: 'omitted',
          claimed: null,
          expected: t,
          detail: `solver found ${t.type} equilibrium ${fmt(t)}; the report omits it`,
        });
        checks.push(`FAIL: omitted ${fmt(t)}`);
      }
    });
  } else if (report.claimedEquilibria.length === 0) {
    mismatches.push({
      kind: 'omitted',
      claimed: null,
      expected: null,
      detail: 'game has a continuum of equilibria; the report claims none',
    });
    checks.push('FAIL: omitted the equilibrium continuum');
  }

  // Prose checks run last and are opt-out (NASH_PROSE_CHECKS=0) so their effect
  // on the consistency metric can be measured in isolation — a new check that
  // silently changes the number it reports is indistinguishable from a model
  // regression, which is the failure this harness exists to avoid.
  if (process.env.NASH_PROSE_CHECKS !== '0') {
    const proseIssues = checkProse(report.prose, g, truth, degenerate);
    for (const issue of proseIssues) {
      mismatches.push(issue);
      checks.push(`FAIL prose: ${issue.detail}`);
    }
    if (proseIssues.length === 0) checks.push('ok prose: no invented values or false claims');
  }

  // Same opt-out treatment as the prose checks, and for the same reason: these
  // are new, they feed the consistency metric, and a metric that shifts for an
  // unknown reason is worth less than one that can be measured with the new
  // checks held out.
  if (process.env.NASH_GEOMETRY_CHECKS !== '0') {
    const geoIssues = checkGeometry(report.geometryClaims, g);
    for (const issue of geoIssues) {
      mismatches.push(issue);
      checks.push(`FAIL geometry: ${issue.detail}`);
    }
    if (geoIssues.length === 0) {
      checks.push(
        report.geometryClaims
          ? 'ok geometry: declared shape matches the computed surfaces'
          : 'ok geometry: no geometric claims declared',
      );
    }
  }

  return { ok: mismatches.length === 0, checks, mismatches };
}

// ── Label-aware direction check ──────────────────────────────────────────────
//
// The semantic gap, closed as far as regexes honestly can: a sentence that
// states a preference or indifference in the game's OWN option words is
// parsed into (player, chosen option, opponent option[s]) and checked against
// the matrix — direction AND strictness. Found live on both paths: the cloud
// model wrote "If A delays, B prefers to Go (5 rather than 3)" on the
// Prisoner's Dilemma with a TRUE declaration (Hold), and the local model
// writes "better"/"prefers" on payoff ties while declaring the tie correctly.
// Declarations are checked elsewhere; this reads the words.
//
// Conservative by construction: a clause is only judged when the chosen
// option and at least one opponent option (or a both-ways cue: "whether",
// "regardless", "no matter", "dominant") are unambiguous. Overlapping label
// sets (both players use "Downtown") are skipped. Callers opt in
// (NASH_DIRECTION_CHECKS) so the production route is byte-identical until
// the battery has measured its false-positive rate.

export interface OptionLabels { row1?: string; row2?: string; col1?: string; col2?: string }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Regex for one option label: optional articles, and a simple inflection on any word ("Opening the gate"). */
function labelPattern(label: string): string {
  const words = label.trim().split(/\s+/).map(escapeRe).map((w) => {
    const stem = w.replace(/e$/i, '');
    // NOTE: a doubled-final-consonant form ("Price-chop" -> "price-chopping")
    // was tried and REVERTED: matching one option's paraphrase while the other
    // option's paraphrase stays unmatched makes the parser attach a later
    // clause to the wrong frame, which flagged a CORRECT prose (C11 draw 7).
    // Partial paraphrase coverage is worse than none.
    // A label is often given in an inflected form ("Warning") while the prose
    // uses the base ("when B warns" — C16 draw 25), so the base is recovered
    // and re-inflected. Applied to every label alike, never to one side only.
    const base = w.replace(/(?:ing|ed|s)$/i, '');
    const fromBase = base.length >= 3 && base !== w && base !== stem ? `|${base}(?:e?s|e?d|ing)?` : '';
    return `(?:${w}|${stem}(?:e?s|e?d|ing)${fromBase})`;
  });
  return `\\b(?:the\\s+|an?\\s+)?${words.join('[\\s-]+(?:the\\s+|an?\\s+)?')}\\b`;
}

interface LabelHit { player: 'A' | 'B'; option: 1 | 2; index: number; length: number }

function findLabels(clause: string, sets: { player: 'A' | 'B'; option: 1 | 2; re: RegExp }[]): LabelHit[] {
  const hits: LabelHit[] = [];
  for (const s of sets) {
    for (const m of clause.matchAll(s.re)) hits.push({ player: s.player, option: s.option, index: m.index ?? 0, length: m[0].length });
  }
  hits.sort((a, b) => a.index - b.index || b.length - a.length);
  // A label that is a substring of another ("Audit" inside "Skip Audit"): the longer span wins.
  const kept = hits.filter((h, i) => !hits.some((o, j) => j !== i && o.index <= h.index && o.index + o.length >= h.index + h.length && o.length > h.length));
  // Two players' labels that PARTIALLY overlap the same words ("the interceptor
  // covers the River Road" is both B's "Cover River" and A's "River Road"):
  // neither reading can be preferred, so both hits are dropped and the sentence
  // goes unjudged rather than misjudged (training-gold rows 2790/3070).
  const overlaps = (a: LabelHit, b: LabelHit) => a.index < b.index + b.length && b.index < a.index + a.length;
  return kept.filter((h) => !kept.some((o) => o !== h && o.player !== h.player && overlaps(h, o)));
}

export function validateProseDirections(text: string, labels: OptionLabels | null | undefined, g: GamePayoffs): string[] {
  return validateProseDirectionsDetailed(text, labels, g).issues;
}

/** Same check, also reporting how many preference claims were parsed (0 = nothing verifiable). */
export function validateProseDirectionsDetailed(rawText: string, labels: OptionLabels | null | undefined, g: GamePayoffs): { issues: string[]; claims: number } {
  // ONE normalisation, here, for every check below. Deciding this per regex gave
  // seven sites seven different ideas of what a minus is, and the validators
  // failed in BOTH directions: three checks missed 100% of false claims written
  // with any unicode minus (measured 400/400 across 5 spellings), while the
  // comparative check, whose class omits U+2014/U+FF0D/U+2010, read "\u20144" as 4
  // and flagged 35% of TRUE claims as false. normalizeProseMinus explains why the
  // prose rule is deliberately narrower than the numeric-field one.
  let text = normalizeProseMinus(rawText);
  const issues: string[] = [];
  let claimCount = 0;
  if (!text) return { issues, claims: 0 };
  // "for sure" / "for certain" are empty intensifiers that carry no referent,
  // but they sit between a label and its frame and break the adjacency the
  // claim parser measures ("If B chooses Col 2 for sure, A's best response is
  // Row 1 for sure" parsed as a claim about the wrong column — C17 draw 4).
  // Deleting them can only remove text, never invent an anchor.
  text = text.replace(/\s+for\s+(?:sure|certain)\b/gi, '');
  const named = [
    { player: 'A' as const, option: 1 as const, names: [labels?.row1, 'Row 1'] },
    { player: 'A' as const, option: 2 as const, names: [labels?.row2, 'Row 2'] },
    { player: 'B' as const, option: 1 as const, names: [labels?.col1, 'Col 1', 'Column 1'] },
    { player: 'B' as const, option: 2 as const, names: [labels?.col2, 'Col 2', 'Column 2'] },
  ];
  // Label attribution (C12 draw 34, the Penalty Kick preset): a scenario label
  // is usable unless it is AMBIGUOUS — identical to one of the other player's
  // labels, or matching one of them outright ("Left" against "Kick Left").
  // Sharing a mere word is not ambiguity: "Kick Left" and "Dive Left" are
  // distinct phrases, and the old vocabulary-overlap rule silently dropped BOTH
  // preset labels, so every directional sentence written in them went unread.
  // A player whose own two labels are identical loses both (nothing to tell
  // them apart); the generic Row/Col names are always kept, so statements in
  // those terms are judged either way (C9 draw 33).
  const norm = (s?: string) => (s ?? '').trim().toLowerCase();
  const full = (pat: string, text: string) => new RegExp(`^(?:${pat})$`, 'i').test(text.trim());
  const labelOf = { A: [labels?.row1, labels?.row2], B: [labels?.col1, labels?.col2] } as const;
  const ambiguous = (player: 'A' | 'B', label?: string): boolean => {
    const me = norm(label);
    if (!me) return true;
    const mine = labelOf[player].map(norm).filter(Boolean);
    if (mine[0] && mine[0] === mine[1]) return true;
    const theirs = labelOf[player === 'A' ? 'B' : 'A'].map(norm).filter(Boolean) as string[];
    // Containment counts too: "Campus" inside "Promote Campus" cannot be
    // attributed on its own once the story elides the verb ("B promotes
    // Downtown … and Campus" — training-gold row 2790).
    const inside = (pat: string, text: string) => new RegExp(pat, 'i').test(text);
    // "No warning" vs "Warning" reads as containment, but the pair is a
    // NEGATION, not an ambiguity: findLabels already prefers the longer span,
    // so the negated form wins wherever its words appear and a bare mention
    // belongs to the affirmative label (C16 draw 25).
    const NEGATION = /^(?:no|not|non-?|never|without|skip|avoid|refrain\s+from|don'?t|do\s+not)\s+/i;
    const negatedPair = (a: string, b: string) => NEGATION.test(a) && full(labelPattern(b), a.replace(NEGATION, '').trim());
    return theirs.some((t) => {
      if (negatedPair(t, me) || negatedPair(me, t)) return false;
      return t === me || full(labelPattern(label!), t) || full(labelPattern(t), me)
        || inside(labelPattern(label!), t) || inside(labelPattern(t), me);
    });
  };
  // SHORT-LABEL ALIASES WERE TRIED AND REVERTED. Prose shortens "Hunt Stag"/
  // "Hunt Hare" to "Stag"/"Hare" (L10 draw 40), and adding the distinguishing
  // remainder as an alias does catch it — but the alias then matched inside the
  // other player's labels ("Review" inside "Manual Review"), flagged 2 training
  // golds, and broke the C4 draw-20 parenthetical test. Two rounds of collision
  // guards did not clear both. The class stays open rather than ship a rule that
  // suppresses correct prose; the explicit-player parse below already covers the
  // same sentences whenever the labels are written out in full.
  const sets = named.flatMap((n) => {
    const scenarioName = ambiguous(n.player, n.names[0]) ? undefined : n.names[0];
    return [scenarioName, ...n.names.slice(1)].filter((x): x is string => !!x && x.trim().length > 0)
      .map((x) => ({ player: n.player, option: n.option, re: new RegExp(labelPattern(x), 'gi') }));
  });

  const payoff = (player: 'A' | 'B', own: 1 | 2, opp: 1 | 2) =>
    player === 'A' ? cellAOf(g, own, opp) : cellBOf(g, opp, own);
  const describe = (player: 'A' | 'B', own: 1 | 2, opp: 1 | 2) => {
    const alt = (3 - own) as 1 | 2;
    return `${player}'s option ${own} vs option ${alt} against opponent option ${opp} pays ${payoff(player, own, opp)} vs ${payoff(player, alt, opp)}`;
  };

  // Desirability wording carries the same claim as "better" ("Offer bribe is
  // very tempting when B runs a light inspection" — C13 draw 20) and was
  // simply outside the vocabulary; it still needs a label and a frame, so the
  // anchoring is unchanged.
  const STRICT_AFTER_DESIRE = /^\s*(?:is|are|looks?|seems?|becomes?)\s+(?:(?:very|quite|highly|especially|particularly|really|rather|more|most|clearly|strictly)\s+)*(?:tempting|attractive|appealing|preferable|advantageous|worthwhile|worth\s+it)\b/i;
  const STRICT_AFTER = /^\s*(?:is|are|does|works|do)\s+(?:(?:strictly|clearly|always|likewise|also|again|still|therefore|thus|only|usually|generally|simply|just)\s+)?(?:(?:[AB]['’]s|the|its|their)\s+)?(?:better|best)\b|^\s*(?:beats|dominates|outperforms)\b|^\s*(?:gives|yields|earns|pays)\s+(?:(?:player\s+)?[AB]|\w+)\s+(?:a\s+(?:payoff|return)\s+of\s+)?-?\d+(?:\.\d+)?\s*(?:rather\s+than|instead\s+of|vs\.?|versus|compared|over)\b/i;
  // "A's best response is Row 1" / "A's best reply is Inspect" states a strict
  // preference as a noun phrase; the vocabulary only had verbs (C17 draw 4,
  // which was written in generic Row/Col names the screen always keeps).
  const STRICT_BEST = /\b(?:player\s+)?[AB]['’]s\s+(?:unique\s+|only\s+|single\s+)?best\s+(?:response|reply|choice|move|option|action)\s+(?:here\s+|then\s+)?(?:is|becomes|remains|would\s+be)\s+(?:to\s+(?:choose|play|pick|use)\s+)?$/i;
  const STRICT_BEFORE = /\b(?:prefers?|favou?rs?|wants?|opts?\s+for|should\s+(?:choose|pick|play)|pinned\s+to|locked\s+into|settles?\s+on|commits?\s+to|(?:does|do)\s+(?:\w+\s+)?(?:better|best)\s+(?:off\s+)?(?:with|by\s+choosing|by\s+playing)|(?:is|are)\s+(?:\w+\s+)?(?:better|best)\s+off\s+(?:with|choosing|playing))\s+(?:to\s+)?$/i;
  const BOTH_WAYS = /\b(?:whether|regardless|no\s+matter|either|dominant|in\s+both|both\s+(?:columns|rows|cases)|always|whatever)\b/i;
  const INDIFF = /\bindifferent\s+between\b/i;
  const SEP = /,|;|\bbut\b|\band\b|\bwhile\b|\bwhereas\b/i;

  interface Claim { own: LabelHit; start: number; end: number; kind: 'strict' | 'indiff' }

  const isPureNE = (r: 1 | 2, c: 1 | 2) =>
    cellAOf(g, r, c) >= cellAOf(g, (3 - r) as 1 | 2, c) - 1e-9 && cellBOf(g, r, c) >= cellBOf(g, r, (3 - c) as 1 | 2) - 1e-9;

  // "A=3 with Echo" / "B = -7 against Counter": a payoff tagged with an opponent
  // option must belong to that column/row (C4 draw 28 tagged every value with
  // the wrong opponent option). If an own-side label sits earlier in the same
  // sentence the exact cell is checked; otherwise the value must appear in that
  // opponent option's column/row for the named player.
  {
    const allHitsC = findLabels(text, sets);
    for (const m of text.matchAll(/\b([AB])\s*[=≈]\s*([-−–]?\d+(?:\.\d+)?)\s+(?:with|against|versus|vs\.?|facing|under)\s+(?:the\s+|an?\s+|[AB]['’]s\s+)?/gi)) {
      const player = m[1].toUpperCase() as 'A' | 'B';
      const v = Number(m[2]);   // already normalised at the entry point
      const at = (m.index ?? 0) + m[0].length;
      const opp = allHitsC.find((h) => h.index >= at && h.index <= at + 2);
      if (!opp || opp.player === player || !Number.isFinite(v)) continue;
      const sentStart = Math.max(text.lastIndexOf('.', m.index ?? 0), text.lastIndexOf(';', m.index ?? 0)) + 1;
      const own = allHitsC.filter((h) => h.player === player && h.index >= sentStart && h.index < (m.index ?? 0)).pop();
      const cellsInOpp = [1, 2].map((o) => (player === 'A' ? cellAOf(g, o as 1 | 2, opp.option) : cellBOf(g, opp.option, o as 1 | 2)));
      const ok = own ? Math.abs((player === 'A' ? cellAOf(g, own.option, opp.option) : cellBOf(g, opp.option, own.option)) - v) < 1e-9
        : cellsInOpp.some((x) => Math.abs(x - v) < 1e-9);
      if (!ok) issues.push(`prose tags ${player}=${v} with opponent option ${opp.option}, but that ${opp.player === 'B' ? 'column' : 'row'} pays ${player} ${cellsInOpp.join(' / ')}`);
    }
  }

  // Mix stated in words or percent attached to a label: "two-fifths on Stick",
  // "puts 60% on Advertise", "Advertise three-quarters of the time" — the
  // number must match some equilibrium probability of that option (C5 draw 23
  // said two-fifths where y* = 0.2). Extreme values are handled below.
  {
    const truthW = computeAllNE(g);
    const allHitsW = findLabels(text, sets);
    const WORD: Record<string, number> = { half: 0.5, third: 1 / 3, quarter: 0.25, fifth: 0.2, sixth: 1 / 6, eighth: 0.125, tenth: 0.1 };
    const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, nine: 9 };
    const fracRe = /\b(?:(one|two|three|four|five|six|seven|nine)[-\s])?(half|third|quarter|fifth|sixth|eighth|tenth)s?\b|\b(\d{1,3})\s*(?:%|percent)\b/gi;
    for (const m of text.matchAll(fracRe)) {
      let p: number;
      if (m[3]) p = Number(m[3]) / 100; else p = (m[1] ? NUM[m[1].toLowerCase()] : 1) * WORD[m[2].toLowerCase()];
      const at = m.index ?? 0, end = at + m[0].length;
      // Skip "with probability one quarter" already-checked forms? No — same rule applies. Skip time fractions ("of the time" is fine) but skip "half of the payoff" etc.
      const after = text.slice(end, end + 40), before = text.slice(Math.max(0, at - 40), at);
      // Forward binding first, and a bare adjacency counts: "two-thirds Lenient
      // inspection" names its own label with no connector at all.
      const lab = allHitsW.find((h) => h.index >= end && h.index <= end + 12 && /^\s*(?:on|to|for|at|toward|towards)?\s*(?:the\s+|an?\s+)?$/i.test(text.slice(end, h.index)))
        // Backward binding must NOT cross a comma. In "(one-third Strict
        // inspection, two-thirds Lenient inspection)" the comma separates two
        // list items, so a fraction after it belongs to what FOLLOWS; letting a
        // bare comma bind backwards attached "two-thirds" to Strict inspection
        // and withheld a wholly correct paragraph (round C19 draw 55 — the
        // campaign's only correct-withheld).
        ?? allHitsW.filter((h) => h.index + h.length <= at && h.index + h.length >= at - 30 && /^\s*(?:with|at|about|roughly|around)?\s*(?:probability\s+|weight\s+|frequency\s+)?(?:of\s+)?$/i.test(text.slice(h.index + h.length, at))).pop();
      if (!lab) continue;
      // "Row 1 and Row 2 with two-thirds/one-third odds": a list of same-side labels before the fraction is ambiguous — skip.
      if (lab.index < at && allHitsW.some((h) => h !== lab && h.player === lab.player && h.index < lab.index && h.index >= lab.index - 40 && /^\s*(?:and|or|\/|,)\s*(?:the\s+)?$/i.test(text.slice(h.index + h.length, lab.index)))) continue;
      if (/\b(?:of\s+the\s+(?:payoff|score|gain|value)|payoff|less|more|higher|lower)\b/i.test(after.slice(0, 20)) || /\b(?:if|when|whenever|suppose|whether|should|were)\b/i.test(text.slice(Math.max(text.lastIndexOf('.', at), text.lastIndexOf(';', at)) + 1, at))) continue;
      // A fully indifferent player sits on a continuum: any mix is an equilibrium for them.
      const indW = computeIndifference(g);
      if ((lab.player === 'A' && indW.aIndifferent) || (lab.player === 'B' && indW.bIndifferent)) continue;
      const ok = truthW.some((t) => { const p1 = lab.player === 'A' ? t.x : t.y; const pl = lab.option === 1 ? p1 : 1 - p1; return Math.abs(pl - p) < 0.02; });
      if (!ok && truthW.length) issues.push(`prose puts ${lab.player}'s option ${lab.option} at probability ${p.toFixed(3)}, but no equilibrium does`);
    }
  }

  // Preference over the OPPONENT's option: "A would rather have B play Agree",
  // "A wants B to Cooperate" (C5 draw 28). Judged at A's equilibrium option
  // when a single pure equilibrium exists: A's payoff there must be at least
  // as high with the named option as with the other one.
  {
    const truthO = computeAllNE(g).filter((t) => t.type === 'pure');
    const allHitsO = findLabels(text, sets);
    for (const m of text.matchAll(/\b([AB])\s+(?:would\s+(?:rather|prefer)\s+(?:to\s+)?(?:have|see|that)|wants?|prefers?(?:\s+that)?|hopes?(?:\s+that)?)\s+(?:player\s+)?([AB])\s+(?:to\s+)?(?:play|plays|choose|chooses|pick|picks|use|uses|go|goes)\s+(?:the\s+|an?\s+)?/gi)) {
      const who = m[1].toUpperCase() as 'A' | 'B', other = m[2].toUpperCase() as 'A' | 'B';
      if (who === other || truthO.length !== 1) continue;
      const end = (m.index ?? 0) + m[0].length;
      const lab = allHitsO.find((h) => h.index >= end && h.index <= end + 2);
      if (!lab || lab.player !== other) continue;
      const t = truthO[0];
      const ownOpt = (who === 'A' ? (t.x === 1 ? 1 : 2) : (t.y === 1 ? 1 : 2)) as 1 | 2;
      const pay = (opp: 1 | 2) => (who === 'A' ? cellAOf(g, ownOpt, opp) : cellBOf(g, opp, ownOpt));
      if (pay(lab.option) < pay((3 - lab.option) as 1 | 2) - 1e-9) {
        issues.push(`prose says ${who} would rather ${other} play option ${lab.option}, but at ${who}'s equilibrium option that pays ${who} ${pay(lab.option)} vs ${pay((3 - lab.option) as 1 | 2)}`);
      }
    }
  }

  // "<label> with probability 0 / 1" (or "one"/"zero"): the label's equilibrium
  // probability must actually be that (C1 draw 13: "A plays Silence with
  // probability 0" when Silence IS the equilibrium row). Only extreme
  // probabilities are judged — interior values belong to checkProse.
  {
    const truthLocal = computeAllNE(g);
    const allHits = findLabels(text, sets);
    for (const m of text.matchAll(/\bwith\s+(?:a\s+)?probability\s+(?:of\s+)?(0|1|one|zero)\b(?!\.\d)(?!\s*[-–%])(?!\s+(?:quarter|third|fifth|sixth|eighth|tenth|half|in|out|minus|plus))/gi)) {
      const p = /^(?:1|one)$/i.test(m[1]) ? 1 : 0;
      const mEnd = (m.index ?? 0) + m[0].length;
      const before = text.slice(Math.max(0, (m.index ?? 0) - 40), m.index);
      // "… with probability 0 for Row 1": the probability belongs to the label AFTER for/on/of.
      const after = /^\s+(?:for|on|of)\s+/i.exec(text.slice(mEnd, mEnd + 8));
      let lab: LabelHit | undefined;
      if (after) lab = allHits.find((h) => h.index >= mEnd && h.index <= mEnd + after[0].length + 1);
      else {
        lab = allHits.filter((h) => h.index + h.length <= (m.index ?? 0) && h.index + h.length >= (m.index ?? 0) - 40).pop();
        if (!lab || !/^\s*(?:\([^)]*\)\s*)?$/.test(text.slice(lab.index + lab.length, m.index))) continue;
      }
      if (!lab) continue;
      if (/\b(?:not|never|no)\b/i.test(before)) continue;
      // Hypotheticals ("if B uses Relay with probability 1, A prefers …") are frames, not claims.
      const segStart = Math.max(text.lastIndexOf('.', lab.index), text.lastIndexOf(';', lab.index), text.lastIndexOf(':', lab.index)) + 1;
      if (/\b(?:if|when|whenever|suppose|supposing|whether|should|were)\b/i.test(text.slice(segStart, lab.index))) continue;
      const ok = truthLocal.some((t) => {
        const p1 = lab.player === 'A' ? t.x : t.y;
        const pl = lab.option === 1 ? p1 : 1 - p1;
        return Math.abs(pl - p) < 1e-3;
      });
      if (!ok && truthLocal.length) issues.push(`prose gives ${lab.player}'s option ${lab.option} probability ${p}, but no equilibrium does`);
    }
  }

  // Qualitative weight attached to a label: "a mostly Hold-Position mix",
  // "leans mainly toward Signal", "rarely Folds" (C11 draw 28: "mostly
  // hold-position" for an option played at 1/16). mostly/mainly/… claims the
  // label carries MORE than half of that player's weight at some equilibrium;
  // rarely/seldom claims LESS than half. Negated and hypothetical frames are
  // skipped; "usually" is left alone (scene-setting habit, not a claim).
  {
    const truthLocal = computeAllNE(g);
    const allHits = findLabels(text, sets);
    const QUAL = /\b(mostly|mainly|predominantly|largely|primarily|chiefly|rarely|seldom)\b(?:\s+(?:on|toward|towards|to|a|an|the|its|his|her|their|for))*[\s-]*/gi;
    for (const m of text.matchAll(QUAL)) {
      const mEnd = (m.index ?? 0) + m[0].length;
      const lab = allHits.find((h) => h.index >= mEnd && h.index <= mEnd + 1);
      if (!lab) continue;
      const before = text.slice(Math.max(0, (m.index ?? 0) - 40), m.index);
      if (/\b(?:not|never|no|isn['’]t|aren['’]t|rather\s+than|instead\s+of)\b/i.test(before)) continue;
      const segStart = Math.max(text.lastIndexOf('.', lab.index), text.lastIndexOf(';', lab.index), text.lastIndexOf(':', lab.index)) + 1;
      if (/\b(?:if|when|whenever|suppose|supposing|whether|should|were|would|could|might)\b/i.test(text.slice(segStart, lab.index))) continue;
      const major = !/^(?:rarely|seldom)$/i.test(m[1]);
      claimCount++;
      const ok = truthLocal.some((t) => {
        const p1 = lab.player === 'A' ? t.x : t.y;
        const pl = lab.option === 1 ? p1 : 1 - p1;
        return major ? pl > 0.5 - 1e-9 : pl < 0.5 + 1e-9;
      });
      if (!ok && truthLocal.length) issues.push(`prose says ${lab.player} ${major ? 'mostly' : 'rarely'} plays option ${lab.option}, but no equilibrium gives it ${major ? 'more' : 'less'} than half of ${lab.player}'s weight`);
    }
  }

  // Explicitly-attributed profiles ("A chooses Football while B chooses Opera"
  // — L4 draw 54, a coordination game rendered as anti-coordination). When the
  // sentence names the player, the label needs no disambiguation: it is looked
  // up in THAT player's own options. This is the only reading that works on a
  // coordination game whose two players share their option words, exactly the
  // case the ambiguity fallback drops.
  {
    const optionOf = (player: 'A' | 'B', word: string): 1 | 2 | null => {
      const cands: [1 | 2, string | undefined][] = player === 'A'
        ? [[1, labels?.row1], [2, labels?.row2], [1, 'Row 1'], [2, 'Row 2']]
        : [[1, labels?.col1], [2, labels?.col2], [1, 'Col 1'], [2, 'Col 2'], [1, 'Column 1'], [2, 'Column 2']];
      for (const [opt, lab] of cands) {
        if (lab && new RegExp(`^(?:${labelPattern(lab)})$`, 'i').test(word.trim())) return opt;
      }
      return null;
    };
    // The verb list has to cover how stories actually talk. "A hunts Hare while
    // B hunts Hare" went unchecked for want of "hunts" (L7 draw 16, and the
    // same class was 4 of C18's 6 misses) — in shared-label games this check is
    // the ONLY one that can see the profile, so a missing verb is a blind spot.
    const PICK = String.raw`(?:choos\w*|us\w*|play\w*|pick\w*|select\w*|go(?:es|ing)?\s+(?:with|for)|opt\w*\s+for|takes?|taking|running|runs?|hunts?|hunting|adopts?|backs?|favou?rs?|commits?\s+to|settles?\s+on|sides?\s+with|adopt(?:ing)?|adheres?\s+to)`;
    const NAME = String.raw`(?:player\s+)?([AB])\b`;
    const RE = new RegExp(String.raw`\b${NAME}\s+${PICK}\s+(?:the\s+|an?\s+)?([\w' -]{2,40}?)\s*(?=,|;|\.|\band\b|\bwhile\b|\bwhereas\b|\bwith\b|$)`, 'gi');
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      // A profile can be asserted as an equilibrium without the word: "neither
      // can improve by switching" IS the definition (C17 draw 69).
      const EQ_WORD = /\b(?:equilibri(?:um|a)|stable|rests?\s+at|settles?)\b/i;
      const EQ_DEF = /\bneither\s+(?:player\s+|side\s+|one\s+)?(?:can|could|would|has\s+(?:an?\s+)?(?:incentive|reason))\b[^.;]{0,40}?\b(?:improve|gain|do\s+better|benefit|deviate|switch|change)\b|\bno\s+(?:player|side|one)\s+(?:can|could|would)\b[^.;]{0,40}?\b(?:improve|gain|do\s+better|benefit|deviate|switch)\b/i;
      const assertsEq = EQ_WORD.test(sentence) || EQ_DEF.test(sentence);
      if (!assertsEq) continue;
      // The negation guard must not fire on the definition itself, which
      // necessarily contains "neither" and "switch".
      const NEG_SCOPE = EQ_DEF.test(sentence)
        ? /\b(?:not\s+an\s+equilibrium|is\s+not\s+stable|fails?\s+to\s+be)\b/i
        : /\b(?:no|not|never|isn['’]t|aren['’]t|fails?|would\s+not|cannot|can['’]t|neither|instead\s+of|rather\s+than|deviat\w*|switch\w*)\b/i;
      if (NEG_SCOPE.test(sentence)) continue;
      // A MIXED-equilibrium sentence names both players' options too ("A uses
      // Standard with probability 0.6 while B uses Monitor …") and is not a
      // claim that the pure profile is an equilibrium — the single largest
      // false-positive source when this check was first written (687 golds).
      if (/\d|\b(?:probabilit\w*|mix\w*|randomi\w*|weight\w*|percent\w*|odds|fraction\w*|half|third|quarter|fifth|of\s+the\s+time|indifferent)\b/i.test(sentence)) continue;
      const found: { player: 'A' | 'B'; option: 1 | 2; index: number; end: number }[] = [];
      for (const m of sentence.matchAll(RE)) {
        const player = m[1].toUpperCase() as 'A' | 'B';
        // "A hunts Hare" states the option "Hunt Hare" with the verb standing
        // in for the label's first word, so the object alone matches nothing
        // (L7 draw 16). Fall back to matching the label across the whole
        // verb+object span, which the lookahead already keeps short.
        const span = m[0].replace(/^\s*(?:player\s+)?[AB]\b/i, '');
        const opt = optionOf(player, m[2]) ?? (() => {
          const cands: [1 | 2, string | undefined][] = player === 'A'
            ? [[1, labels?.row1], [2, labels?.row2]]
            : [[1, labels?.col1], [2, labels?.col2]];
          for (const [o, lab] of cands) if (lab && new RegExp(labelPattern(lab), 'i').test(span)) return o;
          return null;
        })();
        if (opt) found.push({ player, option: opt, index: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
      }
      for (let k = 0; k + 1 < found.length; k++) {
        const a = found[k], b = found[k + 1];
        if (a.player === b.player) continue;
        // The two mentions must be joined into ONE profile ("A chooses X while
        // B chooses Y"), not merely present in the same sentence.
        const between = sentence.slice(a.end, b.index);
        if (between.length > 45 || !/^[\s,]*(?:and|while|whereas|with|&|\+|,)?[\s,]*$/i.test(between)) continue;
        const row = (a.player === 'A' ? a : b).option, col = (a.player === 'B' ? a : b).option;
        claimCount++;
        if (!isPureNE(row, col)) {
          issues.push(`prose presents (Row ${row}, Col ${col}) as an equilibrium, but it is not: A pays ${cellAOf(g, row, col)} vs ${cellAOf(g, (3 - row) as 1 | 2, col)} switching rows, B pays ${cellBOf(g, row, col)} vs ${cellBOf(g, row, (3 - col) as 1 | 2)} switching columns`);
        }
        k++;
      }
    }
  }

  // "both organizers choose morning" (L4 draw 12): a symmetric profile stated
  // once, with the shared option word belonging to both players. Only read when
  // the two players' option lists carry that word in the SAME position, which
  // is what makes the profile well defined.
  {
    const SAME = /\b(?:both|the\s+two|each|either)\s+(?:players?|sides?|firms?|parties|organiz\w+|\w+ers?|\w+ors?)\s+(?:choos\w*|us\w*|play\w*|pick\w*|select\w*|go\s+(?:with|for)|settle\s+on|take)\s+(?:the\s+|an?\s+)?([\w' -]{2,40}?)\s*(?=,|;|\.|\band\b|\bwhile\b|$)/gi;
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      if (!/\b(?:equilibri(?:um|a)|stable|rests?\s+at|settles?|continuum)\b/i.test(sentence)) continue;
      if (/\b(?:no|not|never|isn['’]t|aren['’]t|fails?|cannot|can['’]t|neither|deviat\w*)\b/i.test(sentence)) continue;
      for (const m of sentence.matchAll(SAME)) {
        const word = m[1].trim();
        const hit = (lab?: string) => !!lab && new RegExp(`^(?:${labelPattern(lab)})$`, 'i').test(word);
        const row: 1 | 2 | null = hit(labels?.row1) ? 1 : hit(labels?.row2) ? 2 : null;
        const col: 1 | 2 | null = hit(labels?.col1) ? 1 : hit(labels?.col2) ? 2 : null;
        if (row === null || col === null) continue;
        claimCount++;
        if (!isPureNE(row, col)) {
          issues.push(`prose presents (Row ${row}, Col ${col}) as an equilibrium, but it is not: A pays ${cellAOf(g, row, col)} vs ${cellAOf(g, (3 - row) as 1 | 2, col)} switching rows, B pays ${cellBOf(g, row, col)} vs ${cellBOf(g, row, (3 - col) as 1 | 2)} switching columns`);
        }
      }
    }
  }

  // Equilibrium COUNT (L4 draw 7: "the sole equilibrium …" then "there is
  // another equilibrium …" on a game with two). Only the understatement
  // direction is judged: computeAllNE can under-report continua on degenerate
  // games, so "sole" is decidably wrong when the solver ALREADY holds two or
  // more, and never flagged the other way.
  {
    const truthCount = computeAllNE(g).length;
    const soleRe = /\b(?:the\s+)?(?:sole|only|single|unique|one\s+and\s+only)\s+(?:pure\s+|mixed\s+|nash\s+)*equilibrium\b/i;
    const m = soleRe.exec(text);
    const before = m ? text.slice(Math.max(0, (m.index ?? 0) - 30), m.index) : '';
    // A description that CONTRASTS with a single equilibrium ("producing a
    // continuum rather than a single equilibrium", "the single equilibrium
    // claim is a continuum") asserts the opposite of what this check reads.
    const contrast = /\b(?:rather\s+than|instead\s+of|not|than|beyond|isolat\w*)\s*(?:a|an|the)?\s*$/i.test(before)
      || /\bcontinu(?:um|a|ous)\w*\b/i.test(text);
    if (truthCount > 1 && m && !contrast
      && !/\b(?:no|not|isn['’]t|besides|apart\s+from|other\s+than)\b[^.;]{0,20}\b(?:sole|only|single|unique)\b/i.test(text)) {
      issues.push(`prose calls the equilibrium the sole one, but the game has ${truthCount}`);
      claimCount++;
    }
  }

  // Deviation phrasing is read by the dedicated check below; the anchored
  // preference parser misreads "at <col> with <row>, X would want to …" as a
  // preference between the two named labels, so those clauses are its business
  // and not the parser's.
  const DEVIATE_RE = /\b(?:would\s+(?:want|prefer|like|rather)\s+to|would\s+(?:switch|deviate|move|flip|change)|wants?\s+to\s+(?:switch|deviate|move|flip|change)|has\s+an?\s+incentive\s+to\s+(?:switch|deviate|move|change)|gains?\s+by\s+(?:switching|deviating|moving|changing)|is\s+tempted\s+to\s+(?:switch|deviate|move)|profits?\s+by\s+(?:switching|deviating))\b/i;
  const STOPW = new Set(['option', 'strategy', 'plan', 'move', 'action', 'choice', 'player', 'route', 'gate']);
  // Deviation-shaped best-reply claims (L4 draw 43: "at Open Gate with Pay
  // Toll, the gatekeeper would want to close"). These name a CELL and assert
  // that one player wants to move away from it — a claim the anchored
  // "X is better than Y against Z" parser never sees. The deviation TARGET
  // does not have to be parsed: naming a cell and a player who wants to leave
  // it is false whenever that player is already best-replying there, which is
  // decidable from the two payoffs in that player's column/row.
  {
    const DEVIATE = DEVIATE_RE;
    for (const clause of text.split(/(?<=[.!?])\s+|;\s*|,\s*(?=while\b|whereas\b|but\b|and\b)|\bwhile\b|\bwhereas\b/i)) {
      const dev = DEVIATE.exec(clause);
      if (!dev) continue;
      // Only an IMMEDIATE negation cancels the claim ("would not want to
      // switch"); a sentence-opening "there is no pure equilibrium" does not.
      if (/\b(?:no|not|never|neither|nothing|isn['’]t|doesn['’]t|don['’]t|cannot|can['’]t|nobody)\b[^.;]{0,12}$/i.test(clause.slice(0, dev.index ?? 0))) continue;
      if (/\b(?:probabilit\w*|mix\w*|randomi\w*)\b/i.test(clause)) continue;
      // The clause must NAME a cell: one label of each player.
      const hits = findLabels(clause, sets).filter((h) => h.index < (dev.index ?? 0));
      const rowHit = hits.filter((h) => h.player === 'A');
      const colHit = hits.filter((h) => h.player === 'B');
      if (rowHit.length !== 1 || colHit.length !== 1) continue;
      const row = rowHit[0].option, col = colHit[0].option;
      // Who wants to leave: an explicit letter, else the player whose label is
      // NOT the one the deviation verb follows.
      const letter = /\b(?:player\s+)?([AB])\b/.exec(clause.slice(0, dev.index ?? 0))?.[1] as 'A' | 'B' | undefined;
      // Otherwise the deviation TARGET names the mover: "would want to close"
      // carries a content word of B's "Close Gate" and of no label of A's, so
      // the gatekeeper is the one being said to move (L4 draw 43).
      const tail = clause.slice((dev.index ?? 0) + dev[0].length, (dev.index ?? 0) + dev[0].length + 40).toLowerCase();
      const contentOf = (lab?: string) => (lab ?? '').toLowerCase().split(/\s+/)
        .map((w) => w.replace(/[^a-z]/g, '')).filter((w) => w.length > 3 && !STOPW.has(w));
      const aWordsD = new Set([...contentOf(labels?.row1), ...contentOf(labels?.row2)]);
      const bWordsD = new Set([...contentOf(labels?.col1), ...contentOf(labels?.col2)]);
      const tailWords = tail.split(/[^a-z]+/).filter(Boolean);
      const hitsA = tailWords.some((w) => aWordsD.has(w) && !bWordsD.has(w));
      const hitsB = tailWords.some((w) => bWordsD.has(w) && !aWordsD.has(w));
      const who: 'A' | 'B' | undefined = letter ?? (hitsA !== hitsB ? (hitsA ? 'A' : 'B') : undefined);
      if (!who) continue;
      claimCount++;
      const here = who === 'A' ? cellAOf(g, row, col) : cellBOf(g, row, col);
      const there = who === 'A' ? cellAOf(g, (3 - row) as 1 | 2, col) : cellBOf(g, row, (3 - col) as 1 | 2);
      if (there < here) {
        issues.push(`prose says ${who} would move away from (Row ${row}, Col ${col}), but ${who} is already best-replying there: ${here} vs ${there} after switching`);
      }
    }
  }

  // PAYOFF dependence, as distinct from PREFERENCE dependence (round C15
  // draws 7 and 56). "A's payoff doesn't depend on what B does" is a claim
  // about the numbers in A's row, and on a flat-plane game (equal twists) the
  // model verbalises "which option is better is independent" as "the payoff is
  // independent" — true of the preference, false of the payoff. The existing
  // dependence screen reads BEST-RESPONSE dependence and so never saw these.
  // The matrix decides it outright: A's payoff is independent of B iff
  // a11 = a12 and a21 = a22, and within a stated row iff that row is flat.
  {
    const DEP_NEG = /\b(?:does\s*n[o']t|do\s*n[o']t|doesn['’]t|don['’]t|never|not|no)\s+(?:really\s+|actually\s+)?(?:depend|change|affect|matter|vary|shift)|\b(?:independent\s+of|regardless\s+of|no\s+matter\s+(?:what|which|whether)|unaffected\s+by|has\s+no\s+(?:effect|bearing|impact)|the\s+same\s+(?:either\s+way|regardless)|irrespective\s+of)\b/i;
    const DEP_POS = /\b(?:depend(?:s|ing)?\s+(?:only\s+|solely\s+|entirely\s+|just\s+)?on|affect(?:s|ing)?|influenc(?:es?|ing)|chang(?:es?|ing)\s+with|var(?:ies|ying)\s+with|hing(?:es?|ing)\s+on|is\s+driven\s+by|respond(?:s|ing)?\s+to|turn(?:s|ing)?\s+on)\b/i;
    // The subject must be a PAYOFF, not a choice or a preference.
    const SUBJ = /\b(?:player\s+)?([AB])['’]s\s+(?:expected\s+|final\s+|own\s+)?(?:payoffs?|earnings?|scores?|returns?|rewards?|winnings?)|\bwhat\s+(?:player\s+)?([AB])\s+(?:earns?|gets?|receives?|makes?|scores?|takes\s+home)\b/gi;
    const BOTH = /\bboth\s+(?:player\s+)?A['’]s\s+and\s+(?:player\s+)?B['’]s\s+(?:payoffs?|earnings?|scores?|returns?)|\bboth\s+players?['’]?\s+payoffs?\b/i;
    // Whose choice is doing the driving.
    const DRIVER = /\bwhat\s+(?:player\s+)?([AB])\s+(?:does|plays|chooses|picks)\b|\b(?:player\s+)?([AB])['’]s\s+(?:\w+\s+){0,2}(?:choice|action|move|decision|strategy|option|selection|play)\b|\bon\s+(?:player\s+)?([AB])\b/gi;
    const payA = (r: 1 | 2, c: 1 | 2) => cellAOf(g, r, c);
    const payB = (r: 1 | 2, c: 1 | 2) => cellBOf(g, r, c);
    // Scope stays at the SENTENCE, because the frame that pins the claim to a
    // row often sits in a leading clause ("When A plays Aggressive tags, B's
    // choice affects …" — C15 draw 56) and splitting on commas throws it away.
    // A self-contained "depends only on its own action" claim is judged first
    // and then EXCISED, so its negation cannot colour the rest of the sentence
    // (C16 draw 27 carried one claim of each polarity in one sentence).
    for (const rawSentence of text.split(/(?<=[.!?])\s+/)) {
      let sentence = rawSentence;
      // "X's payoff depends only on X's OWN action" is a two-sided claim: X's
      // payoff must vary with X's own choice AND be invariant to the opponent.
      const OWN = /\b(?:player\s+)?([AB])['’]s\s+(?:expected\s+)?(?:payoffs?|earnings?|scores?|returns?)\s+(?:depend(?:s|ing)?|rest(?:s|ing)?|rel(?:ies|ying))\s+(?:only|solely|entirely|purely|just)\s+on\s+(?:its|their|his|her|(?:player\s+)?[AB]['’]s)?\s*own\b[^.;,]{0,30}/i;
      for (const own of [OWN.exec(sentence)].filter(Boolean) as RegExpExecArray[]) {
        const who = own[1].toUpperCase() as 'A' | 'B';
        const oppMoves = who === 'A'
          ? (cellAOf(g, 1, 1) !== cellAOf(g, 1, 2) || cellAOf(g, 2, 1) !== cellAOf(g, 2, 2))
          : (cellBOf(g, 1, 1) !== cellBOf(g, 2, 1) || cellBOf(g, 1, 2) !== cellBOf(g, 2, 2));
        claimCount++;
        if (oppMoves) {
          issues.push(`prose says ${who}'s payoff depends only on ${who}'s own action, but the opponent's choice moves it: ${who === 'A' ? `row 1 pays ${cellAOf(g, 1, 1)} vs ${cellAOf(g, 1, 2)}` : `column 1 pays ${cellBOf(g, 1, 1)} vs ${cellBOf(g, 2, 1)}`}`);
        }
        sentence = sentence.replace(own[0], ' ');       // judged; excise so it cannot colour the rest
      }
      const neg = DEP_NEG.test(sentence);
      const pos = !neg && DEP_POS.test(sentence);
      if (!neg && !pos) continue;
      const subjects = new Set<'A' | 'B'>();
      for (const m of sentence.matchAll(SUBJ)) {
        const who = (m[1] ?? m[2] ?? '').toUpperCase();
        if (who === 'A' || who === 'B') subjects.add(who);
      }
      if (BOTH.test(sentence)) { subjects.add('A'); subjects.add('B'); }
      if (!subjects.size) continue;                       // a claim about a CHOICE, not a payoff — not ours
      const drivers = new Set<'A' | 'B'>();
      for (const m of sentence.matchAll(DRIVER)) {
        const who = (m[1] ?? m[2] ?? m[3] ?? '').toUpperCase();
        if (who === 'A' || who === 'B') drivers.add(who);
      }
      if (drivers.size !== 1) continue;                   // ambiguous driver: leave it alone
      const driver = [...drivers][0];
      // An optional stated context ("when A tags aggressively, …") pins the
      // driver's opposite axis to one row or column.
      const hits = findLabels(sentence, sets);
      const ctx = hits.find((h) => h.player !== driver);
      for (const subject of subjects) {
        // Does the DRIVER's choice move the SUBJECT's payoff?
        const varies = (fix?: 1 | 2): boolean => {
          if (driver === 'B') {
            const rows: (1 | 2)[] = fix ? [fix] : [1, 2];
            return rows.some((r) => (subject === 'A' ? payA(r, 1) !== payA(r, 2) : payB(r, 1) !== payB(r, 2)));
          }
          const cols: (1 | 2)[] = fix ? [fix] : [1, 2];
          return cols.some((c) => (subject === 'A' ? payA(1, c) !== payA(2, c) : payB(1, c) !== payB(2, c)));
        };
        const fixed = ctx && ctx.player !== driver ? ctx.option : undefined;
        const truth = varies(fixed);
        claimCount++;
        if (pos && !truth) {
          issues.push(`prose says ${driver}'s choice affects ${subject}'s payoff${fixed ? ` when the other option is fixed` : ''}, but ${subject}'s payoff is the same either way there`);
        } else if (neg && truth) {
          issues.push(`prose says ${subject}'s payoff does not depend on ${driver}, but it does: ${driver === 'B'
            ? `A's row 1 pays ${subject === 'A' ? `${payA(1, 1)} vs ${payA(1, 2)}` : `${payB(1, 1)} vs ${payB(1, 2)}`} across B's options`
            : `column 1 pays ${subject === 'A' ? `${payA(1, 1)} vs ${payA(2, 1)}` : `${payB(1, 1)} vs ${payB(2, 1)}`} across A's options`}`);
        }
      }
    }
  }

  // Three CLAIM-TYPE checks, decided from the matrix without needing to parse
  // which option the sentence means. Round L6 produced one of each, all in
  // games whose two players share their option words ("Bold launch" for both,
  // "Hunt Stag" for both) — precisely where label attribution gives up, so a
  // check that needs no label is the only one that can see them.
  {
    // (1) DOMINANCE named outright: "Pay Toll is A's dominant strategy" (L6
    //     draw 47, where Ford River dominates instead). Verified directly.
    const DOM = /\b(?:is|remains|stays|becomes)\s+(?:(?:player\s+)?([AB])['’]s\s+)?(?:the\s+|a\s+)?(?:strictly\s+|weakly\s+)?dominant(?:\s+strategy|\s+option|\s+choice|\s+move)?\b|\b(?:strictly\s+)?dominates\b/i;
    for (const sentence of text.split(/(?<=[.!?])\s+|;\s*/)) {
      const m = DOM.exec(sentence);
      if (!m) continue;
      if (/\b(?:no|not|never|neither|isn['’]t|nothing)\b/i.test(sentence.slice(0, m.index))) continue;
      const hits = findLabels(sentence, sets).filter((h) => h.index < (m.index ?? 0));
      if (!hits.length) continue;
      // "X does better whether B picks Early Shift or Late Shift, so it is A's
      // dominant strategy": the nearest label to the phrase is the OPPONENT's,
      // so the owner named in the phrase decides whose option is meant. With no
      // owner named ("Express Route dominates"), only an adjacent label counts.
      const named = (m[1] ?? '').toUpperCase();
      const owned = named === 'A' || named === 'B' ? hits.filter((h) => h.player === named) : hits;
      if (!owned.length) continue;
      // In a comparative ("Phased launch is better than Rapid launch … so it is
      // A's dominant strategy") the dominant option is the SUBJECT, the first
      // one named; taking the nearest label instead picks the option that was
      // just said to lose, which flagged 6 correct training golds.
      const comparative = /\b(?:better|beats?|outperforms?|stronger|higher|dominates?)\b[^.;]{0,60}?\bthan\b|\bprefers?\b[^.;]{0,60}?\b(?:to|over|rather\s+than|instead\s+of)\b/i.test(sentence);
      const claimed = comparative ? owned[0] : owned[owned.length - 1];
      if (!named && !comparative && (m.index ?? 0) - (claimed.index + claimed.length) > 6) continue;
      const owner = claimed.player;
      if (named && named !== owner) continue;                      // attribution disagrees — leave it
      const other = (3 - claimed.option) as 1 | 2;
      const dominates = owner === 'A'
        ? cellAOf(g, claimed.option, 1) > cellAOf(g, other, 1) && cellAOf(g, claimed.option, 2) > cellAOf(g, other, 2)
        : cellBOf(g, 1, claimed.option) > cellBOf(g, 1, other) && cellBOf(g, 2, claimed.option) > cellBOf(g, 2, other);
      claimCount++;
      if (!dominates) {
        issues.push(`prose calls ${owner}'s option ${claimed.option} dominant, but it is not: ${owner === 'A'
          ? `${cellAOf(g, claimed.option, 1)} vs ${cellAOf(g, other, 1)} and ${cellAOf(g, claimed.option, 2)} vs ${cellAOf(g, other, 2)}`
          : `${cellBOf(g, 1, claimed.option)} vs ${cellBOf(g, 1, other)} and ${cellBOf(g, 2, claimed.option)} vs ${cellBOf(g, 2, other)}`}`);
      }
    }
    // (2) INDIFFERENCE claimed at a NAMED PURE equilibrium (L6 draws 1 and 49:
    //     "In the bold launch equilibrium, Firm A is indifferent between its
    //     two launches", where A gets 8 against -7 there).
    //     A blanket "X is never indifferent" test was tried and REJECTED as
    //     unsound: a player IS indifferent against the opponent's equilibrium
    //     MIXTURE whenever a mixed equilibrium exists, so the claim is only
    //     decidable once the sentence pins it to a profile. Games whose two
    //     players share option words — exactly the ones label attribution gives
    //     up on — name that profile with a single word ("the Bold launch
    //     equilibrium"), which resolves it for both axes at once.
    const sharedOption = (word: string): 1 | 2 | null => {
      const w = word.trim();
      const hit = (lab?: string) => !!lab && new RegExp(`^(?:${labelPattern(lab)})$`, 'i').test(w);
      if (hit(labels?.row1) && hit(labels?.col1)) return 1;
      if (hit(labels?.row2) && hit(labels?.col2)) return 2;
      return null;
    };
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      const frame = /\b(?:in|at)\s+the\s+([\w' -]{2,30}?)\s+equilibrium\b/i.exec(sentence);
      if (!frame) continue;
      const opt = sharedOption(frame[1]);
      if (!opt) continue;
      if (/\b(?:mixed|mixing|probabilit\w*|randomi\w*)\b/i.test(sentence)) continue;
      for (const m of sentence.matchAll(/\b(?:player\s+|firm\s+|the\s+)?([AB])\b[^.;]{0,24}?\bis\s+indifferent\b/gi)) {
        const who = m[1].toUpperCase() as 'A' | 'B';
        if (/\b(?:not|never|isn['’]t|unless|whether)\b/i.test(sentence.slice(Math.max(0, (m.index ?? 0) - 24), m.index))) continue;
        claimCount++;
        const p1 = who === 'A' ? cellAOf(g, 1, opt) : cellBOf(g, opt, 1);
        const p2 = who === 'A' ? cellAOf(g, 2, opt) : cellBOf(g, opt, 2);
        if (p1 !== p2) {
          issues.push(`prose says ${who} is indifferent at the (${opt}, ${opt}) equilibrium, but ${who}'s two options pay ${p1} vs ${p2} there`);
        }
      }
    }
    // (3) GEOMETRY stated in prose: "the payoff surfaces are not warped by the
    //     other's choice" (L6 draw 20, where B's surface twists by 5). The
    //     model's geometryClaims are already checked against describeGeometry;
    //     this checks the SENTENCE, which is what the reader sees.
    const geo = describeGeometry(g);
    const interacts = Math.abs(geo.twistA) >= 1e-9 || Math.abs(geo.twistB) >= 1e-9;
    // Only GLOBAL non-interaction claims. "A's expected payoff is flat across
    // the actions along A's shelf" is a correct description of an equilibrium
    // shelf and must not be read as "the surfaces do not interact" (it flagged
    // a correct C12 prose when the wording was included).
    const FLAT = /\b(?:not\s+warped|no(?:t)?\s+(?:warp\w*|twist\w*)|no\s+interaction|do(?:es)?\s*n[o']t\s+interact|independent\s+surfaces?)\b/i;
    const SHELF = /\b(?:shelf|shelves|along|at\s+the\s+(?:mixed|equilibrium)|mixes?\s+at|when\s+B\s+mixes|when\s+A\s+mixes)\b/i;
    if (FLAT.test(text) && interacts && !SHELF.test(text)) {
      claimCount++;
      issues.push(`prose says the payoff surfaces do not interact, but they twist: twistA ${geo.twistA}, twistB ${geo.twistB}`);
    }
  }

  // BEST-RESPONSE dependence in PROSE. validateScenario has decided this shape
  // for story descriptions since round C4, but prose was never given the same
  // check, so "each player's best choice depends on the other" shipped on a
  // game where B's first column strictly dominates (C17 draw 20).
  {
    const domA = (cellAOf(g, 1, 1) > cellAOf(g, 2, 1) && cellAOf(g, 1, 2) > cellAOf(g, 2, 2))
      || (cellAOf(g, 2, 1) > cellAOf(g, 1, 1) && cellAOf(g, 2, 2) > cellAOf(g, 1, 2));
    const domB = (cellBOf(g, 1, 1) > cellBOf(g, 1, 2) && cellBOf(g, 2, 1) > cellBOf(g, 2, 2))
      || (cellBOf(g, 1, 2) > cellBOf(g, 1, 1) && cellBOf(g, 2, 2) > cellBOf(g, 2, 1));
    if (domA || domB) {
      const EACH_P = /\b(?:each|both|either)\s+(?:player|side|firm|party|agent|office|team)['’]?s?\s+["“”']?(?:best|better|optimal|preferred)\s+(?:response|reply|choice|move|option|action)["“”']?\s+(?:depends?|hinges?|turns?|varies|shifts?|changes?)\s+(?:on|with)\b|\bboth\s+players['’]?\s+incentives?\s+depend\s+on\b/i;
      const NEG_E = /\b(?:does\s+not|doesn['’]t|never|regardless|no\s+matter|whatever|independent|dominant)\b/i;
      for (const sentence of text.split(/(?<=[.!?])\s+|;\s*/)) {
        if (!EACH_P.test(sentence) || NEG_E.test(sentence)) continue;
        claimCount++;
        issues.push(`prose says each player's best choice depends on the other, but ${domA ? 'A' : 'B'} has a dominant strategy`);
        break;
      }
    }
  }

  // CELL PAYOFFS stated in free text and attached to the wrong opponent option
  // (C17 draw 77: "If A uses Tight inspections, it earns 7 against Community
  // ads and 2 against Permit checks" — those two numbers are swapped, and the
  // story's own cellCitations had them right). The frame fixes the player's own
  // option; each "N against <label>" then names a cell outright.
  {
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      const hits = findLabels(sentence, sets);
      if (hits.length < 2) continue;
      const frame = /\b(?:player\s+)?([AB])\b[^.;]{0,20}?\b(?:uses?|plays?|chooses?|picks?|selects?)\s+/i.exec(sentence);
      if (!frame) continue;
      const who = frame[1].toUpperCase() as 'A' | 'B';
      const ownHit = hits.find((h) => h.player === who && h.index >= (frame.index ?? 0));
      if (!ownHit) continue;
      // "against" only. "Col 2 pays 1 vs Col 1 pays 0" compares a player's OWN
      // two options, so reading "vs" as an opponent frame turns a correct
      // sentence into a false cell claim (it flagged a correct C11 prose).
      for (const m of sentence.matchAll(/\b(?:earns?|gets?|receives?|scores?|takes?|makes?|pays?)\s+(-?\d+(?:\.\d+)?)\s+(?:against|facing|under)\s+/gi)) {
        const at = (m.index ?? 0) + m[0].length;
        const opp = hits.find((h) => h.player !== who && h.index >= at - 2 && h.index <= at + 3);
        if (!opp) continue;
        const claimed = Number(m[1]);
        const actual = who === 'A' ? cellAOf(g, ownHit.option, opp.option) : cellBOf(g, opp.option, ownHit.option);
        claimCount++;
        if (Math.abs(actual - claimed) > 1e-9) {
          issues.push(`prose says ${who} earns ${claimed} with option ${ownHit.option} against opponent option ${opp.option}, but that cell pays ${actual}`);
        }
      }
    }
  }

  // NOT IMPLEMENTED — "the contractor chooses Silence while the inspector
  // chooses Silence", where Silence is only A's option (L7 draw 60). Four
  // successive tightenings of a same-player-profile screen each still flagged
  // correct golds (69, then 12, then 4): a sentence naming one player's options
  // twice is normally a legitimate comparison, and the malformed case is only
  // distinguishable once the ROLE NOUNS are mapped to players — which this
  // scenario did not declare (actorA/actorB were null on all 40 stories).
  // Left open deliberately rather than shipped with a false-positive cost; the
  // fix is to make the model declare its actors, not to guess from the text.

  // EXPLICIT-PLAYER preference. "if B takes Take South Road, A's best reply is
  // Take South Road" (C19 draw 66) is unreadable to the label-aware parser
  // because both players share their option words, so the labels are dropped —
  // yet each label is unambiguous once you read the player named in its own
  // clause. Same technique that already works for profiles.
  {
    const optOf = (player: 'A' | 'B', word: string): 1 | 2 | null => {
      const w = word.trim();
      const cands: [1 | 2, string | undefined][] = player === 'A'
        ? [[1, labels?.row1], [2, labels?.row2], [1, 'Row 1'], [2, 'Row 2']]
        : [[1, labels?.col1], [2, labels?.col2], [1, 'Col 1'], [2, 'Col 2']];
      for (const [o, lab] of cands) if (lab && new RegExp(`^(?:${labelPattern(lab)})$`, 'i').test(w)) return o;
      return null;
    };
    const VERB = String.raw`(?:choos\w*|us\w*|play\w*|pick\w*|select\w*|takes?|taking|hunts?|goes?\s+(?:with|for)|opts?\s+for|backs?|sides?\s+with|prefers?|favou?rs?|does\s+better\s+(?:with|by\s+choosing)|is\s+better\s+off\s+(?:with|choosing))`;
    const BEST = String.raw`(?:best|better|optimal|preferred)\s+(?:reply|response|choice|move|option|action)\s+(?:is|becomes|would\s+be)`;
    const CLAUSE = new RegExp(String.raw`\b(?:player\s+)?([AB])\b\s*(?:['’]s\s+${BEST}|${VERB})\s+(?:the\s+|an?\s+)?([\w' -]{2,40}?)\s*(?=,|;|\.|\band\b|\bwhile\b|\bthen\b|\bso\b|$)`, 'gi');
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      if (/\b(?:probabilit\w*|mix\w*|randomi\w*|equilibri(?:um|a))\b/i.test(sentence)) continue;   // profiles and mixtures are other checks
      const found: { player: 'A' | 'B'; option: 1 | 2; isBest: boolean; index: number }[] = [];
      for (const m of sentence.matchAll(CLAUSE)) {
        const player = m[1].toUpperCase() as 'A' | 'B';
        const opt = optOf(player, m[2]);
        // "prefers" does not contain "preferred": the preference verbs added to
        // VERB were invisible to this test, so the claim was parsed and then
        // discarded for want of a subject.
        if (opt) found.push({ player, option: opt, isBest: /best|better|optimal|prefer|favou?r/i.test(m[0]), index: m.index ?? 0 });
      }
      // EVERY best-reply clause in the sentence, not just the first: the local
      // model writes "A prefers launching A against B launching A and launching
      // B against B launching B", two claims in one sentence, and judging only
      // the first let the second ship (all four of L11's seeded defects).
      // ELIDED-SUBJECT CONTINUATIONS WERE TRIED AND REVERTED. The local model
      // writes "A prefers Launch A against Launch A and Launch B against Launch
      // A", where the second claim drops the subject. Gathering those
      // continuations and inheriting the player flagged 51 training golds and
      // broke an existing character test, and it still did not catch the target
      // sentence. The multi-claim reach gap stays open; a sentence-splitting
      // parser, not another regex, is what this needs.
      // ONLY the first best-reply clause is judged. Judging every one flagged
      // 58 golds, because a sentence like "Against Signal, A prefers the Direct
      // Route; against Silence, A prefers the Detour, while B prefers …" needs
      // each claim matched to ITS OWN frame, and a nearest-frame heuristic pairs
      // later claims with earlier frames. Correct segmentation, not a wider
      // regex, is the fix; the reach gap is documented and left open.
      const best = found.find((f) => f.isBest);
      if (best) {
      // The frame is the FIRST opponent clause in the sentence, not the nearest
      // one after the claim: "if B takes Harbor, A prefers Upland, but if B
      // takes Upland, A prefers Harbor" states the frame BEFORE its claim, and
      // preferring a later frame pairs the first claim with the second frame
      // (8 training golds).
      let frame = found.find((f) => !f.isBest && f.player !== best.player);
      // The frame often names no player at all — "Against Hunt Hare, A prefers
      // Hunt Stag". In a game where both players share option words the OPTION
      // INDEX is still unambiguous (the same words in the same order for both),
      // so the opponent's option resolves even though the owner is unstated.
      if (!frame) {
        const other = best.player === 'A' ? 'B' : 'A';
        const m = new RegExp(String.raw`\b(?:against|versus|vs\.?|facing|when|if)\s+(?:the\s+|an?\s+)?([\w' -]{2,40}?)\s*(?=,|;|\.|\band\b|\bwhile\b|$)`, 'i').exec(sentence);
        const opt = m ? optOf(other, m[1]) : null;
        if (opt) frame = { player: other, option: opt, isBest: false, index: m?.index ?? 0 };
      }
      if (!frame) continue;
      claimCount++;
      const own = best.option, opp = frame.option;
      const mine = best.player === 'A' ? cellAOf(g, own, opp) : cellBOf(g, opp, own);
      const alt = best.player === 'A' ? cellAOf(g, (3 - own) as 1 | 2, opp) : cellBOf(g, opp, (3 - own) as 1 | 2);
      if (alt > mine) {
        issues.push(`prose says ${best.player}'s best reply to opponent option ${opp} is option ${own}, but that pays ${mine} against ${alt}`);
      }
      }
    }
  }

  // A payoff pair welded into a comparison and attached to a column: "it earns
  // 5 rather than 2 against Fast Track and 2 rather than 2 against Full Review"
  // (L8 draw 67 — the second pair is false and self-contradictory). The
  // existing cell check reads "N against X" but not the "N rather than M" weld.
  {
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      const hits = findLabels(sentence, sets);
      if (!hits.length) continue;
      // The verb is stated once and ELIDED in the second pair: "it earns 5
      // rather than 2 against Fast Track AND 2 rather than 2 against Full
      // Review". The rule first shipped requiring the verb every time, so it
      // missed the exact sentence it was written for — my regression test had
      // paraphrased the defect and restored the verb.
      for (const m of sentence.matchAll(/(?:\b(?:earns?|gets?|pays?|scores?|receives?|yields?|gives?)\s+|\band\s+)(-?\d+(?:\.\d+)?)\s+(?:rather\s+than|instead\s+of|over|vs\.?|versus|not)\s+(-?\d+(?:\.\d+)?)\s+(?:against|facing|under)\s+/gi)) {
        const at = (m.index ?? 0) + m[0].length;
        const opp = hits.find((h) => h.index >= at - 2 && h.index <= at + 3);
        if (!opp) continue;
        // Which own-option is the sentence about? Normally the NEAREST preceding
        // label — "Bold pays 7 … while Steady pays 3 …" carries two welds and
        // the first label would score the second weld against Bold. But in a
        // COMPARATIVE the subject leads and a pronoun carries it: "B prefers the
        // Priority Contract to the Basic Contract: it pays 8 rather than 5 …"
        // means Priority, not the nearer Basic. Same trap as the dominance rule.
        const ownHits = hits.filter((h) => h.player !== opp.player && h.index < (m.index ?? 0));
        const comparativeLead = /\b(?:prefers?|favou?rs?)\b[^.;]{0,60}?\b(?:to|over|rather\s+than|instead\s+of)\b|\bis\s+better\s+than\b/i.test(sentence)
          && /\bit\s+(?:pays?|earns?|gets?|yields?|scores?)\b/i.test(sentence);
        const own = comparativeLead ? ownHits[0] : ownHits.pop();
        if (!own) continue;
        const better = Number(m[1]), worse = Number(m[2]);
        const mine = own.player === 'A' ? cellAOf(g, own.option, opp.option) : cellBOf(g, opp.option, own.option);
        const alt = own.player === 'A' ? cellAOf(g, (3 - own.option) as 1 | 2, opp.option) : cellBOf(g, opp.option, (3 - own.option) as 1 | 2);
        claimCount++;
        if (Math.abs(mine - better) > 1e-9 || Math.abs(alt - worse) > 1e-9) {
          issues.push(`prose says ${own.player}'s option ${own.option} earns ${better} rather than ${worse} against opponent option ${opp.option}, but those cells pay ${mine} and ${alt}`);
        }
      }
    }
  }

  // ZERO-SUM value signs: the two players' values must sum to zero, so a
  // sentence crediting both sides the SAME value has a sign wrong (L8 draw 65:
  // "the patrol's value of 1 and the smuggler's of 1").
  {
    const zeroSum = [[1, 1], [1, 2], [2, 1], [2, 2]].every(([r, c]) =>
      Math.abs(cellAOf(g, r as 1 | 2, c as 1 | 2) + cellBOf(g, r as 1 | 2, c as 1 | 2)) < 1e-9);
    if (zeroSum) {
      for (const sentence of text.split(/(?<=[.!?])\s+/)) {
        if (!/\b(?:value|minimax|payoffs?)\b/i.test(sentence)) continue;
        // The owner is a SHORT noun phrase of letters only. A charset that
        // allowed spaces and digits spanned "A's payoff is -9 and B" and read
        // that whole run as one owner, flagging a correct zero-sum story.
        const owned = [...sentence.matchAll(/\b(?:the\s+)?([A-Za-z][A-Za-z-]{0,18}(?:\s+[A-Za-z][A-Za-z-]{0,18})?)(?:['’]s)\s+(?:(?:expected\s+)?(?:value|payoff|score)\s+)?(?:of|is|=)\s*(-?\d+(?:\.\d+)?)/gi)]
          .map((m) => ({ who: m[1].trim().toLowerCase(), n: Number(m[2]) }));
        const distinct = owned.filter((o, i) => owned.findIndex((q) => q.who === o.who) === i);
        if (distinct.length !== 2) continue;
        claimCount++;
        if (Math.abs(distinct[0].n + distinct[1].n) > 1e-9) {
          issues.push(`prose gives ${distinct[0].who} ${distinct[0].n} and ${distinct[1].who} ${distinct[1].n} in a zero-sum game, where the two values must sum to zero`);
        }
      }
    }
  }

  // The game's CHARACTER — coordination vs anti-coordination — stated backwards.
  // This was 3 of C19's 4 wrong-shown and 4 of C18's 6, and the earlier repair
  // (more verbs for the profile parse) could not reach it, because the claim is
  // carried by a summary NOUN: "two coordination equilibria", "they fully
  // coordinate", "the strategic trade-off is coordination". Decided only when
  // the game HAS pure equilibria and they all sit on one diagonal, so the
  // character is unambiguous; games with mixed or no pure equilibria are left
  // alone (coordination framing has produced false positives before).
  {
    const pure = computeAllNE(g).filter((t) => t.type === 'pure');
    const diag = pure.filter((t) => (t.x === 1 && t.y === 1) || (t.x === 0 && t.y === 0)).length;
    const anti = pure.filter((t) => (t.x === 1 && t.y === 0) || (t.x === 0 && t.y === 1)).length;
    // "Coordination" only means something when the two players have the SAME
    // options to coordinate on. With disjoint labels (North/South vs West/East)
    // the diagonal is an artifact of the order the options happen to be listed
    // in, and "these alternatives reflect a coordination tension" is a fair
    // description of any two-equilibrium game — it flagged a training gold.
    const norm = (x?: string) => (x ?? '').trim().toLowerCase();
    const aOpts = [norm(labels?.row1), norm(labels?.row2)].filter(Boolean).sort();
    const bOpts = [norm(labels?.col1), norm(labels?.col2)].filter(Boolean).sort();
    const sharedOptions = aOpts.length === 2 && bOpts.length === 2 && aOpts[0] === bOpts[0] && aOpts[1] === bOpts[1];
    // The pure-equilibrium test cannot see a game with NO pure equilibrium —
    // C24 draw 24 shipped a false coordination claim on exactly that (a
    // zero-sum game). Best replies are defined for every game: A MATCHES when
    // its best reply mirrors B's option and MISMATCHES when it opposes.
    const brA1 = cellAOf(g, 1, 1) > cellAOf(g, 2, 1) ? 1 : cellAOf(g, 1, 1) < cellAOf(g, 2, 1) ? 2 : 0;
    const brA2 = cellAOf(g, 1, 2) > cellAOf(g, 2, 2) ? 1 : cellAOf(g, 1, 2) < cellAOf(g, 2, 2) ? 2 : 0;
    const brB1 = cellBOf(g, 1, 1) > cellBOf(g, 1, 2) ? 1 : cellBOf(g, 1, 1) < cellBOf(g, 1, 2) ? 2 : 0;
    const brB2 = cellBOf(g, 2, 1) > cellBOf(g, 2, 2) ? 1 : cellBOf(g, 2, 1) < cellBOf(g, 2, 2) ? 2 : 0;
    const aMatches = brA1 === 1 && brA2 === 2, aMismatches = brA1 === 2 && brA2 === 1;
    const bMatches = brB1 === 1 && brB2 === 2, bMismatches = brB1 === 2 && brB2 === 1;
    const allMatching = sharedOptions && ((pure.length >= 2 && diag === pure.length) || (aMatches && bMatches));
    const allMismatching = sharedOptions && ((pure.length >= 2 && anti === pure.length) || (aMismatches && bMismatches));
    // THE NO-PURE FAMILY. A previous attempt at this ("neither player matches")
    // was UNREACHABLE: with no pure equilibrium neither player has a dominant
    // strategy, so each best reply either matches or mismatches, and the
    // best-reply cycle forces EXACTLY ONE of each — verified on 30,388 sampled
    // games, zero hits (round C25 proved it structurally, not statistically).
    // What IS decidable: a game with no pure equilibrium has no coordination
    // EQUILIBRIA, so a claim about the game or its equilibria is false. Claims
    // about a player's motive ("A wants to coordinate on Stag") stay untouched,
    // because in this family exactly one player really is a matcher.
    const noPure = sharedOptions && pure.length === 0;
    if (allMatching || allMismatching || noPure) {
      // (?<!anti[- ]) is load-bearing: without it "anti-coordination" contains
      // "coordination", and this check — written to catch a FALSE character
      // claim — suppressed the TRUE one (found by round L9 probing the very
      // word the pattern is built from).
      // The adjacency also has to be loose: C20 shipped "both hunters to
      // coordinate" and "reflect perfect coordination", both near-misses of a
      // tight pattern.
      const COORD = /(?<!anti[- ])\b(?:coordinat(?:ion|ed|ive)\s+(?:equilibri(?:um|a)|game|problem|outcomes?|corners?|succeeds?|works?|holds?|type|style|like|pair(?:ing)?s?|trade-?offs?|tensions?|on\b|benefits?|gains?)|(?:are|is|were|was|both)\s+coordinat(?:ed|ive)|(?:fully|successfully|perfectly|both)\s+(?:\w+\s+){0,3}?coordinat\w+|coordinate\s+on|trade-?off\s+is\s+coordination|(?:reflect|show|represent|mean)s?\s+(?:\w+\s+){0,2}?coordination|(?:perfect|complete|full|total)\s+coordination|matching\s+equilibri(?:um|a)|both\s+(?:players|sides|firms|hunters)\s+choose\s+the\s+same)\b/i;
      const ANTI = /\b(?:anti[- ]?coordination|mismatch\w*\s+(?:equilibri(?:um|a)|outcomes?|corners?)|opposite\s+choices|must\s+differ|choose\s+differently)\b/i;
      // The negation must attach to the CHARACTER claim, not merely appear in
      // the sentence: C21 draw 66 shipped a false coordination claim whose
      // sentence also said the players "prefer not to deviate", and a
      // sentence-wide guard threw the true flag away.
      const NEG = /\b(?:not|never|no|isn['’]t|aren['’]t|rather\s+than|instead\s+of|despite|hardly|far\s+from|anything\s+but|nothing\s+like)\s+(?:\w+\s+){0,2}?(?:coordinat\w*|match\w*|mismatch\w*|anti-?coordination)/i;
      // Four of C22's five defects were this ONE rule losing to typography:
      // "coordinated", "coordination-type", "coordination-style" and curly
      // quotes around "coordination" all reached the screen. Normalising quotes
      // and hyphens before matching costs nothing and closes all four at once.
      // Normalisation has now cut BOTH ways and each direction was found by a
      // round rather than by me:
      //   - deleting apostrophes turned "isn't" into "isnt", so the negation
      //     guard stopped matching and a TRUE "this isn't a coordination game"
      //     was withheld (C23);
      //   - turning every hyphen into a space split "co-ordination" into
      //     "co ordination", invisible to a rule matching "coordination" (L12).
      // So: quotation marks are dropped, curly apostrophes are mapped to
      // straight ones rather than deleted, and BOTH hyphen readings are tested —
      // hyphen-as-space for "coordination-style", hyphen-as-nothing for
      // "co-ordination". A sentence is judged if EITHER reading trips the rule,
      // and exempted if EITHER reading trips the negation guard.
      const base = (t: string) => t.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d"]/g, '');
      const variants = (t: string) => {
        const b = base(t);
        return [b.replace(/[-\u2010-\u2015]/g, ' ').replace(/\s+/g, ' '), b.replace(/[-\u2010-\u2015]/g, '')];
      };
      for (const raw of text.split(/(?<=[.!?])\s+/)) {
        const forms = variants(raw);
        if (forms.some((f) => NEG.test(f))) continue;
        const GAME_LEVEL = /(?<!anti[- ])\b(?:coordinat(?:ion|ed|ive)\s+(?:equilibri(?:um|a)|game|problem|outcomes?|corners?|pair(?:ing)?s?)|matching\s+equilibri(?:um|a))\b/i;
        if (noPure && forms.some((f) => GAME_LEVEL.test(f))) {
          claimCount++;
          issues.push(`prose calls this a coordination game, but it has no pure equilibrium at all`);
          break;
        }
        if (allMismatching && forms.some((f) => COORD.test(f))) {
          claimCount++;
          issues.push(`prose calls this a coordination game, but every pure equilibrium sits on a MISmatched pair`);
          break;
        }
        if (allMatching && forms.some((f) => ANTI.test(f))) {
          claimCount++;
          issues.push(`prose calls this an anti-coordination game, but every pure equilibrium sits on a matching pair`);
          break;
        }
      }
    }
  }

  // A stated SPLIT must sum to 1. C20 draw 72 shipped "B uses the same
  // two-fifths/two-fifths split", which is 4/5 of a probability distribution —
  // decidable without knowing which option is which, so it works even in games
  // where both players share their option words.
  {
    const WORDF: Record<string, number> = { half: 0.5, third: 1 / 3, quarter: 0.25, fifth: 0.2, sixth: 1 / 6, eighth: 0.125, tenth: 0.1 };
    const NUMW: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
    const one = String.raw`(?:(one|two|three|four|five|six|seven|eight|nine)[-\s])?(half|third|quarter|fifth|sixth|eighth|tenth)s?`;
    const parse = (n: string | undefined, unit: string) => (n ? NUMW[n.toLowerCase()] : 1) * WORDF[unit.toLowerCase()];
    const SPLIT = new RegExp(String.raw`\b${one}\s*(?:/|\s+(?:and|to|vs\.?|versus)\s+)\s*${one}\s+(?:split|mix|mixture|odds)\b`, 'gi');
    for (const m of text.matchAll(SPLIT)) {
      const a = parse(m[1], m[2]), b = parse(m[3], m[4]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      claimCount++;
      if (Math.abs(a + b - 1) > 1e-6) {
        issues.push(`prose states a ${m[0].trim()} whose two probabilities sum to ${(a + b).toFixed(3)}, not 1`);
      }
    }
  }

  // A player's two stated probabilities must sum to 1. The word-fraction form
  // is checked above; this is the DECIMAL form, and it catches a typo class the
  // per-label probability check cannot: C21 draw 59 shipped "Pay Toll with
  // probability 0.9412 and Ford River with probability 0.0598", where each
  // number is close enough to an equilibrium value to pass individually but the
  // pair sums to 1.001. Only judged when both numbers attach to the SAME
  // player's two options, so a cross-player pair is never added up.
  {
    const PAIR = /\bwith\s+probability\s+(0?\.\d+|1(?:\.0+)?|0)\b[^.;]{0,40}?\band\b[^.;]{0,40}?\bwith\s+probability\s+(0?\.\d+|1(?:\.0+)?|0)\b/gi;
    for (const sentence of text.split(/(?<=[.!?])\s+|;\s*/)) {
      for (const m of sentence.matchAll(PAIR)) {
        const hits = findLabels(sentence, sets).filter((h) => h.index >= (m.index ?? 0) - 40 && h.index <= (m.index ?? 0) + m[0].length);
        let players = new Set(hits.map((h) => h.player));
        let options = new Set(hits.map((h) => h.option));
        // On games where both players share option words the scenario labels are
        // dropped as ambiguous, so there are no hits and this check quietly did
        // NOTHING — in exactly the games where every mixture defect of the
        // campaign has occurred (found by round L13). When the sentence names
        // the player, its own two options resolve unambiguously.
        if (!players.size) {
          const named = /\b(?:player\s+|firm\s+)?([AB])\s+(?:plays?|uses?|chooses?|picks?|mixes?)\b/i.exec(sentence);
          const who = named?.[1]?.toUpperCase() as 'A' | 'B' | undefined;
          if (who) {
            const own = who === 'A' ? [labels?.row1, labels?.row2] : [labels?.col1, labels?.col2];
            const seen = new Set<1 | 2>();
            own.forEach((lab, i) => { if (lab && new RegExp(labelPattern(lab), 'i').test(sentence)) seen.add((i + 1) as 1 | 2); });
            if (seen.size === 2) { players = new Set([who]); options = seen; }
          }
        }
        if (players.size !== 1 || options.size !== 2) continue;      // must be ONE player's TWO options
        const a = Number(m[1]), b = Number(m[2]);
        claimCount++;
        if (Math.abs(a + b - 1) > 5e-4) {
          issues.push(`prose gives ${[...players][0]}'s two options probabilities ${a} and ${b}, which sum to ${(a + b).toFixed(4)}, not 1`);
        }
      }
    }
  }

  // RUNG 2's NUMBER-COVERAGE CHECK WAS BUILT AND REVERTED (round C27).
  // The premise was that a number cannot be paraphrased, so checking that every
  // figure in the prose EXISTS in the game would resist the synonym evasion that
  // defeated rung 1. Measured live it was worthless and harmful:
  //   catch rate on numeric defects 0/1, live precision 0/2, and it CAUSED TWO
  //   CORRECT-WITHHELD — supplied option labels carrying a numeral ("Pay 60
  //   Credits", "Bid 12") are not game figures, so it suppressed two entirely
  //   true paragraphs.
  // The reason it caught nothing is the important part: the defects are not
  // INVENTED figures, they are correctly-valued figures attached to the WRONG
  // CLAIM. The round's one numeric defect said "Row 2 with probability 0" where
  // the dominant row carries 1 — both 0 and 1 are legitimate figures for that
  // game, so existence-checking can never see it. Assignment, not existence, is
  // where the error lives, and assignment cannot be checked without reading the
  // sentence — which is the hard problem rung 2 was meant to sidestep.
  // It also had a 28% blind spot: a sentence-final figure was never scanned,
  // because the regex lookahead rejects a digit followed by a full stop.

  // Tie LOCATION ("it ties A when B chooses Targeted", "the organizer is tied
  // to the Main Stage when the manager chooses the Evening Show", "with Local
  // route, A is tied between the two repairs" — L4 draws 4, 5, 11x2, 7b). The
  // model routinely has the tie and the strict preference both right in its
  // declarations and then attaches the word to the wrong column, often
  // contradicting the next clause. Read CLAUSE by clause (a neighbouring
  // clause's "against X" is not this clause's frame), with the frame allowed on
  // either side of the tie word.
  {
    const TIE_WORD = /\b(?:ties?|tied|breaks?\s+even|equally\s+good|no\s+different|the\s+same\s+(?:payoff|score|amount|return)s?)\b/i;
    const FRAME = /\b(?:when|if|against|versus|vs\.?|facing|whenever|with)\b/gi;
    const MIXY = /\b(?:probabilit\w*|mix\w*|randomi\w*|indifferent\s+between|so\s+that|leaves?|holds?|keeps?|makes?|renders?)\b|\d\.\d|%/i;
    for (const clause of text.split(/(?<=[.!?])\s+|;\s*|,\s*(?=while\b|whereas\b|but\b)|\bbut\b|\bwhile\b|\bwhereas\b/i)) {
      const tie = TIE_WORD.exec(clause);
      if (!tie || MIXY.test(clause)) continue;
      // "away from those ties", "these ties make several corners stable": the
      // word is a NOUN referring back to ties already established, not a claim
      // that a tie sits at the option this clause frames.
      if (/(?:\b(?:those|these|such|the|its|his|her|their|both|two|no|any|of|from|beyond)\s+)$/i.test(clause.slice(0, tie.index ?? 0))) continue;
      const hits = findLabels(clause, sets);
      if (!hits.length) continue;
      // Frame → the option it names: the label starting within ~25 chars after it.
      const framed: { hit: LabelHit; at: number }[] = [];
      for (const f of clause.matchAll(FRAME)) {
        const fEnd = (f.index ?? 0) + f[0].length;
        const h = hits.find((x) => x.index >= fEnd - 1 && x.index <= fEnd + 25);
        if (h) framed.push({ hit: h, at: f.index ?? 0 });
      }
      if (!framed.length) continue;
      const tieAt = tie.index ?? 0;
      framed.sort((x, y) => Math.abs(x.at - tieAt) - Math.abs(y.at - tieAt));
      const opp = framed[0].hit;
      // Who is tied: an explicit player letter next to the tie word wins, then
      // the nearest label belonging to the other player, then the complement.
      // Letters inside the framed phrase ("when B chooses Targeted") name the
      // OPPONENT, not the tied player; the tied player is the nearest letter
      // outside it — subject before the verb ("A gains nothing … its two plans
      // tie") or object right after it ("it ties A when …").
      const frameStart = framed[0].at, frameEnd2 = framed[0].hit.index + framed[0].hit.length;
      let letter: 'A' | 'B' | undefined;
      let bestD = Infinity;
      for (const lm of clause.matchAll(/\b(?:player\s+)?([AB])\b/g)) {
        const at = lm.index ?? 0;
        if (at >= frameStart && at <= frameEnd2) continue;
        const d = Math.abs(at - tieAt);
        if (d < bestD) { bestD = d; letter = lm[1] as 'A' | 'B'; }
      }
      // A named player that IS the framed player means the clause is talking
      // about that player's own options ("once B does so A gains nothing by
      // switching because its two plans tie" frames A) — not a claim about the
      // opponent, and not resolvable here; leave it alone rather than guess.
      if (letter && letter === opp.player) continue;
      const others = hits.filter((h) => h.player !== opp.player && h !== opp);
      const who: 'A' | 'B' = letter ?? (others.length ? others[others.length - 1].player : (opp.player === 'A' ? 'B' : 'A'));
      if (who === opp.player) continue;
      claimCount++;
      const p1 = who === 'A' ? cellAOf(g, 1, opp.option) : cellBOf(g, opp.option, 1);
      const p2 = who === 'A' ? cellAOf(g, 2, opp.option) : cellBOf(g, opp.option, 2);
      if (Math.abs(p1 - p2) > 1e-9) {
        issues.push(`prose says ${who} ties against opponent option ${opp.option}, but ${who}'s two options pay ${p1} vs ${p2} there — a strict preference`);
      }
    }
  }

  const sentences = text.split(/(?<=[.!?])\s+|;\s+/);
  for (const sentence of sentences) {
    // Profile-level equilibrium claims: "the equilibrium has A choose X and
    // B choose Y", "one equilibrium representative is A using Row 2 and B
    // using Col 1", "two pure equilibria: X with Y, and Z with W" (C1 draws
    // 23/36). Every (row, col) pair the sentence presents as an equilibrium
    // must be one. Only explicit pair forms are read — a label of each player
    // joined by with/and/while (optionally "B chooses"), no list comma between
    // them, no best-reply framing, in a sentence that is not a negation.
    if (/\b(?:equilibri(?:um|a)|stable\s+(?:corner|outcome|pair)s?|rests?\s+at|settles?\s+(?:at|on)|coordination|coordinate\s+on|corner)\b/i.test(sentence)
      && !/\b(?:no|not|never|isn['’]t|aren['’]t|fails?|would\s+not|cannot|can['’]t|neither|away\s+from)\b/i.test(sentence)
      // A MIXTURE sentence names one option of each player too ("B plays Col 2
      // while A plays Row 1 with any probability from 0 to 0.125") and is not a
      // claim that the pure pair is an equilibrium. Without this the check
      // withholds correct descriptions of equilibrium continua and of ordinary
      // mixed equilibria — a correct-withheld, the costliest kind of error.
      && !/\b(?:probabilit\w*|mixes|mixture|mixing|randomi\w*|any\s+probability|weight\w*|percent\w*|of\s+the\s+time)\b/i.test(sentence)) {
      const sh = findLabels(sentence, sets);
      const PAIR_JOIN = /^\s*(?:with|and|while|&|\+|paired\s+with|alongside|[–—/-])\s*(?:the\s+|an?\s+)?(?:(?:player\s+)?[AB]\s+|(?:player\s+)?[AB]['’]s\s+|the\s+\w+\s+)?(?:(?:choos|us|play|pick|select|tak|adopt|go)\w*\s+(?:the\s+|an?\s+|with\s+)?)?$/i;
      for (let k = 0; k + 1 < sh.length; k++) {
        const a = sh[k], b = sh[k + 1];
        if (a.player === b.player) continue;
        const between = sentence.slice(a.index + a.length, b.index);
        if (between.length > 45 || !PAIR_JOIN.test(between)) continue;
        // The first label must itself be an outcome word's object, not a frame:
        // "… A chooses X and B chooses Y" / "… : X with Y" — not "against X and Y".
        const beforeA = sentence.slice(Math.max(0, a.index - 30), a.index);
        if (/\b(?:against|versus|vs\.?|when|if|whether|prefers?|favou?rs?|better|best|between)\b[^,;:]*$/i.test(beforeA)) continue;
        const row = (a.player === 'A' ? a : b).option, col = (a.player === 'B' ? a : b).option;
        if (!isPureNE(row, col)) {
          issues.push(`prose presents (Row ${row}, Col ${col}) as an equilibrium, but it is not: A pays ${cellAOf(g, row, col)} vs ${cellAOf(g, (3 - row) as 1 | 2, col)} switching rows, B pays ${cellBOf(g, row, col)} vs ${cellBOf(g, row, (3 - col) as 1 | 2)} switching columns`);
        }
        k++; // a pair consumes both labels: "X with Y and Z with W" never pairs Y with Z
      }
    }
    const clauses = sentence.split(/\s+(?:while|whereas)\s+/i);
    for (const clause of clauses) {
      if (DEVIATE_RE.test(clause)) continue;
      const hits = findLabels(clause, sets);
      if (!hits.length) continue;

      // Indifference: "indifferent between X and Y [against/when/whether Z]".
      // Indifference INDUCED by the opponent's mixture ("A mixes at 0.25 so
      // that B is indifferent between …", "B's mix leaves A indifferent") is
      // a statement about the equilibrium, not about a pure opponent option —
      // skipped, never judged against a single column/row.
      const MIXING = /\b(?:probabilit\w*|mix\w*|randomi\w*|odds|fraction\w*|percent\w*|half|third|quarter|so\s+that|makes?|leaves?|holds?|keeps?|renders?)\b|\d\.\d|%/i;
      const ind = INDIFF.exec(clause);
      if (ind && MIXING.test(clause)) continue;
      if (ind) {
        claimCount++;
        const after = hits.filter((h) => h.index > ind.index + ind[0].length);
        const own = after.filter((h) => h.player === after[0]?.player).slice(0, 2);
        const adjacent = own.length === 2
          && /^\s*(?:the\s+|an?\s+|its\s+)?$/i.test(clause.slice(ind.index + ind[0].length, own[0].index))
          && /^\s*(?:,\s*)?(?:and|or)\s+(?:the\s+|an?\s+)?$/i.test(clause.slice(own[0].index + own[0].length, own[1].index));
        if (adjacent && own[0].option !== own[1].option) {
          const player = own[0].player;
          // Opponent frame for the indifference claim: from the second own
          // label to the next separator (a later "but prefers X against Y"
          // is a different claim).
          const winStart = own[1].index + own[1].length;
          const rest = clause.slice(winStart);
          const sep = SEP.exec(rest)?.index ?? rest.length;
          const winEnd = winStart + sep;
          const leadText = clause.slice(0, ind.index);
          const leadCut = Math.max(leadText.lastIndexOf(' but '), leadText.lastIndexOf(' and '), leadText.lastIndexOf('; '), leadText.lastIndexOf(' while '));
          const leadOppsI = hits.filter((h) => h.player !== player && h.index > leadCut && h.index < ind.index).map((h) => h.option);
          const trailOppsI = hits.filter((h) => h.player !== player && h.index >= winStart && h.index < winEnd).map((h) => h.option);
          const opps = leadOppsI.length ? leadOppsI : trailOppsI;
          const targets: (1 | 2)[] = opps.length ? [...new Set(opps)] : (BOTH_WAYS.test(rest.slice(0, sep)) ? [1, 2] : []);
          for (const opp of targets) {
            if (payoff(player, 1, opp) !== payoff(player, 2, opp)) {
              issues.push(`prose says ${player} is indifferent against opponent option ${opp}, but ${describe(player, 1, opp)} — a strict preference`);
            }
          }
        }
        continue;
      }

      // Claim anchors: a label next to a preference verb, or an elliptical
      // continuation ("… but Y against Q", "… but Y or Z against Q").
      const claims: Claim[] = [];
      for (const h of hits) {
        const before = clause.slice(0, h.index);
        const afterText = clause.slice(h.index + h.length);
        const tail = before.slice(-40);
        let verbBefore = STRICT_BEFORE.exec(tail) ?? STRICT_BEST.exec(tail);
        // "… boosting effects makes hiding the spotlight best" — the label after
        // makes/renders/leaves is the choice when "best/better" follows it.
        if (!verbBefore) {
          const mk = /\b(?:makes?|making|renders?|leaves?)\s+(?:the\s+|an?\s+)?$/i.exec(tail);
          if (mk && /^\s+(?:the\s+)?(?:best|better|optimal)\b/i.test(afterText)) verbBefore = mk;
        }
        // "<actor> is best with X" (no option label right before the verb) names X as the choice;
        // "<label> is better with Y" (label before the verb) is a frame — handled by STRICT_AFTER.
        if (!verbBefore) {
          const m = /\b(?:is|are|was|were)\s+(?:\w+\s+)?(?:better|best)\s+(?:off\s+)?with\s+(?:the\s+|an?\s+)?$/i.exec(tail);
          if (m) {
            const verbAt = before.length - tail.length + m.index;
            const labelBeforeVerb = hits.some((o) => o.index + o.length <= verbAt && o.index + o.length >= verbAt - 3);
            if (!labelBeforeVerb) verbBefore = m;
          }
        }
        if (verbBefore && /\b(?:whether|depending\s+on|on\s+whether)\b[^,;]{0,40}$/i.test(before)) continue;   // "…depends on whether A favors X or Y"
        if (verbBefore) { claims.push({ own: h, start: before.length - tail.length + verbBefore.index, end: h.index + h.length, kind: 'strict' }); continue; }
        const verbAfter = STRICT_AFTER.exec(afterText) ?? STRICT_AFTER_DESIRE.exec(afterText);
        if (verbAfter && /^\s*(?:does|do)\b/i.test(verbAfter[0]) && /^\s*(?:with|by)\b/i.test(afterText.slice(verbAfter[0].length))) { /* "X does better with Y": Y is the claim, anchored via STRICT_BEFORE */ }
        else if (verbAfter) { claims.push({ own: h, start: h.index, end: h.index + h.length + verbAfter[0].length, kind: 'strict' }); continue; }
        // Elliptical continuation of the previous claim: "… but Y against Q",
        // "…, against Q Y" — a same-side label after a separator, with no
        // other same-side label since that separator.
        const prev = claims[claims.length - 1];
        if (prev && h.player === prev.own.player && h.index > prev.end) {
          const sepMatches = [...before.matchAll(new RegExp(SEP.source, 'gi'))];
          const lastSep = sepMatches.length ? sepMatches[sepMatches.length - 1] : null;
          const segStart = lastSep && (lastSep.index ?? 0) >= prev.end ? (lastSep.index ?? 0) : -1;
          if (segStart >= 0) {
            const seg = before.slice(segStart);
            const otherOwn = hits.some((o) => o !== h && o.player === h.player && o.index >= segStart && o.index < h.index);
            const hasOpp = hits.some((o) => o.player !== h.player && o.index >= segStart && o.index < h.index);
            const afterLabel = clause.slice(h.index + h.length, h.index + h.length + 30);
            const frameFollows = /^\s*(?:against|versus|vs\.?|when|if|whether|with|no\s+matter|regardless|facing|toward|in\s+response|under|after|for|at|to|following|given|once)\b/i.test(afterLabel)
              || hits.some((o) => o.player !== h.player && o.index >= h.index + h.length && o.index <= h.index + h.length + 4);
            const bareSep = /^(?:,|;|\bbut\b|\band\b)\s*(?:then\s+)?(?:with\s+|by\s+choosing\s+)?(?:the\s+|an?\s+)?$/i.test(seg);
            if (!otherOwn && (hasOpp || (bareSep && frameFollows))) {
              claims.push({ own: h, start: segStart + (lastSep?.[0].length ?? 1), end: h.index + h.length, kind: 'strict' });
            }
          }
        }
      }
      if (!claims.length) continue;
      claimCount += claims.length;

      for (let i = 0; i < claims.length; i++) {
        const c = claims[i];
        const player = c.own.player;
        // Window: text between this claim and its neighbours, split at the
        // first separator so a leading frame of the NEXT claim ("…, against
        // South Route A prefers Economy") is not read as ours.
        const prevEnd = i === 0 ? 0 : claims[i - 1].end;
        const nextStart = i + 1 < claims.length ? claims[i + 1].start : clause.length;
        const leadRaw = clause.slice(prevEnd, c.start);
        const leadSepRe = i === 0 ? /;|:|\bbut\b|\band\b|\bwhile\b|\bwhereas\b|\balthough\b|\bthough\b|\byet\b|\bso\b|\bbecause\b/gi : new RegExp(SEP.source, 'gi');
        const leadSep = [...leadRaw.matchAll(leadSepRe)].map((m) => m.index ?? -1).pop() ?? -1;
        const lead = leadSep >= 0 ? leadRaw.slice(leadSep) : leadRaw;
        const trailRaw = clause.slice(c.end, nextStart);
        let trailSep = i + 1 < claims.length ? (SEP.exec(trailRaw)?.index ?? -1) : -1;
        // Stop the trail at the first comma/semicolon, and at any but/and that
        // begins a new statement ("… and ties Flexible Review against Plan
        // Beta", "… but either option against Rye") — whichever comes first.
        const comma = /,|;/.exec(trailRaw)?.index ?? -1;
        const m = /(?:\bbut\b|\band\b)(?=[^.]*\b(?:either|neither|both|indifferent|better|best|prefers?|favou?rs?|wants?|ties?|tied|equal|same|against|when|if|versus|after|for|at|to)\b)/i.exec(trailRaw);
        for (const cut of [comma, m?.index ?? -1]) if (cut >= 0 && (trailSep < 0 || cut < trailSep)) trailSep = cut;
        const trail = trailSep >= 0 ? trailRaw.slice(0, trailSep) : trailRaw;
        const leadStart = prevEnd + (leadSep >= 0 ? leadSep : 0);
        // Window = lead frame, anything between the claim start and its label
        // (frame-first ellipsis), and the trail up to the next separator.
        const inWindow = (h: LabelHit) => (h.index >= leadStart && h.index < c.own.index) || (h.index >= c.end && h.index < c.end + trail.length);
        const winHits = hits.filter(inWindow);
        // "X or Y against Z" — both own options joined by "or": an indifference claim in elliptical form.
        const ownInWin = winHits.filter((h) => h.player === player && h.option !== c.own.option);
        // Only when "or" DIRECTLY joins the two own labels ("X or Y against Z"),
        // not when it joins the opponent's options between them.
        const indiffForm = ownInWin.some((h) => {
          const lo = Math.min(c.own.index, h.index), hi = Math.max(c.own.index, h.index);
          const first = lo === c.own.index ? c.own : h;
          return /^\s*,?\s*or\s+(?:the\s+|an?\s+)?$/i.test(clause.slice(first.index + first.length, hi));
        });
        // A frame stated before the verb wins over trailing text ("against
        // Online, A prefers Discount, but B answers Discount with In-store").
        // Only opponent labels after the LAST frame keyword in the lead count
        // ("knowing whether B will Filter or keep Open: against Col 1, A prefers…").
        const leadTextFull = clause.slice(leadStart, c.own.index);
        const frameKw = [...leadTextFull.matchAll(/\b(?:against|versus|vs\.?|when|if|whether|facing|after|given|once|for)\b/gi)].pop();
        const frameAt = frameKw ? leadStart + (frameKw.index ?? 0) : leadStart;
        // A negated opponent label ("when B does NOT audit") names the OTHER option — never judged.
        const negated = (h: LabelHit) => /\b(?:not|never|no|n['’]t)\s+(?:\w+\s+){0,2}$/i.test(clause.slice(Math.max(0, h.index - 24), h.index));
        if (winHits.some((h) => h.player !== player && negated(h))) continue;
        // "whether B guards (then Deliver beats Hold)" names ONE opponent option —
        // a frame; "depending on whether B chooses Col 1 or Col 2: …" names both — not a frame.
        const leadRawOpps = [...new Set(winHits.filter((h) => h.player !== player && h.index < c.own.index && h.index >= frameAt).map((h) => h.option))];
        const whetherLead = frameKw ? /^(?:whether)$/i.test(frameKw[0]) || /\bdepending\s+on\s*$/i.test(leadTextFull.slice(0, frameKw.index ?? 0)) : false;
        const leadIsHypothetical = whetherLead && leadRawOpps.length !== 1;
        const leadOpps = leadIsHypothetical ? [] : leadRawOpps;
        const trailOpps = [...new Set(winHits.filter((h) => h.player !== player && h.index >= c.end).map((h) => h.option))];
        // An explicit frame right after the verb ("… is best against Col 1")
        // beats a lead frame ("depending on whether B chooses Col 1 or Col 2: …").
        const trailExplicit = /^\s*(?:against|versus|vs\.?|when|if|facing|after|given|once)\b/i.test(trail);
        const opps = trailExplicit && trailOpps.length ? trailOpps : (leadOpps.length ? leadOpps : trailOpps);
        // "Against Steam Tug, Diesel Tug is better for the pilot" — the frame names
        // the SAME player's other option: the sentence attaches one player's labels
        // to the other player's choice (L3 draw 40). Malformed, never shown.
        const sameSideFrame = winHits.some((h) => h.player === player && h.option !== c.own.option
          && /\b(?:against|versus|vs\.?|facing)\s+(?:the\s+|an?\s+)?$/i.test(clause.slice(Math.max(0, h.index - 14), h.index)));
        if (sameSideFrame && !opps.length) {
          issues.push(`prose frames ${player}'s option ${c.own.option} "against" ${player}'s own other option — the opponent's options are the other player's`);
          continue;
        }
        const targets: (1 | 2)[] = opps.length ? opps : (BOTH_WAYS.test((leadIsHypothetical ? '' : lead) + trail) ? [1, 2] : []);
        // Quoted comparison numbers ("gives A 5 rather than 3", "7 instead of -9",
        // "8 vs 6") must be the two payoffs of ONE opponent option (C1 draw 31
        // welded a 5 from the tie column with a 3 from the other column).
        const segFull = clause.slice(c.start, c.end + trail.length);   // the claim's own text only — never the lead, which may hold another claim's parenthetical
        // Payoff numbers only: not "Row 2 over Col 1", not probabilities; ASCII or Unicode minus.
        const numM = /(?<!(?:Row|Col|Column|probability|prob\.?|weight)\s)(?<![xy]\s?[=≈])([-−–]?\d+(?:\.\d+)?)\s*(?:rather\s+than|instead\s+of|vs\.?|versus|compared\s+(?:to|with)|beats|is\s+better\s+than|over)\s*(?:[^.;\d−–-]{0,25}?)(?<!(?:Row|Col|Column)\s)([-−–]?\d+(?:\.\d+)?)/i.exec(segFull);
        if (numM && !/^(?:Row|Col)/i.test(segFull.slice(numM.index - 4, numM.index).trim())) {
          const num = (t: string) => Number(t);   // already normalised at the entry point
          const hi = num(numM[1]), lo = num(numM[2]);
          const cols: (1 | 2)[] = [1, 2];
          const consistent = cols.some((opp) => Math.abs(payoff(player, c.own.option, opp) - hi) < 1e-9 && Math.abs(payoff(player, (3 - c.own.option) as 1 | 2, opp) - lo) < 1e-9);
          if (!consistent) issues.push(`prose compares ${hi} with ${lo} for ${player}'s option ${c.own.option}, but no single opponent option pays those two values`);
        }
        for (const opp of targets) {
          const mine = payoff(player, c.own.option, opp), alt = payoff(player, (3 - c.own.option) as 1 | 2, opp);
          if (indiffForm) {
            if (mine !== alt) issues.push(`prose says ${player} is indifferent against opponent option ${opp}, but ${describe(player, c.own.option, opp)} — a strict preference`);
          } else if (mine === alt) issues.push(`prose words a payoff tie as a strict preference: ${describe(player, c.own.option, opp)}`);
          else if (mine < alt) issues.push(`prose has the direction backwards: ${describe(player, c.own.option, opp)}`);
        }
      }
    }
  }
  return { issues, claims: claimCount };
}
