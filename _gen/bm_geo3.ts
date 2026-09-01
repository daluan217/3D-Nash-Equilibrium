import { geometryBriefing as NEW } from '../src/utils/geometry';
import { geometryBriefing as OLD } from './geometry_main_snapshot';
import type { GamePayoffs } from '../src/types';
const ri = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
let shown = 0;
for (let i = 0; i < 2000000 && shown < 3; i++) {
  const c = () => ri(-9000, 9000) / 1000;
  const g: GamePayoffs = { a11: c(), a12: c(), a21: c(), a22: c(), b11: c(), b12: c(), b21: c(), b22: c() };
  const twistA = g.a11 - g.a12 - g.a21 + g.a22;
  if (twistA === 0 || Math.abs(twistA) >= 1e-9) continue;
  shown++;
  console.log(`\ntwistA = ${twistA} (nonzero but < EPS)  ${JSON.stringify(g)}`);
  console.log('OLD:', OLD(g).split('\n')[1]);
  console.log('OLD:', OLD(g).split('\n')[3]);
  console.log('NEW:', NEW(g).split('\n')[1]);
  console.log('NEW:', NEW(g).split('\n')[3]);
}
console.log(`\nfound ${shown}`);
