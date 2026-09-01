/**
 * BEFORE/AFTER for the geometry fix, against origin/main's own renderer.
 *
 * Two properties, both decidable:
 *   1. the five false sentences are gone (0 on every corpus), and
 *   2. the briefing is BYTE-IDENTICAL to origin/main on every game where none
 *      of the five predicates fires — so this is a fix, not a prompt rewrite.
 */
import { geometryBriefing as NEW } from '../src/utils/geometry';
import { geometryBriefing as OLD } from './geometry_main_snapshot';
import { equilibriumSet, regretA, regretB, generateRandomGame, PRESETS } from '../src/utils/gameEngine';
import type { GamePayoffs } from '../src/types';

const S = {
  a: 'outside [0,1]',
  b: "A's payoff does not depend on what B does",
  c: "A's surface always tilts one way",
  d: 'The equilibrium sits on an edge or corner of the square',
  e: 'NEITHER player has a dominant strategy',
};
// EPS, not `=== 0`: the shipping code branches on `Math.abs(twistA) < EPS`, and
// a float twist of 1.3e-15 (reachable from 3-dp payoffs) took the twist-zero
// branch while a `=== 0` predicate called the game clean. Measuring against a
// different threshold than the code uses is measuring a different program.
const E = 1e-9;
function defA(g: GamePayoffs) { const t = g.a11 - g.a12 - g.a21 + g.a22; if (Math.abs(t) < E) return true; const y = (g.a22 - g.a12) / t; return Math.abs(y) <= E || Math.abs(y - 1) <= E; }
function defB(g: GamePayoffs) { return Math.abs(g.a11 - g.a12 - g.a21 + g.a22) < E && Math.abs(g.a21 - g.a22) >= E; }
function defC(g: GamePayoffs) { return Math.abs(g.a11 - g.a12 - g.a21 + g.a22) < E && Math.abs(g.a12 - g.a22) < E; }
function defD(g: GamePayoffs) {
  const tA = g.a11 - g.a12 - g.a21 + g.a22, tB = g.b11 - g.b12 - g.b21 + g.b22;
  const inU = (v: number) => Number.isFinite(v) && v > 1e-9 && v < 1 - 1e-9;
  if (inU(tB === 0 ? NaN : (g.b22 - g.b21) / tB) && inU(tA === 0 ? NaN : (g.a22 - g.a12) / tA)) return false;
  for (const r of equilibriumSet(g)) {
    if (!(r.x1 > 0 && r.x0 < 1 && r.y1 > 0 && r.y0 < 1)) continue;
    const x = Math.min(Math.max((Math.max(r.x0, 0) + Math.min(r.x1, 1)) / 2, 1e-6), 1 - 1e-6);
    const y = Math.min(Math.max((Math.max(r.y0, 0) + Math.min(r.y1, 1)) / 2, 1e-6), 1 - 1e-6);
    if (x < r.x0 - 1e-12 || x > r.x1 + 1e-12 || y < r.y0 - 1e-12 || y > r.y1 + 1e-12) continue;
    if (Math.abs(regretA(x, y, g)) < 1e-9 && Math.abs(regretB(x, y, g)) < 1e-9) return true;
  }
  return false;
}
function defE(g: GamePayoffs) {
  const sA = (g.a11 > g.a21 && g.a12 > g.a22) || (g.a21 > g.a11 && g.a22 > g.a12);
  const sB = (g.b11 > g.b12 && g.b21 > g.b22) || (g.b12 > g.b11 && g.b22 > g.b21);
  if (sA || sB) return false;
  return ((g.a11 >= g.a21 && g.a12 >= g.a22) || (g.a21 >= g.a11 && g.a22 >= g.a12))
      || ((g.b11 >= g.b12 && g.b21 >= g.b22) || (g.b12 >= g.b11 && g.b22 >= g.b21));
}

const ri = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
const gens: Record<string, () => GamePayoffs> = {
  'random button': () => generateRandomGame(Math.random() < 0.5 ? 'pure' : 'mixed'),
  'int[-9,9]': () => { const c = () => ri(-9, 9); return { a11: c(), a12: c(), a21: c(), a22: c(), b11: c(), b12: c(), b21: c(), b22: c() }; },
  'int[-3,3]': () => { const c = () => ri(-3, 3); return { a11: c(), a12: c(), a21: c(), a22: c(), b11: c(), b12: c(), b21: c(), b22: c() }; },
  'int[-1,1]': () => { const c = () => ri(-1, 1); return { a11: c(), a12: c(), a21: c(), a22: c(), b11: c(), b12: c(), b21: c(), b22: c() }; },
  'dec3[-9,9]': () => { const c = () => ri(-9000, 9000) / 1000; return { a11: c(), a12: c(), a21: c(), a22: c(), b11: c(), b12: c(), b21: c(), b22: c() }; },
};
const N = Number(process.env.BM_N || 100000);
for (const [name, gen] of Object.entries(gens)) {
  const oldHit: Record<string, number> = { a: 0, b: 0, c: 0, d: 0, e: 0 };
  const newHit: Record<string, number> = { a: 0, b: 0, c: 0, d: 0, e: 0 };
  let clean = 0, cleanChanged = 0, dirty = 0, dirtyUnchanged = 0;
  for (let i = 0; i < N; i++) {
    const g = gen();
    const o = OLD(g), n = NEW(g);
    const f: Record<string, boolean> = { a: defA(g), b: defB(g), c: defC(g), d: defD(g), e: defE(g) };
    const any = Object.values(f).some(Boolean);
    for (const k of Object.keys(f)) {
      if (!f[k]) continue;
      if (o.includes(S[k as keyof typeof S])) oldHit[k]++;
      if (n.includes(S[k as keyof typeof S])) newHit[k]++;
    }
    if (any) { dirty++; if (o === n) dirtyUnchanged++; }
    else { clean++; if (o !== n) cleanChanged++; }
  }
  console.log(`${name.padEnd(14)} n=${N}`);
  console.log(`   false sentences  BEFORE a=${oldHit.a} b=${oldHit.b} c=${oldHit.c} d=${oldHit.d} e=${oldHit.e}   AFTER a=${newHit.a} b=${newHit.b} c=${newHit.c} d=${newHit.d} e=${newHit.e}`);
  console.log(`   clean games ${clean} of which text CHANGED ${cleanChanged}${cleanChanged ? '   <-- NOT byte-identical' : ''};  defective games ${dirty} of which text UNCHANGED ${dirtyUnchanged}${dirtyUnchanged ? '   <-- NOT FIXED' : ''}`);
}
for (const [k, p] of Object.entries(PRESETS as Record<string, any>)) {
  if (!p || typeof p.a11 !== 'number') continue;
  const g = p as GamePayoffs;
  console.log(`preset ${k.padEnd(8)} briefing byte-identical to main: ${OLD(g) === NEW(g)}`);
}
