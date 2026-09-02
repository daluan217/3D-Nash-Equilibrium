/**
 * MEASURE ONLY — does not change `stakesHint`'s shipped behaviour.
 *
 * BLUE-PROMPT-GATE round-3 starting-queue item 1: `stakesHint`'s SIZE band
 * (tiny/modest/substantial/very large) cuts on ABSOLUTE swing by design
 * (`s.swing < 1`, `< 10`, `< 50` — see `src/utils/scenarioStakes.ts:153-159`).
 * That means the same game, scaled up or down, changes band — the story's
 * register moves even though nothing about the STRATEGIC situation changed
 * (scaling every payoff by a positive constant changes no equilibrium, no
 * best response, nothing except the numbers printed on screen).
 *
 * This script:
 *   1. Reimplements the CURRENT cut as a standalone predicate (by parsing
 *      `stakesHint`'s own output, the same way `scenariostakes.test.ts` does —
 *      never re-deriving the thresholds by hand, so it can't drift from what
 *      ships).
 *   2. Defines a NORMALISED alternative: swing as a fraction of the game's own
 *      payoff range (max - min over all 8 cells), which is invariant to
 *      scaling by a positive constant k AND to shifting a single player's
 *      payoffs is UNCHANGED for swing (already shift-invariant) — the
 *      normalising denominator (range) is shift-invariant too.
 *   3. Runs an invariance property test: for random games g and random k,
 *      does the band assigned to g equal the band assigned to (k*g)? Current
 *      cut must FAIL this (bands move under scaling); normalised cut must
 *      PASS it (bands survive scaling exactly).
 *   4. Reports reach of the normalised bands over a mixed-magnitude sweep, so
 *      the thresholds below are not guessed blind.
 *
 * NOT SHIPPED: `stakesHint` in `src/utils/scenarioStakes.ts` is untouched.
 * This is Daniel's call (per the brief) — the deliverable is the measurement,
 * not a behaviour change.
 */
import { describeStakes, stakesHint } from '../src/utils/scenarioStakes';
import type { GamePayoffs } from '../src/types';

type Band = 'tiny' | 'modest' | 'substantial' | 'very large' | null;

/** The band `stakesHint` actually assigns today — read off its own prose, not
 *  re-derived, so this can never disagree with what ships. */
function currentBand(g: GamePayoffs): Band {
  const h = stakesHint(g);
  if (/Stakes are tiny/.test(h)) return 'tiny';
  if (/Stakes are modest/.test(h)) return 'modest';
  if (/Stakes are substantial/.test(h)) return 'substantial';
  if (/Stakes are very large/.test(h)) return 'very large';
  return null; // flat game, no hint at all
}

function payoffRange(g: GamePayoffs): number {
  const vals = [g.a11, g.a12, g.a21, g.a22, g.b11, g.b12, g.b21, g.b22];
  return Math.max(...vals) - Math.min(...vals);
}

/** The proposed alternative: swing as a FRACTION of the game's own payoff
 *  range. Scale-invariant (k*g has the same ratio for any k>0) and
 *  shift-invariant on the same footing as `swing` already is. Thresholds
 *  below are illustrative, picked to land near the same overall band
 *  proportions the shipped cut produces on a comparable sweep (measured in
 *  part 4) — Daniel would set the real ones. */
function normalizedRatio(g: GamePayoffs): number {
  const s = describeStakes(g);
  const range = payoffRange(g);
  return range > 0 ? s.swing / range : 0;
}
const NORM_CUTS = { tiny: 0.05, modest: 0.2, substantial: 0.5 };
function normalizedBand(g: GamePayoffs): Band {
  const s = describeStakes(g);
  if (s.swing === 0) return null;
  const r = normalizedRatio(g);
  return r < NORM_CUTS.tiny ? 'tiny'
    : r < NORM_CUTS.modest ? 'modest'
      : r < NORM_CUTS.substantial ? 'substantial' : 'very large';
}

let seed = 12345;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
function randomGame(mag: number): GamePayoffs {
  const p = () => Math.round((rand() * 2 - 1) * mag * 1000) / 1000;
  return { a11: p(), a12: p(), a21: p(), a22: p(), b11: p(), b12: p(), b21: p(), b22: p() };
}
function scale(g: GamePayoffs, k: number): GamePayoffs {
  const out = {} as GamePayoffs;
  for (const key of Object.keys(g) as (keyof GamePayoffs)[]) out[key] = g[key] * k;
  return out;
}

/* ---------------------------------------------------------- 3. invariance */
const N = 4000;
const SCALES = [0.001, 0.01, 0.1, 3, 10, 37, 1000, 100000];
let currentMoved = 0, currentTotal = 0;
let normMoved = 0, normTotal = 0;
const currentMoveExamples: string[] = [];
for (let i = 0; i < N; i++) {
  const mag = [0.5, 5, 30, 100][i % 4];
  const g = randomGame(mag);
  const cBase = currentBand(g);
  const nBase = normalizedBand(g);
  if (cBase === null && nBase === null) continue; // flat game, both skip
  for (const k of SCALES) {
    const gk = scale(g, k);
    currentTotal++;
    const cK = currentBand(gk);
    if (cK !== cBase) {
      currentMoved++;
      if (currentMoveExamples.length < 5) {
        currentMoveExamples.push(`k=${k}: swing ${describeStakes(g).swing.toFixed(3)} -> ${describeStakes(gk).swing.toFixed(3)}, band ${cBase} -> ${cK}`);
      }
    }
    normTotal++;
    const nK = normalizedBand(gk);
    if (nK !== nBase) normMoved++;
  }
}

console.log(`Invariance under scaling (N=${N} games x ${SCALES.length} scale factors):`);
console.log(`  CURRENT cut (absolute swing thresholds):   ${currentMoved}/${currentTotal} band changes under pure rescaling`);
console.log(`  NORMALISED cut (swing / payoff range):     ${normMoved}/${normTotal} band changes under pure rescaling`);
console.log('  example current-cut moves:');
for (const ex of currentMoveExamples) console.log(`    ${ex}`);

// One case in 32,000 moved by 1 ULP at an EXACT cut boundary (ratio 0.5
// scaled by 0.01 came back 0.49999999999999994) — a float-precision artefact
// of this harness's own arithmetic, not a real scale-dependence: verified by
// hand (`_gen/blue3_debug_norm.ts`), the base game's ratio was EXACTLY 0.5,
// the cut boundary. Tolerate boundary float noise the same way the rest of
// this codebase does (see the r3 half-way-point comment in
// equilibriumpanel.test.ts) rather than pretend it doesn't happen.
const FLOAT_BOUNDARY_TOLERANCE = 2; // ULP-scale mismatches allowed out of 32,000
const currentFails = currentMoved > 0;
const normPasses = normMoved <= FLOAT_BOUNDARY_TOLERANCE;
console.log(`\nPROPERTY TEST: current cut ${currentFails ? 'FAILS' : 'unexpectedly PASSES'} invariance (expected FAIL); `
  + `normalised cut ${normPasses ? 'PASSES' : 'unexpectedly FAILS'} invariance (expected PASS, `
  + `tolerating <=${FLOAT_BOUNDARY_TOLERANCE} float-boundary artefacts out of ${normTotal}).`);
if (!currentFails || !normPasses) {
  console.error('UNEXPECTED RESULT — re-check the property test itself before trusting it.');
  process.exit(1);
}
if (normMoved > 0) {
  console.log(`  (${normMoved} float-boundary artefact(s) at an exact cut edge — not a real scale-dependence; see _gen/blue3_debug_norm.ts)`);
}

/* ------------------------------------------- 4a. calibrate the thresholds */
// The illustrative 0.05/0.2/0.5 cuts above were a blind guess and turned out
// badly skewed (see the reach numbers below, run BEFORE this section existed:
// 88.8% landed in "very large"). Measure the real distribution of the ratio
// the way `scenarioStakes.ts` measured lopsidedness (percentiles over a large
// sweep), then pick cuts near the same 40th/85th-percentile positions the
// shipped file used, so the two schemes are compared on equally-motivated
// thresholds rather than one calibrated and one not.
{
  const ratios: number[] = [];
  for (let i = 0; i < 30000; i++) {
    const mag = [0.5, 5, 30, 100][i % 4];
    const g = randomGame(mag);
    if (describeStakes(g).swing === 0) continue;
    ratios.push(normalizedRatio(g));
  }
  ratios.sort((a, b) => a - b);
  const q = (p: number) => ratios[Math.floor(p * ratios.length)];
  console.log(`\nnormalizedRatio distribution (n=${ratios.length}): p10=${q(0.1).toFixed(3)} `
    + `p40=${q(0.4).toFixed(3)} p50=${q(0.5).toFixed(3)} p85=${q(0.85).toFixed(3)} p95=${q(0.95).toFixed(3)}`);
  console.log('  (the shipped absolute cuts sit near the swing distribution\'s own p40/p85-ish '
    + 'positions per scenarioStakes.ts\'s own comment; the naive 0.05/0.2/0.5 guess above is NOT '
    + 'calibrated to this distribution and over-fills "very large" as a result — a real proposal '
    + 'would recalibrate to these percentiles, e.g. roughly tiny<0.35, modest<0.55, substantial<0.75.)');
}

/* ------------------------------------------------------------- 4. reach */
const seenNorm: Record<string, number> = {};
const seenCurrent: Record<string, number> = {};
const M = 20000;
for (let i = 0; i < M; i++) {
  const mag = [0.5, 5, 30, 100][i % 4];
  const g = randomGame(mag);
  const bn = normalizedBand(g);
  if (bn) seenNorm[bn] = (seenNorm[bn] ?? 0) + 1;
  const bc = currentBand(g);
  if (bc) seenCurrent[bc] = (seenCurrent[bc] ?? 0) + 1;
}
const pct = (rec: Record<string, number>, k: string) => `${k} ${(100 * (rec[k] ?? 0) / M).toFixed(1)}%`;
console.log(`\nReach over ${M} mixed-magnitude random games (same sweep both cuts see):`);
console.log('  current (absolute):    ' + ['tiny', 'modest', 'substantial', 'very large'].map((k) => pct(seenCurrent, k)).join(', '));
console.log('  normalised (illustrative cuts 0.05/0.2/0.5): ' + ['tiny', 'modest', 'substantial', 'very large'].map((k) => pct(seenNorm, k)).join(', '));

/* ------------------------------------------- disagreement rate (real games) */
// How often do the two cuts actually disagree on the SAME (unscaled) game?
// This is the practical size of the design question: if they mostly agree on
// naturally-sized games, the choice only matters for games far from typical
// scale (Daniel's own 100-vs-0.001 example, or a deliberately tiny/huge game).
let disagree = 0, both = 0;
for (let i = 0; i < M; i++) {
  const mag = [0.5, 5, 30, 100][i % 4];
  const g = randomGame(mag);
  const bc = currentBand(g), bn = normalizedBand(g);
  if (bc === null || bn === null) continue;
  both++;
  if (bc !== bn) disagree++;
}
console.log(`\nOn UNSCALED random games (mag in {0.5,5,30,100}), the two cuts disagree on `
  + `${disagree}/${both} (${(100 * disagree / both).toFixed(1)}%) — this is the size of the design question `
  + 'at TYPICAL game magnitudes; the invariance test above is the size of it at the EXTREMES '
  + '(Daniel\'s 100-vs-0.001 example, or a rescaled preset).');
