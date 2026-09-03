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
import { readFileSync } from 'node:fs';
import { stripUnsafeText, cleanText, clampGraphemeSafe } from './utils/textSafety';

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

// ── 9. RED-APP-7/004 — clampGraphemeSafe, moved here from server.ts so the
//      BROWSER can share the exact same grapheme-boundary logic the label
//      inputs' native `maxLength` used to bypass (it cuts by raw UTF-16 unit
//      count with no grapheme awareness, splitting a typed/pasted ZWJ emoji
//      sequence before this function ever saw the original string).
{
  // Plain ASCII: identical to a bare slice at the boundary — no behavior
  // change for the overwhelmingly common case.
  ok(clampGraphemeSafe('hello world', 5) === 'hello', 'plain ASCII must clamp like a bare slice');
  ok(clampGraphemeSafe('short', 40) === 'short', 'a string under the budget must be returned unchanged');
  ok(clampGraphemeSafe('', 40) === '', 'empty string must return empty string');

  // A lone (unpaired) UTF-16 surrogate anywhere in the string — the general
  // signature of a cut that split a codepoint in half. (Trailing ZWJ with
  // nothing joined after it is the OTHER shape the same class of bug takes,
  // checked separately below with a fixed offset chosen to land there.)
  const hasLoneSurrogate = (s: string): boolean => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF) {
        const next = s.charCodeAt(i + 1);
        if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
        i++; // consumed a VALID pair -- skip the low surrogate, it is not lone
      } else if (c >= 0xDC00 && c <= 0xDFFF) {
        return true; // a low surrogate with nothing valid before it
      }
    }
    return false;
  };

  // The exact defect: a 5x family-emoji ZWJ sequence (55 UTF-16 units, 5
  // grapheme clusters, 11 units each) clamped to a 40-unit budget. A bare
  // `.slice(0, 40)` (what the native `maxLength` attribute effectively does)
  // cuts mid-codepoint here — RED-APP-7/004's own reproduction, byte-for-byte
  // (the finding's own fixture, `"A" + emoji.repeat(20)` clamped to 40, hit
  // the identical mechanism: a lone high surrogate at the cut point).
  const family = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}'; // man ZWJ woman ZWJ girl ZWJ boy
  const fiveFamilies = family.repeat(5);
  ok(fiveFamilies.length === 55, `fixture sanity: 5 family emoji must be 55 UTF-16 units, got ${fiveFamilies.length}`);
  ok(family.length === 11, `fixture sanity: one family-emoji cluster must be 11 UTF-16 units, got ${family.length}`);
  const bareSlice = fiveFamilies.slice(0, 40);
  ok(bareSlice.length === 40 && hasLoneSurrogate(bareSlice),
    `fixture sanity: a BARE slice at 40 must reproduce the defect (a lone/unpaired surrogate) — got ${JSON.stringify(bareSlice)}`);
  const clamped = clampGraphemeSafe(fiveFamilies, 40);
  ok(clamped.length <= 40, `clampGraphemeSafe must respect the budget, got length ${clamped.length}`);
  ok(!hasLoneSurrogate(clamped), `clampGraphemeSafe must never leave a lone/unpaired surrogate, got ${JSON.stringify(clamped)}`);
  // Whole graphemes only: re-segmenting the clamped output must reconstruct
  // it byte-for-byte from complete family-emoji clusters, never a partial one.
  ok(clamped === family.repeat(Math.floor(clamped.length / family.length)) && clamped.length % family.length === 0,
    `clampGraphemeSafe's output must be an exact whole number of complete family-emoji clusters, got ${JSON.stringify(clamped)} (length ${clamped.length})`);
  ok(clamped.length === 33, `with an 11-unit cluster and a 40-unit budget, exactly 3 whole clusters (33 units) fit — got ${clamped.length}`);

  // Same fixture at a width chosen to fall exactly after a ZWJ (33 + 2 + 1 =
  // 36: three whole families, then man ZWJ, cutting before woman) — the
  // OTHER shape this class of bug takes: a dangling joiner with nothing
  // joined after it, not merely a split surrogate pair.
  const clamped36 = clampGraphemeSafe(fiveFamilies, 36);
  ok(!clamped36.endsWith('‍'), `clampGraphemeSafe must never leave a dangling ZWJ either, got ${JSON.stringify(clamped36)}`);
  ok(clamped36.length === 33, `budget 36 with an 11-unit cluster must still yield exactly 3 whole clusters, got ${clamped36.length}`);

  // A single grapheme cluster that alone exceeds the whole budget (an
  // unbounded "zalgo" combining-mark run) must fall back to a codepoint-safe
  // cut of just that cluster rather than silently returning "" and wiping
  // the string RED-CLOUD-6/001 already found for the server-side twin.
  const zalgoBase = 'a';
  const combining = '̀'.repeat(60); // 60 combining grave accents, one grapheme cluster with 'a'
  const zalgo = zalgoBase + combining;
  const clampedZalgo = clampGraphemeSafe(zalgo, 10);
  ok(clampedZalgo.length > 0 && clampedZalgo.length <= 10,
    `an oversized single cluster must fall back to a codepoint-safe partial cut, not "" — got length ${clampedZalgo.length}`);

  // Never returns MORE than the budget, across a spread of astral/ZWJ/plain
  // mixes and boundary widths.
  for (const width of [1, 2, 3, 39, 40, 41, 54, 55, 56]) {
    const out = clampGraphemeSafe(fiveFamilies, width);
    ok(out.length <= width, `clampGraphemeSafe(fiveFamilies, ${width}) must never exceed the budget, got length ${out.length}`);
  }
}

// ── 10. RED-APP-7/004 — structural guard: App.tsx's 4 label inputs (both
//      dialogs) must clamp via clampGraphemeSafe, and must NOT carry the
//      native `maxLength={40}` attribute any more (that attribute is what
//      silently mangled a typed/pasted ZWJ sequence BEFORE React ever saw
//      the value, so removing the clamp from onChange alone is not the fix
//      — the native attribute has to be gone too, or it wins the race on
//      every real keystroke).
//
//      RED-APP-8/002 + RED-APP-8/003 moved PRIMARY enforcement to
//      `onBeforeInput={clampLabelBeforeInput}` (preventDefault before the
//      browser commits an over-budget insertion, so undo never desyncs);
//      `onChange`'s clampLabelInput call is now the SECONDARY guard for the
//      one case onBeforeInput cannot intercept — an IME composition commit
//      — so it must skip while `e.nativeEvent.isComposing` is true or it
//      reintroduces the mid-composition IME fight RED-APP-8/002 found.
{
  const appSrc = readFileSync('src/App.tsx', 'utf8');
  ok(/const clampLabelInput = \(v: string\) => clampGraphemeSafe\(v, 40\);/.test(appSrc),
    'App.tsx must define clampLabelInput = clampGraphemeSafe(v, 40)');
  ok(/function clampLabelBeforeInput\(e: React\.FormEvent<HTMLInputElement>\): void \{/.test(appSrc),
    'App.tsx must define clampLabelBeforeInput (RED-APP-8/002+003 fix)');

  // CodeRabbit finding on this PR: the ORIGINAL version of these checks
  // counted `onBeforeInput`/`onChange`/`onCompositionEnd` sites GLOBALLY
  // (matchAll over the whole file) and only asserted the total came to 2 —
  // so a handler missing from the Edit block while a DIFFERENT one is
  // duplicated in the Save block (or vice versa) would still read "2" and
  // pass, silently letting one dialog regress. Scoped per-dialog now: each
  // dialog's own label-input JSX block (anchored on its own
  // `value={editLabels[key]}` / `value={saveLabels[key]}`, which is
  // dialog-specific — nothing else in the file reads that exact
  // expression) must independently carry all three handlers wired to ITS
  // OWN setter.
  const clampLabelInputCall = /clampLabelInput\(e\.target\.value\)/;
  for (const [setter, anchorText] of [['setEditLabels', 'value={editLabels[key]}'], ['setSaveLabels', 'value={saveLabels[key]}']] as const) {
    const anchorIdx = appSrc.indexOf(anchorText);
    ok(anchorIdx !== -1, `App.tsx must contain the label-input value binding "${anchorText}"`);
    const block = appSrc.slice(anchorIdx, anchorIdx + 1700);

    ok(/onBeforeInput=\{clampLabelBeforeInput\}/.test(block),
      `the ${anchorText} label-input block must carry onBeforeInput={clampLabelBeforeInput}`);

    const onChangeMatch = block.match(new RegExp(
      `onChange=\\{\\(e\\) => ${setter}\\(\\(prev\\) => \\(\\{\\s*\\.\\.\\.prev,\\s*(?:\\/\\/[^\\n]*\\n\\s*)*\\[key\\]: \\(e\\.nativeEvent as InputEvent\\)\\.isComposing \\? e\\.target\\.value : ${clampLabelInputCall.source},\\s*\\}\\)\\)\\}`));
    ok(!!onChangeMatch,
      `the ${anchorText} label-input block must carry an onChange calling ${setter} with clampLabelInput, skipped while composing`);

    // RED-APP-8/002 second-round fix: the composition-commit `input` event
    // often carries the SAME string the last mid-composition `input` event
    // already wrote to the DOM (compositionend just finalizes what was
    // already shown) — React's own value tracker sees no change and
    // suppresses onChange entirely for that event, so relying on onChange
    // alone left an over-budget composed string permanently unclamped after
    // a real composition commit (director-verified: domValueFinalLen 45,
    // full 45-char composition preserved, with only the onChange-based fix).
    // onCompositionEnd fires unconditionally (it is not subject to the
    // value-tracker dedup), so it is the one place guaranteed to see and
    // clamp the committed value.
    ok(new RegExp(`onCompositionEnd=\\{\\(e\\) => \\{[\\s\\S]{0,1200}?${setter}\\(\\(prev\\) => \\(\\{ \\.\\.\\.prev, \\[key\\]: clamped \\}\\)\\)`).test(block),
      `the ${anchorText} label-input block must carry an onCompositionEnd calling ${setter} to clamp the committed value`);

    // No bare native maxLength on this (now clamp-only) label input block.
    ok(!/maxLength=\{40\}/.test(block),
      `REGRESSION GUARD: the ${anchorText} label-input block still has a nearby maxLength={40} — the native `
      + `attribute must be removed, not merely supplemented, or it silently truncates a typed/pasted ZWJ `
      + `sequence before onChange ever runs.`);
  }

  // MUTATION / NEGATIVE FIXTURE — the pre-fix shape, verbatim (bare native
  // maxLength, raw e.target.value with no clamp). Proves the checks above
  // can tell the fixed wiring apart from the defect.
  const preFixInput = `value={saveLabels[key]}
                        onChange={(e) => setSaveLabels((prev) => ({ ...prev, [key]: e.target.value }))}
                        maxLength={40}
                      />`;
  ok(!/clampLabelInput/.test(preFixInput),
    'the pre-fix fixture text must not accidentally already carry the clamp call (fixture sanity check)');
}

console.log(`textsafety.test.ts: ${checks} checks passed`);
