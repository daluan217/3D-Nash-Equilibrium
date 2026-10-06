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
  EA, EB, r3, regretA, regretB, neTolerancePlayer, computeMixedNE, fmtProb, fmtProbFixed, fmtPayoff, commitPayoffs,
  precomputeThinHistory, replayToStep, shownPoint,
} from './utils/gameEngine';
import { readFileSync } from 'node:fs';
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

// ── F8: a regret-mode line is NAMED "indifferent (y = y*)" only where y = y* (sweep 2) ──
// Before the first cycle the lines sit at the corridor midpoint 0.5; a 1% flatness band named
// that line "A indifferent (y = y*)" for y* = 0.497. Truth is display resolution (fmtProb).
{
  const F8: GamePayoffs = { a11: 9.792, a12: -6.731, a21: 5.054, a22: -2.05, b11: -9.164, b12: -0.811, b21: 3.407, b22: -8.902 };
  const named = (g: GamePayoffs, s: SimState) => makeTraces(dummySurf, g, s, 'both', computeAllNE(g), false, 'regret')
    .filter((t: any) => t.showlegend === true && / indifferent \((?:y = y|x = x)\*\)$/.test(t.name ?? ''));
  const lies = (g: GamePayoffs, s: SimState) => {
    const m = computeMixedNE(g)!;
    return named(g, s).filter((t: any) => t.name.startsWith('A') ? fmtProb(t.y[0]) !== fmtProb(m.y) : fmtProb(t.x[0]) !== fmtProb(m.x));
  };
  check('F8 precondition: y* = 0.497, inside the old 1% band around the 0.5 midpoint',
    fmtProb(computeMixedNE(F8)!.y) === '0.497' && computeAllNE(F8).every((n) => n.type === 'mixed'));
  check('F8 verbatim: at reset no line is named indifferent at y = 0.5 when y* = 0.497',
    lies(F8, makeState(0.2, 0.8, F8)).length === 0, JSON.stringify(lies(F8, makeState(0.2, 0.8, F8)).map((t: any) => t.name)));
  const r8 = mulberry32(0xf8);
  const reach = { games: 0, frames: 0, named: 0, nearHalf: 0 };
  for (let i = 0; i < 1500; i++) {
    const g = Object.fromEntries((['a11', 'a12', 'a21', 'a22', 'b11', 'b12', 'b21', 'b22'] as const)
      .map((k) => [k, i % 2 ? Math.floor(r8() * 9) - 4 : Math.round((r8() * 20 - 10) * 1000) / 1000])) as unknown as GamePayoffs;
    const all = computeAllNE(g);
    if (!all.some((n) => n.type === 'mixed') || all.some((n) => n.type === 'pure')) continue;
    reach.games++;
    const m = computeMixedNE(g)!;
    if (Math.abs(m.y - 0.5) < 0.01 || Math.abs(m.x - 0.5) < 0.01) reach.nearHalf++;
    const s = makeState(r8(), r8(), g);
    for (let k = 0; k < 400 && !s.converged; k++) {
      doStep(g, s, k % 3 ? 'A' : 'B', 0.1, all, null, () => {}, () => {}, () => {}, 'regret');
      reach.frames++;
      reach.named += named(g, s).length;
      const bad = lies(g, s);
      check('F8 sweep: every line named indifferent sits at the solver\'s y* / x* (display resolution)', bad.length === 0,
        `${JSON.stringify(g)} step ${k}: ${bad.map((t: any) => `${t.name} at ${t.name.startsWith('A') ? t.y[0] : t.x[0]}`).join('; ')}`);
    }
  }
  check('F8 reach: regret runs, named-indifferent frames, and roots near the 0.5 midpoint all occurred',
    reach.games >= 100 && reach.named >= 1000 && reach.nearHalf >= 3, JSON.stringify(reach));
}

// ── D6: every "✓ x/y-coordinate discovered: v" log line prints the solver's root (sweep 3, empty probe) ──
// Both modes, both movers, four starts, ±100 / ±0.001 range edges: the log is a claim about x* / y*.
{
  const r6 = mulberry32(0x5d3);
  const gens: (() => number)[] = [() => Math.floor(r6() * 19) - 9, () => Math.round((r6() * 200 - 100) * 1000) / 1000,
    () => [100, -100, 99.999, -99.999, 0.001, -0.001, 0][Math.floor(r6() * 7)], () => Math.round((r6() * 2 - 1) * 1000) / 1000];
  const reach = { games: 0, lines: 0, sub: 0 };
  for (const gen of gens) for (let i = 0; i < 400; i++) {
    const g = Object.fromEntries((['a11', 'a12', 'a21', 'a22', 'b11', 'b12', 'b21', 'b22'] as const).map((k) => [k, gen()])) as unknown as GamePayoffs;
    const all = computeAllNE(g);
    if (!all.some((n) => n.type === 'mixed') || all.some((n) => n.type === 'pure')) continue;
    reach.games++;
    const m = computeMixedNE(g)!;
    for (const mover of ['A', 'B'] as const) for (const mode of ['shrink', 'regret'] as const) for (const [x0, y0] of [[0.2, 0.8], [0, 1], [1, 0], [0.5, 0.5]]) {
      const s = makeState(x0, y0, g); const logs: string[] = [];
      for (let k = 0; k < 3000 && !s.converged; k++) doStep(g, s, mover, 0.1, all, null, (l) => logs.push(l), () => {}, () => {}, mode);
      for (const l of logs) {
        const d = l.match(/^✓ ([xy])-coordinate discovered: (.+)$/);
        if (!d) continue;
        reach.lines++; if (/than/.test(d[2])) reach.sub++;
        const want = fmtProb(d[1] === 'x' ? m.x : m.y);
        check('D6 every "coordinate discovered" log line prints the solver\'s x* / y* (fmtProb)', d[2] === want,
          `${mode} ${mover} (${x0},${y0}) ${JSON.stringify(g)} "${l}" want ${want}`);
      }
    }
  }
  check('D6 reach: mixed-only games, discovery lines, and sub-resolution roots all occurred',
    reach.games >= 150 && reach.lines >= 5000 && reach.sub >= 50, JSON.stringify(reach));
}

// ── D7: every marker's hover readout is its own point on its own player's surface (sweep 3, empty probe) ──
// A swapped [zA, zB], a ghost read off the other surface, or a label printing a neighbour's x/y would each
// pass a format check; here payoff must equal E_A or E_B at the marker's (x, y), for the surface it sits on.
{
  const r7 = mulberry32(0xd7);
  const gens: (() => number)[] = [() => Math.floor(r7() * 5) - 2, () => Math.round((r7() * 200 - 100) * 1000) / 1000,
    () => [100, -100, 99.999, -99.999, 0.001, -0.001, 0][Math.floor(r7() * 7)]];
  const reach: Record<string, number> = { games: 0, pts: 0 };
  const who = (name: string, tm: string, j: number, n: number): 'A' | 'B' | null => /\(A\)|Ghost A/.test(name) ? 'A'
    : /\(B\)|Ghost B/.test(name) ? 'B' : tm !== 'both' ? (tm as 'A' | 'B') : n === 2 ? (j ? 'B' : 'A') : null;
  for (const gen of gens) for (let i = 0; i < 120; i++) {
    const g = Object.fromEntries((['a11', 'a12', 'a21', 'a22', 'b11', 'b12', 'b21', 'b22'] as const).map((k) => [k, gen()])) as unknown as GamePayoffs;
    const all = computeAllNE(g); reach.games++;
    for (const mode of ['shrink', 'regret'] as const) {
      const s = makeState(r7(), r7(), g);
      for (let k = 0; k < 400 && !s.converged; k++) {
        doStep(g, s, k % 2 ? 'A' : 'B', 0.1, all, null, () => {}, () => {}, () => {}, mode);
        if (k % 37 && !s.converged) continue;
        for (const tm of ['A', 'B', 'both'] as const) for (const t of makeTraces(dummySurf, g, s, tm, all, false, mode) as any[]) {
          if (t.mode !== 'markers' || t.hoverinfo === 'skip') continue;
          check('D7 every hoverable marker trace carries one readout per point', Array.isArray(t.text) && t.text.length === t.x.length,
            `${t.name} text=${JSON.stringify(t.text)}`);
          (t.text ?? []).forEach((txt: string, j: number) => {
            const [x, y, z] = [t.x[j], t.y[j], t.z[j]], p = who(t.name, tm, j, t.x.length);
            const want = p === 'A' ? EA(x, y, g) : p === 'B' ? EB(x, y, g) : NaN;
            const ok = p ? r3(z) === r3(want) : r3(z) === r3(EA(x, y, g)) || r3(z) === r3(EB(x, y, g));
            const m = txt.match(/<br>x: (.+)<br>y: (.+)<br>payoff: (.+)$/);
            reach.pts++; reach[t.legendgroup ?? t.name] = (reach[t.legendgroup ?? t.name] ?? 0) + 1;
            check('D7 hover payoff is E_A / E_B at the marker\'s own (x, y) on its own player\'s surface', ok,
              `${mode} tm=${tm} ${t.name}[${j}] p=${p} "${txt}" (${x},${y},${z}) EA=${EA(x, y, g)} EB=${EB(x, y, g)} ${JSON.stringify(g)}`);
            check('D7 hover text prints the marker\'s own x, y and payoff', !!m && m[1] === fmtProb(x) && m[2] === fmtProb(y) && m[3] === fmtPayoff(z),
              `"${txt}" vs (${x},${y},${z})`);
            // F11: the printed payoff is the UNROUNDED payoff's display — an r3'd z printed 0.000466 as "0".
            check('D7 hover payoff is fmtPayoff of the true payoff, not of a rounded z', !!m && (p ? m[3] === fmtPayoff(want)
              : m[3] === fmtPayoff(EA(x, y, g)) || m[3] === fmtPayoff(EB(x, y, g))), `${t.name}[${j}] "${txt}" true ${want} ${JSON.stringify(g)}`);
            if (m && p && want !== 0 && Math.abs(want) < 5e-4) reach.subres = (reach.subres ?? 0) + 1;
          });
        }
      }
    }
  }
  // F11 verbatim: ghost A at (0.466, 1) on game H; true E_A = 0.000466, the r3'd z printed "payoff: 0".
  const H: GamePayoffs = { a11: 0.001, a12: 0, a21: 0, a22: 99.999, b11: -99.999, b12: -0.003, b21: 99.999, b22: -0.003 };
  const sH = Object.assign(makeState(0.466, 1, H), { discoveredMixedX: 0.5, foundAxis: 'x', stepCount: 3 }) as SimState;
  const ghostA = (makeTraces(dummySurf, H, sH, 'both', computeAllNE(H), false, 'shrink') as any[]).find((t) => t.name === 'Search position (Ghost A)');
  check('F11 precondition: ghost A at (0.466, 1) with a nonzero sub-resolution payoff', !!ghostA && Math.abs(EA(0.466, 1, H) - 0.000466) < 1e-12);
  check('F11 verbatim: ghost hover never prints "payoff: 0" for 0.000466',
    ghostA?.text?.[0] === 'Search position (Ghost A)<br>x: 0.466<br>y: 1<br>payoff: less than 0.001', JSON.stringify(ghostA?.text));
  // ...and ghost B (game H2, where E_B(0.466, 1) = 0.000466 too).
  const H2: GamePayoffs = { ...H, b11: 0.001, b12: -0.003, b21: 0, b22: -0.003 };
  const ghostB = (makeTraces(dummySurf, H2, sH, 'both', computeAllNE(H2), false, 'shrink') as any[]).find((t) => t.legendgroup === 'ghostB');
  check('F11 verbatim: ghost B hover never prints "payoff: 0" for 0.000466', Math.abs(EB(0.466, 1, H2) - 0.000466) < 1e-12
    && ghostB?.text?.[0] === 'Search position (Ghost B)<br>x: 0.466<br>y: 1<br>payoff: less than 0.001', JSON.stringify(ghostB?.text));
  check('D7 reach: sub-resolution nonzero hover payoffs occurred (the F11 class)', (reach.subres ?? 0) >= 200, JSON.stringify(reach));
  check('D7 reach: every marker family (start, pure/mixed/continuum NE, both spheres, both ghosts) was hovered',
    reach.pts >= 10000 && ['Starting Point', 'pureNE', 'mixedNE', 'continuumNE', 'Current position (A)', 'Current position (B)',
      'Search position (Ghost A)', 'ghostB'].every((k) => (reach[k] ?? 0) >= 50), JSON.stringify(reach));
}

// ── D8 / F15: every run terminates, and none settles off the equilibrium set (sweep 5) ──
// F15: y* = 0.6 landed ON the ghost corridor's bound with fn(0.6) = 2.2e-16 (float residue, not 0), read
// as "bracket lost", collapsed to the 0.5 midpoint and never converged. RED-APP-6/001's fixture settled
// at (0,1) (A's regret 18) when B, indifferent at x = 0, broke the tie away from the committed NE.
{
  const F15: GamePayoffs = { a11: -9, a12: -3, a21: -7, a22: -6, b11: 4, b12: -2, b21: -4, b22: 5 };
  const run = (g: GamePayoffs, mover: 'A' | 'B', mode: 'shrink' | 'regret', x0: number, y0: number, cap: number) => {
    const all = computeAllNE(g), pure = all.filter((n) => n.type === 'pure');
    const committed = pure.length === 0 ? null : pure.reduce((b, n) => ((mover === 'A' ? n.eA > b.eA : n.eB > b.eB) ? n : b));
    const s = makeState(x0, y0, g), logs: string[] = [], m = computeMixedNE(g);
    let onBound = false;   // the F15 condition: a corridor bound IS the root, yet both bounds read one sign
    for (let k = 0; k < cap && !s.converged; k++) {
      doStep(g, s, mover, 0.1, all, committed, (l) => logs.push(l), () => {}, () => {}, mode);
      const r = s.foundAxis === 'x' ? m?.y : s.foundAxis === 'y' ? m?.x : undefined;
      const f = s.foundAxis === 'x' ? (v: number) => v * (g.a11 - g.a21) + (1 - v) * (g.a12 - g.a22) : (v: number) => v * (g.b11 - g.b12) + (1 - v) * (g.b21 - g.b22);
      onBound ||= r !== undefined && s.domainLo !== s.domainHi && (s.domainLo === r || s.domainHi === r) && f(s.domainLo) * f(s.domainHi) > 0;
    }
    return { s, logs, onBound };
  };
  check('F15 precondition: y* = 0.6 and A\'s indifference signal there is a nonzero float residue',
    computeMixedNE(F15)?.y === 0.6 && 0.6 * (F15.a11 - F15.a21) + 0.4 * (F15.a12 - F15.a22) !== 0);
  const f15 = run(F15, 'A', 'shrink', 0.217, 0.217, 200);
  check('F15 verbatim: the app\'s default run converges on the mixed NE (it stalled at y = 0.5 for 20000 steps)',
    f15.s.converged && f15.logs.at(-1) === '━━ Mixed NE: x=0.6, y=0.6  E[A]=-6.600  E[B]=0.800', `${f15.logs.at(-1)}`);
  const R6: GamePayoffs = { a11: 9, a12: -1, a21: -9, a22: 9, b11: -4, b12: -7, b21: -2, b22: -2 };
  const r6 = run(R6, 'A', 'shrink', 0.217, 0.217, 200);
  check('RED-APP-6/001 fixture: B is indifferent at x = 0, and the run converges on the committed NE (0, 0), not (0, 1)',
    R6.b21 === R6.b22 && r6.s.converged && r6.s.convergedIsNE === true && r6.s.exactX === 0 && r6.s.exactY === 0,
    `(${r6.s.exactX},${r6.s.exactY}) isNE=${r6.s.convergedIsNE}`);
  const keys = ['a11', 'a12', 'a21', 'a22', 'b11', 'b12', 'b21', 'b22'] as const;
  const reach = { runs: 0, residueRoot: 0, followerTie: 0 };
  const r8 = mulberry32(0xf15);
  const games: GamePayoffs[] = [];
  for (let code = 0; code < 6561; code++) games.push(Object.fromEntries(keys.map((k, i) => [k, [-1, 0, 1][Math.floor(code / 3 ** i) % 3]])) as unknown as GamePayoffs);
  for (let i = 0; i < 1500; i++) games.push(Object.fromEntries(keys.map((k) => [k, Math.floor(r8() * 19) - 9])) as unknown as GamePayoffs);
  // The F15 family: x* = q/10, y* = p/10 (where the 0.1-step corridor's bounds land), mixed-only.
  for (let p = 1; p <= 9; p++) for (let q = 1; q <= 9; q++) for (const sa of [1, -1]) for (const sb of [1, -1]) for (const k of [1, 2, 3]) {
    const h = (n: number) => k / (n % 2 ? 1 : 2), d1 = -sa * (10 - p) * h(p), d2 = sa * p * h(p), e1 = -sb * (10 - q) * h(q), e2 = sb * q * h(q);
    games.push({ a11: d1 - p, a12: d2 + q - 5, a21: -p, a22: q - 5, b11: e1 + k, b12: k, b21: e2 - q, b22: -q });
  }
  for (const g of games) {
    const pure = computeAllNE(g).filter((n) => n.type === 'pure');
    if (pure.length > 1 && (g.b11 === g.b12 || g.b21 === g.b22 || g.a11 === g.a21 || g.a12 === g.a22)) reach.followerTie++;
    for (const mover of ['A', 'B'] as const) for (const mode of ['shrink', 'regret'] as const) for (const [x0, y0] of [[0.217, 0.217], [0.9, 0.1]]) {
      const { s, onBound } = run(g, mover, mode, x0, y0, 3000);
      reach.runs++; if (onBound) reach.residueRoot++;
      check('D8 every run converges within 3000 steps (no stalled corridor)', s.converged, `${mode} ${mover} (${x0},${y0}) ${JSON.stringify(g)} at (${s.exactX},${s.exactY})`);
      check('D8 no run settles off the equilibrium set ("Settled (not an NE)")', !s.converged || s.convergedIsNE !== false,
        `${mode} ${mover} ${JSON.stringify(g)} at (${s.exactX},${s.exactY})`);
    }
  }
  check('D8 reach: a corridor bound sat on the root with both bounds one sign (F15), and follower ties between pure NEs occurred',
    reach.residueRoot >= 100 && reach.followerTie >= 500, JSON.stringify(reach));

  // ── D9 / F16 (sweep 6): every user step size, small determinants ──
  // The Phase-1 bisection read a sign flip under a flat 1e-4 as "no flip": at |D| = 0.01 a bound
  // 0.01 past the root stayed "good", the bracket lost the root and the run sat at [0.311, 0.692]
  // for 20000 steps (x* = y* = 0.3, step 0.333). D8 ran only step 0.1 and integer payoffs.
  const F16: GamePayoffs = { a11: -0.007, a12: 82.665, a21: 0, a22: 82.662, b11: 0.007, b12: 0, b21: 2.54, b22: 2.543 };
  const run16 = (g: GamePayoffs, mover: 'A' | 'B', mode: 'shrink' | 'regret', step: number, x0: number, y0: number) => {
    const all = computeAllNE(g), pure = all.filter((n) => n.type === 'pure');
    const committed = pure.length === 0 ? null : pure.reduce((b, n) => ((mover === 'A' ? n.eA > b.eA : n.eB > b.eB) ? n : b));
    const s = makeState(x0, y0, g), logs: string[] = [];
    for (let k = 0; k < 20000 && !s.converged; k++) doStep(g, s, mover, step, all, committed, (l) => logs.push(l), () => {}, () => {}, mode);
    return { s, logs };
  };
  const f16 = run16(F16, 'A', 'shrink', 0.333, 1, 1);
  check('F16 verbatim: step 0.333 from (1,1) converges on the mixed NE (0.3, 0.3) (it sat at [0.311, 0.692] for 20000 steps)',
    f16.s.converged && f16.s.convergedIsNE === true && f16.logs.at(-1)?.startsWith('━━ Mixed NE: x=0.3, y=0.3 ') === true, `${f16.logs.at(-1)}`);
  const r9 = mulberry32(0xf16), pick9 = <T,>(xs: T[]) => xs[Math.floor(r9() * xs.length)];
  const steps9 = [0.001, 0.003, 0.007, 0.01, 0.033, 0.07, 0.1, 0.125, 0.2, 0.25, 0.333, 0.5, 0.6, 0.75, 0.9, 0.999];
  const reach9 = { runs: 0, smallD: 0, tinyD: 0, mixedD: 0, steps: new Set<number>() };
  for (let i = 0; i < 1500; i++) {
    // mixed root (p, q) on a step multiple or k/den, A/B gaps scaled by s (|D| = s), 3-dp offsets
    const step = pick9(steps9), p = pick9([0.3, 0.5, 0.25, 0.1, 0.9, 1 / 3, 2 / 3, 0.7]), q = pick9([0.3, 0.5, 0.75, 0.2, 0.6, 1 / 7]);
    const S = [0.003, 0.007, 0.01, 0.02, 0.05, 0.1, 0.15, 1, 50], scA = pick9(S), scB = pick9(S);   // independent: A's |D| is not B's
    const sa = pick9([1, -1]), sb = pick9([1, -1]), o = () => pick9([0, Math.round(r9() * 200000 - 100000) / 1000]);
    const [oa, ob, oc, od] = [o(), o(), o(), o()];
    const g = commitPayoffs({ a11: oa + sa * scA * (1 - q), a21: oa, a12: ob - sa * scA * q, a22: ob, b11: oc + sb * scB * (1 - p), b12: oc, b21: od - sb * scB * p, b22: od });
    const dMin = Math.min(Math.abs(g.a11 - g.a12 - g.a21 + g.a22), Math.abs(g.b11 - g.b12 - g.b21 + g.b22));
    for (const mover of ['A', 'B'] as const) for (const mode of ['shrink', 'regret'] as const) {
      const [x0, y0] = pick9([[0.217, 0.217], [1, 1], [0, 0], [0.5, 0.5]]);
      const { s } = run16(g, mover, mode, step, x0, y0);
      reach9.runs++; reach9.steps.add(step); if (dMin < 0.154) reach9.smallD++; if (dMin < 0.02) reach9.tinyD++;
      if (dMin < 0.02 && Math.max(Math.abs(g.a11 - g.a12 - g.a21 + g.a22), Math.abs(g.b11 - g.b12 - g.b21 + g.b22)) >= 0.154) reach9.mixedD++;
      check('D9 every run converges within the app\'s 20000-step cap, at every step size', s.converged, `${mode} ${mover} step ${step} (${x0},${y0}) ${JSON.stringify(g)} at [${s.domainLo},${s.domainHi}]`);
      check('D9 no run settles off the equilibrium set', !s.converged || s.convergedIsNE !== false, `${mode} ${mover} step ${step} ${JSON.stringify(g)} at (${s.exactX},${s.exactY})`);
      const rp = s.converged ? resolveProfile(g, s) : null;   // measured worst 0.000571 (4/7 found at 0.572)
      check('D9 a run stops within discovery\'s tolerance (0.00065) of the equilibrium it reports', !rp || Math.max(Math.abs(rp.x - s.exactX), Math.abs(rp.y - s.exactY)) <= 0.00065,
        `${mode} ${mover} step ${step} ${JSON.stringify(g)} at (${s.exactX},${s.exactY}) reports ${JSON.stringify(rp)}`);
    }
  }
  check('D9 reach: small determinants (|D| < 0.154, where the tolerance moved) and tiny ones (< 0.02) at every step size',
    reach9.smallD >= 800 && reach9.tinyD >= 300 && reach9.mixedD >= 300 && reach9.steps.size === steps9.length, JSON.stringify({ ...reach9, steps: reach9.steps.size }));
  // D9b (sweep 7): the 3-dp floor itself. Gaps in whole thousandths, |D| = 0.001..0.003 for A, B or
  // both, corner and off-grid starts; mixed-only games are kept so every run must find the root.
  const reach9b = { runs: 0, mixedOnly: 0 };
  for (let i = 0; reach9b.mixedOnly < 150 && i < 20000; i++) {
    const tiny = pick9(['A', 'B', 'AB']), gap = (t: boolean) => { const dm = (t ? pick9([1, 2, 3]) : pick9([7, 50, 1000])) * pick9([1, -1]), u2 = -Math.sign(dm) * (1 + Math.floor(r9() * Math.abs(dm))); return [(u2 + dm) / 1000, u2 / 1000]; };
    const [[a1, a2], [b1, b2]] = [gap(tiny !== 'B'), gap(tiny !== 'A')], o = () => pick9([0, Math.round(r9() * 200000 - 100000) / 1000]);
    const [oa, ob, oc, od] = [o(), o(), o(), o()];
    const g = commitPayoffs({ a11: oa + a1, a21: oa, a12: ob + a2, a22: ob, b11: oc + b1, b12: oc, b21: od + b2, b22: od });
    if (computeAllNE(g).some((n) => n.type === 'pure') || !computeMixedNE(g)) continue;
    reach9b.mixedOnly++;
    for (const mover of ['A', 'B'] as const) for (const mode of ['shrink', 'regret'] as const) {
      const step = pick9(steps9), [x0, y0] = pick9([[0.217, 0.217], [0, 1], [1, 0], [1, 1], [Math.round(r9() * 1e6) / 1e6, Math.round(r9() * 1e6) / 1e6]]);
      const { s } = run16(g, mover, mode, step, x0, y0), rp = s.converged ? resolveProfile(g, s) : null, m = computeMixedNE(g)!;
      reach9b.runs++;
      check('D9b at the 3-dp determinant floor every mixed-only run converges on the root', !!rp && s.convergedIsNE !== false && rp.x === m.x && rp.y === m.y,
        `${mode} ${mover} step ${step} (${x0},${y0}) ${JSON.stringify(g)} at [${s.domainLo},${s.domainHi}] rp ${JSON.stringify(rp)}`);
    }
  }
  check('D9b reach: 150 mixed-only games with a determinant at the 3-dp floor', reach9b.mixedOnly >= 150, JSON.stringify(reach9b));
}

// ── D10 (sweep 8, empty probe checked in): resolveProfile at ANY point a run can stop at ──
// The reported point is an equilibrium (regret ≤ 1e-9·span), inside [0,1]², no listed equilibrium is
// nearer the run, and it is "pure" iff it is a vertex. Ties and range-edge alphabets force continua.
{
  const r10 = mulberry32(0xd10), K8 = ['a11', 'a12', 'a21', 'a22', 'b11', 'b12', 'b21', 'b22'] as const;
  const gens = [() => Math.floor(r10() * 5) - 2, () => [-100, -0.001, 0, 0.001, 100, 1, -1][Math.floor(r10() * 7)], () => Math.round((r10() * 200 - 100) * 1000) / 1000];
  let cont = 0;
  for (let i = 0; i < 12000; i++) {
    const g = Object.fromEntries(K8.map((k) => [k, gens[i % 3]()])) as unknown as GamePayoffs;
    if (i % 5 === 0) g.a21 = g.a11; if (i % 7 === 0) g.b12 = g.b11;
    const all = computeAllNE(g), span = Math.max(1e-9, ...K8.map((k) => Math.abs(g[k])));
    if (equilibriumSet(g).some((q) => q.x0 !== q.x1 || q.y0 !== q.y1)) cont++;
    for (let j = 0; j < 4; j++) {
      const px = j === 0 ? r10() : j === 1 ? Math.round(r10() * 1000) / 1000 : j === 2 ? (r10() < 0.5 ? 0 : 1) : Math.round(r10() * 1e6) / 1e6, py = j === 2 ? (r10() < 0.5 ? 0 : 1) : r10();
      const p = resolveProfile(g, { exactX: px, exactY: py }), at = `${JSON.stringify(g)} (${px},${py}) -> ${JSON.stringify(p)}`, d = Math.hypot(p.x - px, p.y - py);
      check('D10 resolveProfile reports an equilibrium inside the square', p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1 && Math.max(regretA(p.x, p.y, g), regretB(p.x, p.y, g)) <= 1e-9 * span, at);
      check('D10 no listed equilibrium is nearer the run than the one reported', all.every((e) => Math.hypot(e.x - px, e.y - py) >= d - 1e-12), at);
      check('D10 the concept is "pure" iff the reported point is a vertex', (p.concept === 'pure') === ((p.x === 0 || p.x === 1) && (p.y === 0 || p.y === 1)), at);
    }
  }
  check('D10 reach: continua among the resolved games', cont >= 4000, `${cont}`);
}

// ── D11 (sweep 8): each surface cell is its own player's payoff at (x[i], y[j]) ──
// Plotly reads z[j][i] at (x[i], y[j]). The only end-to-end check (§93) reads the (1,1) corner, which a
// transpose leaves fixed, so a swapped grid or an A/B swap painted the wrong surface under green CI.
{
  const r11 = mulberry32(0xd11);
  let cells = 0;
  for (let i = 0; i < 300; i++) {
    const g = Object.fromEntries((['a11', 'a12', 'a21', 'a22', 'b11', 'b12', 'b21', 'b22'] as const).map((k) => [k, Math.round((r11() * 200 - 100) * 1000) / 1000])) as unknown as GamePayoffs;
    const s = makeState(r11(), r11(), g), all = computeAllNE(g);
    for (const t of (makeTraces(buildSurfaces(g), g, s, 'both', all, false, 'shrink') as any[]).filter((t) => t.type === 'surface')) {
      const pay = t.name === 'E[A]' ? EA : t.name === 'E[B]' ? EB : null;
      check('D11 the plot has exactly the E[A] and E[B] surfaces', !!pay, t.name);
      if (!pay) continue;
      t.z.forEach((row: number[], j: number) => row.forEach((z, k) => {
        cells++;
        const m = t.text?.[j]?.[k]?.match(/<br>x: (.+)<br>y: (.+)<br>payoff: (.+)$/);
        check('D11 surface z[j][i] is the player\'s payoff at (x[i], y[j])', z === pay(t.x[k], t.y[j], g), `${t.name} [${j}][${k}] ${z} vs ${pay(t.x[k], t.y[j], g)} ${JSON.stringify(g)}`);
        check('D11 the surface hover prints that cell\'s own x, y and payoff', !!m && m[1] === fmtProb(t.x[k]) && m[2] === fmtProb(t.y[j]) && m[3] === fmtPayoff(z), `${t.name} [${j}][${k}] ${t.text?.[j]?.[k]}`);
      }));
    }
  }
  check('D11 reach: both surfaces of 300 games, every grid cell', cells === 300 * 2 * 29 * 29, `${cells}`);
}

// ── D12 / R1 (review, 2026-10-06): the sphere sits on the readout after every step, cycle frames included ──
// applyBisectCycleStep clamped cx/cy into the new domain but not exactX/exactY, and the sphere is drawn at
// exact: matching pennies, shrink 0.1, step 6 read (0.1, 0.9) in domain [0.1, 0.9] with the sphere at (0, 1).
{
  const sphere = (g: GamePayoffs, s: SimState, mode: 'shrink' | 'regret') => (makeTraces(dummySurf, g, s, 'both', computeAllNE(g), false, mode) as any[])
    .filter((t) => /^Current position \([AB]\)$/.test(t.name)).map((t) => [t.x[0], t.y[0]]);
  const MP: GamePayoffs = { a11: 1, a12: -1, a21: -1, a22: 1, b11: -1, b12: 1, b21: 1, b22: -1 };
  const sv = makeState(0.217, 0.217, MP), allMP = computeAllNE(MP);
  for (let k = 0; k < 6; k++) doStep(MP, sv, 'A', 0.1, allMP, null, () => {}, () => {}, () => {}, 'shrink');
  check('R1 verbatim: matching pennies step 6 (cycle) draws both spheres at the readout (0.1, 0.9), inside domain [0.1, 0.9]',
    sv.cx === 0.1 && sv.cy === 0.9 && sv.domainLo === 0.1 && sphere(MP, sv, 'shrink').every(([x, y]) => x === 0.1 && y === 0.9), JSON.stringify(sphere(MP, sv, 'shrink')));
  const r12 = mulberry32(0xd12), V = [-3, -2, -1, 0, 1, 2, 3, 5, -0.5, 0.25], pk = <T,>(a: T[]) => a[Math.floor(r12() * a.length)];
  const reach12 = { frames: 0, cycles: 0 };
  for (let i = 0; i < 600; i++) {
    const g = commitPayoffs(Object.fromEntries((['a11', 'a12', 'a21', 'a22', 'b11', 'b12', 'b21', 'b22'] as const).map((k) => [k, pk(V)])) as unknown as GamePayoffs);
    const all = computeAllNE(g), pure = all.filter((n) => n.type === 'pure');
    for (const mover of ['A', 'B'] as const) for (const mode of ['shrink', 'regret'] as const) {
      const committed = pure.length === 0 ? null : pure.reduce((b, n) => ((mover === 'A' ? n.eA > b.eA : n.eB > b.eB) ? n : b));
      const step = pk([0.1, 0.333, 0.05, 0.25, 0.007]), s = makeState(pk([0.217, 0, 1, 0.9]), pk([0.217, 0, 1, 0.1]), g);
      for (let k = 0; k < 600 && !s.converged; k++) {
        let cyc = false;
        doStep(g, s, mover, step, all, committed, () => {}, () => { cyc = true; }, () => {}, mode);
        reach12.frames++; if (cyc) reach12.cycles++;
        const at = `${mode} ${mover} step ${step} k ${k + 1}${cyc ? ' cycle' : ''} ${JSON.stringify(g)} readout (${s.cx}, ${s.cy})`;
        check('D12 the exact position is the readout to r3 after every step', Math.max(Math.abs(s.exactX - s.cx), Math.abs(s.exactY - s.cy)) <= 5e-4 + 1e-12, `${at} exact (${s.exactX}, ${s.exactY})`);
        if (cyc) check('D12 a cycle frame draws the sphere on the readout', sphere(g, s, mode).every(([x, y]) => Math.max(Math.abs(x - s.cx), Math.abs(y - s.cy)) <= (s.converged ? 1.5e-3 : 5e-4 + 1e-12)), `${at} spheres ${JSON.stringify(sphere(g, s, mode))}`);
      }
    }
  }
  check('D12 reach: frames and cycle frames over every mode/mover', reach12.frames >= 25000 && reach12.cycles >= 5000, JSON.stringify(reach12));
}

// ── D13 (sweep 9, empty probe checked in): every drawn point lies on its own surface, inside the square ──
// D7 reads hoverable markers only; path and ghost-path lines, strategy lines and indifference lines carry
// their z in state or in the trace with no hover. A path point retro-snapped on x but not re-z'd, or a
// ghost segment written from the other player's payoff, would float off the surface it is drawn on.
{
  const r13 = mulberry32(0xd13), V = [-3, -2, -1, 0, 1, 2, 3, 5, -0.5, 0.25, 0.001, -0.001], pk = <T,>(a: T[]) => a[Math.floor(r13() * a.length)];
  const onA = /^(Current position \(A\)|Search position \(Ghost A\)|A strategy line .*|A indifferent .*)$/, onB = /^(Current position \(B\)|Search position \(Ghost B\)|B strategy line .*|B indifferent .*)$/;
  const reach13: Record<string, number> = { frames: 0, pathPts: 0, ghostPts: 0, tracePts: 0, lines: 0 };
  for (let i = 0; i < 300; i++) {
    const g = commitPayoffs(Object.fromEntries((['a11', 'a12', 'a21', 'a22', 'b11', 'b12', 'b21', 'b22'] as const).map((k) => [k, pk(V)])) as unknown as GamePayoffs);
    const all = computeAllNE(g), pure = all.filter((n) => n.type === 'pure');
    for (const mover of ['A', 'B'] as const) for (const mode of ['shrink', 'regret'] as const) {
      const committed = pure.length === 0 ? null : pure.reduce((b, n) => ((mover === 'A' ? n.eA > b.eA : n.eB > b.eB) ? n : b));
      const step = pk([0.1, 0.333, 0.05, 0.25]), s = makeState(pk([0.217, 0, 1, 0.9]), pk([0.217, 0, 1, 0.1]), g);
      for (let k = 0; k < 400 && !s.converged; k++) {
        doStep(g, s, mover, step, all, committed, () => {}, () => {}, () => {}, mode);
        if (k % 3 && !s.converged) continue;
        reach13.frames++;
        const at = `${mode} ${mover} step ${step} k ${k + 1} ${JSON.stringify(g)}`;
        for (const [arr, P, key] of [[s.pathSegmentsA, EA, 'pathPts'], [s.pathSegmentsB, EB, 'pathPts'], [s.ghostPathSegmentsA, EA, 'ghostPts'], [s.ghostPathSegmentsB, EB, 'ghostPts']] as const)
          for (const seg of arr) seg.xs.forEach((x, j) => {
            const y = seg.ys[j], z = seg.zs[j]; reach13[key]++;
            check('D13 every recorded path point is in the unit square', x >= 0 && x <= 1 && y >= 0 && y <= 1, `${at} ${key} (${x}, ${y})`);
            check('D13 every recorded path point is r3 of its own surface at its own (x, y)', z === r3(P(x, y, g)), `${at} ${key} (${x}, ${y}, ${z}) want ${r3(P(x, y, g))}`);
          });
        for (const t of makeTraces(dummySurf, g, s, 'both', all, false, mode) as any[]) {
          if (t.type !== 'scatter3d' || !Array.isArray(t.x)) continue;
          const P = onA.test(t.name) ? EA : onB.test(t.name) ? EB : null;
          if (P && t.mode === 'lines') reach13.lines++;
          t.x.forEach((x: number, j: number) => {
            const y = t.y[j], z = t.z[j];
            if ([x, y, z].every(Number.isNaN)) return;   // a legend stub or a line break, not a point
            reach13.tracePts++;
            check('D13 every drawn point is in the unit square with a finite z', x >= -1e-9 && x <= 1 + 1e-9 && y >= -1e-9 && y <= 1 + 1e-9 && Number.isFinite(z), `${at} "${t.name}" (${x}, ${y}, ${z})`);
            if (P) check('D13 a point drawn on a player\'s surface has that player\'s payoff as z', Math.abs(z - P(x, y, g)) <= 5e-4 + 1e-12, `${at} "${t.name}" (${x}, ${y}, ${z}) want ${P(x, y, g)}`);
          });
        }
      }
    }
  }
  check('D13 reach: path, ghost-path and on-surface line points all drawn', reach13.frames >= 4000 && reach13.ghostPts >= 2000 && reach13.lines >= 2000 && reach13.tracePts >= 500000, JSON.stringify(reach13));
}

// ── D14 (sweep 9, empty probe checked in): "1st NE Coord" lands on the frame "Go to step N" shows ──
// The button restores precomputeThinHistory's neState copy; Go-to-step replays. A copy that aliased the live
// path arrays (later steps write into it) or a snapshot taken a step late would show a frame the run never had.
{
  const r14 = mulberry32(0xd14), V = [-3, -2, -1, 0, 1, 2, 3, 5, -0.5, 0.25], pk = <T,>(a: T[]) => a[Math.floor(r14() * a.length)];
  let snaps = 0;
  for (let i = 0; i < 1200; i++) {
    const g = commitPayoffs(Object.fromEntries((['a11', 'a12', 'a21', 'a22', 'b11', 'b12', 'b21', 'b22'] as const).map((k) => [k, pk(V)])) as unknown as GamePayoffs);
    const all = computeAllNE(g), pure = all.filter((n) => n.type === 'pure');
    for (const mover of ['A', 'B'] as const) for (const mode of ['shrink', 'regret'] as const) {
      const committed = pure.length === 0 ? null : pure.reduce((b, n) => ((mover === 'A' ? n.eA > b.eA : n.eB > b.eB) ? n : b));
      const step = pk([0.1, 0.333, 0.05, 0.25]), init = makeState(pk([0.217, 0, 1, 0.9]), pk([0.217, 0, 1, 0.1]), g);
      const { neState } = precomputeThinHistory(init, g, mover, step, all, committed, mode);
      if (!neState) continue;
      snaps++;
      const at = `${mode} ${mover} step ${step} @${neState.stepCount} ${JSON.stringify(g)}`;
      const rep = replayToStep(init, neState.stepCount, g, mover, step, all, committed, mode), before = replayToStep(init, neState.stepCount - 1, g, mover, step, all, committed, mode);
      const bad = (Object.keys({ ...rep, ...neState }) as (keyof SimState)[]).filter((k) => k !== 'running' && JSON.stringify(rep[k]) !== JSON.stringify(neState[k]));
      check('D14 the 1st-NE-coordinate snapshot is the replayed state at its step', bad.length === 0, `${at} fields ${bad}`);
      check('D14 the snapshot is the FIRST step with a coordinate found', before.discoveredMixedX === null && before.discoveredMixedY === null, at);
      const tr = (s: SimState) => JSON.stringify((makeTraces(dummySurf, g, { ...s, running: false }, 'both', all, false, mode) as any[]).map((t) => [t.name, t.x, t.y, t.z]));
      check('D14 the snapshot draws the replayed frame', tr(rep) === tr(neState), at);
    }
  }
  check('D14 reach: first-coordinate snapshots occurred', snaps >= 250, `${snaps}`);   // measured 292
}

// ── D15 (sweep 9 HIT, F17/F19/F20): the drawn path ends at the sphere, moves along its own axis, stays in its box ──
// Legend: "A Moves (x)" red, "B Moves (y)" blue. A discovery snap or a cycle clamp that moves both axes was drawn
// as one diagonal in the mover's colour, a clamp left the tip behind the sphere, and regret's position sat outside
// the box it had just contracted. Verbatim repros first (each fails on the unfixed tree), then the fuzz.
{
  const run = (g: GamePayoffs, mode: 'shrink' | 'regret', mover: 'A' | 'B', step: number, x: number, y: number, k: number) => {
    const s = makeState(x, y, g), all = computeAllNE(g); let logs: string[] = [];
    for (let i = 0; i < k; i++) { logs = []; doStep(g, s, mover, step, all, null, (m) => logs.push(m), () => {}, () => {}, mode); }
    return { s, logs, T: makeTraces(dummySurf, g, s, 'both', all, false, mode) as any[] };
  };
  const box = (T: any[]) => { const b = T.find((t) => t.name === 'Domain boundary' || t.name === 'Search corridor'); return [Math.min(...b.x), Math.max(...b.x), Math.min(...b.y), Math.max(...b.y)]; };
  const sph = (T: any[]) => { const t = T.find((u) => u.name === 'Current position (A)'); return [t.x[0], t.y[0]]; };
  const offAxis = (T: any[]) => T.filter((t) => t.legendgroup === 'amoves' || t.legendgroup === 'bmoves').flatMap((t) => {
    const other = t.legendgroup === 'amoves' ? t.y : t.x;
    return other.flatMap((v: number, j: number) => (j && Number.isFinite(v) && Number.isFinite(other[j - 1]) && Math.abs(v - other[j - 1]) > 1e-9 ? [`${t.legendgroup} (${t.x[j - 1]},${t.y[j - 1]})->(${t.x[j]},${t.y[j]})`] : []));
  });
  // F17 verbatim: the log printed "A∈[0.007,0.957] B∈[0.013,0.963]" then "Step 6 (B): x=1.000, y=1.000".
  const f17 = run({ a11: -2, a12: -2, a21: 1, a22: -3, b11: 3, b12: -2, b21: -0.5, b22: 0.25 }, 'regret', 'A', 0.05, 0.217, 0.217, 6);
  const [l17, h17, m17, n17] = box(f17.T), [x17, y17] = sph(f17.T);
  check('D15 F17 verbatim: fixture still contracts to A∈[0.007,0.957] B∈[0.013,0.963] on step 6', f17.logs.some((l) => l.startsWith('↺ Cycle 1 → A∈[0.007,0.957] B∈[0.013,0.963]')), f17.logs.join(' | '));
  check('D15 F17 verbatim: the readout and the sphere are inside the box the cycle line printed', [f17.s.cx, x17].every((v) => v >= l17 && v <= h17) && [f17.s.cy, y17].every((v) => v >= m17 && v <= n17), `cx (${f17.s.cx}, ${f17.s.cy}) sphere (${x17}, ${y17}) box [${l17},${h17}]x[${m17},${n17}]`);
  // F19 verbatim: the discovery snap x: 1 -> 0.467 was drawn inside a "B Moves (y)" line, (1,0)->(0.467,1).
  const f19 = run({ a11: -0.001, a12: 2, a21: 5, a22: -0.5, b11: 2, b12: 0, b21: 0.25, b22: 2 }, 'regret', 'B', 0.25, 1, 0.5, 5);
  check('D15 F19 verbatim: fixture discovers x on step 5', f19.logs.includes('✓ x-coordinate discovered: 0.467'), f19.logs.join(' | '));
  check('D15 F19 verbatim: no drawn move line changes the other player\'s axis', offAxis(f19.T).length === 0, offAxis(f19.T).join('; '));
  // F20 verbatim: "Step 5 (A): x=0.000, y=0.000" then "↺ Cycle 1 → domain [0.250,0.750]": sphere (0.25, 0.25), tip (0.25, 0).
  const f20 = run({ a11: 0.25, a12: 0.25, a21: -3, a22: 1, b11: -2, b12: -0.001, b21: 3, b22: -1 }, 'shrink', 'A', 0.25, 0.217, 0, 5);
  const tip20 = [f20.s.pathSegmentsA.at(-1)!.xs.at(-1), f20.s.pathSegmentsA.at(-1)!.ys.at(-1)];
  check('D15 F20 verbatim: fixture cycles into [0.250,0.750] from (0, 0) on step 5', f20.logs[0].startsWith('Step 5 (A): x=0.000, y=0.000') && f20.logs[1]?.startsWith('↺ Cycle 1 → domain [0.250,0.750]'), f20.logs.join(' | '));
  check('D15 F20 verbatim: the path tip is the sphere (0.25, 0.25)', JSON.stringify(tip20) === JSON.stringify([0.25, 0.25]) && JSON.stringify(sph(f20.T)) === JSON.stringify([0.25, 0.25]), `tip ${tip20} sphere ${sph(f20.T)}`);
  // Shrink convergence: the green box stood at [0.467,0.467]² while the sphere sat at (0.467, 0.333).
  const fc = run({ a11: -0.001, a12: 2, a21: 5, a22: -0.5, b11: 2, b12: 0, b21: 0.25, b22: 2 }, 'shrink', 'A', 0.25, 0.217, 0.1, 65);
  const [lc, hc, mc, nc] = box(fc.T), [xc, yc] = sph(fc.T);
  check('D15 conv verbatim: fixture converges on step 65 at (0.467, 0.333)', fc.s.converged && fc.s.stepCount === 65 && fc.s.cy === 0.333, `${fc.s.stepCount} (${fc.s.cx}, ${fc.s.cy})`);
  check('D15 conv verbatim: the closed box is the sphere\'s point', lc === xc && hc === xc && mc === yc && nc === yc, `box [${lc},${hc}]x[${mc},${nc}] sphere (${xc}, ${yc})`);

  // The pure-NE cycle branch never fires naturally (0 in 80,000 runs): force it by seeding the key the step lands on.
  const gp: GamePayoffs = { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 }, allp = computeAllNE(gp);
  const fp = makeState(0.217, 0.217, gp), probe = structuredClone(fp), lp: string[] = [];
  doStep(gp, probe, 'A', 0.25, allp, null, () => {}, () => {}, () => {}, 'shrink');
  fp.visitedPositions = [probe.cx.toFixed(3) + ',' + probe.cy.toFixed(3)];
  doStep(gp, fp, 'A', 0.25, allp, null, (m) => lp.push(m), () => {}, () => {}, 'shrink');
  const tipP = [fp.pathSegmentsA.at(-1)!.xs.at(-1), fp.pathSegmentsA.at(-1)!.ys.at(-1)];
  check('D15 forced pure-NE cycle: the branch fired and its clamp moved the position', lp.some((l) => l.startsWith('↺ Cycle 1 → domain')) && (fp.cx !== probe.cx || fp.cy !== probe.cy), `${lp.join(' | ')} cx (${fp.cx}, ${fp.cy}) pre (${probe.cx}, ${probe.cy})`);
  check('D15 forced pure-NE cycle: the path tip is the sphere', tipP[0] === r3(fp.exactX) && tipP[1] === r3(fp.exactY), `tip ${tipP} exact (${fp.exactX}, ${fp.exactY})`);

  const r15 = mulberry32(0xd15), V = [-3, -2, -1, 0, 1, 2, 3, 5, -0.5, 0.25, 0.001, -0.001], pk = <T,>(a: T[]) => a[Math.floor(r15() * a.length)];
  const reach15: Record<string, number> = { frames: 0, drawn: 0, cycles: 0, regretClamps: 0, splits: 0, shrinkConv: 0 };
  for (let i = 0; i < 300; i++) {
    const g = commitPayoffs(Object.fromEntries((['a11', 'a12', 'a21', 'a22', 'b11', 'b12', 'b21', 'b22'] as const).map((k) => [k, pk(V)])) as unknown as GamePayoffs);
    const all = computeAllNE(g), pure = all.filter((n) => n.type === 'pure');
    for (const mover of ['A', 'B'] as const) for (const mode of ['shrink', 'regret'] as const) {
      const committed = pure.length === 0 ? null : pure.reduce((b, n) => ((mover === 'A' ? n.eA > b.eA : n.eB > b.eB) ? n : b));
      const step = pk([0.1, 0.333, 0.05, 0.25, 0.007]), s = makeState(pk([0.217, 0, 1, 0.9, 0.5]), pk([0.217, 0, 1, 0.1, 0.5]), g);
      for (let k = 0; k < 400 && !s.converged; k++) {
        const logs: string[] = [], segs = s.pathSegmentsA.length, pts = s.pathSegmentsA.reduce((n, sg) => n + sg.xs.length, 0);
        const pre = [s.cx, s.cy];
        const lastLen = s.pathSegmentsA[segs - 1].xs.length, tip0 = [s.pathSegmentsA[segs - 1].xs.at(-1), s.pathSegmentsA[segs - 1].ys.at(-1)];
        const who = k % 2 === 0 ? mover : mover === 'A' ? 'B' : 'A';
        doStep(g, s, mover, step, all, committed, (m) => logs.push(m), () => {}, () => {}, mode);
        reach15.frames++;
        // The step is the mover's: when its own coordinate changed, its colour is drawn first, then any snap/clamp.
        const first = s.pathSegmentsA[segs - 1].xs.length > lastLen ? s.pathSegmentsA[segs - 1].mover : s.pathSegmentsA[segs]?.mover;
        if (first && r3(who === 'A' ? s.exactX : s.exactY) !== (who === 'A' ? tip0[0] : tip0[1]) && (s.discoveredMixedX === null) === (s.discoveredMixedY === null))
          check('D15 the mover\'s own move is drawn first', first === who, `${mode} ${who} k ${k + 1} ${JSON.stringify(g)} first ${first}`);
        const cyc = logs.some((l) => l.startsWith('↺')), at = `${mode} ${mover} step ${step} k ${k + 1} start (${s.startX},${s.startY}) ${JSON.stringify(g)}`;
        if (cyc) reach15.cycles++;
        if (s.pathSegmentsA.reduce((n, sg) => n + sg.xs.length, 0) - pts > (s.pathSegmentsA.length > segs ? 2 : 1)) reach15.splits++;
        for (const [arr, key] of [[s.pathSegmentsA, 'A'], [s.pathSegmentsB, 'B']] as const) {
          const last = arr.at(-1)!;
          check('D15 the path tip is the sphere, every frame', last.xs.at(-1) === r3(s.exactX) && last.ys.at(-1) === r3(s.exactY), `${at} ${key} tip (${last.xs.at(-1)}, ${last.ys.at(-1)}) exact (${s.exactX}, ${s.exactY})`);
        }
        for (const sg of s.pathSegmentsA) for (let j = 1; j < sg.xs.length; j++)
          check('D15 a recorded A move changes only x, a B move only y', (sg.mover === 'A' ? sg.ys : sg.xs)[j] === (sg.mover === 'A' ? sg.ys : sg.xs)[j - 1], `${at} ${sg.mover} (${sg.xs[j - 1]},${sg.ys[j - 1]})->(${sg.xs[j]},${sg.ys[j]})`);
        const now = logs.find((l) => /^↺ Cycle \d+ → domain/.test(l));
        if (now) check('D15 a shrink cycle line states the clamped position', now.endsWith(`now x=${fmtProbFixed(s.exactX)}, y=${fmtProbFixed(s.exactY)}`), `${at} ${now} cx (${s.cx}, ${s.cy})`);
        if (k % 3 && !cyc && !s.converged) continue;
        reach15.drawn++;
        const T = makeTraces(dummySurf, g, s, 'both', all, false, mode) as any[], [lo, hi, ylo, yhi] = box(T), [px, py] = sph(T);
        check('D15 no drawn move line changes the other player\'s axis', offAxis(T).length === 0, `${at} ${offAxis(T)[0]}`);
        const oneFound = (s.discoveredMixedX !== null) !== (s.discoveredMixedY !== null), regretBox = mode === 'regret' && !pure.length;
        if (regretBox && cyc && (pre[0] < lo || pre[0] > hi || pre[1] < ylo || pre[1] > yhi)) reach15.regretClamps++;
        if (mode === 'shrink' && s.converged && s.discoveredMixedX !== null && s.discoveredMixedY !== null) reach15.shrinkConv++;
        // Shrink's phase-2 square is the ghost's corridor: only the unfound axis lives in it (the found one is locked).
        const inX = px >= lo - 1e-9 && px <= hi + 1e-9, inY = py >= ylo - 1e-9 && py <= yhi + 1e-9;
        const ok = mode === 'shrink' && oneFound ? (s.discoveredMixedX !== null ? inY : inX) : !pure.length || mode === 'shrink' ? inX && inY : true;
        check('D15 the sphere is inside the drawn box', ok, `${at} sphere (${px}, ${py}) box [${lo},${hi}]x[${ylo},${yhi}]`);
      }
    }
  }
  check('D15 reach: cycle, regret-clamp, split-move and shrink-convergence frames drawn', reach15.frames >= 10000 && reach15.cycles >= 1800 && reach15.regretClamps >= 800 && reach15.splits >= 900 && reach15.shrinkConv >= 35, JSON.stringify(reach15));   // measured 12321/2183/1042/1126/45
}

// ── D16 (sweep 10 HIT): the panel, the Step/cycle/━━ lines, the sphere and the banner print ONE point ─────────────
// The panel and Step line formatted r3-collapsed cx/cy: "y=1.000" for 0.9996 (sub-resolution rule), and at
// convergence 0.219 / E[A] 0.332 beside the banner's and ━━ line's 0.22 / 0.333. The panel's source is pinned
// below so the fuzz, which models it through shownPoint, models what App.tsx renders.
{
  const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
  check('D16 the App readout boxes render shownPoint', ['{fmtProbFixed(shown.x)}', '{fmtProbFixed(shown.y)}', '{fmtPayoff(EA(shown.x, shown.y, payoffs))}', '{fmtPayoff(EB(shown.x, shown.y, payoffs))}'].every((t) => app.includes(t)) && app.includes('shownPoint(payoffs, simState)'));
  const run = (g: GamePayoffs, mode: 'shrink' | 'regret', mover: 'A' | 'B', step: number, x: number, y: number, k: number) => {
    const s = makeState(x, y, g), all = computeAllNE(g); let logs: string[] = [];
    for (let i = 0; i < k && !s.converged; i++) { logs = []; doStep(g, s, mover, step, all, null, (m) => logs.push(m), () => {}, () => {}, mode); }
    const p = shownPoint(g, s), a = (makeTraces(dummySurf, g, s, 'both', all, false, mode) as any[]).find((t) => t.name === 'Current position (A)');
    return { s, logs, panel: [fmtProbFixed(p.x), fmtProbFixed(p.y), fmtPayoff(EA(p.x, p.y, g)), fmtPayoff(EB(p.x, p.y, g))].join(' '), sphere: [a.x[0], a.y[0]] };
  };
  // (a) verbatim: "Step 1 (A): x=0.000, y=1.000  E[A]=3.000" for exact (0, 0.9996).
  const fa = run({ a11: -0.001, a12: 0.25, a21: 3, a22: 0, b11: -3, b12: 0.001, b21: -0.001, b22: 3 }, 'regret', 'A', 0.05, 0.0004, 0.9996, 1);
  check('D16 (a) verbatim: fixture is at exact (0, 0.9996), r3 (0, 1)', fa.s.exactY === 0.9996 && fa.s.cy === 1, `${fa.s.exactY} ${fa.s.cy}`);
  check('D16 (a) verbatim: the Step line says more than 0.999', fa.logs[0] === 'Step 1 (A): x=0.000, y=more than 0.999  E[A]=2.999  E[B]=less than 0.001', fa.logs[0]);
  check('D16 (a) verbatim: the panel says more than 0.999', fa.panel === '0.000 more than 0.999 2.999 less than 0.001', fa.panel);
  // (b) verbatim: panel "0.219" / E[A] "-0.025" under "━━ Mixed NE: x=0.8, y=0.22  E[A]=-0.024".
  const fb = run({ a11: -1, a12: 0.25, a21: 7, a22: -2, b11: 1, b12: 0.25, b21: -0.001, b22: 3 }, 'shrink', 'A', 0.05, 1, 0.1, 9999);
  check('D16 (b) verbatim: fixture converges at r3 (0.8, 0.219) with the ━━ line', fb.s.converged && fb.s.cy === 0.219 && fb.logs.includes('━━ Mixed NE: x=0.8, y=0.22  E[A]=-0.024  E[B]=0.800'), fb.logs.join(' | '));
  check('D16 (b) verbatim: the panel prints the ━━ line\'s point', fb.panel === '0.800 0.220 -0.024 0.800', fb.panel);
  // (c) verbatim: panel E[A] "0.332" beside the sphere's and ━━ line's 0.333.
  const fc = run({ a11: 3, a12: -1, a21: 5, a22: -2, b11: -1, b12: -2, b21: -3, b22: 0.25 }, 'shrink', 'A', 0.007, 0, 1, 9999);
  check('D16 (c) verbatim: fixture converges with ━━ E[A]=0.333', fc.s.converged && fc.logs.includes('━━ Mixed NE: x=0.765, y=0.333  E[A]=0.333  E[B]=-1.471'), fc.logs.join(' | '));
  check('D16 (c) verbatim: the panel prints E[A] 0.333', fc.panel === '0.765 0.333 0.333 -1.471', fc.panel);
  // A finished run from an edited game (stale) is not moved onto the new game's equilibria.
  const sd = makeState(0.5, 0.5, { a11: 0, a12: 0, a21: 0, a22: 0, b11: 0, b12: 0, b21: 0, b22: 0 });
  Object.assign(sd, { exactX: 0.1, exactY: 0.1, converged: true, convergedIsNE: true });
  const pd = shownPoint({ a11: -1, a12: 0.25, a21: 7, a22: -2, b11: 1, b12: 0.25, b21: -0.001, b22: 3 }, sd);
  check('D16 a converged point more than 1e-3 from every equilibrium is shown where it stopped', pd.x === 0.1 && pd.y === 0.1, `${pd.x} ${pd.y}`);
  // Contract (state built directly; 0 reached in ~1M fuzz frames, probes/s10-survivors.log): a stop at the vertex
  // (0, 0) is tested exactly (1e-9), so B's regret 0.001 makes it NOT-NE, 4e-4 from the continuum end (0.0004, 0).
  // Snapping would print an equilibrium's digits under "NOT an equilibrium"; rn proves the member is within 1e-3.
  const gn = { a11: 1, a12: 0, a21: 0, a22: 0, b11: -2.499, b12: 0, b21: 0.001, b22: 0 }, rn = resolveProfile(gn, { exactX: 0, exactY: 0 } as SimState);
  const pn = shownPoint(gn, { exactX: 0, exactY: 0, converged: true, convergedIsNE: false });
  check('D16 a NOT-NE stop is shown where it stopped, not on the equilibrium 4e-4 away', rn.x > 0 && rn.x < 1e-3 && pn.x === 0 && pn.y === 0, `${rn.x} ${pn.x}`);
  // Contract (state built directly): a mixed-branch stop on a discovered NOT-NE point used to print the solver's NE
  // (0.5, 0.5) beside "NOT an equilibrium"; the line names where it stopped, as the panel does.
  for (const mode of ['shrink', 'regret'] as const) {
    const gm = { a11: 1, a12: -1, a21: -1, a22: 1, b11: -1, b12: 1, b21: 1, b22: -1 }, sm = makeState(0.1, 0.1, gm), lm: string[] = [];
    Object.assign(sm, { discoveredMixedX: 0.1, discoveredMixedY: 0.1, foundAxis: 'x' });
    doStep(gm, sm, 'A', 0.1, computeAllNE(gm), null, (m) => lm.push(m), () => {}, () => {}, mode);
    check(`D16 ${mode}: a NOT-NE mixed-branch stop names where it stopped`, lm.at(-1) === '━━ Settled at x=0.1, y=0.1 — NOT an equilibrium (a player still gains 1.440 by switching)  E[A]=0.640  E[B]=-0.640', lm.join(' | '));
  }
  // (e) verbatim, seed-2606 fuzz: ━━ printed the exact "y=more than 0.999  E[A]=6.999" beside the banner's (0.5, 1).
  const fe = run({ a11: 7, a12: 5, a21: 7, a22: 2, b11: 3, b12: -1, b21: -3, b22: 1 }, 'regret', 'B', 0.25, 0.5, 0.9996, 9999);
  check('D16 (e) verbatim: the ━━ line names the banner\'s point (0.5, 1)', fe.s.exactY === 0.9996 && fe.logs.at(-1) === '━━ Settled on the equilibrium continuum at x=0.5, y=1: A continuum of equilibria: B plays Col 1 while A mixes with x anywhere from 0.5 to 1.  E[A]=7.000  E[B]=0', fe.logs.join(' | '));
  check('D16 (e) verbatim: the panel prints that point', fe.panel === '0.500 1.000 7.000 0', fe.panel);
  // No rendering formats the r3-collapsed dynamics inputs (cycle "now" lines included: equal digits on every reached
  // frame today, 0 of ~160k, so only this pin keeps them on the exact point).
  const eng = readFileSync(new URL('./utils/gameEngine.ts', import.meta.url), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  check('D16 no engine rendering formats s.cx/s.cy', !/fmt\w*\(\s*(s|state)\.c[xy]\b|E[AB]\(\s*(s|state)\.cx\b/.test(eng), (/.*fmt\w*\(\s*(s|state)\.c[xy]\b.*|.*E[AB]\(\s*(s|state)\.cx\b.*/.exec(eng) ?? [''])[0].trim());

  const num = (t: string) => (/^-?[\d.]+$/.test(t) ? String(+t) : t);
  const r16 = mulberry32(0xd16), V = [-3, -2, -1, 0, 1, 2, 3, 5, -0.5, 0.25, 0.001, -0.001, 7, 0.0004, -0.0004], pk = <T,>(a: T[]) => a[Math.floor(r16() * a.length)];
  const reach16 = { frames: 0, cxDiffers: 0, cycleNow: 0, conv: 0, subres: 0 };
  for (let i = 0; i < 400; i++) {
    const g = commitPayoffs(Object.fromEntries((['a11', 'a12', 'a21', 'a22', 'b11', 'b12', 'b21', 'b22'] as const).map((k) => [k, pk(V)])) as unknown as GamePayoffs);
    const all = computeAllNE(g), pure = all.filter((n) => n.type === 'pure');
    for (const mover of ['A', 'B'] as const) for (const mode of ['shrink', 'regret'] as const) {
      const committed = pure.length === 0 ? null : pure.reduce((b, n) => ((mover === 'A' ? n.eA > b.eA : n.eB > b.eB) ? n : b));
      const step = pk([0.1, 0.333, 0.05, 0.25, 0.007, 0.5]), s = makeState(pk([0.217, 0, 1, 0.9, 0.5, 0.0004]), pk([0.217, 0, 1, 0.1, 0.5, 0.9996]), g);
      for (let k = 0; k < 3000 && !s.converged; k++) {
        const logs: string[] = [];
        doStep(g, s, mover, step, all, committed, (m) => logs.push(m), () => {}, () => {}, mode);
        const p = shownPoint(g, s), pos = [...logs].reverse().find((l) => /^(Step |↺ Cycle .* now x=|━━)/.test(l)) ?? '';
        const xm = /x=([^,]+), y=([^\s,:]+(?: than [^\s,:]+)?)/.exec(pos), pm = /E\[A\]=(.+?) {2}E\[B\]=(.+)$/.exec(pos);
        const at = `${mode} ${mover} step ${step} k ${k + 1} start (${s.startX},${s.startY}) ${JSON.stringify(g)} exact (${s.exactX}, ${s.exactY}) shown (${p.x}, ${p.y}) | ${pos}`;
        reach16.frames++; if (p.x !== s.cx || p.y !== s.cy) reach16.cxDiffers++; if (/now x=/.test(pos)) reach16.cycleNow++; if (s.converged) reach16.conv++;
        if ([s.exactX, s.exactY].some((v) => v !== 0 && v !== 1 && (r3(v) === 0 || r3(v) === 1))) reach16.subres++;
        check('D16 every frame logs a positional line', !!xm, at);
        if (!xm) continue;
        check('D16 the panel x/y read as the last positional line', [fmtProbFixed(p.x), fmtProbFixed(p.y)].map(num).join() === [xm[1], xm[2]].map(num).join(), at);
        if (pm && !/NOT an/.test(pos)) check('D16 the panel E[A]/E[B] read as the last positional line', fmtPayoff(EA(p.x, p.y, g)) === pm[1] && fmtPayoff(EB(p.x, p.y, g)) === pm[2], at);
        for (const v of [p.x, p.y]) check('D16 the panel never prints a vertex for a non-vertex', !((fmtProbFixed(v) === '0.000' || fmtProbFixed(v) === '1.000') && v !== 0 && v !== 1), at);
        if (s.converged && s.convergedIsNE !== false) {
          const r = resolveProfile(g, s);
          check('D16 at convergence the panel shows the banner\'s point', p.x === r.x && p.y === r.y, at);
          const a = (makeTraces(dummySurf, g, s, 'both', all, false, mode) as any[]).find((t) => t.name === 'Current position (A)');
          check('D16 at convergence the sphere is the panel\'s point', a.x[0] === p.x && a.y[0] === p.y, `${at} sphere (${a.x[0]}, ${a.y[0]})`);
        }
      }
    }
  }
  check('D16 reach: frames where cx differs from the shown point, cycle "now" lines, convergences, sub-resolution frames', reach16.frames >= 16000 && reach16.cxDiffers >= 280 && reach16.cycleNow >= 300 && reach16.conv >= 1300 && reach16.subres >= 220, JSON.stringify(reach16));
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
