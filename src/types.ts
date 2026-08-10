/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface GamePayoffs {
  a11: number;
  a12: number;
  a21: number;
  a22: number;
  b11: number;
  b12: number;
  b21: number;
  b22: number;
}

export interface PresetGame {
  key: string;
  name: string;
  a11?: number;
  b11?: number;
  a12?: number;
  b12?: number;
  a21?: number;
  b21?: number;
  a22?: number;
  b22?: number;
  desc: string;
  row1Label?: string;
  row2Label?: string;
  col1Label?: string;
  col2Label?: string;
}

export interface PathSegment {
  xs: number[];
  ys: number[];
  zs: number[];
  mover: 'A' | 'B';
}

export interface SimState {
  cx: number;
  cy: number;
  calcX: number | null;
  calcY: number | null;
  displayX: number | null;
  displayY: number | null;
  startX: number;
  startY: number;

  domainLo: number;
  domainHi: number;
  // Regret mode keeps a SEPARATE domain per player, each contracting toward its
  // own NE coordinate so the two strategy lines flatten independently and
  // gradually (a single shared corridor makes them snap). A's domain brackets
  // x = P(A Row1); B's brackets y = P(B Col1).
  domXLo: number;
  domXHi: number;
  domYLo: number;
  domYHi: number;
  // Representative mix (each player's domain midpoint) the strategy line is drawn
  // at; glides smoothly to the NE coordinate as the domains contract.
  stratX: number;
  stratY: number;
  cycleCount: number;
  visitedPositions: string[];
  ghostVisitedPositions: string[];

  discoveredMixedX: number | null;
  discoveredMixedY: number | null;
  foundAxis: 'x' | 'y' | null;

  running: boolean;
  converged: boolean;
  stepCount: number;

  pathSegmentsA: PathSegment[];
  pathSegmentsB: PathSegment[];
  phase1PtsA: number | null;
  phase1PtsB: number | null;

  ghostPathSegmentsA: PathSegment[];
  ghostPathSegmentsB: PathSegment[];

  // Bisection state for Phase 1 overshoot detection
  cyclePattern: { aHi: number; aLo: number; bHi: number; bLo: number } | null;
  bisecting: boolean;
  bisectGoodLo: number;
  bisectGoodHi: number;
  bisectBadLo: number;
  bisectBadHi: number;

  // Bisection state for Phase 2 ghost corridor
  ghostCyclePattern: { aHi: number; aLo: number } | null;
  ghostBisecting: boolean;
  ghostBisectGoodLo: number;
  ghostBisectGoodHi: number;
  ghostBisectBadLo: number;
  ghostBisectBadHi: number;

  historyStack: Omit<SimState, 'running' | 'historyStack'>[];
}

export interface NashEquilibrium {
  x: number;
  y: number;
  type: 'pure' | 'mixed';
  label: string;
  eA: number;
  eB: number;
}

/* ------------------------------------------------------------------ *
 * LLM report types
 *
 * Shared by the client, the /api/report route, the validator, and the
 * eval harness so all four agree on one definition. Types only — these
 * erase at build time and cost nothing in the server bundle.
 * ------------------------------------------------------------------ */

/** Request body for POST /api/report — the full payoff matrix. */
export interface ReportRequest {
  payoffs: GamePayoffs;
}

/**
 * One equilibrium the model claims exists. `continuum` covers the
 * degenerate case where a player is indifferent and every point on a
 * line (or the whole square) is an equilibrium — computeAllNE returns
 * an empty array there, so it cannot be expressed as 'pure' | 'mixed'.
 */
export interface ClaimedEquilibrium {
  type: 'pure' | 'mixed' | 'continuum';
  x: number;
  y: number;
}

/** Schema-constrained model output. Shape is guaranteed; truth is not. */
export interface LlmReport {
  claimedEquilibria: ClaimedEquilibrium[];
  prose: string;
}

/** Why a single claim failed, so the eval can bucket failures by cause. */
export type MismatchKind =
  | 'out-of-range'      // x or y outside [0,1], or not finite
  | 'nonzero-regret'    // fails the independent oracle: not an equilibrium
  | 'not-in-solver'     // regret-clean but the solver does not list it
  | 'wrong-type'        // real equilibrium, mislabelled pure/mixed/continuum
  | 'omitted'           // solver found it; the model never mentioned it
  // ── prose-level (the text the user actually reads) ────────────────────────
  // Only DECIDABLE checks live here: "is this number in the allowlist?" has an
  // answer, so it can be tested. A semantic check ("does this sentence assert a
  // pure equilibrium exists?") was tried and removed — see nashValidator.ts.
  | 'prose-bad-coordinate' // cites an x=/y= that is not an equilibrium coordinate
  | 'prose-bad-payoff';    // cites an A=/B= value that appears nowhere in the game

export interface Mismatch {
  kind: MismatchKind;
  claimed: ClaimedEquilibrium | null;
  expected: NashEquilibrium | null;
  detail: string;
}

export interface ValidationResult {
  ok: boolean;
  /** Human-readable pass/fail lines, in the order they were checked. */
  checks: string[];
  mismatches: Mismatch[];
}

/** What POST /api/report returns. */
export interface ReportEnvelope {
  source: 'llm' | 'deterministic';
  report: LlmReport | null;
  validation: ValidationResult | null;
  groundTruth: NashEquilibrium[];
  /** Set when source is 'deterministic', so the client can say why. */
  fallbackReason?:
    | 'no-key'
    | 'refusal'
    | 'max-tokens'
    | 'unparseable'
    | 'rate-limited'
    | 'validation-failed'
    | 'error';
}
