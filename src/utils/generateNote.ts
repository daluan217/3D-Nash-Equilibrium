/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The one rendering of what "…or generate a new game" just did.
 *
 * WHY THIS EXISTS (STRUCT-REGEN-19/006). `handleGenerateGame` printed four
 * different notes from four `setGenerateNote(...)` call sites, and not one of
 * them mentioned the user's colour highlights — which one of the branches
 * deletes. The "kept" note even enumerates the three fields it protects
 * (name / description / option names), so the omission reads as a promise:
 *
 *     Generate → highlight a phrase of the AI's story → Generate again
 *     → the highlight is gone, and the note is word-for-word the one printed
 *       when nothing was lost.
 *
 * Verified on origin/main 0.0.197 as well as on the branch that fixed the
 * form model, so it is the note that is wrong, not the clearing: the chips
 * describe text that has just been replaced, and keeping them is
 * STRUCT-REGEN-19/001 (a saved record naming phrases its own description does
 * not contain). The app's own standard for saying so is `regenDroppedNote`
 * (RED-REGEN-11/001): "a draw's own actor noun silently truncated by the
 * per-side cap must say so, same as a manual highlight already does."
 *
 * So: ONE outcome value, one rendering per state, and the count of removed
 * highlights rendered in ONE place where noun, verb and pronoun agree in
 * number (the round-16 rule) — instead of a clause bolted onto four strings,
 * three of which would drift the next time one of them is edited.
 *
 * Pure data: no React, no DOM. Every branch is a one-line assertion in
 * `src/generatenote.test.ts`.
 */

/** What the Generate click actually achieved. */
export type GenerateOutcome =
  /** A new board AND a new AI story landed; the form now holds that story. */
  | 'filled'
  /**
   * A new board landed, but the form held text the user had written, so the
   * all-or-nothing rule (`generatedFillIsSafe`) left every field alone — the
   * AI's story was written and discarded.
   */
  | 'kept'
  /** A new board landed; no trustworthy story came back to fill it with. */
  | 'unavailable';

export type EquilibriumKind = 'pure' | 'mixed';

const kindLabel = (k: EquilibriumKind) => (k === 'mixed' ? 'mixed-strategy' : 'pure-strategy');

/**
 * The clause that reports removed highlights, or '' when none were.
 *
 * Exported so the number-agreement test can hit it directly, and so a caller
 * cannot accidentally build a second version of this sentence.
 */
export function highlightsRemovedClause(chipsRemoved: number): string {
  if (chipsRemoved <= 0) return '';
  return chipsRemoved === 1
    ? ' The colour highlight you had added went with the story it described.'
    : ` The ${chipsRemoved} colour highlights you had added went with the story they described.`;
}

/**
 * The note for one Generate click.
 *
 * `chipsRemoved` is how many of the user's colour highlights the click
 * discarded. It is 0 for `'kept'` by construction — that branch keeps every
 * field, chips included — and `generateNote` does not paper over a caller that
 * says otherwise: the count is rendered wherever it is non-zero, so a wrong
 * caller produces a visibly wrong note rather than a silent one.
 */
export function generateNote(kind: EquilibriumKind, outcome: GenerateOutcome, chipsRemoved: number): string {
  const tail = highlightsRemovedClause(chipsRemoved);
  switch (outcome) {
    case 'filled':
      return `New ${kindLabel(kind)} game on the board, scenario written by AI — edit anything below, then save.${tail}`;
    case 'kept':
      return `New ${kindLabel(kind)} game is on the board. Kept the name/description/option names and colour highlights you'd already added — the AI wrote a scenario too, but didn't touch your text. Clear ALL of those fields (not just one) to let it fill them in on the next Generate.${tail}`;
    case 'unavailable':
      return `New ${kindLabel(kind)} game is on the board. The AI scenario isn't available right now — name and describe it yourself below.${tail}`;
    default: {
      // Exhaustiveness: a new outcome must get its own sentence, never a blank.
      const never: never = outcome;
      return never;
    }
  }
}
