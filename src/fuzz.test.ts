/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Property-based / fuzz harness for the Nash simulation.
 *
 * Goal: confirm the simulation "always functions as intended" — correct outputs
 * (the solver and the converged sim point are genuine Nash equilibria), correct
 * visuals (surface/trace builders emit only finite geometry), and no bugs
 * (no NaN/Infinity, no non-termination, no throws) across the whole legal input
 * space, not just the five named presets.
 *
 * Independent correctness oracle
 * ------------------------------
 * A profile (x,y) with x=P(A plays Row1), y=P(B plays Col1) is a Nash
 * equilibrium iff NEITHER player has positive regret:
 *   regret_A(x,y) = max(rA1,rA2) - (x*rA1 + (1-x)*rA2)
 *   regret_B(x,y) = max(rB1,rB2) - (y*rB1 + (1-y)*rB2)
 * where rA1=y*a11+(1-y)*a12, rA2=y*a21+(1-y)*a22 (A's row payoffs vs y) and
 * rB1=x*b11+(1-x)*b21, rB2=x*b12+(1-x)*b22 (B's col payoffs vs x).
 * This is computed straight from the payoff matrix and shares no code with
 * computeAllNE / doStep, so it is a true oracle for both.
 */

import { GamePayoffs, SimState, NashEquilibrium, PathSegment } from './types';
import { doStep, PRESETS, computeAllNE, EA, EB, r3, regretA, regretB } from './utils/gameEngine';
import { buildSurfaces, makeTraces } from './utils/plotting';

// ── Oracle ────────────────────────────────────────────────────────────────────
// regretA/regretB now live in gameEngine.ts (promoted from here) so the report
// validator can share them. They still share no code with computeAllNE, so the
// oracle stays independent — see the INVARIANT note in gameEngine.ts.
function isNE(x: number, y: number, g: GamePayoffs, tol: number): boolean {
  return regretA(x, y, g) <= tol && regretB(x, y, g) <= tol;
}

// Independently enumerate the NE the app's model is capable of representing:
// the four pure corners + (if it exists) the fully-interior mixed point.
function oracleNEs(g: GamePayoffs): { pure: Array<[number, number]>; mixed: [number, number] | null } {
  const pure: Array<[number, number]> = [];
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]] as Array<[number, number]>) {
    if (isNE(x, y, g, 1e-7)) pure.push([x, y]);
  }
  const dY = g.a11 - g.a12 - g.a21 + g.a22;
  const dX = g.b11 - g.b21 - g.b12 + g.b22;
  let mixed: [number, number] | null = null;
  if (Math.abs(dY) > 1e-9 && Math.abs(dX) > 1e-9) {
    const yS = (g.a22 - g.a12) / dY;
    const xS = (g.b22 - g.b21) / dX;
    if (xS > 1e-9 && xS < 1 - 1e-9 && yS > 1e-9 && yS < 1 - 1e-9) mixed = [xS, yS];
  }
  return { pure, mixed };
}

// A game is "degenerate" when a player is (near) indifferent along a corner edge
// or everywhere — these admit NE continua on the edges that the app's
// corner+interior model deliberately does not enumerate. We don't enforce strict
// completeness on them, but we still require soundness + no crashes.
function isDegenerate(g: GamePayoffs): boolean {
  const dY = g.a11 - g.a12 - g.a21 + g.a22;
  const dX = g.b11 - g.b21 - g.b12 + g.b22;
  if (Math.abs(dY) < 1e-6 || Math.abs(dX) < 1e-6) return true;
  // Near-ties in any corner best-response comparison.
  const ties = [
    (g.a11 - g.a21), (g.a12 - g.a22), // A: row1 vs row2 at y=1 / y=0
    (g.b11 - g.b12), (g.b21 - g.b22), // B: col1 vs col2 at x=1 / x=0
  ];
  return ties.some(d => Math.abs(d) < 1e-6);
}

// ── State helpers (mirror src/test.ts) ──────────────────────────────────────────
function createInitialState(startX: number, startY: number, g: GamePayoffs): SimState {
  return {
    cx: startX, cy: startY, calcX: startX, calcY: startY,
    displayX: startX, displayY: startY, startX, startY,
    domainLo: 0, domainHi: 1, domXLo: 0, domXHi: 1, domYLo: 0, domYHi: 1,
    stratX: startX, stratY: startY, cycleCount: 0,
    visitedPositions: [], ghostVisitedPositions: [],
    discoveredMixedX: null, discoveredMixedY: null, foundAxis: null,
    running: false, converged: false, stepCount: 0,
    pathSegmentsA: [{ xs: [startX], ys: [startY], zs: [r3(EA(startX, startY, g))], mover: 'A' }],
    pathSegmentsB: [{ xs: [startX], ys: [startY], zs: [r3(EB(startX, startY, g))], mover: 'A' }],
    phase1PtsA: null, phase1PtsB: null,
    ghostPathSegmentsA: [], ghostPathSegmentsB: [],
    cyclePattern: null, bisecting: false,
    bisectGoodLo: 0, bisectGoodHi: 1, bisectBadLo: 0, bisectBadHi: 1,
    ghostCyclePattern: null, ghostBisecting: false,
    ghostBisectGoodLo: 0, ghostBisectGoodHi: 1, ghostBisectBadLo: 0, ghostBisectBadHi: 1,
    historyStack: [],
  };
}

interface SimResult {
  converged: boolean;
  steps: number;
  cx: number;
  cy: number;
  nanFound: boolean;
  threw: string | null;
}

function finite(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

function pathHasNonFinite(segs: PathSegment[]): boolean {
  for (const seg of segs) {
    for (const arr of [seg.xs, seg.ys, seg.zs]) {
      for (const v of arr) if (!finite(v)) return true;
    }
  }
  return false;
}

function runSim(
  g: GamePayoffs,
  opts: { firstMover: 'A' | 'B'; shrinkStep: number; stepMode: 'shrink' | 'regret'; startX: number; startY: number; maxSteps: number },
): SimResult {
  const state = createInitialState(opts.startX, opts.startY, g);
  const allNE = computeAllNE(g);
  const pureNEs = allNE.filter(n => n.type === 'pure');
  const committedNE = pureNEs.length > 0
    ? pureNEs.reduce((best, ne) => {
        const my = opts.firstMover === 'A' ? ne.eA : ne.eB;
        const bs = opts.firstMover === 'A' ? best.eA : best.eB;
        return my > bs ? ne : best;
      })
    : null;

  let nanFound = false;
  try {
    for (let i = 0; i < opts.maxSteps && !state.converged; i++) {
      doStep(g, state, opts.firstMover, opts.shrinkStep, allNE, committedNE, () => {}, () => {}, () => {}, opts.stepMode);
      // The harness doesn't use undo, but the pure-NE convergence check reads the
      // most recent snapshot (historyStack[len-1]) to measure step-to-step delta.
      // Keep a short tail so that lookup still works, while avoiding the quadratic
      // memory blowup of retaining every per-step deep clone.
      if (state.historyStack.length > 4) state.historyStack.splice(0, state.historyStack.length - 4);
      if (!finite(state.cx) || !finite(state.cy)) { nanFound = true; break; }
    }
  } catch (err: any) {
    return { converged: state.converged, steps: state.stepCount, cx: state.cx, cy: state.cy, nanFound, threw: err?.message || String(err) };
  }
  if (pathHasNonFinite(state.pathSegmentsA) || pathHasNonFinite(state.pathSegmentsB) ||
      pathHasNonFinite(state.ghostPathSegmentsA) || pathHasNonFinite(state.ghostPathSegmentsB)) {
    nanFound = true;
  }
  return { converged: state.converged, steps: state.stepCount, cx: state.cx, cy: state.cy, nanFound, threw: null };
}

// ── Visual integrity ────────────────────────────────────────────────────────────
// Surfaces must be fully finite. Traces may contain intentional NaN *separators*
// inside merged path line traces (Plotly uses NaN to break a polyline), so for
// line traces we only require that markers/coords aren't Infinity; for marker
// traces (NE diamonds, spheres, start point) every coordinate must be finite.
function checkVisuals(g: GamePayoffs, s: SimState, allNE: NashEquilibrium[]): string | null {
  const surf = buildSurfaces(g);
  for (const row of surf.zA) for (const v of row) if (!finite(v)) return 'surface zA non-finite';
  for (const row of surf.zB) for (const v of row) if (!finite(v)) return 'surface zB non-finite';

  for (const mode of ['A', 'B', 'both'] as const) {
    let traces: any[];
    try {
      traces = makeTraces(surf, g, s, mode, allNE, false, 'shrink');
    } catch (e: any) {
      return `makeTraces threw (${mode}): ${e?.message || e}`;
    }
    for (const t of traces) {
      if (t.type !== 'scatter3d') continue;
      const isMarker = t.mode === 'markers';
      for (const axis of ['x', 'y', 'z'] as const) {
        const arr = t[axis];
        if (!Array.isArray(arr)) continue;
        for (const v of arr) {
          if (v === Infinity || v === -Infinity) return `trace "${t.name}" has Infinity in ${axis}`;
          if (isMarker && !finite(v)) return `marker trace "${t.name}" has non-finite ${axis}`;
        }
      }
    }
  }
  return null;
}

// ── Game generators ─────────────────────────────────────────────────────────────
let SEED = 0x2545f491;
function rng(): number {
  // xorshift32 — deterministic, reproducible runs.
  SEED ^= SEED << 13; SEED >>>= 0;
  SEED ^= SEED >> 17;
  SEED ^= SEED << 5; SEED >>>= 0;
  return SEED / 0xffffffff;
}
function randInt(lo: number, hi: number): number { return lo + Math.floor(rng() * (hi - lo + 1)); }

function gen(kind: 'smallInt' | 'tie' | 'bigFrac' | 'wide'): GamePayoffs {
  const f = (): number => {
    switch (kind) {
      case 'smallInt': return randInt(-5, 5);
      case 'tie': return randInt(-1, 1);               // tons of ties / degeneracy
      case 'bigFrac': return r3(rng() * 200 - 100);    // full [-100,100], 3-decimal
      case 'wide': return randInt(-100, 100);
    }
  };
  return { a11: f(), a12: f(), a21: f(), a22: f(), b11: f(), b12: f(), b21: f(), b22: f() };
}

function payoffsFromPreset(key: keyof typeof PRESETS): GamePayoffs {
  const p = PRESETS[key];
  return {
    a11: p.a11 ?? 0, a12: p.a12 ?? 0, a21: p.a21 ?? 0, a22: p.a22 ?? 0,
    b11: p.b11 ?? 0, b12: p.b12 ?? 0, b21: p.b21 ?? 0, b22: p.b22 ?? 0,
  };
}

// ── Findings accumulator ─────────────────────────────────────────────────────────
interface Findings {
  total: number;
  degenerate: number;
  soundnessFail: string[];     // solver returned a non-NE
  completenessFail: string[];  // solver missed an NE (non-degenerate only)
  existenceFail: string[];     // non-degenerate game with zero NE found
  simNonConverge: string[];    // sim hit step budget
  simWrong: string[];          // sim converged to a non-NE
  simNaN: string[];            // NaN/Infinity in sim state or path
  simThrew: string[];          // exception during sim
  visualFail: string[];        // bad geometry in traces/surfaces
  counts: Record<string, number>;
}
function newFindings(): Findings {
  return { total: 0, degenerate: 0, soundnessFail: [], completenessFail: [], existenceFail: [], simNonConverge: [], simWrong: [], simNaN: [], simThrew: [], visualFail: [], counts: {} };
}
function gstr(g: GamePayoffs): string {
  return `A[[${g.a11},${g.a12}],[${g.a21},${g.a22}]] B[[${g.b11},${g.b12}],[${g.b21},${g.b22}]]`;
}
// Counts EVERY occurrence (so totals are exact) while keeping only the first few
// example strings in the sample array for display.
const occCounts = new WeakMap<string[], number>();
function cap(arr: string[], msg: string, limit = 8) {
  occCounts.set(arr, (occCounts.get(arr) ?? 0) + 1);
  if (arr.length < limit) arr.push(msg);
}

// Tolerances. The solver rounds coordinates to 3 decimals (r3), so we validate
// it by COORDINATE distance to the exact analytic NE (scale-free) rather than by
// plugging rounded coords into a tight regret check. The simulation walks a
// discrete grid, so its converged point is allowed to land slightly farther.
const PURE_REGRET_TOL = 1e-7;   // pure coords are exact 0/1 → regret must vanish
const ROUND_TOL = 2e-3;         // 3-dp rounding slack on mixed coordinates
const COMPLETE_TOL = 5e-3;
const SIM_COORD_TOL = 0.03;     // converged point's distance to nearest true NE

function auditGame(g: GamePayoffs, F: Findings, simConfigs: Array<{ firstMover: 'A' | 'B'; shrinkStep: number; stepMode: 'shrink' | 'regret'; startX: number; startY: number }>) {
  F.total++;
  const degen = isDegenerate(g);
  if (degen) F.degenerate++;

  // Soundness check would catch NaN payoffs too; guard finiteness first.
  let solverNEs: NashEquilibrium[];
  try {
    solverNEs = computeAllNE(g);
  } catch (e: any) {
    cap(F.simThrew, `computeAllNE threw: ${e?.message || e} | ${gstr(g)}`);
    return;
  }

  // 2) EXISTENCE + 3) COMPLETENESS (strict only for non-degenerate games).
  const oracle = oracleNEs(g);
  const oracleCount = oracle.pure.length + (oracle.mixed ? 1 : 0);

  // 1) SOUNDNESS: every returned NE must match the independent oracle.
  for (const ne of solverNEs) {
    if (!finite(ne.x) || !finite(ne.y) || !finite(ne.eA) || !finite(ne.eB)) {
      cap(F.soundnessFail, `non-finite NE field (${ne.label}) | ${gstr(g)}`); continue;
    }
    if (ne.type === 'pure') {
      // Pure coords are exact 0/1 → demand a true (near-zero-regret) NE there.
      if (!isNE(ne.x, ne.y, g, PURE_REGRET_TOL)) {
        cap(F.soundnessFail, `${ne.label} not a true pure NE (regretA=${regretA(ne.x, ne.y, g).toExponential(2)}, regretB=${regretB(ne.x, ne.y, g).toExponential(2)}) | ${gstr(g)}`);
      }
    } else {
      // Mixed coords must match the exact analytic interior NE within rounding.
      if (!oracle.mixed || Math.abs(ne.x - oracle.mixed[0]) > ROUND_TOL || Math.abs(ne.y - oracle.mixed[1]) > ROUND_TOL) {
        cap(F.soundnessFail, `${ne.label} not within rounding of exact mixed NE${oracle.mixed ? ` (${oracle.mixed[0].toFixed(3)},${oracle.mixed[1].toFixed(3)})` : ' (none exists!)'} | ${gstr(g)}`);
      }
    }
    // eA/eB must equal the actual expected payoffs at the reported coords.
    if (Math.abs(ne.eA - EA(ne.x, ne.y, g)) > 2e-3 || Math.abs(ne.eB - EB(ne.x, ne.y, g)) > 2e-3) {
      cap(F.soundnessFail, `${ne.label} payoff mismatch | ${gstr(g)}`);
    }
  }
  if (!degen) {
    if (solverNEs.length === 0) cap(F.existenceFail, `zero NE found | ${gstr(g)}`);
    // Each oracle pure NE must be present in solver output.
    for (const [x, y] of oracle.pure) {
      const hit = solverNEs.some(n => n.type === 'pure' && Math.abs(n.x - x) < COMPLETE_TOL && Math.abs(n.y - y) < COMPLETE_TOL);
      if (!hit) cap(F.completenessFail, `missing pure NE (${x},${y}) | ${gstr(g)}`);
    }
    if (oracle.mixed) {
      const [x, y] = oracle.mixed;
      const hit = solverNEs.some(n => n.type === 'mixed' && Math.abs(n.x - x) < COMPLETE_TOL && Math.abs(n.y - y) < COMPLETE_TOL);
      if (!hit) cap(F.completenessFail, `missing mixed NE (${x.toFixed(3)},${y.toFixed(3)}) | ${gstr(g)}`);
    }
    // Solver must not report MORE than the oracle (extra spurious NE).
    if (solverNEs.length > oracleCount) {
      cap(F.completenessFail, `solver reports ${solverNEs.length} > oracle ${oracleCount} | ${gstr(g)}`);
    }
  }

  // 4) SIMULATION: only meaningful when the solver found something to converge to.
  if (solverNEs.length === 0) return;
  // True NE coordinates the sim may legitimately land on (oracle for soundness of
  // the dynamics). Falls back to solver coords for degenerate games.
  const trueCoords: Array<[number, number]> = degen
    ? solverNEs.map(n => [n.x, n.y] as [number, number])
    : [...oracle.pure, ...(oracle.mixed ? [oracle.mixed] : [])];
  const distToNearest = (x: number, y: number) =>
    Math.min(...trueCoords.map(([nx, ny]) => Math.max(Math.abs(x - nx), Math.abs(y - ny))));

  // Non-degenerate games must converge well within this; degenerate ones are only
  // probed for crashes/NaN, so a smaller budget keeps the sweep fast.
  const maxSteps = degen ? 2500 : 8000;
  for (const cfg of simConfigs) {
    // regret mode only diverges from shrink for mixed-only games; still safe to run elsewhere.
    const res = runSim(g, { ...cfg, maxSteps });
    const tag = `${cfg.stepMode}/${cfg.firstMover}/step=${cfg.shrinkStep}/start=(${cfg.startX},${cfg.startY})`;
    // Crashes/NaN are bugs for ANY input, degenerate or not.
    if (res.threw) { cap(F.simThrew, `${tag} threw: ${res.threw} | ${gstr(g)}`); continue; }
    if (res.nanFound || !finite(res.cx) || !finite(res.cy)) { cap(F.simNaN, `${tag} produced NaN/Inf | ${gstr(g)}`); continue; }
    // Convergence + correctness are only well-defined for non-degenerate games
    // (degenerate ones have NE continua the discrete dynamics needn't pin down).
    if (degen) continue;
    if (!res.converged) { cap(F.simNonConverge, `${tag} no converge in 8000 steps | ${gstr(g)}`); continue; }
    if (distToNearest(res.cx, res.cy) > SIM_COORD_TOL) {
      cap(F.simWrong, `${tag} → (${res.cx.toFixed(3)},${res.cy.toFixed(3)}) dist=${distToNearest(res.cx, res.cy).toFixed(3)} from nearest true NE | ${gstr(g)}`);
    }
  }

  // 5) VISUALS: build traces for a representative converged state.
  const vstate = createInitialState(0.217, 0.217, g);
  vstate.discoveredMixedX = solverNEs.find(n => n.type === 'mixed')?.x ?? null;
  vstate.discoveredMixedY = solverNEs.find(n => n.type === 'mixed')?.y ?? null;
  const vfail = checkVisuals(g, vstate, solverNEs);
  if (vfail) cap(F.visualFail, `${vfail} | ${gstr(g)}`);
}

// ── Driver ───────────────────────────────────────────────────────────────────────
function report(name: string, F: Findings) {
  const buckets: Array<[string, string[]]> = [
    ['SOUNDNESS (solver returned a non-NE)', F.soundnessFail],
    ['COMPLETENESS (solver missed/over-reported NE)', F.completenessFail],
    ['EXISTENCE (non-degenerate game, zero NE)', F.existenceFail],
    ['SIM non-convergence', F.simNonConverge],
    ['SIM converged to wrong point', F.simWrong],
    ['SIM NaN/Infinity', F.simNaN],
    ['SIM threw', F.simThrew],
    ['VISUAL geometry', F.visualFail],
  ];
  const failCount = buckets.reduce((n, [, a]) => n + a.length, 0);
  console.log(`\n=== ${name} ===`);
  console.log(`games audited: ${F.total}  (degenerate: ${F.degenerate})`);
  if (failCount === 0) { console.log('✓ no issues'); return failCount; }
  let total = 0;
  for (const [label, arr] of buckets) {
    if (arr.length === 0) continue;
    const occ = occCounts.get(arr) ?? arr.length;
    total += occ;
    console.log(`✗ ${label}: ${occ} occurrence(s)${occ > arr.length ? ` (showing first ${arr.length})` : ''}`);
    for (const m of arr) console.log(`    - ${m}`);
  }
  return total;
}

function main() {
  const simConfigs = [
    { firstMover: 'A' as const, shrinkStep: 0.1, stepMode: 'shrink' as const, startX: 0.217, startY: 0.217 },
    { firstMover: 'B' as const, shrinkStep: 0.1, stepMode: 'shrink' as const, startX: 0.217, startY: 0.217 },
    { firstMover: 'A' as const, shrinkStep: 0.01, stepMode: 'shrink' as const, startX: 0.5, startY: 0.5 },
    { firstMover: 'A' as const, shrinkStep: 0.1, stepMode: 'regret' as const, startX: 0.217, startY: 0.217 },
    { firstMover: 'A' as const, shrinkStep: 0.05, stepMode: 'regret' as const, startX: 0.8, startY: 0.2 },
  ];

  let totalFails = 0;

  // Presets (with extra start points) — must be flawless.
  {
    const F = newFindings();
    for (const key of ['search', 'bos', 'pd', 'cnr', 'spy'] as const) {
      auditGame(payoffsFromPreset(key), F, simConfigs);
    }
    totalFails += report('PRESETS (search, bos, pd, cnr, spy)', F);
  }

  // Randomized families. The full sweep is a heavy stress run (thousands of games
  // × 5 sim configs × up to 8000 steps each), too slow to gate every push, so it
  // is opt-in via FUZZ_FULL=1. The default is a reduced but category-complete
  // sweep that still samples every family and finishes in seconds — that is what
  // `npm test` and CI run on each PR; the exhaustive run is for nightly/manual use.
  const FULL = process.env.FUZZ_FULL === '1';
  const plan: Array<['smallInt' | 'tie' | 'bigFrac' | 'wide', number]> = FULL
    ? [
        ['smallInt', 3000],
        ['tie', 2000],
        ['bigFrac', 2000],
        ['wide', 1500],
      ]
    : [
        ['smallInt', 300],
        ['tie', 200],
        ['bigFrac', 200],
        ['wide', 150],
      ];
  for (const [kind, count] of plan) {
    const F = newFindings();
    for (let i = 0; i < count; i++) auditGame(gen(kind), F, simConfigs);
    totalFails += report(`RANDOM ${kind} (${count} games)`, F);
  }

  console.log(`\n${'='.repeat(50)}`);
  if (totalFails === 0) {
    console.log('✓✓ ALL CHECKS PASSED — solver, both sim modes, and visuals are correct across all sampled inputs.');
  } else {
    console.log(`✗✗ ${totalFails} issue group(s) found. See above.`);
    process.exit(1);
  }
}

main();
