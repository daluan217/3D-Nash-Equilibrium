// BLUE-SERVER: pull the worst REACHABLE readout-vs-panel disagreements, for the mock.
import { GamePayoffs, SimState } from '../src/types';
import { doStep, computeAllNE, EA, EB, r3, resolveProfile, fmtPayoff, payoffTexRhs, texProb } from '../src/utils/gameEngine';
function init(sx: number, sy: number, g: GamePayoffs): SimState {
  return { cx: sx, cy: sy, exactX: sx, exactY: sy, calcX: sx, calcY: sy, displayX: sx, displayY: sy,
    startX: sx, startY: sy, domainLo: 0, domainHi: 1, domXLo: 0, domXHi: 1, domYLo: 0, domYHi: 1,
    stratX: sx, stratY: sy, cycleCount: 0, visitedPositions: [], ghostVisitedPositions: [],
    discoveredMixedX: null, discoveredMixedY: null, foundAxis: null, running: false, converged: false, stepCount: 0,
    pathSegmentsA: [{ xs: [sx], ys: [sy], zs: [r3(EA(sx, sy, g))], mover: 'A' }],
    pathSegmentsB: [{ xs: [sx], ys: [sy], zs: [r3(EB(sx, sy, g))], mover: 'A' }],
    phase1PtsA: null, phase1PtsB: null, ghostPathSegmentsA: [], ghostPathSegmentsB: [],
    cyclePattern: null, bisecting: false, bisectGoodLo: 0, bisectGoodHi: 1, bisectBadLo: 0, bisectBadHi: 1,
    ghostCyclePattern: null, ghostBisecting: false, ghostBisectGoodLo: 0, ghostBisectGoodHi: 1,
    ghostBisectBadLo: 0, ghostBisectBadHi: 1 } as SimState;
}
function run(g: GamePayoffs, fm: 'A'|'B', mode: 'shrink'|'regret', lam: number) {
  const st = init(0.217, 0.217, g); const allNE = computeAllNE(g);
  const pure = allNE.filter(n => n.type === 'pure');
  const c = pure.length ? pure.reduce((b,n)=>((fm==='A'?n.eA:n.eB)>(fm==='A'?b.eA:b.eB)?n:b)) : null;
  for (let i=0;i<20000 && !st.converged;i++) doStep(g, st, fm, lam, allNE, c, ()=>{}, ()=>{}, ()=>{}, mode);
  return st.converged ? st : null;
}
const pn = (s:string)=>s.replace(/^\s*(\\approx|=)\s*/,'').trim();
let seed = 12345; const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff;};
const bound = Number(process.env.BOUND ?? 9); const ri=()=>Math.round((rnd()*2-1)*bound);
type Row = { g: GamePayoffs; fm: string; mode: string; rA: string; rB: string; pA: string; pB: string; cx: number; cy: number; x: number; y: number; gap: number };
const rows: Row[] = [];
for (let t=0;t<1500;t++) {
  const g: GamePayoffs = {a11:ri(),a12:ri(),a21:ri(),a22:ri(),b11:ri(),b12:ri(),b21:ri(),b22:ri()};
  for (const fm of ['A','B'] as const) for (const [mode,lam] of [['shrink',0.01],['regret',0.3]] as const) {
    const st = run(g, fm, mode as any, lam); if (!st || st.convergedIsNE === false) continue;
    const rv = resolveProfile(g, st); if (rv.concept !== 'mixed') continue;
    const rA=fmtPayoff(EA(st.cx,st.cy,g)), rB=fmtPayoff(EB(st.cx,st.cy,g));
    const pA=pn(payoffTexRhs(EA(rv.x,rv.y,g))), pB=pn(payoffTexRhs(EB(rv.x,rv.y,g)));
    if (rA===pA && rB===pB) continue;
    rows.push({g,fm,mode,rA,rB,pA,pB,cx:st.cx,cy:st.cy,x:rv.x,y:rv.y,
      gap: Math.max(Math.abs(EA(st.cx,st.cy,g)-EA(rv.x,rv.y,g)),Math.abs(EB(st.cx,st.cy,g)-EB(rv.x,rv.y,g)))});
  }
}
rows.sort((a,b)=>b.gap-a.gap);
console.log(`disagreeing panels: ${rows.length}`);
for (const r of rows.slice(0,5)) {
  console.log(`\nA=[[${r.g.a11},${r.g.a12}],[${r.g.a21},${r.g.a22}]] B=[[${r.g.b11},${r.g.b12}],[${r.g.b21},${r.g.b22}]]  ${r.fm}/${r.mode}  gap=${r.gap.toFixed(6)}`);
  console.log(`  READOUT  x=${r.cx.toFixed(3)} y=${r.cy.toFixed(3)}  E[A]=${r.rA}  E[B]=${r.rB}`);
  console.log(`  PANEL    x*=${texProb(r.x)} y*=${texProb(r.y)}  E[A]=${r.pA}  E[B]=${r.pB}`);
}
