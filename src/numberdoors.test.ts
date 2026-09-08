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
import { fmtProb, fmtProbFixed, fmtProbInterval, fmtPayoff, fmtPayoffProse, r3 } from './utils/gameEngine';

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
  'fmtPayoff', 'payoffTexRhs', 'fmtPayoffPair', 'fmtPayoffProse', 'texProb',
];

const EXEMPTION_MARKER = 'not-a-rendering:';

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
  if (lines[i].includes(EXEMPTION_MARKER)) return true;
  for (let j = i - 1; j >= 0; j--) {
    const s = lines[j].trim();
    if (s === '') return false;                       // a blank line ends the block
    if (!(s.startsWith('//') || s.startsWith('*') || s.startsWith('/*'))) return false;
    if (lines[j].includes(EXEMPTION_MARKER)) return true;
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
    // strip complete /* ... */ spans, then an opening one that runs on
    line = line.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const open = line.indexOf('/*');
    if (open !== -1) { line = line.slice(0, open); inBlock = true; }
    const slash = line.indexOf('//');
    if (slash !== -1) line = line.slice(0, slash);
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
      if (!line.includes('.toFixed(')) return;
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
  ok(plot.includes('const labelA = fmtPayoffProse(zAraw);') && plot.includes('const labelB = fmtPayoffProse(zBraw);'),
    'B2e the tour callout labels render through the payoff formatter');
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
      if (l.includes('.toFixed(')) total++;
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
    if (!line.includes('.toFixed(')) return;
    if (isExempt(injectedLines, i)) return;
    if (line.includes('simState.cx.toFixed(')) caught = true;
  });
  ok(caught, 'B3 mutation: reverting the readout to a bare toFixed is seen by the same scan');

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
    if (!line.includes('.toFixed(')) return;
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

testExactEndpointsPrintAsNumbers();
testSubResolutionNeverClaimsAPureStrategy();
testFixedAndProseRegistersAgree();
testCorridorBracket();
testPayoffLabelRegister();
testRenderingFileListIsReal();
testTheFixedSitesRenderThroughTheFamily();
testNoUnannotatedDoors();

if (failures > 0) {
  console.error(`✗ numberdoors.test.ts: ${failures} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`✓ numberdoors.test.ts: ${checks} assertions passed`);
