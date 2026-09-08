import { clampGraphemeSafe } from './textSafety';
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ONE definition of which phrases ColorCoded highlights for each player.
 *
 * Why this is a module and not two inline arrays: the same scenario text is
 * rendered on more than one surface — the "Scenario written for this game"
 * suggestion card, and, once the user keeps it, the saved game's description —
 * and those two call sites each built their own term list. The card passed only
 * the scenario's four option names; the saved description passed those PLUS the
 * structural Row/Col terms. Identical text, two different amounts of colored
 * text, changing at the moment the user pressed save. Both call sites now derive
 * their terms here, so the amount of highlighting cannot depend on which surface
 * you happen to be looking at.
 *
 * NOTE: these are terms the APP decides to highlight from the game's own
 * structure. Nothing a user does to their description's coloring belongs here,
 * and none of it is ever sent to the model — the LLM writes prose, the client
 * colors it afterwards, and the two never negotiate.
 */

/** Structural notation, colored on every surface without a caller naming it. */
export const STRUCTURAL_A_TERMS = ['Row 1', 'Row 2'] as const;
export const STRUCTURAL_B_TERMS = ['Col 1', 'Col 2'] as const;

/** The four option names a scenario can carry. */
export interface ScenarioLabels {
  row1?: string | null;
  row2?: string | null;
  col1?: string | null;
  col2?: string | null;
}

/**
 * Build the {a, b} term lists for a scenario.
 *
 * @param sc      the scenario whose option names should be colored, or null
 * @param actorA  extra player-A nouns (presets carry these; saved games do not)
 * @param actorB  extra player-B nouns
 */
export function colorTermsFor(
  sc: ScenarioLabels | null | undefined,
  actorA: readonly string[] = [],
  actorB: readonly string[] = [],
): { a: string[]; b: string[] } {
  const a: string[] = [...STRUCTURAL_A_TERMS];
  const b: string[] = [...STRUCTURAL_B_TERMS];
  if (sc) {
    // Trim here so a dialog's still-being-typed label (the preview's only
    // source) builds the exact term the save path will store — App.tsx's
    // save handlers `.trim()` every label before it reaches the record.
    for (const t of [sc.row1, sc.row2]) if (t && t.trim()) a.push(t.trim());
    for (const t of [sc.col1, sc.col2]) if (t && t.trim()) b.push(t.trim());
    a.push(...actorA);
    b.push(...actorB);
  }
  return dropAmbiguous(a, b);
}

/**
 * A phrase both players can play belongs to NEITHER colour.
 *
 * Symmetric games share option names on purpose — the Prisoner's Dilemma is
 * "Cooperate" for Row 1 AND Col 1, and Battle of the Sexes is Opera/Football
 * for both — so this is correct input, not a defect to reject. But ColorCoded
 * builds its entry list as every A term followed by every B term and takes the
 * first match, so a shared phrase was always painted as A's: right half the
 * time by construction, and misleading precisely where the reader most needs
 * to know whose move is being described.
 *
 * Leaving it uncoloured says the true thing. The reader still gets the
 * structural cues (Row 1, Col 2, x*, E[A]) which are unambiguous, and no
 * sentence claims an option belongs to a player who does not own it.
 *
 * Found by a red-team pass over the local model, where 8.3% of scenarios gave
 * both players the same option names — but the built-in Prisoner's Dilemma
 * preset had the same defect long before any model did.
 */
function dropAmbiguous(a: string[], b: string[]): { a: string[]; b: string[] } {
  // Canonically-equivalent labels (NFC vs NFD "Réserve") render identically but
  // compare unequal without normalizing first, so a shared action would survive
  // on both sides and ColorCoded's first-match order would paint it as A's.
  const inB = new Set(b.map(normTerm));
  const shared = new Set(a.map(normTerm).filter((t) => inB.has(t)));
  if (shared.size === 0) return { a, b };
  return {
    a: a.filter((t) => !shared.has(normTerm(t))),
    b: b.filter((t) => !shared.has(normTerm(t))),
  };
}

/**
 * The same normalization `dropAmbiguous` uses, shared so a term compares
 * equal to a label under exactly one rule everywhere in this module: NFKC
 * (canonically-equivalent forms render identically), zero-width characters
 * stripped, trimmed, case-folded.
 */
/**
 * THE ONE key under which two colour terms are "the same phrase". Every
 * equality in this module — chip vs label (dropAmbiguous, mergeDescriptionTerms),
 * chip vs chip (cleanUserColorTerms), player vs player (cleanUserColorTermPair,
 * regenKeptColorTerms) — goes through it; RED-REGEN-4/001 and RED-REGEN-5/001
 * were the same phrase judged equal by one comparison and different by another.
 * Folds: NFKC; zero-width/joining and soft hyphens gone; apostrophe-like and
 * quote-like glyphs to ASCII (including the prime family's REVERSED forms and
 * the low-9 single quote — each was added only after its sibling in the same
 * family was already here and a variant using the missing one still slipped
 * through; docs/COLOUR-TERMS.md's KEY table names every glyph and its family);
 * dash glyphs to '-'; whitespace collapsed; leading/trailing punctuation
 * dropped (a drag-selection ends on the sentence's period, RED-REGEN-5/002);
 * case; a leading indefinite/definite article ("a "/"an "/"the "), LAST
 * (RED-CLOUD-11/001: a regenerated actor noun and an existing chip naming the
 * SAME character but introduced with a different article — "a landowner" vs
 * "the landowner" — are, to a reader, one phrase; the model itself writes the
 * same referent both ways within one description, indefinite-then-definite,
 * so without this fold the cross-player guard never saw them as equal).
 * Rendering never uses it — ColorCoded matches the literal text — so a
 * chip's stored spelling (including its own article, if any) is untouched;
 * only the EXCLUSIVITY/collision comparisons this key backs are affected.
 */
export function colorTermKey(t: string): string {
  return t
    // Glyph folds run BEFORE NFKC: NFKC decomposes U+00B4 ACUTE ACCENT into
    // SPACE + U+0301, so a fold after it never sees the glyph (RED-REGEN-6/001).
    // U+201A and U+2035 are the single/apostrophe-shaped siblings of U+201E
    // and U+2032, already handled below — a fold list built one glyph at a
    // time misses a sibling until something is measured against it.
    .replace(/[\u2018\u2019\u201A\u02BC\u02B9\u2032\u2035\u0060\u00B4]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036\u00AB\u00BB]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .normalize('NFKC')
    // U+2060 WORD JOINER is the same invisible-joiner class as the ZW*/BOM
    // glyphs beside it — missing it here was the same one-glyph-at-a-time
    // gap as the apostrophe family above, just in the strip list.
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')
    .replace(/\s+/g, ' ')
    // Edge trimming: sentence punctuation, quotes and brackets only — NOT the
    // whole \p{P} class, which also ate '%', '#' and a leading '-' and folded
    // "50%" onto the unrelated "50" (RED-REGEN-6/002). Covers the ideographic
    // and fullwidth forms (。、，；：！？) that a CJK keyboard produces.
    .replace(/^[\s.,;:!?\u2026\u2025\u3002\u3001\uFF0C\uFF1B\uFF1A\uFF01\uFF1F\u00A1\u00BF"'\u00AB\u00BB\u300C\u300D\u300E\u300F\u3008\u3009\u300A\u300B\u3010\u3011\u3014\u3015\uFF08\uFF09\uFF3B\uFF3D\uFF5B\uFF5D()[\]{}]+|[\s.,;:!?\u2026\u2025\u3002\u3001\uFF0C\uFF1B\uFF1A\uFF01\uFF1F\u00A1\u00BF"'\u00AB\u00BB\u300C\u300D\u300E\u300F\u3008\u3009\u300A\u300B\u3010\u3011\u3014\u3015\uFF08\uFF09\uFF3B\uFF3D\uFF5B\uFF5D()[\]{}]+$/g, '')
    .toLowerCase()
    // Last, and only a LEADING article followed by more text — "another"
    // (no space after "an") and a bare "a"/"the" alone (nothing left to fold
    // onto) are both left alone by the `\s+(?=\S)` requirement.
    .replace(/^(?:a|an|the)\s+(?=\S)/, '');
}
function normTerm(t: string): string {
  return colorTermKey(t);
}

/**
 * A scenario's own OPTION LABEL text per player -- row1/row2 for A, col1/col2
 * for B -- trimmed, empties dropped, BEFORE any ambiguity resolution or actor
 * noun is added. This is the ground truth `mergeDescriptionTerms` checks a
 * user/kept colour term against to resolve a collision by LABEL OWNERSHIP
 * (RED-REGEN-3/001): deliberately narrower than `colorTermsFor`'s full term
 * list -- no "Row 1"/"Col 1" structural notation (those two strings are never
 * equal to each other, so they can never collide across players) and no actor
 * nouns (a same-side/opposite-side actor-noun collision is already resolved,
 * separately, by `regenKeptColorTerms`).
 */
export function optionLabelTerms(sc: ScenarioLabels | null | undefined): { a: string[]; b: string[] } {
  const a: string[] = [];
  const b: string[] = [];
  if (sc) {
    for (const t of [sc.row1, sc.row2]) if (t && t.trim()) a.push(t.trim());
    for (const t of [sc.col1, sc.col2]) if (t && t.trim()) b.push(t.trim());
  }
  return { a, b };
}

// ── user-chosen colour terms ────────────────────────────────────────────────
//
// A user can mark phrases in their OWN description to be colored as player A
// or player B. They pick a phrase, not a character range: the description is
// stored and rendered as plain text (deliberately — that is what closed the
// old HTML-injection hole), and a phrase survives later edits to the text
// where stored offsets would silently slide onto the wrong words.
//
// Hard boundary, and the reason this lives in its own section: these terms
// belong to the user's description ONLY. They are never applied to the model's
// prose, and they are never sent to the model. The LLM writes; the client
// colors afterwards; the user's choices decorate their own text and nothing
// else. Anything that would carry these into a prompt is a bug.

/** A term is a phrase, not an essay — it has to fit the sentence it marks. */
export const USER_TERM_MAX_LEN = 60;
/** Enough to mark the words that matter, few enough to stay legible. */
export const USER_TERMS_MAX = 12;

/**
 * RED-REGEN-11/001: every path that can hit the per-side cap must say so, and
 * must name the phrase(s) it could not keep — a silent drop is never
 * possible. Shared by `DescriptionEditor.addSelection` (manual highlight,
 * always its own single side) and `regenKeptColorTerms`'s `dropped` output
 * via `regenDroppedNote` (Regenerate -> Keep, which can drop on A and/or B
 * in the same call), so the two paths say the identical thing for the
 * identical limit instead of one having a message and the other having none.
 */
export function capHitMessage(dropped: readonly string[], player?: 'A' | 'B'): string {
  const quoted = dropped.map((t) => `"${t}"`).join(', ');
  const who = player ? ` for Player ${player}` : '';
  // CodeRabbit (PR #161): a side at the cap can drop SEVERAL generated
  // terms in the same Keep, and one free slot cannot admit all of them —
  // "remove one" was wrong whenever `dropped.length > 1`. Base the count on
  // `dropped.length` itself, the same list `quoted` names.
  const removeCount = dropped.length === 1 ? 'one' : String(dropped.length);
  return `That is ${USER_TERMS_MAX} highlights already${who} — remove ${removeCount} to add ${quoted}.`;
}

/**
 * Clean a user-supplied term list: trim, drop anything under two characters,
 * de-duplicate case-insensitively, cap the length and the count.
 *
 * Single characters are refused for the same reason ColorCoded refuses them —
 * "A" is indistinguishable from the article, and a one-letter term would paint
 * the whole description. The empty string is refused because it builds a regex
 * alternative that matches at every position.
 *
 * Shared by the client (before saving) and the server (before storing) so the
 * two cannot disagree about what a valid term is.
 */

/** True when `s` has a grapheme boundary exactly at `at` — i.e. slicing there keeps every cluster whole. */
function graphemeBrokenAt(s: string, at: number): boolean {
  const SegmenterCtor: typeof Intl.Segmenter | undefined = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  // No Segmenter: a combining or ZWJ sequence cannot be verified whole, so every
  // truncation is treated as a broken cluster (the term is rejected, never
  // stored in part) — CodeRabbit on #152.
  if (typeof SegmenterCtor !== 'function') return at < s.length;
  let pos = 0;
  for (const { segment } of new SegmenterCtor(undefined, { granularity: 'grapheme' }).segment(s)) {
    if (pos === at) return false;
    if (pos > at) return true;
    pos += segment.length;
  }
  return pos !== at;
}

export function cleanUserColorTerms(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    // Collapse internal whitespace too: a selection dragged across a line
    // break arrives with a newline that would never match the rendered text.
    // RED-REGEN-10/003: clamp by grapheme, never by UTF-16 code unit — a
    // `.slice(0, 60)` cut a ZWJ emoji sequence in half and stored the lone
    // surrogate (same class as RED-APP-7/004, third call site).
    const collapsed = raw.replace(/\s+/g, ' ').trim();
    const t = clampGraphemeSafe(collapsed, USER_TERM_MAX_LEN);
    // A single cluster longer than the cap cannot be clamped whole (the
    // fallback slices by code point) — reject it rather than store a part
    // of a grapheme (CodeRabbit CLI on this branch).
    if (t.length < 2 || (t.length < collapsed.length && graphemeBrokenAt(collapsed, t.length))) continue;
    const key = colorTermKey(t);
    if (key.length < 2) continue; // punctuation-only after folding: nothing to highlight
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= USER_TERMS_MAX) break;
  }
  return out;
}

/**
 * Clean BOTH user lists together, keeping ownership exclusive.
 *
 * A phrase must belong to one player. Cleaning the lists independently lets the
 * same phrase sit in both — the editor never produces that, but a direct PATCH
 * can — and then the colour depends on which list the renderer happens to scan
 * first, which is not a decision anyone made. Player A wins the tie: arbitrary,
 * but deterministic and identical on the client and the server.
 */
export function cleanUserColorTermPair(
  a: unknown,
  b: unknown,
): { a: string[]; b: string[] } {
  const cleanA = cleanUserColorTerms(a);
  const ownedByA = new Set(cleanA.map(colorTermKey));
  return {
    a: cleanA,
    b: cleanUserColorTerms(b).filter((t) => !ownedByA.has(colorTermKey(t))),
  };
}

/**
 * RED-REGEN-9/001: the phrases the user has filed on BOTH players — the exact
 * case `cleanUserColorTermPair` resolves A-wins. Returned as B's spellings
 * (the side that loses), in B's order, so the Edit dialog's 409 message can
 * name them and a neutral chip can explain WHY it is neutral (a cross-player
 * chip collision, not the option-label rule). This is the one place that
 * knows the collision; the tooltip and the message both read it.
 */
export function crossPlayerUserTerms(termsA: readonly string[], termsB: readonly string[]): string[] {
  const ownedByA = new Set(cleanUserColorTerms(termsA).map(colorTermKey));
  return cleanUserColorTerms(termsB).filter((t) => ownedByA.has(colorTermKey(t)));
}

/**
 * Merge the app's automatic terms with the user's explicit ones.
 *
 * An explicit assignment WINS: if the user marked "Row 1" for player B, the
 * phrase is removed from player A's automatic list entirely rather than being
 * ordered behind it. Ordering alone cannot express this — ColorCoded builds its
 * entry list as every A term followed by every B term, so an A entry always
 * resolves an exact tie no matter how each list is sorted internally. Removing
 * the loser makes the ownership a property of the data instead of a property of
 * whichever list happened to be scanned first.
 *
 * Exported so the editor's preview and the saved description can merge
 * identically; a preview that disagrees with the save is the exact defect class
 * this whole change set exists to remove.
 *
 * RED-REGEN-3/001: that "explicit assignment wins" rule is right for a
 * DELIBERATE human override, and wrong when the "user term" is only a STALE
 * chip that happens to string-match a brand-new OPTION LABEL the user never
 * typed or reviewed against this exact draw — Regenerate is exactly what
 * produces that combination routinely (measured: ~19% of the shipped bank
 * shares a label verbatim between a Row and a Col option). `labelOwnership`,
 * when given, resolves that case by LABEL ownership instead of chip
 * ownership: a term that string-matches an option label on the OPPOSITE side
 * from where the user filed it — whether that label is exclusive to the
 * opposite side, or shared by both sides (symmetric) — renders NEUTRAL
 * (excluded from both `a` and `b`, never the wrongly-claimed colour and never
 * a fallback to the label's own legitimate colour either, since a stale
 * mis-filed chip is exactly as misleading as no attribution at all). A term
 * that matches only its OWN filed side's label, or matches no label at all,
 * keeps today's unconditional-override behaviour unchanged. The underlying
 * CHIP data (`colorTermsA`/`colorTermsB` on the saved record) is never
 * touched by this — only what gets rendered — so if the labels later change
 * back, the chip colours again on its own (director's decision, 2026-09-04:
 * an AI action never destroys user-authored data, and this collision is not
 * even an AI action).
 */
export function mergeDescriptionTerms(
  base: { a: readonly string[]; b: readonly string[] },
  userA: readonly string[],
  userB: readonly string[],
  labelOwnership?: { a: readonly string[]; b: readonly string[] },
): { a: string[]; b: string[] } {
  const user = cleanUserColorTermPair([...userA], [...userB]);
  const labelA = new Set((labelOwnership?.a ?? []).map(normTerm));
  const labelB = new Set((labelOwnership?.b ?? []).map(normTerm));

  // A term filed under A that string-matches a label on B's side (whether
  // B-exclusive or shared with A too) is neutralized; symmetric for B.
  const neutral = new Set<string>();
  for (const t of user.a) if (labelB.has(normTerm(t))) neutral.add(normTerm(t));
  for (const t of user.b) if (labelA.has(normTerm(t))) neutral.add(normTerm(t));

  const keptUserA = user.a.filter((t) => !neutral.has(normTerm(t)));
  const keptUserB = user.b.filter((t) => !neutral.has(normTerm(t)));

  const claimed = new Set([...keptUserA, ...keptUserB].map(normTerm));
  const keep = (t: string) => !claimed.has(normTerm(t)) && !neutral.has(normTerm(t));
  return {
    a: [...keptUserA, ...base.a.filter(keep)],
    b: [...keptUserB, ...base.b.filter(keep)],
  };
}

// ── Regenerate scenario: ONE resolution shared by the preview and the saved
// render (RED-REGEN/001, RED-REGEN/002) ─────────────────────────────────────
//
// A saved/custom game has exactly one colour-term field pair
// (`colorTermsA`/`colorTermsB`) — there is no separate "scenario actor nouns"
// slot the way a built-in preset has. So when Regenerate's draw supplies actor
// nouns (today: never — SCENARIO_SCHEMA is strict and cannot carry them; see
// RED-REGEN/001), Keep must ADD them to whatever the user already marked,
// never replace it. `regenKeptColorTerms` is that composition, and it is the
// ONE place both the on-screen preview card and what Keep actually stores
// compute it, so the two cannot compose differently the way `colorTermsFor`
// (dropAmbiguous) and `mergeDescriptionTerms` (no ambiguity check) used to.

/**
 * The colour-term CHIPS a Keep will store: the user's existing highlights,
 * untouched, with any actor nouns the draw itself supplies ADDED (deduped,
 * ownership kept exclusive between the two players by `cleanUserColorTermPair`
 * — the same rule the description editor's own chip-picker uses).
 *
 * Director's decision (2026-09-03, revising round-6 decision 3, RED-REGEN/001):
 * an AI action never destroys user-authored data. `keepFill` calls this for
 * its `terms` field; the regen preview card calls it too (via
 * `regenPreviewColorTerms` below) so the preview shows exactly what Keep will
 * produce, never a different composition.
 *
 * CodeRabbit (this PR) caught a real gap in the first version: concatenating
 * `[...existingA, ...actorA]` BEFORE cleaning let an incoming actor noun
 * silently REASSIGN a phrase the user had explicitly placed on the OTHER
 * side. If `existingB` holds "wolf" (the user marked it player B's) and a
 * draw's `actorA` also offers "wolf", cleaning the concatenated A list first
 * makes A "own" wolf, and the B-side clean then drops it as a now-claimed
 * duplicate — the user's OWN assignment silently overwritten by a generated
 * one. "Never destroys user-authored data" has to mean never REASSIGNS it
 * either. Fixed by cleaning the EXISTING pair FIRST (establishing the user's
 * ownership as fixed) and only adding an actor noun when it does not collide
 * with the OTHER side's existing, user-placed term; a colliding actor noun is
 * simply dropped rather than added anywhere, exactly like any other duplicate
 * `cleanUserColorTermPair` already resolves.
 *
 * RED-REGEN-11/001: dropping a noun at the per-side CAP (`USER_TERMS_MAX`,
 * distinct from the cross-player collision above) used to be just as silent,
 * with no way for a caller to tell "the draw supplied no actor noun" apart
 * from "the draw's own actor noun was truncated by a limit it never saw" —
 * the sibling manual-highlight path (`DescriptionEditor.addSelection`) has
 * always told the user this; Keep never did. `dropped` names exactly the
 * newly-offered noun(s) that did not make the final list BECAUSE of the cap
 * — a noun excluded above for colliding with the other side is never in
 * `newA`/`newB` in the first place, so it can never appear here either; the
 * two causes stay distinguishable by construction, not by re-deriving them.
 */
/**
 * RED-REGEN-14/002: the ONE definition of "this phrase occurs in this text as
 * a highlightable term" — exactly the boundary rule `ColorCoded` paints with
 * (case-insensitive; a real word boundary in space-delimited scripts, none in
 * the scripts that write without spaces — see the comment in ColorCoded.tsx
 * and docs/COLOUR-TERMS.md §(c)). `ColorCoded` builds its regex through
 * `termBoundaryRegExp`, and the editor's chip state asks `termOccursIn`, so
 * "the chip paints nothing" and "the chip says it paints nothing" can never
 * be decided by two different rules. Callers pass terms longest-first when
 * the order matters (ColorCoded does); terms under 2 characters are dropped
 * here, the same rule ColorCoded always applied.
 */
const NO_BOUNDARY_SCRIPTS = '\\p{Script=Han}\\p{Script_Extensions=Hiragana}\\p{Script_Extensions=Katakana}'
  + '\\p{Script_Extensions=Hangul}\\p{Script_Extensions=Thai}\\p{Script_Extensions=Lao}'
  + '\\p{Script_Extensions=Khmer}\\p{Script_Extensions=Myanmar}';
const TERM_LEFT = `(?:(?<![\\p{L}\\p{N}\\p{M}_])|(?<=[${NO_BOUNDARY_SCRIPTS}]))`;
const TERM_RIGHT = `(?:(?![\\p{L}\\p{N}\\p{M}_])|(?=[${NO_BOUNDARY_SCRIPTS}]))`;
export function termBoundaryRegExp(terms: readonly string[], flags = 'giu'): RegExp | null {
  const usable = terms.filter((t) => t && t.trim().length >= 2);
  if (usable.length === 0) return null;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${TERM_LEFT}(?:${usable.map(esc).join('|')})${TERM_RIGHT}`, flags);
}
/** True when `term` would be painted somewhere in `text` (see termBoundaryRegExp). */
export function termOccursIn(text: string, term: string): boolean {
  const re = termBoundaryRegExp([term], 'iu');
  return re !== null && re.test(text);
}

export function regenKeptColorTerms(
  actorA: readonly string[],
  actorB: readonly string[],
  existingA: readonly string[],
  existingB: readonly string[],
  /** RED-REGEN-14/002: the description the kept chips will be rendered
   *  against. When given, every EXISTING chip whose phrase no longer occurs
   *  in it (per `termOccursIn`) is named in `orphaned` — still KEPT (the
   *  2026-09-03 rule: an AI action never destroys a user's highlights; the
   *  editor shows such a chip as "not highlighted", and the user may reuse
   *  the phrase or remove the chip), but no longer silently. Omitted (the
   *  preview-card composition, which has no Keep note) reports none. */
  description?: string,
): { a: string[]; b: string[]; dropped: { a: string[]; b: string[] }; orphaned: { a: string[]; b: string[] } } {
  const existing = cleanUserColorTermPair(existingA, existingB);
  const orphaned = description === undefined
    ? { a: [] as string[], b: [] as string[] }
    : { a: existing.a.filter((t) => !termOccursIn(description, t)), b: existing.b.filter((t) => !termOccursIn(description, t)) };
  const ownedA = new Set(existing.a.map(colorTermKey));
  const ownedB = new Set(existing.b.map(colorTermKey));
  // A generated actor noun may add a NEW highlight, but may never claim a
  // phrase the user already placed on the other side.
  const newA = cleanUserColorTerms(actorA).filter((t) => !ownedB.has(colorTermKey(t)));
  const newB = cleanUserColorTerms(actorB).filter((t) => !ownedA.has(colorTermKey(t)));
  const result = cleanUserColorTermPair([...existing.a, ...newA], [...existing.b, ...newB]);
  const resultAKeys = new Set(result.a.map(colorTermKey));
  const resultBKeys = new Set(result.b.map(colorTermKey));
  // CodeRabbit (this PR) + director-reproduced Opus review F1: a newly-
  // offered noun missing from ITS OWN side's result is not always a cap
  // drop — the SAME draw can offer the identical phrase on BOTH sides
  // (actorA and actorB naming the same actor), and one side wins that tie
  // inside the final `cleanUserColorTermPair` call, same as any other
  // same-phrase collision. That is the documented ownership rule, not a
  // capacity loss: the highlight still exists, just attributed to the OTHER
  // player, so it must not be reported as "dropped" on either side. F1: the
  // tie can resolve either way, not only "A wins" — if A's OWN cap truncates
  // the tie phrase out of `[...existing.a, ...newA]` before B is even
  // considered, `resultAKeys` lacks it and B (with room) keeps it, so the
  // ORIGINAL guard (checking only `resultBKeys` for the `a` filter) reported
  // it dropped for A even though it survived, coloured, as a B chip. A term
  // is genuinely dropped only when it appears in NEITHER final list.
  return {
    ...result,
    dropped: {
      a: newA.filter((t) => !resultAKeys.has(colorTermKey(t)) && !resultBKeys.has(colorTermKey(t))),
      b: newB.filter((t) => !resultBKeys.has(colorTermKey(t)) && !resultAKeys.has(colorTermKey(t))),
    },
    orphaned,
  };
}

/**
 * The terms the regen PREVIEW CARD renders with. Must equal what the saved
 * description renders with once Keep, then Save, land: the same
 * `dialogBaseColorTerms` + `mergeDescriptionTerms` composition
 * `DescriptionEditor` uses for every other saved/custom game (see
 * `testDescriptionPreviewMatchesSave` in unit.test.ts), fed the SAME chip pair
 * `regenKeptColorTerms` computes.
 *
 * RED-REGEN/002: before this, the preview called `colorTermsFor` (which runs
 * `dropAmbiguous` over structural + label + actor terms in one pass) while the
 * post-Keep saved render called `mergeDescriptionTerms` (no ambiguity check
 * against the label side at all) — an actor noun colliding with the OTHER
 * player's own option label was shown neutral in the preview and wrongly
 * attributed after Keep. One function, one call order, used by both —
 * a divergence is no longer expressible.
 */
export function regenPreviewColorTerms(
  labels: ScenarioLabels,
  actorA: readonly string[],
  actorB: readonly string[],
  existingA: readonly string[],
  existingB: readonly string[],
): { a: string[]; b: string[] } {
  const kept = regenKeptColorTerms(actorA, actorB, existingA, existingB);
  // dialogBaseColorTerms takes the dialogs' own (always-string) label shape;
  // a regen preview's labels are optional until the draw arrives, same as
  // colorTermsFor already tolerates via its own trim-and-check loop.
  const dialogLabels = {
    row1: labels.row1 ?? '', row2: labels.row2 ?? '',
    col1: labels.col1 ?? '', col2: labels.col2 ?? '',
  };
  return mergeDescriptionTerms(dialogBaseColorTerms(dialogLabels), kept.a, kept.b, optionLabelTerms(dialogLabels));
}

/**
 * Terms for a saved game's OWN description: the structural/scenario terms plus
 * whatever the user marked. Separate from `colorTermsFor` so that using the
 * wrong one on model prose is a visible mistake at the call site rather than a
 * silent leak of the user's choices into the model's writing.
 */
export function descriptionColorTerms(
  sc: ScenarioLabels | null | undefined,
  actorA: readonly string[] = [],
  actorB: readonly string[] = [],
  userA: readonly string[] = [],
  userB: readonly string[] = [],
): { a: string[]; b: string[] } {
  return mergeDescriptionTerms(colorTermsFor(sc, actorA, actorB), userA, userB, optionLabelTerms(sc));
}

/** A saved game's stored record, as far as colouring is concerned. */
export interface SavedGameColorSource {
  row1Label?: string | null;
  row2Label?: string | null;
  col1Label?: string | null;
  col2Label?: string | null;
  colorTermsA?: string[] | null;
  colorTermsB?: string[] | null;
}

/**
 * Terms for a saved game's description, derived from THE GAME'S OWN RECORD.
 *
 * This is the entry point for any surface that renders a saved game's
 * description straight out of the library — the workspace drawer's game cards
 * today, anything list-shaped tomorrow. It exists because those surfaces have
 * no "currently selected game" to read from: they show many games at once, so
 * each card's colouring has to come from that card's own row.
 *
 * The drawer used to build its own pair inline as
 *   aTerms: [g.row1Label, g.row2Label].filter(Boolean)
 *   bTerms: [g.col1Label, g.col2Label].filter(Boolean)
 * which is this module's whole reason for existing, made concrete three ways at
 * once. That list had no structural Row/Col terms, never ran `dropAmbiguous`,
 * and — the one users could actually notice — never read `colorTermsA` /
 * `colorTermsB`, so every highlight a user placed by hand was invisible on that
 * surface while showing correctly in the main panel one click away.
 *
 * Actor nouns are deliberately absent: they are a property of the built-in
 * presets, and a saved game has no `actorA`/`actorB` (see `mergedPresets` in
 * App.tsx, which merges saved games in without them). Passing none here is
 * therefore exactly what the main panel already passes for a custom game, not a
 * simplification of it.
 */
export function savedGameColorTerms(
  g: SavedGameColorSource | null | undefined,
): { a: string[]; b: string[] } {
  // A hand-edited or migration-corrupted db.json can hold a non-array here;
  // mergeDescriptionTerms spreads its user-term args before cleanUserColorTerms
  // gets a chance to Array.isArray-check them, so an object or number throws
  // TypeError instead of being cleaned away. Normalize at this boundary.
  return descriptionColorTerms(
    g ? { row1: g.row1Label, row2: g.row2Label, col1: g.col1Label, col2: g.col2Label } : null,
    [],
    [],
    Array.isArray(g?.colorTermsA) ? g.colorTermsA : [],
    Array.isArray(g?.colorTermsB) ? g.colorTermsB : [],
  );
}

/**
 * The automatic terms a description-editor preview must merge the user's
 * highlights onto: the ones belonging to THE DIALOG'S OWN option names.
 *
 * The preview promises, in its own comment, that "what this preview shows is
 * what the game will show". It kept that promise only by accident, because both
 * dialogs fed it the terms of whatever game was selected in the main panel —
 * which is neither the game being edited nor the option names being typed into
 * the form a few rows below. It broke in both directions: saving a preset under
 * new option names previewed one highlight and saved four, and the pencil on an
 * unselected row previewed three and saved one.
 *
 * Labels arrive as the dialogs hold them — `''` for "not filled in" — and empty
 * strings are dropped by `colorTermsFor`, so a blank form previews exactly the
 * structural terms and nothing else.
 */
export function dialogBaseColorTerms(labels: {
  row1: string;
  row2: string;
  col1: string;
  col2: string;
}): { a: string[]; b: string[] } {
  return colorTermsFor(labels);
}
