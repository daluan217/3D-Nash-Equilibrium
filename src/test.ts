/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GamePayoffs, SimState, NashEquilibrium, PathSegment, LlmReport, MismatchKind, SuggestedScenario } from './types';
import { doStep, PRESETS, precomputeThinHistory, DEFAULT_MAX_STEPS, computeAllNE, computeIndifference, regretA, regretB, describeContinua, neTolerance, neTolerancePlayer, profileConcept, resolveProfile, indifferenceAt, computeMixedNE, fmtProb, texProb, equilibriumSet, kindOf, EA, EB, r3, parseNumericInput, commitPayoffInput, commitStartCoordinate, commitStepIndex, normalizeProseMinus } from './utils/gameEngine';
import { readFileSync } from 'node:fs';
import { describeGeometry } from './utils/geometry';
import { buildGroundingPayload } from './utils/report';
import { validateReport, validateScenario, validateProseClaims , validateProseDirections, scenarioIsClaimFree } from './utils/nashValidator';
import { tieProse, tieProseFull, type TieLabels } from './utils/tieProse';

const TOL = 0.002;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertApprox(actual: number, expected: number, label: string, tol = TOL) {
  assert(
    Math.abs(actual - expected) <= tol,
    `${label}: expected ${expected.toFixed(3)}, got ${actual.toFixed(3)}`
  );
}

function assertNE(nes: NashEquilibrium[], type: 'pure' | 'mixed', x: number, y: number, label: string) {
  const ne = nes.find(n => n.type === type && Math.abs(n.x - x) <= TOL && Math.abs(n.y - y) <= TOL);
  assert(ne, `${label}: missing ${type} NE at (${x.toFixed(3)}, ${y.toFixed(3)})`);
}

function createInitialState(startX: number, startY: number, g: GamePayoffs): SimState {
  return {
    cx: startX,
    cy: startY,
    exactX: startX,
    exactY: startY,
    calcX: startX,
    calcY: startY,
    displayX: startX,
    displayY: startY,
    startX,
    startY,
    domainLo: 0,
    domainHi: 1,
    domXLo: 0,
    domXHi: 1,
    domYLo: 0,
    domYHi: 1,
    stratX: startX,
    stratY: startY,
    cycleCount: 0,
    visitedPositions: [],
    ghostVisitedPositions: [],
    discoveredMixedX: null,
    discoveredMixedY: null,
    foundAxis: null,
    running: false,
    converged: false,
    stepCount: 0,
    pathSegmentsA: [{ xs: [startX], ys: [startY], zs: [r3(EA(startX, startY, g))], mover: 'A' }],
    pathSegmentsB: [{ xs: [startX], ys: [startY], zs: [r3(EB(startX, startY, g))], mover: 'A' }],
    phase1PtsA: null,
    phase1PtsB: null,
    ghostPathSegmentsA: [],
    ghostPathSegmentsB: [],
    cyclePattern: null,
    bisecting: false,
    bisectGoodLo: 0,
    bisectGoodHi: 1,
    bisectBadLo: 0,
    bisectBadHi: 1,
    ghostCyclePattern: null,
    ghostBisecting: false,
    ghostBisectGoodLo: 0,
    ghostBisectGoodHi: 1,
    ghostBisectBadLo: 0,
    ghostBisectBadHi: 1
  };
}

function cloneState(s: SimState): SimState {
  const cloneSegments = (segments: PathSegment[]) =>
    segments.map(seg => ({ xs: [...seg.xs], ys: [...seg.ys], zs: [...seg.zs], mover: seg.mover }));

  return {
    ...s,
    visitedPositions: [...s.visitedPositions],
    ghostVisitedPositions: [...s.ghostVisitedPositions],
    pathSegmentsA: cloneSegments(s.pathSegmentsA),
    pathSegmentsB: cloneSegments(s.pathSegmentsB),
    ghostPathSegmentsA: cloneSegments(s.ghostPathSegmentsA),
    ghostPathSegmentsB: cloneSegments(s.ghostPathSegmentsB)
  };
}

function simulate(
  g: GamePayoffs,
  opts: {
    firstMover?: 'A' | 'B';
    shrinkStep?: number;
    stepMode?: 'shrink' | 'regret';
    startX?: number;
    startY?: number;
    maxSteps?: number;
  } = {}
): SimState {
  const firstMover = opts.firstMover ?? 'A';
  const shrinkStep = opts.shrinkStep ?? 0.01;
  const stepMode = opts.stepMode ?? 'shrink';
  const state = createInitialState(opts.startX ?? 0.217, opts.startY ?? 0.217, g);
  const allNE = computeAllNE(g);
  const pureNEs = allNE.filter(n => n.type === 'pure');
  const committedNE = pureNEs.length > 0
    ? pureNEs.reduce((best, ne) => {
        const myScore = firstMover === 'A' ? ne.eA : ne.eB;
        const bestScore = firstMover === 'A' ? best.eA : best.eB;
        return myScore > bestScore ? ne : best;
      })
    : null;

  for (let i = 0; i < (opts.maxSteps ?? 5000) && !state.converged; i++) {
    doStep(g, state, firstMover, shrinkStep, allNE, committedNE, () => {}, () => {}, () => {}, stepMode);
  }

  assert(state.converged, `Simulation did not converge within ${opts.maxSteps ?? 5000} steps`);
  return state;
}

function payoffsFromPreset(key: keyof typeof PRESETS): GamePayoffs {
  const p = PRESETS[key];
  return {
    a11: p.a11 ?? 0,
    a12: p.a12 ?? 0,
    a21: p.a21 ?? 0,
    a22: p.a22 ?? 0,
    b11: p.b11 ?? 0,
    b12: p.b12 ?? 0,
    b21: p.b21 ?? 0,
    b22: p.b22 ?? 0,
  };
}

function testSolverCanonicalGames() {
  const search = payoffsFromPreset('search');
  const searchNE = computeAllNE(search);
  assert(searchNE.length === 1, 'Search Game should have exactly one NE');
  assertNE(searchNE, 'mixed', 1 / 3, 1 / 3, 'Search Game');

  const bos = computeAllNE(payoffsFromPreset('bos'));
  assertNE(bos, 'pure', 1, 1, 'Battle of the Sexes');
  assertNE(bos, 'pure', 0, 0, 'Battle of the Sexes');
  assertNE(bos, 'mixed', 2 / 3, 1 / 3, 'Battle of the Sexes');

  const pd = computeAllNE(payoffsFromPreset('pd'));
  assert(pd.filter(n => n.type === 'pure').length === 1, 'Prisoners Dilemma should have one pure NE');
  assertNE(pd, 'pure', 0, 0, 'Prisoners Dilemma');
}

function testZeroSumSearchFamily() {
  const cases = [
    { left: 2, right: 1 },
    { left: 5, right: 2 },
    { left: 1.5, right: 4 },
  ];

  cases.forEach(({ left, right }) => {
    const g: GamePayoffs = {
      a11: left, b11: -left,
      a12: 0, b12: 0,
      a21: 0, b21: 0,
      a22: right, b22: -right,
    };
    const expected = right / (left + right);
    const nes = computeAllNE(g);
    assertNE(nes, 'mixed', expected, expected, `Zero-sum search ${left}/${right}`);
  });
}

function testSimulationConvergence() {
  const search = payoffsFromPreset('search');
  const searchShrink = simulate(search, { shrinkStep: 0.01, stepMode: 'shrink' });
  assertApprox(searchShrink.cx, 1 / 3, 'Search Game shrink x');
  assertApprox(searchShrink.cy, 1 / 3, 'Search Game shrink y');

  const searchRegret = simulate(search, { shrinkStep: 0.1, stepMode: 'regret' });
  assertApprox(searchRegret.cx, 1 / 3, 'Search Game regret x');
  assertApprox(searchRegret.cy, 1 / 3, 'Search Game regret y');

  const bos = simulate(payoffsFromPreset('bos'), { shrinkStep: 0.1, firstMover: 'A' });
  assertApprox(bos.cx, 1, 'Battle of the Sexes first-mover A x');
  assertApprox(bos.cy, 1, 'Battle of the Sexes first-mover A y');

  const pd = simulate(payoffsFromPreset('pd'), { shrinkStep: 0.1 });
  assertApprox(pd.cx, 0, 'Prisoners Dilemma x');
  assertApprox(pd.cy, 0, 'Prisoners Dilemma y');
}

function testGhostCorridorInvariant() {
  const spyGame = payoffsFromPreset('spy');
  const allNE = computeAllNE(spyGame);
  const state = createInitialState(0.217, 0.217, spyGame);

  let ghostCycleDetected = false;
  let savedGhostPositionsInCycle: string[] = [];
  let prevFoundAxis: 'x' | 'y' | null = null;

  for (let steps = 0; steps < 1000 && !state.converged && !ghostCycleDetected; steps++) {
    const prev = cloneState(state);
    prevFoundAxis = state.foundAxis;

    const inPhase2Before = (state.discoveredMixedX !== null) !== (state.discoveredMixedY !== null);
    if (inPhase2Before && state.ghostVisitedPositions.length > 0) {
      savedGhostPositionsInCycle = [...state.ghostVisitedPositions];
    }

    doStep(
      spyGame,
      state,
      'A',
      0.01,
      allNE,
      null,
      () => {},
      () => {
        const inPhase2 = (state.discoveredMixedX !== null) !== (state.discoveredMixedY !== null);
        if (inPhase2) ghostCycleDetected = true;
      },
      () => {}
    );

    const inPhase2After = (state.discoveredMixedX !== null) !== (state.discoveredMixedY !== null);
    const isGhostInitStep = prevFoundAxis === null && state.foundAxis !== null;
    const cycleContracted = state.cycleCount !== prev.cycleCount;
    if (inPhase2After && !isGhostInitStep && !cycleContracted) {
      const dx = Math.abs((state.calcX ?? state.cx) - (prev.calcX ?? prev.cx));
      const dy = Math.abs((state.calcY ?? state.cy) - (prev.calcY ?? prev.cy));
      assert(!(dx > 0 && dy > 0), `Ghost moved diagonally at step ${state.stepCount}`);
    }
  }

  assert(ghostCycleDetected, 'Expected to detect a Phase 2 ghost corridor cycle');
  assert(new Set(savedGhostPositionsInCycle).size === 4, 'Ghost corridor should visit exactly four endpoints before cycling');
}

/**
 * describeGeometry must agree with the solver about where the equilibrium is.
 *
 * This exists because the x* formula here was WRONG once and nothing caught it.
 * The widely-quoted shortcut x* = (a22-a21)/T_A is zero-sum-only: it coincides
 * with the truth when B = -A and silently disagrees otherwise, returning 0.333
 * on Battle of the Sexes where the real answer is 0.667. Since x* is B's
 * indifference point it must be built from B's payoffs, and this test is what
 * keeps it that way — a game with a random non-mirrored B is exactly the case
 * the bad formula gets wrong, so the fuzz below fails immediately if it returns.
 */
function testGeometryOracleAgreesWithSolver() {
  let seed = 20260812;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = () => Math.round((rnd() * 20 - 10));

  let interiorChecked = 0;
  for (let i = 0; i < 20000; i++) {
    const g: GamePayoffs = {
      a11: pick(), a12: pick(), a21: pick(), a22: pick(),
      b11: pick(), b12: pick(), b21: pick(), b22: pick(),
    };
    const geo = describeGeometry(g);
    const ne = computeAllNE(g);
    const interiorMixed = ne.find(
      n => n.type === 'mixed' && n.x > 1e-6 && n.x < 1 - 1e-6 && n.y > 1e-6 && n.y < 1 - 1e-6,
    );

    // Skip degenerate games: a flat player makes a whole region equilibrium, so
    // "the interior mixed NE" is not a single point to compare against.
    if (Math.abs(geo.twistA) < 1e-9 || Math.abs(geo.twistB) < 1e-9) continue;

    assert(
      geo.hasInteriorFlatSpot === !!interiorMixed,
      `geometry/solver disagree on interior NE for ${JSON.stringify(g)}: `
      + `predicate=${geo.hasInteriorFlatSpot} solver=${!!interiorMixed}`,
    );

    if (interiorMixed) {
      interiorChecked++;
      // The joint flat spot IS the mixed equilibrium — same point, two derivations.
      //
      // Tolerance is 1e-3, not 0: computeAllNE reports r3-rounded coordinates
      // while xStar/yStar are exact, so they can differ by up to 5e-4 while
      // agreeing perfectly. That is far tighter than the ~0.33 error the
      // zero-sum-only x* formula produces, which is what this test guards.
      assertApprox(geo.xStar, interiorMixed.x, `xStar vs solver ${JSON.stringify(g)}`, 1e-3);
      assertApprox(geo.yStar, interiorMixed.y, `yStar vs solver ${JSON.stringify(g)}`, 1e-3);
    }
  }
  assert(interiorChecked > 500, `too few interior cases sampled (${interiorChecked}) to mean anything`);

  // Named regression for the specific game the bad formula got wrong.
  const bos = describeGeometry({ a11: 2, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 2 });
  assertApprox(bos.xStar, 2 / 3, 'Battle of the Sexes xStar (must use B\'s payoffs)', 1e-9);
  assertApprox(bos.yStar, 1 / 3, 'Battle of the Sexes yStar', 1e-9);
}

/**
 * Each geometry check needs a fixture that FIRES and one that stays silent.
 * A check only proves something if both halves are demonstrated: one that never
 * fires is decoration, and one that always fires is noise.
 */
function testGeometryValidatorChecks() {
  const MATCHING_PENNIES: GamePayoffs =
    { a11: 1, a12: -1, a21: -1, a22: 1, b11: -1, b12: 1, b21: 1, b22: -1 };
  // Prisoner's Dilemma: a corner equilibrium, not zero-sum, no interior flat spot.
  const PD: GamePayoffs =
    { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 };
  // A's payoff ignores B entirely, so A's surface is a flat plane (twistA = 0).
  const FLAT_A: GamePayoffs =
    { a11: 2, a12: 2, a21: 5, a22: 5, b11: -2, b12: -3, b21: -4, b22: -5 };
  // Battle of the Sexes: not constant-sum and no dominant strategy either way,
  // so it is the negative fixture for BOTH of the new checks.
  const BOS: GamePayoffs =
    { a11: 2, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 2 };
  // twistA = 0 AND a11 === a21: A is indifferent between the rows at EVERY y,
  // so the whole board is a shelf. yStar is NaN here (yStarInRange is false)
  // while hasFlatShelfForA is correctly true — the exact degenerate case
  // `geometry-bad-shelf` was corrected for, and the one case that distinguishes
  // the two fields from each other.
  const ALL_SHELF_A: GamePayoffs =
    { a11: 4, a12: 4, a21: 4, a22: 4, b11: 1, b12: -1, b21: -1, b22: 1 };

  const truthFor = (g: GamePayoffs) => {
    const geo = describeGeometry(g);
    return {
      surfacesInteract: Math.abs(geo.twistA) >= 1e-9,
      opponentSurfaceIsMirror: geo.zeroSum || geo.constantSum,
      hasFlatShelfForA: geo.hasFlatShelfForA,
      equilibriumIsInteriorFlatSpot: geo.hasInteriorFlatSpot,
      invokesMinimax: geo.minimaxApplies,
      claimsDominantStrategy: geo.dominantRowA || geo.dominantColB,
    };
  };

  // Claims that are true carry the report; only the geometry is under test, so
  // the equilibria are copied from the solver to keep the other checks quiet.
  const reportFor = (g: GamePayoffs, claims: ReturnType<typeof truthFor>): LlmReport => ({
    claimedEquilibria: computeAllNE(g).map(n => ({ type: n.type, x: n.x, y: n.y })),
    prose: 'A neutral sentence with no numbers in it.',
    geometryClaims: claims,
  });

  // --- negative fixtures: truthful declarations must not fire ---------------
  for (const [name, g] of [['matching pennies', MATCHING_PENNIES], ['PD', PD], ['flat A', FLAT_A], ['BoS', BOS],
    ['all-shelf A', ALL_SHELF_A]] as const) {
    const v = validateReport(reportFor(g, truthFor(g)), g);
    const geoFails = v.mismatches.filter(m => m.kind.startsWith('geometry-'));
    assert(geoFails.length === 0, `${name}: truthful geometry flagged — ${geoFails.map(m => m.detail).join('; ')}`);
  }

  // --- positive fixtures: one lie each, and ONLY that check fires -----------
  const cases: { label: string; g: GamePayoffs; field: keyof ReturnType<typeof truthFor>; kind: MismatchKind }[] = [
    { label: 'claims interaction on a flat surface', g: FLAT_A, field: 'surfacesInteract', kind: 'geometry-bad-twist' },
    { label: 'claims a mirror on non-zero-sum PD', g: PD, field: 'opponentSurfaceIsMirror', kind: 'geometry-bad-mirror' },
    { label: 'claims a shelf where y* is off-board', g: PD, field: 'hasFlatShelfForA', kind: 'geometry-bad-shelf' },
    // The degenerate direction: A is level along its own axis at EVERY y, so
    // DENYING the shelf is the false claim. y* is NaN here, which is why the
    // old yStarInRange predicate accepted the denial.
    { label: 'denies the shelf on a board that is level everywhere', g: ALL_SHELF_A, field: 'hasFlatShelfForA', kind: 'geometry-bad-shelf' },
    { label: 'claims an interior flat spot at a corner NE', g: PD, field: 'equilibriumIsInteriorFlatSpot', kind: 'geometry-bad-flatspot' },
    // The observed failure: minimax asserted on a non-constant-sum game.
    { label: 'invokes minimax on a non-zero-sum game', g: BOS, field: 'invokesMinimax', kind: 'geometry-bad-minimax' },
    { label: 'claims dominance where neither player has it', g: BOS, field: 'claimsDominantStrategy', kind: 'geometry-bad-dominance' },
  ];
  for (const c of cases) {
    const claims = truthFor(c.g);
    claims[c.field] = !claims[c.field];              // flip exactly one
    const kinds = validateReport(reportFor(c.g, claims), c.g)
      .mismatches.filter(m => m.kind.startsWith('geometry-')).map(m => m.kind);
    assert(kinds.includes(c.kind), `${c.label}: expected ${c.kind}, got [${kinds.join(', ')}]`);
    assert(kinds.length === 1, `${c.label}: one lie should raise one check, got [${kinds.join(', ')}]`);
  }

  // --- null is an escape hatch, not a failure ------------------------------
  const nullClaims = validateReport(
    { claimedEquilibria: computeAllNE(PD).map(n => ({ type: n.type, x: n.x, y: n.y })), prose: 'No shape talk.', geometryClaims: null },
    PD,
  );
  assert(
    nullClaims.mismatches.every(m => !m.kind.startsWith('geometry-')),
    'a null geometryClaims must be skipped, not failed',
  );

  // --- the existing checks must be untouched by all of this ----------------
  const legacyShaped: LlmReport = {
    claimedEquilibria: computeAllNE(MATCHING_PENNIES).map(n => ({ type: n.type, x: n.x, y: n.y })),
    prose: 'A neutral sentence with no numbers in it.',
  };
  assert(
    validateReport(legacyShaped, MATCHING_PENNIES).ok,
    'a report with no geometryClaims field at all must still validate',
  );
}

/**
 * The prose numeric scan across its operator forms. Two tolerance tiers exist
 * on purpose: "=" asserts a value (tight), "≈ ≃ ~" announces a rounding
 * (looser but bounded) — the QA sweep caught the model writing "x≈0.909" in
 * the wild, which the old '='-only regexes never saw. E[A]/E[B] forms are the
 * other closed gap: `\b([AB])=` can never match past the bracket.
 */
function testProseNumericChecks() {
  const MP: GamePayoffs =
    { a11: 1, a12: -1, a21: -1, a22: 1, b11: -1, b12: 1, b21: 1, b22: -1 }; // x*=y*=0.5
  const PD: GamePayoffs =
    { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 }; // NE (0,0), eA=eB=1

  const reportWith = (g: GamePayoffs, prose: string): LlmReport => ({
    claimedEquilibria: computeAllNE(g).map(n => ({ type: n.type, x: n.x, y: n.y })),
    prose,
  });
  const proseKinds = (g: GamePayoffs, prose: string) =>
    validateReport(reportWith(g, prose), g).mismatches
      .filter(m => m.kind.startsWith('prose-')).map(m => m.kind);

  // Approx operator: bounded, not blind. A rounded citation passes; a wrong
  // value hiding behind "≈" still flags.
  assert(proseKinds(MP, 'The mixed point sits near x ≈ 0.52.').length === 0,
    'x ≈ 0.52 for x*=0.5 is a rounding, not a lie — must pass');
  assert(proseKinds(MP, 'The mixed point sits near x≈0.7.').includes('prose-bad-coordinate'),
    'x≈0.7 for x*=0.5 must flag even with the approx operator');
  // The exact operator keeps its tight tolerance — same value, harder claim.
  assert(proseKinds(MP, 'The mixed point is exactly x=0.52.').includes('prose-bad-coordinate'),
    'x=0.52 asserted exactly must flag where x ≈ 0.52 passed');

  // Complement notation is not a coordinate citation: "1−x=0.833" on a game
  // with x*=0.667 is a true statement about Row 2's share, and the bare
  // regex demoted exactly this phrasing live (Spy vs. Analyst). The guard
  // must skip the complement while still flagging a bare wrong x=.
  const BOS_MIX: GamePayoffs =
    { a11: 2, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 2 }; // x*=2/3, y*=1/3
  assert(proseKinds(BOS_MIX, 'A mixes with x=0.667, so 1−x=0.333 falls on Row 2.').length === 0,
    'complement notation (1−x=…) must not be judged as an x citation');
  assert(proseKinds(BOS_MIX, 'A mixes with x=0.667, so 1 - x = 0.333 falls on Row 2.').length === 0,
    'spaced ASCII complement (1 - x = …) must not be judged either');
  assert(proseKinds(BOS_MIX, 'The mix has x=0.333 on Row 1.').includes('prose-bad-coordinate'),
    'a bare wrong x= must still flag with the complement guard in place');

  // E[A]/E[B] citations were structurally invisible to \b([AB])= before.
  assert(proseKinds(PD, 'At the equilibrium E[A]=1.000 and E[B]=1.000.').length === 0,
    'true E[A]/E[B] equilibrium payoffs must pass');
  assert(proseKinds(PD, 'At the equilibrium E[A]=9.9.').includes('prose-bad-payoff'),
    'an invented E[A] value must flag');
  assert(proseKinds(PD, 'Defecting still pays A ≈ 1 at the end.').length === 0,
    'approx-cited real payoff must pass');
}

/**
 * validateScenario against the failure patterns the adversarial QA caught
 * live: a story pairing options exactly backwards (the BoS "Upload works best
 * against Stream" inversion), a real payoff pair cited against the wrong cell
 * (the "Patrol and Warn … 2 and 7" misattribution), and payoff-anchored
 * numbers in a description with nothing declared. Each is undecidable from
 * the sentence but a lookup from the declared claim.
 */
function testScenarioStoryClaims() {
  const BOS: GamePayoffs =
    { a11: 2, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 2 };
  const PD: GamePayoffs =
    { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 };
  const TIED_COL1: GamePayoffs = // A's rows tie against Col 1 — weak claims allowed
    { a11: 5, a12: 3, a21: 5, a22: 1, b11: 2, b12: 1, b21: 4, b22: 3 };

  const sc = (over: Partial<SuggestedScenario>): SuggestedScenario => ({
    name: 'T', row1: 'R1', row2: 'R2', col1: 'C1', col2: 'C2',
    description: 'A neutral story with no numbers.', storyClaims: null, ...over,
  });

  // The live BoS inversion: claiming A's Row 2 does better against B's Col 1.
  assert(!validateScenario(sc({ storyClaims: { cellCitations: [], bestReplies: [
    { player: 'A', opponentOption: 1, bestOption: 2 },
  ] } }), BOS).ok, 'backwards best-reply (the BoS inversion) must fail');
  assert(validateScenario(sc({ storyClaims: { cellCitations: [], bestReplies: [
    { player: 'A', opponentOption: 1, bestOption: 1 },
    { player: 'B', opponentOption: 2, bestOption: 2 },
  ] } }), BOS).ok, 'truthful best-replies must pass');

  // The live misattribution: a real payoff pair declared against the wrong cell.
  assert(!validateScenario(sc({ storyClaims: { cellCitations: [
    { row: 2, col: 1, a: 1, b: 1 }, // (1,1) is Row2/Col2's pair, not Row2/Col1's (5,0)
  ], bestReplies: [] } }), PD).ok, 'real pair cited against the wrong cell must fail');
  assert(validateScenario(sc({ storyClaims: { cellCitations: [
    { row: 2, col: 1, a: 5, b: 0 },
    { row: 1, col: 1, a: 3, b: 3 },
  ], bestReplies: [] } }), PD).ok, 'truthful citations must pass');

  // A tie is a weakly-best claim, not a lie.
  assert(validateScenario(sc({ storyClaims: { cellCitations: [], bestReplies: [
    { player: 'A', opponentOption: 1, bestOption: 1 },
    { player: 'A', opponentOption: 1, bestOption: 2 },
  ] } }), TIED_COL1).ok, 'either option may be claimed best when the column ties');

  // Undeclared payoff-anchored citation in the description.
  assert(!validateScenario(sc({ description: 'If B confesses, staying silent gives A=0 instead.' }),
    PD).ok, 'anchored payoff in the description with nothing declared must fail');
  assert(validateScenario(sc({
    description: 'If B confesses, staying silent gives A=0 instead.',
    storyClaims: { cellCitations: [{ row: 1, col: 2, a: 0, b: 5 }], bestReplies: [] },
  }), PD).ok, 'the same sentence with a covering citation must pass');

  // Malformed indices fail rather than silently skipping.
  assert(!validateScenario(sc({ storyClaims: { cellCitations: [
    { row: 3, col: 1, a: 3, b: 3 },
  ], bestReplies: [] } }), PD).ok, 'a citation naming a nonexistent cell must fail');

  // The escape hatch: a claim-free story declares nothing and passes.
  assert(validateScenario(sc({}), PD).ok, 'a story with no claims and null storyClaims must pass');

  // ── Round-5 closures ──────────────────────────────────────────────────────
  // Compared-payoff declarations: "B gets 9 by playing Col 1 rather than −9"
  // was shown live on THRESH (b11=−1) — both numbers real, allowlists blind,
  // the pairing wrong. Declared pays are checked against the compared cells.
  const THRESH: GamePayoffs =
    { a11: -1, a12: 1, a21: 1, a22: -1, b11: -1, b12: -9, b21: 9, b22: -9 };
  assert(!validateScenario(sc({ storyClaims: { cellCitations: [], bestReplies: [
    { player: 'B', opponentOption: 1, bestOption: 1, bestPays: 9, altPays: -9 },
  ] } }), THRESH).ok, 'the live wrong-row payoff weld (bestPays 9 vs actual −1) must fail');
  assert(validateScenario(sc({ storyClaims: { cellCitations: [], bestReplies: [
    { player: 'B', opponentOption: 1, bestOption: 1, bestPays: -1, altPays: -9 },
  ] } }), THRESH).ok, 'the true compared payoffs must pass');
  assert(validateScenario(sc({ storyClaims: { cellCitations: [], bestReplies: [
    { player: 'B', opponentOption: 1, bestOption: 1, bestPays: null, altPays: null },
  ] } }), THRESH).ok, 'null pays keep the direction-only check');

  // Wordless outcome talk: the live "the quitter loses and the cooperator
  // gains" inversion (QUITGAME rewards quitting) is conditional outcome talk
  // in a digit-free description with no declared best-replies — unverifiable
  // by every other check, so it is withheld.
  const QUITGAME: GamePayoffs =
    { a11: 4, a12: -6, a21: 6, a22: 0, b11: 4, b12: 6, b21: -6, b22: 0 };
  const QUIT_DESC = 'Two partners decide whether to cooperate or quit. If one quits while the other cooperates, the quitter loses and the cooperator gains.';
  assert(!validateScenario(sc({ description: QUIT_DESC, storyClaims: { cellCitations: [
    { row: 1, col: 1, a: 4, b: 4 },
  ], bestReplies: [] } }), QUITGAME).ok, 'wordless conditional outcome talk with no declared best-replies must fail');
  // Policy change (adversarial C3 draw 53): a wordless outcome attribution is
  // withheld even when best replies are declared — declarations carry numbers
  // and directions, never adjectives, so "loses"/"gains" stay unverifiable.
  assert(!validateScenario(sc({ description: QUIT_DESC, storyClaims: { cellCitations: [], bestReplies: [
    { player: 'A', opponentOption: 1, bestOption: 2 },
  ] } }), QUITGAME).ok, 'the same sentence WITH a declared best-reply is still withheld (attribution screen)');
  assert(validateScenario(sc({ description: 'This is zero-sum: what hurts A helps B.' }), QUITGAME).ok,
    'zero-sum framing without a conditional outcome claim must not trip the screen');
  assert(validateScenario(sc({ description: 'If one quits while the other cooperates, the quitter gains 6 and the cooperator loses 6.', storyClaims: { cellCitations: [
    { row: 2, col: 1, a: 6, b: -6 }, { row: 1, col: 2, a: -6, b: 6 },
  ], bestReplies: [] } }), QUITGAME).ok, 'a quantified outcome sentence must not trip the screen');
}

/**
 * validateProseClaims against the F2 specimen caught live: validated prose
 * said "B plays Silent with probability 1 (y=0)" on a game where y=0 was the
 * OTHER column, and read its own cited numbers backwards ("Silent gives B 3
 * or 0 versus Broadcast's 5 or 1" — concluding Silent was best). Every
 * number was right; only the declared lookups can see the words were not.
 */
function testProseDirectionCheck() {
  // The label-aware direction check reads sentences in the game's option
  // words. Specimens are verbatim from the adversarial rounds and the
  // training-gold scan; each "must pass" line is a correct sentence that an
  // earlier draft of the parser misread.
  const PD: GamePayoffs = { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 };
  const pdL = { row1: 'Delay', row2: 'Commit', col1: 'Go', col2: 'Hold' };
  // The live cloud-path defect: correct numbers, inverted label.
  assert(validateProseDirections('If A delays, B prefers to Go because it gives B more (5 rather than 3) instead of holding.', pdL, PD).length > 0,
    'PD description: "B prefers to Go" when A delays must be flagged (B gets 5 for Hold)');
  assert(validateProseDirections('For A, Commit is better than Delay both when B chooses Go (A gets 5 vs 3) and when B chooses Hold (A gets 1 vs 0).', pdL, PD).length === 0,
    'PD prose: correct dominance sentence must pass');

  // L1 D1: strict "better" on a payoff tie (a11 = a21 = 5).
  const TIE: GamePayoffs = { a11: 5, a12: 3, a21: 5, a22: 1, b11: 2, b12: 4, b21: 6, b22: 1 };
  const tieL = { row1: 'Premium', row2: 'Budget', col1: 'Online', col2: 'Retail' };
  assert(validateProseDirections('Premium is better for A against Online.', tieL, TIE).some((i) => i.includes('tie')),
    'tie worded as strict must be flagged');
  assert(validateProseDirections('A is indifferent between Premium and Budget when B chooses Online, but prefers Premium against Retail.', tieL, TIE).length === 0,
    'correct tie wording must pass');
  assert(validateProseDirections('A is indifferent between Premium and Budget whether B chooses Online or Retail.', tieL, TIE).length > 0,
    'over-generalised indifference (L1 D4 class) must be flagged');
  // "Opening the gate is better whether the traveler pays or dodges" — inflections + both-ways cue on a tie.
  const gateL = { row1: 'Open gate', row2: 'Close gate', col1: 'Pay toll', col2: 'Dodge toll' };
  assert(validateProseDirections('Opening the gate is better for the gatekeeper whether the traveler pays or dodges.', gateL, TIE).length > 0,
    'inflected labels with a both-ways cue on a tie must be flagged');

  // L8 draw 68 / L9's 6.1%-of-prose class: an option attributed to the player
  // who does not own it. Only decidable once role nouns map to players, which
  // is why the prompt now requires actorA/actorB — and with none declared the
  // check must stay silent rather than guess.
  const TOLLA: GamePayoffs = { a11: -6, a12: -8, a21: -2, a22: -3, b11: -7, b12: -5, b21: -1, b22: -8 };
  const tollSc = (description: string, actors = true) => ({
    name: 'Toll Bridge', row1: 'Pay Toll', row2: 'Ford River', col1: 'Open Gate', col2: 'Close Gate', description,
    ...(actors ? { actorA: ['traveller'], actorB: ['gatekeeper'] } : {}),
  });
  // THE THREE ROLE-NOUN ASSERTIONS THAT USED TO BE HERE ARE GONE WITH THE RULE.
  //
  // They passed `actorA`/`actorB` straight into `validateScenario` — a shape the
  // product cannot produce. `SCENARIO_SCHEMA` declares neither field and
  // providers.ts sends `additionalProperties:false` with `strict:true`, so a
  // cloud draw cannot carry them, and the local server has never emitted them.
  // The assertions were green for as long as the rule existed and proved only
  // that the rule worked on input nothing generates.
  //
  // The defect itself was then measured directly, without the actor mapping, in
  // its two decidable forms (two subjects both naming one player's pair; one
  // subject naming both pairs) over 8,069 scannable scenarios from every corpus
  // held: zero, with planted controls confirming the instrument fires. See the
  // block comment in nashValidator.ts where the rule used to be for what stays
  // unguarded and why reviving it was tested and does not pay.
  //
  // What replaces them below is the LETTER form, which needs no declaration and
  // is the check that actually caught the one real instance ever captured.

  // DeepSeek-V4-Flash killed the 40-row battery at row 12 with
  // "TypeError: (list ?? []).map is not a function" — actorA came back as a
  // bare string. `?? []` guards only null/undefined, so a wrong-TYPED field
  // walked straight into .map. Every malformed shape must FAIL the scenario,
  // never throw; a validator that throws takes the endpoint with it.
  for (const junk of ['the traveller', 42, {}, true, ['ok', 7], [null]] as unknown[]) {
    const bad = { ...tollSc('Once the gatekeeper chooses Open Gate, the road clears.'), actorA: junk } as never;
    let v: ReturnType<typeof validateScenario>;
    try { v = validateScenario(bad, TOLLA); }
    catch (e) { assert(false, `validateScenario THREW on actorA=${JSON.stringify(junk)}: ${(e as Error).message}`); throw e; }
    assert(!v.ok && v.issues!.some((i) => i.includes('malformed declaration shape')),
      `actorA=${JSON.stringify(junk)} must be reported as a malformed shape, got ${JSON.stringify(v)}`);
  }
  assert(validateScenario({ ...tollSc('Once the gatekeeper chooses Open Gate, the road clears.'), actorA: [] } as never, TOLLA).ok,
    'an EMPTY actor array is a valid shape and must still pass');

  // C25 proved the previous no-pure clause was UNREACHABLE: with no pure
  // equilibrium neither player has a dominant strategy, so exactly one matches
  // and one mismatches — "neither matches" never happens (0 hits in 30,388
  // sampled games). What IS decidable is that such a game has no coordination
  // EQUILIBRIA, while one player's coordination MOTIVE is real and must pass.
  const SHZ = { row1: 'Hunt Stag', row2: 'Hunt Hare', col1: 'Hunt Stag', col2: 'Hunt Hare' };
  const ZSG: GamePayoffs = { a11: 3, a12: -1, a21: -2, a22: 4, b11: -3, b12: 1, b21: 2, b22: -4 };
  assert(computeAllNE(ZSG).filter((n) => n.type === 'pure').length === 0, 'fixture must have no pure equilibrium');
  assert(validateProseDirections('This is fundamentally a coordination game.', SHZ, ZSG).length > 0,
    'a coordination-GAME claim on a game with no pure equilibrium must be flagged');
  assert(validateProseDirections('The coordination equilibria sit on the diagonal.', SHZ, ZSG).length > 0,
    'a coordination-EQUILIBRIA claim must be flagged when there are none');
  assert(validateProseDirections('A wants to coordinate on Hunt Stag, while B wants to avoid it.', SHZ, ZSG).length === 0,
    "one player's coordination MOTIVE is true in this family and must pass");
  assert(validateProseDirections('There is no pure equilibrium here.', SHZ, ZSG).length === 0,
    'the true no-pure statement must pass');

  // C24 probes found a LATENT correct-withheld: these negate the character
  // claim but were absent from the guard, so a true statement would be withheld.
  const SHC = { row1: 'Hunt Stag', row2: 'Hunt Hare', col1: 'Hunt Stag', col2: 'Hunt Hare' };
  const MISC: GamePayoffs = { a11: -9, a12: 2, a21: 7, a22: -1, b11: -1, b12: 1, b21: 6, b22: -9 };
  for (const t of ['This is hardly a coordination game.', 'The equilibria are far from coordination.', 'This is anything but a coordination game.']) {
    assert(validateProseDirections(t, SHC, MISC).length === 0, `a true negation must not be withheld: ${t}`);
  }
  // C24 vocabulary: the NOUN forms the closed list missed.
  assert(validateProseDirections('The coordination tradeoff drives both hunters.', SHC, MISC).length > 0,
    '"coordination tradeoff" must be caught');
  assert(validateProseDirections('They reach coordination on Hunt Stag.', SHC, MISC).length > 0,
    'the NOUN "coordination on X" must be caught, not only the verb');
  // L13's mechanism finding: the complement-pair check was silently disabled on
  // shared-label games — exactly where every mixture defect has occurred.
  const SHG: GamePayoffs = { a11: 5, a12: 0, a21: 0, a22: 3, b11: 4, b12: 0, b21: 0, b22: 6 };
  // NOTE: the probabilities must be THIS game's own (x* = 0.6), because the
  // number check now verifies that every figure in the prose is one the game
  // actually contains — it caught this fixture borrowing another game's values.
  assert(validateProseDirections('A plays Hunt Stag with probability 0.6 and Hunt Hare with probability 0.35.', SHC, SHG).some((i) => i.includes('sum to')),
    'a complement pair must be checked even when both players share option words');
  assert(validateProseDirections('A plays Hunt Stag with probability 0.6 and Hunt Hare with probability 0.4.', SHC, SHG).length === 0,
    'the correct pair must still pass on a shared-label game');

  // Normalisation cut BOTH ways, and each direction was found by a round:
  // deleting apostrophes broke the negation guard (C23, a correct-withheld),
  // and hyphen-as-space hid "co-ordination" (L12). Both readings are now tested.
  const SHN = { row1: 'Hunt Stag', row2: 'Hunt Hare', col1: 'Hunt Stag', col2: 'Hunt Hare' };
  const MISN: GamePayoffs = { a11: -9, a12: 2, a21: 7, a22: -1, b11: -1, b12: 1, b21: 6, b22: -9 };
  assert(validateProseDirections("This isn't a coordination game at all.", SHN, MISN).length === 0,
    'an apostrophe negation must still exempt the sentence');
  assert(validateProseDirections('These are co-ordination outcomes.', SHN, MISN).length > 0,
    'the British hyphenated spelling must be caught');
  assert(validateProseDirections('The equilibria are coordinative.', SHN, MISN).length > 0,
    'the adjectival form must be caught');
  assert(validateProseDirections('This is an anti-co-ordination game.', SHN, MISN).length === 0,
    'a hyphenated anti- form must still be exempt under both readings');

  // C22: four of five defects were ONE rule losing to TYPOGRAPHY — four
  // spellings of the same word reached the screen.
  const SHT = { row1: 'Hunt Stag', row2: 'Hunt Hare', col1: 'Hunt Stag', col2: 'Hunt Hare' };
  const MIST: GamePayoffs = { a11: -9, a12: 2, a21: 7, a22: -1, b11: -1, b12: 1, b21: 6, b22: -9 };
  for (const [name, sentence] of [
    ['participle', 'At both pure equilibria the hunters are coordinated.'],
    ['hyphen compound', 'These are coordination-type outcomes.'],
    ['style compound', 'These are coordination-style pairings.'],
    ['curly quotes', 'These are \u201ccoordination\u201d equilibria.'],
  ] as [string, string][]) {
    assert(validateProseDirections(sentence, SHT, MIST).length > 0, `character claim must survive ${name}`);
  }
  assert(validateProseDirections('This is an anti-coordination game with two anti-coordination equilibria.', SHT, MIST).length === 0,
    'normalising hyphens must not break the anti-coordination exemption');
  assert(validateProseDirections('This is an anti-coordination game.',
    { row1: 'Football', row2: 'Opera', col1: 'Football', col2: 'Opera' },
    { a11: 2, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 2 }).length > 0,
    'the mirror error must still be flagged after normalisation');

  // C21 draw 16 — another character noun form; draw 66 — the negation guard was
  // scoped to the whole sentence and threw away a TRUE flag.
  const SHX = { row1: 'Hunt Stag', row2: 'Hunt Hare', col1: 'Hunt Stag', col2: 'Hunt Hare' };
  const G16C: GamePayoffs = { a11: 5, a12: 7, a21: 8, a22: -8, b11: -2, b12: 4, b21: 8, b22: -8 };
  assert(validateProseDirections('There are two pure outcomes where coordination succeeds.', SHX, G16C).length > 0,
    '"coordination succeeds" on mismatched pures must be flagged');
  const G66C: GamePayoffs = { a11: -9, a12: 2, a21: 7, a22: -1, b11: -1, b12: 1, b21: 6, b22: -9 };
  assert(validateProseDirections('These are coordination equilibria, and at each one both hunters prefer not to deviate.', SHX, G66C).length > 0,
    'an unrelated "not" elsewhere in the sentence must not cancel a false character claim');
  assert(validateProseDirections('This is not a coordination game at all.', SHX, G66C).length === 0,
    'a negation that DOES attach to the character claim must still pass');
  // C21 draw 59 — two probabilities for one player must sum to 1.
  const G59C: GamePayoffs = { a11: -9, a12: 2, a21: 4, a22: -3, b11: 6, b12: 7, b21: 8, b22: -8 };
  const tollC = { row1: 'Pay Toll', row2: 'Ford River', col1: 'Open Gate', col2: 'Close Gate' };
  assert(validateProseDirections('A plays Pay Toll with probability 0.9412 and Ford River with probability 0.0598.', tollC, G59C).some((i) => i.includes('sum to')),
    'a complement pair summing to 1.001 must be flagged');
  assert(validateProseDirections('A plays Pay Toll with probability 0.9412 and Ford River with probability 0.0588.', tollC, G59C).length === 0,
    'the correct complement pair must pass');
  // L10 draw 76 — "prefers" in a shared-option-word game, with a bare frame.
  const G76L: GamePayoffs = { a11: 5, a12: 0, a21: 0, a22: 3, b11: 4, b12: 0, b21: 0, b22: 6 };
  assert(validateProseDirections('Against Hunt Hare, A prefers Hunt Stag.', SHX, G76L).length > 0,
    '"A prefers X" with an unowned frame must be read when both players share option words');
  assert(validateProseDirections('Against Hunt Hare, A prefers Hunt Hare.', SHX, G76L).length === 0,
    'the true preference must pass');

  // Round L9 found that this very check suppressed CORRECT prose: "anti-
  // coordination" CONTAINS "coordination". A check written to catch a false
  // character claim must not fire on the true one by substring.
  const MISX: GamePayoffs = { a11: -9, a12: 2, a21: 7, a22: -1, b11: -1, b12: 1, b21: 6, b22: -9 };
  const stagX = { row1: 'Hunt Stag', row2: 'Hunt Hare', col1: 'Hunt Stag', col2: 'Hunt Hare' };
  assert(validateProseDirections('This is an anti-coordination game with two anti-coordination equilibria.', stagX, MISX).length === 0,
    'TRUE anti-coordination prose on an anti-coordination game must never be withheld');
  // C20 draws 64 and 65, VERBATIM — both near-misses of a tight pattern.
  const G64: GamePayoffs = { a11: -6, a12: -7, a21: 3, a22: -8, b11: -9, b12: -1, b21: 5, b22: -9 };
  assert(validateProseDirections('This Stag Hunt has two ways for both hunters to coordinate with certainty: A playing Hunt Stag and B playing Hunt Hare (x=1,y=0), and A playing Hunt Hare and B playing Hunt Stag (x=0,y=1).', stagX, G64).length > 0,
    '"both hunters to coordinate" on mismatched pures must be flagged');
  assert(validateProseDirections('The two pure equilibria reflect perfect coordination: when A plays Hunt Stag and B plays Hunt Hare, neither wants to move.', stagX, MISX).length > 0,
    '"reflect perfect coordination" on mismatched pures must be flagged');
  // Disjoint option sets: "coordination" has no meaning there, and the diagonal
  // is an artifact of listing order — this shape flagged a training gold.
  assert(validateProseDirections('These alternatives reflect a coordination tension between the two teams.',
    { row1: 'North Route', row2: 'South Route', col1: 'West Route', col2: 'East Route' },
    { a11: 3, a12: -1, a21: -2, a22: 4, b11: 2, b12: -1, b21: -3, b22: 5 }).length === 0,
    'a character claim on a game with DISJOINT option sets must not be judged');
  // C20 draw 72, VERBATIM — a split must sum to 1.
  const G72: GamePayoffs = { a11: 6, a12: 0, a21: 3, a22: 2, b11: 6, b12: 3, b21: 0, b22: 2 };
  assert(validateProseDirections('B uses the same two-fifths/two-fifths split for Hunt Stag vs Hunt Hare.', stagX, G72).some((i) => i.includes('sum to')),
    'a split whose probabilities sum to 0.8 must be flagged');
  assert(validateProseDirections('B uses a two-fifths/three-fifths split for Hunt Stag vs Hunt Hare.', stagX, G72).length === 0,
    'a split summing to 1 must pass');
  // L8 draw 67 VERBATIM — the elided verb in the second welded pair. The first
  // version of this test paraphrased the sentence and restored the verb, so it
  // passed while the real defect still shipped.
  const G67B: GamePayoffs = { a11: 5, a12: 5, a21: 2, a22: 2, b11: 3, b12: 1, b21: 0, b22: 4 };
  assert(validateProseDirections('Apply Early is the applicant\u2019s dominant strategy: it earns 5 rather than 2 against Fast Track and 2 rather than 2 against Full Review.',
    { row1: 'Apply Early', row2: 'Apply Late', col1: 'Fast Track', col2: 'Full Review' }, G67B).some((i) => i.includes('those cells pay')),
    'the VERBATIM defect sentence, with its elided verb, must be caught');

  // C19 draws 67/16 and C18's dominant class: the game's CHARACTER stated
  // backwards by a summary noun, which no verb-based parse can see.
  const MIS: GamePayoffs = { a11: -9, a12: 2, a21: 7, a22: -1, b11: -1, b12: 1, b21: 6, b22: -9 };
  const stagShared = { row1: 'Hunt Stag', row2: 'Hunt Hare', col1: 'Hunt Stag', col2: 'Hunt Hare' };
  assert(validateProseDirections('There are two coordination equilibria in this game.', stagShared, MIS).some((i) => i.includes('MISmatched')),
    'a coordination claim on a game whose pure equilibria are all mismatched must be flagged');
  assert(validateProseDirections('The two pure equilibria are mismatched corners.', stagShared, MIS).length === 0,
    'the true description must pass');
  const BOSC: GamePayoffs = { a11: 2, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 2 };
  const bosShared = { row1: 'Football', row2: 'Opera', col1: 'Football', col2: 'Opera' };
  assert(validateProseDirections('This is a coordination game with two coordination equilibria.', bosShared, BOSC).length === 0,
    'a GENUINE coordination game must not be flagged');
  assert(validateProseDirections('This is an anti-coordination game.', bosShared, BOSC).some((i) => i.includes('matching pair')),
    'the mirror error must be flagged too');

  // C19 draw 55 — the campaign's ONLY correct-withheld. A wholly true paragraph
  // was suppressed because a word-fraction bound BACKWARD across a comma.
  const LOP: GamePayoffs = { a11: -1, a12: 9, a21: 9, a22: 8, b11: -6, b12: 2, b21: 6, b22: 2 };
  const lopL = { row1: 'Strict inspection', row2: 'Lenient inspection', col1: 'Pay bribe', col2: 'Pay nothing' };
  assert(validateProseDirections('A randomizes (one-third Strict inspection, two-thirds Lenient inspection).', lopL, LOP).length === 0,
    'a fraction after a comma binds to the label that FOLLOWS it, not the one before');
  assert(validateProseDirections('A randomizes (two-thirds Strict inspection, one-third Lenient inspection).', lopL, LOP).length > 0,
    'the same sentence with the weights swapped must still be caught');
  // C19 draw 66 — both best replies backwards, in a game where both players
  // share option words so only the named player can resolve the labels.
  const ROADS: GamePayoffs = { a11: 1, a12: 6, a21: 7, a22: 2, b11: 3, b12: 1, b21: 0, b22: 5 };
  const roadL = { row1: 'Take North Road', row2: 'Take South Road', col1: 'Take North Road', col2: 'Take South Road' };
  assert(validateProseDirections("If B takes Take South Road, A's best reply is Take South Road.", roadL, ROADS).length > 0,
    'a backwards best reply must be caught even when both players share option words');
  assert(validateProseDirections("If B takes Take South Road, A's best reply is Take North Road.", roadL, ROADS).length === 0,
    'the correct best reply must pass');
  // L8 draw 67 — a welded payoff pair attached to a column.
  const APPLY: GamePayoffs = { a11: 5, a12: 5, a21: 2, a22: 2, b11: 3, b12: 1, b21: 0, b22: 4 };
  const applyL = { row1: 'Apply Early', row2: 'Apply Late', col1: 'Fast Track', col2: 'Full Review' };
  assert(validateProseDirections('Apply Early earns 2 rather than 2 against Full Review.', applyL, APPLY).length > 0,
    'a false welded payoff pair must be caught');
  assert(validateProseDirections('Apply Early earns 5 rather than 2 against Full Review.', applyL, APPLY).length === 0,
    'the true pair must pass');
  assert(validateProseDirections('Bold pays 7 rather than -1 against Local, while Steady pays 3 rather than -1 against Online.',
    { row1: 'Bold', row2: 'Steady', col1: 'Local', col2: 'Online' },
    { a11: 7, a12: -1, a21: -1, a22: 3, b11: 1, b12: 2, b21: 3, b22: 4 }).length === 0,
    'two welds in one sentence must each bind to their own nearest option');
  // L8 draw 65 — zero-sum values must sum to zero.
  const ZS: GamePayoffs = { a11: 3, a12: -1, a21: -2, a22: 4, b11: -3, b12: 1, b21: 2, b22: -4 };
  const zsL = { row1: 'North Gate', row2: 'South Gate', col1: 'North Gate', col2: 'South Gate' };
  assert(validateProseDirections("This is the minimax outcome, with the patrol's value of 1 and the smuggler's of 1.", zsL, ZS).some((i) => i.includes('zero-sum')),
    'two same-signed values in a zero-sum game must be flagged');
  assert(validateProseDirections("This is the minimax outcome, with the patrol's value of -1 and the smuggler's of 1.", zsL, ZS).length === 0,
    'values that sum to zero must pass');

  // L7 draw 16: a shared-label game whose matching/mismatching character is
  // stated backwards, with the verb standing in for the label's first word.
  const HUNT: GamePayoffs = { a11: -5, a12: 5, a21: 5, a22: 2, b11: -3, b12: 9, b21: 8, b22: -9 };
  const huntL = { row1: 'Hunt Stag', row2: 'Hunt Hare', col1: 'Hunt Stag', col2: 'Hunt Hare' };
  assert(validateProseDirections('There are two pure equilibria: A hunts Hare while B hunts Hare, or A hunts Stag while B hunts Stag.', huntL, HUNT).length > 0,
    '"A hunts Hare" must resolve to the option "Hunt Hare" — the verb absorbs the label\u2019s first word');
  assert(validateProseDirections('There are two pure equilibria: A hunts Stag while B hunts Hare, or A hunts Hare while B hunts Stag.', huntL, HUNT).length === 0,
    'the true anti-coordination profiles must pass');

  // C17 draw 4: a strict preference written as a noun phrase, with an empty
  // intensifier breaking the adjacency the claim parser measures.
  const INSP: GamePayoffs = { a11: 8, a12: -3, a21: -9, a22: -1, b11: 4, b12: -8, b21: -4, b22: 9 };
  const inspL = { row1: 'Inspect', row2: 'Don\u2019t inspect', col1: 'Cooperate', col2: 'Sabotage' };
  assert(validateProseDirections('If B chooses Col 2 for sure, A\u2019s best response is Row 1 for sure.', inspL, INSP).length > 0,
    '"A\u2019s best response is Row 1" must be read as a preference claim, even with "for sure" between the labels');
  assert(validateProseDirections('If B chooses Col 2 for sure, A\u2019s best response is Row 2 for sure.', inspL, INSP).length === 0,
    'the correct version must pass');
  // C17 draw 69: a profile asserted as an equilibrium WITHOUT the word.
  const REG: GamePayoffs = { a11: 4, a12: 0, a21: 1, a22: 3, b11: 3, b12: 1, b21: 0, b22: 5 };
  const regL = { row1: 'Warning', row2: 'Silence', col1: 'No Warning', col2: 'Escalate' };
  assert(validateProseDirections('When B chooses Escalate and A chooses Warning with certainty, neither can improve by switching.', regL, REG).length > 0,
    '"neither can improve by switching" asserts an equilibrium and must be checked');
  assert(validateProseDirections('When B chooses Escalate and A chooses Silence with certainty, neither can improve by switching.', regL, REG).length === 0,
    'the true profile must pass');
  // C17 draw 20: best-response dependence claimed in PROSE on a game with a
  // dominant strategy (validateScenario checked descriptions; prose did not).
  const STAG2: GamePayoffs = { a11: -8, a12: -8, a21: -9, a22: -3, b11: -4, b12: -8, b21: -6, b22: -7 };
  const stag2L = { row1: 'Hunt Stag', row2: 'Hunt Hare', col1: 'Hunt Stag', col2: 'Hunt Hare' };
  assert(validateProseDirections('In this game each player\u2019s best choice depends on the other.', stag2L, STAG2).some((i) => i.includes('dominant')),
    'best-response dependence in prose must be flagged when a player has a dominant strategy');
  // C17 draw 77: cell payoffs stated in free text against the wrong column.
  const MUNI: GamePayoffs = { a11: 2, a12: 7, a21: 2, a22: -3, b11: 4, b12: 4, b21: -2, b22: 5 };
  const muniL = { row1: 'Tight inspections', row2: 'Loose inspections', col1: 'Community ads', col2: 'Permit checks' };
  assert(validateProseDirections('If A uses Tight inspections, it earns 7 against Community ads and 2 against Permit checks.', muniL, MUNI).some((i) => i.includes('that cell pays')),
    'payoffs attached to the wrong opponent option must be flagged');
  assert(validateProseDirections('If A uses Tight inspections, it earns 2 against Community ads and 7 against Permit checks.', muniL, MUNI).length === 0,
    'the correct attribution must pass');
  assert(validateProseDirections('When A plays Row 2, B\u2019s payoff is higher with Col 2 than with Col 1 (Col 2 pays 1 vs Col 1 pays 0).', 
    { row1: 'Strict policy', row2: 'Lenient policy', col1: 'Audit', col2: 'No audit' },
    { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 }).length === 0,
    '"X pays N vs Y pays M" compares a player\u2019s OWN options and is not a cell claim');

  // L6 draw 47: a dominance claim naming the wrong option. The check must read
  // the SUBJECT of a comparative, not the nearest label — "X is better than Y,
  // so it is A's dominant strategy" names Y last.
  const TOLLD: GamePayoffs = { a11: -6, a12: -8, a21: -2, a22: -3, b11: -7, b12: -5, b21: -1, b22: -8 };
  const tollDL = { row1: 'Pay Toll', row2: 'Ford River', col1: 'Open Gate', col2: 'Close Gate' };
  assert(validateProseDirections('Pay Toll is A\u2019s dominant strategy: it does better than Ford River whether the gatekeeper opens or closes the gate.', tollDL, TOLLD).some((i) => i.includes('dominant')),
    'a false dominance claim must be flagged');
  assert(validateProseDirections('Ford River is A\u2019s dominant strategy: it does better than Pay Toll whichever gate choice B makes.', tollDL, TOLLD).length === 0,
    'the true dominance claim must pass');
  assert(validateProseDirections('Phased launch is better than Rapid launch whether B supports fully or minimally, so it is A\u2019s dominant strategy.',
    { row1: 'Phased launch', row2: 'Rapid launch', col1: 'Full support', col2: 'Minimal support' },
    { a11: 7, a12: 0, a21: 6, a22: -3, b11: 1, b12: 2, b21: 3, b22: 4 }).length === 0,
    'the comparative subject, not the nearest label, is the option claimed dominant');
  // L6 draws 1 and 49: indifference claimed at a NAMED pure equilibrium, in a
  // game where both players share their option words.
  const SHARED: GamePayoffs = { a11: 8, a12: -4, a21: -7, a22: 1, b11: 3, b12: 2, b21: -7, b22: 3 };
  const sharedL = { row1: 'Bold launch', row2: 'Cautious launch', col1: 'Bold launch', col2: 'Cautious launch' };
  assert(validateProseDirections('In the Bold launch equilibrium, Firm A is indifferent between its two launches.', sharedL, SHARED).some((i) => i.includes('indifferent at the')),
    'false indifference at a named pure equilibrium must be flagged even when both players share option words');
  assert(validateProseDirections('In the Bold launch equilibrium, Firm A strictly prefers Bold launch.', sharedL, SHARED).length === 0,
    'the correct statement must pass');
  assert(validateProseDirections('At the mixed equilibrium A is indifferent between its two launches.', sharedL, SHARED).length === 0,
    'indifference against the opponent\u2019s MIXTURE is what a mixed equilibrium means and must never be flagged');
  // L6 draw 20: a global "surfaces are not warped" claim on a game that twists.
  const STAG: GamePayoffs = { a11: -3, a12: -4, a21: -2, a22: -3, b11: -6, b12: -4, b21: -9, b22: -2 };
  const stagL = { row1: 'Hunt Stag', row2: 'Hunt Hare', col1: 'Hunt Stag', col2: 'Hunt Hare' };
  assert(validateProseDirections('The payoff surfaces are not warped by the other hunter\u2019s choice.', stagL, STAG).some((i) => i.includes('do not interact')),
    'a false non-interaction claim must be flagged');
  assert(validateProseDirections('A\u2019s expected payoff is flat across its actions along A\u2019s shelf when B mixes.', stagL, STAG).length === 0,
    'a SHELF being flat is not a claim that the surfaces fail to interact');

  // C16 draw 27: two dependence claims of opposite polarity in ONE sentence.
  const FLATROW: GamePayoffs = { a11: -1, a12: 1, a21: -1, a22: 1, b11: -2, b12: -8, b21: -6, b22: -3 };
  const flatL = { row1: 'Immediate signoff', row2: 'Delay signoff', col1: 'Tight review', col2: 'Loose review' };
  assert(validateProseDirections("Their choices set the cost, with A\u2019s payoff depending only on A\u2019s own action and B\u2019s payoff depending on both sides\u2019 actions.", flatL, FLATROW).some((i) => i.includes('own action')),
    '"A\u2019s payoff depends only on A\u2019s own action" must be flagged when the opponent moves it');
  assert(validateProseDirections("A\u2019s payoff depends only on B\u2019s action, since A\u2019s two rows pay the same in each column.", flatL, FLATROW).length === 0,
    'the true statement of the same structure must pass');
  // C16 draw 25: label given inflected ("Warning") while the prose uses the
  // base ("warns"), against a negated partner label ("No warning").
  const WARN: GamePayoffs = { a11: -4, a12: 9, a21: 1, a22: 2, b11: -8, b12: 1, b21: -6, b22: -7 };
  const warnL = { row1: 'Restrict', row2: 'Inspect', col1: 'No warning', col2: 'Warning' };
  assert(validateProseDirections('When B warns, A prefers Inspect.', warnL, WARN).length > 0,
    'a base-form mention of an inflected label must be read (A gets 9 v 2 for Restrict there)');
  assert(validateProseDirections('When B warns, A prefers Restrict.', warnL, WARN).length === 0,
    'the correct version must pass');
  assert(validateProseDirections('When B issues no warning, A prefers Inspect.', warnL, WARN).length === 0,
    'the NEGATED partner label must resolve to its own column, not the affirmative one');

  // C15 draws 7 and 56: PAYOFF dependence confused with PREFERENCE dependence.
  const DOMROW: GamePayoffs = { a11: -1, a12: -4, a21: -6, a22: -9, b11: 2, b12: 5, b21: 3, b22: 1 };
  const domL = { row1: 'Release', row2: 'Hold', col1: 'Confess', col2: 'Deny' };
  assert(validateProseDirections('A\u2019s payoff doesn\u2019t depend on what B does, so A picks the higher row.', domL, DOMROW).some((i) => i.includes('does not depend')),
    '"A\u2019s payoff doesn\u2019t depend on B" must be flagged when A\u2019s row is not flat');
  assert(validateProseDirections('A\u2019s best choice is Release regardless of B\u2019s stance.', domL, DOMROW).length === 0,
    'PREFERENCE independence on a dominant row is true and must pass');
  assert(validateProseDirections('A\u2019s payoff depends on what B does, but A\u2019s preferred row does not.', domL, DOMROW).length === 0,
    'the correctly-worded pair must pass');
  const TIEDBL: GamePayoffs = { a11: 4, a12: 6, a21: 4, a22: 2, b11: 3, b12: 3, b21: 5, b22: 1 };
  const tagL = { row1: 'Aggressive tags', row2: 'Conservative tags', col1: 'Public announce', col2: 'Private hold' };
  assert(validateProseDirections('When A plays Aggressive tags, B\u2019s choice affects both A\u2019s and B\u2019s payoffs.', tagL, TIEDBL).length > 0,
    'a payoff-dependence claim contradicted by a tie in the stated row must be flagged');
  assert(validateProseDirections('When A plays Aggressive tags, B\u2019s choice affects A\u2019s payoff but not B\u2019s.', tagL, TIEDBL).length === 0,
    'the same sentence written correctly must pass');

  // L4 draw 43: a best reply phrased as a DEVIATION ("the gatekeeper would
  // want to close"), naming a cell the player is already best-replying at.
  const TOLL: GamePayoffs = { a11: 1, a12: 8, a21: 6, a22: 2, b11: 4, b12: 3, b21: -9, b22: 10 };
  const tollL = { row1: 'Pay Toll', row2: 'Ford River', col1: 'Open Gate', col2: 'Close Gate' };
  assert(validateProseDirections('There is no pure equilibrium: at Open Gate with Pay Toll, the gatekeeper would want to close, and at Close Gate with Ford River, the traveler would want to pay.', tollL, TOLL).some((i) => i.includes('best-replying')),
    'a deviation claim at a cell the player already best-replies at must be flagged');
  assert(validateProseDirections('There is no pure equilibrium: at Open Gate with Pay Toll, the traveler would want to ford the river, and at Close Gate with Ford River, the traveler would want to pay the toll.', tollL, TOLL).length === 0,
    'the same sentence with the RIGHT mover must pass — the anchored parser must not read "at X with Y" as a preference');
  assert(validateProseDirections('At Close Gate with Ford River, the traveler would not want to switch.', tollL, TOLL).length === 0,
    'an immediately negated deviation is not a claim');

  // L4 draw 54: a coordination game whose players share option words ("A
  // chooses Football while B chooses Opera") rendered as anti-coordination.
  const BOS: GamePayoffs = { a11: 2, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 2 };
  const bosL = { row1: 'Football', row2: 'Opera', col1: 'Football', col2: 'Opera' };
  assert(validateProseDirections('There are two pure equilibria: A chooses Football while B chooses Opera, and A chooses Opera while B chooses Football.', bosL, BOS).length > 0,
    'mismatched profiles named as the pure equilibria must be flagged even when both players share option words');
  assert(validateProseDirections('There are two pure equilibria: A chooses Football while B chooses Football, and A chooses Opera while B chooses Opera.', bosL, BOS).length === 0,
    'the correct matched profiles must pass');
  assert(validateProseDirections('At the mixed equilibrium A chooses Football with probability 0.667 while B chooses Football with probability 0.333.', bosL, BOS).length === 0,
    'a MIXED-equilibrium sentence names both options too and must not read as a pure-profile claim');
  // L4 draws 4/5/11: the tie word attached to the column where the STRICT
  // preference lives, usually contradicting the adjacent clause.
  const TIEW: GamePayoffs = { a11: 5, a12: 3, a21: 5, a22: 1, b11: 2, b12: 4, b21: 6, b22: 1 };
  const tiewL = { row1: 'Premium launch', row2: 'Budget launch', col1: 'Broad campaign', col2: 'Targeted campaign' };
  assert(validateProseDirections('It ties A when B chooses Targeted campaign.', tiewL, TIEW).some((i) => i.includes('ties against')),
    'a tie asserted on the wrong opponent option must be flagged');
  assert(validateProseDirections('It ties A when B chooses Broad campaign.', tiewL, TIEW).length === 0,
    'the tie asserted where the tie actually is must pass');
  assert(validateProseDirections('Away from those ties, A prefers Premium launch to Budget launch against Targeted campaign.', tiewL, TIEW).length === 0,
    '"those ties" is a back-reference, not a tie claim at the framed option');
  // L4 draw 12: a symmetric profile stated once ("both organizers choose morning").
  const CONSTA: GamePayoffs = { a11: 7, a12: 7, a21: 7, a22: 7, b11: 2, b12: 5, b21: 8, b22: 1 };
  const mornL = { row1: 'Morning', row2: 'Evening', col1: 'Morning', col2: 'Evening' };
  assert(validateProseDirections('The continuum of equilibria is the entire line where both organizers choose morning.', mornL, CONSTA).length > 0,
    '"both choose X" naming a non-equilibrium profile must be flagged');
  // L4 draw 7: "the sole equilibrium" on a game the solver already gives two of.
  const TIENEG: GamePayoffs = { a11: -2, a12: -6, a21: -2, a22: -1, b11: -4, b12: -1, b21: -3, b22: -3 };
  const schedL = { row1: 'Full schedule', row2: 'Light schedule', col1: 'Full schedule', col2: 'Light schedule' };
  assert(validateProseDirections('The sole equilibrium has A choose a Light schedule and B choose a Full schedule.', schedL, TIENEG).some((i) => i.includes('sole one')),
    '"the sole equilibrium" on a two-equilibrium game must be flagged');
  assert(validateProseDirections('The payoffs produce a continuum rather than a single equilibrium.', schedL, TIENEG).length === 0,
    'prose CONTRASTING with a single equilibrium must not be read as claiming one');

  // C12 draw 34: the Penalty Kick PRESET's own labels share the word "Left",
  // and the old vocabulary-overlap rule dropped both players' labels, so a
  // backwards best-reply sentence written in them was never parsed.
  const PKG: GamePayoffs = { a11: -12, a12: 8, a21: 2, a22: 0, b11: 12, b12: -8, b21: -2, b22: 0 };
  const pkGL = { row1: 'Kick Left', row2: 'Kick Right', col1: 'Dive Left', col2: 'Dive Right' };
  assert(validateProseDirections('A wants Kick Left against Dive Left, but A\'s best choice flips if B changes sides.', pkGL, PKG).length > 0,
    'shared-word labels (Kick Left / Dive Left) must still be read: A gets -12 vs 2 there');
  assert(validateProseDirections('A wants Kick Right against Dive Left and Kick Left against Dive Right.', pkGL, PKG).length === 0,
    'correct sentence in shared-word labels must pass');
  // Genuinely ambiguous labels still fall back to Row/Col only.
  const dupL = { row1: 'Cooperate', row2: 'Defect', col1: 'Cooperate', col2: 'Defect' };
  assert(validateProseDirections('Cooperate is better for A against Cooperate.', dupL, PD).length === 0,
    'identical labels across players must not be attributed');
  assert(validateProseDirections('Against Row 1, B prefers Col 1 to Col 2.', dupL, PD).length > 0,
    'generic Row/Col names stay readable under ambiguous labels (B gets 3 vs 5)');
  // C12 draw 52: role nouns, not letters, in a dependence claim on a dominant player.
  const DOMA: GamePayoffs = { a11: -2, a12: -7, a21: -1, a22: -4, b11: -3, b12: -1, b21: -8, b22: -6 };
  const roleSc = (description: string) => ({ name: 'Audit', row1: 'Stay Quiet', row2: 'Raise Alert', col1: 'Inspect', col2: 'Skip Audit',
    description, actorA: ['analyst'], actorB: ['manager'] });
  assert(validateScenario({ ...roleSc("Player A is a junior analyst choosing whether to raise an alert. The analyst's best response depends on what the manager does."), actorA: undefined, actorB: undefined }, DOMA).issues.some((i) => i.includes('dominant')),
    'role introduced by the description itself must be attributable (scenarioOnly draws carry no actor arrays)');
  assert(validateScenario(roleSc("The analyst's best response depends on what the manager does."), DOMA).issues.some((i) => i.includes('dominant')),
    "role-noun dependence claim on a player with a dominant strategy must be flagged");
  assert(validateScenario(roleSc("The analyst raises alerts or stays quiet; the manager inspects or skips the audit."), DOMA).ok,
    'plain role-noun setup sentence must pass');

  // C11 draw 28: "a mostly hold-position mix" for an option carried at 1/11
  // (Penalty Kick, x* = 1/11 on Row 1); hyphenated label form must still match.
  const PK: GamePayoffs = { a11: -12, a12: 8, a21: 2, a22: 0, b11: 12, b12: -8, b21: -2, b22: 0 };
  const pkL = { row1: 'Hold Position', row2: 'Dive', col1: 'Kick Left', col2: 'Kick Right' };
  assert(validateProseDirections('At the mixed equilibrium A uses a mostly hold-position mix.', pkL, PK).some((i) => i.includes('mostly')),
    '"mostly <label>" on a 1/11 option must be flagged');
  assert(validateProseDirections('At the mixed equilibrium A uses a mostly Dive mix and only rarely holds position.', pkL, PK).length === 0,
    '"mostly <majority label>" / "rarely <minority label>" must pass');
  assert(validateProseDirections('If A mostly holds position, B should kick right.', pkL, PK).length === 0,
    'hypothetical "if A mostly …" is a frame, not a claim');
  assert(validateProseDirections('A does not mostly hold position here.', pkL, PK).length === 0,
    'negated "mostly" must pass');
  // C11 draw 15: duplicate row labels annotated with a payoff pair the matrix does not hold.
  const SIG: GamePayoffs = { a11: -1, a12: 1, a21: 1, a22: -1, b11: -1, b12: -9, b21: 9, b22: -9 };
  const sigSc = (row1: string, row2: string) => ({ name: 'Signals', row1, row2, col1: 'Listen', col2: 'Ignore', description: 'A signals; B listens or ignores.' });
  assert(validateScenario(sigSc('Signal (−1/−1)', 'Signal (+1/+1)'), SIG).issues.some((i) => i.includes('not distinct')),
    'duplicate row labels must be flagged');
  assert(validateScenario(sigSc('Signal High (−1/−1)', 'Signal Low (+1/+1)'), SIG).issues.some((i) => i.includes('payoff pair')),
    'label annotated with a pair the matrix does not hold must be flagged');
  assert(validateScenario(sigSc('Signal High (−1/1)', 'Signal Low (Row 2)'), SIG).ok,
    "row's own payoff pair and a (Row 2) tag must pass");

  // The local model's gate-invisible inversion (battery q4kmimat row 15): both directions backwards.
  const R15: GamePayoffs = { a11: -8, a12: -9, a21: 9, a22: 4, b11: -9, b12: 7, b21: 8, b22: 2 };
  const r15L = { row1: 'Rush', row2: 'Steady', col1: 'North Route', col2: 'South Route' };
  const r15 = validateProseDirections('The contractor prefers the North Route against Rush but the South Route against Steady.', r15L, R15);
  assert(r15.length === 2, `row-15 inversion must be flagged twice, got ${r15.length}`);
  assert(validateProseDirections('The contractor prefers the South Route against Rush but the North Route against Steady.', r15L, R15).length === 0,
    'row-15 corrected sentence must pass');

  // Shapes that earlier parser drafts misread — all correct, all must pass.
  const ok: [string, GamePayoffs, Record<string, string>][] = [
    ['Against Text Alert, Central Depot does better than Local Depot, and against Central Depot, Text Alert does better than Radio Alert.',
      { a11: 5, a12: 1, a21: 2, a22: 4, b11: 6, b12: 2, b21: 1, b22: 5 }, { row1: 'Central Depot', row2: 'Local Depot', col1: 'Text Alert', col2: 'Radio Alert' }],
    ['The regulator prefers Skip Audit whether the startup chooses Launch or Wait, while the startup prefers Launch against Skip Audit but Wait against Audit.',
      { a11: 5, a12: 3, a21: 8, a22: -4, b11: -2, b12: 1, b21: -9, b22: 8 }, { row1: 'Launch', row2: 'Wait', col1: 'Audit', col2: 'Skip Audit' }],
    ['There is no pure equilibrium: against North Route A prefers Express, against South Route A prefers Economy, while B prefers South Route against Express and North Route against Economy.',
      { a11: 3, a12: -2, a21: -1, a22: 0, b11: -3, b12: 2, b21: 1, b22: 0 }, { row1: 'Express', row2: 'Economy', col1: 'North Route', col2: 'South Route' }],
    ['The startup’s Cautious launch is better whether the distributor chooses Early rollout or Late rollout, and the distributor’s Late rollout is likewise better whether the startup chooses a Bold launch or a Cautious launch.',
      { a11: 4, a12: 2, a21: 5, a22: 5, b11: 0, b12: 6, b21: 0, b22: 4 }, { row1: 'Bold launch', row2: 'Cautious launch', col1: 'Early rollout', col2: 'Late rollout' }],
    ['The manager does better with Safe Launch against an Early Response but with Bold Launch against a Late Response, while the rival prefers Early Response against Bold Launch and Late Response against Safe Launch.',
      { a11: -8, a12: -3, a21: 4, a22: -8, b11: 9, b12: 5, b21: -8, b22: -6 }, { row1: 'Bold Launch', row2: 'Safe Launch', col1: 'Early Response', col2: 'Late Response' }],
    ['The project lead prefers Delay whether the regulator chooses Inspect or Waive Review, while the regulator prefers Inspect after Launch but Waive Review after Delay.',
      { a11: -8, a12: -8, a21: 6, a22: 6, b11: 5, b12: -6, b21: -9, b22: -2 }, { row1: 'Launch', row2: 'Delay', col1: 'Inspect', col2: 'Waive Review' }],
    ['B prefers advertising against a bold launch but advertising or staying quiet against a cautious launch.',
      { a11: 3, a12: 1, a21: 2, a22: 4, b11: 5, b12: 2, b21: 3, b22: 3 }, { row1: 'Bold launch', row2: 'Cautious launch', col1: 'Advertise', col2: 'Stay quiet' }],
    ['For the inspector, Fixed Review is better against Plan Alpha and ties Flexible Review against Plan Beta.',
      { a11: -7, a12: 2, a21: -7, a22: -9, b11: 8, b12: -8, b21: -1, b22: -1 }, { row1: 'Plan Alpha', row2: 'Plan Beta', col1: 'Fixed Review', col2: 'Flexible Review' }],
  ];
  for (const [text, g, labels] of ok) {
    const iss = validateProseDirections(text, labels, g);
    assert(iss.length === 0, `correct sentence must pass: "${text.slice(0, 60)}…" → ${iss[0] ?? ''}`);
  }
  // Indifference induced by a mixture is an equilibrium statement, not a pure-option claim.
  const MIXG: GamePayoffs = { a11: -3, a12: -4, a21: 5, a22: -5, b11: 9, b12: 0, b21: -5, b22: -2 };
  assert(validateProseDirections('A uses Coastal Route with probability 0.25 (and Inland Route with probability 0.75) precisely so that B is indifferent between Basic Cover and Extended Cover.',
    { row1: 'Coastal Route', row2: 'Inland Route', col1: 'Basic Cover', col2: 'Extended Cover' }, MIXG).length === 0,
    'indifference under a mixture must not be judged against pure options');
  const CNR: GamePayoffs = { a11: 2, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 2 };
  assert(validateProseDirections('A randomizes between Plan A and Plan B with probabilities that make B indifferent between Invest and Hold.',
    { row1: 'Plan A', row2: 'Plan B', col1: 'Invest', col2: 'Hold' }, CNR).length === 0,
    '"probabilities that make B indifferent" is induced indifference — must pass (C1 regex bug)');
  // Nano specimens (battery nano_dir): three correct sentences the parser misread, one real error.
  const N64: GamePayoffs = { a11: -1, a12: -1, a21: 5, a22: -9, b11: -8, b12: -5, b21: 1, b22: -5 };
  assert(validateProseDirections('A compares Signal 1 vs Signal 2 knowing whether B will run the Filter (Col 1) or keep the channel Open (Col 2): against Col 1, A prefers Row 2 since 5 beats -1, but against Col 2, A prefers Row 1 since -1 beats -9.',
    { row1: 'Use Signal 1', row2: 'Use Signal 2', col1: 'Run Filter', col2: 'Keep Open' }, N64).length === 0, 'frame-before-colon sentence must pass');
  const N112: GamePayoffs = { a11: -3, a12: 9, a21: 0, a22: 5, b11: -1, b12: -7, b21: 1, b22: -7 };
  assert(validateProseDirections('A prefers Row 2 when B audits, but prefers Row 1 when B does not audit.', { row1: 'Pursue case', row2: 'Drop case', col1: 'Audit', col2: 'No audit' }, N112).length === 0,
    'negated opponent label must not be judged');
  const N19: GamePayoffs = { a11: -4, a12: -8, a21: -7, a22: 8, b11: -1, b12: 6, b21: -2, b22: -3 };
  assert(validateProseDirections('B’s preference between advertising first and second depends on whether A favors Row 1 or Row 2.', { row1: 'Send early', row2: 'Send late', col1: 'Advertise first', col2: 'Advertise second' }, N19).length === 0,
    '"whether A favors X or Y" is a frame, not a claim');
  const N164: GamePayoffs = { a11: 3, a12: -2, a21: -1, a22: 0, b11: -3, b12: 2, b21: 1, b22: 0 };
  assert(validateProseDirections('When A threatens, B prefers accusing to keep A’s payoff down, but when A stands firm, B prefers cooperating.', { row1: 'Threaten', row2: 'Stand firm', col1: 'Accuse', col2: 'Cooperate' }, N164).length > 0,
    'the real nano description error (B prefers accusing when A threatens: -3 vs 2) must be flagged');
  // C1 classes: a (row, col) profile presented as an equilibrium, and welded comparison numbers.
  const C23: GamePayoffs = { a11: 4, a12: 1, a21: 2, a22: 3, b11: 2, b12: 2, b21: 5, b22: 5 }; // B flat; (Row 2, Col 1) is NOT an NE (A: 2 < 4)
  const c23L = { row1: 'Riverside', row2: 'Hillside', col1: 'Morning', col2: 'Evening' };
  assert(validateProseDirections('One equilibrium representative is A using Hillside and B using Morning.', c23L, C23).length > 0,
    'a non-equilibrium profile presented as an equilibrium must be flagged');
  assert(validateProseDirections('The equilibrium has A choose Riverside while B chooses Morning, and another has A choose Hillside with B choosing Evening.', c23L, C23).length === 0,
    'true equilibrium profiles must pass');
  assert(validateProseDirections('Against Morning, A prefers Riverside; the equilibrium is not Hillside with Morning.', c23L, C23).length === 0,
    'negated / best-reply-framed pairs are not judged as profiles');
  const C31: GamePayoffs = { a11: 5, a12: 3, a21: 5, a22: 1, b11: 2, b12: 4, b21: 6, b22: 1 }; // A: Hold=row1? use labels
  assert(validateProseDirections('A is pinned to Hold because Hold gives A 5 rather than Recruit’s 3.', { row1: 'Hold', row2: 'Recruit', col1: 'Listen', col2: 'Ignore' }, C31).length > 0,
    'welded comparison numbers (5 from one column, 3 from the other) must be flagged');
  assert(validateProseDirections('Against Ignore, Hold gives A 3 rather than 1.', { row1: 'Hold', row2: 'Recruit', col1: 'Listen', col2: 'Ignore' }, C31).length === 0,
    'a consistent comparison must pass');
  // Game-shape framing (validateScenario): coordination talk on a dominance game.
  const pdSc = (description: string) => ({ name: 'x', row1: 'Delay', row2: 'Commit', col1: 'Go', col2: 'Hold', description, storyClaims: null });
  assert(!validateScenario(pdSc('Each side has an incentive to match the opponent’s likely choice.'), PD).ok,
    'coordination framing on the Prisoner’s Dilemma must fail');
  assert(validateScenario(pdSc('Each side chooses without knowing the other’s move; the payoffs reward committing.'), PD).ok,
    'neutral PD description must pass');
  const BOSg: GamePayoffs = { a11: 2, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 2 };
  assert(validateScenario({ name: 'x', row1: 'Opera', row2: 'Football', col1: 'Opera', col2: 'Football', description: 'Both want to coordinate on the same event.', storyClaims: null }, BOSg).ok,
    'coordination framing on Battle of the Sexes must pass');
  // Outcome attribution in words (validateScenario): withheld regardless of declarations.
  const pdFull = (description: string) => ({ name: 'x', row1: 'Signal', row2: 'No Signal', col1: 'Listen', col2: 'Ignore', description,
    storyClaims: { cellCitations: [{ row: 1, col: 1, a: 3, b: 3 }], bestReplies: [{ player: 'A' as const, opponentOption: 1, bestOption: 2, bestPays: null, altPays: null }] } });
  assert(!validateScenario(pdFull('Both benefit from coordination on Signal/Listen, while mismatches hurt both.'), PD).ok,
    '"mismatches hurt both" must be withheld even with declarations');
  assert(!validateScenario(pdFull('If they coordinate on the first pair, both receive the smaller mutual payoff.'), PD).ok,
    '"the smaller mutual payoff" attribution must be withheld');
  assert(validateScenario(pdFull('If both choose the first option, each receives 3; the payoffs are the firms’ quarterly scores.'), PD).ok,
    'a quantified attribution passes');
  assert(validateScenario(pdFull('A chooses the Upper Pass or the Lower Pass, while B picks the East or West trail.'), PD).ok,
    'label words like "Lower" are not outcome words');
  // C4 classes: "A=N with <label>" cell attribution; dependence framing on a dominance game; weld numbers only from the claim's own trail.
  const VD: GamePayoffs = { a11: 3, a12: 7, a21: -7, a22: 1, b11: 3, b12: -7, b21: 7, b22: 1 };
  const vdL = { row1: 'Match', row2: 'Mismatch', col1: 'Echo', col2: 'Counter' };
  assert(validateProseDirections('Match gives A the higher payoff (A=3 with Echo vs A=−7 with Counter).', vdL, VD).length > 0,
    'A=−7 with Counter (Counter column pays Match 7) must be flagged');
  assert(validateProseDirections('Match gives A the higher payoff (A=3 with Echo vs A=7 with Counter).', vdL, VD).length === 0,
    'correctly tagged cells must pass');
  assert(!validateScenario(pdSc('Each player’s better response depends on what the other does.'), PD).ok,
    'dependence framing on the PD (both dominant) must fail');
  const AUD: GamePayoffs = { a11: 7, a12: -1, a21: 0, a22: -3, b11: 2, b12: -6, b21: 5, b22: 1 };
  assert(validateProseDirections('Against Audit, Row 1 is better (7 beats 0), and against Ignore Row 1 is better (−1 beats −3); B’s best response is Audit when A plays Row 1 (2 beats −6).', { row1: 'Row 1', row2: 'Row 2', col1: 'Audit', col2: 'Ignore' }, AUD).length === 0,
    'a parenthetical belonging to B’s claim must not be welded onto A’s (C4 draw 20)');
  // C5 classes: a mix stated in words; a preference over the opponent's option.
  const MP2: GamePayoffs = { a11: 1, a12: -1, a21: -1, a22: 1, b11: -1, b12: 1, b21: 1, b22: -1 }; // matching pennies: x*=y*=0.5
  const mpL = { row1: 'Heads', row2: 'Tails', col1: 'Match', col2: 'Differ' };
  assert(validateProseDirections('B puts two-fifths on Match and three-fifths on Differ.', mpL, MP2).length > 0, 'two-fifths where y* = 0.5 must be flagged');
  assert(validateProseDirections('B puts half on Match and half on Differ, so A is indifferent.', mpL, MP2).length === 0, 'a correct word-fraction passes');
  assert(validateProseDirections('B plays Match 50% of the time.', mpL, MP2).length === 0, 'a correct percentage passes');
  const OP: GamePayoffs = { a11: 7, a12: 3, a21: 2, a22: 1, b11: -7, b12: 5, b21: 0, b22: 4 }; // unique pure NE (Row 1, Col 2)
  const opL = { row1: 'Push', row2: 'Wait', col1: 'Resist', col2: 'Agree' };
  assert(validateProseDirections('A gets 7 while B gets −7, and A would rather have B play Agree.', opL, OP).length > 0, 'A would rather have B play Agree (pays A 3 vs 7) must be flagged');
  assert(validateProseDirections('A would rather have B play Resist.', opL, OP).length === 0, 'a correct opponent-preference passes');
  // C6 draw 26: correct conditional preferences with bestReplies: [] — verified by the direction parser, no longer screened.
  const G26: GamePayoffs = { a11: -2, a12: 3, a21: 7, a22: -1, b11: 3, b12: -7, b21: 2, b22: 6 };
  const l26 = { row1: 'Row 1', row2: 'Row 2', col1: 'Col 1', col2: 'Col 2' };
  const prose26 = 'Against Col 1, A prefers Row 2 (7 beats -2); against Col 2, A prefers Row 1 (3 beats -1). Against Row 1, B prefers Col 1 (3 beats -7); against Row 2, B prefers Col 2 (6 beats 2).';
  assert(validateProseClaims({ equilibriumActions: [], bestReplies: [] }, prose26, G26, computeAllNE(G26), false, l26).ok,
    'verified comparisons with empty bestReplies must pass when labels are available');
  assert(!validateProseClaims({ equilibriumActions: [], bestReplies: [] }, prose26, G26, computeAllNE(G26), false).ok,
    'without labels the undeclared-comparison screen still applies');
  assert(!validateProseClaims({ equilibriumActions: [], bestReplies: [] }, 'Against Col 1, A prefers Row 1.', G26, computeAllNE(G26), false, l26).ok,
    'a wrong comparison with empty bestReplies fails (direction issue, not just the screen)');
  // C6 draw 7: "<label> is only better … when <opp>" (inflected labels).
  const BOS7: GamePayoffs = { a11: 2, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 2 };
  assert(validateProseDirections('Enabling caching is only better when A holds stable.', { row1: 'Deploy', row2: 'Hold stable', col1: 'Enable cache', col2: 'Skip cache' }, BOS7).length > 0,
    '"is only better when" with inflected labels must be judged (B: 0 vs 2 against Hold stable)');
  // C7 classes.
  const TX90: GamePayoffs = { a11: -1, a12: 1, a21: 1, a22: -1, b11: -1, b12: -9, b21: 9, b22: -9 }; // pure NE only; A levels at y=0.5
  assert(validateReport({ claimedEquilibria: [{ type: 'pure', x: 0, y: 1 }], prose: 'A’s surface goes level when B plays y=0.5, but the equilibrium sits at the corner.', geometryClaims: null } as any, TX90).ok,
    'citing the indifference value y=0.5 must not be a bad coordinate');
  const CA: GamePayoffs = { a11: 2, a12: 0, a21: 0, a22: 2, b11: 2, b12: 0, b21: 0, b22: 2 };
  assert(!validateReport({ claimedEquilibria: [{ type: 'pure', x: 1, y: 1 }, { type: 'pure', x: 0, y: 0 }], prose: 'In the equilibria, each player picks a strategy that makes the other player indifferent between their two options.', geometryClaims: null } as any, CA).ok,
    'mixed-equilibrium template beside pure-only claims must fail');
  assert(validateReport({ claimedEquilibria: [{ type: 'pure', x: 1, y: 1 }, { type: 'pure', x: 0, y: 0 }, { type: 'mixed', x: 0.5, y: 0.5 }], prose: 'Each player’s mix makes the other player indifferent.', geometryClaims: null } as any, CA).ok,
    'the same sentence with a claimed mixed equilibrium passes');
  assert(validateProseClaims(null, 'A’s tradeoff between Row 1 and Row 2 depends on how much weight B puts on Col 1.', G26, computeAllNE(G26), false, l26).ok,
    'with labels, a sentence the parser cannot read is not screened');
  // L3 draw 40: B's choice described with A's labels on both sides.
  const TUG: GamePayoffs = { a11: -8, a12: 5, a21: 8, a22: -5, b11: -3, b12: 2, b21: 6, b22: 0 };
  const tugL = { row1: 'Steam Tug', row2: 'Diesel Tug', col1: 'Dawn Tide', col2: 'Dusk Tide' };
  assert(validateProseDirections('Against Steam Tug, Diesel Tug is better for the pilot, while against Diesel Tug, Steam Tug is better.', tugL, TUG).length > 0,
    'a claim framed against the same player’s other option must be flagged');
  assert(validateProseDirections('Against Steam Tug, Dusk Tide is better for the pilot, while against Diesel Tug, Dawn Tide is better.', tugL, TUG).length === 0,
    'the correctly labelled version passes');
  // C8 dependence phrasings on dominance games.
  const C8A: GamePayoffs = { a11: -5, a12: -3, a21: -2, a22: 9, b11: 5, b12: 0, b21: -9, b22: 0 }; // A's Row 2 dominant
  assert(!validateScenario({ name: 'x', row1: 'Hold', row2: 'Push', col1: 'Left', col2: 'Right', description: 'A’s best choice responds to what B does, while B weighs both.', storyClaims: null }, C8A).ok,
    '"A’s best choice responds to what B does" on a dominant-A game must fail');
  assert(!validateScenario({ name: 'x', row1: 'Wheat', row2: 'Rye', col1: 'Morning Wind', col2: 'Evening Wind', description: 'The landlord’s choice between Morning Wind and Evening Wind shifts which grain the miller (A) should prefer.', storyClaims: null }, PD).ok,
    '"shifts which grain A should prefer" on a dominant-A game must fail');
  // C9: overlapping scenario names fall back to Row/Col; "changes which of A's actions is best".
  assert(validateProseDirections('A plays Row 2 with probability 1 and B plays Col 2 with probability 0.', { row1: 'Cooperate', row2: 'Defect', col1: 'Cooperate', col2: 'Defect' }, PD).length > 0,
    'with overlapping scenario names, generic Col 2 statements are still judged (Col 2 has probability 1 at the PD equilibrium)');
  assert(!validateScenario({ name: 'x', row1: 'Hold', row2: 'Push', col1: 'Left', col2: 'Right', description: 'B’s feedback policy changes which of A’s actions is best.', storyClaims: null }, C8A).ok,
    '"changes which of A’s actions is best" on a dominant-A game must fail');
  // C10: "makes <label> best" frame with inflected labels; complements written with the coordinate letter.
  const SPOT: GamePayoffs = { a11: 5, a12: 0, a21: 0, a22: 3, b11: 2, b12: 0, b21: 0, b22: 4 };
  assert(validateProseDirections('Sometimes boosting effects makes hiding the spotlight best.', { row1: 'Use spotlight', row2: 'Hide spotlight', col1: 'Boost effects', col2: 'Dim effects' }, SPOT).length > 0,
    '"boosting effects makes hiding the spotlight best" (A gets 0 vs 5) must be flagged');
  assert(validateProseDirections('Boosting effects makes using the spotlight best.', { row1: 'Use spotlight', row2: 'Hide spotlight', col1: 'Boost effects', col2: 'Dim effects' }, SPOT).length === 0,
    'the correct "makes X best" passes');
  assert(validateReport({ claimedEquilibria: [{ type: 'mixed', x: 0.667, y: 0.333 }, { type: 'pure', x: 1, y: 1 }, { type: 'pure', x: 0, y: 0 }], prose: 'A mixes with x=0.667 on Row 1 and x=0.333 on Row 2, while B uses y=0.333 on Col 1 and y=0.667 on Col 2.', geometryClaims: null } as any, BOSg).ok,
    'complements written with the coordinate letter are true statements');
  // Overlapping label vocabularies are skipped, never guessed.
  assert(validateProseDirections('B prefers Downtown against A’s Downtown.', { row1: 'Downtown', row2: 'Campus', col1: 'Downtown', col2: 'Campus' }, TIE).length === 0,
    'overlapping labels must be skipped');
  // Statements the declared claims cannot carry (validateProseClaims reads the prose).
  const BFLAT: GamePayoffs = { a11: 4, a12: 1, a21: 2, a22: 3, b11: 2, b12: 2, b21: 5, b22: 5 }; // B fully indifferent; two pure corners
  const bflatTruth = computeAllNE(BFLAT);
  assert(!validateProseClaims({ equilibriumActions: [], bestReplies: [] }, 'There is no pure equilibrium here.', BFLAT, bflatTruth, true).ok,
    '"no pure equilibrium" on a game with pure corners must fail');
  assert(validateProseClaims({ equilibriumActions: [{ player: 'A', option: 2 }, { player: 'B', option: 1 }], bestReplies: [] }, 'x', BFLAT, bflatTruth, true).ok,
    'degenerate game: (A,2) is a best reply against B option 2 and B may play anything — admissible');
  const BFLAT_DOM: GamePayoffs = { a11: 4, a12: 3, a21: 2, a22: 1, b11: 2, b12: 2, b21: 5, b22: 5 }; // B flat, A's option 1 dominant
  assert(!validateProseClaims({ equilibriumActions: [{ player: 'A', option: 2 }], bestReplies: [] }, 'x', BFLAT_DOM, computeAllNE(BFLAT_DOM), true).ok,
    'degenerate game: A option 2 is never a best reply anywhere on the continuum — must fail (the L2 case-31 hole)');
  const FLAT2: GamePayoffs = { a11: 1, a12: 1, a21: 1, a22: 1, b11: 2, b12: 2, b21: 2, b22: 2 };
  assert(!validateProseClaims(null, 'Every pairing gives both A and B a payoff of 1.', FLAT2, computeAllNE(FLAT2), true).ok,
    'joint payoff statement false for B must fail');
  assert(validateProseClaims(null, 'Every pairing gives A 1 and B 2, so both players are indifferent.', FLAT2, computeAllNE(FLAT2), true).ok,
    'correct flat-game statement must pass');
  console.log('  ✓ prose direction check: catches the cloud PD inversion, tie-as-strict, over-generalised indifference and the row-15 inversion; passes 8 correct specimens');
}

function testEquilibriumSet() {
  // equilibriumSet returns the EXACT equilibrium set, continua included, where
  // computeAllNE enumerates only corners plus the interior mixed point. Two
  // properties are asserted, both by fuzz, because the whole value of the
  // function is that it is right on the games the corner model cannot express:
  //   1. membership agrees with the DEFINITION of Nash equilibrium on a grid;
  //   2. on games with no within-player tie it agrees exactly with
  //      computeAllNE — so adding it to the report can only add equilibria the
  //      shipped list is missing, never change an existing answer.
  const rnd = (() => { let s = 20260829; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; })();
  const isNE = (g: GamePayoffs, x: number, y: number) => {
    const epA = (xx: number) => xx * (y * g.a11 + (1 - y) * g.a12) + (1 - xx) * (y * g.a21 + (1 - y) * g.a22);
    const epB = (yy: number) => yy * (x * g.b11 + (1 - x) * g.b21) + (1 - yy) * (x * g.b12 + (1 - x) * g.b22);
    return epA(x) >= Math.max(epA(0), epA(1)) - 1e-7 && epB(y) >= Math.max(epB(0), epB(1)) - 1e-7;
  };
  const N = 12;
  let gridChecked = 0, ordinaryChecked = 0, tieIncomplete = 0;
  for (let t = 0; t < 3000; t++) {
    const small = () => Math.floor(rnd() * 9) - 4;          // small range: many ties
    const wide = () => Math.floor(rnd() * 19) - 9;
    const cell = t % 2 ? small : wide;
    const g: GamePayoffs = { a11: cell(), a12: cell(), a21: cell(), a22: cell(), b11: cell(), b12: cell(), b21: cell(), b22: cell() };
    const set = equilibriumSet(g);
    const inSet = (x: number, y: number) => set.some((r) => x >= r.x0 - 1e-7 && x <= r.x1 + 1e-7 && y >= r.y0 - 1e-7 && y <= r.y1 + 1e-7);
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
      const x = i / N, y = j / N;
      assert(isNE(g, x, y) === inSet(x, y), `equilibriumSet membership disagrees with the definition at (${x}, ${y}) on ${JSON.stringify(g)}`);
      gridChecked++;
    }
    const tie = g.a11 === g.a21 || g.a12 === g.a22 || g.b11 === g.b12 || g.b21 === g.b22;
    const old = computeAllNE(g);
    if (!tie) {
      ordinaryChecked++;
      assert(set.every((r) => kindOf(r) === 'point'), `no-tie game has a non-point component: ${JSON.stringify(g)}`);
      const mine = set.map((r) => [r.x0, r.y0] as [number, number]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
      const theirs = old.map((n) => [n.x, n.y] as [number, number]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
      assert(mine.length === theirs.length && mine.every((m, i) => Math.abs(m[0] - theirs[i][0]) < 1e-3 && Math.abs(m[1] - theirs[i][1]) < 1e-3),
        `equilibriumSet disagrees with computeAllNE on a tie-free game: ${JSON.stringify(g)}`);
    } else {
      // The shipped list must never claim a NON-equilibrium, even on ties.
      for (const n of old) assert(inSet(n.x, n.y), `computeAllNE reports a non-equilibrium ${n.x},${n.y} on ${JSON.stringify(g)}`);
      if (set.some((r) => kindOf(r) !== 'point')) tieIncomplete++;
    }
  }
  // Named cases whose answers were derived by hand.
  const flat: GamePayoffs = { a11: 2, a12: 2, a21: 2, a22: 2, b11: 4, b12: 4, b21: 4, b22: 4 };
  assert(equilibriumSet(flat).length === 1 && kindOf(equilibriumSet(flat)[0]) === 'area',
    'a doubly-indifferent game is the whole unit square');
  const weakDom: GamePayoffs = { a11: 5, a12: 3, a21: 5, a22: 1, b11: 2, b12: 4, b21: 6, b22: 1 };
  const wd = equilibriumSet(weakDom);
  assert(wd.some((r) => kindOf(r) === 'point' && Math.abs(r.x0 - 1) < 1e-9 && Math.abs(r.y0) < 1e-9)
    && wd.some((r) => kindOf(r) === 'segment' && Math.abs(r.y0 - 1) < 1e-9 && Math.abs(r.x1 - 5 / 7) < 1e-6),
    'weak dominance: the corner (1,0) AND the edge x in [0,5/7] at y=1');
  console.log(`✓ equilibriumSet: ${gridChecked.toLocaleString()} membership checks, ${ordinaryChecked.toLocaleString()} tie-free games identical to computeAllNE, ${tieIncomplete.toLocaleString()} tie games where the corner list is incomplete`);
}

// The joint-payoff check flagged 21 of the 4,462 training golds and produced
// L15's only correct-withheld. Three distinct false-positive SHAPES, all with
// "both" attached to something other than a joint payoff. Every string below is
// VERBATIM from the gold or the round — a paraphrase once passed while the real
// defect still shipped, so paraphrases are not allowed in this file.
// The equilibriumActions check read positive probability off `computeAllNE`,
// which enumerates CORNERS and is documented incomplete on tie games, while the
// `degenerate` escape hatch only catches FULL indifference. A PARTIAL tie (weak
// dominance) produces a continuum neither sees, so true statements about its
// interior were withheld — 2,624 of a 53,512-rendering sweep of the renderer's
// own output. It now reads the exact `equilibriumSet`.
// The claim-free screen is the rung-3 story gate. Dropping on the bare NOUN
// "payoffs" cost 1,269 of 4,462 GOLD scenarios — an off switch, not a filter —
// and the withheld rate is half of what a constraint costs (see the ladder).
// Now 98.0% of golds pass while every genuine claim is still refused.
function testClaimFreeScreen() {
  const drop = (description: string) => !scenarioIsClaimFree({ description } as never).ok;
  // MUST DROP — each is a checkable assertion a scenario has no business making.
  for (const d of [
    "A\u2019s payoff is higher when both cooperate.",
    'The payoffs are greater for the firm that moves first.',
    'Each player prefers the safe option.',
    'B has a dominant strategy here.',
    'A does better by choosing Left.',
    'The equilibrium is where both defect.',
    'Both players end up indifferent between the routes.',
    'Whichever route B takes, A gains by going first.',
    'The team with the larger payoff wins the contract.',
    'Each side earns 4 from the shared route.',
  ]) assert(drop(d), `claim-free screen must refuse: ${d}`);
  // ADVERSARIAL ROUND 1 (2026-08-29), verbatim. The rule required "in response
  // TO", so a bare "…in response." at sentence end slipped through — 2 of 49
  // stories asserted that B moves after seeing A, which is FALSE of a
  // simultaneous game. Round 1 was failed on these and the counter reset.
  for (const d of [
    'A museum visitor chooses between a Quiet Visit and a Stage Protest. The museum director chooses between Call Police and Offer Dialogue in response.',
    'A harbor inspector chooses between Light inspection and Thorough inspection when checking a shipping company. The shipping company chooses between Cooperate and Resist in response.',
  ]) assert(drop(d), `sequential framing of a SIMULTANEOUS game must be refused: ${d.slice(-70)}`);

  // ADVERSARIAL ROUND 2 (fresh games), verbatim. "A chooses X BEFORE B chooses
  // Y" asserts a move order the game does not have. The distinction that must
  // be preserved: "before the INSPECTION" is an event and is fine; "before a
  // port manager CHOOSES" is the other player's move and is not.
  for (const d of [
    'A harbor inspector chooses between Thorough Check and Quick Check before a port manager chooses between Open Access and Restricted Access. The two decisions determine how the inspection and access process is conducted.',
    'A harbor inspector chooses between Thorough Check and Quick Check before a site manager chooses between Open Access and Restricted Access. The two players make these decisions simultaneously while preparing a cargo terminal for inspection.',
  ]) assert(drop(d), `move-order claim must be refused: ${d.slice(0, 80)}`);
  // …while these EVENT references must survive (all verbatim from passing rounds).
  for (const d of [
    'A ship captain chooses between Declare Cargo and Hide Cargo before the inspection.',
    'A warehouse manager chooses between Inspect Route and Skip Route before a shipment leaves.',
    'A traveler chooses whether to Show Pass or Skip Check before approaching the entrance.',
  ]) assert(!drop(d), `an EVENT reference must not be read as move order: ${d.slice(0, 80)}`);

  // MUST PASS — verbatim gold descriptions with no claim and no meta.
  for (const d of [
    'Two subcontractors, Arin and Bela, separately choose how to structure competing proposals for a shared project.',
    'Two drivers approach a narrow one-lane bridge from opposite ends. Each driver chooses whether to Hold Course or Yield before they proceed.',
  ]) assert(!drop(d), `claim-free screen must ALLOW a claim-free story: ${d.slice(0, 80)}`);
  // ── The "payoffs" golds, asserted BY REASON. ────────────────────────────
  // These name the concept only and assert nothing false — the proposition this
  // block was written to protect, and it still holds. They ARE now dropped, by
  // the META screen, for naming the mathematical object in user-facing fiction.
  // True and out of register are independent questions; both are asked here.
  //
  // THE FIRST GOLD CARRIES TWO DEFECT SIGNALS AND IS THEREFORE NOT ISOLATING.
  // Its text opens "A and B are rival campaign managers", which is also a
  // conjoined bare-letter leak, and once that rule existed this row started
  // being rejected for THAT reason first. The verbatim text is kept — a
  // paraphrased regression fixture has already let a real defect ship in this
  // repo — so the assertion accepts either register reason for it, and an
  // ISOLATING third row carrying the payoffs signal ALONE is added so the
  // proposition this block exists for is still tested on its own. Without that
  // third row, deleting the META payoff rule would leave this block green.
  const REGISTER_REASON = /mathematical object|bare letters standing in/;
  for (const d of [
    'A and B are rival campaign managers deciding where to send a field team. Each independently chooses North or South, and the matrix records their strategic payoffs.',
    'Firms A and B simultaneously choose whether to build around a shared industry standard or their own proprietary platform. Their payoffs represent the resulting commercial success for each firm.',
    'Two rival campaign managers decide where to send a field team. Each independently chooses North or South, and the matrix records their strategic payoffs.',
  ]) {
    const w = scenarioIsClaimFree({ description: d } as never).reason ?? '';
    assert(REGISTER_REASON.test(w),
      `the "payoffs" golds are dropped for REGISTER: ${d.slice(0, 60)} -> ${w || '(allowed)'}`);
    if (!/^A and B/.test(d) && !/^Firms A and B/.test(d)) {
      assert(/mathematical object/.test(w),
        `the ISOLATING payoffs gold must be dropped for the PAYOFF rule specifically, not for a letter leak: ${w || '(allowed)'}`);
    }
    assert(!/comparative|attached to a comparison|conditional outcome|moves first|offers and the other accepts/.test(w),
      `no FALSEHOOD screen may fire on a bare "payoffs" gold — that is what this block protects: ${d.slice(0, 60)} -> ${w}`);
  }
  // The port-inspector gold, moved out of the list above and asserted BY REASON.
  // It is now dropped \u2014 but for its META vocabulary ("A is a port inspector"
  // uses the bare letter as the character's name), not by any CLAIM rule, and
  // this block exists to test the claim rules. Asserting the reason keeps the
  // original fact under test instead of letting a gold draw quietly change
  // which screen it is evidence about.
  const inspector = 'A is a port inspector choosing between Light inspection and Thorough inspection. B is a cargo operator choosing between Cooperate and Evade during the inspection.';
  const inspectorWhy = scenarioIsClaimFree({ description: inspector } as never).reason ?? '';
  assert(/bare letter/.test(inspectorWhy),
    `the port-inspector gold must be dropped for META, not for a claim: ${inspectorWhy || '(allowed)'}`);
  assert(!/comparative|payoff word|claim|equilibri/i.test(inspectorWhy),
    'claim-free screen must still find NO CLAIM in the port-inspector gold \u2014 that is what it was quoted to prove');
  console.log('\u2713 claim-free screen: every attached claim refused; the bare-"payoffs" golds carry no claim and are dropped for REGISTER by META instead');
}

function testEquilibriumActionsContinuum() {
  const acts = (g: GamePayoffs, player: 'A' | 'B', option: number) =>
    (validateProseClaims({ equilibriumActions: [{ player, option }], bestReplies: [] }, 'x', g,
      computeAllNE(g), computeIndifference(g).any).issues ?? [])
      .filter((i) => i.includes('probability 0') || i.includes('never a best reply')).length > 0;

  // x is pinned at 0, but y ranges over [0, 0.5]: B really does play option 1.
  const SEG: GamePayoffs = { a11: 1, a12: 0, a21: 0, a22: 1, b11: 0, b12: 1, b21: 0, b22: 0 };
  const set = equilibriumSet(SEG);
  assert(set.length === 1 && kindOf(set[0]) === 'segment' && Math.abs(set[0].y1 - 0.5) < 1e-9,
    `fixture must be the segment x=0, y in [0,0.5]; got ${JSON.stringify(set)}`);
  assert(computeAllNE(SEG).length === 1, 'and computeAllNE must see only the single corner — that is the whole point');
  assert(!acts(SEG, 'B', 1), 'B plays option 1 with probability up to 0.5 on the continuum — must NOT be withheld');
  assert(acts(SEG, 'A', 1), 'A is pinned at option 2, so claiming option 1 must still be caught');

  // The live Silent/Broadcast catch must survive: a unique pure NE at (0,0).
  const PD: GamePayoffs = { a11: -1, a12: -3, a21: 0, a22: -2, b11: -1, b12: 0, b21: -3, b22: -2 };
  assert(acts(PD, 'A', 1) && acts(PD, 'B', 1), 'options never played at the unique pure NE must still be caught');
  assert(!acts(PD, 'A', 2) && !acts(PD, 'B', 2), 'the options actually played must pass');
  console.log('\u2713 equilibriumActions: continuum interiors accepted, unplayed options still caught');
}

// The deterministic renderer must DECLARE what it asserts, or the template path
// publishes prose nothing can verify (it shipped proseClaims: null). Round L15
// measured the model's bestPays/altPays populated 0/46; the renderer prints both
// payoffs, so it has no excuse for leaving them null.
function testTemplateDeclarations() {
  const g: GamePayoffs = { a11: 5, a12: 3, a21: 5, a22: 1, b11: 2, b12: 4, b21: 6, b22: 1 };
  const { prose, claims } = tieProseFull(g, null);
  assert(claims.bestReplies.length > 0, 'the renderer must declare its best replies');
  assert(claims.bestReplies.every((b) => typeof b.bestPays === 'number' && typeof b.altPays === 'number'),
    'bestPays/altPays must be populated — the prose prints both figures');
  // Every declaration must be TRUE of the matrix.
  const pay = (who: 'A' | 'B', r: 1 | 2, c: 1 | 2) => who === 'A'
    ? (r === 1 ? (c === 1 ? g.a11 : g.a12) : c === 1 ? g.a21 : g.a22)
    : (r === 1 ? (c === 1 ? g.b11 : g.b12) : c === 1 ? g.b21 : g.b22);
  for (const b of claims.bestReplies) {
    const alt = (3 - b.bestOption) as 1 | 2;
    const [best, worse] = b.player === 'A'
      ? [pay('A', b.bestOption as 1 | 2, b.opponentOption as 1 | 2), pay('A', alt, b.opponentOption as 1 | 2)]
      : [pay('B', b.opponentOption as 1 | 2, b.bestOption as 1 | 2), pay('B', b.opponentOption as 1 | 2, alt)];
    assert(best > worse, `declared best reply ${JSON.stringify(b)} is not actually better`);
    assert(b.bestPays === best && b.altPays === worse, `declared payoffs ${b.bestPays}/${b.altPays} != ${best}/${worse}`);
  }
  // And the whole package must pass the gate it will be published through.
  const v = validateProseClaims(claims, prose, g, computeAllNE(g), computeIndifference(g).any, null);
  assert(v.ok, `the renderer's own output must pass the production gate: ${(v.issues ?? []).join(' | ')}`);
  console.log('\u2713 template declarations: bestPays/altPays populated and true, output passes its own gate');
}

// RED TEAM findings, 2026-08-29. All four were reachable from the shipping UI
// and all four were missed by 300 hand-derived games plus 1.08M fuzz renderings.
// RED TEAM #3, 2026-08-29. All three were in DETERMINISTIC code, not the model.
// RED TEAM #4. The simulation was the untested half of the app: every prior
// round exercised the report API, never the best-response run.
// RED TEAM #5. Break 1 was a REGRESSION I introduced: the convergedIsNE gate
// compared regret to 1e-6 while the engine quantises coordinates through r3,
// so purely quantisation-induced residual tripped it on the app's own presets.
function testRedTeamFindings13() {
  // A run must not change its own rules mid-flight. Same game, same start, same
  // mover — only the step parameter differs partway. The forward stepper used to
  // read LIVE controls while the precomputed history (progress denominator and
  // the Step-button gate) still described the abandoned trajectory, so the app
  // announced "Equilibrium reached" and disabled Step at (0, 1) on Spy vs.
  // Analyst, where A gains 4 by switching. Unique NE is (1/6, 1/3).
  const spy = (PRESETS as Record<string, { payoffs?: GamePayoffs } & GamePayoffs>).spy;
  const g = (spy.payoffs ?? spy) as GamePayoffs;
  const m = computeMixedNE(g)!;
  assert(Math.abs(m.x - 1 / 6) < 1e-9 && Math.abs(m.y - 1 / 3) < 1e-9,
    'fixture: Spy vs. Analyst has its unique equilibrium at (1/6, 1/3)');
  // The profile the broken run halted on is emphatically not an equilibrium.
  const rq = Math.max(Math.abs(regretA(0, 1, g)), Math.abs(regretB(0, 1, g)));
  assert(rq > 3.9,
    `(0,1) gives a player a gain of ${rq} — the app must never call that an equilibrium`);
  assert(rq > neTolerancePlayer(g, 'A') && rq > neTolerancePlayer(g, 'B'),
    'and it must fail the per-player gate');

  // Unicode minus signs must reach the solver as real negatives. A pasted
  // U+2212 used to display "−4" while every panel computed with 0.
  const canon = (t: string) => t.replace(/[\u2212\u2013\u2014\uFF0D\u2010\u2011]/g, '-');
  for (const [raw, want] of [['\u22124', -4], ['\u22123.5', -3.5], ['-12.75', -12.75]] as const) {
    const v = parseFloat(canon(raw));
    assert(!isNaN(v) && v === want, `"${raw}" must parse to ${want}, got ${v}`);
  }
  assert(isNaN(parseFloat('\u22124')),
    'fixture: without normalisation the unicode minus really does fail to parse');
  console.log('\u2713 red-team #13: run parameters frozen for the forward path too; unicode minus reaches the solver');
}

function testRedTeamFindings11and12() {
  // Replay must consume the run's OWN parameters. The app replays finished runs
  // for Back and "Go to step"; three rounds of defects came from feeding that
  // replay LIVE controls. Freezing firstMover was not enough — `committedNE` is
  // DERIVED from firstMover, and doStep steers pure-NE games toward it, so a
  // mover toggle re-aimed the replay even with the mover argument frozen.
  const bos: GamePayoffs = { a11: 2, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 2 };
  const pures = computeAllNE(bos).filter((n) => n.type === 'pure');
  assert(pures.length >= 2, 'BoS has two pure equilibria with opposed mover preferences');
  const bestFor = (who: 'A' | 'B') =>
    pures.reduce((b, n) => ((who === 'A' ? n.eA : n.eB) > (who === 'A' ? b.eA : b.eB) ? n : b));
  const cA = bestFor('A'), cB = bestFor('B');
  assert(cA.x !== cB.x || cA.y !== cB.y,
    'fixture: the two players commit to DIFFERENT corners — this is what makes committedNE load-bearing');

  // Same mover, same payoffs, same everything EXCEPT committedNE => different
  // trajectory. So committedNE cannot be read live while the rest is frozen.
  const runWith = (committed: typeof cA) => {
    const st = createInitialState(0.217, 0.217, bos);
    const all = computeAllNE(bos);
    for (let i = 0; i < 400 && !st.converged; i++) {
      doStep(bos, st, 'A', 0.1, all, committed, () => {}, () => {}, () => {}, 'shrink');
    }
    return st;
  };
  const withA = runWith(cA), withB = runWith(cB);
  assert(withA.cx !== withB.cx || withA.cy !== withB.cy,
    `committedNE steers the trajectory (A-committed ended (${withA.cx},${withA.cy}), B-committed ended (${withB.cx},${withB.cy})) — it MUST be part of the frozen replay context`);
  assert(withA.cx === 1 && withA.cy === 1,
    'the honest A-first run lands on (1,1), the corner A prefers');
  assert(withB.cx === 0 && withB.cy === 0,
    'and the B-committed replay lands on (0,0) — the point the displayed run never occupied');

  // The mover-narration payoff must come from the run, not the live toggle.
  assert(r3(EA(withA.cx, withA.cy, bos)) === 2 && r3(EA(withB.cx, withB.cy, bos)) === 1,
    'A realises 2.000 on its own run and 1.000 on the B corner — "Player A moved first and realised 1.000" was the B-first outcome');
  console.log('\u2713 red-team #11/#12: committedNE and the full replay argument set are part of the run context');
}

function testRedTeamFindings10() {
  // The box mixed LIVE geometry with a DEAD run: resolveProfile reads
  // equilibriumSet(payoffs) — current React state — while s.exactX/exactY are
  // frozen at the last doStep. Editing one matrix cell updated the first and
  // not the second, because updatePayoffField never reset the sim (every other
  // loader does). Every earlier test passed the SAME g to simulate and to
  // resolveProfile, so the pairing the app does not guarantee was never tested.
  const pd: GamePayoffs = { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 };
  const st = simulate(pd, { firstMover: 'A', stepMode: 'shrink', shrinkStep: 0.2 });
  assert(st.converged, 'fixture: PD converges');

  // The user edits a22: 1 -> -1. The run is now stale.
  const edited: GamePayoffs = { ...pd, a22: -1 };
  const res = resolveProfile(edited, st);

  // 1. Whatever the box prints must be an equilibrium OF THE GAME ON SCREEN.
  const set = equilibriumSet(edited);
  assert(set.some((r) => r.x0 - 1e-9 <= res.x && res.x <= r.x1 + 1e-9
                      && r.y0 - 1e-9 <= res.y && res.y <= r.y1 + 1e-9),
    'the reported point must be an equilibrium of the edited game');

  // 2. The invariant that was actually violated: the payoffs printed beside the
  //    coordinates must be the payoffs AT those coordinates. The old box read
  //    EA(simState.cx, simState.cy) — a different point entirely.
  const shownEA = r3(EA(res.x, res.y, edited));
  const staleEA = r3(EA(st.cx, st.cy, edited));
  assert(shownEA !== staleEA,
    'fixture must actually discriminate: the run position and the equilibrium must give different payoffs here');
  assert(Math.abs(shownEA - EA(res.x, res.y, edited)) < 1e-9,
    'box payoffs must be evaluated at the box coordinates');

  // 3. And the run really is NOT an equilibrium of the edited game, so the box
  //    must not be claiming one at the stale position.
  const rqStale = Math.max(Math.abs(regretA(st.cx, st.cy, edited)), Math.abs(regretB(st.cx, st.cy, edited)));
  assert(rqStale > neTolerancePlayer(edited, 'A'),
    `the stale position has regret ${rqStale} in the edited game — it is not an equilibrium there`);

  // Sweep the pairing generally: simulate one game, render against a perturbed
  // one, and require the box to stay self-consistent for BOTH games.
  let seed = 90210, checked = 0;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const q = () => Math.floor(rnd() * 19) - 9;
  for (let t = 0; t < 400; t++) {
    const g1: GamePayoffs = { a11: q(), a12: q(), a21: q(), a22: q(), b11: q(), b12: q(), b21: q(), b22: q() };
    const keys: (keyof GamePayoffs)[] = ['a11','a12','a21','a22','b11','b12','b21','b22'];
    const g2: GamePayoffs = { ...g1, [keys[Math.floor(rnd() * 8)]]: q() };
    let s1: SimState;
    try { s1 = simulate(g1, { firstMover: 'A', stepMode: 'shrink', shrinkStep: 0.1, maxSteps: 1200 }); } catch { continue; }
    if (!s1.converged) continue;
    for (const g of [g1, g2]) {
      const r = resolveProfile(g, s1);
      checked++;
      const inSet = equilibriumSet(g).some((rr) => rr.x0 - 1e-9 <= r.x && r.x <= rr.x1 + 1e-9
                                                && rr.y0 - 1e-9 <= r.y && r.y <= rr.y1 + 1e-9);
      assert(inSet, `reported point (${r.x}, ${r.y}) is not an equilibrium of the rendered game ${JSON.stringify(g)}`);
      const isVertex = (v: number) => v === 0 || v === 1;
      assert(r.concept === (isVertex(r.x) && isVertex(r.y) ? 'pure' : 'mixed'),
        `concept mismatch at (${r.x}, ${r.y}) for ${JSON.stringify(g)}`);
    }
  }
  assert(checked > 400, `sweep must exercise the path (only ${checked})`);
  console.log(`\u2713 red-team #10: box coordinates, concept and payoffs all read the rendered game; ${checked} cross-game renders checked`);
}

function testRedTeamFindings9() {
  // #20 — shrink locks on the domain boundary; only equilibrium is mixed.
  const g20: GamePayoffs = { a11: 20, a12: 0, a21: -20, a22: 0.025, b11: 0, b12: 0.025, b21: 20, b22: -20 };
  const s20 = simulate(g20, { firstMover: 'A', stepMode: 'shrink', shrinkStep: 0.1 });
  assert(computeAllNE(g20).filter((n) => n.type === 'pure').length === 0, 'fixture g20 has no pure NE');
  assert(r3(s20.cx) === 1 && r3(s20.cy) === 0, 'fixture: the run really locks on the (1,0) boundary');
  const r20 = resolveProfile(g20, s20);
  assert(r20.concept === 'mixed',
    'the box must not say PURE on a game whose own report says "No pure strategy NE coordinates exist"');
  assert(r20.x > 0.999 && r20.x < 1, 'and must print the mixed NE it converged to, not the boundary it stopped on');

  // #21 — a genuine strict pure NE that shares 3 decimals with the mixed NE.
  const g21: GamePayoffs = { a11: 100, a12: -100, a21: 99.95, a22: 99, b11: 0.05, b12: 0, b21: -100, b22: 100 };
  const s21 = simulate(g21, { firstMover: 'A', stepMode: 'shrink', shrinkStep: 0.1 });
  const r21 = resolveProfile(g21, s21);
  assert(r21.x === 1 && r21.y === 1 && r21.concept === 'pure',
    'a run ending ON a strict pure NE must report that point — not the mixed NE that merely rounds alike');

  // #22 — indifference must be judged against the player's OWN payoffs.
  const g22: GamePayoffs = { a11: 100, a12: 100, a21: 100, a22: -100, b11: 0.4, b12: 0, b21: 0, b22: 0.001 };
  assert(indifferenceAt(g22, 0.9, 1).b === false,
    'a 0.3599 gap — 90% of B\'s entire payoff range — is not indifference, whatever A\'s payoffs span');

  // ── TOTALITY, not fixtures. RT#9: "one fixture is not a totality proof."
  // Sweep the REAL sim and assert the cross-panel invariant directly: whatever
  // the box reports must BE an equilibrium, and its concept must match it.
  let checked = 0;
  let seed = 4242;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const shapes: (() => GamePayoffs)[] = [
    () => { const P = 5 + Math.floor(rnd() * 60), e = Math.round(rnd() * 60) / 1000 + 0.001;
            return { a11: P, a12: 0, a21: -P, a22: e, b11: 0, b12: e, b21: P, b22: -P }; },
    () => { const q = () => Math.round((rnd() * 200 - 100) * 1000) / 1000;
            return { a11: q(), a12: q(), a21: q(), a22: q(), b11: q(), b12: q(), b21: q(), b22: q() }; },
    () => { const q = () => Math.floor(rnd() * 19) - 9;
            return { a11: q(), a12: q(), a21: q(), a22: q(), b11: q(), b12: q(), b21: q(), b22: q() }; },
  ];
  for (let t = 0; t < 900; t++) {
    const g = shapes[t % shapes.length]();
    for (const fm of ['A', 'B'] as const) for (const mode of ['shrink', 'regret'] as const) {
      let st: SimState;
      try { st = simulate(g, { firstMover: fm, stepMode: mode, shrinkStep: 0.1, maxSteps: 1200 }); } catch { continue; }
      if (!st.converged || st.convergedIsNE === false) continue;
      checked++;
      const res = resolveProfile(g, st);
      const set = equilibriumSet(g);
      const inSet = set.some((r) => r.x0 - 1e-9 <= res.x && res.x <= r.x1 + 1e-9
                                 && r.y0 - 1e-9 <= res.y && res.y <= r.y1 + 1e-9);
      assert(inSet,
        `box would assert an equilibrium at (${res.x}, ${res.y}) which is NOT in the equilibrium set of ${JSON.stringify(g)}`);
      const isVertex = (v: number) => v === 0 || v === 1;
      const trueConcept = isVertex(res.x) && isVertex(res.y) ? 'pure' : 'mixed';
      assert(res.concept === trueConcept,
        `box would call (${res.x}, ${res.y}) "${res.concept}" on ${JSON.stringify(g)}`);
      if (trueConcept === 'pure') {
        assert(computeAllNE(g).some((n) => n.type === 'pure'),
          `box would say PURE on a game with no pure NE: ${JSON.stringify(g)}`);
      }
    }
  }
  assert(checked > 500, `sweep must actually exercise the path (only ${checked} converged runs)`);
  console.log(`\u2713 red-team #9: exact coordinates carried on the state; ${checked} converged runs, every reported equilibrium is in the equilibrium set`);
}

function testRedTeamFindings8() {
  // ── THE LESSON OF THIS ROUND ─────────────────────────────────────────────
  // The #7 test called profileConcept(computeMixedNE(g).x, …) — the solver's
  // exact coordinate. No panel ever passes that. doStep collapses the state
  // through r3 (`s.cx = s.displayX = r3(nx)`), so the app passed 1 and 0, got
  // "pure", and the test stayed green while the defect shipped. These tests
  // drive the REAL simulation and assert on what the box would actually print.
  const g16: GamePayoffs = { a11: 100, a12: 0, a21: -100, a22: 0.09, b11: 0, b12: 0.09, b21: 100, b22: -100 };
  const st = simulate(g16, { firstMover: 'A', stepMode: 'shrink', shrinkStep: 0.1 });
  assert(st.converged, 'fixture converges');
  assert(r3(st.cx) === 1 && r3(st.cy) === 0,
    'the state really is r3-collapsed onto a vertex — this is the trap');
  assert(computeAllNE(g16).filter((n) => n.type === 'pure').length === 0,
    'and the game really has NO pure equilibrium');
  const res = resolveProfile(g16, st);
  assert(res.concept === 'mixed',
    'the BOX must not say "Pure Strategy Nash Equilibrium Reached" on a game with no pure NE');
  assert(res.x > 0.999 && res.x < 1 && res.y > 0 && res.y < 0.001,
    'and it must print the exact coordinates, not the collapsed ones');
  assert(fmtProb(res.x) === 'more than 0.999' && fmtProb(res.y) === 'less than 0.001',
    'box coordinates must read as the log and report panel already do');

  // ── Break 2: tolerance must be invariant under PER-PLAYER rescaling ───────
  const g2: GamePayoffs = { a11: 0, a12: 100, a21: 0, a22: -100, b11: 0, b12: 0.399, b21: 10, b22: 9.99 };
  assert(Math.abs(regretB(1, 1, g2)) > neTolerancePlayer(g2, 'B'),
    'B gains 0.399 at (1,1) by B\'s own payoffs — that is not an equilibrium whatever A\'s payoffs span');
  // Rescaling ONE player's payoffs cannot move either player's equilibrium set.
  for (const k of [0.01, 1, 100]) {
    const sc: GamePayoffs = { ...g2, a11: g2.a11 * k, a12: g2.a12 * k, a21: g2.a21 * k, a22: g2.a22 * k };
    assert(Math.abs(regretB(1, 1, sc)) > neTolerancePlayer(sc, 'B'),
      `scaling only A's payoffs by ${k} must not change B's verdict at (1,1)`);
  }
  // Presets must still be recognised under the per-player tolerance.
  for (const [key, preset] of Object.entries(PRESETS as Record<string, { payoffs?: GamePayoffs } & GamePayoffs>)) {
    const g = (preset.payoffs ?? preset) as GamePayoffs;
    if (g.a11 === undefined) continue;
    const mixed = computeAllNE(g).find((n) => n.type === 'mixed');
    if (!mixed) continue;
    const qx = r3(mixed.x), qy = r3(mixed.y);
    assert(Math.abs(regretA(qx, qy, g)) <= neTolerancePlayer(g, 'A')
      && Math.abs(regretB(qx, qy, g)) <= neTolerancePlayer(g, 'B'),
      `preset "${key}" must still be recognised as an NE under the per-player tolerance`);
  }
  console.log('\u2713 red-team #8: box resolves to exact coordinates through the real sim path, tolerance is per-player');
}

function testRedTeamFindings7() {
  // ── Defect #16: profileConcept collapsed a strictly-mixed NE onto a vertex ──
  // Verbatim fixture. Unique equilibrium is strictly mixed at
  // x*=200/200.09, y*=0.09/200.09; this game has NO pure equilibrium at all.
  const g16: GamePayoffs = { a11: 100, a12: 0, a21: -100, a22: 0.09, b11: 0, b12: 0.09, b21: 100, b22: -100 };
  assert(computeAllNE(g16).filter((n) => n.type === 'pure').length === 0,
    'fixture: every corner of g16 has a deviator, so there is no pure NE');
  const m16 = computeMixedNE(g16)!;
  assert(m16.x > 0.999 && m16.x < 1 && m16.y > 0 && m16.y < 0.001,
    'fixture: both coordinates are strictly interior but round to a vertex');
  assert(Math.round(m16.x * 1000) / 1000 === 1 && Math.round(m16.y * 1000) / 1000 === 0,
    'fixture: r3 really does collapse both coordinates onto vertices');
  assert(profileConcept(m16.x, m16.y) === 'mixed',
    'a strictly-interior equilibrium is MIXED — deciding the noun on rounded coordinates announced a pure NE on a game with none');
  // fmtProb must keep refusing the same collapse, and the box now shares it.
  assert(fmtProb(m16.x) === 'more than 0.999' && fmtProb(m16.y) === 'less than 0.001',
    'the coordinates must render without collapsing onto 0/1');

  // ── Defect #17: indifference asserted for a player who strictly prefers ────
  // Verbatim fixture, all UI defaults; converges to (1, 0.217) on a continuum.
  const g17: GamePayoffs = { a11: 3, a12: 4, a21: 4, a22: -2, b11: -2, b12: -2, b21: -2, b22: -1 };
  const st = indifferenceAt(g17, 1, 0.217);
  const eRow1 = 0.217 * g17.a11 + 0.783 * g17.a12;
  const eRow2 = 0.217 * g17.a21 + 0.783 * g17.a22;
  assert(Math.abs(eRow1 - eRow2) > 4,
    `fixture: A's rows differ by ${Math.abs(eRow1 - eRow2)} at y=0.217`);
  assert(st.a === false,
    'A strictly prefers Row 1 by 4.481 here — the box must not print "A indifferent: 3.783 ≈ -0.698"');
  assert(st.b === true, 'B really is indifferent on this continuum, which is why B can mix');
  // A genuine interior mixed NE must still report BOTH players indifferent.
  const spy = (PRESETS as Record<string, { payoffs?: GamePayoffs } & GamePayoffs>).spy;
  const gs = (spy.payoffs ?? spy) as GamePayoffs;
  const ms = computeMixedNE(gs)!;
  const both = indifferenceAt(gs, ms.x, ms.y);
  assert(both.a && both.b, 'at a true interior mixed NE both players are indifferent');
  // fmtProb's prose forms must not be dropped raw into math mode — KaTeX renders
  // "more than 0.999" as the run-together italic variables "morethan0.999".
  assert(texProb(m16.x) === '\\text{more than 0.999}' && texProb(m16.y) === '\\text{less than 0.001}',
    'prose probability forms must be wrapped in \\text{} for KaTeX');
  assert(texProb(0.217) === '0.217' && texProb(0) === '0' && texProb(1) === '1',
    'plain numbers must pass through as maths, unwrapped');
  console.log('\u2713 red-team #7: concept decided on exact coordinates, indifference asserted only where it holds');
}

function testRedTeamFindings6() {
  // ── Break A: neTolerance's Math.max(1, spread) floor ──────────────────────
  // The floor pinned the tolerance at a constant 0.002 for every game with
  // spread < 1 — larger than the whole payoff range of such a game, so every
  // profile passed. Verbatim red-team fixture:
  const tiny: GamePayoffs = { a11: 0, a12: 0.001, a21: 0.001, a22: 0.001, b11: 0, b12: 0, b21: 0.001, b22: 0 };
  const rqTiny = Math.max(Math.abs(regretA(1, 1, tiny)), Math.abs(regretB(1, 1, tiny)));
  assert(rqTiny > neTolerance(tiny),
    `(1,1) gains ${rqTiny} — 100% of this game's payoff range — and must NOT pass the NE tolerance (tol ${neTolerance(tiny)})`);
  // The equilibria really are only the two opposite corners.
  const tinySet = equilibriumSet(tiny);
  assert(!tinySet.some((r) => r.x0 <= 1 && 1 <= r.x1 && r.y0 <= 1 && 1 <= r.y1),
    '(1,1) must not be in the equilibrium set of the tiny-payoff fixture');

  // NE-ness is invariant under positive rescaling of payoffs. Any tolerance
  // that changes the verdict when every payoff is multiplied by a constant is
  // not testing for a Nash equilibrium. This is the property the floor broke.
  for (const scale of [0.001, 0.01, 1, 1000]) {
    const base: GamePayoffs = { a11: 9, a12: -1, a21: -9, a22: 9, b11: -4, b12: -7, b21: -2, b22: -2 };
    const sc = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v * scale])) as unknown as GamePayoffs;
    const rq = Math.max(Math.abs(regretA(0, 1, sc)), Math.abs(regretB(0, 1, sc)));
    assert(rq > neTolerance(sc),
      `the regret-18 non-equilibrium must stay a non-equilibrium at scale ${scale} (regret ${rq}, tol ${neTolerance(sc)})`);
  }

  // ── Break B: "Pure" concept printed on a strictly mixed profile ───────────
  // Verbatim red-team fixture: the run settles at x*=1.000, y*=0.500 on a
  // continuum where B mixes 50/50, and the box said "PURE STRATEGY NASH
  // EQUILIBRIUM REACHED" because it took its noun from nearestNE.
  const cont: GamePayoffs = { a11: -5, a12: 4, a21: -1, a22: -7, b11: 6, b12: 6, b21: -3, b22: -2 };
  const rqCont = Math.max(Math.abs(regretA(1, 0.5, cont)), Math.abs(regretB(1, 0.5, cont)));
  assert(rqCont <= neTolerance(cont), 'fixture: (1, 0.5) really is an equilibrium of this game');
  assert(profileConcept(1, 0.5) === 'mixed',
    'a profile where B mixes 50/50 is NOT a pure-strategy equilibrium, whatever the nearest listed NE is');
  assert(profileConcept(1, 1) === 'pure' && profileConcept(0, 1) === 'pure' && profileConcept(0, 0) === 'pure',
    'both players at a vertex is pure');
  assert(profileConcept(0.5, 0) === 'mixed' && profileConcept(0.217, 0.217) === 'mixed',
    'either player mixing makes the profile mixed');
  // SUPERSEDED BY RED TEAM #7. This originally asserted the opposite — that a
  // coordinate displaying as 1.000 should read as "pure" — which locked in the
  // very collapse #7 then found: it announced a PURE equilibrium on a game with
  // no pure equilibrium. Truth is decided on the exact coordinate; the DISPLAY
  // is made to agree with it via fmtProb, never the other way round.
  assert(profileConcept(0.9999996, 1) === 'mixed',
    'a strictly-interior coordinate is mixed however it displays — rounding is for display, not for deciding what is true');
  console.log('\u2713 red-team #6: NE tolerance is scale-invariant (no floor), solution concept read from the realised profile');
}

function testRedTeamFindings5() {
  // Every mixed preset must be recognised as a genuine NE at its QUANTISED
  // coordinate. The Search Game carries 6.67e-4 of residual from r3 alone.
  for (const [key, preset] of Object.entries(PRESETS as Record<string, { payoffs?: GamePayoffs } & GamePayoffs>)) {
    const g = (preset.payoffs ?? preset) as GamePayoffs;
    if (g.a11 === undefined) continue;
    const mixed = computeAllNE(g).find((n) => n.type === 'mixed');
    if (!mixed) continue;
    const qx = r3(mixed.x), qy = r3(mixed.y);
    const rq = Math.max(Math.abs(regretA(qx, qy, g)), Math.abs(regretB(qx, qy, g)));
    assert(rq <= neTolerance(g),
      `preset "${key}" must be recognised as an NE at its quantised coordinate (regret ${rq}, tol ${neTolerance(g)})`);
  }
  // …and a genuine non-equilibrium must STILL be caught, tolerance or not.
  const bad: GamePayoffs = { a11: 9, a12: -1, a21: -9, a22: 9, b11: -4, b12: -7, b21: -2, b22: -2 };
  assert(Math.max(Math.abs(regretA(0, 1, bad)), Math.abs(regretB(0, 1, bad))) > neTolerance(bad),
    'a point with regret 18 must never pass the NE tolerance');
  // The tolerance must scale with the payoffs, not be a constant.
  const small: GamePayoffs = { a11: 1, a12: 0, a21: 0, a22: 1, b11: 0, b12: 1, b21: 1, b22: 0 };
  const large: GamePayoffs = { a11: 100, a12: 0, a21: 0, a22: 100, b11: 0, b12: 100, b21: 100, b22: 0 };
  assert(neTolerance(large) > neTolerance(small),
    'tolerance must grow with payoff spread — that is what quantisation error does');
  console.log('\u2713 red-team #5: NE tolerance scaled to r3 quantisation, presets recognised, real non-equilibria still caught');
}

function testRedTeamFindings4() {
  // 1. STATIONARY IS NOT EQUILIBRIUM. The run settles at (0,1) where A gains 18
  //    by switching, and the app announced a Nash equilibrium there.
  const sim: GamePayoffs = { a11: 9, a12: -1, a21: -9, a22: 9, b11: -4, b12: -7, b21: -2, b22: -2 };
  assert(Math.abs(regretA(0, 1, sim)) > 1, 'fixture: (0,1) has large regret for A');
  const set = equilibriumSet(sim);
  assert(!set.some((r) => r.x0 <= 0 && 0 <= r.x1 && r.y0 <= 1 && 1 <= r.y1),
    'fixture: (0,1) is NOT in the equilibrium set');
  // Run the simulation to its end and require the NE claim to match the oracle.
  {
    const st = simulate(sim, { firstMover: 'A', shrinkStep: 0.1, startX: 0.217, startY: 0.217 });
    const rq = Math.max(Math.abs(regretA(st.cx, st.cy, sim)), Math.abs(regretB(st.cx, st.cy, sim)));
    assert(st.convergedIsNE === (rq < 1e-6),
      `convergedIsNE (${st.convergedIsNE}) must match the regret oracle (max regret ${rq})`);
  }

  // 2. Confusable homoglyphs must be treated as duplicate labels. NFC does not
  //    fold Cyrillic A onto Latin A, so "Attack"/"Аttack" slipped the screen.
  const homo = tieProse({ a11: 1, a12: 0, a21: 0, a22: 1, b11: 2, b12: 1, b21: 3, b22: 4 } as GamePayoffs,
    { row1: 'Attack', row2: '\u0410ttack', col1: 'Left', col2: 'Right' });
  assert(homo.includes('Row 1') && homo.includes('Row 2'),
    `confusable labels must fall back to generic names: ${homo}`);
  // …but genuinely distinct labels must still be used.
  const distinct = tieProse({ a11: 1, a12: 0, a21: 0, a22: 1, b11: 2, b12: 1, b21: 3, b22: 4 } as GamePayoffs,
    { row1: 'Attack', row2: 'Defend', col1: 'Left', col2: 'Right' });
  assert(distinct.includes('Attack') && distinct.includes('Defend'),
    `distinct labels must be preserved: ${distinct}`);
  console.log('\u2713 red-team #4: regret-checked convergence, confusable-label folding');
}

function testRedTeamFindings3() {
  // 1. describeContinua carried its OWN formatter and never received the
  //    fmtProb fix, so it printed an interior coordinate as exactly 0 and
  //    claimed an interval starting at a NON-equilibrium.
  const cont: GamePayoffs = { a11: 0, a12: 1, a21: 0, a22: 0, b11: 100, b12: -100, b21: 0, b22: 0.1 };
  const lines = describeContinua(cont);
  assert(lines.length > 0, 'fixture must produce a continuum line');
  assert(!/from 0 to 1\b/.test(lines[0]),
    `an interior endpoint must not print as 0: ${lines[0]}`);
  const set = equilibriumSet(cont)[0];
  assert(regretB(0, 1, cont) > 1e-9, 'fixture: (0,1) really is NOT an equilibrium');
  assert(set.x0 > 0, 'fixture: the true set starts strictly above 0');

  // 2. The category narrative gated on computeIndifference, which only detects a
  //    FULLY flat player, so a PARTIAL tie printed "always converge to the
  //    unique attractor" on a game whose equilibrium set is a segment.
  const partial: GamePayoffs = { a11: -2, a12: -2, a21: -2, a22: -1, b11: -2, b12: -1, b21: -1, b22: -2 };
  assert(!computeIndifference(partial).any, 'fixture: the OLD gate sees no indifference');
  assert(equilibriumSet(partial).some((r) => kindOf(r) !== 'point'),
    'fixture: but there IS a continuum, which is the gate the UI now uses');
  assert(Math.abs(regretA(0.3, 1, partial)) < 1e-9 && Math.abs(regretB(0.3, 1, partial)) < 1e-9,
    '(0.3, 1) is a genuine equilibrium, so "unique attractor" would be false');

  // 3. The move-order screen keyed on the words before/after only. All of these
  //    assert a sequence; the first is verbatim from the wild.
  for (const d of [
    'Two neighboring hospitals independently choose, with the row hospital choosing first and the column hospital choosing second.',
    'A goes first and B goes second.',
    'B observes A and then selects.',
    'A commits initially, and B follows.',
    'The second mover replies to the first mover.',
  ]) assert(!scenarioIsClaimFree({ description: d } as never).ok, `move-order claim must be refused: ${d.slice(0, 70)}`);
  console.log('\u2713 red-team #3: continuum formatter, continuum-aware narrative gate, ordinal move-order phrasings');
}

function testRedTeamFindings() {
  // 1. Sub-resolution probability must never render as certainty. y* = 1/3001
  //    printed as "probability 0", asserting a pure profile that is NOT an
  //    equilibrium (at y=0 A gets 0 from Row 1 vs 0.001 from Row 2).
  const sub: GamePayoffs = { a11: 3, a12: 0, a21: 0, a22: 0.001, b11: 1, b12: 3, b21: 3, b22: 1 };
  const subText = tieProse(sub, null);
  assert(!/probability [01](?![\d.])/.test(subText),
    `a sub-resolution probability must not render as certainty: ${subText}`);
  assert(/less than 0\.001/.test(subText), `expected threshold wording, got: ${subText}`);

  // 2. The solver must not DELETE an equilibrium whose coordinate rounds to a
  //    boundary. Regret is exactly 0 here, so it is genuinely an equilibrium.
  const drop: GamePayoffs = { a11: -2, a12: 5, a21: -1, a22: 3, b11: 8.002, b12: 8, b21: 3, b22: 7 };
  const ne = computeAllNE(drop);
  assert(ne.length === 1 && ne[0].type === 'mixed',
    `an equilibrium at x* = 0.9995002 must be reported, got ${JSON.stringify(ne)}`);
  assert(Math.abs(regretA(ne[0].x, ne[0].y, drop)) < 1e-9 && Math.abs(regretB(ne[0].x, ne[0].y, drop)) < 1e-9,
    'the reported coordinates must have zero regret');

  // 3. PROSE AND SOLVER MUST NOT DISAGREE ON A DIGIT — one source of truth, one
  //    formatter. The prose used to compute payoffs at the EXACT point while the
  //    label computed them at the ROUNDED one (2.316 vs 2.315).
  //
  //    A sub-resolution payoff is a THIRD shape, neither a plain number nor a
  //    disagreement: fmtPayoffProse renders it as "less than 0.001" or
  //    "greater than -0.001" rather than "0.000" (`prose-false-pure`'s sibling
  //    rule for payoffs). The old numbers-only regex read that sentence as
  //    "prose must state expected payoffs" FAILING, which is the wrong
  //    conclusion — the two are agreeing that the payoff is sub-resolution, not
  //    disagreeing on a digit.
  const THRESHOLD = /^(less than 0\.001|greater than -0\.001)$/;
  let thresholdHits = 0;
  for (const g of [
    { a11: 6, a12: -4, a21: -1, a22: 8, b11: -9, b12: 6, b21: -1, b22: -8 } as GamePayoffs,
    drop,
    // A's payoffs are engineered so the shared row-indifference value at the
    // mixed equilibrium is 0.0002 — nonzero, but r3 rounds it to 0. The
    // solver reports eA = 0; the prose must say "less than 0.001", not "0".
    { a11: 0.0002, a12: 0.0002, a21: 2, a22: -2, b11: 4, b12: -1, b21: -3, b22: 5 } as GamePayoffs,
  ]) {
    const mixed = computeAllNE(g).find((n) => n.type === 'mixed');
    if (!mixed) continue;
    const prose = tieProse(g, null);
    const m = prose.match(/E\[A\] = (-?\d+(?:\.\d+)?|less than 0\.001|greater than -0\.001) and E\[B\] = (-?\d+(?:\.\d+)?|less than 0\.001|greater than -0\.001)/);
    assert(!!m, `prose must state expected payoffs, in numeric or threshold form: ${prose}`);
    for (const [captured, solverValue, label] of [[m![1], mixed.eA, 'A'], [m![2], mixed.eB, 'B']] as const) {
      if (THRESHOLD.test(captured)) {
        thresholdHits++;
        assert(solverValue === 0,
          `prose gave threshold wording "${captured}" for E[${label}] but the solver's rounded value is ${solverValue}, not 0`);
      } else {
        assert(Number(captured) === solverValue,
          `prose and solver disagree on E[${label}]: prose ${captured} vs solver ${solverValue}`);
      }
    }
  }
  assert(thresholdHits > 0,
    'no fixture produced the sub-resolution payoff wording — the THRESHOLD branch above was never exercised');

  // 4. Canonically-equivalent Unicode labels are DUPLICATES. "Réserve" as
  //    e+U+0301 vs U+00E9 renders identically, so byte comparison let both
  //    through and produced two best replies "against Réserve".
  const nfd = 'Re\u0301serve', nfc = '\u00c9'.toLowerCase() === '\u00e9' ? 'R\u00e9serve' : 'R\u00e9serve';
  const uni = tieProse({ a11: 1, a12: 0, a21: 0, a22: 1, b11: 2, b12: 1, b21: 3, b22: 4 } as GamePayoffs,
    { row1: nfd, row2: nfc, col1: 'Left', col2: 'Right' });
  assert(!uni.includes(nfd) && !uni.includes(nfc),
    `canonically-equivalent labels must fall back to generic names: ${uni}`);
  assert(uni.includes('Row 1') && uni.includes('Row 2'), `expected generic fallback: ${uni}`);
  console.log('\u2713 red-team findings: sub-resolution probability, dropped equilibrium, prose/solver agreement, Unicode duplicates');
}

function testSubResolutionWordingEverywhere() {
  // The tie-prose renderer was the first surface fixed (test above); the SAME
  // collapse existed in the solver handover the model copies and in every
  // simulation-log discovery message. y* = 1/3001 \u2248 0.000333 on this fixture,
  // which rounds to 0 at display precision while the profile at exactly 0 is
  // provably NOT an equilibrium (at y=0 A gets 0 from Row 1 vs 0.001 from Row 2).
  const g: GamePayoffs = { a11: 3, a12: 0, a21: 0, a22: 0.001, b11: 1, b12: 3, b21: 3, b22: 1 };
  const CERTAIN = /probability [01](?![\d.])/;   // "probability 0"/"probability 1", never "0.5"

  // 1. The grounding handover: the model copies this verbatim, and the old
  //    4-dp spell-out handed it "probability 0".
  const payload = buildGroundingPayload(g);
  assert(!CERTAIN.test(payload), `handover must not call a sub-resolution coordinate 0 or 1: ${payload.match(/probability [^\n]*/g)}`);
  assert(payload.includes('probability less than 0.001') && payload.includes('probability more than 0.999'),
    'handover must spell the threshold wording out per option');

  // 2. Every discovery message in the log, in BOTH convergence modes. The
  //    landing value is grid-quantised (0 here) even when fmtProb-ed, so the
  //    messages must speak from the exact solver root.
  for (const mode of ['shrink', 'regret'] as const) {
    const st = createInitialState(0.217, 0.217, g);
    const lines: string[] = [];
    let n = 0;
    while (!st.converged && n < 20000) {
      doStep(g, st, 'A', 0.1, computeAllNE(g), null, (m) => { if (/discovered/.test(m)) lines.push(m); },
        () => {}, () => { st.running = false; }, mode);
      n++;
    }
    assert(st.converged, `${mode}: fixture must converge`);
    assert(lines.length >= 2, `${mode}: fixture must log at least one discovery per axis`);
    for (const l of lines) {
      assert(!/discovered: [01](?![\d.])/.test(l),
        `${mode}: a sub-resolution coordinate must not be called 0 or 1 in the log: ${l}`);
    }
    assert(lines.some((l) => /discovered: less than 0\.001/.test(l)),
      `${mode}: the y* discovery must use the threshold wording: ${JSON.stringify(lines)}`);
  }
  console.log('\u2713 sub-resolution wording: handover and both modes\u2019 discovery logs say "less than 0.001", never "0"');
}

function testJointPayoffClaim() {
  const chk = (g: GamePayoffs, prose: string) => {
    const v = validateProseClaims(null, prose, g, computeAllNE(g), computeIndifference(g).any);
    return !v.ok && (v.issues ?? []).some((i) => i.includes('both players receive'));
  };
  const BOS: GamePayoffs = { a11: 2, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 2 };

  // MUST STILL FIRE — a check that stops firing has been deleted, not fixed.
  assert(chk(BOS, 'The equilibrium gives both A and B a payoff of 1.'),
    'L2 case 9: a genuine joint-payoff claim naming a cell that does not exist must still be caught');
  assert(chk(BOS, 'At that corner both players receive 4.'), 'a bare joint claim must still be caught');
  assert(chk(BOS, 'Here each player earns 4.'), '"each player earns" must still be caught');
  // The unicode minus used to make this read as +4 and check the wrong cell.
  assert(chk(BOS, 'At that corner both players receive \u22124.'),
    'a joint claim written with U+2212 must be read as NEGATIVE and caught');

  // MUST NOT FIRE.
  // (a) "both" binds the ACTION and the two payoffs are then given SEPARATELY.
  assert(!chk({ a11: -1, a12: -3, a21: 4, a22: 3, b11: -1, b12: 3, b21: -7, b22: 9 },
    'The sole equilibrium is therefore the corner where A and B both choose Automate, giving payoffs 3 and 9.'),
    'a stated PAIR of payoffs is not a joint claim');
  assert(!chk({ a11: -3, a12: -9, a21: -7, a22: 1, b11: -3, b12: 6, b21: 4, b22: 9 },
    'The sole equilibrium has both shops Cut Price: A earns 1 and B earns 9.'),
    'payoffs attributed to A and B separately are not a joint claim');
  // (b) L15's correct-withheld, verbatim, unicode minus included.
  assert(!chk({ a11: -1, a12: 3, a21: 2, a22: 0, b11: -5, b12: 1, b21: 0, b22: 2 },
    'Both nurses choose Day Shift, giving payoffs of \u22121 and \u22125.'),
    'L15 correct-withheld: a true asymmetric pair must not be read as a joint payoff');
  // (c) "both" ranges over ONE PLAYER'S TWO OPTIONS — a tie sentence, and true.
  assert(!chk({ a11: -1, a12: -7, a21: -1, a22: 0, b11: 5, b12: 2, b21: -6, b22: -8 },
    'The factory prefers the Backup Process if inspection is waived, but once the regulator inspects, both processes give the factory the same payoff of -1.'),
    'a TIE stated over one player\'s two options must not be read as a joint payoff');
  assert(!chk({ a11: -8, a12: 0, a21: -2, a22: 8, b11: -6, b12: -7, b21: 0, b22: 0 },
    'Once the Main Route is chosen, Broadcast and Stay Silent both give the controller a payoff of 0, so switching between them offers no gain.'),
    'a tie over one player\'s two columns must not be read as a joint payoff');
  // (d) the figure belongs to an OPTION NAME. Both verbatim from the nano
  //     213-row battery, where they were 2 of 33 failures (0.94% withheld).
  assert(!chk({ a11: 0, a12: -9, a21: 3, a22: 2, b11: -8, b12: -1, b21: 3, b22: -7 },
    'Player A\u2019s choice interacts with Player B\u2019s, but A\u2019s tradeoff is straightforward: for both of B\u2019s possible columns, A gets a higher payoff by choosing Row 2 over Row 1.'),
    'the 2 of "Row 2" is an option name, not a joint payoff');
  assert(!chk({ a11: -5, a12: -8, a21: 8, a22: -4, b11: -4, b12: 2, b21: -3, b22: 9 },
    'So A and B both get pinned to Row 2 and Col 2, making the only equilibrium the pure profile (x=0, y=0) with A\u2019s payoff \u22124 and B\u2019s payoff 9.'),
    'both figures being 2 defeats the pair guard, so the option-name guard must carry this one');

  // A joint claim that is simply TRUE must pass.
  assert(!chk(BOS, 'At that corner both players receive 0.'), 'a true joint claim must pass');
  console.log('\u2713 joint-payoff claim: 4 true positives still fire, 4 false-positive shapes closed (21 golds + L15 + 2 nano rows)');
}

function testTieProse() {
  // Deterministic tie prose. The guard is adversarial rather than cosmetic:
  // the generated sentences are pushed through the SAME validators the model's
  // prose must pass. A flag means either the renderer is wrong or the gate has
  // a false positive, and both must be fixed before a reader ever sees it.
  const rnd = (() => { let s = 424242; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; })();
  const LABELS: (TieLabels | null)[] = [
    { row1: 'Premium launch', row2: 'Budget launch', col1: 'Broad campaign', col2: 'Targeted campaign' },
    { row1: 'Full schedule', row2: 'Light schedule', col1: 'Full schedule', col2: 'Light schedule' },  // shared words
    null,                                                                                              // generic Row/Col
  ];
  let tieGames = 0;
  for (let t = 0; t < 1500; t++) {
    const cell = () => Math.floor(rnd() * 9) - 4;
    const g: GamePayoffs = { a11: cell(), a12: cell(), a21: cell(), a22: cell(), b11: cell(), b12: cell(), b21: cell(), b22: cell() };
    if (!(g.a11 === g.a21 || g.a12 === g.a22 || g.b11 === g.b12 || g.b21 === g.b22)) continue;
    tieGames++;
    const labels = LABELS[t % LABELS.length];
    const text = tieProse(g, labels);
    assert(text.length > 0, `tieProse produced nothing for ${JSON.stringify(g)}`);
    const issues = validateProseDirections(text, labels, g);
    assert(issues.length === 0, `generated tie prose was flagged by the gate on ${JSON.stringify(g)}: ${issues[0]} — TEXT: ${text}`);
  }
  // A tie does NOT always create a continuum: the "beyond isolated points"
  // clause must be derived, not assumed (L7 draw 54 shipped it on a game whose
  // equilibrium set is the single point (0,0)).
  const pointOnly: GamePayoffs = { a11: 7, a12: -2, a21: 7, a22: 9, b11: 0, b12: 8, b21: -1, b22: 5 };
  assert(equilibriumSet(pointOnly).every((r) => kindOf(r) === 'point'), 'fixture must have a point-only equilibrium set');
  assert(!tieProse(pointOnly, null).includes('beyond isolated points'),
    'the continuum clause must not appear on a tie game whose equilibrium set is a single point');
  const withContinuum: GamePayoffs = { a11: 5, a12: 3, a21: 5, a22: 1, b11: 2, b12: 4, b21: 6, b22: 1 };
  assert(tieProse(withContinuum, null).includes('beyond isolated points'),
    'the continuum clause must still appear when the equilibrium set really has one');

  // A full-space component cannot have siblings, which is WHY tieProse renders
  // it with a standalone sentence and why describe()'s 'area' branch never runs
  // (mutation testing flagged it as an equivalent mutant). If equilibriumSet
  // ever changes so that an area DOES appear alongside another component, this
  // fires — because the branch would start emitting text nothing has verified.
  {
    let areaGames = 0, withSiblings = 0;
    for (const vals of [[0, 1], [0, 1, 2]]) {
      const k = vals.length;
      for (let n = 0; n < k ** 8; n++) {
        let m = n; const c: number[] = [];
        for (let i = 0; i < 8; i++) { c.push(vals[m % k]); m = Math.floor(m / k); }
        const st = equilibriumSet({ a11: c[0], a12: c[1], a21: c[2], a22: c[3], b11: c[4], b12: c[5], b21: c[6], b22: c[7] });
        if (st.some((r) => kindOf(r) === 'area')) { areaGames++; if (st.length > 1) withSiblings++; }
      }
    }
    assert(areaGames > 0, 'the exhaustive sweep must actually contain full-space equilibrium sets');
    assert(withSiblings === 0, `a full-space component appeared alongside ${withSiblings} sibling(s) — describe()'s 'area' branch is now reachable and needs verification`);
  }

  // The sentence the models get wrong most often must name the right column.
  const weakDom: GamePayoffs = { a11: 5, a12: 3, a21: 5, a22: 1, b11: 2, b12: 4, b21: 6, b22: 1 };
  const wd = tieProse(weakDom, { row1: 'Premium launch', row2: 'Budget launch', col1: 'Broad campaign', col2: 'Targeted campaign' });
  assert(/against Broad campaign, A earns 5 from either row/.test(wd), `tie stated on the wrong column: ${wd}`);
  assert(!/against Targeted campaign, A earns/.test(wd), `tie claimed where A strictly prefers: ${wd}`);
  assert(/any probability from 0 to 0\.714/.test(wd), `continuum missing from the tie explanation: ${wd}`);
  console.log(`✓ tie prose: ${tieGames.toLocaleString()} tie games rendered, every sentence passed the prose gate`);
}

function testProseActionClaims() {
  // The live matrix: unique pure NE at (x=0, y=0) — A's Row 2, B's Col 2.
  const SPECIMEN: GamePayoffs =
    { a11: 4, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 };
  const BOS: GamePayoffs =
    { a11: 2, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 2 };
  const MP: GamePayoffs =
    { a11: 1, a12: -1, a21: -1, a22: 1, b11: -1, b12: 1, b21: 1, b22: -1 };

  const check = (claims: Parameters<typeof validateProseClaims>[0], g: GamePayoffs, degenerate = false, prose = '') =>
    validateProseClaims(claims, prose, g, computeAllNE(g), degenerate);

  // The exact live error: naming Col 1 as B's equilibrium action.
  assert(!check({ equilibriumActions: [{ player: 'B', option: 1 }], bestReplies: [] }, SPECIMEN).ok,
    "the Silent specimen — B's option 1 at equilibrium — must fail");
  assert(check({ equilibriumActions: [{ player: 'A', option: 2 }, { player: 'B', option: 2 }], bestReplies: [] }, SPECIMEN).ok,
    'the true equilibrium actions must pass');

  // Its companion inversion: claiming Col 1 beats Col 2 for B (3 vs 5).
  assert(!check({ equilibriumActions: [], bestReplies: [
    { player: 'B', opponentOption: 1, bestOption: 1 },
  ] }, SPECIMEN).ok, "the specimen's backwards best-reply must fail");
  assert(check({ equilibriumActions: [], bestReplies: [
    { player: 'B', opponentOption: 1, bestOption: 2 },
    { player: 'B', opponentOption: 2, bestOption: 2 },
  ] }, SPECIMEN).ok, "B's true dominance (both columns) must pass");

  // Multiple pure equilibria: naming either coordination corner is true.
  assert(check({ equilibriumActions: [
    { player: 'A', option: 1 }, { player: 'A', option: 2 },
  ], bestReplies: [] }, BOS).ok, 'both BoS corners are real equilibrium actions');

  // Mixed-only game: both options carry positive probability, so a claim
  // about either is true — the calibration pilot demoted 100% of mixed games
  // under the stricter pure-NE-only rule (the model declares entries for
  // "plays X with probability 0.8" statements), which is why the semantics
  // are positive-probability, not pure-only.
  assert(check({ equilibriumActions: [
    { player: 'A', option: 1 }, { player: 'B', option: 2 },
  ], bestReplies: [] }, MP).ok, 'mixed-lean action claims on a mixed game must pass');

  // Degenerate games skip the action check (the continuum makes it ill-posed).
  assert(check({ equilibriumActions: [{ player: 'A', option: 1 }], bestReplies: [] }, MP, true).ok,
    'degenerate games must skip equilibrium-action checks');

  // Malformed indices fail rather than silently skipping.
  assert(!check({ equilibriumActions: [{ player: 'A', option: 3 }], bestReplies: [] }, SPECIMEN).ok,
    'a malformed option index must fail');

  // Claim-free declarations pass.
  assert(check({ equilibriumActions: [], bestReplies: [] }, SPECIMEN).ok,
    'empty declarations must pass');

  // ── Round-6 closure: the undeclared-comparison screen ────────────────────
  // A plain-BoS draw was SHOWN saying "B wants Tone 2 against A's Talk"
  // (inverted) because proseClaims was null and passed vacuously. Prose that
  // pairs a preference verb with an opponent frame while declaring no
  // bestReplies is unverifiable and therefore withheld.
  const FP_BOS_SENTENCE =
    'B similarly faces a choice where it wants Tone 2 against A\'s Talk and prefers Tone 1 against A\'s Listen.';
  assert(!check(null, BOS, false, FP_BOS_SENTENCE).ok,
    'a better-against sentence with NULL declarations must be withheld');
  assert(!check({ equilibriumActions: [], bestReplies: [] }, BOS, false, FP_BOS_SENTENCE).ok,
    'the same sentence with empty bestReplies must be withheld');
  assert(check({ equilibriumActions: [], bestReplies: [
    { player: 'B', opponentOption: 1, bestOption: 1 },
  ] }, BOS, false, FP_BOS_SENTENCE).ok,
    'declared (and true) bestReplies exempt the sentence — the declared path checks it');
  assert(check(null, BOS, false,
    'When B plays y=0.333, A is indifferent between Row 1 and Row 2, so mixing is stable.').ok,
    'indifference prose without preference verbs must not trip the screen');
  assert(check(null, BOS, false,
    'Both players would rather coordinate than miss each other, and the equilibria reward matching.').ok,
    'coordination flavor without an opponent frame must not trip the screen');
}


function testRedTeamFindings14() {
  // ── A. A pasted unicode minus must survive blur ───────────────────────────
  // Verbatim fixture, reproduced in Chrome against the served build:
  // A=[[−4,4],[2,0]] B=[[1,0],[0,2]] with a11 pasted as U+2212 "−4".
  //   after paste: Mixed NE (x*=0.667, y*=0.400) E[A]=0.800
  //   after blur:  Mixed NE (x*=0.667, y*=0.667) E[A]=1.333   <- a different game
  // onChange and blur are two conversions of the SAME string and must agree.
  const typed = '−4';
  assert(typed.charCodeAt(0) === 0x2212,
    'fixture integrity: the pasted cell really holds U+2212, not an ASCII hyphen');
  assert(isNaN(parseFloat(typed)),
    'fixture integrity: bare parseFloat really does fail on it — this is what made the defect');
  assert(commitPayoffInput(typed) === -4,
    `a pasted "${typed}" must commit as -4, got ${commitPayoffInput(typed)}`);
  assert(commitPayoffInput(String(commitPayoffInput(typed))) === -4,
    'blur re-parses its own canonical output — the round trip must be a fixed point');

  const pasted: GamePayoffs = { a11: commitPayoffInput(typed), a12: 4, a21: 2, a22: 0,
                                b11: 1, b12: 0, b21: 0, b22: 2 };
  const zeroed: GamePayoffs = { ...pasted, a11: 0 };
  const mP = computeMixedNE(pasted)!, mZ = computeMixedNE(zeroed)!;
  assertApprox(mP.y, 0.4, 'the pasted game (a11 = -4) has y* = 0.400', 1e-9);
  assertApprox(mZ.y, 2 / 3, 'the silently-zeroed game has y* = 0.667', 1e-9);
  assert(Math.abs(mP.y - mZ.y) > 0.2,
    'fixture integrity: the two games are far apart, so losing the minus is not a rounding difference');
  assertApprox(EA(mP.x, mP.y, pasted), 0.8, 'and E[A] = 0.800, not 1.333', 1e-9);

  for (const ch of ['−', '–', '—', '―', '‒', '‐',
                    '‑', '⁃', '˗', '－', '﹣', '﹘']) {
    assert(commitPayoffInput(ch + '4') === -4,
      `U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')} must read as a minus, got ${commitPayoffInput(ch + '4')}`);
  }

  // ── B. A legitimate 0 is a value, not a missing field ─────────────────────
  // `parseFloat(x0) || 0.217` treated 0 as absent: x0 = 0 (advertised by the
  // input's own min="0.0", and where the down button lands from 0.010) ran from
  // 0.217, and the log opened "Start (0.217, 0.500)" above a box reading 0.
  assert(commitStartCoordinate('0') === 0,
    `x0 = "0" must start the run at 0, got ${commitStartCoordinate('0')}`);
  assert(commitStartCoordinate('0.000') === 0,
    'the down-stepper writes "0.000" — that is still zero');
  assert(commitStartCoordinate('') === 0.217 && commitStartCoordinate('abc') === 0.217,
    'only a genuinely unparseable field may fall back');
  assert(parseNumericInput('0') === 0 && parseNumericInput('') === null,
    'null is the ONLY "not a number" signal — that is what keeps 0 distinguishable from absent');
  assert(commitStepIndex('0') === 0, 'step 0 is a real step index, not a missing one');

  // ── C. Fullwidth digits (RED-APP-3 finding 002) ────────────────────────────
  // The minus/plus normalisation above never covered the DIGITS themselves.
  // A fullwidth "３１" (U+FF13 U+FF11 -- what an IME's fullwidth mode or a
  // pasted CJK document produces) made `parseFloat` return NaN immediately
  // (it only recognises ASCII 0-9), so the null-fallback silently committed
  // 0 -- indistinguishable on screen from the user having typed zero on
  // purpose. Same failure shape as section A above, just for digits instead
  // of the sign.
  assert(commitPayoffInput('３１') === 31,
    `a fullwidth "３１" must commit as 31, got ${commitPayoffInput('３１')}`);
  assert(parseFloat('３１') !== 31,
    'fixture integrity: bare parseFloat really does fail on fullwidth digits -- this is what made the defect');
  for (let d = 0; d <= 9; d++) {
    const fw = String.fromCharCode(0xff10 + d); // the fullwidth form of this single digit
    assert(commitPayoffInput(fw) === d,
      `fullwidth digit U+${(0xff10 + d).toString(16).toUpperCase()} must read as ${d}, got ${commitPayoffInput(fw)}`);
  }
  // Combines with the existing fullwidth minus (already normalised above) --
  // the two normalisations must compose, not just work in isolation.
  assert(isNaN(parseFloat('－４')),
    'fixture integrity: bare parseFloat really does fail on fullwidth minus+digit too');
  assert(commitPayoffInput('－４') === -4,
    `fullwidth minus + fullwidth digit "－４" must commit as -4, got ${commitPayoffInput('－４')}`);
  // CodeRabbit finding (this branch): the minus+digit composition case above
  // does not prove the PLUS case composes too -- NUMERIC_INPUT_PLUS is a
  // separate character class from NUMERIC_INPUT_MINUS, and a regression that
  // broke ONLY the plus normalisation (e.g. an edit that narrowed
  // NUMERIC_INPUT_PLUS's character class) would leave every assertion above
  // passing while `commitPayoffInput('＋４')` silently fell back to 0.
  const fwPlusDigit = '＋４';
  assert(fwPlusDigit.charCodeAt(0) === 0xff0b && fwPlusDigit.charCodeAt(1) === 0xff14,
    'fixture integrity: the fullwidth plus+digit fixture must be U+FF0B U+FF14, not ASCII lookalikes');
  assert(isNaN(parseFloat(fwPlusDigit)),
    'fixture integrity: bare parseFloat really does fail on fullwidth plus+digit too');
  assert(commitPayoffInput(fwPlusDigit) === 4,
    `fullwidth plus + fullwidth digit "${fwPlusDigit}" must commit as 4, got ${commitPayoffInput(fwPlusDigit)}`);
  // The fullwidth full stop must ALSO normalise, and be tested together with
  // the digits, not in isolation: fixing only the digits and leaving the
  // fullwidth "." alone would make a fullwidth-typed "0.5" digit-normalise
  // to ASCII "0" followed by an UNRECOGNISED fullwidth dot -- parseFloat
  // then stops right after that leading "0" and returns the NUMBER 0 (a
  // real, parseable value), which is WORSE than the pre-fix behaviour: null
  // at least falls back to the field's own documented default (0.217 here),
  // where a silently-parsed 0 does not. Caught by writing this assertion
  // against the wrong expected value first and reading why it failed.
  // Fixture integrity, same discipline as fixture A's charCodeAt check above:
  // this string must actually BE the fullwidth code points, not something
  // that happens to read the same in a monospace font while secretly being
  // plain ASCII "0.5" -- which would pass this assertion for the wrong
  // reason (ASCII "0.5" also commits to 0.5, fixed or not).
  const fwDecimal = '０．５';
  assert(fwDecimal.charCodeAt(0) === 0xff10 && fwDecimal.charCodeAt(1) === 0xff0e && fwDecimal.charCodeAt(2) === 0xff15,
    'fixture integrity: the fullwidth-decimal fixture must be U+FF10 U+FF0E U+FF15, not ASCII lookalikes');
  assert(commitStartCoordinate(fwDecimal) === 0.5,
    `a fullwidth "${fwDecimal}" must commit as 0.5, got ${commitStartCoordinate(fwDecimal)}`);
  // Every OTHER numeric field shares this same parser core -- x0/y0 and the
  // step index are equally exposed, and equally fixed by one change at the
  // source rather than needing a fix at every call site.
  assert(commitStepIndex('３') === 3, 'the step-index field shares the same core parser, so it is fixed too');

  console.log('✓ red-team #14: one parser per typed field; a pasted minus survives blur and a zero is a value; fullwidth digits normalise the same way as fullwidth minus/plus');
}

function testRedTeamBreak1StaleReplay() {
  // Red 14 break 1, verbatim gesture chain on the Search Game:
  //   Run to 49/49 -> "Go to step" 0 -> edit b22 from -1 to -4 -> "Go to step" 49
  // updatePayoffField's guard was `simState.converged || simState.stepCount > 0`,
  // which reads FALSE at step 0 even though runCtx / thinHistory / initStateRef
  // are all still bound to the finished run. So the edit did not invalidate the
  // frozen replay set, and the app then certified the OLD game's result on top
  // of the NEW game. The predicate is now `runCtx !== null` — the direct answer
  // to "is there a live run?" rather than a proxy for it.
  const edited: GamePayoffs = { a11: 2, a12: 0, a21: 0, a22: 1, b11: -2, b12: 0, b21: 0, b22: -4 };

  // The app displayed and CERTIFIED (1/3, 1/3) with E[B] = -0.667. All three
  // claims are false for the game that was actually in the matrix.
  assert(computeAllNE(edited).filter((n) => n.type === 'pure').length === 0,
    'fixture: the edited game has no pure equilibrium');
  const m = computeMixedNE(edited)!;
  assertApprox(m.x, 2 / 3, 'the edited game mixes at x* = 2/3, not 1/3', 1e-9);
  assertApprox(m.y, 1 / 3, 'and y* = 1/3', 1e-9);
  assertApprox(EB(1 / 3, 1 / 3, edited), -2, 'E[B] at the certified point is -2 exactly, not -0.667', 1e-9);
  const rq = Math.abs(regretB(1 / 3, 1 / 3, edited));
  assertApprox(rq, 4 / 3, 'B gains 4/3 by switching at the certified point', 1e-9);
  assert(rq > neTolerancePlayer(edited, 'B') * 100,
    `and that is ${(rq / neTolerancePlayer(edited, 'B')).toFixed(0)}x the per-player tolerance — never an equilibrium`);

  // -0.667 is the PRE-EDIT game's value at that point: the frozen run leaking through.
  const preEdit: GamePayoffs = { ...edited, b22: -1 };
  assertApprox(EB(1 / 3, 1 / 3, preEdit), -2 / 3,
    'fixture: -0.667 is exactly E[B] of the game BEFORE the edit — the leak, identified', 1e-9);
  // The arithmetic above documents WHY the defect matters, but it does not
  // exercise the predicate — the first version of this test passed with the
  // buggy `stepCount > 0` guard restored, which made it worthless as a guard
  // (the round-8 trap: a green test beside a live defect). The predicate lives
  // in React state logic a node test cannot run, so pin it at the source.
  const src = readFileSync('src/App.tsx', 'utf8');
  assert(/if \(runCtx\) handleReset\(nextPayoffs\);/.test(src),
    "updatePayoffField must invalidate the run on `runCtx`, the direct answer to \"is there a live run?\". "
    + 'A proxy for it (simState.stepCount > 0) reads false at step 0, which Back and "Go to step 0" '
    + 'both produce with the whole frozen replay set still live.');
  assert(!/simState\.stepCount > 0\)\s*handleReset/.test(src),
    'no reset may gate on stepCount as a liveness proxy — that is the defect this test exists for');
  console.log('✓ red-team break 1: the stale-replay fixture is false three ways, and the predicate is pinned');
}

function testRedTeamBreak2MoverNarration() {
  // Red 14 break 2, on Battle of the Sexes: Run to convergence, then click
  // "Player B". The report flipped to B's committed corner while the log, the
  // markers and the "✓ Converged" pill still described the A-first run.
  // Fixed by making the mover toggle reset, through ONE writer (changeFirstMover)
  // that the tour's act entries also use — an onClick-only fix would have left
  // the tour's two setFirstMover re-assertions as surviving writers.
  const bos: GamePayoffs = { a11: 2, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 2 };
  const pures = computeAllNE(bos).filter((n) => n.type === 'pure');
  assert(pures.length === 2, 'fixture: BoS has two pure equilibria');
  const bestFor = (who: 'A' | 'B') =>
    pures.reduce((b, n) => ((who === 'A' ? n.eA : n.eB) > (who === 'A' ? b.eA : b.eB) ? n : b));
  const cA = bestFor('A'), cB = bestFor('B');
  // Asserted BEFORE the two specific corners: afterwards TypeScript has narrowed
  // cA.x to 1 and cB.x to 0, and flags the comparison as tautological (TS2367).
  // The claim is the load-bearing one, so it keeps its own line rather than
  // being deleted as redundant.
  assert(cA.x !== cB.x,
    'the two movers commit to DIFFERENT corners — which is why a mover change makes a finished run false');
  assert(cA.x === 1 && cA.y === 1, 'A commits to (Row1, Col1)');
  assert(cB.x === 0 && cB.y === 0, 'B commits to (Row2, Col2)');
  assertApprox(EA(1, 1, bos), 2, 'the A-first run realises E[A] = 2.000 at its own corner', 1e-9);
  assertApprox(EB(0, 0, bos), 2, 'while the B-committed report names a corner paying B 2.000', 1e-9);
  console.log('✓ red-team break 2: mover change makes a finished run false, so it must reset');
}

// ── Class guards. The instance tests above pass again the day someone adds an
// eighth ad-hoc parser or a fifth mover writer. These fail when that happens,
// which is the actual recurrence mode: four consecutive rounds found the same
// root cause because each fix covered the reported site and not its siblings.
function testNoAdHocNumericParsers() {
  const src = readFileSync('src/App.tsx', 'utf8');
  const offenders: string[] = [];
  src.split('\n').forEach((line, i) => {
    if (!/parseFloat\(|parseInt\(|\bNumber\(|valueAsNumber/.test(line)) return;
    if (/^\s*(\/\/|\*)/.test(line)) return;
    if (/getComputedStyle/.test(line)) return;   // CSS px, not user input
    offenders.push(`App.tsx:${i + 1}: ${line.trim()}`);
  });
  assert(offenders.length === 0,
    'ad-hoc numeric parsing in App.tsx. Every typed field must convert through '
    + 'commitPayoffInput / commitStartCoordinate / commitStepSize / commitStepIndex, so no call '
    + 'site can invent its own idea of "not a number". If you added a field, route it through one '
    + `of those and this test passes again:\n  ${offenders.join('\n  ')}`);
  console.log('✓ class guard: no ad-hoc numeric parsers in App.tsx');
}

function testFirstMoverHasOneWriter() {
  const src = readFileSync('src/App.tsx', 'utf8');
  const sites = src.split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter((r) => /setFirstMover\(/.test(r.line) && !/^\s*(\/\/|\*)/.test(r.line));
  // Exactly one CALL: the body of changeFirstMover. (The useState declaration
  // destructures the setter, so it does not match `setFirstMover(`.)
  assert(sites.length === 1,
    'setFirstMover must be CALLED in exactly one place — the body of '
    + 'changeFirstMover. Turn order is part of a run\'s rules, so every writer must go through '
    + 'changeFirstMover or a finished run keeps being narrated under rules it never used. '
    + `If you added a legitimate writer, route it through changeFirstMover:\n  ${sites.map((r) => `App.tsx:${r.n}: ${r.line}`).join('\n  ')}`);
  assert(/const changeFirstMover = \(next: 'A' \| 'B'\) => \{[\s\S]{0,400}?if \(runCtx\) handleReset\(\);/.test(src),
    'changeFirstMover must still reset the run when the mover actually changes');
  console.log('✓ class guard: firstMover has exactly one writer');
}

// The simulation log colours each equilibrium line with the colour the GRAPH
// draws for that equilibrium — pure diamond green, mixed diamond purple — and
// the Start line with the starting-point sphere's grey, so a reader can match
// log to plot by colour alone (Daniel, 2026-09-01). Three files must agree:
// plotting.ts (the Plotly literal), index.css (the token), App.tsx (the class).
// Two of them agreeing while the third drifts is the whole failure mode, so
// this checks all three against each other rather than any one in isolation.
function testLogLineColoursMatchPlotMarkers() {
  const app = readFileSync('src/App.tsx', 'utf8');
  const css = readFileSync('src/index.css', 'utf8');
  const plot = readFileSync('src/utils/plotting.ts', 'utf8');
  const tok = (name: string) => (css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`)) ?? [])[1]?.toLowerCase();
  const plotColours = (pattern: RegExp) => [...new Set([...plot.matchAll(pattern)].map((m) => m[1].toLowerCase()))];
  // 1. tokens equal the Plotly literals
  const pureDiamond = plotColours(/color: '(#[0-9a-fA-F]{6})', symbol: 'diamond'/g);
  assert(pureDiamond.includes(tok('ne-pure')!), `ne-pure token ${tok('ne-pure')} is not a diamond colour in plotting.ts (${pureDiamond.join(', ')})`);
  assert(pureDiamond.includes(tok('ne-mixed-marker')!), `ne-mixed-marker token ${tok('ne-mixed-marker')} is not a diamond colour in plotting.ts (${pureDiamond.join(', ')})`);
  const startSphere = plotColours(/name: 'Starting Point'[\s\S]{0,2000}?color: '(#[0-9a-fA-F]{6})'/g);
  assert(startSphere.length === 1 && startSphere[0] === tok('sim-start'),
    `sim-start token ${tok('sim-start')} must equal the Starting Point marker colour (${startSphere.join(', ')})`);
  // 2. the renderer routes each line kind to the right token and never to a hardcoded palette
  // From the kind decision (logKind / neLineClass) through the renderer that consumes it.
  const rendererFrom = app.indexOf('const logKind:');
  const rendererTo = app.indexOf('const simulationLogPanel');
  assert(rendererFrom >= 0 && rendererTo > rendererFrom,
    `log renderer bounds not found in App.tsx (logKind at ${rendererFrom}, simulationLogPanel at ${rendererTo}) — a -1 here silently widens the window to the rest of the file`);
  const renderer = app.slice(rendererFrom, rendererTo);
  assert(renderer.length > 200, 'log renderer not found in App.tsx');
  const branch = (needle: string) => {
    const i = renderer.indexOf(needle);
    assert(i >= 0, `no renderer branch for ${needle}`);
    const end = renderer.indexOf('} else', i + 1);
    return renderer.slice(i, end >= 0 ? end : undefined);
  };
  assert(/neLineClass/.test(branch("line.includes('✓')")) && !/text-emerald/.test(branch("line.includes('✓')")),
    "the ✓ (coordinate discovered) line must take the equilibrium marker colour, not a hardcoded emerald");
  assert(/neLineClass/.test(branch("━━ Pure NE")) && !/text-accent/.test(branch("━━ Pure NE")),
    "the ━━ Pure/Mixed NE line must take the equilibrium marker colour, not the accent");
  assert(/text-sim-start/.test(branch("line.startsWith('Start (')")),
    "the Start line must take the starting-point marker grey");
  assert(/text-ne-pure/.test(renderer) && /text-ne-mixed-marker/.test(renderer) && /'━━ Pure NE'/.test(renderer) && /'━━ Mixed NE'/.test(renderer),
    'the pure/mixed decision must read the run\'s own final ━━ line and map to the two marker tokens');
  console.log('✓ class guard: simulation-log colours are the plot marker colours (plotting.ts = index.css token = App.tsx class)');
}

function testPayoffsWritersAllInvalidate() {
  const src = readFileSync('src/App.tsx', 'utf8');
  const sites = src.split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter((r) => /setPayoffs\(/.test(r.line) && !/^\s*(\/\/|\*)/.test(r.line));
  // Six, enumerated and each shown to reset or to be value-preserving:
  //   handleGenerateGame  -> handleReset()      — resets
  //   handleLoadPreset    -> handleReset()      — resets
  //   updatePayoffField   -> if (runCtx) reset  — resets
  //   inactivity timer    -> sets 0 to 0        — cannot change a value
  //   restorePreEditPayoff -> if (runCtx) reset — resets (RED-DESKTOP-9/002: puts a
  //                          cell back to its focus-time value when a comma appears)
  //   (handlePayoffBlur now delegates to updatePayoffField, so it is NOT a site;
  //    the useState declaration destructures the setter and does not match.)
  assert(sites.length === 5,
    'setPayoffs must be CALLED in exactly five places. This enumeration is load-bearing: it is what '
    + 'makes runStale unable to be true while a run still exists, which is what closes the '
    + '"narrating a dead run" class. A new writer must either call handleReset (like every loader) '
    + 'or be provably value-preserving; then update this count.\n  '
    + sites.map((r) => `App.tsx:${r.n}: ${r.line}`).join('\n  '));
  console.log('✓ class guard: every setPayoffs writer resets or cannot change a value');
}

function testValidatorUnicodeMinus() {
  const G: GamePayoffs = { a11: -9, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 };
  const rep = (prose: string): LlmReport => ({
    claimedEquilibria: computeAllNE(G).map((n) => ({ type: n.type, x: n.x, y: n.y })), prose });
  const kinds = (prose: string) => validateReport(rep(prose), G).mismatches
    .filter((m) => m.kind.startsWith('prose-')).map((m) => m.kind);

  // -9.9 is not a payoff anywhere in G. The claim is false in EVERY spelling of
  // its minus, so it must flag in every spelling. It used to flag only in ASCII,
  // so a model writing a typographically correct minus escaped the check
  // entirely: measured 400/400 missed, across five spellings, on three checks.
  assert(kinds('At the equilibrium E[A]=-9.9.').includes('prose-bad-payoff'),
    'baseline: the ASCII spelling of the false claim flags');
  for (const ch of ['−', '–', '—', '－', '‐']) {
    assert(kinds(`At the equilibrium E[A]=${ch}9.9.`).includes('prose-bad-payoff'),
      `the U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')} spelling of the SAME false claim must flag too — it used to pass silently`);
  }
  // And the narrow prose rule must not invent negatives out of punctuation.
  assert(kinds('Payoffs in this game range 3–5 for A.').length === 0,
    'an en dash BETWEEN DIGITS is a range, not a minus — normalising it would invent a false positive');
  assert(kinds('A gets 5 — and B gets 3.').length === 0,
    'an em dash followed by a space is punctuation, not a sign');
  assert(normalizeProseMinus('range 3–5') === 'range 3–5'
    && normalizeProseMinus('gets –4') === 'gets -4',
    'the rule is positional: a dash is a sign only after start/space/opener and immediately before a digit');
  console.log('✓ validators: a false claim flags in every spelling of its minus sign');
}

function testTwoNegativesInOneSentence() {
  // LATENT-HAZARD GUARD, not a shipped defect. Before the entry-point
  // normaliser, three sites used `.replace(/[−–]/, '-')` with no `g`. That was
  // INERT: each ran inside a single-number capture, which holds at most one
  // dash, and the one site fed a multi-number string always had the flag.
  // Verified end to end BEFORE the change: the false claim flagged as
  // "compares -7 with -4", i.e. both negatives converted. The hazard was that
  // widening any of those captures would have started half-converting silently.
  const g: GamePayoffs = { a11: -4, a12: 2, a21: -7, a22: 3, b11: 1, b12: 0, b21: 0, b22: 2 };
  const L = { row1: 'Commit', row2: 'Delay', col1: 'Go', col2: 'Hold' };
  for (const minus of ['-', '−', '–', '—', '－', '‐']) {
    const t = `For A, Commit is better than Delay when B chooses Go (A gets ${minus}4 rather than ${minus}7).`;
    const f = `For A, Commit is better than Delay when B chooses Go (A gets ${minus}7 rather than ${minus}4).`;
    const tag = `U+${minus.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
    assert(validateProseDirections(t, L, g).length === 0,
      `a TRUE claim citing two negatives must pass in every spelling — ${tag} flagged it`);
    const issues = validateProseDirections(f, L, g);
    assert(issues.length > 0, `the FALSE claim must flag in every spelling — ${tag} missed it`);
    assert(issues.some((i) => i.includes('-7') && i.includes('-4')),
      `BOTH negatives must reach the comparison, not just the first — got: ${issues.join(' | ')}`);
  }
  console.log('✓ two negatives in one sentence: every occurrence normalises, in every spelling');
}


function testRedTeamRound15BreakA() {
  // Red 15 break A: the tab DIED. doStep pushed createSnapshot(s) onto
  // s.historyStack on every call, and createSnapshot deep-copied all four path
  // segment arrays. Shrink mode opens a segment per step, so step k cloned ~k
  // segments: O(N^2) allocation, synchronous inside a click handler. Measured on
  // THIS fixture before the fix: 69MB at 500 steps, 559MB at 1500, 2757MB at
  // 3000, and an OOM at 5000 even with an 8GB heap. One Step click was enough.
  //
  // The delta check at the far end of doStep read only prev.cx / prev.cy — two
  // numbers — and only ever the element it had just pushed. Nothing else in the
  // codebase read the stack at all.
  //
  // THIS TEST RUNS AT THE SCALE THAT KILLED IT. A unit test that never allocates
  // 5000 snapshots proves nothing about the case that crashed the renderer.
  const g: GamePayoffs = { a11: 7, b11: -7, a12: -6, b12: -4, a21: -7, b21: 1, a22: 0, b22: -6 };
  const m = computeMixedNE(g)!;
  assert(r3(m.x) === 0.7 && r3(m.y) === 0.3,
    `fixture: the reported equilibrium is x*=0.7, y*=0.3 (got ${r3(m.x)}, ${r3(m.y)})`);
  assert(r3(EA(m.x, m.y, g)) === -2.1 && r3(EB(m.x, m.y, g)) === -4.6,
    'fixture: and E[A]=-2.100, E[B]=-4.600, exactly as the report reads');

  const all = computeAllNE(g);
  const st = createInitialState(0.217, 0.217, g);
  const step = () => doStep(g, st, 'A', 0.001, all, null, () => {}, () => {}, () => { st.running = false; }, 'shrink');
  // hrtime, not Date.now: 500 steps run in ~1.5ms, and Date.now's 1ms
  // granularity alone swung the ratio by 2x, which would make the bound either
  // flaky or useless.
  let timedSamples = 0;
  // Getters, not direct reads: both counters are mutated inside closures, which
  // TypeScript's control-flow narrowing cannot see — after `assert(x === 3)` a
  // direct `x === 4` is flagged TS2367 as an impossible comparison.
  const sampled = () => timedSamples;
  const steps = () => st.stepCount;
  const timeBlock = (count: number) => {
    timedSamples++;
    const t = process.hrtime.bigint();
    for (let i = 0; i < count && !st.converged; i++) step();
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  // COMPLEXITY, not wall clock. A constant time bound is machine-dependent and,
  // calibrated loosely enough to be safe in CI, it failed to catch a partial
  // reintroduction of per-step cloning during mutation testing. The defect was
  // that a STEP'S COST GREW WITH THE STEP COUNT, so measure exactly that: the
  // same amount of work early in the run and late in it. Under the fix the two
  // blocks are equal within noise; under any per-step O(k) copying the late
  // block costs ~9x the early one at these offsets.
  // Warm the JIT on a throwaway state first, or the early block absorbs
  // compilation time and deflates the ratio it is being compared against.
  {
    const warm = createInitialState(0.217, 0.217, g);
    for (let i = 0; i < 400 && !warm.converged; i++) {
      doStep(g, warm, 'A', 0.001, all, null, () => {}, () => {}, () => { warm.running = false; }, 'shrink');
    }
  }
  // Median of three 100-step samples per block, not one 300-step sample: on a
  // shared CI runner a single GC pause or scheduling gap inside a ~1.5 ms
  // window inflated one sample 4.2x (main a2b25c6, 2026-09-05) with no code
  // change. The defect this guards is per-step O(k) copying, which raises
  // EVERY late sample ~9x — the median still carries it (mutation-tested with
  // an injected O(stepCount) loop per step); one transient pause is the
  // outlier the median discards, and it discards nothing else (CodeRabbit).
  const medianOf = (n: number, count: number) => {
    const xs = Array.from({ length: n }, () => timeBlock(count)).sort((a, b) => a - b);
    return xs[Math.floor(n / 2)];
  };
  const early = medianOf(3, 100);
  // Structural contract of the measurement itself (CodeRabbit, #124): the
  // sampling really is 3×100 / 600 / 3×100 steps of ONE run, so the ratio
  // compares the same amount of work early and late.
  assert(sampled() === 3 && steps() === 300, `early block must be three 100-step samples (samples=${sampled()}, steps=${steps()})`);
  timeBlock(600);
  assert(sampled() === 4 && steps() === 900, `the intervening workload must be 600 steps (samples=${sampled()}, steps=${steps()})`);
  const late = medianOf(3, 100);
  assert(sampled() === 7 && steps() === 1200, `late block must be three 100-step samples (samples=${sampled()}, steps=${steps()})`);
  let n = st.stepCount;
  while (!st.converged && n < 20000) { step(); n++; }
  assert(st.converged, `the crash fixture must converge, not be cut off (stopped after ${n} steps)`);
  // 1504, not 5000: the old Phase-2 entry read the second root ON the corridor
  // boundary as a lost bracket and reset the corridor to [0,1], re-shrinking
  // everything Phase 1 had already narrowed (see testPhase2EntryKeepsCorridor).
  assert(n === 1504, `the fixture converges at 1504 steps (got ${n}) — 5000 was an artifact of the corridor reset`);
  const ratio = late / early;
  assert(ratio < 4,
    `per-step cost must not grow with the step count: the late block took ${late.toFixed(2)}ms against ${early.toFixed(2)}ms `
    + `for the early one (ratio ${ratio.toFixed(1)}x). That growth is the O(N^2) trajectory cloning that `
    + 'exhausted an 8GB heap at this scale and killed the browser renderer with no console error.');
  console.log(`✓ red-team 15 break A: ${n} steps converge; per-step cost flat (late/early ${ratio.toFixed(2)}x)`);
}

function testPhase2EntryKeepsCorridor() {
  // Found by Daniel during the 2026-08-30 localhost verification, live on
  // production: click "1st NE Coord" mid-run on the tab-wedge fixture and the
  // orange search corridor snaps back to the FULL cube right after the green
  // domain box had narrowed — the visual says "converging" while the geometry
  // restarts from scratch.
  //
  // Root cause: Phase-2 entry tested `fn(lo)·fn(hi) >= 0` for a lost bracket.
  // On this fixture Phase 1 contracts the domain to exactly [y*, x*] = [0.3,
  // 0.7], so the second root sits ON the lo boundary, the product is 0, and a
  // PERFECT bracket was read as lost — the corridor reset to [0,1] and Phase 2
  // re-shrank 0.7 of domain for nothing (the run took 5000 steps where the
  // geometry needs 1504).
  //
  // The fix keeps the corridor when either bound is within the DISCOVERY
  // tolerance of the root (the same tolerance ghostStep uses, so "keep" and
  // "discovery fires here" can never disagree) and, when the root is strictly
  // outside, extends only the bound on the root's side instead of both.
  const g: GamePayoffs = { a11: 7, b11: -7, a12: -6, b12: -4, a21: -7, b21: 1, a22: 0, b22: -6 };
  const all = computeAllNE(g);
  const st = createInitialState(0.217, 0.217, g);

  let entered = false;
  let widthAtEntry = Infinity;
  let widthAfterEntry = 0;
  let prevInPhase2 = false;
  for (let i = 0; i < 20000 && !st.converged; i++) {
    doStep(g, st, 'A', 0.001, all, null, () => {}, () => {}, () => { st.running = false; }, 'shrink');
    const inPhase2 = (st.discoveredMixedX !== null) !== (st.discoveredMixedY !== null);
    if (inPhase2 && !prevInPhase2) {
      entered = true;
      widthAtEntry = st.domainHi - st.domainLo;
      // THE assertion, stated as the visual reads it: the corridor Phase 2
      // starts from is the corridor Phase 1 ended with. The defect opened it
      // back to width 1.0 on the very step after this one.
      assert(st.domainLo === 0.3 && st.domainHi === 0.7,
        `Phase 2 must inherit Phase 1's corridor [0.3, 0.7] (got [${st.domainLo}, ${st.domainHi}])`);
    }
    if (entered) widthAfterEntry = Math.max(widthAfterEntry, st.domainHi - st.domainLo);
    prevInPhase2 = inPhase2;
  }
  assert(entered, 'fixture must reach Phase 2');
  assert(st.converged, 'fixture must converge');
  assert(widthAfterEntry <= widthAtEntry + 1e-9,
    `the corridor must never WIDEN after Phase-2 entry (was ${widthAtEntry.toFixed(3)} at entry, saw ${widthAfterEntry.toFixed(3)} after) `
    + '— widening is the orange-cube snapback');
  assert(st.stepCount === 1504,
    `with the corridor preserved the geometry needs 1504 steps (got ${st.stepCount}), not the corridor-reset artifact 5000`);

  // The strictly-outside case: a Phase-1 corridor that genuinely excludes the
  // second root must gain ONLY the root's side, never both. Hand-built state,
  // because reaching this configuration end-to-end depends on where Phase 1
  // happens to stop: entry fires on the first doStep with foundAxis unset.
  // The payoffs hold BOTH indifference roots at the values the comment needs
  // AND kill every pure cell (a deviator in each), or doStep never reaches the
  // mixed branch at all — the first draft of this fixture had a pure NE at
  // (row 1, col 1) and the staged entry silently never fired.
  // A indifference: y·14 + (1-y)(-6) = 20y - 6 → y* = 0.3, below the corridor.
  // B indifference: x·(-1) + (1-x)·3 = 3 - 4x → x* = 0.75, already found.
  const g3: GamePayoffs = { a11: 7, a12: -6, a21: -7, a22: 0, b11: 0, b12: 1, b21: 3, b22: 0 };
  const m3 = computeMixedNE(g3)!;
  assert(r3(m3.y) === 0.3, `fixture y* must be 0.3 (got ${r3(m3.y)})`);
  const all3 = computeAllNE(g3);
  const st3 = createInitialState(0.217, 0.217, g3);
  // Stage mid-Phase-2 by hand: x* found, corridor [0.35, 0.8] excludes y*=0.3.
  st3.discoveredMixedX = 0.75;
  st3.domainLo = 0.35;
  st3.domainHi = 0.8;
  doStep(g3, st3, 'A', 0.01, all3, null, () => {}, () => {}, () => {}, 'shrink');
  assert(st3.foundAxis === 'x', 'entry fired on the staged state');
  assert(st3.domainHi === 0.8 && st3.domainLo === 0,
    `strictly-outside root must extend ONLY the root's side: expected [0, 0.8], got [${st3.domainLo}, ${st3.domainHi}]`);
  // And the extended corridor must still bracket the root for Phase 2 to use.
  const fn3 = (v: number) => v * (g3.a11 - g3.a21) + (1 - v) * (g3.a12 - g3.a22);
  assert(fn3(st3.domainLo) * fn3(st3.domainHi) < 0, 'the extended corridor brackets the second root');

  // The POINT-corridor degenerate: Phase 1 can narrow the corridor all the way
  // to width 0 (the fuzz suite caught this as a live non-convergence —
  // A[[0,1],[5,-3]] B[[-3,-5],[-5,-3]] contracts to [0.5, 0.5] at step 26).
  // There both |fn| are equal, the one-sided tie-break picks a side, and the
  // second root (y*=0.444) can be on the OTHER side — ghost bisection then
  // cycles forever on a bracket-less corridor. Entry must VERIFY the bracket
  // and widen fully when the one-sided guess didn't restore one.
  const g4: GamePayoffs = { a11: 0, a12: 1, a21: 5, a22: -3, b11: -3, b12: -5, b21: -5, b22: -3 };
  const m4 = computeMixedNE(g4)!;
  assert(r3(m4.x) === 0.5 && r3(m4.y) === 0.444, `fixture NE must be (0.5, 0.444) (got ${r3(m4.x)}, ${r3(m4.y)})`);
  const all4 = computeAllNE(g4);
  // staged: x* found, corridor collapsed to the point [0.5, 0.5]
  const st4 = createInitialState(0.217, 0.217, g4);
  st4.discoveredMixedX = 0.5;
  st4.domainLo = 0.5;
  st4.domainHi = 0.5;
  doStep(g4, st4, 'A', 0.1, all4, null, () => {}, () => {}, () => {}, 'shrink');
  const fn4 = (v: number) => v * (g4.a11 - g4.a21) + (1 - v) * (g4.a12 - g4.a22);
  assert(fn4(st4.domainLo) * fn4(st4.domainHi) < 0,
    `a point corridor must still yield a bracketing corridor after entry (got [${st4.domainLo}, ${st4.domainHi}])`);
  // and end-to-end the fuzz fixture must converge again (it ran 12,000 steps
  // without converging under the one-sided-only rule)
  const st4e = createInitialState(0.217, 0.217, g4);
  let n4 = 0;
  while (!st4e.converged && n4 < 20000) {
    doStep(g4, st4e, 'A', 0.1, all4, null, () => {}, () => {}, () => { st4e.running = false; }, 'shrink');
    n4++;
  }
  assert(st4e.converged, `the fuzz-regression fixture must converge again (ran ${n4} steps)`);
  assert(r3(st4e.discoveredMixedY!) === 0.444, `and find y*=0.444 (got ${st4e.discoveredMixedY})`);

  console.log('✓ phase-2 entry: corridor inherited (no [0,1] snapback), one-sided extension when the root is outside');
}

function testStepCapIsHonest() {
  // Red 15 target 2, fixed in the same round DELIBERATELY: the crash fixture
  // converges at exactly step 5000, and precomputeThinHistory allowed only 4999
  // doSteps. So fixing the crash alone would have converted a dead defect into a
  // live one — the run would finish one step short and the UI would show a full
  // "4999 / 4999" bar with Step disabled and no pill, which reads as completed.
  const src = readFileSync('src/App.tsx', 'utf8');
  const eng = readFileSync('src/utils/gameEngine.ts', 'utf8');
  assert(/truncated: !state\.converged/.test(eng),
    'precomputeThinHistory must REPORT when the cap bound rather than returning a history that looks complete');
  assert(/Stopped at the \{thinHistory\.length - 1\}-step limit/.test(src),
    'and the UI must say so: a full progress bar with Step disabled otherwise reads as a finished run');

  // EXERCISE the truncation path, do not merely assert it exists in source. The
  // red team swept ~8,400 configurations and found a worst reachable run of
  // 4,754 steps against a 20,000 cap, so this branch is unreachable from the UI
  // — which makes it untested code that renders user-visible text unless a test
  // injects a low cap. The alternative, deleting it, would restore silent
  // truncation the day a new preset or lambda range pushes past the cap.
  const g: GamePayoffs = { a11: 7, b11: -7, a12: -6, b12: -4, a21: -7, b21: 1, a22: 0, b22: -6 };
  const all = computeAllNE(g);
  const cut = precomputeThinHistory(createInitialState(0.217, 0.217, g), g, 'A', 0.001, all, null, 'shrink', 25);
  assert(cut.truncated === true, 'a run cut off by the cap must report truncated: true');
  assert(cut.snaps.length === 25, `and must stop exactly at the cap (got ${cut.snaps.length} snapshots)`);
  assert(cut.snaps[cut.snaps.length - 1].converged === false,
    'the final snapshot of a truncated run is NOT converged — which is what the notice exists to say');

  const whole = precomputeThinHistory(createInitialState(0.217, 0.217, g), g, 'A', 0.001, all, null, 'shrink');
  assert(whole.truncated === false, 'the same run under the real cap must NOT report truncated');
  assert(whole.snaps.length === 1505,
    `and must run to its natural end: 1504 steps plus the initial snapshot (got ${whole.snaps.length}). `
    + '(5000 was the corridor-reset artifact; see testPhase2EntryKeepsCorridor.)');
  assert(DEFAULT_MAX_STEPS > 5000,
    'the shipped cap must exceed the worst reachable run — the pre-fix sweep put it at 4,754 — or fixing the wedge silently truncates it');

  // MOVE PURITY. precomputeThinHistory/replayToStep/toThin were relocated from
  // App.tsx into this module and given an injectable cap. A move is exactly
  // where a new defaulted parameter silently absorbs a caller's argument, so
  // prove equivalence against a hand-rolled doStep loop rather than assume it.
  // (maxSteps is APPENDED after stepMode, and the one caller passes 7 args, so
  // stepMode still lands in slot 7 — this asserts that end to end.)
  const manual = createInitialState(0.217, 0.217, g);
  let steps = 0;
  while (!manual.converged && steps < 20000) {
    doStep(g, manual, 'A', 0.001, all, null, () => {}, () => {}, () => { manual.running = false; }, 'shrink');
    steps++;
  }
  assert(whole.snaps.length === steps + 1,
    `the moved precompute must walk the same trajectory as a manual doStep loop: ${steps} steps + 1 initial snapshot vs ${whole.snaps.length}`);
  const last = whole.snaps[whole.snaps.length - 1];
  assert(last.cx === manual.cx && last.cy === manual.cy && last.stepCount === manual.stepCount,
    `and land on the same state: precompute (${last.cx}, ${last.cy}) @${last.stepCount} vs manual (${manual.cx}, ${manual.cy}) @${manual.stepCount}`);
  assert(last.converged === true && last.cycleCount === manual.cycleCount,
    'including convergence and cycle count — the move must be behaviour-pure, not merely compile-clean');
  console.log('✓ step cap: truncation path exercised with an injected cap; the real cap clears the worst known run');
}

function testNoQuadraticSnapshotting() {
  // Class guard. The instance test above passes again the day someone
  // reintroduces per-step deep copying under another name. Note fuzz.test.ts had
  // already worked around this locally (truncating historyStack to 4 entries)
  // rather than fixing the root — a local workaround is how a defect like this
  // survives in plain sight.
  // Code lines only — the comments above the fix necessarily NAME the thing they
  // removed, and a guard that cannot tell prose from code would trip on its own
  // explanation.
  const codeOf = (f: string) => readFileSync(f, 'utf8').split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const eng = codeOf('src/utils/gameEngine.ts');
  assert(!/createSnapshot/.test(eng),
    'createSnapshot is gone: its only consumer was the delta check, which needs two numbers, not a deep clone of the trajectory');
  assert(!/historyStack/.test(eng),
    'historyStack is gone from the engine: it had exactly one reader, of the element it had just pushed');
  assert(!/historyStack/.test(codeOf('src/types.ts')),
    'and gone from SimState, so it cannot be silently repopulated by a future writer');
  assert(/const prevCx = s\.cx, prevCy = s\.cy;/.test(eng),
    'the delta check must read two locals captured before the move');
  console.log('✓ class guard: no per-step deep copying of the trajectory');
}

function testStartFieldWriteBack() {
  // Red 15 break B: patch 1 gave every numeric field ONE PARSER but only three
  // of its four sites also wrote the committed value BACK. Typing "2" into x0 —
  // a box whose own attributes say max="1.0" — left it reading 2 while the
  // readout showed 1.000 and the log opened "Start (1.000, 0.217)".
  assert(commitStartCoordinate('2') === 1, 'typing 2 commits as 1');
  assert(commitStartCoordinate('-1') === 0, 'typing -1 commits as 0');
  assert(commitStartCoordinate('') === 0.217, 'clearing the field commits the default');
  const src = readFileSync('src/App.tsx', 'utf8');
  assert(/onBlur=\{\(\) => commitStartField\('x'\)\}/.test(src)
      && /onBlur=\{\(\) => commitStartField\('y'\)\}/.test(src),
    'both start-point fields must write the committed value back on blur — the spinner three feet away already did, so the field showed one start point while every computation used another');
  // The write-back must fire ONLY when the box misrepresents the committed
  // value. Comparing against the FORMATTED string rewrote "0.5" to "0.500" —
  // same value, different text — which changes x0, fires the [x0, y0] re-freeze
  // effect and resets the run. A blur that changed nothing then wiped a finished
  // run. Same hazard handlePayoffBlur guards with its value inequality.
  assert(/if \(parseNumericInput\(raw\) !== committed\)/.test(src),
    'the start-field write-back must compare VALUES, not formatted strings, or a no-op blur resets the run');
  for (const harmless of ['0.5', '.5', '1', '0.2170', '0.217']) {
    assert(parseNumericInput(harmless) === commitStartCoordinate(harmless),
      `"${harmless}" already represents its committed value — blurring it must not rewrite the field or reset the run`);
  }
  for (const wrong of ['2', '-1', '']) {
    assert(parseNumericInput(wrong) !== commitStartCoordinate(wrong),
      `"${wrong}" misrepresents the value the run uses — blurring it MUST correct the field`);
  }
  console.log('✓ red-team 15 break B: x0/y0 canonicalise on blur, like every other numeric field');
}

function testRunContextInvariant() {
  // Red 15's reservation, and the coordinator's synthesis: break 2 was closed by
  // making every WRITER reset — the shape that failed in rounds 23-25 — leaving
  // the pill/progress/timeline read ungated behind two class guards. The right
  // answer is not a dead runtime branch but an assertion of the INVARIANT:
  //
  //     runStale && a surviving run context  ==>  unreachable
  //
  // runStale is `!runCtx || payoffs differ || firstMover differ`. So the
  // invariant holds iff every writer of those two fields clears runCtx. Rather
  // than counting call sites, check each one is inside a function that resets.
  const src = readFileSync('src/App.tsx', 'utf8');
  const fnOf = (idx: number) => {
    const before = src.slice(0, idx);
    const start = Math.max(before.lastIndexOf('\n  const '), before.lastIndexOf('\n  function '));
    return src.slice(start, idx + 2000);
  };
  const offenders: string[] = [];
  for (const re of [/setPayoffs\(/g, /setFirstMover\(/g]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const body = fnOf(m.index);
      const resets = /handleReset\(/.test(body);
      // The inactivity timer is the one writer that cannot change a VALUE: it
      // assigns 0 to a field it has already tested is 0, so runStale (which
      // compares by value) cannot go true through it.
      const valuePreserving = /if \(prev\[field\] === 0\)/.test(body);
      if (!resets && !valuePreserving) {
        offenders.push(src.slice(m.index, m.index + 60).split('\n')[0]);
      }
    }
  }
  assert(offenders.length === 0,
    'every writer of payoffs/firstMover must clear the run context, or a finished run keeps being '
    + 'narrated by the pill, the progress bar and the timeline under rules it never used. '
    + `Unguarded writer(s):\n  ${offenders.join('\n  ')}`);
  console.log('✓ run-context invariant: runStale cannot be true while a run still exists');
}


function testStepModeHasOneWriter() {
  // The third control that defines a run's rules, after the matrix and the turn
  // order. Both steppers pass `fc.stepMode` from the FROZEN run context
  // (App.tsx handleStep and the play-runner), so switching method mid-run left
  // the button visibly active while every subsequent Step continued under the
  // old method. Nothing false was printed — the control silently had no effect,
  // and a user cannot tell that apart from an effect they cannot see.
  //
  // Same single-writer shape as changeFirstMover, and the same reason it is not
  // a useEffect: the tour re-asserts the method on almost every step of the
  // mixed act, and the unchanged-value early return keeps those true no-ops.
  const src = readFileSync('src/App.tsx', 'utf8');
  const sites = src.split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter((r) => /setStepMode\(/.test(r.line) && !/^\s*(\/\/|\*)/.test(r.line));
  assert(sites.length === 1,
    'setStepMode must be CALLED in exactly one place — the body of changeStepMode. The convergence '
    + 'method is part of a run\'s rules, so every writer must go through it or the control silently '
    + `does nothing to a run already in progress:\n  ${sites.map((r) => `App.tsx:${r.n}: ${r.line}`).join('\n  ')}`);
  assert(/const changeStepMode = \(next: 'shrink' \| 'regret'\) => \{[\s\S]{0,300}?if \(next === stepMode\) return;/.test(src),
    'changeStepMode must early-return on an unchanged value, or the tour\'s per-step re-assertions would reset the run mid-act');
  assert(/const changeStepMode = \(next: 'shrink' \| 'regret'\) => \{[\s\S]{0,400}?if \(runCtx\) handleReset\(\);/.test(src),
    'and it must reset when the method actually changes');
  // The steppers must still read the FROZEN method — that is what made the
  // silent no-op possible, and it is also what keeps a running run coherent.
  assert(/fc\.stepMode\);/.test(src),
    'the steppers must keep passing the frozen fc.stepMode; the fix is to end the run on a change, not to unfreeze it');
  console.log('✓ class guard: stepMode has exactly one writer, and it ends the run it would otherwise silently ignore');
}


function testTourStagesTheDisplayedMethod() {
  // Red 16: four clicks from a cold load, the app ran DOMAIN SHRINK while the
  // method panel, the step-size label, the help text and the plot caption all
  // said OPPONENT REGRET. Take the tour, Next x11 to step 12, click "Domain
  // Shrink" once, Next. Step 13 is titled "Watch the leans flatten" and the
  // regret strategy lines were not drawn at all.
  //
  // MECHANISM — neither hypothesis offered. Step 13's onEnter calls
  // changeStepMode('regret') and then `tourDefer(() => handleStep(true), 350)`.
  // tourDefer is window.setTimeout, so the callback captures handleStep from the
  // render in which onEnter ran — BEFORE its own setState commits. It is stale
  // BY CONSTRUCTION, not by racing, and no delay would fix it. On the normal
  // path the mode is already 'regret' by step 13, so the stale value happens to
  // be right; touching the method button once on step 12 makes it wrong. It is
  // not the changeStepMode reset (runCtx is null there, and the step calls
  // handleReset itself), and not the staging effect (step 13 does not use it).
  //
  // THE ORACLE IS THE RUN ITSELF, not a label. Penalty Kick from the tour's own
  // staging point produces two exact, independent discriminators per mode.
  const penalty: GamePayoffs = { a11: -12, b11: 12, a12: 8, b12: -8, a21: 2, b21: -2, a22: 0, b22: 0 };
  const all = computeAllNE(penalty);
  const stage = (mode: 'shrink' | 'regret') =>
    precomputeThinHistory(createInitialState(0.8, 0.2, penalty), penalty, 'A', 0.3, all, null, mode);

  const regret = stage('regret');
  const shrink = stage('shrink');
  // Distinguishability FIRST: after the exact-value assertions below, TypeScript
  // narrows both to literals and flags this comparison as tautological (TS2367).
  // It is the load-bearing claim — if the two modes ever produced the same
  // counts, this test would silently stop being able to see the defect — so it
  // keeps its own line rather than being deleted as redundant.
  assert(regret.snaps.length !== shrink.snaps.length && regret.neState?.stepCount !== shrink.neState?.stepCount,
    'the two modes must stay distinguishable by BOTH discriminators, or this test stops being able to see the defect');
  assert(regret.snaps.length - 1 === 30 && regret.neState?.stepCount === 24,
    `fixture: regret stages 30 steps with first-find at 24 (got ${regret.snaps.length - 1}, ${regret.neState?.stepCount})`);
  assert(shrink.snaps.length - 1 === 58 && shrink.neState?.stepCount === 37,
    `fixture: shrink stages 58 steps with first-find at 37 (got ${shrink.snaps.length - 1}, ${shrink.neState?.stepCount})`);

  // The staged run must be built from CURRENT parameters, never from a closure
  // captured before the step changed them. Pinned at source because the
  // staleness lives in a timer that no node test can drive.
  const src = readFileSync('src/App.tsx', 'utf8');
  assert(/const rp = runParamsRef\.current;/.test(src)
      && /const \{ payoffs, firstMover, shrinkStep, stepMode, allNE, committedNE \} = rp;/.test(src),
    'handleStep\'s init branch must read the run parameters from runParamsRef, not from its own closure — '
    + 'a deferred caller (tourDefer) holds a closure from before its own onEnter\'s setState committed');
  assert(/runParamsRef\.current = \{ payoffs, firstMover, shrinkStep, stepMode, allNE, committedNE, x0, y0 \};/.test(src),
    'and the ref must be refreshed every commit, or it becomes a second stale source');
  // x0/y0 are in the ref for the same reason: a deferred stage must not start
  // the run from the start point that was showing before the step moved it.
  assert(/commitStartCoordinate\(rp\.x0\)/.test(src) && /commitStartCoordinate\(rp\.y0\)/.test(src),
    'the start point must come from the ref too — same staleness, same timer');
  console.log('✓ red-team 16: a deferred tour stage builds its run from current parameters, not a stale closure');
}

function testTourMoverArgumentStaysSafe() {
  // LATENT HAZARD, flagged rather than fixed. changeFirstMover resets when the
  // mover actually changes, and the tour calls it at two act entries — but both
  // pass 'A', which the tour has almost always already set, so the early return
  // fires and the call is a genuine no-op. That safety is ACCIDENTAL: it holds
  // because of the value currently passed, not by construction. If any act ever
  // stages 'B', changeFirstMover acquires the same shape as the defect above,
  // with a reset landing inside a staged step. Same kind of inert-by-coincidence
  // hazard as the non-global regex flag: assert the coincidence so it cannot
  // quietly stop being true.
  const src = readFileSync('src/App.tsx', 'utf8');
  const args = [...src.matchAll(/changeFirstMover\((['"])(\w+)\1\)/g)].map((m) => m[2]);
  assert(args.length >= 2, `expected the tour's act entries to call changeFirstMover with a literal (found ${args.length})`);
  assert(args.every((a) => a === 'A'),
    'every literal changeFirstMover call in the tour passes \'A\', which is why its reset never fires mid-tour. '
    + `A site staging '${args.find((a) => a !== 'A')}' would reset a staged run exactly as red-team 16 did — `
    + 'route it through a non-resetting path first, then update this assertion.');
  console.log('✓ latent-hazard guard: the tour never stages a mover change, so changeFirstMover cannot reset mid-act');
}

function testPerformanceBudgets() {
  // Wall-clock budgets are deliberately ~500x the local measurement: GitHub's
  // 2-core runners vary several-fold, and a tight budget would flake long
  // before it caught anything. What each budget IS calibrated to catch is an
  // ORDER-OF-MAGNITUDE complexity regression — the tab wedge was exactly that
  // (a per-step O(N) copy turning a 1504-step run into an O(N²) heap bomb),
  // and it shipped because no test measured any wall clock at all. The
  // complexity-shape guards elsewhere (testRedTeamRound15BreakA's
  // early/late ratio, testNoQuadraticSnapshotting) stay the primary defense;
  // these budgets are the absolute backstop.
  const BUDGET_SOLVER_MS = 5_000;        // local: ~10ms for 20k games
  const BUDGET_PRECOMPUTE_MS = 5_000;    // local: tens of ms for 1504 steps
  const BUDGET_BATTERY_MS = 30_000;      // local: well under a second

  // 1. solver throughput — 20k random games through the full NE finder
  let seed = 0x5EED;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const games: GamePayoffs[] = [];
  for (let i = 0; i < 20_000; i++) {
    const v = () => Math.round((rnd() * 2 - 1) * 10);
    games.push({ a11: v(), a12: v(), a21: v(), a22: v(), b11: v(), b12: v(), b21: v(), b22: v() });
  }
  let t0 = process.hrtime.bigint();
  let neCount = 0;
  for (const g of games) neCount += computeAllNE(g).length;
  const solverMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert(solverMs < BUDGET_SOLVER_MS,
    `solver throughput regressed: 20k games took ${solverMs.toFixed(0)}ms (budget ${BUDGET_SOLVER_MS}ms; local baseline ~10ms)`);
  assert(neCount > 20_000, `the sweep must actually exercise the solver (found ${neCount} NEs)`);

  // 2. precomputeThinHistory on the crash fixture — the exact call the tab
  //    wedge lived in (1504 steps of full state snapshots)
  const g2: GamePayoffs = { a11: 7, b11: -7, a12: -6, b12: -4, a21: -7, b21: 1, a22: 0, b22: -6 };
  const all2 = computeAllNE(g2);
  t0 = process.hrtime.bigint();
  const hist = precomputeThinHistory(createInitialState(0.217, 0.217, g2), g2, 'A', 0.001, all2, null, 'shrink');
  const preMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert(preMs < BUDGET_PRECOMPUTE_MS,
    `precomputeThinHistory regressed: 1504-step precompute took ${preMs.toFixed(0)}ms (budget ${BUDGET_PRECOMPUTE_MS}ms)`);
  assert(hist.snaps.length > 1_400, `the precompute must cover the run (got ${hist.snaps.length} snapshots)`);

  // 3. end-to-end battery — 200 random games must each converge inside the
  //    step cap, together in reasonable time. This is the budget that catches
  //    a step-count explosion (a corridor bug that turns 1,000-step runs into
  //    20,000-step cap-outs) even when each step stays cheap.
  t0 = process.hrtime.bigint();
  let totalSteps = 0;
  for (let i = 0; i < 200; i++) {
    const g = games[i * 7 % games.length];
    const st = simulate(g, { shrinkStep: 0.1, maxSteps: DEFAULT_MAX_STEPS });
    totalSteps += st.stepCount;
  }
  const batteryMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert(batteryMs < BUDGET_BATTERY_MS,
    `simulation battery regressed: 200 games took ${batteryMs.toFixed(0)}ms (budget ${BUDGET_BATTERY_MS}ms)`);
  assert(totalSteps < 200 * DEFAULT_MAX_STEPS,
    `the battery hit the step cap on some game (total ${totalSteps} steps) — a convergence regression, not a perf one`);

  console.log(`✓ performance budgets: solver 20k=${solverMs.toFixed(0)}ms, precompute=${preMs.toFixed(0)}ms, `
    + `200-game battery=${batteryMs.toFixed(0)}ms (${totalSteps} steps total)`);
}

function runTests() {
  testSolverCanonicalGames();
  testZeroSumSearchFamily();
  testSimulationConvergence();
  testGhostCorridorInvariant();
  testGeometryOracleAgreesWithSolver();
  testGeometryValidatorChecks();
  testProseNumericChecks();
  testScenarioStoryClaims();
  testProseActionClaims();
  testProseDirectionCheck();
  testEquilibriumSet();
  testClaimFreeScreen();
  testEquilibriumActionsContinuum();
  testTemplateDeclarations();
  testRedTeamFindings();
  testSubResolutionWordingEverywhere();
  testRedTeamFindings3();
  testRedTeamFindings4();
  testRedTeamFindings5();
  testRedTeamFindings6();
  testRedTeamFindings7();
  testRedTeamFindings8();
  testRedTeamFindings9();
  testRedTeamFindings10();
  testRedTeamFindings11and12();
  testRedTeamFindings13();
  testRedTeamFindings14();
  testRedTeamBreak1StaleReplay();
  testRedTeamBreak2MoverNarration();
  testNoAdHocNumericParsers();
  testFirstMoverHasOneWriter();
  testPayoffsWritersAllInvalidate();
  testLogLineColoursMatchPlotMarkers();
  testValidatorUnicodeMinus();
  testTwoNegativesInOneSentence();
  testRedTeamRound15BreakA();
  testPhase2EntryKeepsCorridor();
  testStepCapIsHonest();
  testNoQuadraticSnapshotting();
  testStartFieldWriteBack();
  testRunContextInvariant();
  testStepModeHasOneWriter();
  testTourStagesTheDisplayedMethod();
  testTourMoverArgumentStaysSafe();
  testJointPayoffClaim();
  testTieProse();
  testPerformanceBudgets();
  console.log('All game-engine regression tests passed.');
}

try {
  runTests();
} catch (err: any) {
  console.error('Test suite failure:');
  console.error(err?.message || err);
  process.exit(1);
}
