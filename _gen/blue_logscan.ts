import { computeAllNE, doStep, EA, EB, r3, regretA, regretB, neTolerancePlayer } from '../src/utils/gameEngine';
import type { GamePayoffs, SimState } from '../src/types';
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

function runLogs(g: GamePayoffs, o: {firstMover?:'A'|'B'; shrinkStep?:number; stepMode?:'shrink'|'regret'} = {}) {
  const logs: string[] = [];
  const st = createInitialState(0.217, 0.217, g);
  const allNE = computeAllNE(g);
  const pure = allNE.filter(n => n.type === 'pure');
  const fm = o.firstMover ?? 'A';
  const committed = pure.length ? pure.reduce((b, n) => ((fm === 'A' ? n.eA : n.eB) > (fm === 'A' ? b.eA : b.eB) ? n : b)) : null;
  for (let i = 0; i < 20000 && !st.converged; i++)
    doStep(g, st, fm, o.shrinkStep ?? 0.01, allNE, committed, (m: string) => logs.push(m), () => {}, () => {}, o.stepMode ?? 'shrink');
  return { st, logs };
}

const vals = [-0.003, -0.002, -0.001, 0, 0.001, 0.002, 0.003];
const pick = () => vals[Math.floor(Math.random() * vals.length)];
let contra = 0, zeroPay = 0, runs = 0;
const ex: string[] = [];
for (let t = 0; t < 1500; t++) {
  const g: GamePayoffs = { a11:pick(),a12:pick(),a21:pick(),a22:pick(),b11:pick(),b12:pick(),b21:pick(),b22:pick() };
  for (const mode of ['shrink','regret'] as const) {
    let r; try { r = runLogs(g, { stepMode: mode, shrinkStep: 0.01 }); } catch { continue; }
    if (!r.st.converged) continue;
    runs++;
    for (const line of r.logs) {
      if (/still gains -?0\.000 by switching/.test(line)) {
        contra++;
        if (ex.length < 4) ex.push(`SELF-CONTRADICTION [${mode}] ${JSON.stringify(g)}\n      ${line.trim()}`);
      }
      if (/E\[A\]=-?0\.000\b/.test(line) && EA(r.st.cx, r.st.cy, g) !== 0) {
        zeroPay++;
        if (ex.length < 8) ex.push(`ZERO-PRINT [${mode}] true E[A]=${EA(r.st.cx, r.st.cy, g)}\n      ${line.trim()}`);
      }
    }
  }
}
console.log(`converged runs: ${runs}`);
console.log(`"still gains 0.000 by switching" (self-contradicting): ${contra}`);
console.log(`"E[A]=0.000" while the true payoff is nonzero: ${zeroPay}`);
for (const e of ex) console.log('  ' + e);
