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
