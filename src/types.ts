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
  /**
   * Actor nouns for color-coding model-written prose ("robber", "goalie").
   * The AI explanation is rendered as plain text (it may never emit HTML), so
   * player coloring is applied client-side by matching these terms; actorA is
   * the row player (player-a rose), actorB the column player (player-b blue).
   */
  actorA?: string[];
  actorB?: string[];
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

/**
 * The geometric assertions the prose makes, DECLARED as booleans.
 *
 * These exist so the geometry in the explanation is checkable. The model is
 * told to describe the equilibrium in terms of the plotted surfaces — level
 * shelves, warp, the joint flat spot — which widens what it can get wrong.
 * Asking it to also state those claims as four booleans turns "does this
 * paragraph assert a flat shelf?" from a semantic judgement into a lookup.
 *
 * This is the same move nashValidator already documents for the removed
 * `prose-false-pure` regex: a claim a model makes in PROSE is not decidable, so
 * the claim is required in the STRUCTURED output, where an oracle can compare it
 * against a computed value. Do not add a check here that has to read `prose`.
 */
export interface GeometryClaims {
  /** A's surface is warped — the players' choices genuinely interact. */
  surfacesInteract: boolean;
  /** B's surface is A's flipped over (zero-sum, or constant-sum up to an offset). */
  opponentSurfaceIsMirror: boolean;
  /** A's surface goes level somewhere ON the board — A has an indifference shelf. */
  hasFlatShelfForA: boolean;
  /** The equilibrium is the interior point where BOTH surfaces are level at once. */
  equilibriumIsInteriorFlatSpot: boolean;
  /**
   * The prose frames the equilibrium as von Neumann's minimax / "the value of
   * the game". Only meaningful on a zero- or constant-sum game; elsewhere there
   * is no single value for it to be the minimax of.
   */
  invokesMinimax: boolean;
  /** The prose says some player has a strategy that is better whatever the opponent does. */
  claimsDominantStrategy: boolean;
}

/** Schema-constrained model output. Shape is guaranteed; truth is not. */
export interface LlmReport {
  claimedEquilibria: ClaimedEquilibrium[];
  prose: string;
  /**
   * Null when the model declined to describe the geometry, which is allowed —
   * the checks exist to catch FALSE assertions, not to compel assertions.
   */
  geometryClaims?: GeometryClaims | null;
  /**
   * Present only when the game arrived with no usable scenario and the model
   * invented one. Offered to the user to save into their game's description.
   * Illustrative only: the payoffs and equilibria remain authoritative, and
   * nashValidator does not check the story.
   */
  suggestedScenario?: SuggestedScenario;
}

/**
 * A scenario the model invented for a game that had none.
 *
 * SAVE CONTRACT — persist the LABELS, not only the description.
 *
 * A saved scenario is only worth saving if the next explanation reuses it
 * instead of inventing another one; otherwise the text the user kept is a dead
 * letter. Reuse is decided by `scenarioIsUsable`, which accepts either all four
 * labels OR a description of at least twelve words. Labels are the reliable
 * half: they are always sufficient, whereas a terse description would silently
 * fall through to regeneration.
 *
 * So when the user accepts a suggestion, write row1/row2/col1/col2 into the
 * game's label fields as well as the description, and send all of them back on
 * the next /api/report call.
 */
export interface SuggestedScenario {
  name?: string;
  row1?: string;
  row2?: string;
  col1?: string;
  col2?: string;
  description?: string;
  /**
   * The factual claims the invented description makes, restated as data so
   * `validateScenario` can check them as lookups — the same design as
   * geometryClaims: "does this sentence claim X?" is semantic and undecidable,
   * "does this declared claim match the matrix?" is a comparison. Null is the
   * escape hatch for a description that makes no payoff or better-against
   * claims. The server drops any suggestion whose declared claims are false,
   * so an unverified story is never offered or prefilled.
   */
  storyClaims?: ScenarioStoryClaims | null;
}

/** One "the payoffs at (row, col) are (a, b)" statement made by the story. */
export interface ScenarioCellCitation {
  /** 1 or 2 — which of A's options the sentence names. */
  row: number;
  /** 1 or 2 — which of B's options the sentence names. */
  col: number;
  /** A's payoff in that cell, exactly as the description states it. */
  a: number;
  /** B's payoff in that cell. */
  b: number;
}

/** One "player's OPTION does best against the opponent's OPTION" statement. */
export interface ScenarioBestReply {
  player: 'A' | 'B';
  /** 1 or 2 — the opponent option held fixed by the claim. */
  opponentOption: number;
  /** 1 or 2 — the option claimed better for the player. */
  bestOption: number;
}

export interface ScenarioStoryClaims {
  cellCitations: ScenarioCellCitation[];
  bestReplies: ScenarioBestReply[];
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
  | 'prose-bad-payoff'     // cites an A=/B= value that appears nowhere in the game
  // ── geometry (declared in geometryClaims, compared against describeGeometry) ─
  // Decidable for the same reason the two above are: each compares a value the
  // model STATED against one the solver COMPUTED. None of them reads the prose.
  | 'geometry-bad-twist'    // claims interaction on a game whose surface is flat
  | 'geometry-bad-mirror'   // claims a mirrored surface on a non-constant-sum game
  | 'geometry-bad-shelf'    // claims a flat shelf when y* lies off the board
  | 'geometry-bad-flatspot' // claims an interior joint flat spot when the NE is on an edge
  | 'geometry-bad-minimax'  // invokes minimax/"the value of the game" on a non-constant-sum game
  | 'geometry-bad-dominance';// claims a dominant strategy when neither player has one

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
