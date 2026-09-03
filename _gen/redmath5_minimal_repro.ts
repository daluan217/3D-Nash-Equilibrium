/**
 * Minimal, hand-verifiable repro of the "approx-different" finding: a small
 * integer game whose mixed NE has an indifference line whose TRUE value is
 * EXACTLY 0 on both sides (that's what mixed-NE indifference means), where
 * floating-point noise of order 1e-16 alone flips the printed sign/relation.
 */
import { computeAllNE, resolveProfile } from '../src/utils/gameEngine';
import { indifferenceLines, neValues } from '../src/components/equilibriumPanel';
import type { GamePayoffs, SimState, NashEquilibrium } from '../src/types';

const g: GamePayoffs = { a11: -3, a12: 2, a21: 6, a22: -4, b11: 5, b12: 1, b21: -7, b22: 1 };
console.log('Game (all small integers, directly enterable):', JSON.stringify(g));

const nes = computeAllNE(g) as NashEquilibrium[];
console.log('computeAllNE ->', JSON.stringify(nes));

const mixed = nes.find(n => n.x > 0 && n.x < 1 && n.y > 0 && n.y < 1)!;
console.log('mixed NE root x*,y* =', mixed.x, mixed.y);

const resolved = resolveProfile(g, { exactX: mixed.x, exactY: mixed.y } as unknown as SimState);
console.log('resolveProfile ->', resolved);

const vals = neValues(mixed, g);
console.log('Headline E[A], E[B] (neValues) =', vals);

const L = indifferenceLines(g, resolved.x, resolved.y);
console.log('indifferenceLines.a =', JSON.stringify(L.a, null, 2));
console.log('indifferenceLines.b =', JSON.stringify(L.b, null, 2));

console.log('\n--- What the panel actually renders (TeX) ---');
console.log('A line:', L.a.tex);
console.log('B line:', L.b.tex);

console.log('\n--- Exact math check ---');
const eRow1 = mixed.y * g.a11 + (1 - mixed.y) * g.a12;
const eRow2 = mixed.y * g.a21 + (1 - mixed.y) * g.a22;
console.log('eRow1 (float) =', eRow1, ' eRow2 (float) =', eRow2, ' diff =', eRow1 - eRow2);
console.log('Both are EXACTLY 0 in real-number arithmetic: y*a11+(1-y)*a12 and y*a21+(1-y)*a22');
console.log('at the indifference root are equal by DEFINITION of the mixed NE (that is what makes y* the root).');
console.log('Here both evaluate to 0 in exact arithmetic; the ~1e-16 values are pure float noise.');
