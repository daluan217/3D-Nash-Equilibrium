/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Strip Unicode bidi override/embedding characters and raw control
 * characters out of user-typed text before it is saved.
 *
 * RED-PUBLIC D (round 3 starting queue): nothing between the "Game Name" /
 * "Game Description" / option-name inputs and the saved record stripped
 * these. A name saved with a trailing RIGHT-TO-LEFT OVERRIDE codepoint plus
 * "txt.exe" renders the whole tail bidi-REORDERED everywhere this app shows
 * it back (the preset list, the matrix header, the edit dialog, the
 * saved-games grid) -- the classic filename-spoofing trick, applied here to
 * a game name instead of a file name. Raw control characters (form feed,
 * vertical tab, NUL, ...) can corrupt the log lines and layout the same way.
 * Applied at the one choke point every saved field passes through -- the
 * save/edit submit handlers -- rather than on every keystroke, so it never
 * fights the cursor while typing.
 *
 * What survives, deliberately:
 *  - Ordinary whitespace: space, tab, newline, carriage return (descriptions
 *    are multi-line).
 *  - Every printable Unicode character, INCLUDING real right-to-left script
 *    text (Arabic, Hebrew) -- this removes only the override/embedding/
 *    isolate *control* code points, never a script's own letters. An honest
 *    Arabic or Hebrew game name must render exactly as typed.
 *  - Emoji sequences (flag emoji, family emoji, skin-tone modifiers), which
 *    are built from ordinary printable code points this filter never
 *    touches -- and the surrogate-pair-safe iteration below (`for...of` over
 *    code points, not UTF-16 code units) is what keeps an astral character
 *    like an emoji from being split in half by this pass.
 *
 * Every removed code point is listed as a plain decimal/hex NUMBER below,
 * deliberately -- never as a literal character pasted into this source file,
 * and never as a `\u` string escape either. A literal bidi-override
 * character sitting in the SOURCE that defines the filter for bidi
 * overrides is exactly the "Trojan Source" class of bug (CVE-2021-42574 --
 * source-level bidi controls make code review see one thing and the
 * compiler read another); a numeric code point has no such reading.
 */

// Bidi format/control code points: ALM, LRM, RLM, the four embedding/
// override controls (LRE, RLE, PDF, LRO, RLO), and the four isolate
// controls (LRI, RLI, FSI, PDI).
const BIDI_CODEPOINTS = new Set<number>([
  0x061c, // Arabic Letter Mark
  0x200e, // Left-to-Right Mark
  0x200f, // Right-to-Left Mark
  0x202a, // Left-to-Right Embedding
  0x202b, // Right-to-Left Embedding
  0x202c, // Pop Directional Formatting
  0x202d, // Left-to-Right Override
  0x202e, // Right-to-Left Override
  0x2066, // Left-to-Right Isolate
  0x2067, // Right-to-Left Isolate
  0x2068, // First Strong Isolate
  0x2069, // Pop Directional Isolate
]);

const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const DEL = 0x7f;
const C1_START = 0x80;
const C1_END = 0x9f;

function isUnsafeCodePoint(code: number): boolean {
  if (BIDI_CODEPOINTS.has(code)) return true;
  if (code === DEL) return true;
  if (code >= C1_START && code <= C1_END) return true;
  if (code >= 0 && code <= 0x1f) {
    return code !== TAB && code !== LINE_FEED && code !== CARRIAGE_RETURN;
  }
  return false;
}

export function stripUnsafeText(s: string): string {
  if (!s) return s;
  let out = '';
  // Iterate by CODE POINT, not UTF-16 code unit -- a plain for-index loop or
  // .split('') would cut a surrogate pair (any astral character: most emoji)
  // in half, corrupting exactly the text this function must leave untouched.
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code === undefined || !isUnsafeCodePoint(code)) out += ch;
  }
  return out;
}

/** `stripUnsafeText` then `.trim()` -- the exact pair every save/edit submit
 *  handler needs, so the two can never be applied in the wrong order (a
 *  bidi override sitting right at the edge of a field must be stripped
 *  BEFORE trim decides where the "real" edge of the string is, not after). */
export function cleanText(s: string): string {
  return stripUnsafeText(s).trim();
}

/**
 * Cut `s` to at most `maxLength` UTF-16 units without ever splitting a
 * surrogate pair -- a plain codepoint-by-codepoint walk, weaker than a full
 * grapheme-cluster boundary (it can separate a base character from its own
 * combining marks), but that is exactly and only what happens when a SINGLE
 * cluster does not fit the budget at all: there is no boundary-safe cut that
 * keeps it whole, and returning nothing is worse than a partial cluster.
 */
function codepointSafeSlice(s: string, maxLength: number): string {
  let out = '';
  for (const ch of s) {
    if (out.length + ch.length > maxLength) break;
    out += ch;
  }
  return out;
}

/**
 * Clamp a string to at most `maxLength` UTF-16 code units WITHOUT ever
 * cutting inside a surrogate pair or a multi-codepoint grapheme cluster
 * (emoji skin-tone modifiers, ZWJ family/profession sequences, flag
 * sequences -- all built from 2+ codepoints, several also astral so each
 * codepoint is itself a 2-unit surrogate pair).
 *
 * Originally server.ts-only (RED-CLOUD-5/001: a bare `.slice(0, maxLength)`
 * split an astral character's surrogate pair, producing an unpaired high
 * surrogate that rendered as mojibake). Moved here (RED-APP-7/004) so the
 * BROWSER can share the exact same boundary logic — the label inputs' own
 * native `maxLength={40}` attribute enforces the same 40-unit budget by raw
 * UTF-16 code unit count with NO grapheme awareness, so it was cutting a
 * typed/pasted ZWJ emoji sequence mid-grapheme client-side, before this
 * (correct) server-side clamp ever got a chance to run on the original
 * string — there was nothing left for it to protect. `Intl.Segmenter` is
 * available in every evergreen browser and in the Node 22 runtime this app
 * targets; a codepoint-safe fallback covers the (theoretical, here) absence.
 *
 * A grapheme cluster has no upper size bound (a base character followed by
 * an unbounded run of combining marks, i.e. "zalgo" text, is still ONE
 * cluster under the same UAX #29 rules `Intl.Segmenter` implements) — when
 * the FIRST cluster already exceeds the whole budget, fall back to a
 * codepoint-safe (not grapheme-safe) cut of just that oversized cluster
 * rather than returning "" and silently discarding the whole string.
 */
/**
 * Would inserting `insertedData` at the given selection push the field over
 * `maxLength` grapheme-safe units? Framework-agnostic (no DOM/React types)
 * so both an `<input>`'s `onBeforeInput` (App.tsx's label/name fields,
 * 40-unit budget) and a `<textarea>`'s (DescriptionEditor.tsx, 800-unit
 * budget) can share the exact same boundary check rather than each
 * reimplementing the "read the prospective value, compare it against its
 * own grapheme-safe clamp" logic — RED-APP-9/003 found the Name and
 * Description fields had never been given the RED-APP-7/004 treatment at
 * all (still bare native `maxLength`, which cuts by UTF-16 code unit with
 * no grapheme awareness), and a second hand-copied implementation is
 * exactly the kind of drift this codebase has been burned by before (see
 * `clampGraphemeSafe`'s own docstring above).
 *
 * `target` only needs the three properties every native text input/
 * textarea element already has; passing the DOM node itself works
 * unchanged.
 */
export function wouldExceedGraphemeBudget(
  target: { value: string; selectionStart: number | null; selectionEnd: number | null },
  insertedData: string | null | undefined,
  maxLength: number,
): boolean {
  if (!insertedData) return false; // deletions and other non-inserting edits have nothing to bound
  const current = target.value;
  const selStart = target.selectionStart ?? current.length;
  const selEnd = target.selectionEnd ?? current.length;
  const prospective = current.slice(0, selStart) + insertedData + current.slice(selEnd);
  return clampGraphemeSafe(prospective, maxLength) !== prospective;
}

export function clampGraphemeSafe(s: string, maxLength: number): string {
  if (s.length <= maxLength) return s;
  const SegmenterCtor: typeof Intl.Segmenter | undefined = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (typeof SegmenterCtor === 'function') {
    const segmenter = new SegmenterCtor(undefined, { granularity: 'grapheme' });
    let out = '';
    for (const { segment } of segmenter.segment(s)) {
      if (out.length + segment.length > maxLength) {
        if (out.length === 0) out = codepointSafeSlice(segment, maxLength);
        break;
      }
      out += segment;
    }
    return out;
  }
  let out = '';
  for (const ch of s) {
    if (out.length + ch.length > maxLength) {
      if (out.length === 0) out = codepointSafeSlice(ch, maxLength);
      break;
    }
    out += ch;
  }
  return out;
}
