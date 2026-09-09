/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * THE SCREEN A DRAWN SCENARIO MUST PASS BEFORE IT IS SERVED — as one table.
 *
 * It used to be a closure inside `inventScreenedScenario`, four `if`s written
 * one per finding. Three consequences, all of them measured rather than
 * supposed:
 *
 *  1. TWO OF THE FOUR DROPPED SILENTLY. `validateScenario` and the direction
 *     checks returned `false` without calling `onDrop`, so the production log
 *     `[report] rung-3 scenario dropped: …` reported three of five reasons and
 *     the reroll budget could not be tuned against the two it never saw.
 *  2. THE SCREEN WAS NOT TESTABLE. Being a closure, nothing could call it; the
 *     only guard on it was `src/scenariopaths.contract.test.ts` matching the
 *     SHAPE of server.ts's source. "Presence is not participation" was checked
 *     by a regex looking for `return false` near a call.
 *  3. A SCREEN COULD SHIP WITHOUT FIXTURES OR A REACH NUMBER, because there was
 *     nothing to enumerate. `src/scenarioscreen.contract.test.ts` now walks
 *     THIS table and fails when an entry lacks a known-positive fixture, its
 *     hand-read negatives, or its measured reach — so a new screen cannot be
 *     added without them.
 *
 * The screens themselves are unchanged in order and in meaning; nothing here
 * loosens one. `attributable` is the one addition (STRUCT-CLOUD-19/001).
 */
import type { GamePayoffs, SuggestedScenario } from '../types';
import { scenarioIsClaimFree, validateScenario, validateProseDirections } from './nashValidator';
import { isSameStory } from './scenarioRegen';
import { scenarioIsAttributable } from './scenarioRenderability';

export interface ScreenOptions {
  /** the story a regenerate must not hand back unchanged */
  avoid?: { name?: string; description?: string; domain?: string };
  /** `NASH_DIRECTION_CHECKS === '1'`; read by the caller so this stays pure */
  directionChecks: boolean;
}

export interface ScenarioScreen {
  /** stable id — the drop log, the fixtures and the reach table all key on it */
  id: string;
  /** what it refuses, in one line */
  what: string;
  /** null when the story passes; otherwise the reason recorded in the drop log */
  run: (sc: SuggestedScenario, g: GamePayoffs, opts: ScreenOptions) => string | null;
}

/**
 * ORDER IS PART OF THE CONTRACT. The cheapest structural refusals come first so
 * a malformed draw never reaches a screen that assumes well-formed fields, and
 * `src/scenarioscreen.contract.test.ts` requires every known-positive fixture to
 * be caught by ITS OWN screen and by no earlier one — an isolating fixture, so
 * deleting any single screen makes exactly one check fail.
 */
export const SCENARIO_SCREENS: readonly ScenarioScreen[] = [
  {
    id: 'declarations',
    what: 'the story contradicts the matrix, leaks debris, or declares a malformed shape',
    /**
     * `actorNouns: true` on EVERY route, and it does not mean "nouns are
     * required": its one and only effect (nashValidator.ts, `if
     * (options.actorNouns && !actorNounsOk(sc))`) is to DROP a declared noun
     * pair the shared safety predicate refuses, keeping the story — and
     * `actorNounsOk` returns true for a scenario that declares none.
     *
     * It used to be the caller's `actorNouns` draw-shape flag, so the safety
     * pass ran on the regenerate route and not on the report one. That is the
     * same "a guard on one path, absent on its sibling" shape as
     * STRUCT-CLOUD-19/001 itself, and now that /api/report serves the nouns it
     * would be the live version of it: an unsafe noun could reach the card
     * without ever meeting the predicate the bank build applies. Measured on
     * the shipped artifact: 2090 of 2442 rows declare nouns, 0 fail
     * `actorNounsOk`, so this is defence in depth rather than a behaviour
     * change (`_gen/cloud19_nounsok.ts`).
     */
    run: (sc, g) => {
      const v = validateScenario(sc, g, { actorNouns: true });
      return v.ok ? null : (v.issues[0] ?? 'validateScenario');
    },
  },
  {
    id: 'claim-free',
    what: 'the rung-3 description asserts something the solver is the only voice for',
    run: (sc) => {
      const cf = scenarioIsClaimFree(sc);
      return cf.ok ? null : (cf.reason ?? 'not claim-free');
    },
  },
  {
    id: 'regen-same-story',
    what: 'a regenerate handed back the story the user asked to replace',
    run: (sc, _g, opts) => (opts.avoid && isSameStory(sc, opts.avoid) ? 'regen-same-story' : null),
  },
  {
    id: 'directions',
    what: 'a directional claim in the description points the wrong way against the matrix',
    run: (sc, g, opts) => {
      if (!opts.directionChecks) return null;
      const issues = validateProseDirections(sc.description ?? '', sc, g);
      return issues.length ? issues[0] : null;
    },
  },
  {
    id: 'attributable',
    what: 'the reader cannot find one of the players in the story (RED-DESKTOP-9/001)',
    run: (sc) => {
      const a = scenarioIsAttributable(sc);
      return a.ok ? null : (a.reason ?? 'unattributable');
    },
  },
];

export interface ScreenVerdict {
  ok: boolean;
  /** which screen refused it — the id, for a log or a counter */
  screen?: string;
  /** the human reason, already suitable for the drop log */
  reason?: string;
}

/** Runs the table in order and stops at the first refusal. */
export function screenScenario(
  sc: SuggestedScenario,
  g: GamePayoffs,
  opts: ScreenOptions,
): ScreenVerdict {
  for (const s of SCENARIO_SCREENS) {
    const reason = s.run(sc, g, opts);
    if (reason !== null) return { ok: false, screen: s.id, reason };
  }
  return { ok: true };
}
