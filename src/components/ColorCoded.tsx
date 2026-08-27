/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';

// Matte ink classes (defined in index.css): player hue knocked toward slate
// so highlights read as part of the sentence, not stickers on it. Terms
// (option names, "Player A") keep semibold so they stay scannable; structural
// tokens (Row 2, E[A]=…, x*=…) take medium so dense numeric runs stay calm.
const A_TERM_CLS = 'text-player-a-ink dark:text-player-a-ink-dark font-semibold';
const B_TERM_CLS = 'text-player-b-ink dark:text-player-b-ink-dark font-semibold';
const A_TOKEN_CLS = 'text-player-a-ink dark:text-player-a-ink-dark font-medium';
const B_TOKEN_CLS = 'text-player-b-ink dark:text-player-b-ink-dark font-medium';

/**
 * Structural game-notation tokens, colored in EVERY ColorCoded text without
 * callers naming them: row/column references, per-player payoff citations,
 * and strategy coordinates (x belongs to A, y to B). The bare-letter rules
 * accept "A"/"B" only mid-sentence after a lowercase word (or as a
 * possessive), which is always the player — a sentence-initial "A" could be
 * the article, so it deliberately stays uncolored rather than risk painting
 * "A city clerk…".
 */
const TOKEN_RULES: Array<{ re: RegExp; cls: string }> = [
  { re: /E\[A\](?:\s*=\s*-?\d+(?:\.\d+)?)?/g, cls: A_TOKEN_CLS },
  { re: /E\[B\](?:\s*=\s*-?\d+(?:\.\d+)?)?/g, cls: B_TOKEN_CLS },
  { re: /\bRow\s?[12]\b/gi, cls: A_TOKEN_CLS },
  { re: /\bCol(?:umn)?\s?[12]\b/gi, cls: B_TOKEN_CLS },
  { re: /\bA\s*=\s*-?\d+(?:\.\d+)?/g, cls: A_TOKEN_CLS },
  { re: /\bB\s*=\s*-?\d+(?:\.\d+)?/g, cls: B_TOKEN_CLS },
  { re: /\bx\s?\*\s*=\s*-?\d+(?:\.\d+)?|\bx\s*=\s*-?\d+(?:\.\d+)?|\bx\*|\bx\b/g, cls: A_TOKEN_CLS },
  { re: /\by\s?\*\s*=\s*-?\d+(?:\.\d+)?|\by\s*=\s*-?\d+(?:\.\d+)?|\by\*|\by\b/g, cls: B_TOKEN_CLS },
  { re: /(?<=[a-z,;:)]\s)A(?=[\s,.:;!?')]|'s)|\bA(?='s)/g, cls: A_TOKEN_CLS },
  { re: /(?<=[a-z,;:)]\s)B(?=[\s,.:;!?')]|'s)|\bB(?='s)/g, cls: B_TOKEN_CLS },
];

/**
 * Color player-relevant phrases in model- or user-written PLAIN TEXT.
 *
 * Built-in preset descriptions carry trusted app-authored HTML spans, but the
 * AI explanation and user descriptions are rendered as text precisely so they
 * cannot inject markup. This applies the same player-a / player-b coloring as
 * a deterministic post-pass: known terms are matched (case-insensitively, at
 * word boundaries, longest first) and wrapped in React elements — the text
 * itself is never interpreted as HTML. Structural notation (TOKEN_RULES) is
 * always colored, terms only when the caller supplies them.
 */
export function ColorCoded({ text, aTerms = [], bTerms = [] }: { text: string; aTerms?: string[]; bTerms?: string[] }) {
  const nodes = useMemo(() => {
    if (!text) return [text];
    let k = 0;
    // One rule applied over the still-plain string segments; earlier passes'
    // spans are opaque to later ones, so the first rule to claim a range wins.
    const applyRule = (input: React.ReactNode[], re: RegExp, clsFor: (hit: string) => string | undefined) =>
      input.flatMap((node) => {
        if (typeof node !== 'string') return [node];
        const out: React.ReactNode[] = [];
        let last = 0;
        re.lastIndex = 0;
        for (let m = re.exec(node); m !== null; m = re.exec(node)) {
          if (m.index > last) out.push(node.slice(last, m.index));
          out.push(<span key={k++} className={clsFor(m[0])}>{m[0]}</span>);
          last = m.index + m[0].length;
          if (m[0].length === 0) re.lastIndex++;
        }
        out.push(node.slice(last));
        return out;
      });

    // Caller-supplied terms first (longest first, so "Issue Fast Ticket"
    // beats "Ticket"): they carry scenario meaning and outrank notation.
    const entries = [
      ...aTerms.map((t) => ({ t, cls: A_TERM_CLS })),
      ...bTerms.map((t) => ({ t, cls: B_TERM_CLS })),
    ]
      // Single characters ("A") are ambiguous with articles; require 2+ chars.
      .filter((e) => e.t && e.t.trim().length >= 2)
      .sort((p, q) => q.t.length - p.t.length);
    let out: React.ReactNode[] = [text];
    if (entries.length > 0) {
      const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const termRe = new RegExp(`(?<![\\w])(?:${entries.map((e) => esc(e.t)).join('|')})(?![\\w])`, 'gi');
      out = applyRule(out, termRe, (hit) => entries.find((e) => e.t.toLowerCase() === hit.toLowerCase())?.cls);
    }
    for (const rule of TOKEN_RULES) out = applyRule(out, rule.re, () => rule.cls);
    return out;
  }, [text, aTerms, bTerms]);
  return <>{nodes}</>;
}
