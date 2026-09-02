/**
 * Hand-verification for the one float-boundary case
 * `blue3_stakes_scale_invariance.ts`'s invariance sweep found (1 of 32,000):
 * a game whose normalisedRatio landed EXACTLY on the substantial/very-large
 * cut edge (0.5), where scaling by 0.01 returns 0.4999999999999999 instead of
 * 0.5 — a 1-ULP float artefact of this harness's own arithmetic, not a real
 * scale-dependence in the normalised scheme. Kept as a standing repro.
 */
import { describeStakes } from '../src/utils/scenarioStakes';
import type { GamePayoffs } from '../src/types';

function payoffRange(g: GamePayoffs): number {
  const vals = [g.a11, g.a12, g.a21, g.a22, g.b11, g.b12, g.b21, g.b22];
  return Math.max(...vals) - Math.min(...vals);
}
function normalizedRatio(g: GamePayoffs): number {
  const s = describeStakes(g);
  const range = payoffRange(g);
  return range > 0 ? s.swing / range : 0;
}

const g: GamePayoffs = { a11: 0.362, a12: -0.47, a21: 0.292, a22: -0.287, b11: 0.49, b12: 0.01, b21: 0.319, b22: 0.372 };
const scaled: GamePayoffs = Object.fromEntries(
  Object.entries(g).map(([k, v]) => [k, v * 0.01]),
) as unknown as GamePayoffs;

const rBase = normalizedRatio(g);
const rScaled = normalizedRatio(scaled);
console.log(`base ratio  = ${rBase} (exactly 0.5? ${rBase === 0.5})`);
console.log(`scaled(k=0.01) ratio = ${rScaled} (exactly 0.5? ${rScaled === 0.5})`);
console.log(`difference = ${rBase - rScaled} — a 1-ULP float artefact, not a real scale-dependence.`);
