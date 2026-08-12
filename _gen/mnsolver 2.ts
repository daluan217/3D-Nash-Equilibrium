/**
 * m x n bimatrix Nash solver — VENDORED, do not edit in place.
 *
 * Provenance: copied verbatim from ~/Desktop/mn-nash-probe/solver.ts (2026-08-10)
 * so the eval harness is self-contained and committable rather than importing
 * across a directory boundary that is not part of this repo.
 *
 * The copy is VALIDATED, not assumed: _gen/mnsolver.selftest.ts cross-checks it
 * against the shipped, fuzz-tested computeAllNE on 4000 random 2x2 games and
 * verifies Rock-Paper-Scissors has the unique (1/3,1/3,1/3) equilibrium. Run it
 * before trusting any m x n result.
 *
 * Why a second solver exists at all: src/utils/gameEngine.ts is 2x2 only, and
 * 2x2's closed form does not generalise. Ground truth has to be computed before
 * any model claim can be graded.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export interface MNGame {
  /** Row player payoffs, A[i][j]. */
  A: number[][];
  /** Column player payoffs, B[i][j]. */
  B: number[][];
}

export interface MNEquilibrium {
  /** Row player's mixed strategy, length m. */
  x: number[];
  /** Column player's mixed strategy, length n. */
  y: number[];
  /** Indices with positive probability. */
  supportX: number[];
  supportY: number[];
  type: 'pure' | 'mixed';
  eA: number;
  eB: number;
}

const EPS = 1e-9;
export const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Solves M z = b by Gaussian elimination with partial pivoting. null if singular. */
function solve(M: number[][], b: number[]): number[] | null {
  const k = b.length;
  const a = M.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) < EPS) return null;
    [a[col], a[piv]] = [a[piv], a[col]];
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      for (let c = col; c <= k; c++) a[r][c] -= f * a[col][c];
    }
  }
  return a.map((row, i) => row[k] / a[i][i]);
}

function subsets(n: number): number[][] {
  const out: number[][] = [];
  for (let mask = 1; mask < 1 << n; mask++) {
    const s: number[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) s.push(i);
    out.push(s);
  }
  return out;
}

/** Expected payoff of the row player under (x, y). */
export function payoffA(g: MNGame, x: number[], y: number[]): number {
  let v = 0;
  for (let i = 0; i < x.length; i++) for (let j = 0; j < y.length; j++) v += x[i] * y[j] * g.A[i][j];
  return v;
}
export function payoffB(g: MNGame, x: number[], y: number[]): number {
  let v = 0;
  for (let i = 0; i < x.length; i++) for (let j = 0; j < y.length; j++) v += x[i] * y[j] * g.B[i][j];
  return v;
}

/**
 * INDEPENDENT ORACLE — shares no code with enumerateNE. A profile is an
 * equilibrium iff both regrets are ~0. Same two-key design as the 2x2 project.
 */
export function regretA(g: MNGame, x: number[], y: number[]): number {
  const rows = g.A.map((row) => row.reduce((s, v, j) => s + v * y[j], 0));
  return Math.max(...rows) - payoffA(g, x, y);
}
export function regretB(g: MNGame, x: number[], y: number[]): number {
  const n = g.B[0].length;
  const cols: number[] = [];
  for (let j = 0; j < n; j++) cols.push(g.B.reduce((s, row, i) => s + row[j] * x[i], 0));
  return Math.max(...cols) - payoffB(g, x, y);
}

export function enumerateNE(g: MNGame, tol = 1e-7): MNEquilibrium[] {
  const m = g.A.length;
  const n = g.A[0].length;
  const found: MNEquilibrium[] = [];

  for (const S1 of subsets(m)) {
    for (const S2 of subsets(n)) {
      if (S1.length !== S2.length) continue;
      const k = S1.length;

      // y makes the row player indifferent across S1; x makes the column
      // player indifferent across S2. Each is (k-1) indifference equations
      // plus one normalisation.
      const My: number[][] = [];
      const by: number[] = [];
      for (let t = 1; t < k; t++) {
        My.push(S2.map((j) => g.A[S1[0]][j] - g.A[S1[t]][j]));
        by.push(0);
      }
      My.push(S2.map(() => 1));
      by.push(1);
      const ys = solve(My, by);
      if (!ys) continue;

      const Mx: number[][] = [];
      const bx: number[] = [];
      for (let t = 1; t < k; t++) {
        Mx.push(S1.map((i) => g.B[i][S2[0]] - g.B[i][S2[t]]));
        bx.push(0);
      }
      Mx.push(S1.map(() => 1));
      bx.push(1);
      const xs = solve(Mx, bx);
      if (!xs) continue;

      if (xs.some((v) => v < -tol) || ys.some((v) => v < -tol)) continue;
      // Strictly positive on the support, else this is really a smaller support
      // and will be found (once) by that smaller pair instead.
      if (xs.some((v) => v <= tol) || ys.some((v) => v <= tol)) continue;

      const x = Array(m).fill(0);
      S1.forEach((i, t) => (x[i] = xs[t]));
      const y = Array(n).fill(0);
      S2.forEach((j, t) => (y[j] = ys[t]));

      // Verify: no profitable deviation to any action outside the support.
      if (regretA(g, x, y) > 1e-6 || regretB(g, x, y) > 1e-6) continue;

      const eq: MNEquilibrium = {
        x: x.map(r6),
        y: y.map(r6),
        supportX: S1,
        supportY: S2,
        type: k === 1 ? 'pure' : 'mixed',
        eA: r6(payoffA(g, x, y)),
        eB: r6(payoffB(g, x, y)),
      };
      const dup = found.some(
        (f) => f.x.every((v, i) => Math.abs(v - eq.x[i]) < 1e-5) && f.y.every((v, j) => Math.abs(v - eq.y[j]) < 1e-5),
      );
      if (!dup) found.push(eq);
    }
  }
  return found;
}
