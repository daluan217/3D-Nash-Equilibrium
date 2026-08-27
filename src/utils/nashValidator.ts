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
import { computeAllNE, computeIndifference, regretA, regretB } from './gameEngine';
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
    const allowedX = [0, 1, ...truth.map((t) => t.x)];
    const allowedY = [0, 1, ...truth.map((t) => t.y)];
    for (const m of prose.matchAll(/\b([xy])\s*\*?\s*([=≈≃~])\s*(-?\d+(?:\.\d+)?)/gi)) {
      const axis = m[1].toLowerCase();
      const value = Number(m[3]);
      if (!Number.isFinite(value)) continue;
      if (near(value, axis === 'x' ? allowedX : allowedY, m[2] !== '=')) continue;
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
export function validateScenario(sc: SuggestedScenario, g: GamePayoffs): ScenarioValidation {
  const issues: string[] = [];
  // Same tolerance shape as checkProse: tight, the citation restates a matrix
  // number the model was handed verbatim.
  const near = (v: number, a: number) => Math.abs(a - v) <= Math.max(0.01, Math.abs(a) * 0.005);

  const claims = sc.storyClaims ?? null;
  if (claims) {
    for (const c of claims.cellCitations ?? []) {
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
    issues.push(...bestReplyIssues(claims.bestReplies ?? [], g, 'story'));
  }

  // Undeclared-citation guard: any payoff-anchored number in the description
  // ("A=9", "E[B]≈3") must be covered by a declared citation, otherwise the
  // declaration rule was skipped and nothing above ever looked at that claim.
  const declared = claims ? (claims.cellCitations ?? []).flatMap((c) => [c.a, c.b]) : [];
  const desc = sc.description ?? '';

  // Wordless outcome talk: a CONDITIONAL sentence attributing gain/loss to a
  // specific action combination, in a digit-free description with no declared
  // best-reply claims, is invisible to every check above — the live "the
  // quitter loses and the cooperator gains" inversion (a moral prior imported
  // over the actual numbers) rode exactly this shape. Unverifiable is treated
  // as unshowable; the server's retry usually lands a compliant draw. Kept
  // deliberately narrow — conditional frame AND outcome verb AND no digits
  // AND empty bestReplies — so zero-sum framing sentences ("what hurts A
  // helps B") and any story that quantifies itself never trip it.
  const OUTCOME_TALK = /\b(?:if|when|while)\b[^.!?]{0,140}?\b(?:pays? off|loses?|gains?|wins?|profits?|suffers?|is (?:punished|rewarded))\b/i;
  if (OUTCOME_TALK.test(desc) && !/\d/.test(desc) && (claims?.bestReplies ?? []).length === 0) {
    issues.push(
      'description attributes gains/losses to an action combination without numbers or declared best-reply claims — unverifiable',
    );
  }
  for (const m of desc.matchAll(/(?:\bE\[[AB]\]|\b[AB])\s*[=≈≃~]\s*(-?\d+(?:\.\d+)?)/g)) {
    const v = Number(m[1]);
    if (!Number.isFinite(v)) continue;
    if (!declared.some((a) => Math.abs(a - v) <= Math.max(0.05, Math.abs(a) * 0.02))) {
      issues.push(`description cites ${m[0].replace(/\s+/g, ' ')} but no declared cellCitation covers it`);
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
  prose: string,
  g: GamePayoffs,
  truth: NashEquilibrium[],
  degenerate: boolean,
): ScenarioValidation {
  const issues: string[] = [];

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
  if ((claims?.bestReplies ?? []).length === 0 && prose) {
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

  if (!degenerate && claims) {
    for (const a of claims.equilibriumActions ?? []) {
      if ((a.player !== 'A' && a.player !== 'B') || !isOpt12(a.option)) {
        issues.push(`equilibrium-action claim is malformed (player=${a.player}, option=${a.option})`);
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
      const matches = truth.some((t) => {
        const pOption1 = a.player === 'A' ? t.x : t.y;
        return (a.option === 1 ? pOption1 : 1 - pOption1) > 1e-3;
      });
      if (!matches) {
        issues.push(
          `prose says ${a.player} plays option ${a.option} at an equilibrium, but every equilibrium gives that option probability 0`,
        );
      }
    }
  }
  issues.push(...bestReplyIssues(claims?.bestReplies ?? [], g, 'prose'));
  return { ok: issues.length === 0, issues };
}

export function validateReport(report: LlmReport, g: GamePayoffs): ValidationResult {
  const checks: string[] = [];
  const mismatches: Mismatch[] = [];

  const truth = computeAllNE(g);
  const indifference = computeIndifference(g);
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
