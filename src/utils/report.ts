/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Generates a natural-language game analysis, grounded in the solver.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ SDK-BOUND MODULE — SERVER AND EVAL HARNESS ONLY.                 │
 * │ Never import this from the App.tsx graph. It pulls in provider   │
 * │ SDKs, which would break the browser build and ship server-side   │
 * │ clients (and their key handling) to the client.                  │
 * │ The pure counterpart is nashValidator.ts, which anyone may use.  │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * Division of labour: the solver computes, the model explains. The model is
 * never asked to derive an equilibrium — it receives them and writes prose.
 * Whatever it claims is then checked against ground truth by nashValidator.
 *
 * This file is PROVIDER-AGNOSTIC: the grounding payload, the rubric, and the
 * response schema are identical for every model, which is what makes the eval's
 * cross-family comparison meaningful. All vendor dialect lives in providers.ts.
 */

import type { GamePayoffs, LlmReport, SuggestedScenario } from '../types';
import { computeAllNE, computeIndifference, fmtProb } from './gameEngine';
import { geometryBriefing } from './geometry';
import { callProvider, hasCredentials, type NormalizedUsage, type ProviderFailure, type ReasoningEffort } from './providers';

/**
 * Chosen from eval data, not preference — see src/evals/ and the sweep of
 * 2026-08-10 (16 golden games x 3 passes, two model families).
 *
 * gpt-5.4-nano and gemini-3.5-flash-lite tied at 100% factual consistency, so
 * accuracy did not decide it. Cost was close ($0.00037 vs $0.00058/report).
 * TAIL LATENCY decided it: gemini won the median (1144ms vs 2478ms) but its
 * p90 was 38s and p95 66s, against 3.8s/4.0s here. This is rendered behind a
 * button a user waits on, so the tail is the experience — a median win is worth
 * nothing if one click in ten hangs for half a minute.
 *
 * Caveats worth re-checking before treating this as settled: gemini's tail is
 * partly a FREE-TIER artifact and a paid key may look different, and the Azure
 * credits backing this deployment expire. Overridden per-request by the eval
 * sweep, and per-deploy by REPORT_MODEL.
 *
 * 2026-08-29 — SWITCHED nano -> mini on a 213-row head-to-head (same gate, run
 * in parallel so latency is symmetric):
 *
 *     gpt-5.4-mini  209/213 = 98.1%  defect 1.88% [0.73, 4.73]  p50 2.9s  427 tok
 *     gpt-5.4-nano  182/213 = 85.4%  defect 14.6% [10.4, 19.9]  p50 3.7s  467 tok
 *
 * Two-proportion z = 4.76, p = 1.9e-06 — a 7.7x reduction in defect rate, and
 * mini is also FASTER and TERSER. It costs 3.50x nano ($37.36 vs $10.68 per
 * 10,000 explanations), which is the only axis it loses on.
 *
 * The 40-row screen that preceded this read nano at 90% and mini at 95% and so
 * understated the gap by more than half; 40 rows cannot separate 2 failures
 * from 4. Do not re-decide this on a small battery.
 */
/**
 * Rule 1 of the rung-1 block, A/B-able.
 *
 * Measured on gpt-5.4-mini's 213-row battery: mini complies near-perfectly with
 * the other four rung-1 rules (across 705 sentences, rule 2 violated ONCE,
 * rule 3 five times, rule 5 eight times) but IGNORES this one in 32.1% of
 * reports — and a chained sentence appears in 100% of its failures against a
 * 32.1% base rate among passes (one-sided Fisher p = 0.012). So this is the one
 * rung-1 rule with headroom on this model, and 'strong' names the exact
 * construction mini actually writes instead of describing the fault abstractly.
 *
 * NASH_RULE1: unset/'default' = the original wording; 'strong' = below; 'off' =
 * omit the rule entirely (to test whether it does anything at all).
 */
const RULE1_DEFAULT = '- ONE CLAIM PER SENTENCE. Never chain two best-reply claims together ("A prefers X against Y and Z against W"): write them as separate sentences. Compressed multi-claim sentences are where your reasoning most often slips, and a reader cannot check them either.';
const RULE1_STRONG = `- ONE CLAIM PER SENTENCE — THIS IS THE RULE YOU ARE MOST LIKELY TO BREAK. A sentence may contain AT MOST ONE of the words better, worse, prefers, favours, best reply, does better, dominant. If you are about to write a sentence with two of them, stop and split it into two sentences.
  FORBIDDEN, and this exact shape is where your errors happen: "Search Ads is better against a Local Campaign, while Television Ads is better against a National Campaign." Also forbidden with "and", "whereas", "but", or a semicolon in place of "while".
  REQUIRED instead: "Against a Local Campaign, A prefers Search Ads. Against a National Campaign, A prefers Television Ads."
  Before you finish, re-read every sentence you wrote and count those words. Two in one sentence means you must split it.`;
const RULE1 = process.env.NASH_RULE1 === 'strong' ? RULE1_STRONG
  : process.env.NASH_RULE1 === 'off' ? ''
  : RULE1_DEFAULT;

export const DEFAULT_MODEL = process.env.REPORT_MODEL || 'gpt-5.4-mini';

/**
 * Structured-output schema. Constrains SHAPE only.
 *
 * Written as a plain JSON-Schema subset so one definition serves every
 * provider: Gemini takes it as-is (it rejects `additionalProperties`), and the
 * OpenAI adapter grafts `additionalProperties: false` on for strict mode.
 * Numeric constraints (minimum/maximum) are unsupported across the board, so
 * "x is a probability" cannot be expressed here — nashValidator range-checks
 * instead. Schema constrains shape; the solver constrains truth.
 */
const REPORT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  // Strict structured output requires EVERY property to be listed here;
  // optionality is expressed by allowing null, not by omission.
  required: ['claimedEquilibria', 'suggestedScenario', 'geometryClaims', 'proseClaims', 'prose'],
  properties: {
    claimedEquilibria: {
      type: 'array',
      description:
        'Every equilibrium of this game. Use "continuum" when a player is ' +
        'indifferent and a whole line or region is in equilibrium; give any ' +
        'representative point for x and y in that case.',
      items: {
        type: 'object',
        required: ['type', 'x', 'y'],
        properties: {
          type: { type: 'string', enum: ['pure', 'mixed', 'continuum'] },
          x: { type: 'number', description: "Player A's probability of Row 1, 0 to 1." },
          y: { type: 'number', description: "Player B's probability of Column 1, 0 to 1." },
        },
      },
    },
    suggestedScenario: {
      type: ['object', 'null'],
      required: ['name', 'row1', 'row2', 'col1', 'col2', 'description', 'storyClaims'],
      description:
        'ONLY when the game had no scenario attached: a short concrete story ' +
        'fitting these payoffs. Omit entirely when a scenario was supplied.',
      properties: {
        name: { type: 'string', description: 'Short title, e.g. "Border Patrol".' },
        row1: { type: 'string', description: "A's first option, 1-3 words." },
        row2: { type: 'string', description: "A's second option, 1-3 words." },
        col1: { type: 'string', description: "B's first option, 1-3 words." },
        col2: { type: 'string', description: "B's second option, 1-3 words." },
        description: {
          type: 'string',
          description:
            'Two or three plain sentences setting up the situation and what each ' +
            'player is choosing between. Do not state the equilibrium.',
        },
        /**
         * The description's factual claims, restated as data — same design as
         * geometryClaims. A QA sweep found ~1 in 4 invented stories asserting a
         * backwards pairing or citing a payoff against the wrong cell; those
         * sentences are undecidable by regex, but a declared claim is a lookup.
         * Nullable: a story that makes no such claims declares nothing.
         */
        storyClaims: {
          type: ['object', 'null'],
          required: ['cellCitations', 'bestReplies'],
          description:
            'Every factual claim your description makes about the payoffs, restated ' +
            'as data so it can be checked. Set null ONLY if the description cites no ' +
            'payoff numbers and never says one option works better against another.',
          properties: {
            cellCitations: {
              type: 'array',
              description:
                'One entry per action-pair whose payoffs the description states, ' +
                'e.g. "if A patrols and B warns, they get 8 and 3" -> the (row, col) ' +
                'of Patrol/Warn with a=8, b=3, exactly as in the matrix.',
              items: {
                type: 'object',
                required: ['row', 'col', 'a', 'b'],
                properties: {
                  row: { type: 'number', description: "1 or 2: which of A's options the sentence names." },
                  col: { type: 'number', description: "1 or 2: which of B's options the sentence names." },
                  a: { type: 'number', description: "A's payoff in that cell." },
                  b: { type: 'number', description: "B's payoff in that cell." },
                },
              },
            },
            bestReplies: {
              type: 'array',
              description:
                'One entry per claim that one option does better than the other ' +
                'against a fixed opponent option — "works best against", "the ' +
                'quitter loses / the cooperator gains", "prefers X when Y".',
              items: {
                type: 'object',
                required: ['player', 'opponentOption', 'bestOption', 'bestPays', 'altPays'],
                properties: {
                  player: { type: 'string', enum: ['A', 'B'] },
                  opponentOption: { type: 'number', description: '1 or 2: the opponent option held fixed.' },
                  bestOption: { type: 'number', description: '1 or 2: the option claimed better for this player.' },
                  bestPays: {
                    type: ['number', 'null'],
                    description:
                      "The payoff the sentence states for the better option (copy the exact number it cites); null if the sentence cites no numbers.",
                  },
                  altPays: {
                    type: ['number', 'null'],
                    description:
                      'The payoff the sentence states for the other option; null if not cited.',
                  },
                },
              },
            },
          },
        },
      },
    },
    /**
     * The geometric claims, declared so they can be checked.
     *
     * Nullable on purpose. A required non-null object would make every provider
     * that fumbles one boolean fail the whole parse, and a failed parse drops
     * the user to the deterministic panel — a worse outcome than an unchecked
     * paragraph. Declining to declare is allowed; declaring falsely is not.
     */
    geometryClaims: {
      type: ['object', 'null'],
      required: [
        'surfacesInteract', 'opponentSurfaceIsMirror',
        'hasFlatShelfForA', 'equilibriumIsInteriorFlatSpot',
        'invokesMinimax', 'claimsDominantStrategy',
      ],
      description:
        'The geometric facts your prose relies on, restated as booleans. Copy ' +
        'them from the supplied geometry — do not derive them. Set null only if ' +
        'your explanation says nothing about the shape of the surfaces.',
      properties: {
        surfacesInteract: {
          type: 'boolean',
          description: "True when A's surface is warped rather than a flat plane.",
        },
        opponentSurfaceIsMirror: {
          type: 'boolean',
          description: "True when B's surface is A's flipped over (zero-sum or constant-sum).",
        },
        hasFlatShelfForA: {
          type: 'boolean',
          description: "True when A's surface goes level somewhere on the board.",
        },
        equilibriumIsInteriorFlatSpot: {
          type: 'boolean',
          description: 'True when both surfaces are level at the same interior point.',
        },
        invokesMinimax: {
          type: 'boolean',
          description:
            'True if your prose calls the equilibrium a minimax outcome or "the value of the game".',
        },
        claimsDominantStrategy: {
          type: 'boolean',
          description:
            'True if your prose says a player has an option that is better whatever the opponent does.',
        },
      },
    },
    /**
     * The prose's action-level claims, declared so they can be checked — the
     * companion to geometryClaims for WHO-PLAYS-WHAT statements. A QA audit
     * caught validated prose naming the wrong option beside correct
     * coordinates ("B plays Silent with probability 1 (y=0)" when y=0 was
     * the other column); which label a sentence names is semantic, but a
     * declared option index is a lookup. Nullable for the same reason
     * geometryClaims is.
     */
    proseClaims: {
      type: ['object', 'null'],
      required: ['equilibriumActions', 'bestReplies'],
      description:
        "Your prose's action-level claims restated as data. Set null ONLY if " +
        'the prose never names which option a player uses at an equilibrium ' +
        'and never says one option does better than the other.',
      properties: {
        equilibriumActions: {
          type: 'array',
          description:
            'One entry each time the prose says a player uses a specific ' +
            'option at an equilibrium — with certainty OR with some mixed ' +
            'probability: the player and the option NUMBER the named label ' +
            'corresponds to. Remember x is A\'s probability of Row 1 (x=1 ' +
            'pure Row 1, x=0 pure Row 2) and y is B\'s of Col 1.',
          items: {
            type: 'object',
            required: ['player', 'option'],
            properties: {
              player: { type: 'string', enum: ['A', 'B'] },
              option: { type: 'number', description: '1 or 2: the option the prose names for this player.' },
            },
          },
        },
        bestReplies: {
          type: 'array',
          description:
            'One entry per "X does better against Y" claim in the prose. A ' +
            'dominance claim ("X is better no matter what the opponent does") ' +
            'is TWO entries, one per opposing option.',
          items: {
            type: 'object',
            required: ['player', 'opponentOption', 'bestOption', 'bestPays', 'altPays'],
            properties: {
              player: { type: 'string', enum: ['A', 'B'] },
              opponentOption: { type: 'number', description: '1 or 2: the opponent option held fixed.' },
              bestOption: { type: 'number', description: '1 or 2: the option claimed better for this player.' },
              bestPays: {
                type: ['number', 'null'],
                description:
                  "The payoff the sentence states for the better option (copy the exact number it cites); null if the sentence cites no numbers.",
              },
              altPays: {
                type: ['number', 'null'],
                description:
                  'The payoff the sentence states for the other option; null if not cited.',
              },
            },
          },
        },
      },
    },
    prose: {
      type: 'string',
      description:
        'Two to four sentences explaining the strategic situation in plain ' +
        'language: what each player is trading off and why the equilibrium ' +
        'sits where it does. No markdown, no headings, no LaTeX.',
    },
  },
};

/**
 * The scenario-only call: same suggestedScenario definition as the full
 * report (one source of truth — this references INTO REPORT_SCHEMA), nothing
 * else. "New AI scenario" wants a fresh story for a game whose explanation
 * is already on screen and validated; regenerating the whole report costs
 * ~650 output tokens at ~95 tok/s where the story alone costs ~300, so the
 * dedicated call roughly halves that button's latency and its retry.
 */
const SCENARIO_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['suggestedScenario'],
  properties: {
    suggestedScenario: (REPORT_SCHEMA.properties as Record<string, Record<string, unknown>>).suggestedScenario,
  },
};

export const SCENARIO_SYSTEM_PROMPT = `RUNG-3 MODE (set when the caller renders the mathematics itself): if the request says the description must be claim-free, then write PURE SCENE-SETTING only — who the two players are and what each option means — with NO numbers and NO claims about preferences, responses, advantages or equilibria, and OMIT storyClaims entirely. The solver states all of that; a description asserting anything decidable is discarded.

You are inventing a short, concrete scenario for a 2x2 normal-form game — who the two players are and what their two options mean. You will be given the payoff matrix, the solver's equilibria, and a best-reply table, all authoritative.

Rules (the same discipline as the full report path):
- The story must fit and never contradict the payoffs or the equilibria. Option labels are 1-3 words; the description is two or three plain sentences and does not state the equilibrium.
- Restate the description's factual claims in storyClaims so they can be checked: every action-pair whose payoffs the description cites goes in cellCitations with the exact matrix values, and every "X works best against Y" or "the quitter loses"-style claim goes in bestReplies — copied from the supplied best-reply table, never derived. When a sentence states the payoffs it compares, copy them into bestPays/altPays; otherwise null.
- Never characterize what happens when specific options meet in words alone: state that cell's exact numbers and cite the cell, or leave the outcome unsaid.
- Any sentence that says one option is better, worse, tempting, safer, riskier, or preferred MUST name the options with their exact labels, not a paraphrase ("Light inspection", not "when inspections are light") and not an invented role noun ("the pusher", "the yielding side"). A comparison that cannot be matched to a label cannot be checked, so it will be discarded even when correct.
- Declarations must match the text in both directions: delete any entry no sentence states, and declare every claim a sentence makes. If the description makes no payoff or better-against claims, set storyClaims to null.
- VARY THE DOMAIN. Left unguided this task collapses onto a handful of settings: 40% of a 1,140-scenario sample came back "Harbor Inspection" and 15% "Museum Security", and a model distilled on that wrote harbour inspections 90% of the time. Choose the setting from the SHAPE of this particular game rather than reaching for a default, and range widely — for example: farming and irrigation, airline scheduling, hospital staffing, orchestra programming, software release timing, fishing quotas, publishing deals, construction bidding, energy grid dispatch, school timetabling, freight routing, vaccine allocation, film distribution, sports tactics, retail pricing, spectrum auctions, water rights, restaurant sourcing, urban transit, archaeology permits, satellite scheduling, brewing, translation contracts, insurance underwriting, wildfire response, patent licensing, and many others. Inspection, security, customs and smuggling settings are heavily over-used: prefer something else unless the payoffs genuinely call for enforcement framing.`;

export interface GenerateScenarioResult {
  scenario: SuggestedScenario | null;
  failure: ProviderFailure | null;
  /**
   * Token usage for the invention call. Absent until 2026-08-29: the scenario
   * path is the ONLY call rung 3 makes, so without this its cost — and the
   * reasoning tokens a thinking model spends on it — could not be measured at
   * all. A yield harness printed structural zeros for every arm before this.
   */
  usage?: NormalizedUsage | null;
}

/** The slim invention call behind "New AI scenario" — see SCENARIO_SCHEMA. */
export async function generateScenario(
  g: GamePayoffs,
  opts: { model?: string; reasoning?: ReasoningEffort } = {},
): Promise<GenerateScenarioResult> {
  const res = await callProvider({
    model: opts.model || DEFAULT_MODEL,
    systemPrompt: SCENARIO_SYSTEM_PROMPT,
    // No scenario passed on purpose: the payload's invention block applies.
    userPrompt: buildGroundingPayload(g),
    reasoning: opts.reasoning,
    schema: SCENARIO_SCHEMA,
    // 2048 was sized for a NON-reasoning call: the scenario body is ~200 tokens,
    // so it looked generous. Reasoning tokens bill against this same budget, and
    // once `reasoning` is on a call can spend the whole cap thinking and return
    // truncated or empty JSON — the exact failure the report call's comment
    // warns about, one function up. Measured on the rung-3 yield runs: 1.1% of
    // luna@low calls and 1.7% of mini@low calls came back empty after ~11s (a
    // full budget generated), versus ~2.3s for a healthy call. Those are lost
    // stories caused by our cap, not by the model. Matched to the report call.
    maxOutputTokens: 8192,
  });
  if (res.failure || !res.text) return { scenario: null, failure: res.failure ?? 'unparseable', usage: res.usage ?? null };
  try {
    const parsed = JSON.parse(res.text) as { suggestedScenario?: SuggestedScenario | null };
    return { scenario: parsed.suggestedScenario ?? null, failure: null, usage: res.usage ?? null };
  } catch {
    return { scenario: null, failure: 'unparseable', usage: res.usage ?? null };
  }
}

/**
 * Identical for every model in the sweep — the rubric is part of the
 * measurement, so it must not vary by provider.
 */
export const SYSTEM_PROMPT = `You are a game theorist explaining a 2x2 normal-form game to someone learning the subject.

You will be given a payoff matrix AND the equilibria, already computed exactly by a solver. Your job is to EXPLAIN, never to derive.

Rules:
- Report exactly the equilibria you are given. Do not add, drop, merge, or recompute any of them. If the solver reports one equilibrium, report one.
- In claimedEquilibria, copy the coordinates verbatim. Do not round, rescale, or "correct" them.
- In the PROSE you may name a coordinate in words when that reads better — "a third", "two-thirds", "fifty-fifty" — provided it is the same value. The structured claims carry the exact numbers, so the prose does not have to.
- When you are told the game is degenerate (a player is indifferent, so a whole line or region is in equilibrium), label those claims "continuum" and give any representative point inside the region.
- The prose should say what the players are actually trading off, in the terms of the game itself. Prefer "A gains nothing by switching once B mixes at these odds" over restating the definition of Nash equilibrium.
- Write for a reader who knows what a payoff matrix is and does not yet have intuition for mixed strategies. Two to four sentences. Plain prose, no markdown, no headings, no LaTeX.
- Never claim an equilibrium exists that you were not given, and never describe a pure equilibrium in a game that has none. If the solver found no pure equilibria, say plainly that the game has none and explain why the players must mix.
- If a scenario is supplied, use its names for the players' options instead of "Row 1"/"Col 2" wherever that reads better, and leave suggestedScenario out. If none is supplied, invent one that fits the payoffs, write the explanation in its terms, and return it in suggestedScenario. Never let an invented story contradict the payoffs or the equilibria.
- When you invent a scenario, restate the description's factual claims in suggestedScenario.storyClaims so they can be checked: every action-pair whose payoffs the description cites goes in cellCitations with the exact matrix values, and every "X works best against Y" or "prefers X when the opponent does Y" claim goes in bestReplies. A claim made in the description but missing from storyClaims, or declared wrongly, causes the whole story to be discarded — when unsure which cell a sentence refers to, reread the matrix rather than guess. If the description cites no payoffs and makes no better-against claims, set storyClaims to null.
- In an invented description, never characterize what happens when specific options meet in words alone ("pays off", "is punished", "works well"): any sentence about a particular action combination's outcome must state that cell's exact payoff numbers, and that cell must appear in cellCitations. If you prefer not to cite numbers, make no outcome claims — describe only who the players are and what their options mean. Sentences like "the quitter loses and the cooperator gains" are better-against claims: declare them in bestReplies, and verify the direction against the matrix rather than against how such stories usually go — the numbers you were given always win.
- Whenever a better-against sentence states the payoffs it compares ("gets 9 rather than −9"), copy those exact numbers into that bestReplies entry's bestPays/altPays; set both null when the sentence cites no numbers. Each cited number must belong to the exact cell being compared — copy it from the supplied best-reply table's matching line, never derive it from the matrix yourself.
- If your description refers to the players by role nouns ("the gatekeeper", "the analyst") rather than as A and B, you MUST list those nouns in actorA and actorB. Without them a sentence like "the gatekeeper chooses Ford River" cannot be checked against the matrix, and assigning one player's option to the other is the most common remaining error in this report.
- A dominant strategy makes a player's PREFERENCE independent of the opponent, never their PAYOFF. Write "A's best choice is the same whichever column B picks"; never "A's payoff doesn't depend on what B does" unless that row really is flat (both cells equal). The same care applies to "B's choice affects A's payoff": say it only when those two cells differ.
- When you are asked ONLY for a scenario (no prose), the description must be PURE SCENE-SETTING: who the two players are and what each option means, in two or three sentences, with NO numbers and NO claims about the game — nothing about who prefers what, who responds to whom, what is better, or where the equilibrium lies. The solver states all of that. A description that asserts anything decidable is discarded.
${RULE1}
- NEVER CHARACTERISE THE GAME TYPE. Do not call it a coordination game, an anti-coordination game, a matching game, or say the players coordinate, mismatch, or that "coordination succeeds": name the equilibria instead ("the pure equilibria are (Row 1, Col 2) and (Row 2, Col 1)"). Whether the equilibria sit on matching or mismatching pairs is something the reader can see from the profiles you name.
- USE "A" AND "B" IN ANY SENTENCE THAT MAKES A CLAIM. Role nouns ("the gatekeeper", "the analyst") are fine for scene-setting, but a sentence stating a preference, a payoff, a probability or an equilibrium must say A or B, so that which player is meant is never in doubt.
- NEVER SHORTEN AN OPTION LABEL. If the option is "Hunt Stag", write "Hunt Stag", not "Stag" — including inside a comparison.
- WHEN YOU STATE A MIXTURE, GIVE BOTH PROBABILITIES AND CHECK THEY SUM TO 1. Write "A plays Hunt Stag with probability 0.6 and Hunt Hare with probability 0.4"; before you finish, add the two numbers and confirm they make exactly 1.
- A MIXED COORDINATE IS NEVER 0 OR 1. When the solver output says "less than 0.001" or "more than 0.999", copy that wording (or write "essentially never"/"almost always") — do NOT round it to "probability 0" or "probability 1": the profile at exactly 0 or 1 is provably not an equilibrium.
- Any sentence that says one option is better, worse, tempting, safer, riskier, or preferred MUST name the options with their exact labels, spelled the way they appear above ("Light inspection", not "when inspections are light"; "Insist", not "the pusher" or "the yielding side"). A comparison written in paraphrase or in an invented role noun cannot be checked, so it will be discarded even when it is correct. Use "you" for neither player.
- Declarations must match the text in BOTH directions, and you must re-read the description and prose sentence by sentence against your declarations before answering: an entry for a claim the text never makes is as fatal as a missing entry, so when a declaration has no sentence that states it, delete the declaration — do not keep it "to be safe".
- You are also given the GEOMETRY of the two expected-payoff surfaces the reader is looking at. Where it helps, describe the equilibrium in those terms: indifference is a level shelf where a surface stops tilting; the equilibrium is the joint flat spot where both surfaces are level at once; strategic interaction is the warp in the surface; a best response is which way a slice tilts. Use these ONLY where the supplied geometry says they apply — if it tells you there is no flat shelf, or no interior flat spot, or that the game is not zero-sum, do not describe one.
- Fill in geometryClaims to match what the supplied geometry states, and make sure your prose agrees with it. These are copied, not worked out: every one of them is stated for you above. If your explanation does not discuss the shape of the surfaces at all, set geometryClaims to null rather than guessing.
- Restate your prose's action-level claims in proseClaims so they can be checked. Every time the prose names which option a player uses at an equilibrium (including "plays X with probability 1"), add an equilibriumActions entry with that player and the option NUMBER the named label maps to — before writing it, verify the label against the coordinates you were given: x=1 means A plays Row 1, x=0 means Row 2; y=1 means B plays Col 1, y=0 means Col 2. Every "X does better against Y" claim goes in bestReplies, and a dominance claim is two entries (one per opposing option). Declare ONLY claims your prose actually states — do not add entries for comparisons the prose never makes, and before each entry re-check the direction against the matrix. A claim made in prose but missing here, or declared wrongly, causes the whole explanation to be withheld. If the prose makes no such claims, set proseClaims to null.`;

/**
 * Compact system prompt for the LOCAL fine-tuned explainer (Electron).
 *
 * The full SYSTEM_PROMPT above is ~1,230 tokens of rules a cloud model must
 * be told on every call. A model fine-tuned on gate-validated reports has
 * those rules baked into its weights, so the local path sends only this
 * identity line. Everything factual still arrives in the grounding payload,
 * and nashValidator still gates every number exactly as it does for the
 * cloud path. Halves training cost and saves ~3s of prompt processing per
 * report on Apple-silicon inference.
 */
export const LOCAL_SYSTEM_PROMPT = `You are a game theorist explaining a 2x2 normal-form game to someone learning the subject. You are given the payoff matrix, the equilibria computed exactly by a solver, a best-reply table and the geometry of the expected-payoff surfaces; all of it is authoritative. Explain, never derive. Answer with the report JSON only.`;

/** Everything the model is allowed to know. Ground truth, nothing else. */
/**
 * The story attached to a game, when there is one.
 *
 * Without it the model can only write "Player A plays Row 1", because Row 1 is
 * genuinely all it knows. The app's presets already carry concrete nouns
 * ("Search L", "Hide R") and never passed them to the explainer — so an
 * explanation of the Search Game talked about rows and columns rather than
 * doors, which is worse for a learner and made the prose unmistakably
 * machine-written.
 *
 * The preset `desc` is deliberately NOT included: it is HTML, and it states the
 * equilibrium outright, which would let the model recite instead of explain.
 */
export interface Scenario {
  name?: string;
  row1?: string; row2?: string;
  col1?: string; col2?: string;
  /** Free text a user wrote about their own game. Plain text, already clamped. */
  description?: string;
}

/**
 * Is there enough here for the model to talk about the game in concrete nouns?
 *
 * Labels are enough on their own. A description needs to be long enough to
 * actually describe something — a two-word title tells the model nothing it can
 * write with, and inventing a scenario is better than half-using a fragment.
 */
export function scenarioIsUsable(sc?: Scenario): boolean {
  if (!sc) return false;
  const hasLabels = !!(sc.row1 && sc.row2 && sc.col1 && sc.col2);
  const hasStory = (sc.description ?? '').trim().split(/\s+/).length >= 12;
  return hasLabels || hasStory;
}

function scenarioBlock(sc?: Scenario): string {
  if (scenarioIsUsable(sc) && sc) {
    const parts: string[] = [];
    if (sc.name) parts.push(`This game is known as: ${sc.name}.`);
    if (sc.description) parts.push(`The person who built it describes it this way: "${sc.description}"`);
    if (sc.row1 && sc.row2) parts.push(`A's two options are "${sc.row1}" (Row 1) and "${sc.row2}" (Row 2).`);
    if (sc.col1 && sc.col2) parts.push(`B's two options are "${sc.col1}" (Col 1) and "${sc.col2}" (Col 2).`);
    parts.push(
      'Use these names in the prose where they read more naturally than "Row 1" and "Col 2".'
      + ' Do NOT invent a different story, and do not fill suggestedScenario.'
      + ' Explain this scenario in your own words rather than quoting the description'
      + ' back — the reader has already seen it, and what they want from you is the'
      + ' equilibrium told in these terms, not the setup repeated.',
    );
    return parts.join(' ');
  }
  // Nothing usable: let the model invent one, and hand it back so the user can
  // keep it. The story is illustrative only — the payoffs remain authoritative.
  return 'This game has no scenario attached. Invent a short, concrete one that fits these payoffs'
    + ' — who the two players are and what their two options are — write the explanation using it,'
    + ' and return it in suggestedScenario so it can be offered to the user. The story must not'
    + ' contradict the payoffs or the equilibria you were given. Declare every payoff number and'
    + ' every better-against claim the description makes in storyClaims (or set it to null if it'
    + ' makes none) — undeclared or wrongly declared claims get the story discarded. Never'
    + ' describe the outcome of a specific action combination in words alone: state that cell\'s'
    + ' numbers and cite the cell, or leave the outcome unsaid.';
}

/**
 * The four best-reply comparisons, precomputed and worded, so the model COPIES
 * them instead of deriving them. Every direction error, phantom declaration,
 * and welded payoff the adversarial QA ever caught was the model doing one of
 * exactly these four lookups on reflex and pattern-matching its way to the
 * wrong cell — B's side especially. Reflex-mode nano is a poor reasoner but a
 * reliable copier (the per-option equilibrium spell-out proved it), so the
 * whole table is handed over as material.
 */
function bestReplyTable(g: GamePayoffs): string[] {
  const line = (oppDesc: string, o1: string, p1: number, o2: string, p2: number) => {
    const verdict = Math.abs(p1 - p2) < 1e-9
      ? `they tie at ${p1}`
      : p1 > p2 ? `${o1} is better` : `${o2} is better`;
    return `  ${oppDesc}: ${o1} pays ${p1}, ${o2} pays ${p2} — ${verdict}.`;
  };
  return [
    'Best-reply table (authoritative — every "better against" statement and every bestReplies entry must be copied from these four lines, never derived):',
    line("A against B's Col 1", 'Row 1', g.a11, 'Row 2', g.a21),
    line("A against B's Col 2", 'Row 1', g.a12, 'Row 2', g.a22),
    line("B against A's Row 1", 'Col 1', g.b11, 'Col 2', g.b12),
    line("B against A's Row 2", 'Col 1', g.b21, 'Col 2', g.b22),
  ];
}

export function buildGroundingPayload(g: GamePayoffs, scenario?: Scenario): string {
  const equilibria = computeAllNE(g);
  const indifference = computeIndifference(g);
  // A flat-payoff player is indifferent between their own actions, so a whole
  // line (or the entire square) is in equilibrium and computeAllNE's corner
  // enumeration is only a partial picture. Trigger on indifference itself:
  // computeAllNE is non-empty for these games (it lists the corners), so gating
  // on an empty list would never fire. Mirrors the trigger in nashValidator.
  const degenerate = indifference.any;

  const matrix = [
    'Payoff matrix (Player A first, Player B second in each cell):',
    `  Row 1 / Col 1: A=${g.a11}, B=${g.b11}`,
    `  Row 1 / Col 2: A=${g.a12}, B=${g.b12}`,
    `  Row 2 / Col 1: A=${g.a21}, B=${g.b21}`,
    `  Row 2 / Col 2: A=${g.a22}, B=${g.b22}`,
  ];

  if (degenerate) {
    const region = indifference.both
      ? 'both players are indifferent between their own actions, so EVERY point in the unit square is an equilibrium'
      : `player ${indifference.aIndifferent ? 'A' : 'B'} is indifferent between their own actions, so a whole line of points is in equilibrium`;
    // Hand the model the enumerated corners as guaranteed-valid representative
    // points, so it can pick one rather than derive a point on the continuum.
    const validPoints = equilibria.length
      ? equilibria.map((e) => `(x=${e.x}, y=${e.y})`).join(', ')
      : 'any point where neither player can gain by deviating';
    const sc0 = scenarioBlock(scenario);
    return [
      ...matrix,
      '',
      ...bestReplyTable(g),
      ...(sc0 ? ['', sc0] : []),
      '',
      geometryBriefing(g),
      '',
      `This game is DEGENERATE: ${region}.`,
      'There is a continuum of equilibria, not a finite list. Report it as a SINGLE',
      'claim of type "continuum", using any one representative point that is in',
      `equilibrium. These enumerated points are all valid choices: ${validPoints}.`,
      'Do NOT list the corners as separate pure equilibria — collapse them into one',
      '"continuum" claim.',
    ].join('\n');
  }

  const sc = scenarioBlock(scenario);
  return [
    ...matrix,
    '',
    ...bestReplyTable(g),
    ...(sc ? ['', sc] : []),
    '',
    geometryBriefing(g),
    '',
    'Solver output (authoritative — x is A\'s probability of Row 1, y is B\'s probability of Col 1):',
    equilibria.length
      // Each equilibrium is ALSO spelled out per option, because every
      // direction error the adversarial QA ever caught (seven across three
      // rounds, zero on A's side) was the model fumbling B's y=P(Col 1)
      // convention — writing "Col 2 with probability 0.8333" when Col 1
      // carries it. The framing pilot's lesson applies: instructions about
      // the convention don't take, but material handed over as computed fact
      // does. So the 1−x/1−y arithmetic is done HERE, never by the model.
      ? equilibria.map((e) => {
          // MIXED coordinates go through fmtProb, never a fixed-precision
          // number: an interior probability like 0.00004 at 4dp is "0", and a
          // handover that says "probability 0" becomes model prose that names a
          // pure profile which is provably not the equilibrium (the same
          // collapse tieProse's prob() exists to prevent). Pure equilibria ARE
          // exactly 0/1 and stay numeric.
          const base = `  ${e.type} at x=${e.type === 'mixed' ? fmtProb(e.x) : e.x}, y=${e.type === 'mixed' ? fmtProb(e.y) : e.y} (payoffs A=${e.eA}, B=${e.eB})`;
          if (e.type === 'pure') {
            return `${base} — that is: A plays Row ${e.x === 1 ? 1 : 2}, B plays Col ${e.y === 1 ? 1 : 2}`;
          }
          return `${base} — that is: A plays Row 1 with probability ${fmtProb(e.x)} and Row 2 with probability ${fmtProb(1 - e.x)}; `
            + `B plays Col 1 with probability ${fmtProb(e.y)} and Col 2 with probability ${fmtProb(1 - e.y)}`;
        }).join('\n')
      : '  none enumerated',
    '',
    'This game is not degenerate; the solver output above is complete.',
  ].join('\n');
}

export interface GenerateResult {
  report: LlmReport | null;
  raw: string | null;
  /** Vendor stop/finish reason, verbatim, for failure bucketing. */
  stopReason: string | null;
  usage: NormalizedUsage | null;
  /** Set when no report was produced — distinguishes a refusal from a crash. */
  failure: ProviderFailure | null;
}

export { hasCredentials };

/**
 * One shared entry point for both POST /api/report and the eval sweep. If these
 * ever diverge the eval stops measuring what production actually runs.
 */
export async function generateReport(
  g: GamePayoffs,
  opts: {
    model?: string; framingGuidance?: string; styleExemplars?: string[]; scenario?: Scenario;
    /**
     * Replace the full rulebook with another system prompt — the local
     * fine-tuned model is served with LOCAL_SYSTEM_PROMPT (the rules are in its
     * weights). Everything else on the path — payload, schema, gates — is
     * identical, so a local report is scored exactly like a cloud one.
     */
    systemPrompt?: string;
    /**
     * Thinking level for the report call. Defaults to the provider's own
     * default (nano effectively answers on reflex), which is where every
     * declaration-fidelity error the adversarial QA found lives — the
     * REPORT_REASONING env lets a deploy raise it without a code change,
     * trading the tail latency that originally picked this model.
     */
    reasoning?: ReasoningEffort;
  } = {},
): Promise<GenerateResult> {
  const model = opts.model || DEFAULT_MODEL;
  const reasoning = opts.reasoning ?? (process.env.REPORT_REASONING as ReasoningEffort | undefined);

  // `framingGuidance` is an EXPERIMENTAL hook, appended rather than substituted
  // so the production rules above always still apply. Production passes nothing
  // and is byte-identical to before. It exists so the voice/framing experiment
  // measures the real production path instead of a copy that can drift — the
  // same reason this function is the single entry point for the API and the
  // eval sweep.
  // `styleExemplars` supplies EXAMPLES rather than rules. The framing pilot
  // showed instructions do not take ("you may use these framings" moved
  // nothing) while material does -- vocabulary handed over inside a computed
  // fact was adopted immediately. Exemplars are material, and unlike a briefing
  // they can carry the SHAPE of an argument, which is what the briefing route
  // could not reach.
  //
  // They are appended, never substituted, so every correctness rule above still
  // applies and nashValidator still gates every number.
  // HARD GATE: exemplars are EXPERIMENT-ONLY and must never ship.
  //
  // They are verbatim prose from a manuscript under double-anonymous review. If
  // they reached the deployed system prompt, that text would be transmitted to
  // the model provider on every public request, and prompt-extraction would
  // surface manuscript wording under the author's identity -- a
  // deanonymisation vector while review is live.
  //
  // Opt-in rather than opt-out on purpose: the default is OFF everywhere,
  // including any environment that forgets to set anything, so shipping them is
  // an action someone has to take rather than a mistake they can make.
  const exemplarsAllowed = process.env.ALLOW_STYLE_EXEMPLARS === '1';
  if (opts.styleExemplars?.length && !exemplarsAllowed) {
    throw new Error(
      'styleExemplars supplied without ALLOW_STYLE_EXEMPLARS=1. These carry manuscript '
      + 'prose and are experiment-only; they must not reach a deployed prompt.',
    );
  }

  const exemplarBlock = opts.styleExemplars?.length
    ? `\n\nHere are examples of the explanatory voice to match. Match their register, sentence`
      + ` rhythm, and way of building an argument -- NOT their content, which describes different`
      + ` games. Never import a claim from an example; every claim must come from the solver output`
      + ` and geometry you were given.\n\n`
      + opts.styleExemplars.map((e, i) => `Example ${i + 1}:\n${e}`).join('\n\n')
    : '';

  const systemPrompt = [
    opts.systemPrompt ?? SYSTEM_PROMPT,
    opts.framingGuidance ? `\n\n${opts.framingGuidance}` : '',
    exemplarBlock,
  ].join('');

  const res = await callProvider({
    model,
    systemPrompt,
    userPrompt: buildGroundingPayload(g, opts.scenario),
    reasoning,
    schema: REPORT_SCHEMA,
    // Roomy on purpose: current models think by default, and thinking tokens
    // count against this budget on every provider. Too tight a cap makes the
    // model spend the whole budget reasoning and return truncated (or empty)
    // JSON. The report body itself is only a few hundred tokens.
    maxOutputTokens: 8192,
  });

  if (res.failure || !res.text) {
    return {
      report: null,
      raw: res.text,
      stopReason: res.stopReason,
      usage: res.usage,
      failure: res.failure ?? 'unparseable',
    };
  }

  try {
    return {
      report: JSON.parse(res.text) as LlmReport,
      raw: res.text,
      stopReason: res.stopReason,
      usage: res.usage,
      failure: null,
    };
  } catch {
    return { report: null, raw: res.text, stopReason: res.stopReason, usage: res.usage, failure: 'unparseable' };
  }
}
