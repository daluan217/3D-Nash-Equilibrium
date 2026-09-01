/**
 * The converged log line, `gameEngine.ts:~1578`. NOT my file — measured so the
 * owner gets a rate and a fixture rather than a hunch.
 *
 *   const lx = fmtProb(exact ? exact.x : s.cx);      // EXACT mixed NE
 *   const finalEA = r3(EA(s.cx, s.cy, g));           // the r3-collapsed run point
 *
 * Two claims, one line, two coordinate sources — the same shape as the panel
 * defect. And the SECOND branch uses `lx`/`ly` too, where `exact` is the mixed
 * NE but the run demonstrably did NOT settle there.
 */
import {
  PRESETS, doStep, computeAllNE, computeMixedNE, resolveProfile, EA, EB, r3, fmtProb,
  neTolerancePlayer, regretA, regretB,
} from '../src/utils/gameEngine';
import type { GamePayoffs, SimState, NashEquilibrium } from '../src/types';

function createInitialState(startX: number, startY: number, g: GamePayoffs): SimState {
  return { cx: startX, cy: startY, exactX: startX, exactY: startY, calcX: startX, calcY: startY,
    displayX: startX, displayY: startY, startX, startY, domainLo: 0, domainHi: 1,
    domXLo: 0, domXHi: 1, domYLo: 0, domYHi: 1, stratX: startX, stratY: startY, cycleCount: 0,
    visitedPositions: [], ghostVisitedPositions: [], discoveredMixedX: null, discoveredMixedY: null,
    foundAxis: null, running: false, converged: false, stepCount: 0,
    pathSegmentsA: [{ xs: [startX], ys: [startY], zs: [r3(EA(startX, startY, g))], mover: 'A' }],
    pathSegmentsB: [{ xs: [startX], ys: [startY], zs: [r3(EB(startX, startY, g))], mover: 'A' }],
    phase1PtsA: null, phase1PtsB: null, ghostPathSegmentsA: [], ghostPathSegmentsB: [],
    cyclePattern: null, bisecting: false, bisectGoodLo: 0, bisectGoodHi: 1, bisectBadLo: 0, bisectBadHi: 1,
    ghostCyclePattern: null, ghostBisecting: false, ghostBisectGoodLo: 0, ghostBisectGoodHi: 1,
    ghostBisectBadLo: 0, ghostBisectBadHi: 1 } as unknown as SimState;
}
function converge(g: GamePayoffs, fm: 'A'|'B', mode: 'shrink'|'regret', step: number, sx: number, sy: number) {
  const st = createInitialState(sx, sy, g);
  const all = computeAllNE(g);
  const pure = all.filter((n: NashEquilibrium) => n.type === 'pure');
  const com = pure.length ? pure.reduce((b: NashEquilibrium, n: NashEquilibrium) =>
    ((fm === 'A' ? n.eA : n.eB) > (fm === 'A' ? b.eA : b.eB) ? n : b)) : null;
  for (let i = 0; i < 20000 && !st.converged; i++) doStep(g, st, fm, step, all, com, () => {}, () => {}, () => {}, mode);
  return st;
}
function mk(s: number){let a=s>>>0;return()=>{a=(a+0x6D2B79F5)>>>0;let t=Math.imul(a^(a>>>15),1|a);
  t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}

for (const SCALE of [10, 100]) {
  const rnd = mk(31337 + SCALE);
  let mixedRuns = 0, payoffMismatch = 0, worstPayoff = 0;
  let settledRuns = 0, settledWrongCoord = 0, worstCoord = 0;
  const examples: string[] = [];
  const STARTS: [number, number][] = [[0.217,0.217],[0.02,0.98],[0.5,0.5],[0.95,0.05],[0.01,0.01],[0.99,0.99]];
  const STEPS = [0.001, 0.01, 0.1, 0.3];
  for (let i = 0; i < 120; i++) {
    const v = () => Math.round((rnd() * 2 - 1) * SCALE);
    const g = { a11:v(),a12:v(),a21:v(),a22:v(),b11:v(),b12:v(),b21:v(),b22:v() } as GamePayoffs;
    for (const fm of ['A','B'] as const) for (const mode of ['shrink','regret'] as const)
    for (const [sx0, sy0] of STARTS) for (const stp of STEPS) {
      const st = converge(g, fm, mode, stp, sx0, sy0);
      if (!st.converged) continue;
      const exact = computeMixedNE(g);
      if (!exact) continue;
      const lx = fmtProb(exact.x), ly = fmtProb(exact.y);
      const finalEA = r3(EA(st.cx, st.cy, g)), finalEB = r3(EB(st.cx, st.cy, g));
      const trueEA = r3(EA(exact.x, exact.y, g)), trueEB = r3(EB(exact.x, exact.y, g));
      const isNE = Math.abs(regretA(st.cx, st.cy, g)) <= neTolerancePlayer(g,'A')
                && Math.abs(regretB(st.cx, st.cy, g)) <= neTolerancePlayer(g,'B');
      if (isNE) {
        const res = resolveProfile(g, st);
        if (res.concept !== 'mixed') continue;
        mixedRuns++;
        if (finalEA.toFixed(3) !== trueEA.toFixed(3) || finalEB.toFixed(3) !== trueEB.toFixed(3)) {
          payoffMismatch++;
          worstPayoff = Math.max(worstPayoff, Math.abs(finalEA - trueEA), Math.abs(finalEB - trueEB));
          if (examples.length < 2) examples.push(
            `LOG  "Mixed NE: x=${lx}, y=${ly}  E[A]=${finalEA.toFixed(3)}"  vs PANEL E[A]=${trueEA.toFixed(3)}  ${JSON.stringify(g)}`);
        }
      } else {
        settledRuns++;
        // The "Settled ... NOT an equilibrium" branch prints the MIXED NE's
        // coordinates while asserting the run settled at them.
        if (lx !== fmtProb(st.cx) || ly !== fmtProb(st.cy)) {
          settledWrongCoord++;
          worstCoord = Math.max(worstCoord, Math.abs(exact.x - st.cx), Math.abs(exact.y - st.cy));
          if (examples.length < 4) examples.push(
            `SETTLED "at x=${lx}, y=${ly}" but the run is at (${st.cx.toFixed(3)}, ${st.cy.toFixed(3)})  ${JSON.stringify(g)}`);
        }
      }
    }
  }
  console.log(JSON.stringify({ SCALE,
    convergedMixedNEruns: mixedRuns,
    logPayoffDisagreesWithPanel: payoffMismatch,
    rate: mixedRuns ? (100*payoffMismatch/mixedRuns).toFixed(1)+'%' : 'n/a',
    worstPayoffGap: worstPayoff.toFixed(3),
    settledNotNEruns: settledRuns,
    settledPrintsCoordsTheRunNeverReached: settledWrongCoord,
    settledRate: settledRuns ? (100*settledWrongCoord/settledRuns).toFixed(1)+'%' : 'n/a',
    worstCoordGap: worstCoord.toFixed(3),
    examples }, null, 1));
}
