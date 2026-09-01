import { computeAllNE, EA, EB, r3, fmtProb } from '../src/utils/gameEngine';
import { tieProse } from '../src/utils/tieProse';
import type { GamePayoffs } from '../src/types';
// 1. the stale comment's own example
const g0: GamePayoffs = { a11: 6, a12: -4, a21: -1, a22: 8, b11: -9, b12: 6, b21: -1, b22: -8 };
for (const ne of computeAllNE(g0)) if (ne.type === 'mixed')
  console.log(`example game: label="${ne.label}" eA=${ne.eA} eB=${ne.eB}  exact x=${ne.x} y=${ne.y}`);
console.log(`  prose: ${tieProse(g0).split('. ').pop()}`);
// 2. how often is the DISPLAYED tuple hand-recomputable?
const ri = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
for (const [name, lim] of [['int[-9,9]', 9], ['int[-100,100]', 100]] as const) {
  let n = 0, bad = 0, worst = 0;
  for (let i = 0; i < 200000; i++) {
    const c = () => ri(-lim, lim);
    const g: GamePayoffs = { a11: c(), a12: c(), a21: c(), a22: c(), b11: c(), b12: c(), b21: c(), b22: c() };
    for (const ne of computeAllNE(g)) {
      if (ne.type !== 'mixed') continue;
      n++;
      const dx = r3(ne.x), dy = r3(ne.y);          // what the screen shows
      for (const [rep, f] of [[ne.eA, EA], [ne.eB, EB]] as const) {
        const hand = r3(f(dx, dy, g));
        if (Math.abs(hand - rep) > 5e-4) { bad++; worst = Math.max(worst, Math.abs(hand - rep)); break; }
      }
    }
  }
  console.log(`${name}: ${n} mixed NEs, ${bad} (${(100*bad/n).toFixed(1)}%) where recomputing E at the DISPLAYED x,y gives a different 3-dp value; worst gap ${worst.toFixed(4)}`);
}
