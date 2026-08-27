/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GamePayoffs, SimState, NashEquilibrium, PathSegment, LlmReport, MismatchKind, SuggestedScenario } from './types';
import { doStep, PRESETS, computeAllNE, EA, EB, r3 } from './utils/gameEngine';
import { describeGeometry } from './utils/geometry';
import { validateReport, validateScenario, validateProseClaims } from './utils/nashValidator';

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
    ghostBisectBadHi: 1,
    historyStack: []
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
    ghostPathSegmentsB: cloneSegments(s.ghostPathSegmentsB),
    historyStack: []
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

  const truthFor = (g: GamePayoffs) => {
    const geo = describeGeometry(g);
    return {
      surfacesInteract: Math.abs(geo.twistA) >= 1e-9,
      opponentSurfaceIsMirror: geo.zeroSum || geo.constantSum,
      hasFlatShelfForA: geo.yStarInRange,
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
  for (const [name, g] of [['matching pennies', MATCHING_PENNIES], ['PD', PD], ['flat A', FLAT_A], ['BoS', BOS]] as const) {
    const v = validateReport(reportFor(g, truthFor(g)), g);
    const geoFails = v.mismatches.filter(m => m.kind.startsWith('geometry-'));
    assert(geoFails.length === 0, `${name}: truthful geometry flagged — ${geoFails.map(m => m.detail).join('; ')}`);
  }

  // --- positive fixtures: one lie each, and ONLY that check fires -----------
  const cases: { label: string; g: GamePayoffs; field: keyof ReturnType<typeof truthFor>; kind: MismatchKind }[] = [
    { label: 'claims interaction on a flat surface', g: FLAT_A, field: 'surfacesInteract', kind: 'geometry-bad-twist' },
    { label: 'claims a mirror on non-zero-sum PD', g: PD, field: 'opponentSurfaceIsMirror', kind: 'geometry-bad-mirror' },
    { label: 'claims a shelf where y* is off-board', g: PD, field: 'hasFlatShelfForA', kind: 'geometry-bad-shelf' },
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
  assert(validateScenario(sc({ description: QUIT_DESC, storyClaims: { cellCitations: [], bestReplies: [
    { player: 'A', opponentOption: 1, bestOption: 2 },
  ] } }), QUITGAME).ok, 'the same sentence WITH a declared (and true) best-reply must pass');
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
  console.log('All game-engine regression tests passed.');
}

try {
  runTests();
} catch (err: any) {
  console.error('Test suite failure:');
  console.error(err?.message || err);
  process.exit(1);
}
