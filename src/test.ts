/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GamePayoffs, SimState, NashEquilibrium, PathSegment } from './types';
import { doStep, PRESETS, computeAllNE, EA, EB, r3 } from './utils/gameEngine';

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

function runTests() {
  testSolverCanonicalGames();
  testZeroSumSearchFamily();
  testSimulationConvergence();
  testGhostCorridorInvariant();
  console.log('All game-engine regression tests passed.');
}

try {
  runTests();
} catch (err: any) {
  console.error('Test suite failure:');
  console.error(err?.message || err);
  process.exit(1);
}
