import { geometryBriefing, describeGeometry } from '../src/utils/geometry';
import { equilibriumSet, generateRandomGame } from '../src/utils/gameEngine';
import type { GamePayoffs } from '../src/types';
const ri = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
const gens: [string, () => GamePayoffs][] = [
  ['random button', () => generateRandomGame(Math.random() < 0.5 ? 'pure' : 'mixed')],
  ['int[-9,9]', () => { const c = () => ri(-9, 9); return { a11: c(), a12: c(), a21: c(), a22: c(), b11: c(), b12: c(), b21: c(), b22: c() }; }],
  ['int[-3,3]', () => { const c = () => ri(-3, 3); return { a11: c(), a12: c(), a21: c(), a22: c(), b11: c(), b12: c(), b21: c(), b22: c() }; }],
  ['int[-1,1]', () => { const c = () => ri(-1, 1); return { a11: c(), a12: c(), a21: c(), a22: c(), b11: c(), b12: c(), b21: c(), b22: c() }; }],
];
for (const [n, gen] of gens) {
  let undef = 0, nan = 0, spot = 0, interiorNE = 0;
  for (let i = 0; i < 100000; i++) {
    const g = gen(); const t = geometryBriefing(g);
    if (t.includes('undefined')) undef++;
    if (t.includes('NaN')) nan++;
    const geo = describeGeometry(g);
    if (geo.hasInteriorFlatSpot) spot++;
    if (!geo.hasInteriorFlatSpot && equilibriumSet(g).some((r) => r.x1 > 0 && r.x0 < 1 && r.y1 > 0 && r.y0 < 1)) interiorNE++;
  }
  console.log(`  ${n.padEnd(14)} "undefined" in briefing: ${undef}   "NaN": ${nan}   interior flat spot: ${spot}   class-(d) still reachable: ${interiorNE}`);
}
