/**
 * BLUE-SERVER: WHY do the readout and the panel disagree?
 *
 * Two candidate causes, and they call for opposite fixes:
 *   (H1) the run genuinely stops short of the exact root, so the two boxes name
 *        two different POINTS -> legitimately different quantities, relabel.
 *   (H2) the readout evaluates E at a coordinate `doStep` already collapsed to
 *        3 dp (`s.cx = r3(...)`), so the disagreement is an artifact of display
 *        rounding fed back into arithmetic -> a bug, evaluate at exactX/exactY.
 *
 * Discriminator: `s.exactX`/`exactY` hold the SAME landing point without the
 * r3 collapse. If E at (exactX, exactY) agrees with the panel where E at
 * (cx, cy) does not, the cause is H2.
 */
import { GamePayoffs, SimState } from '../src/types';
import { doStep, computeAllNE, EA, EB, r3, resolveProfile, fmtPayoff, payoffTexRhs } from '../src/utils/gameEngine';

function init(sx: number, sy: number, g: GamePayoffs): SimState {
  return { cx: sx, cy: sy, exactX: sx, exactY: sy, calcX: sx, calcY: sy, displayX: sx, displayY: sy,
    startX: sx, startY: sy, domainLo: 0, domainHi: 1, domXLo: 0, domXHi: 1, domYLo: 0, domYHi: 1,
    stratX: sx, stratY: sy, cycleCount: 0, visitedPositions: [], ghostVisitedPositions: [],
    discoveredMixedX: null, discoveredMixedY: null, foundAxis: null, running: false, converged: false,
    stepCount: 0,
    pathSegmentsA: [{ xs: [sx], ys: [sy], zs: [r3(EA(sx, sy, g))], mover: 'A' }],
    pathSegmentsB: [{ xs: [sx], ys: [sy], zs: [r3(EB(sx, sy, g))], mover: 'A' }],
    phase1PtsA: null, phase1PtsB: null, ghostPathSegmentsA: [], ghostPathSegmentsB: [],
    cyclePattern: null, bisecting: false, bisectGoodLo: 0, bisectGoodHi: 1, bisectBadLo: 0, bisectBadHi: 1,
    ghostCyclePattern: null, ghostBisecting: false, ghostBisectGoodLo: 0, ghostBisectGoodHi: 1,
    ghostBisectBadLo: 0, ghostBisectBadHi: 1 } as SimState;
}
function run(g: GamePayoffs, fm: 'A' | 'B', mode: 'shrink' | 'regret', lam: number) {
  const st = init(0.217, 0.217, g);
  const allNE = computeAllNE(g);
  const pure = allNE.filter(n => n.type === 'pure');
  const committed = pure.length ? pure.reduce((b, n) => ((fm === 'A' ? n.eA : n.eB) > (fm === 'A' ? b.eA : b.eB) ? n : b)) : null;
  for (let i = 0; i < 20000 && !st.converged; i++) doStep(g, st, fm, lam, allNE, committed, () => {}, () => {}, () => {}, mode);
  return st.converged ? st : null;
}
const pn = (s: string) => s.replace(/^\s*(\\approx|=)\s*/, '').trim();

const bound = Number(process.env.BOUND ?? 9), N = Number(process.env.N ?? 600);
let seed = Number(process.env.SEED ?? 12345);
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = () => Math.round((rnd() * 2 - 1) * bound);

let n = 0, dCx = 0, dExact = 0, cxNotExact = 0, exactEqRoot = 0;
let worstCx = 0, worstExact = 0;
for (let t = 0; t < N; t++) {
  const g: GamePayoffs = { a11: ri(), a12: ri(), a21: ri(), a22: ri(), b11: ri(), b12: ri(), b21: ri(), b22: ri() };
  for (const fm of ['A', 'B'] as const) for (const [mode, lam] of [['shrink', 0.01], ['regret', 0.3]] as const) {
    const st = run(g, fm, mode as any, lam);
    if (!st || st.convergedIsNE === false) continue;
    const rv = resolveProfile(g, st);
    if (rv.concept !== 'mixed') continue;
    n++;
    const panelA = pn(payoffTexRhs(EA(rv.x, rv.y, g))), panelB = pn(payoffTexRhs(EB(rv.x, rv.y, g)));
    // What the readout prints TODAY (cx/cy = r3-collapsed).
    const cxA = fmtPayoff(EA(st.cx, st.cy, g)), cxB = fmtPayoff(EB(st.cx, st.cy, g));
    // The SAME landing point without the r3 collapse.
    const exA = fmtPayoff(EA(st.exactX, st.exactY, g)), exB = fmtPayoff(EB(st.exactX, st.exactY, g));
    if (cxA !== panelA || cxB !== panelB) dCx++;
    if (exA !== panelA || exB !== panelB) dExact++;
    if (st.cx !== st.exactX || st.cy !== st.exactY) cxNotExact++;
    if (st.exactX === rv.x && st.exactY === rv.y) exactEqRoot++;
    worstCx = Math.max(worstCx, Math.abs(EA(st.cx, st.cy, g) - EA(rv.x, rv.y, g)), Math.abs(EB(st.cx, st.cy, g) - EB(rv.x, rv.y, g)));
    worstExact = Math.max(worstExact, Math.abs(EA(st.exactX, st.exactY, g) - EA(rv.x, rv.y, g)), Math.abs(EB(st.exactX, st.exactY, g) - EB(rv.x, rv.y, g)));
  }
}
const p = (k: number) => `${k} (${(100 * k / n).toFixed(1)}%)`;
console.log(`converged mixed panels (panel's own gate applied): ${n}   int[-${bound},${bound}]`);
console.log(`  readout at (cx, cy)        disagrees with panel: ${p(dCx)}   worst gap ${worstCx.toExponential(3)}`);
console.log(`  readout at (exactX, exactY) disagrees with panel: ${p(dExact)}   worst gap ${worstExact.toExponential(3)}`);
console.log(`  runs where cx/cy != exactX/exactY:                ${p(cxNotExact)}`);
console.log(`  runs where the landing point IS the exact root:   ${p(exactEqRoot)}`);
