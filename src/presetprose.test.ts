/**
 * Every standard preset must name its own options consistently: the matrix
 * header (row1Label/row2Label/col1Label/col2Label) and the narrative prose
 * (`desc`) must agree, and neither may fall back to exposing the internal
 * grid index ("Row 1", "Col 2") as if it were the option's name.
 *
 * RED-PUBLIC A/B (round 3 starting queue): 4 of 6 presets (bos, pd, cnr, spy)
 * had no row/col labels of their own, so `activeLabels` in App.tsx fell back
 * to the literal strings "Row 1"/"Row 2"/"Col 1"/"Col 2" for the matrix
 * header — technical grid jargon under a matrix whose whole point is a story.
 * And even the two presets that DID carry real labels (search, penalty)
 * named the same option BOTH ways at once: the header said "Search L" while
 * the prose two lines away said "Left (Row 1)" for the identical cell — two
 * different names for one thing, which is what "one source of truth"
 * (RED-PUBLIC B) means to fix.
 *
 * Every check here FAILS against the preset data this file's fix replaced —
 * the fixture at the bottom proves the predicate actually fires, hand-read,
 * not merely asserted.
 *
 *   npx tsx src/presetprose.test.ts
 */
import assert from 'node:assert';
import { PRESETS } from './utils/gameEngine';

let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  assert(cond, msg);
}

// Matches the literal grid-index leak this file exists to remove. Deliberately
// loose ("Row 1", "row  2", "Column 2", "Col1") — a predicate that is too
// narrow is how the last five of these leaked past the first rule written
// for them (CLAUDE.md's standing lesson). Word-boundaried so it does not
// false-positive on prose that legitimately contains "row" or "column" as an
// ordinary English word with no trailing digit (none of these presets do,
// checked by hand below).
const ROWCOL = /\b(row|col(?:umn)?)\s*\d\b/i;

const STANDARD_KEYS = ['search', 'bos', 'pd', 'cnr', 'spy', 'penalty'] as const;

// ── 1. every standard preset has real row/col labels ────────────────────────
// Without these, App.tsx's activeLabels (`scenarioForReport?.row1 || 'Row 1'`)
// falls back to the generic index string for the matrix header.
for (const key of STANDARD_KEYS) {
  const p = PRESETS[key];
  ok(!!p.row1Label && p.row1Label.trim().length > 0, `${key}: row1Label must be a non-empty custom label`);
  ok(!!p.row2Label && p.row2Label.trim().length > 0, `${key}: row2Label must be a non-empty custom label`);
  ok(!!p.col1Label && p.col1Label.trim().length > 0, `${key}: col1Label must be a non-empty custom label`);
  ok(!!p.col2Label && p.col2Label.trim().length > 0, `${key}: col2Label must be a non-empty custom label`);
}

// ── 2. no preset's prose (or its labels) leaks the grid index ───────────────
// Strip the trusted app-authored HTML spans before matching so a class name
// or attribute can never coincidentally trip the predicate.
function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, ' ');
}
for (const key of STANDARD_KEYS) {
  const p = PRESETS[key];
  ok(!ROWCOL.test(textOf(p.desc)), `${key}: desc must not name an option by its grid index (found in: ${p.desc})`);
  for (const [field, val] of [
    ['row1Label', p.row1Label], ['row2Label', p.row2Label],
    ['col1Label', p.col1Label], ['col2Label', p.col2Label],
  ] as const) {
    ok(!ROWCOL.test(val ?? ''), `${key}: ${field} ("${val}") must not itself be a grid-index placeholder`);
  }
}

// ── 3. custom (the blank slate) is deliberately exempt ──────────────────────
// It has no story to tell — "Enter your own payoff values" — so it correctly
// has no row/col labels and no actor nouns; App.tsx's generic "Row 1"/"Col 2"
// fallback is the RIGHT answer there, not a leak.
ok(PRESETS.custom.row1Label === undefined, 'custom must stay label-free (it has no story)');

// ── 4. the predicate itself fires on the exact defect shape ─────────────────
// Hand-read positive fixtures, not merely asserted: every string below is a
// real substring that was ACTUALLY IN this file before the fix (search,
// penalty) or would have been produced by the same fallback path (bos, pd,
// cnr, spy) — see this file's own PR diff.
const KNOWN_DEFECT_STRINGS = [
  'Left (Row 1)',                 // search, pre-fix
  'Football (Col 2)',             // bos, pre-fix
  'Cooperate (Row 1)',            // pd, pre-fix (mixed with a span)
  'Stay at Home (Row 1)',         // cnr, pre-fix
  'leak classified intel (Row 1)',// spy, pre-fix
  'Row 1 = Aim Left',             // penalty, pre-fix
  'Row2',                         // no-space form, still must fire
  'col 3',                        // lowercase, still must fire
];
for (const s of KNOWN_DEFECT_STRINGS) {
  ok(ROWCOL.test(s), `predicate must fire on the known-defect shape: "${s}"`);
}

// ── 5. the predicate does NOT over-fire on ordinary English ─────────────────
// "row" and "column" as plain words, with no trailing digit, must survive —
// per the repo's standing lesson (predicates over-fire on the first draft,
// every time; hand-read every match before shipping a rate).
const KNOWN_GOOD_STRINGS = [
  'the front row of the stadium',
  'a column of smoke rose from the fire',
  'Row your boat gently down the stream',
  'Search L',   // the ACTUAL fixed label — must never itself match
  'Hide R',
];
for (const s of KNOWN_GOOD_STRINGS) {
  ok(!ROWCOL.test(s), `predicate must NOT fire on ordinary English: "${s}"`);
}

console.log(`presetprose.test.ts: ${checks} checks passed`);
