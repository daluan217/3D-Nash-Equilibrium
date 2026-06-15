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
