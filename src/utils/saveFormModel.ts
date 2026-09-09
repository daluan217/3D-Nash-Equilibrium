/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Save dialog's form, as ONE value with ONE reconcile rule.
 *
 * WHY THIS EXISTS (STRUCT-REGEN-19/001). The save form is five pieces — name,
 * description, four option labels, and the user's colour chips — plus the board
 * they were written for. Six different places in App.tsx used to write them, and
 * each wrote a DIFFERENT subset:
 *
 *   reconcile-on-board-change   name desc terms            (not labels)
 *   "Save this scenario…"       name desc labels           (not terms)
 *   Generate, board changed     name desc labels terms
 *   Generate, fill from a draw  name desc labels           (not terms)
 *   post-save reset             name desc labels terms
 *   Regenerate → Keep           name desc labels terms
 *
 * Nobody owned the invariant, so it broke: "Save this scenario with the game"
 * replaced the description with a brand-new AI story and left the chips from an
 * abandoned earlier draft in place — and, by stamping the board key itself, it
 * disarmed the one reconcile that would ever have cleared them. The saved record
 * then named highlight phrases that appear nowhere in its own description
 * (verified through the POST body and a `GET /api/games` read-back).
 *
 * THE INVARIANT, stated once and enforced here: **the five pieces always
 * describe ONE story, written for ONE board.** A new story replaces all five. A
 * different board discards the story it was written for. Nothing survives a
 * change to the thing it describes. Every entry point — the Save Preset click,
 * the report card's prefill, Generate, Regenerate → Keep, the resume after a
 * sign-in, a successful save — is an ACTION here, so a new entry point cannot
 * accidentally write four fifths of a story.
 *
 * Provenance per field is what lets one rule serve every action: a field the
 * USER typed is theirs and outranks any generated fill (RED-APP-4, round 4),
 * while a field a generated fill wrote may be replaced by the next one.
 *
 * Pure data: no React, no DOM, no fetch — every branch is a one-line assertion
 * in `src/saveformmodel.test.ts`.
 */

/** Where a field's current value came from. */
/**
 * Where a field's current value came from.
 *
 * `'adopted'` is a value this dialog did not write and the user did not type: a
 * concurrent edit on another device, merged in by the 409 recovery
 * (OPUS-REVIEW-184/S3). It is deliberately NOT `'typed'` — the Generate note
 * only ever claims to have kept what the user typed — and not `'generated'`,
 * which means an AI story this app wrote.
 */
export type FieldSource = 'empty' | 'typed' | 'generated' | 'from-board' | 'adopted';

export interface SaveFormLabels { row1: string; row2: string; col1: string; col2: string }
export type LabelKey = keyof SaveFormLabels;

export interface SaveFormState {
  name: string;
  desc: string;
  labels: SaveFormLabels;
  terms: { a: string[]; b: string[] };
  /**
   * The board these five pieces were written for — `boardKeyOf(payoffs)`, the
   * eight payoff cells (RED-REGEN-13/001). `null` means the form holds nothing
   * that belongs to any board.
   */
  boardKey: string | null;
  /**
   * The last value the NAME field held that the user did NOT type (blank on a
   * fresh form, or whatever a prefill/Generate/Keep wrote). Keep replaces the
   * name only while the live value still equals this (director, 2026-09-03).
   */
  nameBaseline: string;
  provenance: { name: FieldSource; desc: FieldSource; labels: FieldSource; terms: FieldSource };
}

export const EMPTY_LABELS: SaveFormLabels = { row1: '', row2: '', col1: '', col2: '' };

export const EMPTY_SAVE_FORM: SaveFormState = {
  name: '',
  desc: '',
  labels: EMPTY_LABELS,
  terms: { a: [], b: [] },
  boardKey: null,
  nameBaseline: '',
  provenance: { name: 'empty', desc: 'empty', labels: 'empty', terms: 'empty' },
};

export type SaveFormAction =
  /** A keystroke in the name or description. */
  | { type: 'typed'; field: 'name' | 'desc'; value: string }
  /** A keystroke in one option-label field. */
  | { type: 'typedLabel'; field: LabelKey; value: string }
  /** The user added or removed a colour highlight. */
  | { type: 'typedTerms'; a: string[]; b: string[] }
  /** The 409 recovery adopting another device's colour terms (OPUS-REVIEW-184/S3). */
  | { type: 'adoptedTerms'; a: readonly string[]; b: readonly string[] }
  /**
   * The dialog is being opened for `boardKey`. A draft written for THIS board
   * survives whole; a draft written for another board is discarded whole, and
   * the caller's board-derived labels (the current game's own option names)
   * take its place. `presetLabels` is what the board itself calls its options —
   * never a placeholder like "Row 1".
   */
  | { type: 'openForBoard'; boardKey: string; presetLabels: SaveFormLabels }
  /**
   * A new STORY arrives for `boardKey`, from wherever: the report card's
   * "Save this scenario with the game", a Generate fill, or Regenerate → Keep.
   * All five pieces move together. `terms` defaults to none — a source that
   * brings no chips must not inherit the previous story's.
   */
  | {
      type: 'story';
      boardKey: string;
      name?: string;
      desc: string;
      labels: SaveFormLabels;
      terms?: { a: string[]; b: string[] };
    }
  /**
   * The board changed under an open form. `keepUserText` is the caller's
   * all-or-nothing judgement (the negation of `generatedFillIsSafe`): TRUE
   * means the text is the user's own, so all five pieces stay and now belong
   * to the new board; FALSE means the app itself wrote them for the OLD board,
   * so the form is emptied and only the new board key remains.
   */
  | { type: 'boardChanged'; boardKey: string; keepUserText: boolean }
  /** The save succeeded: the form is blank and belongs to no board. */
  | { type: 'saved' };

const sameLabels = (a: SaveFormLabels, b: SaveFormLabels) =>
  a.row1 === b.row1 && a.row2 === b.row2 && a.col1 === b.col1 && a.col2 === b.col2;
/** RED-REGEN-14/001 + CodeRabbit on #178: whitespace-only labels count as blank. */
const labelsBlank = (l: SaveFormLabels) => [l.row1, l.row2, l.col1, l.col2].every((s) => !s.trim());

export function saveFormReducer(state: SaveFormState, action: SaveFormAction): SaveFormState {
  switch (action.type) {
    case 'typed': {
      const next = { ...state, [action.field]: action.value } as SaveFormState;
      next.provenance = { ...state.provenance, [action.field]: 'typed' };
      return next;
    }
    case 'typedLabel':
      return {
        ...state,
        labels: { ...state.labels, [action.field]: action.value },
        provenance: { ...state.provenance, labels: 'typed' },
      };
    case 'adoptedTerms':
      // A concurrent edit from another device, merged in by the 409 recovery.
      // Only the terms move, and the provenance says whose they are.
      return {
        ...state,
        terms: { a: [...action.a], b: [...action.b] },
        provenance: { ...state.provenance, terms: 'adopted' },
      };
    case 'typedTerms':
      return {
        ...state,
        terms: { a: [...action.a], b: [...action.b] },
        provenance: { ...state.provenance, terms: 'typed' },
      };
    case 'openForBoard': {
      // A draft written for THIS board survives with its own labels — the
      // option names belong to the story, and re-prefilling over them saved a
      // record whose description named options the record did not carry
      // (RED-REGEN-14/001).
      const kept = state.boardKey === null || state.boardKey === action.boardKey;
      const hasDraft = state.desc !== '' || state.name !== '' || !sameLabels(state.labels, EMPTY_LABELS)
        || state.terms.a.length > 0 || state.terms.b.length > 0;
      if (kept && hasDraft) {
        // A kept draft with NO option names of its own still takes the board's
        // (RED-REGEN-14/001's fix, #178): there is nothing of the story to
        // overwrite, and saving a named game's copy should keep its names.
        return labelsBlank(state.labels)
          ? {
            ...state,
            boardKey: action.boardKey,
            labels: { ...action.presetLabels },
            provenance: { ...state.provenance, labels: labelsBlank(action.presetLabels) ? state.provenance.labels : 'from-board' },
          }
          : { ...state, boardKey: action.boardKey };
      }
      // Nothing to keep: take the board's own option names.
      return {
        ...EMPTY_SAVE_FORM,
        labels: { ...action.presetLabels },
        boardKey: action.boardKey,
        // ONE blankness predicate on both paths (OPUS-REVIEW-184/NIT): the branch
        // above asks `labelsBlank`, which trims, so a whitespace-only board label
        // must be 'empty' here too rather than 'from-board'.
        provenance: { ...EMPTY_SAVE_FORM.provenance, labels: labelsBlank(action.presetLabels) ? 'empty' : 'from-board' },
      };
    }
    case 'story':
      // THE invariant: a new story replaces every piece, chips included. A
      // caller with no chips of its own passes none, and the previous story's
      // highlights go with the text they were describing.
      return {
        name: action.name ?? state.name,
        desc: action.desc,
        labels: { ...action.labels },
        terms: { a: [...(action.terms?.a ?? [])], b: [...(action.terms?.b ?? [])] },
        boardKey: action.boardKey,
        // A story the user did not type is the new name baseline (so Keep may
        // replace it later); a story that leaves the name alone leaves it too.
        nameBaseline: action.name ?? state.nameBaseline,
        provenance: {
          name: action.name !== undefined ? 'generated' : state.provenance.name,
          desc: 'generated',
          labels: 'generated',
          terms: (action.terms?.a.length ?? 0) + (action.terms?.b.length ?? 0) > 0 ? 'generated' : 'empty',
        },
      };
    case 'boardChanged':
      if (state.boardKey === action.boardKey) return state;
      return action.keepUserText
        // The user's own text stays, and now belongs to the new board.
        ? { ...state, boardKey: action.boardKey }
        : { ...EMPTY_SAVE_FORM, boardKey: action.boardKey };
    case 'saved':
      return EMPTY_SAVE_FORM;
    default: {
      // Exhaustiveness: a new action must be handled, never silently ignored.
      const never: never = action;
      return never;
    }
  }
}
