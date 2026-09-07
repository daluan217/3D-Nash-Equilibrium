/**
 * Property suite for the colour-term equivalence contract — docs/COLOUR-TERMS.md
 * is the written contract; this file is a GENERATOR that holds every real call
 * site to it at once, instead of the hand-picked fixtures RED-REGEN-4 through
 * RED-REGEN-7 each found the next gap in one at a time (apostrophe fold, then
 * cross-player exclusivity never using it, then a listed-but-NFKC-dead glyph,
 * then an over-broad edge trim, then a per-field PATCH race across two
 * INDEPENDENT requests). Every existing hand-written fixture in
 * unit.test.ts's "Fixture 2b/2c" (RED-REGEN-4/001, RED-REGEN-5/001+002,
 * RED-REGEN-6/001+002) is reproduced here as a generated case — both are kept:
 * this file for the sweep, unit.test.ts for the exact, hand-read regressions.
 *
 * WHY A GENERATOR, NOT MORE HAND-PICKED PAIRS: every prior round's fixture
 * proved its OWN glyph and stopped there — the next round always found a
 * SIBLING glyph in the same family the fixture never tried (U+2035 next to
 * U+2032, U+201A next to U+201E, U+2060 next to U+200B — see colorTerms.ts's
 * own comment). A generator that crosses every fold family x every edge class
 * x every ownership case x every surface answers "and every OTHER glyph in
 * this family?" once, structurally, instead of per red-team round.
 *
 *   npx tsx src/colorterms.property.test.ts
 */
import {
  colorTermKey,
  cleanUserColorTerms,
  USER_TERM_MAX_LEN,
  USER_TERMS_MAX,
  cleanUserColorTermPair,
  colorTermsFor,
  crossPlayerUserTerms,
  mergeDescriptionTerms,
  regenKeptColorTerms,
  regenPreviewColorTerms,
  savedGameColorTerms,
  capHitMessage,
  type ScenarioLabels,
} from './utils/colorTerms';
import { regenDroppedNote } from './utils/scenarioRegen';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ColorCoded } from './components/ColorCoded';
import { DescriptionEditor } from './components/DescriptionEditor';

let failures = 0;
let cases = 0;
function check(name: string, ok: boolean, detail = ''): void {
  cases++;
  if (!ok) { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
}

// deterministic PRNG (same algorithm as src/unit.test.ts's own, so a CI log
// diff never has to explain two different generators)
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(0xC0107); // "COLOR"
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];

// ═════════════════════════════════════════════════════════════════════════
// FOLD FAMILIES — every glyph class docs/COLOUR-TERMS.md's KEY table names,
// as a function from an ASCII base phrase to a variant spelling. Two ASCII
// base phrases carry an apostrophe/dash so every family has something to
// vary; every variant must fold to the IDENTICAL colorTermKey as the base.
// ═════════════════════════════════════════════════════════════════════════
const APOSTROPHE_BASE = "Farmer's Market";
type Variant = { family: string; glyph: string; make: (s: string) => string };
const APOSTROPHE_VARIANTS: Variant[] = [
  { family: 'apostrophe', glyph: 'U+2019 curly ’', make: (s) => s.replace(/'/g, '’') },
  { family: 'apostrophe', glyph: 'U+2018 curly ‘', make: (s) => s.replace(/'/g, '‘') },
  { family: 'apostrophe', glyph: 'U+201A low-9 ‚', make: (s) => s.replace(/'/g, '‚') },
  { family: 'apostrophe', glyph: 'U+02BC modifier ʼ', make: (s) => s.replace(/'/g, 'ʼ') },
  { family: 'apostrophe', glyph: 'U+02B9 modifier ʹ', make: (s) => s.replace(/'/g, 'ʹ') },
  { family: 'apostrophe', glyph: 'U+2032 prime ′', make: (s) => s.replace(/'/g, '′') },
  { family: 'apostrophe', glyph: 'U+2035 reversed prime ‵', make: (s) => s.replace(/'/g, '‵') },
  { family: 'apostrophe', glyph: 'U+0060 backtick `', make: (s) => s.replace(/'/g, '`') },
  { family: 'apostrophe', glyph: 'U+00B4 acute accent ´', make: (s) => s.replace(/'/g, '´') },
  { family: 'apostrophe', glyph: 'U+FF07 fullwidth ＇', make: (s) => s.replace(/'/g, '＇') },
];
const DASH_BASE = 'Cease-fire';
const DASH_VARIANTS: Variant[] = [
  { family: 'dash', glyph: 'U+2010 hyphen', make: (s) => s.replace(/-/g, '‐') },
  { family: 'dash', glyph: 'U+2011 non-breaking hyphen', make: (s) => s.replace(/-/g, '‑') },
  { family: 'dash', glyph: 'U+2012 figure dash', make: (s) => s.replace(/-/g, '‒') },
  { family: 'dash', glyph: 'U+2013 en dash', make: (s) => s.replace(/-/g, '–') },
  { family: 'dash', glyph: 'U+2014 em dash', make: (s) => s.replace(/-/g, '—') },
  { family: 'dash', glyph: 'U+2015 horizontal bar', make: (s) => s.replace(/-/g, '―') },
  { family: 'dash', glyph: 'U+2212 minus sign', make: (s) => s.replace(/-/g, '−') },
  { family: 'dash', glyph: 'U+FF0D fullwidth hyphen-minus', make: (s) => s.replace(/-/g, '－') },
];
const INVISIBLE_BASE = 'Cooperate';
const INVISIBLE_VARIANTS: Variant[] = [
  { family: 'invisible', glyph: 'U+200B ZWSP mid-word', make: (s) => s.slice(0, 4) + '​' + s.slice(4) },
  { family: 'invisible', glyph: 'U+200C ZWNJ mid-word', make: (s) => s.slice(0, 4) + '‌' + s.slice(4) },
  { family: 'invisible', glyph: 'U+200D ZWJ mid-word', make: (s) => s.slice(0, 4) + '‍' + s.slice(4) },
  { family: 'invisible', glyph: 'U+FEFF BOM mid-word', make: (s) => s.slice(0, 4) + '﻿' + s.slice(4) },
  { family: 'invisible', glyph: 'U+00AD soft hyphen mid-word', make: (s) => s.slice(0, 4) + '­' + s.slice(4) },
  { family: 'invisible', glyph: 'U+2060 word joiner mid-word', make: (s) => s.slice(0, 4) + '⁠' + s.slice(4) },
];
const WHITESPACE_BASE = 'Two Words';
const WHITESPACE_VARIANTS: Variant[] = [
  { family: 'whitespace', glyph: 'U+00A0 NBSP', make: (s) => s.replace(' ', ' ') },
  { family: 'whitespace', glyph: 'U+2009 thin space', make: (s) => s.replace(' ', ' ') },
  { family: 'whitespace', glyph: 'U+202F narrow NBSP', make: (s) => s.replace(' ', ' ') },
  { family: 'whitespace', glyph: 'double ASCII space', make: (s) => s.replace(' ', '  ') },
];
const CANONICAL_BASE = 'Réserve'; // NFD: e + combining acute
const CANONICAL_VARIANTS: Variant[] = [
  { family: 'canonical', glyph: 'NFC (single precomposed é)', make: () => 'Réserve' },
];
// Case: every check in this file already case-folds via colorTermKey; one
// representative pair is enough to prove the class, not a whole family.
const CASE_VARIANTS: Variant[] = [
  { family: 'case', glyph: 'SCREAMING CASE', make: (s) => s.toUpperCase() },
];
// RED-CLOUD-11/001: a regenerated actor noun and an existing chip naming the
// SAME character but introduced with a different leading article ("a
// landowner" vs "the landowner") must collide for EXCLUSIVITY purposes — the
// model itself writes the same referent both ways (indefinite, then definite)
// within one description. Works on any word, like case/invisible/whitespace
// above, so it is NOT added to NEEDS_OWN_BASE.
const ARTICLE_VARIANTS: Variant[] = [
  { family: 'article', glyph: 'leading "a "', make: (s) => `a ${s}` },
  { family: 'article', glyph: 'leading "an "', make: (s) => `an ${s}` },
  { family: 'article', glyph: 'leading "the "', make: (s) => `the ${s}` },
  { family: 'article', glyph: 'leading "The " (capitalized)', make: (s) => `The ${s}` },
];
const ALL_FOLD_FAMILIES: Array<{ base: string; variants: Variant[] }> = [
  { base: APOSTROPHE_BASE, variants: APOSTROPHE_VARIANTS },
  { base: DASH_BASE, variants: DASH_VARIANTS },
  { base: INVISIBLE_BASE, variants: INVISIBLE_VARIANTS },
  { base: WHITESPACE_BASE, variants: WHITESPACE_VARIANTS },
  { base: CANONICAL_BASE, variants: CANONICAL_VARIANTS },
  { base: 'Cooperate', variants: CASE_VARIANTS },
  { base: 'Landowner', variants: ARTICLE_VARIANTS },
];

// EDGE-STRIP class: wrapping a bare phrase in these must fold to the SAME key
// (sentence punctuation, quotes, brackets — including CJK/fullwidth forms).
const EDGE_STRIP_WRAPS: Array<{ name: string; wrap: (s: string) => string }> = [
  { name: 'trailing period', wrap: (s) => `${s}.` },
  { name: 'trailing comma', wrap: (s) => `${s},` },
  { name: 'trailing question mark', wrap: (s) => `${s}?` },
  { name: 'trailing ellipsis', wrap: (s) => `${s}…` },
  { name: 'leading+trailing curly quotes', wrap: (s) => `“${s}”` },
  { name: 'leading+trailing straight quotes', wrap: (s) => `"${s}"` },
  { name: 'leading+trailing parens', wrap: (s) => `(${s})` },
  { name: 'ideographic full stop', wrap: (s) => `${s}。` },
  { name: 'inverted exclamation (leading)', wrap: (s) => `¡${s}!` },
  { name: 'CJK corner brackets', wrap: (s) => `「${s}」` },
  { name: 'fullwidth parens', wrap: (s) => `（${s}）` },
  { name: 'leading+trailing whitespace', wrap: (s) => `   ${s}\t\n` },
];

// EDGE-PRESERVE class: these must NOT fold away — they change the phrase.
// Each entry is a NEGATIVE pair: two phrases the contract says are DIFFERENT.
const NEGATIVE_PAIRS: Array<[string, string, string]> = [
  ['50%', '50', 'percent sign carries meaning'],
  ['#tag', 'tag', 'hash carries meaning'],
  ['-50', '50', 'leading minus carries meaning'],
  ['+50', '50', 'leading plus carries meaning'],
  ['$50', '50', 'currency sign carries meaning'],
  ['Co-op', 'Coop', 'an inner dash is not punctuation to strip'],
  ['another chance', 'a chance', '"another" is not the article "an" + a word (no space after "an")'],
  ['a-frame', 'frame', 'a hyphen right after "a" blocks the article fold (no whitespace follows)'],
  ['a landowner', 'a farmer', 'the SAME article on two DIFFERENT nouns must still be different phrases'],
  ['Wolf', 'Rabbit', 'unrelated words'],
  ['(Cooperate)', 'Retreat', 'unrelated words, one merely bracketed'],
  ["Farmer's", "Farmers", 'the apostrophe is part of the word’s spelling, not edge punctuation'],
];

// ═════════════════════════════════════════════════════════════════════════
// PART 1 — colorTermKey: every variant in every fold family collides with
// its own base, and with every OTHER variant in the same family (not just
// with the ASCII base) — RED-REGEN-6/001 was exactly a variant matching the
// base directly while missing a DIFFERENT variant in the very same family.
// ═════════════════════════════════════════════════════════════════════════
for (const { base, variants } of ALL_FOLD_FAMILIES) {
  const baseKey = colorTermKey(base);
  for (const v of variants) {
    const made = v.make(base);
    check(`fold[${v.family}] ${v.glyph}: colorTermKey(variant) === colorTermKey(base)`,
      colorTermKey(made) === baseKey,
      `base=${JSON.stringify(base)} variant=${JSON.stringify(made)} keys=${JSON.stringify([colorTermKey(made), baseKey])}`);
  }
  // every PAIR of variants within the family must also collide with EACH
  // OTHER (not routed through the base) -- this is what would have caught
  // RED-REGEN-6/001 even if U+00B4 had never been compared to the ascii "'".
  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) {
      const a = variants[i].make(base), b = variants[j].make(base);
      check(`fold[${variants[i].family}] ${variants[i].glyph} vs ${variants[j].glyph} collide with EACH OTHER`,
        colorTermKey(a) === colorTermKey(b), `a=${JSON.stringify(a)} b=${JSON.stringify(b)}`);
    }
  }
}
for (const wrap of EDGE_STRIP_WRAPS) {
  const bare = 'Cooperate';
  check(`edge-strip: ${wrap.name} folds away`, colorTermKey(wrap.wrap(bare)) === colorTermKey(bare),
    `wrapped=${JSON.stringify(wrap.wrap(bare))} -> ${JSON.stringify(colorTermKey(wrap.wrap(bare)))}`);
}
for (const [x, y, why] of NEGATIVE_PAIRS) {
  check(`edge-preserve (negative): ${JSON.stringify(x)} !== ${JSON.stringify(y)} (${why})`,
    colorTermKey(x) !== colorTermKey(y), `keys=${JSON.stringify([colorTermKey(x), colorTermKey(y)])}`);
}

// `cleanUserColorTerms` collapses internal whitespace (incl. NBSP/thin-space/
// U+FEFF — JS's own `\s` treats the historical BOM/ZWNBSP as whitespace,
// documented in docs/COLOUR-TERMS.md's "out of scope" list) into a plain
// space BEFORE it ever computes a key, so the text a chip is actually STORED
// as can differ from the raw selection. Every check below compares against
// what the real pipeline stores, not the raw variant text, or the whitespace
// family would fail this suite for behaving exactly as documented.
const storedForm = (s: string): string => cleanUserColorTerms([s])[0] ?? s;

// ═════════════════════════════════════════════════════════════════════════
// PART 2 — per-side equality sites: cleanUserColorTerms (dedup within one
// side) and cleanUserColorTermPair (cross-player exclusivity) must agree
// with colorTermKey on every fold-family variant pair. This is the
// RED-REGEN-5/001 class: the apostrophe fold existed but a DIFFERENT
// equality site (plain .toLowerCase()) never used it.
// ═════════════════════════════════════════════════════════════════════════
for (const { base, variants } of ALL_FOLD_FAMILIES) {
  for (const v of variants) {
    const made = v.make(base);
    if (colorTermKey(storedForm(made)) !== colorTermKey(base)) continue; // see storedForm's comment (U+FEFF)
    // dedup: [base, variant] on the SAME side collapses to one entry, and
    // keeps the FIRST spelling (documented cleanUserColorTerms behaviour).
    const deduped = cleanUserColorTerms([base, made]);
    check(`cleanUserColorTerms dedup[${v.family}] ${v.glyph}: [base, variant] -> 1 entry, first spelling kept`,
      deduped.length === 1 && deduped[0] === base,
      `got ${JSON.stringify(deduped)}`);
    // cross-player exclusivity: A=[base], B=[variant] -> B is empty, A keeps
    // its OWN spelling (never silently rewritten to the loser's spelling).
    const pair = cleanUserColorTermPair([base], [made]);
    check(`cleanUserColorTermPair[${v.family}] ${v.glyph}: A=[base] vs B=[variant] -> B empty, A unaffected`,
      pair.a.length === 1 && pair.a[0] === base && pair.b.length === 0,
      `got ${JSON.stringify(pair)}`);
  }
}
// Negative pairs must SURVIVE on opposite sides with their OWN spelling.
for (const [x, y] of NEGATIVE_PAIRS) {
  const pair = cleanUserColorTermPair([x], [y]);
  check(`cleanUserColorTermPair (negative): ${JSON.stringify(x)} on A and ${JSON.stringify(y)} on B BOTH survive`,
    pair.a.length === 1 && pair.a[0] === x && pair.b.length === 1 && pair.b[0] === y,
    `got ${JSON.stringify(pair)}`);
}

// ═════════════════════════════════════════════════════════════════════════
// PART 3 — OWNERSHIP x SURFACE: for every fold-family variant, cross every
// named ownership case (symmetric label, other-exclusive label, own label,
// cross-player chip, regen actor noun) against every surface the contract
// promises agrees (preview card, saved render/drawer — the SAME call chain,
// checked here as two named entry points so a future divergence between them
// is still caught, per RED-REGEN/002's own history).
// ═════════════════════════════════════════════════════════════════════════
function savedRender(labels: ScenarioLabels, userA: readonly string[], userB: readonly string[]) {
  return savedGameColorTerms({
    row1Label: labels.row1, row2Label: labels.row2, col1Label: labels.col1, col2Label: labels.col2,
    colorTermsA: [...userA], colorTermsB: [...userB],
  });
}
let ownershipCases = 0;
const storageRoundTripGaps: string[] = [];
for (const { base, variants } of ALL_FOLD_FAMILIES) {
  for (const v of variants) {
    const variantForm = v.make(base);
    // What the term is actually STORED as, after cleanUserColorTerms's own
    // preprocessing — every ownership function re-cleans its inputs
    // internally, so this (not the raw selection) is what ends up in the
    // arrays these checks read. Using the raw form here would either miss a
    // real gap (whitespace-family variants get canonicalized to a plain
    // space before storage, so ".includes(variantForm)" would wrongly find
    // nothing whether or not the code is correct) or wrongly fail a working
    // contract (same reason, reversed).
    const stored = storedForm(variantForm);
    if (colorTermKey(stored) !== colorTermKey(base)) {
      // Documented gap, not a contract violation: found by this suite,
      // narrowed to exactly one glyph (U+FEFF, see storedForm's own
      // comment) with near-zero real reach (a literal BOM selected
      // mid-word), tracked in docs/COLOUR-TERMS.md's "out of scope" list
      // rather than silently skipped.
      storageRoundTripGaps.push(`${v.family}/${v.glyph}`);
      continue;
    }
    ownershipCases++;

    // (o1) SYMMETRIC label (both sides), chip on A spelled as the VARIANT ->
    // neutral on BOTH sides, in the preview AND the saved render.
    const symmetric: ScenarioLabels = { row1: base, row2: 'Hold Back', col1: base, col2: 'Ignore' };
    const previewSym = regenPreviewColorTerms(symmetric, [], [], [variantForm], []);
    const savedSym = savedRender(symmetric, [variantForm], []);
    check(`(o1)[${v.family}/${v.glyph}] symmetric label + variant chip: neutral in PREVIEW`,
      !previewSym.a.includes(stored) && !previewSym.b.includes(stored), JSON.stringify(previewSym));
    check(`(o1)[${v.family}/${v.glyph}] symmetric label + variant chip: neutral in SAVED RENDER (agrees with preview)`,
      !savedSym.a.includes(stored) && !savedSym.b.includes(stored), JSON.stringify(savedSym));

    // (o2) label EXCLUSIVE to A (row1 only), chip filed on B spelled as the
    // VARIANT of that same label -> neutral (chip filed on the OTHER side
    // from the label it names).
    const asym: ScenarioLabels = { row1: base, row2: 'Stay Home', col1: 'Hunt', col2: 'Retreat' };
    const previewOther = regenPreviewColorTerms(asym, [], [], [], [variantForm]);
    const savedOther = savedRender(asym, [], [variantForm]);
    check(`(o2)[${v.family}/${v.glyph}] variant chip on B naming A's label: neutral in PREVIEW`,
      !previewOther.b.includes(stored), JSON.stringify(previewOther));
    check(`(o2)[${v.family}/${v.glyph}] variant chip on B naming A's label: neutral in SAVED RENDER`,
      !savedOther.b.includes(stored), JSON.stringify(savedOther));

    // (o3) REGRESSION: chip filed on the SAME side as its matching label
    // (variant spelling) -> stays coloured, not neutralized.
    const previewOwn = regenPreviewColorTerms(asym, [], [], [variantForm], []);
    check(`(o3)[${v.family}/${v.glyph}] variant chip on A naming A's OWN label: stays coloured (not neutralized)`,
      previewOwn.a.includes(stored), JSON.stringify(previewOwn));

    // (o4) cross-player CHIP-vs-CHIP (no label at all): base on A, variant on
    // B -> B's is dropped entirely, A keeps its own spelling. (Already swept
    // in PART 2 via cleanUserColorTermPair directly; repeated here through
    // mergeDescriptionTerms/savedGameColorTerms so the SAVED-RENDER surface
    // is proven too, not just the lower-level pair function.)
    const noLabel: ScenarioLabels = { row1: 'Advertise', row2: 'Hold back', col1: 'Match', col2: 'Ignore' };
    const savedChipVsChip = savedRender(noLabel, [base], [variantForm]);
    check(`(o4)[${v.family}/${v.glyph}] chip-vs-chip cross-player, no label: A keeps base spelling, B empty (SAVED RENDER)`,
      savedChipVsChip.a.includes(base) && !savedChipVsChip.b.some((t) => colorTermKey(t) === colorTermKey(base)),
      JSON.stringify(savedChipVsChip));

    // (o5) regen actor noun (variant) vs an EXISTING chip (base) on the
    // OTHER side -> the generated noun must never be added.
    const kept = regenKeptColorTerms([], [variantForm], [base], []);
    check(`(o5)[${v.family}/${v.glyph}] regen actor noun (variant) colliding with existing OTHER-side chip: never added`,
      kept.b.length === 0 && kept.a.includes(base), JSON.stringify(kept));
  }
}

// Negative ownership control: a NON-colliding chip must NOT be neutralized —
// this is the "the check is only worth something if it can fail" guard
// (unit.test.ts's own "NEGATIVE CONTROL" comment, reproduced here).
{
  const asym: ScenarioLabels = { row1: 'Advertise', row2: 'Hold back', col1: 'Match', col2: 'Ignore' };
  const nonLabel = regenPreviewColorTerms(asym, [], [], ['the hedge'], []);
  check('negative control: a chip matching NO label is never neutralized', nonLabel.a.includes('the hedge'), JSON.stringify(nonLabel));
}

// ═════════════════════════════════════════════════════════════════════════
// RED-CLOUD-11/001, exact hand-read reproduction: the finding's own draw 17
// (main 3f699f4) — a regenerated actor noun ("a landowner") for Player A
// colliding with an EXISTING Player B chip ("the landowner") from the
// PREVIOUS story, differing only by leading article. Before the article fold
// this slipped `regenKeptColorTerms`'s cross-player guard entirely (both
// chips got stored, per the finding's own trace: kept.a included "a
// landowner" AND kept.b kept "the landowner"). Reproduced directly, not just
// through the generic family sweep above, so this exact case is pinned by
// name.
// ═════════════════════════════════════════════════════════════════════════
{
  const existingA = ['the surveyor'];
  const existingB = ['the landowner'];
  const newActorA = ['a landowner'];
  const newActorB = ['a hedge-layer'];
  const kept = regenKeptColorTerms(newActorA, newActorB, existingA, existingB);
  check('RED-CLOUD-11/001: "a landowner" (new, Player A) colliding with the EXISTING "the landowner" (Player B) is never added to A',
    !kept.a.some((t) => colorTermKey(t) === colorTermKey('a landowner')), JSON.stringify(kept));
  check('RED-CLOUD-11/001: Player B keeps its existing "the landowner" chip unchanged',
    kept.b.includes('the landowner'), JSON.stringify(kept));
  check('RED-CLOUD-11/001: Player A keeps its own unrelated existing chip ("the surveyor")',
    kept.a.includes('the surveyor'), JSON.stringify(kept));
  check('RED-CLOUD-11/001: Player B\'s genuinely NEW, non-colliding actor noun ("a hedge-layer") is still added',
    kept.b.includes('a hedge-layer'), JSON.stringify(kept));
  // Rendering-side control: the fold above must NEVER reach ColorCoded's own
  // literal match — a chip stored as "the landowner" still colours only the
  // literal text "the landowner", never a bare "landowner" occurring without
  // its article (docs/COLOUR-TERMS.md — rendering never uses colorTermKey).
  const renderPlain = rendered('The landowner agrees, and a landowner nearby does not.', [], ['the landowner']);
  const spansB = [...renderPlain.matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);
  check('RED-CLOUD-11/001 rendering control: "the landowner" chip colours ONLY its own literal text, never the bare "landowner" (no article) elsewhere in the same sentence',
    spansB.length === 1 && spansB[0] === 'The landowner', JSON.stringify({ renderPlain, spansB }));
}

// ═════════════════════════════════════════════════════════════════════════
// PART 4 — VOLUME PAD: the same ownership x surface sweep repeated over a
// seeded random sample of (family, variant, ownership-case) draws, so the
// suite's total exceeds 5,000 cases the way a real fuzz sweep would rather
// than by inflating the class list artificially. Every draw is one of the
// SAME checks above (o1/o2), just re-run against a randomly chosen family,
// glyph and a randomly generated base phrase built from a small word pool —
// this catches an ORDER-dependent bug (a family whose fold only works on the
// FIRST base word it was ever tested against) that a fixed base word cannot.
// ═════════════════════════════════════════════════════════════════════════
const WORD_POOL = ['Wolf', 'Rabbit', 'Harbor', 'Ticket', 'Bakery', 'Signal', 'Ledger', 'Anchor', 'Meadow', 'Cinder'];
// apostrophe/dash/canonical families need their own literal base character
// (a plain word has no apostrophe/dash/diacritic to vary); the others
// (invisible/whitespace/case) work on any 4+ letter word, so vary the WORD
// to prove the fold is not an accident of one fixed phrase.
const NEEDS_OWN_BASE = new Set([ALL_FOLD_FAMILIES[0], ALL_FOLD_FAMILIES[1], ALL_FOLD_FAMILIES[4]]);
const N_RANDOM = 5200;
let randomSkippedGaps = 0;
for (let i = 0; i < N_RANDOM; i++) {
  const fam = pick(ALL_FOLD_FAMILIES);
  const v = pick(fam.variants);
  const base = NEEDS_OWN_BASE.has(fam) ? fam.base : pick(WORD_POOL);
  const variantForm = v.make(base);
  const stored = storedForm(variantForm);
  if (colorTermKey(stored) !== colorTermKey(base)) { randomSkippedGaps++; continue; } // see storedForm's comment (U+FEFF)
  const symmetric: ScenarioLabels = { row1: base, row2: 'Hold Back', col1: base, col2: 'Ignore' };
  const preview = regenPreviewColorTerms(symmetric, [], [], [variantForm], []);
  check(`random[${i}] (${fam.variants[0].family}/${v.glyph}) symmetric label + variant chip stays neutral`,
    !preview.a.includes(stored) && !preview.b.includes(stored), JSON.stringify({ base, variantForm, stored, preview }));
}

// ═════════════════════════════════════════════════════════════════════════
// PART 5 — server.ts structural contract: the ONE key function backs the
// PATCH validator too (single source of truth, not a reimplementation), and
// the per-field pairing added by #126 (RED-APP-10/001) plus the RED-REGEN-7/001
// 409 guard both call the SAME cleanUserColorTermPair/cleanUserColorTerms.
// A source-grep, not an HTTP round trip: booting a real server for 5,000
// generated cases does not fit this file's <20s budget (no fast-unit file in
// this repo boots a live server); the real HTTP round trip for the two
// concrete attack orders lives in
// src/integration/colorterms-patch-race.test.mjs (CI's `integration` job),
// which this check's own comment points at so the two never drift apart.
// ═════════════════════════════════════════════════════════════════════════
{
  const serverSrc = readFileSync('server.ts', 'utf8');
  check('server.ts imports the SAME cleanUserColorTermPair/cleanUserColorTerms the client uses (single source)',
    /from ["']\.\/src\/utils\/colorTerms["']/.test(serverSrc) && /cleanUserColorTermPair/.test(serverSrc) && /cleanUserColorTerms\b/.test(serverSrc),
    'server.ts must import the shared functions rather than reimplement the equality rule');
  check('PATCH /api/games/:id pairs a lone submitted side against the STORED other side (not an empty default)',
    /hasA \? req\.body\.colorTermsA : storedA/.test(serverSrc) && /hasB \? req\.body\.colorTermsB : storedB/.test(serverSrc),
    'the pairing call must read game.colorTermsA/B when the request omits that side');
  check('RED-REGEN-7/001: a request never silently rewrites a colour-term side it did not submit or explicitly empty via a stored-side collision (409 guard present)',
    /untouchedAChanged \|\| untouchedBChanged \|\| explicitAEmptiedByStoredB \|\| explicitBEmptiedByStoredA/.test(serverSrc)
      && /res\.status\(409\)/.test(serverSrc),
    'the 409 refusal must exist and must be gated on the untouched/emptied-by-STORED-side conditions, not fire on a same-request self-collision (see src/integration/colorterms-patch-race.test.mjs for the live HTTP proof of both commit orders)');
}
{
  const appSrc = readFileSync('src/App.tsx', 'utf8');
  const fnStart = appSrc.indexOf('const handleEditGameSubmit = async');
  const fnEnd = appSrc.indexOf('\n  };\n', fnStart);
  check('located handleEditGameSubmit in App.tsx', fnStart !== -1 && fnEnd !== -1, `fnStart=${fnStart} fnEnd=${fnEnd}`);
  const fn = fnStart !== -1 && fnEnd !== -1 ? appSrc.slice(fnStart, fnEnd) : '';
  // Every status this handler branches on explicitly (200 success, 404
  // deleted-elsewhere) is named; everything else -- 401, 409, 500, any future
  // code -- falls into ONE generic branch that must show the server's
  // message and must NOT close the dialog. A 409 (RED-REGEN-7/001's cross-tab
  // collision refusal) relies on exactly this generic branch, so it is
  // checked by NAME here rather than assumed from the 409 guard's own
  // presence in server.ts.
  const errStart = fn.indexOf("} else if (res.status === 404)");
  check('the 404-then-generic error chain exists in handleEditGameSubmit', errStart !== -1, 'could not find the 404 branch');
  const errRegion = errStart !== -1 ? fn.slice(errStart) : '';
  check('the error region sets editError with the server\'s message (data.error)',
    /setEditError\(data\.error \|\| 'Failed to update game\.'\)/.test(errRegion), errRegion.slice(0, 300));
  check('RED-REGEN-7/001: no status-handling branch after the success case may close the Edit dialog '
    + '(a 409 falls into the generic branch here; closing it would drop the collision message unseen)',
    !/setIsEditModalOpen\(false\)/.test(errRegion), errRegion.slice(0, 300));
}

// ═════════════════════════════════════════════════════════════════════════
// PART 6 — RED-REGEN-8/001: ColorCoded's OWN boundary regex (never routed
// through colorTermKey, §(c)) must be Unicode-letter-aware so an ASCII chip
// adjacent to a non-ASCII letter does not match mid-word, while CJK/kana
// script (no spaces between words at all) keeps matching mid-compound — a
// DECIDED, documented exception (docs/COLOUR-TERMS.md §(c)), not an
// oversight. Calls the real exported `ColorCoded` via `renderToStaticMarkup`
// — real React rendering, not a reimplementation of the regex.
// ═════════════════════════════════════════════════════════════════════════
function rendered(text: string, aTerms: string[] = [], bTerms: string[] = []): string {
  return renderToStaticMarkup(React.createElement(ColorCoded, { text, aTerms, bTerms }));
}
function isHighlighted(html: string): boolean { return /<span/.test(html); }

// MUST-NOT-MATCH: an ASCII (or shorter accented) chip whose match would end
// mid-word against an adjacent non-ASCII letter, across several scripts —
// the exact class RED-REGEN-8/001 found (not just the one Latin example).
const BOUNDARY_MUST_NOT_MATCH: Array<{ name: string; text: string; term: string }> = [
  { name: 'Latin (Portuguese): "cora" before ç in "coração"', text: 'O coração decide.', term: 'cora' },
  { name: 'Latin (French): "tr" before è in "très"', text: 'Il est très calme.', term: 'tr' },
  { name: 'Latin (Swedish): "rd" after å in "gård"', text: 'En gård i skogen.', term: 'rd' },
  { name: 'Latin (Spanish): "se" before ñ in "señor"', text: 'El señor decide.', term: 'se' },
  { name: 'Latin (German): "Wal" before ö in "Walöl"', text: 'Der Anbieter verkauft Walöl heute.', term: 'Wal' },
  { name: 'Cyrillic: "при" before мер in "пример"', text: 'Вот пример игры.', term: 'при' },
  { name: 'Greek: "θε" before ωρ in "θεωρία"', text: 'Η θεωρία λέει.', term: 'θε' },
  { name: 'digit boundary: "item" before "_2" (underscore+digit are word chars)', text: 'Choose item_2 now.', term: 'item' },
  { name: 'underscore boundary: "foo" adjacent to "_bar"', text: 'Pick foo_bar please.', term: 'foo' },
];
for (const c of BOUNDARY_MUST_NOT_MATCH) {
  const html = rendered(c.text, [c.term]);
  check(`(boundary) ${c.name}: must NOT highlight (inside one word)`, !isHighlighted(html), html);
}

// MUST-MATCH: the whole accented/non-Latin word, and an ASCII chip with a
// genuine ASCII-only word boundary on both sides (positive controls proving
// the check above can fail, and that the fix is not simply "never match").
const BOUNDARY_MUST_MATCH: Array<{ name: string; text: string; term: string }> = [
  { name: 'whole accented word: "très"', text: 'Il est très calme.', term: 'très' },
  { name: 'whole Cyrillic word: "пример"', text: 'Вот пример игры.', term: 'пример' },
  { name: 'whole Greek word: "θεωρία"', text: 'Η θεωρία λέει.', term: 'θεωρία' },
  { name: 'ASCII control: "se" as its own word', text: 'El comprador se decide rapido.', term: 'se' },
  { name: 'digit-adjacent whole word still matches when the WORD itself, not a prefix, is the chip', text: 'Choose item_2 now.', term: 'item_2' },
];
for (const c of BOUNDARY_MUST_MATCH) {
  const html = rendered(c.text, [c.term]);
  check(`(boundary) ${c.name}: must highlight`, isHighlighted(html), html);
}

// NEGATIVE CONTROL: the ASCII-neighbour case must NOT match either (proves
// the defect is specifically "adjacent to a NON-ASCII letter", not "any
// adjacent letter" — RED-REGEN-8/001's own falsifier, reproduced here).
{
  const html = rendered('A tree grows.', ['tr']);
  check('(boundary) negative control: ASCII "tr" inside "tree" stays plain (both agree)', !isHighlighted(html), html);
}

// CJK DECISION, documented in docs/COLOUR-TERMS.md §(c): Han/Hiragana/
// Katakana carry no inter-word spaces, so a chip may still match mid-run —
// kept, not changed, and pinned here so a future "fix" cannot flip it
// silently.
{
  const html = rendered('彼は日本語を話す。', ['日本']);
  check('(boundary) CJK: "日本" inside "日本語" still highlights (decided, documented behaviour)', isHighlighted(html), html);
  // Katakana compounds use the long-vowel mark ー (U+30FC, Script=Common but
  // Script_Extensions=Katakana): with Script=Katakana alone the mark counted as a
  // letter and "パ" no longer matched inside "スーパー" (CodeRabbit on #142).
  const htmlKana = rendered('駅前のスーパーで会う。', ['パー']);
  check('(boundary) CJK: "パー" inside "スーパー" (preceded by the long-vowel mark ー) highlights like other kana; mutation: Script= instead of Script_Extensions= → plain', isHighlighted(htmlKana), htmlKana);
}
{
  // RED-REGEN-9/002 (director-reproduced): the no-boundary class is the
  // WRITING SYSTEM — Thai (no spaces at all) and Hangul with an attached
  // particle (the ordinary Korean sentence) regressed to never matching
  // after #142. Mutation: drop Thai/Hangul from ColorCoded's carve-out → the
  // three MUST-MATCH checks fail; the Latin controls must keep failing to
  // match (a "fix" that just removes the boundary would pass the first three
  // and break the controls).
  check('(boundary) Thai: "ชาวนา" inside continuous Thai prose highlights', isHighlighted(rendered('ชาวนาและพ่อค้าตกลงกันเรื่องราคาข้าว', ['ชาวนา'])));
  check('(boundary) Thai: "ชาวนา" before a real period highlights', isHighlighted(rendered('ทุกคนรู้จักชาวนา.', ['ชาวนา'])));
  check('(boundary) Hangul: "농부" with the particle 와 attached ("농부와") highlights', isHighlighted(rendered('농부와 상인이 계약서에 서명했다.', ['농부'])));
  check('(boundary) Hangul: bare "농부" before a comma still highlights', isHighlighted(rendered('농부, 상인, 그리고 변호사가 만났다.', ['농부'])));
  check('(boundary) Lao: "ຊາວນາ" inside Lao prose highlights', isHighlighted(rendered('ຊາວນາແລະພໍ່ຄ້າຕົກລົງກັນ', ['ຊາວນາ'])));
  check('(boundary) Latin control: "se" never splits "señor"', !isHighlighted(rendered('El señor llegó.', ['se'])));
  check('(boundary) Latin control: "wolf" never matches inside "wolves"', !isHighlighted(rendered('The wolves circle the pond.', ['wolf'])));
  check('(boundary) Cyrillic control (space-delimited): "вол" never matches inside "волк"', !isHighlighted(rendered('Серый волк бежит.', ['вол'])));
  // Mixed scripts (CodeRabbit on #148): a change of writing system IS a word
  // boundary — no word is spelled across two scripts — so a Latin chip next to
  // Thai/Hangul letters matches ("wolf와": a Korean particle attached to a Latin
  // noun is the ordinary shape), while a same-script neighbour still blocks it.
  check('(boundary) mixed: "wolf" between Thai letters ("ชาวนาwolfและ") highlights — the script change is the boundary', isHighlighted(rendered('ชาวนาwolfและ', ['wolf'])));
  check('(boundary) mixed: "wolf" with a Hangul particle attached ("wolf와") highlights', isHighlighted(rendered('wolf와 상인이 만났다', ['wolf'])));
  check('(boundary) mixed control: "wolf" after Hangul but inside "wolves" ("상인wolves") does NOT match', !isHighlighted(rendered('상인wolves', ['wolf'])));
  check('(boundary) mixed control: "wolf" glued to Cyrillic letters ("Серыйwolf") does NOT match (both space-delimited)', !isHighlighted(rendered('Серыйwolf', ['wolf'])));
}
{
  // A CJK chip with real neighbours on both sides in the SAME script also
  // works (not just adjacent to the one deliberately-exempted example).
  const html = rendered('東京タワーは高い。', ['タワー']);
  check('(boundary) CJK/Katakana: "タワー" inside "東京タワーは" still highlights', isHighlighted(html), html);
}

// COMBINING MARKS (CodeRabbit, this PR): an NFD-normalized "café" is the
// base letters "cafe" followed by a SEPARATE combining-mark code point
// (U+0301, COMBINING ACUTE ACCENT) — a chip matching only the base letters
// must not match (it would leave the accent rendered outside the coloured
// span, splitting the same grapheme this fix exists to keep whole); a chip
// that IS the full NFD grapheme (base + combining mark) must still match.
{
  const nfdCafe = 'cafe' + '́'; // "café", NFD form: 5 UTF-16 code units
  const text = `The ${nfdCafe} is closed today.`;
  const htmlBaseOnly = rendered(text, ['cafe']);
  check('(boundary) NFD combining mark: chip "cafe" (base letters only) must NOT match "café" (NFD, base + combining accent)',
    !isHighlighted(htmlBaseOnly), htmlBaseOnly);
  const htmlFullGrapheme = rendered(text, [nfdCafe]);
  check('(boundary) NFD combining mark: chip = the FULL NFD grapheme ("cafe" + combining accent) still highlights',
    isHighlighted(htmlFullGrapheme), htmlFullGrapheme);
}

if (failures > 0) {
  console.error(`✗ colorterms.property.test.ts: ${failures}/${cases} checks failed`);
  process.exit(1);
}
// PART 7 — RED-REGEN-9/001: a B chip that goes neutral because the SAME
// phrase is filed on A in this dialog must say so (cross-player cause), and
// the helper both the tooltip and the Edit dialog's 409 message read must
// name exactly the losing spellings. Rendered through the REAL
// DescriptionEditor (server-side), read from the real chip attributes.
{
  const cross = crossPlayerUserTerms(['wolf', 'Hedge'], ['Wolf', 'pond', 'HEDGE']);
  check('crossPlayerUserTerms names B\'s losing spellings, in B\'s order', cross.join('|') === 'Wolf|HEDGE', cross.join('|'));
  check('crossPlayerUserTerms is empty when the sides are disjoint', crossPlayerUserTerms(['wolf'], ['pond']).length === 0);
  check('crossPlayerUserTerms folds a leading article, the same rule the server\'s 409 guard applies (RED-APP-13/001: "a wolf" vs "wolf")',
    crossPlayerUserTerms(['wolf'], ['a wolf']).join('|') === 'a wolf' && crossPlayerUserTerms(['the Wolf'], ['wolf']).join('|') === 'wolf');
  check('crossPlayerUserTerms never reports A (A wins the tie)', !crossPlayerUserTerms(['wolf'], ['Wolf']).includes('wolf'));
  const render = (termsA: string[], termsB: string[], labelA: string[] = []) => renderToStaticMarkup(
    React.createElement(DescriptionEditor, {
      value: 'The wolf circles the pond while the hedge waits.',
      onChange: () => {},
      termsA, termsB,
      onTermsChange: () => {},
      labelA,
    }),
  );
  const chipAttrs = (html: string, player: 'A' | 'B') => {
    const m = html.match(new RegExp(`<button[^>]*data-player="${player}"[^>]*>`));
    if (!m) return null;
    const attr = (n: string) => (m[0].match(new RegExp(`${n}="([^"]*)"`)) ?? [])[1] ?? null;
    return { suppressed: attr('data-suppressed'), cause: attr('data-suppressed-cause'), title: attr('title') };
  };
  const collided = chipAttrs(render(['wolf'], ['Wolf']), 'B');
  check('DescriptionEditor: the B chip colliding with A\'s own chip is neutral with the cross-player cause and wording',
    !!collided && collided.suppressed === 'true' && collided.cause === 'cross-player'
      && /also a Player A highlight/.test(collided.title ?? '') && !/option label/.test(collided.title ?? ''), JSON.stringify(collided));
  const labelCase = chipAttrs(render([], ['Cooperate'], ['Cooperate']), 'B');
  check('DescriptionEditor: a B chip naming A\'s option label keeps the label wording (control)',
    !!labelCase && labelCase.suppressed === 'true' && labelCase.cause === 'label' && /option label/.test(labelCase.title ?? ''), JSON.stringify(labelCase));
  const winner = chipAttrs(render(['wolf'], ['Wolf']), 'A');
  check('DescriptionEditor: the A chip that wins the tie is not suppressed', !!winner && winner.suppressed === null, JSON.stringify(winner));
  // The Edit dialog's 409 branch must read the same helper (structural).
  const app = readFileSync('src/App.tsx', 'utf8');
  const branch = app.slice(app.indexOf("res.status === 409"), app.indexOf("res.status === 409") + 6000);
  check('App.tsx 409 branch names the colliding phrase via crossPlayerUserTerms on every 409 (first and retry)',
    /crossPlayerUserTerms\(/.test(branch) && /Not saved: \$\{collisionNote\}/.test(branch) && /highlighted for both players/.test(branch));
}

// PART 8 — RED-REGEN-10/002+003 (+001 as a UX note), director-reproduced.
{
  // 003: the length cap is grapheme-safe on the SHARED validator (server + client).
  const fam = '👨\u200d👩\u200d👧\u200d👦';
  const [capped] = cleanUserColorTerms([fam.repeat(9)]);
  const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
  const parts = [...seg.segment(capped)].map((x) => x.segment);
  check('cleanUserColorTerms caps by grapheme: every kept family emoji is intact (mutation: `.slice(0, USER_TERM_MAX_LEN)` → a lone surrogate tail)',
    capped.length <= USER_TERM_MAX_LEN && parts.length > 0 && parts.every((g) => g === fam), JSON.stringify({ units: capped.length, graphemes: parts.length }));
  const bigCluster = 'e' + '\u0301'.repeat(80); // one grapheme, 81 code units: cannot be clamped whole
  check('cleanUserColorTerms REJECTS a single cluster longer than the cap instead of storing part of it (CodeRabbit CLI)',
    cleanUserColorTerms([bigCluster]).length === 0, JSON.stringify(cleanUserColorTerms([bigCluster])));
  check('cleanUserColorTerms never ends on a lone surrogate', !/[\ud800-\udfff]$/.test(capped) || /[\udc00-\udfff]$/.test(capped) && /[\ud800-\udbff][\udc00-\udfff]$/.test(capped));
  // 002: the counter's denominator is the pooled room (per-side cap × 2).
  const html = renderToStaticMarkup(React.createElement(DescriptionEditor, {
    value: 'x', onChange: () => {}, termsA: ['aa', 'bb'], termsB: ['cc'], onTermsChange: () => {},
  }));
  check(`DescriptionEditor counter reads "(3/${USER_TERMS_MAX * 2})" — pooled numerator over pooled room (mutation: /USER_TERMS_MAX alone → "(24/12)" reachable)`,
    html.includes(`(3/${USER_TERMS_MAX * 2})`), html.match(/\(\d+\/\d+\)/)?.[0] ?? 'no counter');
  // 001: moving a phrase to the other player is announced (structural).
  const editor = readFileSync('src/components/DescriptionEditor.tsx', 'utf8');
  check('DescriptionEditor announces a chip that moved from the other player (movedFrom hint)',
    /movedFrom/.test(editor) && /was highlighted for Player \$\{movedFrom\}; it now belongs to Player \$\{player\}/.test(editor));
}

// PART 9 — RED-REGEN-11/001: the per-side USER_TERMS_MAX cap on Regenerate ->
// Keep must report exactly which actor noun(s) it dropped, the same way the
// manual-highlight path (`DescriptionEditor.addSelection`) already reports
// its own cap hit -- a Keep-side drop used to be totally silent (no field on
// the return, no note, nothing). Mutation: remove `dropped` from
// `regenKeptColorTerms`'s return (revert to the bare `cleanUserColorTermPair`
// result) -> every check in this block either throws (reading `.a`/`.b` off
// `undefined`) or reads an empty/undefined list and fails.
{
  const fullA = Array.from({ length: USER_TERMS_MAX }, (_, i) => `harbour master ${i + 1}`);
  const fullB = Array.from({ length: USER_TERMS_MAX }, (_, i) => `dock hand ${i + 1}`);

  // Both sides already at the cap: the draw's own actor noun on EACH side is
  // dropped, and named -- not merely counted.
  const bothFull = regenKeptColorTerms(['the lighthouse keeper'], ['the ferry crew'], fullA, fullB);
  check('regenKeptColorTerms: A at cap drops and NAMES the new A noun',
    bothFull.dropped.a.includes('the lighthouse keeper'), JSON.stringify(bothFull.dropped));
  check('regenKeptColorTerms: B at cap drops and NAMES the new B noun',
    bothFull.dropped.b.includes('the ferry crew'), JSON.stringify(bothFull.dropped));
  check('regenKeptColorTerms: a dropped noun never sneaks into the kept list too',
    !bothFull.a.includes('the lighthouse keeper') && !bothFull.b.includes('the ferry crew'));

  // One side full, the other free: only the full side reports a drop (positive
  // control -- proves this is cap-specific, not "always report something");
  // the free side's noun is genuinely ADDED, not silently lost either.
  const oneFull = regenKeptColorTerms(['the lighthouse keeper'], ['the ferry crew'], fullA, []);
  check('regenKeptColorTerms: the FULL side (A) drops and names its noun',
    oneFull.dropped.a.includes('the lighthouse keeper'), JSON.stringify(oneFull.dropped));
  check('regenKeptColorTerms: the FREE side (B) reports no drop at all',
    oneFull.dropped.b.length === 0, JSON.stringify(oneFull.dropped));
  check('regenKeptColorTerms: the FREE side\'s own noun is actually kept',
    oneFull.b.includes('the ferry crew'));

  // Cross-player exclusivity vs the cap: a noun filtered because the OTHER
  // side already owns it (an existing, unrelated rule) must NOT be reported
  // as a cap drop -- the two causes stay distinguishable by construction.
  const exclusivity = regenKeptColorTerms(['wolf'], [], [], ['wolf']);
  check('regenKeptColorTerms: a cross-player-excluded noun is NOT reported as a cap drop (different cause)',
    exclusivity.dropped.a.length === 0, JSON.stringify(exclusivity.dropped));
  check('regenKeptColorTerms: (control) the cross-player exclusion itself still applies',
    !exclusivity.a.includes('wolf') && exclusivity.b.includes('wolf'));

  // CodeRabbit (this PR): a SAME-DRAW tie -- actorA and actorB offer the
  // IDENTICAL phrase, with no cap pressure at all (both sides empty) -- must
  // not be reported dropped either. A wins the tie inside the final
  // `cleanUserColorTermPair` call (documented ownership rule); the highlight
  // still exists, just attributed to A, so B's `dropped` must stay empty.
  // Mutation: drop the `&& !resultAKeys.has(...)` conjunct from `dropped.b`
  // -> this check fails (b.dropped would wrongly include 'shared').
  const tieDraw = regenKeptColorTerms(['shared'], ['shared'], [], []);
  check('regenKeptColorTerms: a same-draw A/B naming tie is NOT reported as a cap drop for B (A winning the tie is not a capacity loss)',
    tieDraw.dropped.b.length === 0, JSON.stringify(tieDraw.dropped));
  check('regenKeptColorTerms: (control) the tie itself still resolves to A, same as cleanUserColorTermPair elsewhere',
    tieDraw.a.includes('shared') && !tieDraw.b.includes('shared'));

  // capHitMessage: exact wording, shared by both add-paths -- one term with
  // no player tag (the manual picker's own single-side case), several terms
  // with one (Keep's per-side case).
  check('capHitMessage names a single dropped term, no player tag when omitted',
    capHitMessage(['the lighthouse keeper']) === 'That is 12 highlights already — remove one to add "the lighthouse keeper".');
  check('capHitMessage names every dropped term, comma-joined, with the player tag',
    capHitMessage(['x', 'y'], 'A') === 'That is 12 highlights already for Player A — remove one to add "x", "y".');

  // regenDroppedNote: the one place Keep turns `dropped` into the note shown
  // through the SAME role="status" aria-live="polite" region every other
  // regen note already uses (App.tsx's `regen.note`).
  check('regenDroppedNote is null when nothing was dropped (the common case)',
    regenDroppedNote({ a: [], b: [] }) === null);
  const combined = regenDroppedNote({ a: ['the lighthouse keeper'], b: ['the ferry crew'] });
  check('regenDroppedNote names BOTH sides\' dropped nouns when both cap out in the same Keep',
    combined === `${capHitMessage(['the lighthouse keeper'], 'A')} ${capHitMessage(['the ferry crew'], 'B')}`, combined ?? 'null');

  // Structural: the manual-highlight cap hint (DescriptionEditor.addSelection)
  // calls the SAME shared helper, so the two paths cannot drift back onto
  // different wording for the identical limit.
  const editorSrc = readFileSync('src/components/DescriptionEditor.tsx', 'utf8');
  check('DescriptionEditor\'s cap-hit hint calls the shared capHitMessage helper (not a bespoke, unnamed string)',
    /setHint\(capHitMessage\(\[term\]\)\)/.test(editorSrc));
}

if (failures > 0) {
  // The mid-file gate after PART 6 only stops a run early when PART 1-6
  // already failed; PART 7/8/9 failures reached this point with NOTHING
  // setting a non-zero exit code (confirmed by mutation: a forced failing
  // check here printed "✗" to stderr and the process still exited 0, so
  // `npm test`'s `&&` chain never saw it and this file logged "passed" on a
  // red run). This is the one gate that actually fails the process for
  // every PART in the file, not just the first six.
  console.error(`✗ colorterms.property.test.ts: ${failures}/${cases} checks failed`);
  process.exit(1);
}
console.log(`✓ colorterms.property.test.ts: ${cases} generated cases passed — ${ALL_FOLD_FAMILIES.reduce((n, f) => n + f.variants.length, 0)} `
  + `glyph variants across ${ALL_FOLD_FAMILIES.length} fold families, ${EDGE_STRIP_WRAPS.length} edge-strip wraps, `
  + `${NEGATIVE_PAIRS.length} negative pairs, ${ownershipCases} ownership x surface sweeps, ${N_RANDOM - randomSkippedGaps} random-sampled draws `
  + `(${randomSkippedGaps} skipped, same documented gap), plus the server.ts/App.tsx structural contract for the RED-REGEN-7/001 cross-tab PATCH race. `
  + `Documented storage-round-trip gap (see docs/COLOUR-TERMS.md, out of scope): ${[...new Set(storageRoundTripGaps)].join(', ') || 'none'}.`);
