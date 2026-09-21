/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SR-64 — A PAYOFF MUST ARRIVE AS A NUMBER, NOT BECOME ONE.
 *
 * `cleanPayoffs` validated the COERCED value:
 *
 *   const n = Number(value?.[key]);
 *   if (!Number.isFinite(n)) return null;
 *
 * `Number()` coerces, and `Number.isFinite` then says yes to inputs that were
 * never payoffs: `null` -> 0, `[]` -> 0, `[1]` -> 1, `true` -> 1, `""` -> 0,
 * `" "` -> 0. MEASURED against the packaged bundle (IS_ELECTRON=true, cwd a
 * temp dir, the rung-3 flags), POST /api/report with `a11: null` answered 200
 * and the prose asserted payoff numbers the user never supplied —
 *   "against Request Earlier, A prefers Open Later (5 rather than 0)"
 * where that 0 is the coerced null — while `a11: "NaN"` was correctly refused
 * with 400. On the endpoint whose whole job is being trustworthy about the
 * matrix, a confident wrong number is worse than a refusal.
 *
 * The function is EXTRACTED FROM server.ts AND EXECUTED, not pattern-matched:
 * a regex over the source would pass on a function that spells the check and
 * then ignores it, and this is a pure function with no I/O, so running it is
 * both possible and the only thing that proves behaviour. `GamePayoffs` is a
 * type-only reference, erased at runtime, so the extracted body evaluates on
 * its own once the annotation is stripped.
 *
 * Both directions are table-driven and named individually, because a guard
 * that only listed the rejections would also pass on a function that rejects
 * EVERYTHING — which would break every caller of this function.
 *
 * `tsx src/desktoppayoffs.contract.test.ts`, part of `npm test`, CI job `unit`.
 * No server, no network, no ports bound.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SERVER_TS = resolve(ROOT, 'server.ts');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** The real `cleanPayoffs`, lifted out of server.ts and made runnable. */
function loadCleanPayoffs(): (v: any) => Record<string, number> | null {
  const src = readFileSync(SERVER_TS, 'utf8');
  const start = src.indexOf('function cleanPayoffs(');
  assert(start !== -1, 'cleanPayoffs is gone from server.ts — this guard is pointed at nothing');
  // Balance braces from the function's opening `{` so the extraction cannot
  // silently stop at the first `}` inside the body.
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  assert(end !== -1, 'could not find the end of cleanPayoffs — the extraction is broken');
  const body = src.slice(start, end)
    // Erase the TS-only annotations; the logic is plain JS underneath.
    .replace(/: GamePayoffs \| null/g, '')
    .replace(/: \(keyof GamePayoffs\)\[\]/g, '')
    .replace(/as GamePayoffs/g, '')
    .replace(/: any/g, '');
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return cleanPayoffs;`)() as (v: any) => Record<string, number> | null;
}

const cleanPayoffs = loadCleanPayoffs();
const KEYS = ['a11', 'a12', 'a21', 'a22', 'b11', 'b12', 'b21', 'b22'];
/** A complete, ordinary matrix. Every case below replaces exactly one cell. */
const BASE: Record<string, any> = { a11: 3, a12: 0, a21: 5, a22: 1, b11: 3, b12: 5, b21: 0, b22: 1 };
const withA11 = (v: any) => ({ ...BASE, a11: v });

/**
 * MUST BE REFUSED. Every one of these is finite after `Number()`, which is
 * exactly why the old spelling let them through — so each row is a genuine
 * instance of the defect class, not a shape that was always rejected.
 */
const REJECT: [string, any][] = [
  ['null', null],
  ['undefined (a missing cell)', undefined],
  ['an empty array', []],
  ['a one-element array [1]', [1]],
  ['a nested array [[2]]', [[2]]],
  ['the empty string', ''],
  ['a whitespace-only string', '   '],
  ['true', true],
  ['false', false],
  ['a plain object', {}],
  ['an object with valueOf', { valueOf: () => 7 }],
  ['a padded numeric string " 7 "', ' 7 '],
  ['a numeric string with a newline', '\n3'],
  ['the string "NaN"', 'NaN'],
  ['the string "Infinity"', 'Infinity'],
  ['Infinity itself', Infinity],
  ['NaN itself', NaN],
];

/** MUST BE ACCEPTED, with the value the function is expected to produce. */
const ACCEPT: [string, any, number][] = [
  ['a plain integer', 3, 3],
  ['zero', 0, 0],
  ['a negative number', -4, -4],
  ['negative zero', -0, -0],
  ['the low clamp bound', -100, -100],
  ['the high clamp bound', 100, 100],
  ['past the high bound (clamped)', 1000, 100],
  ['past the low bound (clamped)', -1000, -100],
  ['a value needing rounding', 100.0005, 100],
  ['a sub-milli value (rounded)', 0.00049, 0],
  ['three decimals (kept)', 1.234, 1.234],
  ['a numeric string', '5', 5],
  ['a negative decimal string', '-3.25', -3.25],
  ['an exponent string', '1e2', 100],
];

function testRejectedShapes() {
  for (const [label, value] of REJECT) {
    assert(cleanPayoffs(withA11(value)) === null,
      `cleanPayoffs ACCEPTED ${label} as a payoff. Number() coerces it to a finite value, so a `
      + 'report built from it states a number the user never supplied.');
  }
  // …and the same shapes in EVERY cell, not just a11: a per-key check that
  // only ever runs on one key would miss a loop that validates the first
  // element and trusts the rest.
  for (const key of KEYS) {
    assert(cleanPayoffs({ ...BASE, [key]: null }) === null,
      `cleanPayoffs accepted null in ${key} — the validation does not cover every cell`);
  }
  // A non-object, and a missing matrix entirely.
  for (const [label, value] of [['null', null], ['undefined', undefined], ['a string', 'x'],
    ['a number', 5], ['an empty object', {}]] as [string, any][]) {
    assert(cleanPayoffs(value) === null, `cleanPayoffs accepted ${label} as a whole matrix`);
  }
}

function testAcceptedShapes() {
  for (const [label, value, expected] of ACCEPT) {
    const out = cleanPayoffs(withA11(value));
    assert(out !== null,
      `cleanPayoffs REFUSED ${label}, which is a legitimate payoff. A validator that rejects `
      + 'everything would satisfy every rejection check above while breaking all three callers.');
    assert(Object.is(out.a11, expected) || out.a11 === expected,
      `cleanPayoffs turned ${label} into ${out.a11}, expected ${expected}`);
  }
  // The whole matrix survives, not just the cell under test.
  const full = cleanPayoffs(BASE);
  assert(full !== null, 'cleanPayoffs refused an ordinary complete matrix');
  assert(KEYS.every((k) => full[k] === BASE[k]),
    `an ordinary matrix came back changed: ${JSON.stringify(full)}`);
  assert(Object.keys(full).length === KEYS.length,
    `cleanPayoffs returned extra keys: ${Object.keys(full).join(', ')}`);
  // An unknown extra field must not survive into the returned matrix — that
  // object is what reaches the prompt.
  const extra = cleanPayoffs({ ...BASE, evil: 'x' });
  assert(extra !== null && !('evil' in extra), 'cleanPayoffs passed an unknown field through');
}

/**
 * SELF-TEST: the rejected rows must be rejected FOR THE STATED REASON. Each
 * one is finite under the OLD predicate, so a rule that merely reordered the
 * checks would not satisfy this.
 */
function testEveryRejectedShapeWasFiniteBefore() {
  const stillCaughtByIsFinite = new Set(['the string "NaN"', 'NaN itself', 'Infinity itself',
    'the string "Infinity"', 'a plain object', 'undefined (a missing cell)']);
  let coerced = 0;
  for (const [label, value] of REJECT) {
    if (stillCaughtByIsFinite.has(label)) continue;
    assert(Number.isFinite(Number(value)),
      `the fixture row "${label}" is not an instance of this defect class — Number() does not `
      + 'make it finite, so the OLD code rejected it too and this row proves nothing');
    coerced++;
  }
  assert(coerced >= 10,
    `only ${coerced} rows actually exercise the coercion hole; the table has drifted into `
    + 'shapes the old code already refused');
}

function run() {
  testRejectedShapes();
  testAcceptedShapes();
  testEveryRejectedShapeWasFiniteBefore();
  console.log(`All SR-64 payoff-validation contract tests passed `
    + `(${REJECT.length} rejected shapes, ${ACCEPT.length} accepted shapes).`);
}

try {
  run();
} catch (err: any) {
  console.error('SR-64 payoff-validation contract failure:');
  console.error(err?.message || err);
  process.exit(1);
}
