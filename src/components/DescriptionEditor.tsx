/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useState } from 'react';
import { ColorCoded } from './ColorCoded';
import {
  termOccursIn,
  colorTermKey,
  cleanUserColorTerms,
  cleanUserColorTermPair,
  crossPlayerUserTerms,
  mergeDescriptionTerms,
  capHitMessage,
  USER_TERMS_MAX,
  USER_TERM_MAX_LEN,
} from '../utils/colorTerms';
import { clampGraphemeSafe, wouldExceedGraphemeBudget } from '../utils/textSafety';

/**
 * The description textarea plus the controls for colour-coding it.
 *
 * The user selects a phrase in their own description and assigns it to player A
 * or player B. What is stored is the PHRASE, not the character range: the
 * description is plain text that stays editable, and offsets would quietly
 * slide onto the wrong words the moment the sentence around them changed. It
 * also means the same phrase colours consistently wherever it appears, which is
 * how every other term in this app already behaves.
 *
 * The one rule worth stating out loud, because it is the whole point: this
 * decorates the USER's description. It is never applied to the model's prose,
 * and none of it is sent to the model. The LLM writes; the client colours
 * afterwards; the two do not negotiate.
 *
 * Shared by the save and edit dialogs so the two cannot drift apart.
 */
export function DescriptionEditor({
  id,
  value,
  onChange,
  termsA,
  termsB,
  onTermsChange,
  baseA = [],
  baseB = [],
  labelA = [],
  labelB = [],
  placeholder = 'What is this game about?',
  maxLength = 800,
}: {
  /** RED-APP-16/003: forwarded to the textarea so a caller's `<label
   *  htmlFor>` can associate with it — without this the textarea's only
   *  name source was `placeholder`, which disappears once the user types. */
  id?: string;
  value: string;
  onChange: (v: string) => void;
  termsA: string[];
  termsB: string[];
  onTermsChange: (a: string[], b: string[]) => void;
  /** The terms the app colours automatically (structural notation and the
   *  game's option names). Passed in so the preview renders EXACTLY what the
   *  saved description will — without them a phrase that is also an automatic
   *  term previews in the user's colour and then saves in the other one. */
  baseA?: string[];
  baseB?: string[];
  /** The dialog's own OPTION LABEL text only (no structural notation, no
   *  actor nouns) — `mergeDescriptionTerms`'s label-ownership check
   *  (RED-REGEN-3/001): a chip that string-matches a label on the OPPOSITE
   *  side from where it was filed renders neutral rather than mis-colouring
   *  a symmetric or other-player label. Passed separately from `baseA`/
   *  `baseB` because those are already ambiguity-resolved — the raw label
   *  text is what this check needs. */
  labelA?: string[];
  labelB?: string[];
  placeholder?: string;
  maxLength?: number;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [hint, setHint] = useState('');

  // Computed once — the preview used to call `mergeDescriptionTerms` twice
  // with identical arguments (once for aTerms, once for bTerms), the same
  // "two calls that must agree" shape the module-level comment already
  // warns about.
  const merged = mergeDescriptionTerms({ a: baseA, b: baseB }, termsA, termsB, { a: labelA, b: labelB });

  const addSelection = (player: 'A' | 'B') => {
    const ta = taRef.current;
    if (!ta) return;
    const picked = value.slice(ta.selectionStart ?? 0, ta.selectionEnd ?? 0);
    // cleanUserColorTerms is the same function the server validates with, so
    // anything it rejects here would have been rejected there anyway.
    const [term] = cleanUserColorTerms([picked]);
    if (!term) {
      setHint(
        picked.trim().length === 1
          ? 'Single letters are ambiguous with ordinary words — select at least two characters.'
          : 'Select some text in the description first, then choose a player.',
      );
      return;
    }
    const nextA = player === 'A' ? [...termsA, term] : termsA.filter((t) => colorTermKey(t) !== colorTermKey(term));
    const nextB = player === 'B' ? [...termsB, term] : termsB.filter((t) => colorTermKey(t) !== colorTermKey(term));
    // As a pair, so a phrase can never end up owned by both players.
    const { a: cleanA, b: cleanB } = cleanUserColorTermPair(nextA, nextB);
    // RED-REGEN-10/001: choosing the other player for a phrase already
    // highlighted MOVES it (explicit assignment wins, docs/COLOUR-TERMS.md §b)
    // — computed BEFORE the cap guard below, since a move that the cap
    // blocks is still a move, not a fresh add.
    const movedFrom = player === 'A'
      ? termsB.some((t) => colorTermKey(t) === colorTermKey(term)) ? 'B' : null
      : termsA.some((t) => colorTermKey(t) === colorTermKey(term)) ? 'A' : null;
    if (
      (player === 'A' && !cleanA.some((t) => colorTermKey(t) === colorTermKey(term)))
      || (player === 'B' && !cleanB.some((t) => colorTermKey(t) === colorTermKey(term)))
    ) {
      // Opus review N1: a cap-blocked MOVE is a different situation from a
      // cap-blocked fresh highlight — the phrase is already on screen,
      // unmoved, so `capHitMessage`'s "remove one to add X" is both false
      // (X is not missing) and unactionable (removing a chip on THIS
      // player's side does not move X off the other player). Name the
      // actual state instead of the shared "add" wording.
      setHint(
        movedFrom
          ? `"${term}" is highlighted for Player ${movedFrom}; Player ${player} already has ${USER_TERMS_MAX} highlights — remove one to move it.`
          // CodeRabbit (PR #161): name the SELECTED player's cap, not a
          // player-agnostic message — this is always a single side's own
          // pick (Player A or B), never the pooled Keep-side case.
          : capHitMessage([term], player),
      );
      return;
    }
    setHint(movedFrom ? `"${term}" was highlighted for Player ${movedFrom}; it now belongs to Player ${player}.` : '');
    onTermsChange(cleanA, cleanB);
  };

  const remove = (term: string) => {
    setHint('');
    onTermsChange(
      termsA.filter((t) => t !== term),
      termsB.filter((t) => t !== term),
    );
  };

  // RED-REGEN-4/002: a chip whose highlight the label-ownership rule suppressed
  // (it names an option label on the other side) must SAY so — the chip stays,
  // its pill goes neutral, and the title explains why nothing is coloured.
  // Per player, not pooled: a chip filed on A whose phrase renders as B's is
  // suppressed for A even though the key is "rendered" somewhere (CodeRabbit).
  const renderedA = new Set(merged.a.map(colorTermKey));
  const renderedB = new Set(merged.b.map(colorTermKey));
  // RED-REGEN-9/001: a B chip can also go neutral because the SAME phrase is
  // filed on A in this very dialog (a 409 adoption creates exactly that
  // shape) — a different cause from the label rule, so it gets its own words.
  const crossPlayerKeys = new Set(crossPlayerUserTerms(termsA, termsB).map(colorTermKey));
  // RED-REGEN-14/002: a chip whose phrase does not occur in the text at all
  // (a regenerated story replaced it, or the user edited it away) paints
  // nothing either — same family, third cause, decided by the SAME boundary
  // rule `ColorCoded` paints with (`termOccursIn`), never by a second one.
  // The chip stays (Keep never destroys highlights); it says what it is.
  // Precedence: the ownership causes first — they would still apply after
  // the user put the phrase back into the text, so they are the fact worth
  // stating; "absent" is reported only for a chip that would otherwise paint.
  const chip = (term: string, player: 'A' | 'B') => {
    const byRule = !(player === 'A' ? renderedA : renderedB).has(colorTermKey(term));
    const absent = !byRule && !termOccursIn(value, term);
    const suppressed = byRule || absent;
    const crossPlayer = byRule && player === 'B' && crossPlayerKeys.has(colorTermKey(term));
    const colour = player === 'A'
      ? 'border-player-a-300 dark:border-player-a-800 text-player-a-ink dark:text-player-a-ink-dark hover:bg-player-a-50 dark:hover:bg-player-a-900/30'
      : 'border-player-b-300 dark:border-player-b-800 text-player-b-ink dark:text-player-b-ink-dark hover:bg-player-b-50 dark:hover:bg-player-b-900/30';
    const neutral = 'border-dashed border-slate-300 dark:border-slate-600 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800';
    return (
      <button
        key={player + term}
        type="button"
        onClick={() => remove(term)}
        data-player={player}
        data-suppressed={suppressed ? 'true' : undefined}
        data-suppressed-cause={suppressed ? (absent ? 'absent' : crossPlayer ? 'cross-player' : 'label') : undefined}
        title={suppressed
          ? (absent
            ? `Not highlighted: "${term}" does not appear in the story. Reuse the phrase in the text, or remove the chip.`
            : crossPlayer
              ? `Not highlighted: "${term}" is also a Player A highlight in this dialog, and one phrase can belong to only one player. Remove it here or from Player A.`
              : `Not highlighted: "${term}" names an option label that is not exclusively this player's (shared by both, or the other player's), so it stays neutral. Remove to drop the chip.`)
          : 'Remove this highlight'}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold transition ${suppressed ? neutral : colour}`}
      >
        {term}
        {suppressed && <span className="font-normal">(not highlighted)</span>}
        <span aria-hidden="true" className="text-slate-400">×</span>
        <span className="sr-only">Remove highlight</span>
      </button>
    );
  };

  return (
    <div>
      <textarea
        id={id}
        ref={taRef}
        className="w-full px-3 py-2 text-xs md:text-sm bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-accent-100 focus:border-slate-300 h-24 resize-none text-slate-800 dark:text-slate-200"
        placeholder={placeholder}
        value={value}
        // RED-APP-9/003: the native `maxLength` attribute enforces this same
        // budget by raw UTF-16 code unit count with NO grapheme awareness —
        // exactly the RED-APP-7/004 defect, never fixed here. Same fix
        // shape: primary enforcement in onBeforeInput (preventDefault before
        // the browser commits an over-budget insertion, so undo never
        // desyncs — RED-APP-8/002+003), onChange as the composition-safe
        // secondary clamp, onCompositionEnd for the one case onBeforeInput
        // cannot intercept (an IME composition commit). The boundary check
        // itself is shared with App.tsx's label/name inputs via
        // `wouldExceedGraphemeBudget` (src/utils/textSafety.ts) rather than
        // reimplemented here.
        onBeforeInput={(e) => {
          const ne = e.nativeEvent as InputEvent;
          if (ne.isComposing) return;
          if (wouldExceedGraphemeBudget(e.currentTarget, ne.data, maxLength)) {
            e.preventDefault();
          }
        }}
        onChange={(e) => onChange((e.nativeEvent as InputEvent).isComposing ? e.target.value : clampGraphemeSafe(e.target.value, maxLength))}
        onCompositionEnd={(e) => {
          const v = e.currentTarget.value;
          const clamped = clampGraphemeSafe(v, maxLength);
          if (clamped !== v) onChange(clamped);
        }}
      />

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-slate-500 dark:text-slate-400">Highlight the selected words as</span>
        {(['A', 'B'] as const).map((p) => (
          <button
            key={p}
            type="button"
            // Keep the textarea's selection alive: a plain click moves focus
            // and collapses it before the handler can read it.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => addSelection(p)}
            className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold transition
              ${p === 'A'
                ? 'border-player-a-300 dark:border-player-a-800 text-player-a-ink dark:text-player-a-ink-dark hover:bg-player-a-50 dark:hover:bg-player-a-900/30'
                : 'border-player-b-300 dark:border-player-b-800 text-player-b-ink dark:text-player-b-ink-dark hover:bg-player-b-50 dark:hover:bg-player-b-900/30'}`}
          >
            Player {p}
          </button>
        ))}
        <span className="text-[11px] text-muted dark:text-muted-dark">
          {/* RED-REGEN-10/002: the cap is PER SIDE (USER_TERMS_MAX each), so the
              pooled numerator is measured against both sides' room. */}
          ({termsA.length + termsB.length}/{USER_TERMS_MAX * 2})
        </span>
      </div>

      {hint && (
        <p role="status" aria-live="polite" className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">{hint}</p>
      )}

      {(termsA.length > 0 || termsB.length > 0) && (
        <>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {termsA.map((t) => chip(t, 'A'))}
            {termsB.map((t) => chip(t, 'B'))}
          </div>
          {/* The preview is the honest answer to "what will this look like":
              it runs the same ColorCoded the saved description will. */}
          <p className="mt-1.5 rounded-lg bg-slate-50 p-2 text-[12px] leading-relaxed text-slate-600 dark:bg-slate-950/40 dark:text-slate-300">
            {/* Merged exactly as the saved description merges, so what this
                preview shows is what the game will show. Computed once —
                two separate calls that must independently agree is the same
                shape as two lists that must agree. */}
            <ColorCoded
              text={value}
              aTerms={merged.a}
              bTerms={merged.b}
            />
          </p>
        </>
      )}

      <p className="mt-1 text-[11px] text-muted dark:text-muted-dark">
        Your highlights colour this description only — they never change the AI
        explanation or how it colours its own writing. Up to {USER_TERM_MAX_LEN} characters each.
      </p>
    </div>
  );
}
