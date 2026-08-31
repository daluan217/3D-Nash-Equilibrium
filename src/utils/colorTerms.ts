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
    for (const t of [sc.row1, sc.row2]) if (t) a.push(t);
    for (const t of [sc.col1, sc.col2]) if (t) b.push(t);
    a.push(...actorA);
    b.push(...actorB);
  }
  return { a, b };
}
