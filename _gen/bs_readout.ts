/**
 * BLUE-SERVER: reproduce the "live readout vs equilibrium panel" disagreement
 * from scratch. No peer's number is taken on trust.
 *
 * The two boxes, as App.tsx actually renders them:
 *   readout (always visible, ~line 3628):
 *       fmtPayoff(EB(simState.cx, simState.cy, payoffs))   <- the RUN's landing point
 *   panel  (converged box, ~line 3672):
 *       payoffTexRhs(EB(resolved.x, resolved.y, payoffs))  <- the EXACT solver root
 *
 * They sit ~40px apart, both labelled with E[B].
 */
import { GamePayoffs, SimState, PathSegment } from '../src/types';
import { doStep, computeAllNE, EA, EB, r3, resolveProfile, fmtPayoff, payoffTexRhs } from '../src/utils/gameEngine';

function createInitialState(startX: number, startY: number, g: GamePayoffs): SimState {
  return {
    cx: startX, cy: startY, exactX: startX, exactY: startY, calcX: startX, calcY: startY,
    displayX: startX, displayY: startY, startX, startY,
    domainLo: 0, domainHi: 1, domXLo: 0, domXHi: 1, domYLo: 0, domYHi: 1,
    stratX: startX, stratY: startY, cycleCount: 0, visitedPositions: [], ghostVisitedPositions: [],
    discoveredMixedX: null, discoveredMixedY: null, foundAxis: null,
    running: false, converged: false, stepCount: 0,
    pathSegmentsA: [{ xs: [startX], ys: [startY], zs: [r3(EA(startX, startY, g))], mover: 'A' }],
    pathSegmentsB: [{ xs: [startX], ys: [startY], zs: [r3(EB(startX, startY, g))], mover: 'A' }],
    phase1PtsA: null, phase1PtsB: null, ghostPathSegmentsA: [], ghostPathSegmentsB: [],
    cyclePattern: null, bisecting: false, bisectGoodLo: 0, bisectGoodHi: 1, bisectBadLo: 0, bisectBadHi: 1,
    ghostCyclePattern: null, ghostBisecting: false, ghostBisectGoodLo: 0, ghostBisectGoodHi: 1,
    ghostBisectBadLo: 0, ghostBisectBadHi: 1
  } as SimState;
}

function run(g: GamePayoffs, firstMover: 'A' | 'B', stepMode: 'shrink' | 'regret', lambda: number) {
  const st = createInitialState(0.217, 0.217, g);
  const allNE = computeAllNE(g);
  const pureNEs = allNE.filter(n => n.type === 'pure');
  const committedNE = pureNEs.length > 0
    ? pureNEs.reduce((best, ne) => {
        const my = firstMover === 'A' ? ne.eA : ne.eB;
        const bs = firstMover === 'A' ? best.eA : best.eB;
        return my > bs ? ne : best;
      })
    : null;
  for (let i = 0; i < 20000 && !st.converged; i++) {
    doStep(g, st, firstMover, lambda, allNE, committedNE, () => {}, () => {}, () => {}, stepMode);
  }
  return st.converged ? st : null;
}

// Strip the TeX "= " / "\approx " prefix payoffTexRhs emits so the two boxes
// are compared as the USER sees them: two rendered numbers.
function panelNum(s: string): string {
  return s.replace(/^\s*(\\approx|=)\s*/, '').trim();
}

const bound = Number(process.env.BOUND ?? 9);
const N = Number(process.env.N ?? 600);
let seed = Number(process.env.SEED ?? 12345);
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = () => Math.round((rnd() * 2 - 1) * bound);

let mixedPanels = 0, disagreeB = 0, disagreeA = 0, disagreeEither = 0;
let worstGap = 0; const samples: string[] = [];

for (let t = 0; t < N; t++) {
  const g: GamePayoffs = { a11: ri(), a12: ri(), a21: ri(), a22: ri(), b11: ri(), b12: ri(), b21: ri(), b22: ri() };
  for (const fm of ['A', 'B'] as const) {
    for (const [mode, lam] of [['shrink', 0.01], ['regret', 0.3]] as const) {
      const st = run(g, fm, mode as 'shrink' | 'regret', lam);
      if (!st) continue;
      // THE PANEL'S ACTUAL GATE (App.tsx:3645). Without this the corpus
      // includes runs the app never shows a panel for.
      if (st.convergedIsNE === false) continue;
      const resolved = resolveProfile(g, st);
      if (resolved.concept !== 'mixed') continue;   // the panel's caveat is mixed-only
      mixedPanels++;
      const readB = fmtPayoff(EB(st.cx, st.cy, g));
      const panB = panelNum(payoffTexRhs(EB(resolved.x, resolved.y, g)));
      const readA = fmtPayoff(EA(st.cx, st.cy, g));
      const panA = panelNum(payoffTexRhs(EA(resolved.x, resolved.y, g)));
      const dB = readB !== panB, dA = readA !== panA;
      if (dB) disagreeB++;
      if (dA) disagreeA++;
      if (dA || dB) {
        disagreeEither++;
        const gap = Math.max(
          Math.abs(EB(st.cx, st.cy, g) - EB(resolved.x, resolved.y, g)),
          Math.abs(EA(st.cx, st.cy, g) - EA(resolved.x, resolved.y, g)));
        if (gap > worstGap) worstGap = gap;
        if (samples.length < 6) samples.push(
          `  A=[[${g.a11},${g.a12}],[${g.a21},${g.a22}]] B=[[${g.b11},${g.b12}],[${g.b21},${g.b22}]] ${fm}/${mode}\n` +
          `      readout  E[A]=${readA}  E[B]=${readB}   (cx=${st.cx.toFixed(6)}, cy=${st.cy.toFixed(6)})\n` +
          `      panel    E[A]=${panA}  E[B]=${panB}   (x*=${resolved.x.toFixed(6)}, y*=${resolved.y.toFixed(6)})`);
      }
    }
  }
}

const pct = (n: number) => mixedPanels ? (100 * n / mixedPanels).toFixed(1) + '%' : 'n/a';
console.log(`corpus: ${N} random games x 2 movers x {shrink 0.01, regret 0.3}, int[-${bound},${bound}], seed ${process.env.SEED ?? 12345}`);
console.log(`converged MIXED panels: ${mixedPanels}`);
console.log(`  readout E[B] != panel E[B]: ${disagreeB} (${pct(disagreeB)})`);
console.log(`  readout E[A] != panel E[A]: ${disagreeA} (${pct(disagreeA)})`);
console.log(`  either disagrees:           ${disagreeEither} (${pct(disagreeEither)})`);
console.log(`  worst |readout - panel|:    ${worstGap.toExponential(3)}`);
console.log('samples:'); samples.forEach(s => console.log(s));
