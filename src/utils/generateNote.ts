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
import type { FieldSource } from './saveFormModel';

export type GenerateOutcome = GenerateResult['outcome'];

/**
 * The outcome AND everything its sentence needs — one value, so a branch cannot
 * be rendered without the facts it asserts.
 *
 * STRUCT-REGEN-19/008: `'kept'` used to be a bare string, and its sentence
 * enumerated four things ("the name/description/option names and colour
 * highlights") whatever the user actually had. Typing in one option-name box —
 * the first thing anyone does in this dialog — produced a note claiming to have
 * kept a name, a description and highlights that never existed. Carrying
 * `kept` in the value makes that unrepresentable rather than merely fixed.
 */
export type GenerateResult =
  /** A new board AND a new AI story landed; the form now holds that story. */
  | { outcome: 'filled' }
  /**
   * A new board landed, but the form held text the user had written, so the
   * all-or-nothing rule (`generatedFillIsSafe`) left every field alone — the
   * AI's story was written and discarded. `kept` is what was actually there.
   */
  | { outcome: 'kept'; kept: KeptFields }
  /** A new board landed; no trustworthy story came back to fill it with. */
  | { outcome: 'unavailable' };

/** Which of the four things a user can author this dialog was holding. */
export interface KeptFields {
  name: boolean;
  desc: boolean;
  labels: boolean;
  terms: boolean;
}

/**
 * Read `KeptFields` off the form model itself. The note must never derive this
 * from its own copy of "what counts as filled in" — that second rule is how the
 * enumeration came to disagree with the form in the first place.
 *
 * A field is "kept" only when the USER typed it (`provenance === 'typed'`) and it
 * is not blank. Option names copied from the board (`'from-board'`) and text an
 * earlier Generate wrote (`'generated'`) never block a fill, so the sentence
 * "…you'd already added" must not claim them (director probe on #184).
 */
export function keptFieldsOf(form: {
  name: string;
  desc: string;
  labels: { row1: string; row2: string; col1: string; col2: string };
  terms: { a: readonly string[]; b: readonly string[] };
  provenance: { name: FieldSource; desc: FieldSource; labels: FieldSource; terms: FieldSource };
}): KeptFields {
  const typed = (k: keyof KeptFields) => form.provenance[k] === 'typed';
  return {
    name: typed('name') && form.name.trim() !== '',
    desc: typed('desc') && form.desc.trim() !== '',
    labels: typed('labels') && [form.labels.row1, form.labels.row2, form.labels.col1, form.labels.col2]
      .some((l) => l.trim() !== ''),
    terms: typed('terms') && form.terms.a.length + form.terms.b.length > 0,
  };
}

/** The four noun phrases, in the order the sentence lists them. */
const KEPT_LABELS: [keyof KeptFields, string][] = [
  ['name', 'the name'],
  ['desc', 'the description'],
  ['labels', 'the option names'],
  ['terms', 'the colour highlights'],
];

/**
 * "the name", "the name and the description", "the name, the description and
 * the option names" — an Oxford-less list, so the sentence reads as English
 * whichever subset is true.
 */
export function keptList(kept: KeptFields): string[] {
  return KEPT_LABELS.filter(([k]) => kept[k]).map(([, label]) => label);
}
function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

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
 *
 * The `'kept'` sentence names only the fields `result.kept` says were there
 * (STRUCT-REGEN-19/008).
 */
export function generateNote(kind: EquilibriumKind, result: GenerateResult, chipsRemoved: number): string {
  const tail = highlightsRemovedClause(chipsRemoved);
  switch (result.outcome) {
    case 'filled':
      return `New ${kindLabel(kind)} game on the board, scenario written by AI — edit anything below, then save.${tail}`;
    case 'kept': {
      const items = keptList(result.kept);
      // The fill was refused but nothing in the form is the user's own typing.
      // OPUS-REVIEW-184/F1: this branch was called unreachable, and was reachable
      // — the report card's prefill marked the fields 'generated' while
      // `generatedFillIsSafe` still saw values it had no record of writing. That
      // seam is closed (every `story` into the save form now records
      // `lastGeneratedFillRef`), so on today's paths it should not be reached;
      // it still must not be a dead end if it is, because a note that names
      // nothing and offers nothing leaves the user with no way forward.
      if (items.length === 0) {
        return `New ${kindLabel(kind)} game is on the board. The AI wrote a scenario, but the form already has text in it, so nothing was replaced. Clear the form to let the AI fill it in on the next Generate.${tail}`;
      }
      // Number agreement (the round-16 rule): with one item the noun is
      // repeated rather than pronominalised, so "the option names" — plural in
      // itself — never collides with a singular "it".
      const clearing = items.length === 1
        ? `Clear ${items[0]} to let the AI fill the form on the next Generate.`
        : `Clear ALL of them (not just one) to let it fill them in on the next Generate.`;
      return `New ${kindLabel(kind)} game is on the board. Kept ${joinList(items)} you'd already added — the AI wrote a scenario too, but didn't touch your text. ${clearing}${tail}`;
    }
    case 'unavailable':
      return `New ${kindLabel(kind)} game is on the board. The AI scenario isn't available right now — name and describe it yourself below.${tail}`;
    default: {
      // Exhaustiveness: a new outcome must get its own sentence, never a blank.
      const never: never = result;
      return never;
    }
  }
}
