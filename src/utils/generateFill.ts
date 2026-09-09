/**
 * Pure decision logic for the Save Custom Game modal's "Generate" prefill.
 *
 * THE DEFECT (RED-APP-4, round 4, reproduced 1/1 against the live site). The
 * modal's "…or generate a new game" button rolled a fresh random matrix, had
 * the AI invent a scenario for it, and UNCONDITIONALLY overwrote whatever the
 * user had typed into the Game Name / Game Description / four Option Name
 * fields of the SAME form the button sits inside — no guard, no undo, and the
 * in-dialog copy said only "Replaces the matrix shown above." Type a careful
 * description, click Generate once, and it is gone.
 *
 * WHY THIS IS A MODULE AND NOT INLINE IN App.tsx. The same lesson
 * `equilibriumPanel.ts` was built on: a defect that lives in a UI event
 * handler needs the DECISION split out into something callable, or every test
 * checks the pieces (does the report call work? does setSaveName work?) while
 * the actual bug — an unconditional overwrite with no check at all — is
 * invisible to all of them.
 *
 * THE RULE: overwrite ALL SIX fields (name, description, four labels) with
 * the newly generated ones, or NONE of them — never a mix. Overwriting is
 * safe iff every field is either still EMPTY, or still holds EXACTLY what the
 * immediately preceding Generate call itself wrote (a re-roll recognising its
 * own prior output is fine to replace; that is the normal "keep clicking
 * Generate to browse options" flow). The moment any one field differs from
 * both of those — the user typed something, or edited the AI's previous
 * draft — NONE of the six are touched. All-or-nothing rather than per-field,
 * because a save whose name is the user's own hand-typed text but whose
 * description and option labels are a completely different rolled story
 * would be an internally incoherent save: a name that doesn't match the story
 * under it is a new, second defect, not a fix for the first one.
 */

export interface GeneratedFill {
  name: string;
  desc: string;
  row1: string;
  row2: string;
  col1: string;
  col2: string;
}

export interface SaveFormFields {
  name: string;
  desc: string;
  labels: { row1: string; row2: string; col1: string; col2: string };
}

/**
 * True iff every one of `current`'s six fields is either empty or exactly what
 * the APP itself put there — i.e. safe for a fresh `GeneratedFill` to replace.
 *
 * The app writes into this form from TWO places, and the predicate has to know
 * both (STRUCT-REGEN-19/005):
 *
 *   `prevFill`    the last thing Generate itself wrote (null before the first
 *                 fill) — a re-roll recognising its own prior output.
 *   `boardLabels` the four option names the dialog prefilled FROM THE BOARD
 *                 when it opened, or null when it prefilled none. Pass them
 *                 only while they are still the app's: `saveFormReducer`
 *                 records that as `provenance.labels === 'from-board'`, and
 *                 the first keystroke into any label field flips it to
 *                 `'typed'`, at which point the caller passes null and all
 *                 four are the user's again.
 *
 * Knowing only the first was a shipped defect: every preset carries option
 * names, `openSaveFormForBoard` prefills them on every open, and the very first
 * Generate click therefore read them as the user's own typing, refused to fill,
 * and told the user it had "kept the name/description/option names you'd
 * already typed" — text the user had never touched. Verified against
 * origin/main 0.0.197; findings/STRUCT-REGEN-19/005.
 *
 * `boardLabels` is optional so that every caller and fixture written before it
 * existed keeps its exact previous meaning.
 */
export function generatedFillIsSafe(
  current: SaveFormFields,
  prevFill: GeneratedFill | null,
  boardLabels: SaveFormFields['labels'] | null = null,
): boolean {
  const untouched = (v: string, key: keyof GeneratedFill) => v === '' || (prevFill !== null && v === prevFill[key]);
  const labelUntouched = (v: string, key: keyof SaveFormFields['labels']) =>
    untouched(v, key) || (boardLabels !== null && v === boardLabels[key]);
  return untouched(current.name, 'name')
    && untouched(current.desc, 'desc')
    && labelUntouched(current.labels.row1, 'row1')
    && labelUntouched(current.labels.row2, 'row2')
    && labelUntouched(current.labels.col1, 'col1')
    && labelUntouched(current.labels.col2, 'col2');
}
