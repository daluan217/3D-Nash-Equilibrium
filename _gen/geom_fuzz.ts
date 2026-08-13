import { describeGeometry } from '../src/utils/geometry';
import { computeAllNE, computeIndifference } from '../src/utils/gameEngine';
import type { GamePayoffs } from '../src/types';

/**
 * The interior-flat-spot predicate must agree with the shipped, fuzz-tested
 * solver on whether an interior mixed equilibrium exists, and on WHERE it is.
 * Degenerate games are skipped: there the solver enumerates corners of a
 * continuum, so "the" mixed point is not well defined.
 */
let seed = 0xBEEF;
const rnd = () => { seed = (seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff; };
const ri = () => Math.round(-9 + rnd()*18);

let checked=0, agreeExists=0, agreeCoord=0, bothInterior=0; const bad: unknown[] = [];
for (let t=0; t<20000; t++) {
  const g: GamePayoffs = { a11:ri(),a12:ri(),a21:ri(),a22:ri(), b11:ri(),b12:ri(),b21:ri(),b22:ri() };
  if (computeIndifference(g).any) continue;
  const geo = describeGeometry(g);
  const ne = computeAllNE(g) as { type:string; x:number; y:number }[];
  const mixed = ne.find(n => n.type==='mixed' && n.x>1e-9 && n.x<1-1e-9 && n.y>1e-9 && n.y<1-1e-9);
  checked++;
  if (!!mixed === geo.hasInteriorFlatSpot) agreeExists++;
  else if (bad.length<3) bad.push({ g, geo, ne });
  if (mixed && geo.hasInteriorFlatSpot) {
    bothInterior++;
    // computeAllNE rounds its coordinates to 3 decimals (see its labels), so
    // compare at the tolerance the rest of this codebase uses for solver
    // agreement, not at machine epsilon.
    if (Math.abs(mixed.x-geo.xStar)<0.0025 && Math.abs(mixed.y-geo.yStar)<0.0025) agreeCoord++;
    else if (bad.length<3) bad.push({ why:'coord', g, geo, mixed });
  }
}
console.log(`existence:  ${agreeExists}/${checked} agree with computeAllNE`);
console.log(`coordinate: ${agreeCoord}/${bothInterior} agree (tol 0.0025) where both say interior-mixed`);
if (bad.length) console.log('DISAGREEMENTS:', JSON.stringify(bad, null, 1).slice(0, 900));

// The specific game that broke the zero-sum-only formula.
const bos: GamePayoffs = { a11:2,a12:0,a21:0,a22:1, b11:1,b12:0,b21:0,b22:2 };
const gb = describeGeometry(bos);
console.log(`\nBattle of the Sexes: xStar=${gb.xStar.toFixed(4)} yStar=${gb.yStar.toFixed(4)} zeroSum=${gb.zeroSum}`);
console.log(`  solver mixed: ${JSON.stringify((computeAllNE(bos) as {type:string;x:number;y:number}[]).find(n=>n.type==='mixed'))}`);
