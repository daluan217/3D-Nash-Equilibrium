/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useState } from 'react';
import { ColorCoded } from './ColorCoded';
import {
  cleanUserColorTerms,
  cleanUserColorTermPair,
  mergeDescriptionTerms,
  USER_TERMS_MAX,
  USER_TERM_MAX_LEN,
} from '../utils/colorTerms';

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
  value,
  onChange,
  termsA,
  termsB,
  onTermsChange,
  baseA = [],
  baseB = [],
  placeholder = 'What is this game about?',
  maxLength = 800,
}: {
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
  placeholder?: string;
  maxLength?: number;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [hint, setHint] = useState('');

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
    const nextA = player === 'A' ? [...termsA, term] : termsA.filter((t) => t.toLowerCase() !== term.toLowerCase());
    const nextB = player === 'B' ? [...termsB, term] : termsB.filter((t) => t.toLowerCase() !== term.toLowerCase());
    // As a pair, so a phrase can never end up owned by both players.
    const { a: cleanA, b: cleanB } = cleanUserColorTermPair(nextA, nextB);
    if (
      (player === 'A' && !cleanA.some((t) => t.toLowerCase() === term.toLowerCase()))
      || (player === 'B' && !cleanB.some((t) => t.toLowerCase() === term.toLowerCase()))
    ) {
      setHint(`That is ${USER_TERMS_MAX} highlights already — remove one to add another.`);
      return;
    }
    setHint('');
    onTermsChange(cleanA, cleanB);
  };

  const remove = (term: string) => {
    setHint('');
    onTermsChange(
      termsA.filter((t) => t !== term),
      termsB.filter((t) => t !== term),
    );
  };

  const chip = (term: string, player: 'A' | 'B') => (
    <button
      key={player + term}
      type="button"
      onClick={() => remove(term)}
      title="Remove this highlight"
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold transition
        ${player === 'A'
          ? 'border-player-a-300 dark:border-player-a-800 text-player-a-ink dark:text-player-a-ink-dark hover:bg-player-a-50 dark:hover:bg-player-a-900/30'
          : 'border-player-b-300 dark:border-player-b-800 text-player-b-ink dark:text-player-b-ink-dark hover:bg-player-b-50 dark:hover:bg-player-b-900/30'}`}
    >
      {term}
      <span aria-hidden="true" className="text-slate-400">×</span>
      <span className="sr-only">Remove highlight</span>
    </button>
  );

  return (
    <div>
      <textarea
        ref={taRef}
        className="w-full px-3 py-2 text-xs md:text-sm bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-accent-100 focus:border-slate-300 h-24 resize-none text-slate-800 dark:text-slate-200"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={maxLength}
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
          ({termsA.length + termsB.length}/{USER_TERMS_MAX})
        </span>
      </div>

      {hint && (
        <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">{hint}</p>
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
                preview shows is what the game will show. */}
            <ColorCoded
              text={value}
              aTerms={mergeDescriptionTerms({ a: baseA, b: baseB }, termsA, termsB).a}
              bTerms={mergeDescriptionTerms({ a: baseA, b: baseB }, termsA, termsB).b}
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
