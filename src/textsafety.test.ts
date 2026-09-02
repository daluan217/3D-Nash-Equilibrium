/**
 * `stripUnsafeText` / `cleanText` must remove bidi override/embedding
 * characters and raw control characters (RED-PUBLIC D), and must NEVER
 * touch ordinary printable text -- including right-to-left scripts, emoji,
 * and whitespace a multi-line description legitimately needs.
 *
 * Every code point exercised here is written as a NUMBER
 * (String.fromCodePoint(0x...)), never as a `\u` escape or a literal
 * character pasted into this file -- see the "Trojan Source" note in
 * src/utils/textSafety.ts for why.
 *
 *   npx tsx src/textsafety.test.ts
 */
import assert from 'node:assert';
import { stripUnsafeText, cleanText } from './utils/textSafety';

let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  assert(cond, msg);
}

const RLO = String.fromCodePoint(0x202e); // Right-to-Left Override
const LRO = String.fromCodePoint(0x202d); // Left-to-Right Override
const ALM = String.fromCodePoint(0x061c); // Arabic Letter Mark
const LRM = String.fromCodePoint(0x200e);
const RLM = String.fromCodePoint(0x200f);
const LRE = String.fromCodePoint(0x202a);
const RLE = String.fromCodePoint(0x202b);
const PDF = String.fromCodePoint(0x202c);
const LRI = String.fromCodePoint(0x2066);
const RLI = String.fromCodePoint(0x2067);
const FSI = String.fromCodePoint(0x2068);
const PDI = String.fromCodePoint(0x2069);
const DEL = String.fromCodePoint(0x7f);
const NUL = String.fromCodePoint(0x00);
const FORM_FEED = String.fromCodePoint(0x0c);
const VERTICAL_TAB = String.fromCodePoint(0x0b);
const C1_NEL = String.fromCodePoint(0x85); // a C1 control

// ── 1. THE KNOWN-POSITIVE FIXTURE: the actual spoofing shape ────────────────
// "evil<RLO>exe.txt" visually reorders to "eviltxt.exe" in any bidi-aware
// renderer -- this is the exact defect RED-PUBLIC D names, hand-constructed
// and hand-read, not merely asserted against the predicate that removes it.
{
  const spoofed = 'evil' + RLO + 'exe.txt';
  const cleaned = stripUnsafeText(spoofed);
  ok(cleaned === 'evilexe.txt', `RLO must be stripped from the exact spoofing fixture, got ${JSON.stringify(cleaned)}`);
  ok(!cleaned.includes(RLO), 'no RLO code point may survive in cleaned output');
}

// ── 2. every named bidi control character is removed, individually ─────────
for (const [name, ch] of [
  ['ALM', ALM], ['LRM', LRM], ['RLM', RLM],
  ['LRE', LRE], ['RLE', RLE], ['PDF', PDF], ['LRO', LRO], ['RLO', RLO],
  ['LRI', LRI], ['RLI', RLI], ['FSI', FSI], ['PDI', PDI],
] as const) {
  const out = stripUnsafeText('a' + ch + 'b');
  ok(out === 'ab', `${name} must be stripped (got ${JSON.stringify(out)})`);
}

// ── 3. raw control characters are removed ────────────────────────────────
for (const [name, ch] of [
  ['NUL', NUL], ['DEL', DEL], ['FORM FEED', FORM_FEED],
  ['VERTICAL TAB', VERTICAL_TAB], ['C1 NEL', C1_NEL],
] as const) {
  const out = stripUnsafeText('a' + ch + 'b');
  ok(out === 'ab', `${name} must be stripped (got ${JSON.stringify(out)})`);
}

// ── 4. legitimate whitespace survives (a multi-line description needs it) ──
ok(stripUnsafeText('a\tb\nc\rd') === 'a\tb\nc\rd', 'tab/newline/carriage-return must survive');

// ── 5. real right-to-left SCRIPT text is untouched -- this filter removes
//      only the invisible override controls, never a script's own letters
ok(stripUnsafeText('مرحبا بالعالم') === 'مرحبا بالعالم', 'honest Arabic text must render exactly as typed');
ok(stripUnsafeText('שלום עולם') === 'שלום עולם', 'honest Hebrew text must render exactly as typed');

// ── 6. emoji sequences (astral / surrogate-pair code points, some built
//      from ZWJ) survive whole -- proves the code-point iteration is not
//      splitting a surrogate pair or eating the joiner
{
  const family = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}'; // family: man, woman, girl, boy (all base emoji code points, not control chars)
  ok(stripUnsafeText(family) === family, 'a ZWJ emoji sequence must survive unchanged');
  const flag = '\u{1F1FA}\u{1F1F8}'; // US flag (regional indicator pair)
  ok(stripUnsafeText(flag) === flag, 'a flag emoji (surrogate pair) must survive unchanged');
}

// ── 7. cleanText strips THEN trims, in the right order ──────────────────────
// A bidi override sitting at the very edge of the field must not become
// "invisible whitespace that trim() leaves behind" -- stripping first means
// trim() then sees the real edge.
{
  const out = cleanText('  ' + RLO + 'hello' + LRO + '  ');
  ok(out === 'hello', `cleanText must strip controls AND trim, got ${JSON.stringify(out)}`);
}

// ── 8. empty / falsy input is a no-op, not a crash ──────────────────────────
ok(stripUnsafeText('') === '', 'empty string must return empty string');

console.log(`textsafety.test.ts: ${checks} checks passed`);
