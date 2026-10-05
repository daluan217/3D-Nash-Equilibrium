/**
 * Dynamics convergence, solution-concept consensus, and continuum invariants (math-loop-22).
 * Verifies that the dynamics (shrink & regret) and solution concept oracles
 * agree across all equilibrium classes (pure, mixed, continua).
 *
 * Checks Angles 2 and 3 of the math surface:
 *   - Angle 2: Continua agreement across geometry briefing, grounding payload,
 *              continuum components, and settled description.
 *   - Angle 3: Dynamics convergence (shrink & regret) on pure, mixed, and continuum
 *              games, regret certification, unrounded coordinate preservation,
 *              and alignment with drawn plot glyphs.
 *
 *   npx tsx src/mathdynamics.test.ts
 */
import {
  doStep, computeAllNE, resolveProfile, formatConvergenceLogLine,
  continuumSettledDescription, equilibriumSet, pointInRect,
  EA, EB, r3, regretA, regretB, neTolerancePlayer,
} from './utils/gameEngine';
import { makeTraces, buildSurfaces } from './utils/plotting';
import type { GamePayoffs, NashEquilibrium, SimState } from './types';

let checks = 0;
const fails: Record<string, number> = {};
const firstFail: Record<string, string> = {};

function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (ok) return;
  fails[name] = (fails[name] ?? 0) + 1;
  firstFail[name] ??= detail;
}

function makeState(x: number, y: number, g: GamePayoffs): SimState {
  return {
    cx: x, cy: y, exactX: x, exactY: y, calcX: x, calcY: y,
    displayX: x, displayY: y, startX: x, startY: y,
    domainLo: 0, domainHi: 1, domXLo: 0, domXHi: 1, domYLo: 0, domYHi: 1,
    stratX: x, stratY: y, cycleCount: 0,
    visitedPositions: [], ghostVisitedPositions: [],
    discoveredMixedX: null, discoveredMixedY: null, foundAxis: null,
    running: false, converged: false, stepCount: 0,
    pathSegmentsA: [{ xs: [x], ys: [y], zs: [r3(EA(x, y, g))], mover: 'A' }],
    pathSegmentsB: [{ xs: [x], ys: [y], zs: [r3(EB(x, y, g))], mover: 'A' }],
    phase1PtsA: null, phase1PtsB: null, ghostPathSegmentsA: [], ghostPathSegmentsB: [],
    cyclePattern: null, bisecting: false,
    bisectGoodLo: 0, bisectGoodHi: 1, bisectBadLo: 0, bisectBadHi: 1,
    ghostCyclePattern: null, ghostBisecting: false,
    ghostBisectGoodLo: 0, ghostBisectGoodHi: 1, ghostBisectBadLo: 0, ghostBisectBadHi: 1,
  } as SimState;
}

const dummySurf = buildSurfaces({ a11: 0, a12: 0, a21: 0, a22: 0, b11: 0, b12: 0, b21: 0, b22: 0 });

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  if (l < 1e-18) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

// ── Deterministic PRNG ────────────────────────────────────────────────────────
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(0x9a714);
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];

// ── Specific named fixtures ───────────────────────────────────────────────────
// F1_FOLLOWER_TIE: Follower A indifferent between Row 1 and 2 when B commits to (0, 0).
// Inactive A must break tie toward committedNE.x, converging to (0, 0), not (1, 0).
const G_EDGES: GamePayoffs = {
  a11: 0, a12: 100, a21: 0, a22: 100,
  b11: -99.999, b12: -100, b21: -0.001, b22: 0.001,
};

// F2_UNROUNDED_CONTINUUM: Continuum endpoint at 0.8125.
// Step must preserve unrounded exactX so off-grid start does not collapse to 0.813.
const G_INT9_CONT: GamePayoffs = {
  a11: 8, a12: 2, a21: 8, a22: 3,
  b11: 3, b12: 6, b21: 7, b22: -6,
};

// ── Fixture Tests ─────────────────────────────────────────────────────────────
{
  // Test F1_FOLLOWER_TIE (mutant M1: follower tie-breaking)
  const all = computeAllNE(G_EDGES);
  const pure = all.filter((n) => n.type === 'pure');
  const committed = pure.reduce((b, n) => (n.eB > b.eB ? n : b));
  const s = makeState(0.2, 0.8, G_EDGES);
  const logs: string[] = [];
  for (let k = 0; k < 50 && !s.converged; k++) {
    doStep(G_EDGES, s, 'B', 0.1, all, committed, (m) => logs.push(m), () => {}, () => {}, 'shrink');
  }
  check('D4_follower_tie_break', s.converged && s.convergedIsNE === true && s.cx === 0 && s.cy === 0,
    `expected convergence to (0,0), got (${s.cx},${s.cy})`);
}

{
  // Test F2_UNROUNDED_CONTINUUM (mutant M2: preserving exactX/exactY across steps)
  const all = computeAllNE(G_INT9_CONT);
  const s = makeState(0.8125, 1, G_INT9_CONT);
  const logs: string[] = [];
  doStep(G_INT9_CONT, s, 'B', 0.1, all, null, (m) => logs.push(m), () => {}, () => {}, 'shrink');
  doStep(G_INT9_CONT, s, 'B', 0.1, all, null, (m) => logs.push(m), () => {}, () => {}, 'shrink');
  const res = resolveProfile(G_INT9_CONT, s);
  const banner = formatConvergenceLogLine(G_INT9_CONT, res.x, res.y, true, EA(res.x, res.y, G_INT9_CONT), EB(res.x, res.y, G_INT9_CONT), 0);
  const lastLog = logs[logs.length - 1];
  check('D5_unrounded_exactX_sync', s.converged && lastLog === banner && s.exactX === 0.8125,
    `log vs banner mismatch or exactX lost: exactX=${s.exactX}, log="${lastLog}", banner="${banner}"`);
}

{
  // Test F3_PURE_TOLERANCE (mutant M3: strict pure regret tolerance at stationary pure point)
  // At (1, 0) on G_EDGES, B has regret 0.001 but spread 100.
  // neTolerancePlayer would allow 0.200, certifying a false pure NE.
  // Strict tolerance 1e-9 must refuse it (convergedIsNE === false).
  const s = makeState(1, 0, G_EDGES);
  s.stepCount = 2; // already moved twice
  const fakePure = [{ x: 0, y: 0, type: 'pure' as const }, { x: 1, y: 1, type: 'pure' as const }];
  const fakeCommitted = { x: 1, y: 0, type: 'pure' as const, label: 'Fake', eA: 100, eB: -100 } as any;
  doStep(G_EDGES, s, 'A', 0.1, fakePure as any, fakeCommitted, () => {}, () => {}, () => {}, 'shrink');
  check('D1_pure_regret_strict', s.converged === true && s.convergedIsNE === false,
    `pure corner with positive regret 0.001 must not be certified as NE (convergedIsNE=${s.convergedIsNE})`);
}

// ── Multi-game Sweeps ─────────────────────────────────────────────────────────
const KINDS: Record<string, () => number> = {
  edges: () => pick([100, -100, 99.999, -99.999, 0.001, -0.001, 0]),
  int9: () => Math.floor(rnd() * 19) - 9,
  dp3: () => Math.round((rnd() * 200 - 100) * 1000) / 1000,
  ties: () => pick([0.1, 0.2, 0.3, 0.7, -0.1, 0.6, 0.05, -0.06, 0.08, -0.07]),
};

const N_GAMES_PER_KIND = 15;
for (const [kind, cell] of Object.entries(KINDS)) {
  for (let i = 0; i < N_GAMES_PER_KIND; i++) {
    const g: GamePayoffs = {
      a11: cell(), a12: cell(), a21: cell(), a22: cell(),
      b11: cell(), b12: cell(), b21: cell(), b22: cell(),
    };
    const all = computeAllNE(g);
    const pure = all.filter((n) => n.type === 'pure');
    const set = equilibriumSet(g);

    for (const mover of ['A', 'B'] as const) {
      const committed = pure.length === 0 ? null : pure.reduce((b, n) => (
        (mover === 'A' ? n.eA : n.eB) > (mover === 'A' ? b.eA : b.eB) ? n : b
      ));

      for (const mode of ['shrink', 'regret'] as const) {
        for (const [x0, y0] of [[0.2, 0.8], [0, 1], [1, 0]]) {
          const s = makeState(x0, y0, g);
          const logs: string[] = [];
          for (let k = 0; k < 2000 && !s.converged; k++) {
            doStep(g, s, mover, 0.1, all, committed, (m) => logs.push(m), () => {}, () => {}, mode);
          }
          if (!s.converged) continue;

          const res = resolveProfile(g, s);
          const lastLog = logs[logs.length - 1];

          if (s.convergedIsNE === false) {
            // Check that it did not declare non-NE when sitting exactly in the equilibrium set
            const inSet = set.some((r) => pointInRect(r, s.exactX, s.exactY));
            check('D1_non_ne_soundness', !inSet,
              `${kind} run declared non-NE while exact (${s.exactX},${s.exactY}) is in eq set`);
            continue;
          }

          // D1_oracle_regret: Regret at converged point must be within tolerance
          const rA = Math.abs(regretA(s.exactX, s.exactY, g));
          const rB = Math.abs(regretB(s.exactX, s.exactY, g));
          const isPurePt = (s.exactX === 0 || s.exactX === 1) && (s.exactY === 0 || s.exactY === 1);
          const tolA = isPurePt ? 1e-9 : neTolerancePlayer(g, 'A');
          const tolB = isPurePt ? 1e-9 : neTolerancePlayer(g, 'B');
          check('D1_oracle_regret', rA <= tolA + 1e-9 && rB <= tolB + 1e-9,
            `regret exceeded: rA=${rA} tolA=${tolA}, rB=${rB} tolB=${tolB}`);

          // D2_log_banner_sync: Log line and banner must describe the same solution concept
          const banner = formatConvergenceLogLine(g, res.x, res.y, true, EA(res.x, res.y, g), EB(res.x, res.y, g), 0);
          check('D2_log_banner_sync', lastLog === banner,
            `log vs banner:\n  log:    ${lastLog}\n  banner: ${banner}`);

          // D3_continuum_glyph: Settled continuum point must lie on drawn glyph
          const cd = continuumSettledDescription(g, res.x, res.y);
          if (cd) {
            const tr = makeTraces(dummySurf, g, s, 'both', all, false, mode)
              .filter((t: any) => t.legendgroup === 'continuumNE');
            let onGlyph = false;
            for (const t of tr as any[]) {
              const xs: number[] = t.x, ys: number[] = t.y;
              if (t.mode === 'markers') {
                onGlyph ||= xs.some((v, idx) => Math.abs(v - res.x) < 1e-9 && Math.abs(ys[idx] - res.y) < 1e-9);
              } else {
                for (let k = 0; k + 1 < xs.length; k++) {
                  if (!Number.isNaN(xs[k]) && !Number.isNaN(xs[k + 1])
                    && segDist(res.x, res.y, xs[k], ys[k], xs[k + 1], ys[k + 1]) < 1e-9) {
                    onGlyph = true;
                    break;
                  }
                }
              }
            }
            check('D3_continuum_glyph', onGlyph,
              `settled continuum (${res.x},${res.y}) not on drawn glyph`);
          }
        }
      }
    }
  }
}

// ── Final reporting ───────────────────────────────────────────────────────────
const failCount = Object.keys(fails).length;
if (failCount > 0) {
  console.error(`✗ mathdynamics: ${failCount} check types failed:`);
  for (const [name, count] of Object.entries(fails)) {
    console.error(`  - ${name} (${count} failures): ${firstFail[name]}`);
  }
  process.exit(1);
} else {
  console.log(`✓ mathdynamics: ${checks} checks passed across fixtures and multi-game dynamics sweeps`);
}
