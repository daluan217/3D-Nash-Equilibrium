/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IS THE STORY WE ARE ABOUT TO SERVE ONE THE READER CAN FIND EACH PLAYER IN?
 *
 * RED-DESKTOP-9/001 (2026-09-04) named the defect: a description that gives a
 * player no term the highlighter can match "renders that player's half of the
 * story with NO highlight at all". That was fixed for the BANK ARTIFACT — an
 * extraction+drop pass plus the re-screen in `src/scenariobank.test.ts` — and
 * the fix has held there: 0 of 2,442 shipped rows fail this gate.
 *
 * THE CLOUD PATH NEVER GOT A SCREEN AT ALL, and the bank's re-screen cannot
 * stand in for one: it certifies an artifact, and a live draw is not in it.
 * Measured on 146 gate-passing live draws taken on the production call shape,
 * 2 (1.37%) name nothing the reader can attribute to one of the two players
 * (STRUCT-CLOUD-19/001, `_gen/cloud19_draw.ts` + `_gen/cloud19_colour2.ts`).
 * That is what this gate is for. It fires on 0 bank rows by construction, so
 * the artifact is its negative control, not its justification.
 *
 * WHY THIS MODULE EXISTS RATHER THAN ANOTHER PREDICATE NEXT TO THE LAST ONE.
 * `scenarioIsColourable` re-derives the renderer's term lists by hand, and the
 * copy has drifted: the renderer's builders end in `dropAmbiguous`, which
 * deletes any term appearing on BOTH players' lists so a shared action is never
 * painted as one player's. The screen omits that step, so it reports
 * "colourable for both players" on 244 of 2,442 bank rows (9.99%) the renderer
 * paints nothing on for one side (STRUCT-CLOUD-19/002). Everything here therefore asks the
 * renderer's OWN builder -- `regenPreviewColorTerms`, the exact function
 * `App.tsx` renders both scenario cards with -- instead of rebuilding a third
 * idea of what gets coloured. A drift is then not possible: there is one
 * implementation and this file calls it.
 *
 * THERE IS ONE AUDIENCE, because there is one builder. This module used to take
 * a `ColourAudience` ('report-card' | 'regen-preview') because the two surfaces
 * genuinely painted different term sets: `/api/report` stripped the actor nouns
 * and its card called `colorTermsFor(sc)` with the four labels alone, while the
 * regenerate preview passed the nouns through. That difference WAS the defect
 * (see server.ts, where the stripping used to happen), so removing it removes
 * the parameter: every surface now paints with `regenPreviewColorTerms`, and a
 * third surface that wants its own term list has to change this file to get one.
 *
 * AMBIGUITY IS NOT ABSENCE, AND ONLY ABSENCE IS GATED. All 244 of those are
 * scenarios that give both players the SAME option-label pair (what the model
 * writes whenever the game is symmetric). No highlighter can attribute a
 * mention of "Early heat" to one of two players who both chose between "Early
 * heat" and "Late heat"; NOT colouring is the correct rendering, and gating it
 * would reject a tenth of good output to catch nothing. What IS gated is a side
 * with no term at all, before any ambiguity pass.
 */
import type { SuggestedScenario } from '../types';
import { paintPlan, regenPreviewColorTerms, type ScenarioLabels } from './colorTerms';
import { highlightWouldMatch } from './scenarioBank';

const strList = (v: unknown): string[] =>
  (Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string' && t.length > 0) : []);

const labelsOf = (sc: SuggestedScenario): ScenarioLabels => ({
  row1: sc.row1, row2: sc.row2, col1: sc.col1, col2: sc.col2,
});

/**
 * The terms the REAL renderer will paint this scenario's description with.
 *
 * `regenPreviewColorTerms` is the one builder both scenario cards use, and it
 * is the one whose composition survives a save: RED-REGEN/002 established that
 * `colorTermsFor` (one `dropAmbiguous` pass over structural + label + actor
 * terms) and `mergeDescriptionTerms` (label-ownership neutralisation of USER
 * terms, which is what a saved game's stored nouns become) disagree when a noun
 * collides with the other player's option label. The saved description renders
 * through the second, so the card and this gate must too.
 *
 * Asked with EMPTY existing user terms on purpose: a user's own highlights
 * normally only ADD terms, so the empty set is the worst case, and a gate
 * calibrated on the worst case cannot pass a story the surface would then fail
 * to colour for a user who has marked nothing.
 */
export function renderedColourTerms(sc: SuggestedScenario): { a: string[]; b: string[] } {
  return regenPreviewColorTerms(labelsOf(sc), strList(sc.actorA), strList(sc.actorB), [], []);
}

/**
 * The same terms BEFORE the renderer's ambiguity pass — every term the scenario
 * authored for that player. Used only to tell absence from ambiguity; it is not
 * what gets painted.
 */
function authoredColourTerms(sc: SuggestedScenario): { a: string[]; b: string[] } {
  const trimmed = (v: unknown): string[] => (typeof v === 'string' && v.trim() ? [v.trim()] : []);
  return {
    a: [...trimmed(sc.row1), ...trimmed(sc.row2), ...strList(sc.actorA)],
    b: [...trimmed(sc.col1), ...trimmed(sc.col2), ...strList(sc.actorB)],
  };
}

export interface Renderability {
  /** the renderer would paint at least one term of A's in the description */
  a: boolean;
  /** the same for B */
  b: boolean;
  /**
   * A side that is not painted, but only because the two players share the term
   * — the renderer's `dropAmbiguous` removed it from both. Correct behaviour,
   * not a defect; see the header.
   */
  ambiguityOnly: boolean;
}

export function scenarioRenderability(sc: SuggestedScenario): Renderability {
  const desc = sc.description ?? '';
  const painted = renderedColourTerms(sc);
  // The gate must credit a side only for a span the renderer leaves in that
  // side's colour. A shorter B noun can occur inside a longer A option, where
  // testing the two entries separately says B is present even though the card
  // paints every occurrence rose.
  const plan = paintPlan(desc, painted.a, painted.b);
  const a = plan.some((span) => span.side === 'A');
  const b = plan.some((span) => span.side === 'B');
  if (a && b) return { a, b, ambiguityOnly: false };
  const authored = authoredColourTerms(sc);
  const rawA = authored.a.some((t) => highlightWouldMatch(t, desc));
  const rawB = authored.b.some((t) => highlightWouldMatch(t, desc));
  // Shared labels are the only benign no-paint case. Do not let their raw
  // occurrence excuse a one-sided paint plan: that is an ownership shadow.
  return { a, b, ambiguityOnly: !a && !b && rawA && rawB };
}

/**
 * THE GATE. A story in which a player cannot be found at all is rejected; a
 * story the renderer declines to colour because the two players share the term
 * is kept. Returns the side, so the drop reason a production log carries names
 * WHICH player the reader would lose (v5 self-adversarial item (f)).
 */
export function scenarioIsAttributable(sc: SuggestedScenario): { ok: boolean; reason?: string } {
  const r = scenarioRenderability(sc);
  if (r.a && r.b) return { ok: true };
  if (r.ambiguityOnly) return { ok: true };
  const side = !r.a && !r.b ? 'either player' : !r.a ? 'player A' : 'player B';
  return {
    ok: false,
    reason: `the description names nothing the scenario card would highlight for ${side}`,
  };
}
