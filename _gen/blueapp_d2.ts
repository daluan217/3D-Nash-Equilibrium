import { computeAllNE, EA, EB, fmtPayoff } from '../src/utils/gameEngine';
import type { GamePayoffs } from '../src/types';

// RED-MATH's exact repro, as ground truth before any sweep.
const repro = { a11:-0.017, a12:0.01, a21:0.077, a22:-0.049,
                b11:-0.034, b12:0.048, b21:0.048, b22:0.034 } as GamePayoffs;
for (const ne of computeAllNE(repro)) {
  console.log('REPRO', ne.type, ne.label,
    '| shipped:', `E[A]=${ne.eA.toFixed(3)}, E[B]=${ne.eB.toFixed(3)}`,
    '| naive fmtPayoff(stored):', `E[A]=${fmtPayoff(ne.eA)}, E[B]=${fmtPayoff(ne.eB)}`,
    '| recomputed:', `E[A]=${fmtPayoff(EA(ne.x, ne.y, repro))}, E[B]=${fmtPayoff(EB(ne.x, ne.y, repro))}`,
    '| exact:', EA(ne.x, ne.y, repro), EB(ne.x, ne.y, repro));
}

// mulberry32 — the earlier LCG lost its low bits to float precision.
function mk(seed: number) { let a = seed >>> 0; return () => {
  a = (a + 0x6D2B79F5) >>> 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

for (const SCALE of [0.1, 1, 3, 10]) {
  const rnd = mk(20260901);
  let entries = 0, mixed = 0, shippedFalseZero = 0, naiveFalseZero = 0, mixedFalseZero = 0, fixedFalseZero = 0;
  const N = 200000;
  for (let i = 0; i < N; i++) {
    const v = () => Math.round((rnd() * 2 - 1) * SCALE * 1000) / 1000;
    const g = { a11:v(), a12:v(), a21:v(), a22:v(), b11:v(), b12:v(), b21:v(), b22:v() } as GamePayoffs;
    for (const ne of computeAllNE(g)) {
      entries++;
      if (ne.type === 'mixed') mixed++;
      for (const [stored, exact] of [[ne.eA, EA(ne.x, ne.y, g)], [ne.eB, EB(ne.x, ne.y, g)]] as const) {
        if (exact === 0) continue;
        if (stored.toFixed(3) === '0.000' || stored.toFixed(3) === '-0.000') {
          shippedFalseZero++;
          if (ne.type === 'mixed') mixedFalseZero++;
        }
        if (fmtPayoff(stored) === '0') naiveFalseZero++;
        if (fmtPayoff(exact) === '0') fixedFalseZero++;
      }
    }
  }
  console.log(JSON.stringify({ SCALE, games: N, entries, mixed,
    shipped_false_zero: shippedFalseZero,
    shipped_rate_pct: (100 * shippedFalseZero / (2 * entries)).toFixed(3),
    mixed_false_zero: mixedFalseZero,
    mixed_rate_pct: (100 * mixedFalseZero / (2 * mixed)).toFixed(3),
    naive_fmtPayoff_still_false_zero: naiveFalseZero,
    recomputed_false_zero: fixedFalseZero }));
}
