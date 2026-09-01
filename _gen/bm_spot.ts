/**
 * Did `hasInteriorFlatSpot` actually MOVE on the random button?
 *
 * I told main "~57% of random-button games, where it used to be false wherever a
 * twist vanished" — a LEVEL and a CHANGE run together in one sentence. BLUE
 * could not reproduce it. This separates the two, and compares old vs new on the
 * same draws using origin/main's own renderer as the before arm.
 */
import { describeGeometry as NEWg } from '../src/utils/geometry';
import { describeGeometry as OLDg } from './geometry_main_snapshot';
import { generateRandomGame } from '../src/utils/gameEngine';
import type { GamePayoffs } from '../src/types';

const ri = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
const gens: [string, () => GamePayoffs][] = [
  ['random button, kind=mixed', () => generateRandomGame('mixed')],
  ['random button, kind=pure', () => generateRandomGame('pure')],
  ['random button, 50/50 (what I sampled)', () => generateRandomGame(Math.random() < 0.5 ? 'pure' : 'mixed')],
  ['int[-9,9]', () => { const c = () => ri(-9, 9); return { a11: c(), a12: c(), a21: c(), a22: c(), b11: c(), b12: c(), b21: c(), b22: c() }; }],
  ['int[-3,3]', () => { const c = () => ri(-3, 3); return { a11: c(), a12: c(), a21: c(), a22: c(), b11: c(), b12: c(), b21: c(), b22: c() }; }],
  ['int[-1,1]', () => { const c = () => ri(-1, 1); return { a11: c(), a12: c(), a21: c(), a22: c(), b11: c(), b12: c(), b21: c(), b22: c() }; }],
];
const N = 40000;
for (const [name, gen] of gens) {
  let oldT = 0, newT = 0, moved = 0;
  for (let i = 0; i < N; i++) {
    const g = gen();
    const o = OLDg(g).hasInteriorFlatSpot, n = NEWg(g).hasInteriorFlatSpot;
    if (o) oldT++;
    if (n) newT++;
    if (o !== n) moved++;
  }
  const p = (x: number) => `${(100 * x / N).toFixed(2)}%`;
  console.log(`${name.padEnd(38)} BEFORE ${p(oldT)}  AFTER ${p(newT)}  rows CHANGED ${p(moved)}`);
}
