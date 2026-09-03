/**
 * RED-MATH-5, angle 1: attack the Option B (#87) invariant directly.
 * "≈" must print IDENTICAL digits on both sides; a STRICT relation must never
 * print identical digits. Both must be 0 over the corpus.
 *
 * Adapted from `_gen/blueapp_vertex_class.ts` (175d502, the harness that found
 * the PRE-#87 defect at 0.04-0.09%), extended to:
 *  (a) check the DIRECT invariant on pStr/qStr (not just the vertex-coordinate
 *      subset the original harness scoped to),
 *  (b) check the REVERSE direction (strict relation, identical digits),
 *  (c) run both the computeAllNE population AND the arbitrary-projected-profile
 *      population (saved game / jump-to-step), since the original harness's own
 *      comment says the vertex-coordinate MIXED panels come from the SECOND
 *      population, not the first.
 */
import { computeAllNE, resolveProfile } from '../src/utils/gameEngine';
import { indifferenceLines } from '../src/components/equilibriumPanel';
import type { GamePayoffs, SimState, NashEquilibrium } from '../src/types';

function mk(s: number){let a=s>>>0;return()=>{a=(a+0x6D2B79F5)>>>0;let t=Math.imul(a^(a>>>15),1|a);
  t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
const profile = (x: number, y: number) => ({ exactX: x, exactY: y } as unknown as SimState);

let TOTAL_APPROX_DIFFERENT = 0;
let TOTAL_STRICT_IDENTICAL = 0;
const approxDifferentExamples: unknown[] = [];
const strictIdenticalExamples: unknown[] = [];

function checkLine(gameLabel: string, g: GamePayoffs, x: number, y: number, side: 'a'|'b', l: ReturnType<typeof indifferenceLines>['a']) {
  if (l.indifferent && l.pStr !== l.qStr) {
    TOTAL_APPROX_DIFFERENT++;
    if (approxDifferentExamples.length < 12) approxDifferentExamples.push({ gameLabel, g, x, y, side, l });
  }
  if (!l.indifferent && l.pStr === l.qStr) {
    TOTAL_STRICT_IDENTICAL++;
    if (strictIdenticalExamples.length < 12) strictIdenticalExamples.push({ gameLabel, g, x, y, side, l });
  }
}

console.log('=== Population 1: computeAllNE roots (real NE-list panels) ===');
for (const [name, SCALE, INT] of [['int[-9,9]', 9, true], ['dec +/-1', 1, false], ['int[-100,100]', 100, true], ['dec +/-100 3dp', 100, false]] as const) {
  const rnd = mk(90210);
  let n = 0;
  for (let i = 0; i < 120000; i++) {
    const v = () => INT ? Math.round((rnd()*2-1)*SCALE) : Math.round((rnd()*2-1)*SCALE*1000)/1000;
    const g = { a11:v(),a12:v(),a21:v(),a22:v(),b11:v(),b12:v(),b21:v(),b22:v() } as GamePayoffs;
    for (const ne of computeAllNE(g) as NashEquilibrium[]) {
      const res = resolveProfile(g, profile(ne.x, ne.y));
      const L = indifferenceLines(g, res.x, res.y);
      checkLine(name, g, res.x, res.y, 'a', L.a);
      checkLine(name, g, res.x, res.y, 'b', L.b);
      n++;
    }
  }
  console.log(name, 'NE panels checked:', n, 'running totals: approxDifferent=', TOTAL_APPROX_DIFFERENT, 'strictIdentical=', TOTAL_STRICT_IDENTICAL);
}

console.log('=== Population 2: arbitrary projected profiles (saved game / jump-to-step) ===');
for (const [name, SCALE, INT] of [['int[-9,9]', 9, true], ['dec +/-1', 1, false], ['int[-100,100]', 100, true], ['dec +/-100 3dp', 100, false]] as const) {
  const rnd = mk(555);
  let n = 0;
  for (let i = 0; i < 120000; i++) {
    const v = () => INT ? Math.round((rnd()*2-1)*SCALE) : Math.round((rnd()*2-1)*SCALE*1000)/1000;
    const g = { a11:v(),a12:v(),a21:v(),a22:v(),b11:v(),b12:v(),b21:v(),b22:v() } as GamePayoffs;
    for (const [px, py] of [[rnd(), rnd()], [0, rnd()], [1, rnd()], [rnd(), 0], [rnd(), 1]] as [number,number][]) {
      const res = resolveProfile(g, profile(px, py));
      const L = indifferenceLines(g, res.x, res.y);
      checkLine(name, g, res.x, res.y, 'a', L.a);
      checkLine(name, g, res.x, res.y, 'b', L.b);
      n++;
    }
  }
  console.log(name, 'projected-profile panels checked:', n, 'running totals: approxDifferent=', TOTAL_APPROX_DIFFERENT, 'strictIdentical=', TOTAL_STRICT_IDENTICAL);
}

console.log('\n=== FINAL ===');
console.log('TOTAL_APPROX_DIFFERENT (must be 0):', TOTAL_APPROX_DIFFERENT);
console.log('TOTAL_STRICT_IDENTICAL (must be 0):', TOTAL_STRICT_IDENTICAL);
if (approxDifferentExamples.length) console.log('examples (approx-different):', JSON.stringify(approxDifferentExamples, null, 2));
if (strictIdenticalExamples.length) console.log('examples (strict-identical):', JSON.stringify(strictIdenticalExamples, null, 2));
