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
  EA, EB, r3, regretA, regretB, neTolerancePlayer, computeMixedNE, fmtProb, fmtPayoff, commitPayoffs,
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
