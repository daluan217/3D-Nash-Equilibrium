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
  // Ambiguity is resolved over the SCENARIO's own words only. The structural
  // cues are added afterwards and are never filtered: a scenario that labels
  // one of A's options literally "Col 1" would otherwise make "Col 1" look
  // shared and strip B's built-in notation cue — losing the one unambiguous
  // signal the reader has, to resolve an ambiguity the scenario invented.
  const aScenario: string[] = [];
  const bScenario: string[] = [];
  if (sc) {
    for (const t of [sc.row1, sc.row2]) if (t) aScenario.push(t);
    for (const t of [sc.col1, sc.col2]) if (t) bScenario.push(t);
    aScenario.push(...actorA);
    bScenario.push(...actorB);
  }
  const scoped = dropAmbiguous(aScenario, bScenario);
  return {
    a: [...STRUCTURAL_A_TERMS, ...scoped.a],
    b: [...STRUCTURAL_B_TERMS, ...scoped.b],
  };
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
  const norm = (t: string) => t.trim().toLowerCase();
  const inB = new Set(b.map(norm));
  const shared = new Set(a.map(norm).filter((t) => inB.has(t)));
  if (shared.size === 0) return { a, b };
  return {
    a: a.filter((t) => !shared.has(norm(t))),
    b: b.filter((t) => !shared.has(norm(t))),
  };
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
export function cleanUserColorTerms(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    // Collapse internal whitespace too: a selection dragged across a line
    // break arrives with a newline that would never match the rendered text.
    const t = raw.replace(/\s+/g, ' ').trim().slice(0, USER_TERM_MAX_LEN);
    if (t.length < 2) continue;
    const key = t.toLowerCase();
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
  const ownedByA = new Set(cleanA.map((t) => t.toLowerCase()));
  return {
    a: cleanA,
    b: cleanUserColorTerms(b).filter((t) => !ownedByA.has(t.toLowerCase())),
  };
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
 */
export function mergeDescriptionTerms(
  base: { a: readonly string[]; b: readonly string[] },
  userA: readonly string[],
  userB: readonly string[],
): { a: string[]; b: string[] } {
  const user = cleanUserColorTermPair([...userA], [...userB]);
  const claimed = new Set([...user.a, ...user.b].map((t) => t.toLowerCase()));
  const keep = (t: string) => !claimed.has(t.toLowerCase());
  return {
    a: [...user.a, ...base.a.filter(keep)],
    b: [...user.b, ...base.b.filter(keep)],
  };
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
  return mergeDescriptionTerms(colorTermsFor(sc, actorA, actorB), userA, userB);
}
