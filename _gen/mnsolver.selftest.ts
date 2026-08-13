import { enumerateNE, type MNGame } from './mnsolver';
import { computeAllNE, computeIndifference } from '../src/utils/gameEngine';
import type { GamePayoffs } from '../src/types';

// 1) Rock-Paper-Scissors: unique mixed NE at (1/3,1/3,1/3) both sides.
const rps: MNGame = {
  A: [[0,-1,1],[1,0,-1],[-1,1,0]],
  B: [[0,1,-1],[-1,0,1],[1,-1,0]],
};
const r = enumerateNE(rps);
console.log(`RPS: ${r.length} equilibrium/a`);
for (const e of r) console.log(`   x=[${e.x}] y=[${e.y}] type=${e.type}`);

// 2) Cross-check vs the shipped 2x2 solver on random non-degenerate games.
let seed = 0xC0FFEE;
const rnd = () => { seed = (seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff; };
const ri = () => Math.floor(-10 + rnd()*21);
let checked=0, agree=0; const bad:any[]=[];
for (let t=0;t<4000;t++){
  const g: GamePayoffs = {a11:ri(),a12:ri(),a21:ri(),a22:ri(), b11:ri(),b12:ri(),b21:ri(),b22:ri()};
  if (computeIndifference(g).any) continue;           // degenerate: engines model it differently
  const mn: MNGame = { A:[[g.a11,g.a12],[g.a21,g.a22]], B:[[g.b11,g.b12],[g.b21,g.b22]] };
  const truth = computeAllNE(g).map(n=>({x:n.x,y:n.y})).sort((p,q)=>p.x-q.x||p.y-q.y);
  const mine  = enumerateNE(mn).map(e=>({x:e.x[0],y:e.y[0]})).sort((p,q)=>p.x-q.x||p.y-q.y);
  checked++;
  const same = truth.length===mine.length && truth.every((v,i)=>Math.abs(v.x-mine[i].x)<0.0025 && Math.abs(v.y-mine[i].y)<0.0025);
  if (same) agree++; else if (bad.length<3) bad.push({g,truth,mine});
}
console.log(`\n2x2 cross-check: ${agree}/${checked} agree with the shipped fuzz-tested solver`);
if (bad.length) console.log('disagreements:', JSON.stringify(bad,null,1));
