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

import type { GamePayoffs, LlmReport } from '../types';
import { computeAllNE, computeIndifference } from './gameEngine';
import { geometryBriefing } from './geometry';
import { callProvider, hasCredentials, type NormalizedUsage, type ProviderFailure } from './providers';

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
 */
export const DEFAULT_MODEL = process.env.REPORT_MODEL || 'gpt-5.4-nano';

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
                'One entry per "X works best / does better against Y" claim, e.g. ' +
                '"Upload works best against Compress" -> player A, the opponent ' +
                'option held fixed, and the option claimed better.',
              items: {
                type: 'object',
                required: ['player', 'opponentOption', 'bestOption'],
                properties: {
                  player: { type: 'string', enum: ['A', 'B'] },
                  opponentOption: { type: 'number', description: '1 or 2: the opponent option held fixed.' },
                  bestOption: { type: 'number', description: '1 or 2: the option claimed better for this player.' },
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
            required: ['player', 'opponentOption', 'bestOption'],
            properties: {
              player: { type: 'string', enum: ['A', 'B'] },
              opponentOption: { type: 'number', description: '1 or 2: the opponent option held fixed.' },
              bestOption: { type: 'number', description: '1 or 2: the option claimed better for this player.' },
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
 * Identical for every model in the sweep — the rubric is part of the
 * measurement, so it must not vary by provider.
 */
const SYSTEM_PROMPT = `You are a game theorist explaining a 2x2 normal-form game to someone learning the subject.

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
- In an invented description, never characterize what happens when specific options meet in words alone ("pays off", "is punished", "works well"): any sentence about a particular action combination's outcome must state that cell's exact payoff numbers, and that cell must appear in cellCitations. If you prefer not to cite numbers, make no outcome claims — describe only who the players are and what their options mean.
- Declarations must match the text in BOTH directions, and you must re-read the description and prose sentence by sentence against your declarations before answering: an entry for a claim the text never makes is as fatal as a missing entry, so when a declaration has no sentence that states it, delete the declaration — do not keep it "to be safe".
- You are also given the GEOMETRY of the two expected-payoff surfaces the reader is looking at. Where it helps, describe the equilibrium in those terms: indifference is a level shelf where a surface stops tilting; the equilibrium is the joint flat spot where both surfaces are level at once; strategic interaction is the warp in the surface; a best response is which way a slice tilts. Use these ONLY where the supplied geometry says they apply — if it tells you there is no flat shelf, or no interior flat spot, or that the game is not zero-sum, do not describe one.
- Fill in geometryClaims to match what the supplied geometry states, and make sure your prose agrees with it. These are copied, not worked out: every one of them is stated for you above. If your explanation does not discuss the shape of the surfaces at all, set geometryClaims to null rather than guessing.
- Restate your prose's action-level claims in proseClaims so they can be checked. Every time the prose names which option a player uses at an equilibrium (including "plays X with probability 1"), add an equilibriumActions entry with that player and the option NUMBER the named label maps to — before writing it, verify the label against the coordinates you were given: x=1 means A plays Row 1, x=0 means Row 2; y=1 means B plays Col 1, y=0 means Col 2. Every "X does better against Y" claim goes in bestReplies, and a dominance claim is two entries (one per opposing option). Declare ONLY claims your prose actually states — do not add entries for comparisons the prose never makes, and before each entry re-check the direction against the matrix. A claim made in prose but missing here, or declared wrongly, causes the whole explanation to be withheld. If the prose makes no such claims, set proseClaims to null.`;

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
          const base = `  ${e.type} at x=${e.x}, y=${e.y} (payoffs A=${e.eA}, B=${e.eB})`;
          if (e.type === 'pure') {
            return `${base} — that is: A plays Row ${e.x === 1 ? 1 : 2}, B plays Col ${e.y === 1 ? 1 : 2}`;
          }
          const w = (p: number) => Number(p.toFixed(4));
          return `${base} — that is: A plays Row 1 with probability ${w(e.x)} and Row 2 with probability ${w(1 - e.x)}; `
            + `B plays Col 1 with probability ${w(e.y)} and Col 2 with probability ${w(1 - e.y)}`;
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
  opts: { model?: string; framingGuidance?: string; styleExemplars?: string[]; scenario?: Scenario } = {},
): Promise<GenerateResult> {
  const model = opts.model || DEFAULT_MODEL;

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
    SYSTEM_PROMPT,
    opts.framingGuidance ? `\n\n${opts.framingGuidance}` : '',
    exemplarBlock,
  ].join('');

  const res = await callProvider({
    model,
    systemPrompt,
    userPrompt: buildGroundingPayload(g, opts.scenario),
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
