import { equilibriumSet, EA, EB, fmtPayoff } from '../src/utils/gameEngine';
import type { GamePayoffs } from '../src/types';
const legacy = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, ''));
const strip = (v: number) => { const s = fmtPayoff(v); return /^-?\d+\.\d+$/.test(s) ? s.replace(/\.?0+$/, '') : s; };
const ri = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
let shown = 0;
for (let i = 0; i < 400000 && shown < 12; i++) {
  const c = () => ri(-9, 9);
  const g: GamePayoffs = { a11: c(), a12: c(), a21: c(), a22: c(), b11: c(), b12: c(), b21: c(), b22: c() };
  const set = equilibriumSet(g); if (!set.length) continue;
  const r = set[0]; const x = (r.x0 + r.x1) / 2, y = (r.y0 + r.y1) / 2;
  for (const v of [EA(x, y, g), EB(x, y, g)]) {
    const a = legacy(v), b = strip(v);
    if (a !== b && a !== '-0') { console.log(`v=${v}  legacy="${a}"  strip="${b}"`); shown++; }
  }
}
