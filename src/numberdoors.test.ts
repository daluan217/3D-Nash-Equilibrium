/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * STRUCT-MATH-19, class 1 — "number formatting has many doors".
 *
 * `payoffhonesty.test.ts` guards the three renderings that were WRONG in round
 * 6 and round 18. This file guards the SHAPE that let them go wrong: a number
 * reaching a user-visible string without passing the shared formatter family.
 * It has two halves.
 *
 * A. THE FORMATTER CONTRACT. `fmtProbFixed` is the fixed-width probability
 *    formatter the readout boxes and the simulation log use; `fmtProbInterval`
 *    is the corridor bracket. Both must obey `fmtProb`'s contract exactly — an
 *    EXACT 0 or 1 prints as a number, and anything that merely ROUNDS to one
 *    says so in words — and must never disagree with `fmtProb` about WHICH
 *    values are sub-resolution. That agreement is the "one formatter, three
 *    renderings agree" rule; the only licensed difference is padding.
 *
 * B. THE SOURCE GATE. Every `.toFixed(` on a rendering path must either sit
 *    inside the formatter family itself or carry a `not-a-rendering:` comment
 *    saying why the value is not a displayed probability/payoff. A new bare
 *    `.toFixed(3)` on a rendered quantity therefore fails CI at the moment it
 *    is written, which is the only thing that would have caught
 *    STRUCT-MATH-19/001 (`{simState.cx.toFixed(3)}`, App.tsx, shipped since the
 *    readout was written) before a user saw "x = 0.000" for x = 0.0004.
 *
 * THE DEFECT THIS GUARDS (STRUCT-MATH-19/001, reproduced in real output on
 * origin/main 124c815): `commitStartCoordinate` clamps a typed start
 * coordinate to [0,1] but — unlike `commitPayoffInput` — does not quantise it
 * to the 3-dp grid, so typing 0.0004 into the x₀ field (whose own min/max
 * accept it) left `simState.cx = 0.0004`. The readout printed "0.000" and the
 * log opened "Start (0.000, 0.217)" — a PURE strategy asserted for a strictly
 * interior probability — while the equilibrium panel, the prose and the report
 * payload all said "less than 0.001" for the same number.
 *
 * MUTATION-TESTED, by name, on the real files:
 *   - `fmtProbFixed` body -> `return v.toFixed(3)`  => A2/A4/A5 fail.
 *   - `fmtProbFixed`'s `v === 0 || v === 1` -> `v === 0`  => A1 fails.
 *   - App.tsx `{fmtProbFixed(simState.cx)}` -> `{simState.cx.toFixed(3)}`
 *       => B1 and B3 both fail (B3 names the file and line).
 *   - App.tsx Start line back to `startValX.toFixed(3)`  => B2 and B3 fail.
 *   - gameEngine Step line back to `s.cx.toFixed(3)`     => B3 fails.
 *   - deleting a `not-a-rendering:` annotation            => B3 fails (proving
 *       the gate reads the annotation and is not vacuous).
 *
 *   npx tsx src/numberdoors.test.ts
 */
import { readFileSync } from 'node:fs';
import { fmtProb, fmtProbFixed, fmtProbInterval, fmtPayoff, fmtPayoffProse, fmtPayoffPair, r3, EA, EB, computeAllNE } from './utils/gameEngine';
import { indifferenceLines } from './components/equilibriumPanel';
import { applyPlotHoverContract, buildSurfaces, makeTraces, PLOT_HOVER_TEMPLATE } from './utils/plotting';
import type { GamePayoffs } from './types';

let checks = 0;
let failures = 0;
function ok(cond: boolean, name: string, detail = ''): void {
  checks++;
  if (!cond) { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
}

// A numeric string, as opposed to the formatter's PROSE form.
const isNumeric = (s: string) => /^-?\d+(\.\d+)?$/.test(s);

// ───────────────────────── A. the formatter contract ─────────────────────────

function testExactEndpointsPrintAsNumbers(): void {
  // A1 — an EXACT 0 or 1 is a real pure strategy and must print as a number.
  ok(fmtProbFixed(0) === '0.000', 'A1 fmtProbFixed(0) === "0.000"', `got ${JSON.stringify(fmtProbFixed(0))}`);
  ok(fmtProbFixed(1) === '1.000', 'A1 fmtProbFixed(1) === "1.000"', `got ${JSON.stringify(fmtProbFixed(1))}`);
  // -0 is `=== 0`, and `(-0).toFixed(3)` is "0.000" (V8 drops the sign there,
  // unlike `(-0.0001).toFixed(3)` which is "-0.000"). Asserted, not assumed.
  ok(fmtProbFixed(-0) === '0.000', 'A1 fmtProbFixed(-0) === "0.000" (no signed zero on screen)', `got ${JSON.stringify(fmtProbFixed(-0))}`);
  ok(fmtProbFixed(NaN) === '—' && fmtProbFixed(Infinity) === '—', 'A1 non-finite prints the em dash, never "NaN"');
}

function testSubResolutionNeverClaimsAPureStrategy(): void {
  // A2 — the defect's own values, VERBATIM (a paraphrased fixture once passed
  // while the real defect shipped: user memory `verbatim-defect-text-in-tests`).
  ok(fmtProbFixed(0.0004) === 'less than 0.001', 'A2 fmtProbFixed(0.0004) is the phrase, not "0.000"', `got ${JSON.stringify(fmtProbFixed(0.0004))}`);
  ok(fmtProbFixed(0.9997) === 'more than 0.999', 'A2 fmtProbFixed(0.9997) is the phrase, not "1.000"', `got ${JSON.stringify(fmtProbFixed(0.9997))}`);
  ok(fmtProbFixed(1e-17) === 'less than 0.001', 'A2 float dust below the grid is still not zero');
  ok(fmtProbFixed(0.9999999999999998) === 'more than 0.999', 'A2 float dust below 1 is still not one');

  // A dense sweep over the whole probability range: no interior value may ever
  // render as an exact endpoint. 200,001 values at 5e-6 spacing, plus the
  // 1e-9-wide margins where the collapse actually happens.
  let interior = 0, lies = 0, firstLie = '';
  const sweep: number[] = [];
  for (let i = 1; i < 200000; i++) sweep.push(i / 200000);
  for (let k = 1; k <= 400; k++) { sweep.push(k * 1e-9); sweep.push(1 - k * 1e-9); }
  for (const v of sweep) {
    if (v <= 0 || v >= 1) continue;
    interior++;
    const s = fmtProbFixed(v);
    if (s === '0.000' || s === '1.000' || s === '-0.000') { lies++; if (!firstLie) firstLie = `${v} -> ${s}`; }
  }
  ok(interior > 200000, 'A2 sweep actually ran', `interior values = ${interior}`);
  ok(lies === 0, 'A2 no strictly-interior probability renders as an exact 0 or 1', `${lies} lies, first: ${firstLie}`);
}

function testFixedAndProseRegistersAgree(): void {
  // A3 — the two registers may differ in PADDING and in nothing else. If they
  // could disagree about which values are sub-resolution, "three renderings
  // agree" would be false again by construction.
  let compared = 0, disagreements = 0, firstBad = '';
  for (let i = 0; i <= 200000; i++) {
    const v = i / 200000;
    const a = fmtProbFixed(v), b = fmtProb(v);
    compared++;
    const bothProse = !isNumeric(a) && !isNumeric(b);
    const bothNumeric = isNumeric(a) && isNumeric(b);
    const sameValue = bothNumeric && Number(a) === Number(b);
    const samePhrase = bothProse && a === b;
    if (!(sameValue || samePhrase)) { disagreements++; if (!firstBad) firstBad = `${v}: fixed=${JSON.stringify(a)} prose=${JSON.stringify(b)}`; }
  }
  ok(compared === 200001, 'A3 register comparison ran over the whole range', `compared ${compared}`);
  ok(disagreements === 0, 'A3 fmtProbFixed and fmtProb never disagree about a value or a phrase', `${disagreements}, first: ${firstBad}`);
  // And the padding difference is real, or A3 would be comparing a function
  // with itself: 0.4 is "0.400" fixed and "0.4" in prose.
  ok(fmtProbFixed(0.4) === '0.400' && fmtProb(0.4) === '0.4',
    'A3 the two registers are genuinely different functions (padding)', `${fmtProbFixed(0.4)} / ${fmtProb(0.4)}`);
}

function testCorridorBracket(): void {
  // A4 — the corridor bracket is the same formatter, twice.
  ok(fmtProbInterval(0, 1) === '[0.000,1.000]', 'A4 the full corridor prints as the exact endpoints', fmtProbInterval(0, 1));
  ok(fmtProbInterval(0.0004, 0.5) === '[less than 0.001,0.500]', 'A4 a sub-resolution corridor endpoint says so', fmtProbInterval(0.0004, 0.5));
  // A corridor that has genuinely narrowed to a point prints as one, on
  // purpose (the landing step sets domXLo = domXHi = stratX).
  ok(fmtProbInterval(0.5, 0.5) === '[0.500,0.500]', 'A4 a corridor narrowed to a point is not widened into a fake range');
  let bad = 0;
  for (let i = 0; i <= 20000; i++) {
    const lo = i / 20000;
    const s = fmtProbInterval(lo, 1 - lo);
    if (/\[0\.000,/.test(s) && lo !== 0) bad++;
    if (/,1\.000\]/.test(s) && 1 - lo !== 1) bad++;
  }
  ok(bad === 0, 'A4 no corridor endpoint claims an exactness it does not have', `${bad}`);
}

function testPayoffLabelRegister(): void {
  // A5 — the plot's tour callout moved from a bare `r3(v)` to
  // `fmtPayoffProse`. That must be byte-identical for every value the callout
  // can currently show (the tour's presets are integer payoffs, and any
  // corner/centre expectation of 3-dp cells is a 4-dp-or-coarser rational),
  // and honest for the sub-resolution ones `r3` used to print as "0".
  let compared = 0, changed = 0, firstChange = '';
  for (let i = -100000; i <= 100000; i++) {
    const v = i / 1000; // every 3-dp payoff the matrix admits, ±100
    compared++;
    const before = String(r3(v)), after = fmtPayoffProse(v);
    if (before !== after) { changed++; if (!firstChange) firstChange = `${v}: r3="${before}" prose="${after}"`; }
  }
  ok(compared === 200001, 'A5 payoff-label comparison ran', `${compared}`);
  ok(changed === 0, 'A5 the callout label is unchanged for every 3-dp payoff', `${changed} changed, first: ${firstChange}`);
  ok(fmtPayoffProse(0.00025) === 'less than 0.001', 'A5 a sub-resolution expected payoff no longer prints as "0"', fmtPayoffProse(0.00025));
  ok(String(r3(0.00025)) === '0', 'A5 the OLD label really did print "0" there (this check is not vacuous)');
  ok(fmtPayoff(0) === '0' && fmtPayoffProse(0) === '0', 'A5 an exact zero payoff still prints as 0');
}


function testStrictPairNeverPrintsAFalseZero(): void {
  // A6 — STRUCT-MATH-19/002. `fmtPayoffPair` is the STRICT-relation renderer
  // for the equilibrium panel's two indifference lines. It used to stop the
  // moment the two strings differed, so a sub-resolution side beside an
  // ordinary one printed an exact zero it does not have.
  //
  // The defect's own panel, verbatim from the shipping-condition sweep
  // (`_gen/probe_panel_reachable.ts`, run on origin/main 124c815): a converged
  // run on this continuum game resolves to (0, 0.97) and the A line read
  //   \mathbb{E}[Row 1] = 0.000 < \mathbb{E}[Row 2] = 0.009
  // while E[Row 1] is 0.00012 — and the panel's own headline prints "< 0.001"
  // for that same quantity through `payoffTexRhs`.
  const g = { a11: 0, a12: 0.004, a21: 0.01, a22: -0.008, b11: 0, b12: -0.01, b21: -0.01, b22: -0.01 };
  const line = indifferenceLines(g, 0, 0.97).a;
  ok(Math.abs(line.p - 0.00012) < 1e-9, 'A6 the fixture really does carry a sub-resolution payoff', `p=${line.p}`);
  ok(!line.indifferent, 'A6 the fixture really is a STRICT line (this is the strict branch)', `rel=${line.relation}`);
  ok(!/^-?0(\.0+)?$/.test(line.pStr), 'A6 the panel no longer prints an exact zero for 0.00012', `pStr=${JSON.stringify(line.pStr)}`);
  ok(line.pStr !== line.qStr, 'A6 the two sides of a strict line still read differently', `${line.pStr} / ${line.qStr}`);
  ok(line.tex.includes('= 0.0001 < ') && line.tex.includes('= 0.0095'),
    'A6 the fixture renders at the precision that states BOTH sides truthfully', line.tex);

  // The negative sign must survive too — the second measured shape.
  const gNeg = { a11: 0.006, a12: -0.002, a21: 0.003, a22: 0.006, b11: -0.006, b12: -0.003, b21: 0.003, b22: 0.003 };
  const neg = indifferenceLines(gNeg, 0, 0.217).a;
  ok(neg.p < 0 && Math.abs(neg.p) < 5e-4, 'A6 the negative fixture is a sub-resolution NEGATIVE payoff', `p=${neg.p}`);
  ok(/^-/.test(neg.pStr), 'A6 a tiny negative payoff keeps its sign instead of collapsing to "0.000"', `pStr=${JSON.stringify(neg.pStr)}`);

  // A6b — the invariant, swept. Neither returned string may be all zeros while
  // the value it stands for is representable and nonzero; and the pair must
  // still be told apart, which is the contract fmtPayoffPair exists for.
  let pairs = 0, falseZeros = 0, collisions = 0, exponentials = 0;
  const vals = [0, 5e-9, 1e-8, 1e-6, 0.00012, 0.000458, 0.0004999, 0.001, 0.001362, 0.009, 0.5, 3, 99.999, -0.00012, -0.000264, -0.0005, -0.009, -7];
  for (const a of vals) {
    for (const b of vals) {
      if (Math.abs(a - b) < 5e-4) continue;      // the panel would print ≈, not this branch
      pairs++;
      const r = fmtPayoffPair(a, b);
      for (const [s, v] of [[r.p, a], [r.q, b]] as Array<[string, number]>) {
        if (/^-?0(\.0+)?$/.test(s) && v !== 0 && Math.abs(v) >= 5e-9) { falseZeros++; }
      }
      if (r.p === r.q) collisions++;
      if (/e[+-]/i.test(r.p) || /e[+-]/i.test(r.q)) exponentials++;
    }
  }
  ok(pairs > 200, 'A6b the pair sweep ran', `${pairs} pairs`);
  ok(falseZeros === 0, 'A6b no side of a strict pair prints an exact zero for a representable nonzero value', `${falseZeros}`);
  ok(collisions === 0, 'A6b every strict pair still reads as two different numbers', `${collisions}`);
  ok(exponentials === 0, 'A6b widening never has to fall back to exponential notation on these values', `${exponentials}`);

  // A6c — float noise is a GENUINE zero and must keep the plain 3-dp string,
  // never be widened into "1.00e-16". This is the branch the 5e-9 band exists
  // for; without it the sweep above would push such a pair to exponential.
  const noise = fmtPayoffPair(2.220446049250313e-16, 0.6);
  ok(noise.p === '0.000' && noise.q === '0.600',
    'A6c float dust beside an ordinary payoff still prints "0.000", not exponential', JSON.stringify(noise));
}

// ────────────────────────── B. the source gate ───────────────────────────────

/**
 * Files on a rendering path — anything whose output can reach a user, a
 * screen-reader, or the model's prompt. A file added to this list must obey
 * the gate; a file NOT on it is unguarded, which is why the list is asserted
 * to be non-empty and each entry is asserted to exist.
 */
const RENDERING_PATH_FILES = [
  'src/App.tsx',
  'src/utils/gameEngine.ts',
  'src/utils/report.ts',
  'src/utils/tieProse.ts',
  'src/utils/plotting.ts',
  'src/components/PlotlyView.tsx',
  'src/components/equilibriumPanel.ts',
];

/**
 * The formatter family itself: the only functions allowed to call `.toFixed(`
 * on a displayed quantity, because they ARE the contract. Everything else on a
 * rendering path calls one of these, or says why the value is not a rendering.
 */
const FORMATTER_FAMILY = [
  'collapseNegZeroDisplay', 'fmtProb', 'fmtProbFixed', 'fmtProbInterval',
  'fmtPayoff', 'payoffTexRhs', 'payoffProseRhs', 'fmtPayoffPair', 'fmtPayoffProse', 'texProb',
];

const EXEMPTION_MARKER = 'not-a-rendering:';
// The marker must OPEN the comment (`// not-a-rendering:`, `/* not-a-rendering:`
// or a `* not-a-rendering:` continuation line). Prose that merely mentions the
// token ("the not-a-rendering: annotation is explained above") exempts nothing
// (Opus review of #181, 2026-09-08).
const EXEMPTION_RE = /^(?:\/\/|\/\*|\*)\s*not-a-rendering:/;
/** The marker must follow the FIRST comment delimiter on the line (or open a
 *  `*` continuation line) — `// see /* not-a-rendering:` opens nothing
 *  (CodeRabbit CLI on 2d0fd58). */
function opensWithMarker(line: string): boolean {
  const t = line.trim();
  if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return EXEMPTION_RE.test(t);
  const a = line.indexOf('//'), b = line.indexOf('/*');
  const idx = a === -1 ? b : b === -1 ? a : Math.min(a, b);
  return idx !== -1 && EXEMPTION_RE.test(line.slice(idx));
}
// A door is any of the three number-to-string methods, with or without a space
// before the parenthesis: `.toFixed(`, `.toFixed (`, `.toPrecision(`,
// `.toExponential(`. A literal `.toFixed(` search missed the other three
// spellings (Opus review of #181).
const DOOR_RE = /\.\s*(?:toFixed|toPrecision|toExponential)\s*\(/;

/**
 * Is this line exempted? The annotation must be ON the line, or in the comment
 * block IMMEDIATELY above it with no code in between.
 *
 * A fixed six-line lookback was tried first and leaked: the dedupe-key
 * annotation four lines above a corridor log line silently exempted the log
 * line too (mutant M6 survived B3 because of it). An annotation has to sit
 * against the thing it excuses.
 */
function isExempt(lines: string[], i: number): boolean {
  if (opensWithMarker(lines[i])) return true;
  for (let j = i - 1; j >= 0; j--) {
    const s = lines[j].trim();
    if (s === '') return false;                       // a blank line ends the block
    if (!(s.startsWith('//') || s.startsWith('*') || s.startsWith('/*'))) return false;
    if (opensWithMarker(lines[j])) return true;
  }
  return false;
}

interface Door { file: string; line: number; text: string; enclosing: string }

/**
 * The source with every comment blanked out, line numbering preserved.
 *
 * Written after the gate's first run flagged its OWN documentation: a JSX
 * comment in App.tsx that quotes `.toFixed(3)` while explaining why the line
 * below it does not call one. A gate that fires on prose describing the defect
 * is a gate nobody will keep. Handles `//`, `/* … *​/` (including the `{/* … *​/}`
 * JSX form) and multi-line blocks; string literals containing "/*" are not a
 * concern in these files and would only ever HIDE a door, which the
 * `total >= 12` sanity count and the injection fixture below both catch.
 */
function blankComments(src: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of src.split('\n')) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) { out.push(''); continue; }
      line = ' '.repeat(end + 2) + line.slice(end + 2);
      inBlock = false;
    }
    // strip complete /* ... */ spans, then whichever of `//` and `/*` comes
    // FIRST decides the rest of the line: a `/*` inside a line comment must not
    // open a block, or it would hide every following line from the scan
    // (CodeRabbit CLI on 5ef5b6d; fixture B3c below).
    line = line.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const open = line.indexOf('/*');
    const slash = line.indexOf('//');
    if (slash !== -1 && (open === -1 || slash < open)) line = line.slice(0, slash);
    else if (open !== -1) { line = line.slice(0, open); inBlock = true; }
    out.push(line);
  }
  return out;
}

function scanDoors(): Door[] {
  const doors: Door[] = [];
  for (const file of RENDERING_PATH_FILES) {
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    const code = blankComments(src);
    // Track the nearest preceding top-level `export function NAME(` /
    // `const NAME = (` so a `.toFixed(` inside the formatter family can be
    // told apart from one in a component or a log line.
    let enclosing = '';
    code.forEach((line, i) => {
      const decl = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/.exec(line)
        ?? /^(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(?:\(|function)/.exec(line);
      if (decl) enclosing = decl[1];
      // A column-0 `}` closes the top-level declaration, so an object literal or
      // class that FOLLOWS a formatter-family function is not exempted by it
      // (Opus review of #181: `export const probLabels = { short: v => v.toFixed(3) }`
      // right after fmtPayoffProse scanned as 0 doors).
      if (/^\}/.test(line)) enclosing = '';
      if (!DOOR_RE.test(line)) return;
      // The annotation is read from the ORIGINAL text (that is where comments
      // live) and must sit against this very line — see `isExempt`.
      if (isExempt(lines, i)) return;
      if (FORMATTER_FAMILY.includes(enclosing)) return;
      doors.push({ file, line: i + 1, text: lines[i].trim(), enclosing });
    });
  }
  return doors;
}

function testTheFixedSitesRenderThroughTheFamily(): void {
  const app = readFileSync('src/App.tsx', 'utf8');
  const engine = readFileSync('src/utils/gameEngine.ts', 'utf8');

  // B1 — the readout boxes. Both axes, because an asymmetric guard is this
  // codebase's own recurring defect (COMMON v5 (a)).
  ok(app.includes('{fmtProbFixed(simState.cx)}'), 'B1 the x readout renders through fmtProbFixed');
  ok(app.includes('{fmtProbFixed(simState.cy)}'), 'B1 the y readout renders through fmtProbFixed');
  ok(!/simState\.c[xy]\.toFixed\(/.test(app), 'B1 no readout renders a coordinate with a bare toFixed');

  // B2 — the log's opening line, both coordinates.
  ok(app.includes('`Start (${fmtProbFixed(startValX)}, ${fmtProbFixed(startValY)})'),
    'B2 the log Start line renders both start coordinates through fmtProbFixed');
  ok(!/startVal[XY]\.toFixed\(/.test(app), 'B2 no start coordinate is logged with a bare toFixed');

  // B2b — the per-step log line, in the engine.
  ok(engine.includes('x=${fmtProbFixed(s.cx)}, y=${fmtProbFixed(s.cy)}'),
    'B2b the Step log line renders both coordinates through fmtProbFixed');
  ok(!/s\.c[xy]\.toFixed\(3\)\s*\}/.test(engine), 'B2b no Step line interpolates a bare toFixed');

  // B2c — every corridor bracket goes through the one interval formatter.
  const brackets = (engine.match(/fmtProbInterval\(/g) ?? []).length;
  ok(brackets >= 5, 'B2c every corridor log line uses fmtProbInterval', `found ${brackets} call sites, expected >= 5`);
  ok(!/\[\$\{r3\(s\.dom[A-Za-z]*\)\.toFixed/.test(engine), 'B2c no corridor bracket is built from a bare r3().toFixed');

  // B2d — the grounding payload's coordinates, with no type-conditional bypass.
  const report = readFileSync('src/utils/report.ts', 'utf8');
  ok(!/e\.type === 'mixed' \? fmtProb\(/.test(report),
    'B2d the payload has no "mixed ? formatted : raw" coordinate branch');
  ok(report.includes('`(x=${fmtProb(e.x)}, y=${fmtProb(e.y)})`'), 'B2d the payload coord helper formats both axes');

  // B2e — the plot's tour callout label.
  const plot = readFileSync('src/components/PlotlyView.tsx', 'utf8');
  ok(plot.includes('const labelA = payoffProseRhs(zAraw);') && plot.includes('const labelB = payoffProseRhs(zBraw);'),
    'B2e the tour callout labels render through the payoff formatter, relation included');
  ok(!/= \$\{label[AB]\}/.test(plot), 'B2e no second callout construction prepends its own "=" to a relation-bearing label');
  ok(plot.includes('text: [`${who} ${label}`]') && !plot.includes('${who} = ${label}'),
    'B2e the callout puts the relation in the operator, never "= less than 0.001"');
  ok(!/const label[AB] = r3\(/.test(plot), 'B2e no callout label interpolates a bare r3()');
}

function testNoUnannotatedDoors(): void {
  // B3 — the gate itself.
  const doors = scanDoors();
  ok(doors.length === 0, 'B3 no un-annotated .toFixed( on any rendering path',
    doors.map((d) => `${d.file}:${d.line} (in ${d.enclosing || 'top level'}) ${d.text}`).join(' | '));

  // The gate must not be vacuous: it has to SEE the calls it is exempting.
  // Count how many `.toFixed(` the scanned files actually contain in code.
  let total = 0;
  for (const file of RENDERING_PATH_FILES) {
    for (const l of blankComments(readFileSync(file, 'utf8'))) {
      if (DOOR_RE.test(l)) total++;
    }
  }
  ok(total >= 12, 'B3 the scan sees the real call sites (not an empty file list)', `saw ${total} code lines with .toFixed(`);

  // MUTATION FIXTURE, run against the REAL sources: injecting an un-annotated
  // `.toFixed(3)` into a copy of App.tsx must be caught. Proves B3 fails for
  // the reason it claims, not because the file list is empty.
  const injected = readFileSync('src/App.tsx', 'utf8')
    .replace('{fmtProbFixed(simState.cx)}', '{simState.cx.toFixed(3)}');
  const injectedLines = injected.split('\n');
  const injectedCode = blankComments(injected);
  let caught = false;
  injectedCode.forEach((line, i) => {
    if (!DOOR_RE.test(line)) return;
    if (isExempt(injectedLines, i)) return;
    if (line.includes('simState.cx.toFixed(')) caught = true;
  });
  ok(caught, 'B3 mutation: reverting the readout to a bare toFixed is seen by the same scan');

  // Opus review of #181 (2026-09-08): four ways past the gate, each now a fixture.
  const scanText = (text: string): number => {
    const ls = text.split('\n'); const cd = blankComments(text); let enclosing = ''; let doors = 0;
    cd.forEach((line, i) => {
      const decl = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/.exec(line)
        ?? /^(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(?:\(|function)/.exec(line);
      if (decl) enclosing = decl[1];
      if (/^\}/.test(line)) enclosing = '';
      if (!DOOR_RE.test(line)) return;
      if (isExempt(ls, i)) return;
      if (FORMATTER_FAMILY.includes(enclosing)) return;
      doors++;
    });
    return doors;
  };
  ok(scanText('const a = v.toFixed (3);') === 1, 'B3d `.toFixed (3)` with a space is a door');
  ok(scanText('const a = v.toPrecision(3);') === 1 && scanText('const a = v.toExponential(2);') === 1,
    'B3d toPrecision and toExponential are doors');
  ok(scanText(['// Historical note: the not-a-rendering: annotation is explained above.', 'const a = v.toFixed(3);'].join('\n')) === 1,
    'B3e prose that merely mentions the marker exempts nothing');
  ok(scanText(['// not-a-rendering: a setting', 'const a = v.toFixed(3);'].join('\n')) === 0
    && scanText('const a = v.toFixed(3); /* not-a-rendering: a setting */') === 0,
    'B3e the marker opening a comment still exempts (control)');
  ok(scanText(['// see /* not-a-rendering: not an opener', 'const a = v.toFixed(3);'].join('\n')) === 1
    && scanText('const a = v.toFixed(3); // see /* not-a-rendering: not an opener') === 1,
    'B3e a marker after an embedded "/*" inside a line comment exempts nothing');
  ok(scanText(['export function fmtPayoffProse(v: number): string {', '  return v.toFixed(3);', '}', 'export const probLabels = {', '  short: (v: number) => v.toFixed(3),', '};'].join('\n')) === 1,
    'B3f an object literal after a formatter-family function is not covered by it');

  // A `/*` inside a `//` comment must not open a block: with the old
  // first-check-`/*` order the second line below vanished from the scan, and
  // with it every line to the end of the file (CodeRabbit CLI on 5ef5b6d).
  const swallowed = blankComments(['// see /* the spec', 'const z = v.toFixed(3);', 'const w = u.toFixed(3);'].join('\n'));
  ok(swallowed[1].includes('.toFixed(') && swallowed[2].includes('.toFixed('),
    'B3c a "/*" inside a line comment does not swallow the lines after it', JSON.stringify(swallowed));
  ok(!swallowed[0].includes('.toFixed(') && blankComments(['/* open // not a line comment', 'hidden.toFixed(3) */ shown.toFixed(3)'].join('\n'))[1].trim() === 'shown.toFixed(3)',
    'B3c a real block comment still hides its body and a "//" inside it does not end it');

  // …and removing an annotation must also be caught, so the exemption is not
  // a blanket pass.
  const stripped = readFileSync('src/utils/gameEngine.ts', 'utf8')
    .replace(/^.*not-a-rendering: a dedupe KEY for cycle detection.*$/m, '');
  const strippedLines = stripped.split('\n');
  const strippedCode = blankComments(stripped);
  let strippedDoors = 0;
  let enclosing = '';
  strippedCode.forEach((line, i) => {
    const decl = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/.exec(line)
      ?? /^(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(?:\(|function)/.exec(line);
    if (decl) enclosing = decl[1];
    if (/^\}/.test(line)) enclosing = '';
    if (!DOOR_RE.test(line)) return;
    if (isExempt(strippedLines, i)) return;
    if (FORMATTER_FAMILY.includes(enclosing)) return;
    strippedDoors++;
  });
  ok(strippedDoors > 0, 'B3 mutation: deleting a not-a-rendering annotation reopens the gate');
}

function testRenderingFileListIsReal(): void {
  ok(RENDERING_PATH_FILES.length >= 7, 'B0 the rendering-path list covers every file that prints a number');
  for (const f of RENDERING_PATH_FILES) {
    let exists = true;
    try { readFileSync(f, 'utf8'); } catch { exists = false; }
    ok(exists, `B0 ${f} exists (a renamed file must not silently drop out of the gate)`);
  }
}

// ─────────────────────── C. Plotly hover contract ────────────────────────────

function plotState(g: GamePayoffs, rich = false): any {
  const startX = 0.217, startY = 0.217;
  const state: any = {
    cx: startX, cy: startY, exactX: startX, exactY: startY,
    calcX: startX, calcY: startY, displayX: startX, displayY: startY,
    startX, startY, domainLo: 0, domainHi: 1, domXLo: 0, domXHi: 1,
    domYLo: 0, domYHi: 1, stratX: startX, stratY: startY, cycleCount: 0,
    visitedPositions: [], ghostVisitedPositions: [], discoveredMixedX: null,
    discoveredMixedY: null, foundAxis: null, running: false, converged: false,
    stepCount: 0, phase1PtsA: null, phase1PtsB: null,
    pathSegmentsA: [{ xs: [startX], ys: [startY], zs: [r3(EA(startX, startY, g))], mover: 'A' }],
    pathSegmentsB: [{ xs: [startX], ys: [startY], zs: [r3(EB(startX, startY, g))], mover: 'A' }],
    ghostPathSegmentsA: [], ghostPathSegmentsB: [], cyclePattern: null, bisecting: false,
    bisectGoodLo: 0, bisectGoodHi: 1, bisectBadLo: 0, bisectBadHi: 1,
    ghostCyclePattern: null, ghostBisecting: false, ghostBisectGoodLo: 0,
    ghostBisectGoodHi: 1, ghostBisectBadLo: 0, ghostBisectBadHi: 1,
  };
  if (rich) {
    state.discoveredMixedX = 0.25;
    state.foundAxis = 'x';
    // The ghost is a real marker too. Use the sub-resolution coordinate from
    // the finding so this control proves it reaches fmtProb rather than merely
    // having any nonempty custom text.
    state.calcX = 0.0004;
    state.calcY = 0.25;
    state.pathSegmentsA = [{ xs: [0.217, 0.4], ys: [0.217, 0.25], zs: [r3(EA(0.217, 0.217, g)), r3(EA(0.4, 0.25, g))], mover: 'A' }];
    state.pathSegmentsB = [{ xs: [0.217, 0.4], ys: [0.217, 0.25], zs: [r3(EB(0.217, 0.217, g)), r3(EB(0.4, 0.25, g))], mover: 'B' }];
    state.ghostPathSegmentsA = [{ xs: [0.4, 0.35], ys: [0.25, 0.25], zs: [r3(EA(0.4, 0.25, g)), r3(EA(0.35, 0.25, g))], mover: 'A' }];
    state.ghostPathSegmentsB = [{ xs: [0.4, 0.4], ys: [0.25, 0.3], zs: [r3(EB(0.4, 0.25, g)), r3(EB(0.4, 0.3, g))], mover: 'B' }];
  }
  return state;
}

function flattenHoverText(value: unknown): string[] {
  if (!Array.isArray(value)) return typeof value === 'string' ? [value] : [];
  return value.flatMap((entry) => flattenHoverText(entry));
}

function hoverContractErrors(traces: any[]): string[] {
  const errors: string[] = [];
  traces.forEach((trace, index) => {
    const requiresFormattedHover = trace.type === 'surface'
      || trace.mode === 'markers';
    if (trace.hoverinfo === 'skip') {
      if (requiresFormattedHover) errors.push(`${index}: meaningful trace was silenced`);
      return;
    }
    if (trace.hoverinfo !== undefined) errors.push(`${index}: non-skip hoverinfo ${trace.hoverinfo}`);
    if (trace.hovertemplate !== PLOT_HOVER_TEMPLATE) {
      errors.push(`${index}: missing canonical hovertemplate`);
      return;
    }
    if (!Array.isArray(trace.text)) errors.push(`${index}: formatted hover has no text data`);
    const text = flattenHoverText(trace.text);
    if (text.length === 0 || text.some((entry) => typeof entry !== 'string')) {
      errors.push(`${index}: formatted hover text is malformed`);
    }
    if (/%\{(?:x|y|z)(?:[}:])?/.test(trace.hovertemplate)) {
      errors.push(`${index}: hovertemplate interpolates raw coordinates`);
    }
  });
  return errors;
}

function testMalformedPlotDataIsSilent(): void {
  // Plotly tolerates partial and scalar data, but a hover contract cannot
  // safely infer a truthful x/y/payoff triple from it. Every malformed shape
  // must become explicitly silent and lose any stale active template/text.
  const malformed = [
    ['surface scalar x', { type: 'surface', x: 0, y: [0], z: [[1]] }],
    ['surface missing y', { type: 'surface', x: [0], z: [[1]] }],
    ['surface short rows', { type: 'surface', x: [0, 1], y: [0, 1], z: [[1, 2]] }],
    ['surface short row', { type: 'surface', x: [0, 1], y: [0, 1], z: [[1], [2, 3]] }],
    ['surface empty', { type: 'surface', x: [], y: [], z: [] }],
    ['surface NaN', { type: 'surface', x: [0], y: [0], z: [[NaN]] }],
    ['marker scalar z', { type: 'scatter3d', mode: 'markers', x: [0], y: [0], z: 1 }],
    ['marker missing y', { type: 'scatter3d', mode: 'markers', x: [0], z: [1] }],
    ['marker short z', { type: 'scatter3d', mode: 'markers', x: [0, 1], y: [0, 1], z: [1] }],
    ['marker empty', { type: 'scatter3d', mode: 'markers', x: [], y: [], z: [] }],
    ['marker NaN', { type: 'scatter3d', mode: 'markers', x: [NaN], y: [0], z: [1] }],
  ] as const;
  for (const [label, malformedTrace] of malformed) {
    const [trace] = applyPlotHoverContract([{
      ...malformedTrace,
      hovertemplate: 'x: %{x}<extra></extra>',
      text: 'stale custom hover',
    }]);
    ok(trace.hoverinfo === 'skip' && trace.hovertemplate === undefined && trace.text === undefined,
      `${label}: invalid data is explicitly silent with no active stale hover`, JSON.stringify(trace));
  }
}

function testPlotHoverContract(): void {
  const mixedGame: GamePayoffs = {
    a11: 1, a12: 0, a21: 0, a22: 1,
    b11: 2.499, b12: 0, b21: 0, b22: 0.001,
  };
  const negativeGame: GamePayoffs = {
    a11: 1, a12: -1, a21: -1, a22: 1,
    b11: -2, b12: 1, b21: 1, b22: -2,
  };
  const continuumGame: GamePayoffs = {
    a11: 0, a12: 0, a21: 0, a22: 0,
    b11: 0, b12: 0, b21: 0, b22: 0,
  };
  const twoPureGame: GamePayoffs = {
    a11: 2, a12: 0, a21: 0, a22: 1,
    b11: 1, b12: 0, b21: 0, b22: 2,
  };
  const cases = [
    ['mixed/pure/base', mixedGame, plotState(mixedGame)],
    ['mixed/ghost/flat', mixedGame, plotState(mixedGame, true)],
    ['negative surface', negativeGame, plotState(negativeGame)],
    ['continuum markers', continuumGame, plotState(continuumGame, true)],
    ['two pure equilibria', twoPureGame, plotState(twoPureGame)],
  ] as const;
  const families = new Set<string>();
  let mixedTraces: any[] = [];
  let richMixedTraces: any[] = [];
  let twoPureTraces: any[] = [];
  for (const [label, game, state] of cases) {
    const traces = makeTraces(buildSurfaces(game), game, state, 'both', computeAllNE(game), false, 'shrink');
    traces.forEach((trace: any) => families.add(`${trace.type}:${trace.mode}`));
    const errors = hoverContractErrors(traces);
    ok(errors.length === 0, `${label}: every trace has canonical hover or skip`, errors.join(' | '));
    if (label === 'mixed/pure/base') mixedTraces = traces;
    if (label === 'mixed/ghost/flat') richMixedTraces = traces;
    if (label === 'two pure equilibria') twoPureTraces = traces;
  }
  // Regret mode supplies the last line family; this game has a mixed NE and no
  // pure NE, so its live strategy lines are actually emitted.
  const regret = makeTraces(buildSurfaces(negativeGame), negativeGame, plotState(negativeGame, true), 'both', computeAllNE(negativeGame), false, 'regret');
  regret.forEach((trace: any) => families.add(`${trace.type}:${trace.mode}`));
  ok(hoverContractErrors(regret).length === 0, 'regret strategy-line traces also obey hover contract', hoverContractErrors(regret).join(' | '));
  ok(families.has('surface:undefined') && families.has('scatter3d:lines') && families.has('scatter3d:markers'),
    'the trace sweep exercised surfaces, lines, and markers', JSON.stringify([...families]));

  const mixed = mixedTraces.find((trace) => trace.name === 'Mixed NE');
  ok(!!mixed && flattenHoverText(mixed.text).some((text) => text.includes('x: less than 0.001')),
    'Mixed NE hover uses fmtProb for the sub-resolution x*=0.0004');
  ok(!!mixed && !flattenHoverText(mixed.text).some((text) => text.includes('0.0004')),
    'Mixed NE hover never exposes the raw sub-resolution float');
  const allText = mixedTraces.flatMap((trace) => flattenHoverText(trace.text));
  ok(!allText.some((text) => text.includes('785.7143μ') || text.includes('0.07142857')),
    'surface/marker hover never exposes Plotly SI prefixes or raw seven-digit floats');

  const negative = makeTraces(buildSurfaces(negativeGame), negativeGame, plotState(negativeGame), 'both', computeAllNE(negativeGame), false, 'shrink');
  const negativeText = negative.flatMap((trace: any) => flattenHoverText(trace.text));
  ok(negativeText.some((text) => text.includes('payoff: -1.000')),
    'negative payoff hover uses the canonical ASCII-minus fmtPayoff output');
  ok(!negativeText.some((text) => text.includes('−')),
    'negative payoff hover does not reintroduce Plotly Unicode-minus typography');

  // A legend-deduped marker is still a plotted point.  Battle of the Sexes has
  // two distinct pure equilibria, so its second diamond keeps name '_' while
  // needing the same truthful hover as the first.  Phase-2's Ghost B marker
  // has the same shape when both surfaces are shown.
  const secondPure = twoPureTraces.find((trace: any) => trace.mode === 'markers' && trace.name === '_' && trace.legendgroup === 'pureNE');
  ok(!!secondPure && secondPure.hovertemplate === PLOT_HOVER_TEMPLATE
    && flattenHoverText(secondPure.text).every((text) => /^Pure NE<br>x: (?:0|1)<br>y: (?:0|1)<br>payoff: \d\.000$/.test(text)),
  'second, legend-deduped Pure NE marker retains its formatted semantic hover', JSON.stringify(secondPure));
  const ghostB = richMixedTraces.find((trace: any) => trace.name === '_' && trace.legendgroup === 'ghostB');
  ok(!!ghostB && ghostB.hovertemplate === PLOT_HOVER_TEMPLATE
    && flattenHoverText(ghostB.text).some((text) => text.includes('Search position (Ghost B)<br>x: less than 0.001<br>y: 0.25')),
  'legend-deduped Ghost B marker retains its formatted semantic hover');

  // Mutation fixtures: the behavioral gate must reject both an absent override
  // and an override that falls back to Plotly's raw %{x}/%{z} interpolation.
  const surfaceIndex = mixedTraces.findIndex((trace) => trace.type === 'surface');
  const absent = mixedTraces.map((trace: any) => ({ ...trace }));
  delete absent[surfaceIndex].hovertemplate;
  ok(hoverContractErrors(absent).length > 0, 'mutation: removing a surface hovertemplate reopens the gate');
  const malformed = mixedTraces.map((trace: any) => ({ ...trace }));
  malformed[surfaceIndex].hovertemplate = 'x: %{x}<br>z: %{z}<extra></extra>';
  ok(hoverContractErrors(malformed).length > 0, 'mutation: a raw-coordinate hovertemplate is rejected');
  const legacy = mixedTraces.map((trace: any) => ({ ...trace }));
  delete legacy[surfaceIndex].hovertemplate;
  legacy[surfaceIndex].hoverinfo = 'x+y+z';
  ok(hoverContractErrors(legacy).length > 0, 'mutation: legacy x+y+z hoverinfo is rejected');
}

testExactEndpointsPrintAsNumbers();
testSubResolutionNeverClaimsAPureStrategy();
testFixedAndProseRegistersAgree();
testCorridorBracket();
testPayoffLabelRegister();
testStrictPairNeverPrintsAFalseZero();
testRenderingFileListIsReal();
testTheFixedSitesRenderThroughTheFamily();
testNoUnannotatedDoors();
testPlotHoverContract();
testMalformedPlotDataIsSilent();

if (failures > 0) {
  console.error(`✗ numberdoors.test.ts: ${failures} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`✓ numberdoors.test.ts: ${checks} assertions passed`);
