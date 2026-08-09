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
  LlmReport,
  Mismatch,
  NashEquilibrium,
  ValidationResult,
} from '../types';
import { computeAllNE, computeIndifference, regretA, regretB } from './gameEngine';

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

  return { ok: mismatches.length === 0, checks, mismatches };
}
