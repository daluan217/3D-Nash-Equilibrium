/**
 * BLUE-MATH reports "not indifferent" at 99.7-100% for vertex-coordinate
 * equilibria; I report 0.33% for "`≈` between two different numbers". Same
 * population? Separate the predicates and count them side by side: if they ARE
 * the same thing one of us is badly wrong, and if they are not then my guard
 * message quotes the wrong number at the person who will read it.
 */
import { computeAllNE, resolveProfile } from '../src/utils/gameEngine';
import { indifferenceLines } from '../src/components/equilibriumPanel';
import type { GamePayoffs, SimState, NashEquilibrium } from '../src/types';

function mk(s: number){let a=s>>>0;return()=>{a=(a+0x6D2B79F5)>>>0;let t=Math.imul(a^(a>>>15),1|a);
  t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
const profile = (x: number, y: number) => ({ exactX: x, exactY: y } as unknown as SimState);

for (const [name, SCALE, INT] of [['int[-9,9]', 9, true], ['dec +/-1', 1, false], ['int[-100,100]', 100, true]] as const) {
  const rnd = mk(90210);
  let vertexLines = 0, strictShown = 0, misprint = 0, cleanApprox = 0;
  let interiorLines = 0, interiorNotIndifferent = 0;
  for (let i = 0; i < 120000; i++) {
    const v = () => INT ? Math.round((rnd()*2-1)*SCALE) : Math.round((rnd()*2-1)*SCALE*1000)/1000;
    const g = { a11:v(),a12:v(),a21:v(),a22:v(),b11:v(),b12:v(),b21:v(),b22:v() } as GamePayoffs;
    // Exactly what an NE-list click would feed: computeAllNE's own coordinates.
    for (const ne of computeAllNE(g) as NashEquilibrium[]) {
      const res = resolveProfile(g, profile(ne.x, ne.y));
      if (res.concept !== 'mixed') continue;              // pure branch, not this question
      const atVertex = res.x === 0 || res.x === 1 || res.y === 0 || res.y === 1;
      const L = indifferenceLines(g, res.x, res.y);
      for (const side of ['a','b'] as const) {
        const l = L[side];
        if (atVertex) {
          vertexLines++;
          if (!l.indifferent) strictShown++;              // "A strictly prefers" — CORRECT output
          else if (l.pStr !== l.qStr) misprint++;         // the tolerance misprint
          else cleanApprox++;                             // "≈" with one number — fine
        } else {
          interiorLines++;
          if (!l.indifferent) interiorNotIndifferent++;   // non-vacuity control: must be 0
        }
      }
    }
  }
  console.log(JSON.stringify({ alphabet: name,
    vertexCoordinateLines: vertexLines,
    strict_CORRECT: strictShown,
    strictRate: vertexLines ? (100*strictShown/vertexLines).toFixed(1)+'%' : 'n/a',
    approxBetweenDifferentNumbers_MISPRINT: misprint,
    misprintRate: vertexLines ? (100*misprint/vertexLines).toFixed(3)+'%' : 'n/a',
    approxCleanOneNumber: cleanApprox,
    control_interiorLines: interiorLines,
    control_interiorNotIndifferent_mustBe0: interiorNotIndifferent }));
}

// ── WHERE DOES THE HAZARDOUS CLASS ACTUALLY COME FROM? ──────────────────────
// computeAllNE gates the mixed root at 0 < x < 1 and returns pure NEs at
// corners, so it never yields a MIXED-concept point with a coordinate at a
// vertex. The vertex-coordinate mixed panels come from `resolveProfile`
// projecting an ARBITRARY profile onto the EDGE of a continuum region in
// `equilibriumSet`. Different caller, different hazard.
console.log('\n--- arbitrary profiles, projected (a saved game / jumped-to step) ---');
for (const [name, SCALE, INT] of [['int[-9,9]', 9, true], ['dec +/-1', 1, false], ['int[-100,100]', 100, true]] as const) {
  const rnd = mk(555);
  let mixedLines = 0, vertexLines = 0, strictShown = 0, misprint = 0;
  for (let i = 0; i < 120000; i++) {
    const v = () => INT ? Math.round((rnd()*2-1)*SCALE) : Math.round((rnd()*2-1)*SCALE*1000)/1000;
    const g = { a11:v(),a12:v(),a21:v(),a22:v(),b11:v(),b12:v(),b21:v(),b22:v() } as GamePayoffs;
    for (const [px, py] of [[rnd(), rnd()], [0, rnd()], [1, rnd()], [rnd(), 0], [rnd(), 1]] as [number,number][]) {
      const res = resolveProfile(g, profile(px, py));
      if (res.concept !== 'mixed') continue;
      const atVertex = res.x === 0 || res.x === 1 || res.y === 0 || res.y === 1;
      const L = indifferenceLines(g, res.x, res.y);
      for (const side of ['a','b'] as const) {
        mixedLines++;
        if (!atVertex) continue;
        vertexLines++;
        if (!L[side].indifferent) strictShown++;
        else if (L[side].pStr !== L[side].qStr) misprint++;
      }
    }
  }
  console.log(JSON.stringify({ alphabet: name, mixedPanelLines: mixedLines,
    ofWhichVertexCoordinate: vertexLines,
    vertexShare: (100*vertexLines/mixedLines).toFixed(1)+'%',
    strict_CORRECT: strictShown,
    strictRateWithinVertexClass: vertexLines ? (100*strictShown/vertexLines).toFixed(1)+'%' : 'n/a',
    MISPRINT: misprint,
    misprintRateWithinVertexClass: vertexLines ? (100*misprint/vertexLines).toFixed(2)+'%' : 'n/a',
    misprintRateOverAllMixedLines: (100*misprint/mixedLines).toFixed(2)+'%' }));
}
