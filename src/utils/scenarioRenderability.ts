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
 * extraction+drop pass plus the re-screen in `src/scenariobank.test.ts`. The
 * CLOUD path never got the screen, and `/api/report` actively removes the term
 * the bank fix leaned on (`withoutActorNouns`), so the same defect is alive on
 * the path that finding did not cover: measured 84 of 2,442 shipped bank rows
 * (3.44%) and 2 of 146 gate-passing live draws served through `/api/report`
 * (STRUCT-CLOUD-19/001, `_gen/cloud19_colour2.ts`).
 *
 * WHY THIS MODULE EXISTS RATHER THAN ANOTHER PREDICATE NEXT TO THE LAST ONE.
 * `scenarioIsColourable` re-derives the renderer's term lists by hand, and the
 * copy has drifted: the renderer's builders end in `dropAmbiguous`, which
 * deletes any term appearing on BOTH players' lists so a shared action is never
 * painted as one player's. The screen omits that step, so it reports
 * "colourable for both players" on 515 of 2,442 bank rows (21.09%) the renderer
 * paints nothing on (STRUCT-CLOUD-19/002). Everything here therefore asks the
 * renderer's OWN builders — `colorTermsFor` and `regenPreviewColorTerms`, the
 * exact functions the two call sites in `App.tsx` use — instead of rebuilding
 * a third idea of what gets coloured. A drift is then not possible: there is
 * one implementation and this file calls it.
 *
 * AMBIGUITY IS NOT ABSENCE, AND ONLY ABSENCE IS GATED. Of those 515, 431 are
 * scenarios that give both players the SAME option-label pair (what the model
 * writes whenever the game is symmetric). No highlighter can attribute a
 * mention of "Early heat" to one of two players who both chose between "Early
 * heat" and "Late heat"; NOT colouring is the correct rendering, and gating it
 * would reject a fifth of good output to catch nothing. The 84 that remain are
 * the real defect: a side with no term at all, before any ambiguity pass.
 */
import type { SuggestedScenario } from '../types';
import { colorTermsFor, regenPreviewColorTerms, type ScenarioLabels } from './colorTerms';
import { highlightWouldMatch } from './scenarioBank';

/**
 * WHICH SURFACE WILL RENDER THIS STORY. The two differ in one way that decides
 * the outcome — whether the actor nouns reach the term builder — so the gate
 * must know which one it is screening for rather than assume the friendlier.
 *
 * - `report-card`: the suggestion card under the report, `App.tsx`'s
 *   `colorTermsFor(llmEnvelope.report.suggestedScenario)` — the scenario's four
 *   option labels and nothing else, because `/api/report` strips the nouns and
 *   the call site passes none.
 * - `regen-preview`: the regenerate preview, `App.tsx`'s `regenPreviewTerms`,
 *   which passes `preview.actorA` / `preview.actorB` through.
 */
export type ColourAudience = 'report-card' | 'regen-preview';

const strList = (v: unknown): string[] =>
  (Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string' && t.length > 0) : []);

const labelsOf = (sc: SuggestedScenario): ScenarioLabels => ({
  row1: sc.row1, row2: sc.row2, col1: sc.col1, col2: sc.col2,
});

/**
 * The terms the REAL renderer will paint this scenario's description with.
 *
 * `regen-preview` is asked with EMPTY existing user terms on purpose: a user's
 * own highlights can only ADD terms, so the empty set is the worst case, and a
 * gate calibrated on the worst case cannot pass a story that the surface would
 * then fail to colour for a user who has marked nothing.
 */
export function renderedColourTerms(sc: SuggestedScenario, audience: ColourAudience): { a: string[]; b: string[] } {
  return audience === 'regen-preview'
    ? regenPreviewColorTerms(labelsOf(sc), strList(sc.actorA), strList(sc.actorB), [], [])
    : colorTermsFor(labelsOf(sc));
}

/**
 * The same terms BEFORE the renderer's ambiguity pass — every term the scenario
 * authored for that player. Used only to tell absence from ambiguity; it is not
 * what gets painted.
 */
function authoredColourTerms(sc: SuggestedScenario, audience: ColourAudience): { a: string[]; b: string[] } {
  const nouns = audience === 'regen-preview'
    ? { a: strList(sc.actorA), b: strList(sc.actorB) }
    : { a: [] as string[], b: [] as string[] };
  const trimmed = (v: unknown): string[] => (typeof v === 'string' && v.trim() ? [v.trim()] : []);
  return {
    a: [...trimmed(sc.row1), ...trimmed(sc.row2), ...nouns.a],
    b: [...trimmed(sc.col1), ...trimmed(sc.col2), ...nouns.b],
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

export function scenarioRenderability(sc: SuggestedScenario, audience: ColourAudience): Renderability {
  const desc = sc.description ?? '';
  const painted = renderedColourTerms(sc, audience);
  const a = painted.a.some((t) => highlightWouldMatch(t, desc));
  const b = painted.b.some((t) => highlightWouldMatch(t, desc));
  if (a && b) return { a, b, ambiguityOnly: false };
  const authored = authoredColourTerms(sc, audience);
  const rawA = authored.a.some((t) => highlightWouldMatch(t, desc));
  const rawB = authored.b.some((t) => highlightWouldMatch(t, desc));
  return { a, b, ambiguityOnly: rawA && rawB };
}

/**
 * THE GATE. A story in which a player cannot be found at all is rejected; a
 * story the renderer declines to colour because the two players share the term
 * is kept. Returns the side, so the drop reason a production log carries names
 * WHICH player the reader would lose (v5 self-adversarial item (f)).
 */
export function scenarioIsAttributable(
  sc: SuggestedScenario,
  audience: ColourAudience,
): { ok: boolean; reason?: string } {
  const r = scenarioRenderability(sc, audience);
  if (r.a && r.b) return { ok: true };
  if (r.ambiguityOnly) return { ok: true };
  const side = !r.a && !r.b ? 'either player' : !r.a ? 'player A' : 'player B';
  return {
    ok: false,
    reason: `the description names nothing the ${audience} would highlight for ${side}`,
  };
}
