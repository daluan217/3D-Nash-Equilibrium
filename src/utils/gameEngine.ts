/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GamePayoffs, SimState, NashEquilibrium, PresetGame, PathSegment } from '../types';

export const PRESETS: Record<string, PresetGame> = {
  bos: {
    key: 'bos',
    name: 'Battle of the Sexes',
    a11: 2, b11: 1,  a12: 0, b12: 0,
    a21: 0, b21: 0,  a22: 1, b22: 2,
    desc: '<strong>Battle of the Sexes:</strong> Two partners want to spend the evening together but prefer different activities. '
        + '<span style="color:#C0392B;font-weight:600;">Player A</span> prefers the Opera (Row 1), '
        + '<span style="color:#1A5276;font-weight:600;">Player B</span> prefers Football (Col 2). '
        + 'Being together matters to both, but each would rather be at their favourite venue. '
        + 'Payoffs: (Opera,Opera)=(2,1), (Opera,Football)=(0,0), (Football,Opera)=(0,0), (Football,Football)=(1,2).'
  },
  pd: {
    key: 'pd',
    name: 'Prisoners Dilemma',
    a11: 3, b11: 3,  a12: 0, b12: 5,
    a21: 5, b21: 0,  a22: 1, b22: 1,
    desc: '<strong>Prisoner\'s Dilemma:</strong> Two suspects are arrested and held in separate cells. '
        + 'Each can Cooperate (Row 1/Col 1) with their partner by remaining silent, or Defect (Row 2/Col 2) by confessing. '
        + 'Defecting is a strictly dominant strategy for both players, leading them inexorably to the unique dominant strategy Nash Equilibrium of mutual defection (1,1), '
        + 'even though mutual cooperation would have yielded a much higher payoff (3,3) for both.'
  },
  cnr: {
    key: 'cnr',
    name: 'Cops & Robbers',
    a11: 3, b11: 2,  a12: 3, b12: 3,
    a21: 2, b21: 4,  a22: 4, b22: 1,
    desc: '<strong>Cops &amp; Robbers:</strong> A robber chooses to Stay at Home (Row 1) or Commit a Crime (Row 2). '
        + 'A cop simultaneously decides to Patrol (Col 1) or Eat Donuts (Col 2). '
        + 'The robber wants to commit crime undetected, while the cop wants to patrol and catch them. '
        + '<span style="color:#C0392B;font-weight:600;">Robber\'s payoff</span> is maximized (4) when they commit crime while the cop eats donuts; '
        + '<span style="color:#1A5276;font-weight:600;">cop\'s payoff</span> is maximized (4) when patrolling while a crime is committed. '
        + 'Payoffs (clockwise from top-left): (3,2), (3,3), (4,1), (2,4).'
  },
  spy: {
    key: 'spy',
    name: 'Spy vs. Analyst',
    a11: 3, b11: -3,  a12: -2, b12: 2,
    a21: -1, b21: 1,  a22: 0, b22: 0,
    desc: '<strong>Spy vs. Analyst:</strong> A spy chooses to leak classified intel (Row 1) or stay silent (Row 2). '
        + 'An analyst simultaneously decides to publish a story (Col 1) or hold it (Col 2). '
        + 'The spy gains from publication when leaking but loses credibility if silent and published. '
        + 'The analyst profits from a confirmed scoop but risks backlash if they publish without a leak. '
        + 'This zero-sum-adjacent game has no pure Nash Equilibrium — both players must mix their strategies. '
        + 'Payoffs (clockwise from top-left): (3,−3), (−2,2), (0,0), (−1,1).'
  },
  custom: {
    key: 'custom',
    name: 'Custom',
    desc: 'Enter your own payoff values in the matrix below.'
  }
};

// ── Payoff functions ─────────────────────────────────────────────────────────
export function EA(x: number, y: number, g: GamePayoffs): number {
  return x * y * g.a11 + x * (1 - y) * g.a12 + (1 - x) * y * g.a21 + (1 - x) * (1 - y) * g.a22;
}

export function EB(x: number, y: number, g: GamePayoffs): number {
  return x * y * g.b11 + x * (1 - y) * g.b12 + (1 - x) * y * g.b21 + (1 - x) * (1 - y) * g.b22;
}

export function r3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// ── NE computation ───────────────────────────────────────────────────────────
export function computeMixedNE(g: GamePayoffs): { x: number; y: number } | null {
  const dY = g.a11 - g.a12 - g.a21 + g.a22;
  const dX = g.b11 - g.b21 - g.b12 + g.b22;
  if (Math.abs(dY) < 1e-9 || Math.abs(dX) < 1e-9) return null;
  const yS = r3((g.a22 - g.a12) / dY);
  const xS = r3((g.b22 - g.b21) / dX);
  if (xS <= 0 || xS >= 1 || yS <= 0 || yS >= 1) return null;
  return { x: xS, y: yS };
}

export function computeAllNE(g: GamePayoffs): NashEquilibrium[] {
  const nes: NashEquilibrium[] = [];
  const corners = [[0, 0], [1, 0], [0, 1], [1, 1]];
  corners.forEach(([x, y]) => {
    const rA1 = y * g.a11 + (1 - y) * g.a12;
    const rA2 = y * g.a21 + (1 - y) * g.a22;
    const rB1 = x * g.b11 + (1 - x) * g.b21;
    const rB2 = x * g.b12 + (1 - x) * g.b22;
    
    // Is A's chosen action (Row 1 if x === 1, Row 2 if x === 0) a best response to y?
    const isABestResponse = (x === 1) ? (rA1 >= rA2 - 1e-9) : (rA2 >= rA1 - 1e-9);
    // Is B's chosen action (Col 1 if y === 1, Col 2 if y === 0) a best response to x?
    const isBBestResponse = (y === 1) ? (rB1 >= rB2 - 1e-9) : (rB2 >= rB1 - 1e-9);

    if (isABestResponse && isBBestResponse) {
      nes.push({
        x,
        y,
        type: 'pure',
        label: `Pure NE (Row${x === 1 ? '1' : '2'}, Col${y === 1 ? '1' : '2'})`,
        eA: r3(EA(x, y, g)),
        eB: r3(EB(x, y, g))
      });
    }
  });

  const mn = computeMixedNE(g);
  if (mn) {
    nes.push({
      x: mn.x,
      y: mn.y,
      type: 'mixed',
      label: `Mixed NE (x*=${mn.x.toFixed(3)}, y*=${mn.y.toFixed(3)})`,
      eA: r3(EA(mn.x, mn.y, g)),
      eB: r3(EB(mn.x, mn.y, g))
    });
  }
  return nes;
}

export function chooseBestPureNEForMover(mover: 'A' | 'B', pureNEs: NashEquilibrium[]): NashEquilibrium | null {
  if (pureNEs.length === 0) return null;
  if (pureNEs.length === 1) return pureNEs[0];
  return pureNEs.reduce((best, ne) => {
    const myP   = mover === 'A' ? ne.eA   : ne.eB;
    const bestP = mover === 'A' ? best.eA : best.eB;
    return myP > bestP ? ne : best;
  });
}

// ── Payoff equation string builder ───────────────────────────────────────────
export function buildPolyStr(cXY: number, cX: number, cY: number, cC: number): string {
  const terms: string[] = [];
  function addTerm(coef: number, v: string) {
    const c = r3(coef);
    if (Math.abs(c) < 1e-9) return;
    const sign = c > 0 ? '+' : '-';
    const abs  = Math.abs(c);
    const cs   = (Math.abs(abs - 1) < 1e-9 && v !== '') ? '' : abs.toString();
    if (terms.length === 0) terms.push((c < 0 ? '-' : '') + cs + v);
    else terms.push(' ' + sign + ' ' + cs + v);
  }
  addTerm(cXY, 'xy');
  addTerm(cX, 'x');
  addTerm(cY, 'y');
  addTerm(cC, '');
  return terms.length === 0 ? '0' : terms.join('');
}

// ── Bisection helper: adjusts domain on Phase 1 cycle detection ──────────────
// Records the best-response sign pattern from the first cycle. On subsequent
// cycles, if the pattern is unchanged the domain shrinks normally. When the
// pattern flips (domain overshot the NE coordinate) we bisect between the last
// known-good domain and the current bad domain until the EPS check fires.
function applyBisectCycleStep(s: SimState, g: GamePayoffs, defaultStep: number, mover: 'A' | 'B'): void {
  const sAFn = (y: number) => y * (g.a11 - g.a21) + (1 - y) * (g.a12 - g.a22);
  const sBFn = (x: number) => x * (g.b11 - g.b12) + (1 - x) * (g.b21 - g.b22);
  const pat = {
    aHi: sAFn(s.domainHi), aLo: sAFn(s.domainLo),
    bHi: sBFn(s.domainHi), bLo: sBFn(s.domainLo),
  };

  const EPS_PAT = 1e-4;
  const patternOK = s.cyclePattern === null || (
    !(Math.abs(pat.aHi) > EPS_PAT && Math.sign(pat.aHi) !== Math.sign(s.cyclePattern.aHi)) &&
    !(Math.abs(pat.aLo) > EPS_PAT && Math.sign(pat.aLo) !== Math.sign(s.cyclePattern.aLo)) &&
    !(Math.abs(pat.bHi) > EPS_PAT && Math.sign(pat.bHi) !== Math.sign(s.cyclePattern.bHi)) &&
    !(Math.abs(pat.bLo) > EPS_PAT && Math.sign(pat.bLo) !== Math.sign(s.cyclePattern.bLo))
  );

  let newLo: number;
  let newHi: number;

  if (!s.bisecting) {
    if (patternOK) {
      // Forward phase: store reference on first cycle, update good bounds, shrink normally
      if (s.cyclePattern === null) s.cyclePattern = pat;
      s.bisectGoodLo = s.domainLo;
      s.bisectGoodHi = s.domainHi;
      newLo = r3(s.domainLo + defaultStep);
      newHi = r3(s.domainHi - defaultStep);
    } else {
      // First overshoot: enter bisect mode, try midpoint between last good and current bad
      s.bisecting = true;
      s.bisectBadLo = s.domainLo;
      s.bisectBadHi = s.domainHi;
      newLo = r3((s.bisectGoodLo + s.bisectBadLo) / 2);
      newHi = r3((s.bisectGoodHi + s.bisectBadHi) / 2);
    }
  } else {
    // Bisect phase: update good or bad boundary based on current pattern result
    if (patternOK) {
      s.bisectGoodLo = s.domainLo;
      s.bisectGoodHi = s.domainHi;
    } else {
      s.bisectBadLo = s.domainLo;
      s.bisectBadHi = s.domainHi;
    }
    newLo = r3((s.bisectGoodLo + s.bisectBadLo) / 2);
    newHi = r3((s.bisectGoodHi + s.bisectBadHi) / 2);
    // If rounding made no progress (stuck at bisectGood), use the bad boundary instead
    // so the EPS check can fire at the correct rounded coordinate.
    if (newLo === s.bisectGoodLo && newHi === s.bisectGoodHi) {
      newLo = s.bisectBadLo;
      newHi = s.bisectBadHi;
    }
  }

  s.domainLo = newLo;
  s.domainHi = newHi;

  if (s.domainLo >= s.domainHi - 0.0005) {
    s.domainLo = s.domainHi = r3((s.domainLo + s.domainHi) / 2);
  }

  s.cx    = r3(Math.max(s.domainLo, Math.min(s.domainHi, s.cx)));
  s.cy    = r3(Math.max(s.domainLo, Math.min(s.domainHi, s.cy)));
  s.calcX = r3(Math.max(s.domainLo, Math.min(s.domainHi, s.calcX ?? s.cx)));
  s.calcY = r3(Math.max(s.domainLo, Math.min(s.domainHi, s.calcY ?? s.cy)));
  // Squeeze the strategy-line representative into the contracted corridor so it
  // eases toward the NE coordinate as the bracket closes (gradual flattening).
  s.stratX = r3(Math.max(s.domainLo, Math.min(s.domainHi, s.stratX)));
  s.stratY = r3(Math.max(s.domainLo, Math.min(s.domainHi, s.stratY)));

  // Retroactively snap only the mover's axis in the last recorded path point.
  // The non-mover axis stays at its pre-clamp value so the NEXT step (opposite mover)
  // changes only that axis — keeping the path axis-aligned with no diagonals.
  if (s.pathSegmentsA.length > 0) {
    const lastA = s.pathSegmentsA[s.pathSegmentsA.length - 1];
    const nA = lastA.xs.length - 1;
    if (nA >= 0) {
      if (mover === 'A') lastA.xs[nA] = s.cx;
      else lastA.ys[nA] = s.cy;
      lastA.zs[nA] = r3(EA(lastA.xs[nA], lastA.ys[nA], g));
    }
  }
  if (s.pathSegmentsB.length > 0) {
    const lastB = s.pathSegmentsB[s.pathSegmentsB.length - 1];
    const nB = lastB.xs.length - 1;
    if (nB >= 0) {
      if (mover === 'A') lastB.xs[nB] = s.cx;
      else lastB.ys[nB] = s.cy;
      lastB.zs[nB] = r3(EB(lastB.xs[nB], lastB.ys[nB], g));
    }
  }
}

// ── Phase 2 ghost corridor bisection ─────────────────────────────────────────
// Triggered when hi-lo < 2*step (too narrow for a full step) OR when the
// best-response sign pattern at corridor boundaries changes (overshoot).
function applyGhostBisectCycleStep(s: SimState, g: GamePayoffs, defaultStep: number): void {
  // foundAxis='x': x* found → searching y* → sA(y) = y*(a11-a21)+(1-y)*(a12-a22)
  // foundAxis='y': y* found → searching x* → sB(x) = x*(b11-b12)+(1-x)*(b21-b22)
  const fn = s.foundAxis === 'x'
    ? (v: number) => v * (g.a11 - g.a21) + (1 - v) * (g.a12 - g.a22)
    : (v: number) => v * (g.b11 - g.b12) + (1 - v) * (g.b21 - g.b22);

  const pat = { aHi: fn(s.domainHi), aLo: fn(s.domainLo) };
  // Always capture the first-cycle pattern so overshoot detection has a baseline
  // even when tooNarrow fires immediately (large step sizes).
  if (s.ghostCyclePattern === null) s.ghostCyclePattern = pat;
  const EPS_PAT = 1e-4;
  const patternOK = (
    !(Math.abs(pat.aHi) > EPS_PAT && Math.sign(pat.aHi) !== Math.sign(s.ghostCyclePattern.aHi)) &&
    !(Math.abs(pat.aLo) > EPS_PAT && Math.sign(pat.aLo) !== Math.sign(s.ghostCyclePattern.aLo))
  );
  const tooNarrow = (s.domainHi - s.domainLo) < 2 * defaultStep;

  let newLo: number;
  let newHi: number;

  if (!s.ghostBisecting) {
    if (patternOK && !tooNarrow) {
      // Forward: record reference pattern, update good bounds, shrink normally.
      s.ghostCyclePattern = pat;
      s.ghostBisectGoodLo = s.domainLo;
      s.ghostBisectGoodHi = s.domainHi;
      newLo = r3(s.domainLo + defaultStep);
      newHi = r3(s.domainHi - defaultStep);
    } else {
      s.ghostBisecting = true;
      if (!patternOK) {
        // Overshoot: current domain is bad; good was stored in last forward step.
        s.ghostBisectBadLo = s.domainLo;
        s.ghostBisectBadHi = s.domainHi;
      } else {
        // tooNarrow: current domain is good; a full step would be bad.
        s.ghostBisectGoodLo = s.domainLo;
        s.ghostBisectGoodHi = s.domainHi;
        s.ghostBisectBadLo = r3(s.domainLo + defaultStep);
        s.ghostBisectBadHi = r3(s.domainHi - defaultStep);
      }
      newLo = r3((s.ghostBisectGoodLo + s.ghostBisectBadLo) / 2);
      newHi = r3((s.ghostBisectGoodHi + s.ghostBisectBadHi) / 2);
    }
  } else {
    if (patternOK) {
      s.ghostBisectGoodLo = s.domainLo;
      s.ghostBisectGoodHi = s.domainHi;
    } else {
      s.ghostBisectBadLo = s.domainLo;
      s.ghostBisectBadHi = s.domainHi;
    }
    newLo = r3((s.ghostBisectGoodLo + s.ghostBisectBadLo) / 2);
    newHi = r3((s.ghostBisectGoodHi + s.ghostBisectBadHi) / 2);
  }

  s.domainLo = newLo;
  s.domainHi = newHi;

  if (s.domainLo >= s.domainHi - 0.0005) {
    s.domainLo = s.domainHi = r3((s.domainLo + s.domainHi) / 2);
  }

  s.calcX = r3(Math.max(s.domainLo, Math.min(s.domainHi, s.calcX ?? s.cx)));
  s.calcY = r3(Math.max(s.domainLo, Math.min(s.domainHi, s.calcY ?? s.cy)));
  // Squeeze the strategy-line representative into the contracted corridor.
  s.stratX = r3(Math.max(s.domainLo, Math.min(s.domainHi, s.stratX)));
  s.stratY = r3(Math.max(s.domainLo, Math.min(s.domainHi, s.stratY)));
}

// ── Algorithm control parameters ─────────────────────────────────────────────
export function pickShrinkStep(
  lo: number, 
  hi: number, 
  mixedNE: NashEquilibrium | undefined, 
  defaultStep: number,
  foundAxis: 'x' | 'y' | null = null
): number {
  if (!mixedNE) return 0.001;
  
  let dists: number[] = [];
  if (foundAxis === 'x') {
    // x is found, so we are searching for y. Check only distance of lo and hi to y*
    dists = [
      Math.abs(lo - mixedNE.y),
      Math.abs(hi - mixedNE.y),
    ];
  } else if (foundAxis === 'y') {
    // y is found, so we are searching for x. Check only distance of lo and hi to x*
    dists = [
      Math.abs(lo - mixedNE.x),
      Math.abs(hi - mixedNE.x),
    ];
  } else {
    // Both/neither found
    dists = [
      Math.abs(lo - mixedNE.x), Math.abs(hi - mixedNE.x),
      Math.abs(lo - mixedNE.y), Math.abs(hi - mixedNE.y),
    ];
  }
  
  const minDist = Math.min(...dists);
  if (minDist <= 0.01) return 0.001;
  if (minDist <= defaultStep) return 0.01;
  return defaultStep;
}

// ── Helper to append points into paths ────────────────────────────────────────
export function pushToSegs(
  state: SimState,
  x: number,
  y: number,
  zA: number,
  zB: number,
  mover: 'A' | 'B'
) {
  if (state.pathSegmentsA.length === 0 || state.pathSegmentsA[state.pathSegmentsA.length - 1].mover !== mover) {
    const prevSeg = state.pathSegmentsA[state.pathSegmentsA.length - 1];
    const nsA: PathSegment = { xs: [], ys: [], zs: [], mover };
    if (prevSeg && prevSeg.xs.length > 0) {
      const n = prevSeg.xs.length - 1;
      nsA.xs.push(prevSeg.xs[n]);
      nsA.ys.push(prevSeg.ys[n]);
      nsA.zs.push(prevSeg.zs[n]);
    } else {
      nsA.xs.push(x);
      nsA.ys.push(y);
      nsA.zs.push(zA);
    }
    state.pathSegmentsA.push(nsA);
  }
  const currSegA = state.pathSegmentsA[state.pathSegmentsA.length - 1];
  currSegA.xs.push(x);
  currSegA.ys.push(y);
  currSegA.zs.push(zA);

  if (state.pathSegmentsB.length === 0 || state.pathSegmentsB[state.pathSegmentsB.length - 1].mover !== mover) {
    const prevSeg = state.pathSegmentsB[state.pathSegmentsB.length - 1];
    const nsB: PathSegment = { xs: [], ys: [], zs: [], mover };
    if (prevSeg && prevSeg.xs.length > 0) {
      const n = prevSeg.xs.length - 1;
      nsB.xs.push(prevSeg.xs[n]);
      nsB.ys.push(prevSeg.ys[n]);
      nsB.zs.push(prevSeg.zs[n]);
    } else {
      nsB.xs.push(x);
      nsB.ys.push(y);
      nsB.zs.push(zB);
    }
    state.pathSegmentsB.push(nsB);
  }
  const currSegB = state.pathSegmentsB[state.pathSegmentsB.length - 1];
  currSegB.xs.push(x);
  currSegB.ys.push(y);
  currSegB.zs.push(zB);
}

// ── Correct Ghost steps in Phase 2 ───────────────────────────────────────────
// Updates exactly ONE axis depending on who moves:
// - If foundAxis === 'x': y is unfound axis (controlled by B).
//   - When B moves: B flips y to the opposite corridor boundary (lo <-> hi).
//   - When A moves: A best-responds with x to the current y boundary.
// - If foundAxis === 'y': x is unfound axis (controlled by A).
//   - When A moves: A flips x to the opposite corridor boundary (lo <-> hi).
//   - When B moves: B best-responds with y to the current x boundary.
export function ghostStep(g: GamePayoffs, state: SimState, mover: 'A' | 'B') {
  const lo = state.domainLo;
  const hi = state.domainHi;

  const Dx = g.b11 - g.b12 - g.b21 + g.b22;
  const Dy = g.a11 - g.a12 - g.a21 + g.a22;
  const EPS_B = Math.abs(Dx) > 1e-9 ? Math.abs(Dx) * 0.00065 : 0.00065;
  const EPS_A = Math.abs(Dy) > 1e-9 ? Math.abs(Dy) * 0.00065 : 0.00065;

  let newX = state.calcX ?? state.cx;
  let newY = state.calcY ?? state.cy;

  if (state.foundAxis === 'x') {
    // y is unfound axis. Player B controls y, Player A controls x.
    if (mover === 'B') {
      // Flip y mechanically to opposite corridor boundary
      newY = (Math.abs(newY - lo) < Math.abs(newY - hi)) ? hi : lo;

      // Check discovery of y*: does newY make Player A indifferent?
      const sAcheck = newY * (g.a11 - g.a21) + (1 - newY) * (g.a12 - g.a22);
      if (Math.abs(sAcheck) < EPS_A && state.discoveredMixedY === null) {
        state.discoveredMixedY = r3(newY);
      }
    } else {
      // Player A moves and reacts on x-axis by best-responding to current y
      const sA = newY * (g.a11 - g.a21) + (1 - newY) * (g.a12 - g.a22);
      newX = sA > 1e-9 ? hi : (sA < -1e-9 ? lo : newX);
    }
  } else {
    // x is unfound axis. Player A controls x, Player B controls y.
    if (mover === 'A') {
      // Flip x mechanically to opposite corridor boundary
      newX = (Math.abs(newX - lo) < Math.abs(newX - hi)) ? hi : lo;

      // Check discovery of x*: does newX make Player B indifferent?
      const sBcheck = newX * (g.b11 - g.b12) + (1 - newX) * (g.b21 - g.b22);
      if (Math.abs(sBcheck) < EPS_B && state.discoveredMixedX === null) {
        state.discoveredMixedX = r3(newX);
      }
    } else {
      // Player B moves and reacts on y-axis by best-responding to current x
      const sB = newX * (g.b11 - g.b12) + (1 - newX) * (g.b21 - g.b22);
      newY = sB > 1e-9 ? hi : (sB < -1e-9 ? lo : newY);
    }
  }

  state.calcX = r3(newX);
  state.calcY = r3(newY);
}

// ── Snapshot creator ─────────────────────────────────────────────────────────
export function createSnapshot(s: SimState): Omit<SimState, 'running' | 'historyStack'> {
  const segCloneA = s.pathSegmentsA.map(seg => ({ xs: seg.xs.slice(), ys: seg.ys.slice(), zs: seg.zs.slice(), mover: seg.mover }));
  const segCloneB = s.pathSegmentsB.map(seg => ({ xs: seg.xs.slice(), ys: seg.ys.slice(), zs: seg.zs.slice(), mover: seg.mover }));
  const ghostSegCloneA = s.ghostPathSegmentsA.map(seg => ({ xs: seg.xs.slice(), ys: seg.ys.slice(), zs: seg.zs.slice(), mover: seg.mover }));
  const ghostSegCloneB = s.ghostPathSegmentsB.map(seg => ({ xs: seg.xs.slice(), ys: seg.ys.slice(), zs: seg.zs.slice(), mover: seg.mover }));
  return {
    cx: s.cx,
    cy: s.cy,
    calcX: s.calcX,
    calcY: s.calcY,
    displayX: s.displayX,
    displayY: s.displayY,
    startX: s.startX,
    startY: s.startY,
    domainLo: s.domainLo,
    domainHi: s.domainHi,
    domXLo: s.domXLo,
    domXHi: s.domXHi,
    domYLo: s.domYLo,
    domYHi: s.domYHi,
    stratX: s.stratX,
    stratY: s.stratY,
    cycleCount: s.cycleCount,
    visitedPositions: s.visitedPositions.slice(),
    ghostVisitedPositions: s.ghostVisitedPositions.slice(),
    discoveredMixedX: s.discoveredMixedX,
    discoveredMixedY: s.discoveredMixedY,
    foundAxis: s.foundAxis,
    converged: s.converged,
    stepCount: s.stepCount,
    pathSegmentsA: segCloneA,
    pathSegmentsB: segCloneB,
    phase1PtsA: s.phase1PtsA,
    phase1PtsB: s.phase1PtsB,
    ghostPathSegmentsA: ghostSegCloneA,
    ghostPathSegmentsB: ghostSegCloneB,
    cyclePattern: s.cyclePattern ? { ...s.cyclePattern } : null,
    bisecting: s.bisecting,
    bisectGoodLo: s.bisectGoodLo,
    bisectGoodHi: s.bisectGoodHi,
    bisectBadLo: s.bisectBadLo,
    bisectBadHi: s.bisectBadHi,
    ghostCyclePattern: s.ghostCyclePattern ? { ...s.ghostCyclePattern } : null,
    ghostBisecting: s.ghostBisecting,
    ghostBisectGoodLo: s.ghostBisectGoodLo,
    ghostBisectGoodHi: s.ghostBisectGoodHi,
    ghostBisectBadLo: s.ghostBisectBadLo,
    ghostBisectBadHi: s.ghostBisectBadHi,
  };
}

// ── Step logic ───────────────────────────────────────────────────────────────
export function doStep(
  g: GamePayoffs,
  s: SimState,
  firstMover: 'A' | 'B',
  defaultShrinkStep: number,
  allNE: NashEquilibrium[],
  committedNE: NashEquilibrium | null,
  addLog: (msg: string) => void,
  onCycleDetected: () => void,
  onConverged: () => void,
  stepMode: 'shrink' | 'regret' = 'shrink'
) {
  if (s.converged) return;

  // Save historical snapshot
  s.historyStack.push(createSnapshot(s));

  const pureNEs = allNE.filter(n => n.type === 'pure');
  const mixedNE = allNE.find(n => n.type === 'mixed');
  const mover: 'A' | 'B' = (s.stepCount % 2 === 0) ? firstMover : (firstMover === 'A' ? 'B' : 'A');
  s.stepCount++;

  let nx = s.cx;
  let ny = s.cy;

  if (pureNEs.length > 1 && committedNE) {
    if (mover === firstMover) {
      // The first mover commits to its own preferred pure NE coordinate,
      // forcing the other player to best-respond into that equilibrium.
      if (mover === 'A') nx = committedNE.x;
      else ny = committedNE.y;
    } else if (mover === 'A') {
      // Follower A best-responds to the current y.
      const valRow1 = s.cy * g.a11 + (1 - s.cy) * g.a12;
      const valRow2 = s.cy * g.a21 + (1 - s.cy) * g.a22;
      nx = valRow1 >= valRow2 ? 1 : 0;
    } else {
      // Follower B best-responds to the current x.
      const valCol1 = s.cx * g.b11 + (1 - s.cx) * g.b21;
      const valCol2 = s.cx * g.b12 + (1 - s.cx) * g.b22;
      ny = valCol1 >= valCol2 ? 1 : 0;
    }
  } else if (pureNEs.length >= 1) {
    if (mover === 'A') {
      const sY = s.calcY ?? s.cy;
      const sA = sY * (g.a11 - g.a21) + (1 - sY) * (g.a12 - g.a22);
      if (sA > 1e-9) nx = s.domainHi;
      else if (sA < -1e-9) nx = s.domainLo;
      else if (mixedNE) nx = Math.max(s.domainLo, Math.min(s.domainHi, mixedNE.x));
    } else {
      const sX = s.calcX ?? s.cx;
      const sB = sX * (g.b11 - g.b12) + (1 - sX) * (g.b21 - g.b22);
      if (sB > 1e-9) ny = s.domainHi;
      else if (sB < -1e-9) ny = s.domainLo;
      else if (mixedNE) ny = Math.max(s.domainLo, Math.min(s.domainHi, mixedNE.y));
    }
  } else {
    // ── Mixed NE only: Domain shrinking dynamics ────────────────────────────
    const Dx = g.b11 - g.b12 - g.b21 + g.b22;
    const Dy = g.a11 - g.a12 - g.a21 + g.a22;
    const EPS_B = Math.abs(Dx) > 1e-9 ? Math.abs(Dx) * 0.00065 : 0.00065;
    const EPS_A = Math.abs(Dy) > 1e-9 ? Math.abs(Dy) * 0.00065 : 0.00065;

    const regretEligible = stepMode === 'regret' && mixedNE !== undefined
      && Math.abs(Dx) > 1e-9 && Math.abs(Dy) > 1e-9;

    if (regretEligible) {
      // ── Two-domain regret contraction ─────────────────────────────────────
      // Each player keeps their OWN domain, contracted toward their OWN NE
      // coordinate every cycle by a fraction λ of the remaining distance. Because
      // the opponent's regret is proportional to that distance, this is exactly
      // "step ∝ opponent's regret × weight": the midpoints (stratX, stratY) glide
      // independently and decelerate, so each strategy line eases flat gradually
      // instead of snapping. Best-response corner cycling is retained for the
      // sphere; its amplitude shrinks with the domains.
      const xStar = mixedNE!.x;
      const yStar = mixedNE!.y;
      const lambda = Math.max(0.001, Math.min(0.95, defaultShrinkStep));
      const glide = (b: number, r: number): number => {
        if (Math.abs(b - r) < 1e-9) return r;
        let step = lambda * (r - b);
        // Floor to one display-grid unit toward the root so 3-dp rounding can't
        // freeze the glide a hair short; clamp so it never overshoots.
        if (Math.abs(step) < 0.001) step = Math.sign(r - b) * 0.001;
        let nb = b + step;
        if ((r - b) * (r - nb) < 0) nb = r;
        return r3(Math.max(0, Math.min(1, nb)));
      };

      // Best-response cycling: each mover flips its OWN axis to a domain corner in
      // response to the opponent's CURRENT corner (s.cx / s.cy), so the path rotates
      // around the box perimeter exactly like shrink mode. (Using the midpoint here
      // would freeze it at one corner — no rotation.)
      if (mover === 'A') {
        const sA = s.cy * (g.a11 - g.a21) + (1 - s.cy) * (g.a12 - g.a22);
        nx = sA > 0 ? s.domXHi : s.domXLo;
        ny = s.cy;
      } else {
        const sB = s.cx * (g.b11 - g.b12) + (1 - s.cx) * (g.b21 - g.b22);
        ny = sB > 0 ? s.domYHi : s.domYLo;
        nx = s.cx;
      }
      s.calcX = r3(nx);
      s.calcY = r3(ny);

      // One contraction per full perimeter loop. Each domain shrinks toward its own
      // NE coordinate by a regret-proportional amount (the geometric step λ·(root−b)
      // is proportional to that player's distance from indifference, i.e. the
      // opponent's regret). The midpoint (hi+lo)/2 — where the strategy line is
      // drawn — glides smoothly to the NE coordinate, flattening one cycle at a time.
      const rkey = r3(nx).toFixed(3) + ',' + r3(ny).toFixed(3);
      if (s.visitedPositions.includes(rkey)) {
        s.cycleCount++;
        s.visitedPositions = [];
        s.domXLo = glide(s.domXLo, xStar); s.domXHi = glide(s.domXHi, xStar);
        s.domYLo = glide(s.domYLo, yStar); s.domYHi = glide(s.domYHi, yStar);
        s.stratX = r3((s.domXLo + s.domXHi) / 2);
        s.stratY = r3((s.domYLo + s.domYHi) / 2);
        // Snap each domain onto its root once it has collapsed (its line sits flat).
        const xDone = Math.abs(s.domXHi - s.domXLo) < 0.0015;
        const yDone = Math.abs(s.domYHi - s.domYLo) < 0.0015;
        if (xDone) { s.domXLo = xStar; s.domXHi = xStar; s.stratX = xStar; }
        if (yDone) { s.domYLo = yStar; s.domYHi = yStar; s.stratY = yStar; }
        // Declare BOTH coordinates together (parallel convergence). Setting them
        // atomically avoids a transient "exactly one found" state, which would
        // otherwise flash the Search-corridor box / ghost for a few end steps.
        if (xDone && yDone && s.discoveredMixedX === null) {
          s.discoveredMixedX = xStar;
          s.discoveredMixedY = yStar;
          addLog('✓ x-coordinate discovered: ' + xStar.toFixed(3));
          addLog('✓ y-coordinate discovered: ' + yStar.toFixed(3));
        }
        addLog(`↺ Cycle ${s.cycleCount} → A∈[${r3(s.domXLo).toFixed(3)},${r3(s.domXHi).toFixed(3)}] B∈[${r3(s.domYLo).toFixed(3)},${r3(s.domYHi).toFixed(3)}] (λ=${r3(lambda)})`);
        onCycleDetected();
      } else {
        s.visitedPositions.push(rkey);
      }
    } else {

    const inPhase2 = (s.discoveredMixedX !== null) !== (s.discoveredMixedY !== null);

    if (!inPhase2) {
      // ── Phase 1: standard best-response cycling ───────────────────────────
      nx = s.calcX ?? s.cx;
      ny = s.calcY ?? s.cy;
      if (mover === 'A') {
        const sA3 = ny * (g.a11 - g.a21) + (1 - ny) * (g.a12 - g.a22);
        nx = sA3 > 0 ? s.domainHi : s.domainLo;
        const sB3 = nx * (g.b11 - g.b12) + (1 - nx) * (g.b21 - g.b22);
        if (Math.abs(sB3) < EPS_B && s.discoveredMixedX === null) {
          s.discoveredMixedX = r3(nx);
          addLog('✓ x-coordinate discovered: ' + s.discoveredMixedX.toFixed(3));
        }
      } else {
        const sB3 = nx * (g.b11 - g.b12) + (1 - nx) * (g.b21 - g.b22);
        ny = sB3 > 0 ? s.domainHi : s.domainLo;
        const sA3 = ny * (g.a11 - g.a21) + (1 - ny) * (g.a12 - g.a22);
        if (Math.abs(sA3) < EPS_A && s.discoveredMixedY === null) {
          s.discoveredMixedY = r3(ny);
          addLog('✓ y-coordinate discovered: ' + s.discoveredMixedY.toFixed(3));
        }
      }
      s.calcX = r3(nx);
      s.calcY = r3(ny);
    } else {
      // ── Phase 2: ghost cycles freely; large sphere inches along unfound axis ─
      if (s.foundAxis === null) {
        s.foundAxis = s.discoveredMixedX !== null ? 'x' : 'y';
        s.phase1PtsA = s.pathSegmentsA.reduce((n, seg) => n + seg.xs.length, 0);
        s.phase1PtsB = s.pathSegmentsB.reduce((n, seg) => n + seg.xs.length, 0);
        // Use the Phase 1 domain as the starting corridor if it brackets the
        // second NE coordinate (opposite signs of the indifference function at
        // lo and hi). If Phase 1 collapsed the domain with a large step and the
        // bracket is lost, fall back to [0, 1].
        const _axis = s.discoveredMixedX !== null ? 'x' : 'y';
        const _fn = _axis === 'x'
          ? (v: number) => v * (g.a11 - g.a21) + (1 - v) * (g.a12 - g.a22)
          : (v: number) => v * (g.b11 - g.b12) + (1 - v) * (g.b21 - g.b22);
        if (_fn(s.domainLo) * _fn(s.domainHi) >= 0) {
          s.domainLo = 0;
          s.domainHi = 1;
        }
        s.calcX = s.domainHi;
        s.calcY = s.domainHi;
        s.ghostVisitedPositions = [];
        s.ghostPathSegmentsA = [];
        s.ghostPathSegmentsB = [];
        s.ghostCyclePattern = null;
        s.ghostBisecting = false;
        s.ghostBisectGoodLo = s.domainLo;
        s.ghostBisectGoodHi = s.domainHi;
        s.ghostBisectBadLo = 0;
        s.ghostBisectBadHi = 1;
        addLog(`Phase 2: ${s.foundAxis}* locked, searching ${s.foundAxis === 'x' ? 'y' : 'x'}*`);
      }

      const prevGX = s.calcX!;
      const prevGY = s.calcY!;

      // Run ghost step (flips unfound axis, checks discovery)
      ghostStep(g, s, mover);

      const nextGX = s.calcX!;
      const nextGY = s.calcY!;

      // Find the mover of this ghost step based on which coordinate changed
      const isAMove = Math.abs(prevGX - nextGX) > 1e-7;
      const isBMove = Math.abs(prevGY - nextGY) > 1e-7;
      if (isAMove || isBMove) {
        const ghMover = isAMove ? 'A' : 'B';
        const ea1 = r3(EA(prevGX, prevGY, g));
        const ea2 = r3(EA(nextGX, nextGY, g));
        const eb1 = r3(EB(prevGX, prevGY, g));
        const eb2 = r3(EB(nextGX, nextGY, g));

        s.ghostPathSegmentsA.push({
          xs: [prevGX, nextGX],
          ys: [prevGY, nextGY],
          zs: [ea1, ea2],
          mover: ghMover
        });
        s.ghostPathSegmentsB.push({
          xs: [prevGX, nextGX],
          ys: [prevGY, nextGY],
          zs: [eb1, eb2],
          mover: ghMover
        });
      }

      if (s.discoveredMixedY !== null && s.foundAxis === 'x') {
        addLog('✓ y-coordinate discovered: ' + s.discoveredMixedY.toFixed(3));
      }
      if (s.discoveredMixedX !== null && s.foundAxis === 'y') {
        addLog('✓ x-coordinate discovered: ' + s.discoveredMixedX.toFixed(3));
      }

      // Large sphere: locked coord stays fixed; unfound coord snaps visually
      // to nearest corridor boundary to showcase shrinking progress.
      const currentDisplayX = s.displayX ?? s.cx;
      const currentDisplayY = s.displayY ?? s.cy;
      if (s.foundAxis === 'x') {
        nx = s.discoveredMixedX!;
        ny = (Math.abs(currentDisplayY - s.domainLo) <= Math.abs(currentDisplayY - s.domainHi))
          ? s.domainLo : s.domainHi;
      } else {
        ny = s.discoveredMixedY!;
        nx = (Math.abs(currentDisplayX - s.domainLo) <= Math.abs(currentDisplayX - s.domainHi))
          ? s.domainLo : s.domainHi;
      }

      // Ghost cycle detection: checks coordinates (calcX, calcY)
      const ghostKey = s.calcX!.toFixed(3) + ',' + s.calcY!.toFixed(3);
      if (s.ghostVisitedPositions.includes(ghostKey)) {
        s.cycleCount++;
        s.ghostVisitedPositions = [];

        applyGhostBisectCycleStep(s, g, defaultShrinkStep);

        // Snap large sphere's visual position to the updated boundaries
        if (s.foundAxis === 'x') {
          nx = s.discoveredMixedX!;
          ny = (Math.abs(ny - s.domainLo) <= Math.abs(ny - s.domainHi))
            ? s.domainLo : s.domainHi;
        } else {
          ny = s.discoveredMixedY!;
          nx = (Math.abs(nx - s.domainLo) <= Math.abs(nx - s.domainHi))
            ? s.domainLo : s.domainHi;
        }

        const searchMover = s.foundAxis === 'x' ? 'B' : 'A';
        addLog(`↺ Ghost cycle ${s.cycleCount} (${searchMover}) → corridor [${r3(s.domainLo).toFixed(3)},${r3(s.domainHi).toFixed(3)}]${s.ghostBisecting ? ' [bisecting]' : ` (step=${defaultShrinkStep})`}`);
        onCycleDetected();
      } else {
        s.ghostVisitedPositions.push(ghostKey);
      }
    }
    } // end shrink/bisection branch (non-regret)
  }

  // ── Update display position ──────────────────────────────────────────────
  s.displayX = s.discoveredMixedX !== null ? s.discoveredMixedX : r3(nx);
  s.displayY = s.discoveredMixedY !== null ? s.discoveredMixedY : r3(ny);
  s.cx = s.displayX;
  s.cy = s.displayY;

  const eA = r3(EA(s.cx, s.cy, g));
  const eB = r3(EB(s.cx, s.cy, g));
  pushToSegs(s, s.displayX, s.displayY, eA, eB, mover);

  const domStr = (s.domainLo > 0.0005 || s.domainHi < 0.9995)
    ? ' [' + r3(s.domainLo).toFixed(3) + ',' + r3(s.domainHi).toFixed(3) + ']' : '';
  addLog(`Step ${s.stepCount} (${mover})${domStr}: x=${s.cx.toFixed(3)}, y=${s.cy.toFixed(3)}  E[A]=${eA.toFixed(3)}  E[B]=${eB.toFixed(3)}`);

  // Check convergence conditions
  if (pureNEs.length > 0) {
    const prev = s.historyStack[s.historyStack.length - 1];
    const dx = Math.abs(s.cx - (prev ? prev.cx : s.cx));
    const dy = Math.abs(s.cy - (prev ? prev.cy : s.cy));
    if (dx < 0.0003 && dy < 0.0003) {
      s.converged = true;
      const finalEA = r3(EA(s.cx, s.cy, g));
      const finalEB = r3(EB(s.cx, s.cy, g));
      addLog(`━━ Pure NE: x=${s.cx.toFixed(3)}, y=${s.cy.toFixed(3)}  E[A]=${finalEA.toFixed(3)}  E[B]=${finalEB.toFixed(3)}`);
      onConverged();
      return;
    }
  } else {
    if (s.discoveredMixedX !== null && s.discoveredMixedY !== null) {
      s.cx = s.discoveredMixedX;
      s.cy = s.discoveredMixedY;
      s.displayX = s.cx;
      s.displayY = s.cy;
      s.converged = true;
      const finalEA = r3(EA(s.cx, s.cy, g));
      const finalEB = r3(EB(s.cx, s.cy, g));
      addLog(`━━ Mixed NE: x=${s.cx.toFixed(3)}, y=${s.cy.toFixed(3)}  E[A]=${finalEA.toFixed(3)}  E[B]=${finalEB.toFixed(3)}`);
      onConverged();
      return;
    }
  }

  // ── Phase 1 cycle detection ────────────────────────────────────────────────
  // Regret mode handles its own per-cycle contraction inline above, so skip the
  // shared-corridor cycle detection here.
  const inPhase2Now = (s.discoveredMixedX !== null) !== (s.discoveredMixedY !== null);
  if (pureNEs.length === 0 && !inPhase2Now && stepMode !== 'regret') {
    const posKey = s.cx.toFixed(3) + ',' + s.cy.toFixed(3);
    if (s.visitedPositions.includes(posKey)) {
      s.cycleCount++;
      s.visitedPositions = [];
      applyBisectCycleStep(s, g, defaultShrinkStep, mover);
      addLog(`↺ Cycle ${s.cycleCount} → domain [${r3(s.domainLo).toFixed(3)},${r3(s.domainHi).toFixed(3)}]${s.bisecting ? ' [bisecting]' : ` (step=${defaultShrinkStep})`}`);
      onCycleDetected();
      return;
    }
    s.visitedPositions.push(posKey);
  }

  // ── Pure NE cycle detection ────────────────────────────────────────────────
  if (pureNEs.length > 0) {
    const posKey = s.cx.toFixed(3) + ',' + s.cy.toFixed(3);
    if (s.visitedPositions.includes(posKey)) {
      s.cycleCount++;
      s.visitedPositions = [];
      applyBisectCycleStep(s, g, defaultShrinkStep, mover);
      s.cx = s.discoveredMixedX !== null ? s.discoveredMixedX : r3(Math.max(s.domainLo, Math.min(s.domainHi, s.cx)));
      s.cy = s.discoveredMixedY !== null ? s.discoveredMixedY : r3(Math.max(s.domainLo, Math.min(s.domainHi, s.cy)));
      addLog(`↺ Cycle ${s.cycleCount} → domain [${r3(s.domainLo).toFixed(3)},${r3(s.domainHi).toFixed(3)}]${s.bisecting ? ' [bisecting]' : ` (step=${defaultShrinkStep})`}`);
      onCycleDetected();
      return;
    }
    s.visitedPositions.push(posKey);
  }
}
