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

  ghostPathSegmentsA: PathSegment[];
  ghostPathSegmentsB: PathSegment[];

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
