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
  cleanUserColorTermPair,
  colorTermsFor,
  mergeDescriptionTerms,
  regenKeptColorTerms,
  regenPreviewColorTerms,
  savedGameColorTerms,
  type ScenarioLabels,
} from './utils/colorTerms';
import { readFileSync } from 'node:fs';

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
const ALL_FOLD_FAMILIES: Array<{ base: string; variants: Variant[] }> = [
  { base: APOSTROPHE_BASE, variants: APOSTROPHE_VARIANTS },
  { base: DASH_BASE, variants: DASH_VARIANTS },
  { base: INVISIBLE_BASE, variants: INVISIBLE_VARIANTS },
  { base: WHITESPACE_BASE, variants: WHITESPACE_VARIANTS },
  { base: CANONICAL_BASE, variants: CANONICAL_VARIANTS },
  { base: 'Cooperate', variants: CASE_VARIANTS },
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

if (failures > 0) {
  console.error(`✗ colorterms.property.test.ts: ${failures}/${cases} checks failed`);
  process.exit(1);
}
console.log(`✓ colorterms.property.test.ts: ${cases} generated cases passed — ${ALL_FOLD_FAMILIES.reduce((n, f) => n + f.variants.length, 0)} `
  + `glyph variants across ${ALL_FOLD_FAMILIES.length} fold families, ${EDGE_STRIP_WRAPS.length} edge-strip wraps, `
  + `${NEGATIVE_PAIRS.length} negative pairs, ${ownershipCases} ownership x surface sweeps, ${N_RANDOM - randomSkippedGaps} random-sampled draws `
  + `(${randomSkippedGaps} skipped, same documented gap), plus the server.ts/App.tsx structural contract for the RED-REGEN-7/001 cross-tab PATCH race. `
  + `Documented storage-round-trip gap (see docs/COLOUR-TERMS.md, out of scope): ${[...new Set(storageRoundTripGaps)].join(', ') || 'none'}.`);
