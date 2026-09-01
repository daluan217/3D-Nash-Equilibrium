/**
 * REACH of the equilibrium-panel defects, measured through the SHIPPED path.
 *
 * Runs `doStep` to convergence exactly as App.tsx does, then renders the panel
 * lines both the OLD way (simState.cx/cy, the 3dp display coordinate) and the
 * NEW way (resolveProfile's exact coordinate), and counts the disagreements.
 */
import {
  PRESETS, doStep, r3, resolveProfile, indifferenceAt, fmtPayoffPair,
  computeAllNE, EA, EB, fmtPayoff,
} from '../src/utils/gameEngine';
import type { GamePayoffs, SimState, NashEquilibrium } from '../src/types';
import { indifferenceLines } from '../src/components/equilibriumPanel';

// ── the panel EXACTLY as it read before this branch ──
function oldLines(g: GamePayoffs, cx: number, cy: number) {
  const ind = indifferenceAt(g, cx, cy);
  const mk = (p: number, q: number, on: boolean) => {
    const f = fmtPayoffPair(p, q);
    return { indifferent: on, pStr: f.p, qStr: f.q,
             relation: on ? '\\approx' : (p > q ? '>' : '<') };
  };
  return {
    a: mk(cy * g.a11 + (1 - cy) * g.a12, cy * g.a21 + (1 - cy) * g.a22, ind.a),
    b: mk(cx * g.b11 + (1 - cx) * g.b21, cx * g.b12 + (1 - cx) * g.b22, ind.b),
  };
}

function createInitialState(startX: number, startY: number, g: GamePayoffs): SimState {
  return {
    cx: startX,
    cy: startY,
    exactX: startX,
    exactY: startY,
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
    ghostBisectBadHi: 1
  };
}

// The shipped run loop, same wiring App.tsx uses.
function run(g: GamePayoffs, firstMover: 'A' | 'B', stepMode: 'shrink' | 'regret'): SimState {
  const state = createInitialState(0.217, 0.217, g);
  const allNE = computeAllNE(g);
  const pure = allNE.filter((n: NashEquilibrium) => n.type === 'pure');
  const committed = pure.length > 0
    ? pure.reduce((best: NashEquilibrium, ne: NashEquilibrium) => {
        const mine = firstMover === 'A' ? ne.eA : ne.eB;
        const theirs = firstMover === 'A' ? best.eA : best.eB;
        return mine > theirs ? ne : best;
      })
    : null;
  for (let i = 0; i < 20000 && !state.converged; i++) {
    doStep(g, state, firstMover, 0.01, allNE, committed, () => {}, () => {}, () => {}, stepMode);
  }
  return state;
}

interface Row { g: GamePayoffs; mover: 'A' | 'B'; mode: 'shrink' | 'regret'; s: SimState }

const rows: Row[] = [];
const rnd = (() => { let a = 20260901 >>> 0; return () => {
  a = (a + 0x6D2B79F5) >>> 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
const games: { name: string; g: GamePayoffs }[] = [];
for (const k of Object.keys(PRESETS)) games.push({ name: PRESETS[k].name, g: PRESETS[k] as GamePayoffs });
const N = Number(process.env.N ?? 400);
const SCALE = Number(process.env.SCALE ?? 10);
for (let i = 0; i < N; i++) {
  const v = () => Math.round((rnd() * 2 - 1) * SCALE);
  games.push({ name: `rand${i}`, g: { a11: v(), a12: v(), a21: v(), a22: v(), b11: v(), b12: v(), b21: v(), b22: v() } as GamePayoffs });
}

for (const { g } of games) {
  for (const mover of ['A', 'B'] as const) {
    for (const mode of ['shrink', 'regret'] as const) {
      const s = run(g, mover, mode);
      if (s.converged && s.convergedIsNE !== false) rows.push({ g, mover, mode, s });
    }
  }
}

// ── D1: an "indifferent" line printing two different numbers ────────────────
let rendered = 0, oldBad = 0, newBad = 0, oldWorst = 0, newWorst = 0;
let oldBadPreset = 0, newBadPreset = 0, presetLines = 0;
let expo = 0;   // fmtPayoffPair's exponential fallback reaching the screen
const presetNames = new Set(Object.keys(PRESETS).map((k) => PRESETS[k].name));
for (const { g, s } of rows) {
  const res = resolveProfile(g, s);
  if (res.concept !== 'mixed') continue;
  const nw = indifferenceLines(g, res.x, res.y);
  const ol = oldLines(g, s.cx, s.cy);
  const isPreset = games.some((q) => presetNames.has(q.name) && q.g === g);
  for (const side of ['a', 'b'] as const) {
    rendered++;
    if (isPreset) presetLines++;
    const o = ol[side], n = nw[side];
    if (o.indifferent && o.pStr !== o.qStr) { oldBad++; if (isPreset) oldBadPreset++;
      oldWorst = Math.max(oldWorst, Math.abs(Number(o.pStr) - Number(o.qStr))); }
    if (n.indifferent && n.pStr !== n.qStr) { newBad++; if (isPreset) newBadPreset++;
      newWorst = Math.max(newWorst, Math.abs(Number(n.pStr) - Number(n.qStr)));
      if (process.env.DUMP) console.error('RESIDUAL', side, JSON.stringify(g), 'resolved', res.x, res.y, res.concept,
        n.pStr, n.qStr, 'exactgap', Math.abs(n.p - n.q)); }
    if (/e[+-]/.test(n.pStr) || /e[+-]/.test(n.qStr)) expo++;
  }
}

// ── D2: ne.eA/eB pre-rounded to a FALSE ZERO in the report list ─────────────
let neTotal = 0, neFalseZero = 0, neMixedTotal = 0, neMixedFalseZero = 0;
for (let i = 0; i < 200000; i++) {
  const v = () => Math.round((rnd() * 2 - 1) * 3000) / 1000;   // ±3.000, 3dp — the matrix's own grid
  const g = { a11: v(), a12: v(), a21: v(), a22: v(), b11: v(), b12: v(), b21: v(), b22: v() } as GamePayoffs;
  for (const ne of computeAllNE(g)) {
    neTotal++;
    if (ne.type === 'mixed') neMixedTotal++;
    for (const [stored, exact] of [[ne.eA, EA(ne.x, ne.y, g)], [ne.eB, EB(ne.x, ne.y, g)]] as const) {
      const shipped = stored.toFixed(3);                 // what main prints today
      const viaFmt = fmtPayoff(stored);                  // what a naive fmtPayoff swap prints
      const fixed = fmtPayoff(exact);                    // what recomputing prints
      if (exact !== 0 && (shipped === '0.000' || shipped === '-0.000' || viaFmt === '0')) {
        if (fixed !== shipped) { neFalseZero++; if (ne.type === 'mixed') neMixedFalseZero++; }
      }
    }
  }
}

console.log(JSON.stringify({
  convergedRuns: rows.length,
  renderedIndifferenceLines: rendered,
  D1_old_indifferent_but_different: oldBad,
  D1_old_rate: (100 * oldBad / rendered).toFixed(1) + '%',
  D1_old_worst_gap: oldWorst.toFixed(3),
  D1_new_indifferent_but_different: newBad,
  D1_new_rate: (100 * newBad / rendered).toFixed(1) + '%',
  D1_new_worst_gap: newWorst.toFixed(3),
  D1_preset_lines: presetLines, D1_preset_old_bad: oldBadPreset, D1_preset_new_bad: newBadPreset,
  D1_exponential_fallback_on_screen: expo,
  D2_ne_entries: neTotal, D2_false_zero: neFalseZero,
  D2_mixed_entries: neMixedTotal, D2_mixed_false_zero: neMixedFalseZero,
  D2_mixed_rate: (100 * neMixedFalseZero / neMixedTotal).toFixed(2) + '%',
}, null, 2));
