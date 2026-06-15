/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GamePayoffs, SimState, NashEquilibrium, PathSegment } from './types';
import { doStep, PRESETS, computeAllNE, EA, EB, r3 } from './utils/gameEngine';

// Mock function for Logging in tests
let logs: string[] = [];
function addTestLog(msg: string) {
  logs.push(msg);
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
    phase1PtsA: null, phase1PtsB: null,
    ghostPathSegmentsA: [],
    ghostPathSegmentsB: [],
    cyclePattern: null, bisecting: false,
    bisectGoodLo: 0, bisectGoodHi: 1, bisectBadLo: 0, bisectBadHi: 1,
    ghostCyclePattern: null, ghostBisecting: false,
    ghostBisectGoodLo: 0, ghostBisectGoodHi: 1, ghostBisectBadLo: 0, ghostBisectBadHi: 1,
    historyStack: []
  };
}

// ── TEST 1: Diagnostic on Old Diagonal Ghost Step vs New Step ──────────────
function runTests() {
  console.log('----------------------------------------------------');
  console.log('NASH EQUILIBRIUM SIMULATOR GHOST CORIDDORS TEST SUITE');
  console.log('----------------------------------------------------');

  const spyGame: GamePayoffs = {
    a11: 3, b11: -3,  a12: -2, b12: 2,
    a21: -1, b21: 1,  a22: 0, b22: 0,
  };

  const allNE = computeAllNE(spyGame);
  const startX = 0.217;
  const startY = 0.217;

  const state = createInitialState(startX, startY, spyGame);
  logs = [];

  console.log('1. Simulating best-response dynamics for Spy vs. Analyst...');

  // Run the simulation steps until we enter Phase 2 and complete a full corridor cycle
  let ghostCycleDetected = false;
  let stepsPlayed = 0;
  const maxSteps = 1000;

  let savedGhostPositionsInCycle: string[] = [];
  let prevFoundAxis: 'x' | 'y' | null = null;

  while (!state.converged && !ghostCycleDetected && stepsPlayed < maxSteps) {
    const prevCalcX = state.calcX;
    const prevCalcY = state.calcY;
    const prevCycleCount = state.cycleCount;
    prevFoundAxis = state.foundAxis;

    // Capture ghost trajectory coordinates before they are cleared inside doStep due to cycle detection
    const inPhase2Before = (state.discoveredMixedX !== null) !== (state.discoveredMixedY !== null);
    if (inPhase2Before && state.ghostVisitedPositions.length > 0) {
      savedGhostPositionsInCycle = [...state.ghostVisitedPositions];
    }

    doStep(
      spyGame,
      state,
      'A', // firstMover A
      0.01, // default shrink step
      allNE,
      null, // committedNE (none for mixed game)
      addTestLog,
      () => {
        const inPhase2 = (state.discoveredMixedX !== null) !== (state.discoveredMixedY !== null);
        if (inPhase2) {
          ghostCycleDetected = true;
        }
      },
      () => {
        console.log('   Converged!');
      }
    );

    console.log(`Step ${state.stepCount}: calcX=${state.calcX}, calcY=${state.calcY}, discX=${state.discoveredMixedX}, discY=${state.discoveredMixedY}, ghostLen=${state.ghostVisitedPositions.length}, cycleCount=${state.cycleCount}`);

    stepsPlayed++;

    // In Phase 2, verify that only ONE coordinate changes per step (no diagonal movements!)
    const inPhase2After = (state.discoveredMixedX !== null) !== (state.discoveredMixedY !== null);
    const isGhostInitStep = prevFoundAxis === null && state.foundAxis !== null;

    if (inPhase2After && prevCalcX !== null && prevCalcY !== null && state.calcX !== null && state.calcY !== null) {
      // Ghost initialization step: Phase 2 resets calcX/calcY to domainHi then runs the first ghost
      // move in one doStep — so the net change can appear diagonal. Skip this one step.
      if (isGhostInitStep) {
        console.log(`   (Ghost initialized at Step ${state.stepCount}. Skipping diagonal check for Phase 2 init.)`);
      } else if (state.cycleCount !== prevCycleCount) {
        // Domain contraction clamps both dimensions simultaneously — skip diagonal check.
        console.log(`   (Cycle detected and shrunk at Step ${state.stepCount}. Skipping diagonal check for contraction.)`);
      } else {
        const dx = Math.abs(state.calcX - prevCalcX);
        const dy = Math.abs(state.calcY - prevCalcY);

        // If BOTH dx and dy are greater than 0, then the ghost has moved diagonally!
        if (dx > 0 && dy > 0) {
          throw new Error(`FAIL: Ghost moved diagonally at step ${state.stepCount}! dx=${dx.toFixed(3)}, dy=${dy.toFixed(3)}. Position switched from (${prevCalcX}, ${prevCalcY}) to (${state.calcX}, ${state.calcY})`);
        }
      }
    }
  }

  console.log('   [PASS] Verified that the ghost never moves diagonally (only one coordinate changes per step).');

  // Verify that all 4 endpoints of the corridor were reached during Phase 2 cycle detection
  // In the first Ghost Cycle:
  // Since we check the list of visited positions *before* adding the next one:
  // On Phase 2 entry, ghost starts at hi, hi.
  // Then B flips y to lo: (hi, lo) is logged -> Step 1
  // Then A moves x to lo (best response): (lo, lo) is logged -> Step 2
  // Then B flips y to hi: (lo, hi) is logged -> Step 3
  // Then A moves x to hi: (hi, hi) is logged -> Step 4
  // Then B flips y to lo: (hi, lo) is tested, seen in ghostVisitedPositions, triggering a cycle!
  // This means exactly 4 unique endpoints of the search corridor were in the visited positions at cycle detection!
  
  const ghostUniquePositions = new Set(savedGhostPositionsInCycle);
  console.log('   Ghost coordinates logged in the first corridor cycle:', savedGhostPositionsInCycle);
  console.log(`   Number of unique coordinates visited: ${ghostUniquePositions.size}`);

  if (ghostUniquePositions.size !== 4) {
    throw new Error(`FAIL: Simulated cycle only visited ${ghostUniquePositions.size} endpoints. Expected exactly 4!`);
  }

  console.log('   [PASS] All 4 corridor endpoints were reached before a cycle was detected.');
  console.log('----------------------------------------------------');
  console.log('ALL TESTS PASSED SUCCESSFULLY! The corridor search is mathematically correct.');
  console.log('----------------------------------------------------');
}

try {
  runTests();
  process.exit(0);
} catch (err: any) {
  console.error('\n❌ TEST SUITE FAILURE:');
  console.error(err.message || err);
  process.exit(1);
}
