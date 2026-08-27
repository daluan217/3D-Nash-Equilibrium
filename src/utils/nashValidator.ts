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
