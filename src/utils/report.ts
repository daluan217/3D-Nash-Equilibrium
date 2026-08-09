/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Generates a natural-language game analysis, grounded in the solver.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ SDK-BOUND MODULE — SERVER AND EVAL HARNESS ONLY.                 │
 * │ Never import this from the App.tsx graph. It pulls in the        │
 * │ Anthropic SDK, which would break the browser build and ship a    │
 * │ server-side client (and its key handling) to the client.         │
 * │ The pure counterpart is nashValidator.ts, which anyone may use.  │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * Division of labour: the solver computes, the model explains. The model is
 * never asked to derive an equilibrium — it receives them and writes prose.
 * Whatever it claims is then checked against ground truth by nashValidator.
 *
 * The model is a parameter, not a constant, because model choice is an output
 * of the eval harness rather than an input to it. The harness sweeps models and
 * reports consistency, latency, and cost; the default here is only a default.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { GamePayoffs, LlmReport } from '../types';
import { computeAllNE, computeIndifference } from './gameEngine';

/** Overridden per-request by the eval sweep; see src/evals/. */
export const DEFAULT_MODEL = process.env.REPORT_MODEL || 'claude-haiku-4-5';

/**
 * Structured-output schema. Constrains SHAPE only.
 *
 * Numeric constraints (minimum/maximum) are not supported by structured
 * outputs, so "x is a probability" cannot be expressed here — nashValidator
 * range-checks instead. Every object needs additionalProperties: false.
 */
const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['claimedEquilibria', 'prose'],
  properties: {
    claimedEquilibria: {
      type: 'array',
      description:
        'Every equilibrium of this game. Use "continuum" when a player is ' +
        'indifferent and a whole line or region is in equilibrium; give any ' +
        'representative point for x and y in that case.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'x', 'y'],
        properties: {
          type: { type: 'string', enum: ['pure', 'mixed', 'continuum'] },
          x: { type: 'number', description: "Player A's probability of Row 1, 0 to 1." },
          y: { type: 'number', description: "Player B's probability of Column 1, 0 to 1." },
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
} as const;

/**
 * Stable across every request, so it earns a cache breakpoint. Sized past the
 * 1024-token minimum that the smaller models need — Opus 5 caches from 512,
 * but a rubric that only cached on one model in a three-model sweep would make
 * the cost column incomparable.
 */
const SYSTEM_PROMPT = `You are a game theorist explaining a 2x2 normal-form game to someone learning the subject.

You will be given a payoff matrix AND the equilibria, already computed exactly by a solver. Your job is to EXPLAIN, never to derive.

Rules:
- Report exactly the equilibria you are given. Do not add, drop, merge, or recompute any of them. If the solver reports one equilibrium, report one.
- Copy the coordinates verbatim. Do not round, rescale, or "correct" them.
- When you are told the game is degenerate (a player is indifferent, so a whole line or region is in equilibrium), label those claims "continuum" and give any representative point inside the region.
- The prose should say what the players are actually trading off, in the terms of the game itself. Prefer "A gains nothing by switching once B mixes at these odds" over restating the definition of Nash equilibrium.
- Write for a reader who knows what a payoff matrix is and does not yet have intuition for mixed strategies. Two to four sentences. Plain prose, no markdown, no headings, no LaTeX.
- Never claim an equilibrium exists that you were not given, and never describe a pure equilibrium in a game that has none. If the solver found no pure equilibria, say plainly that the game has none and explain why the players must mix.`;

/** Everything the model is allowed to know. Ground truth, nothing else. */
export function buildGroundingPayload(g: GamePayoffs): string {
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
    return [
      ...matrix,
      '',
      `This game is DEGENERATE: ${region}.`,
      'There is a continuum of equilibria, not a finite list. Report it as a SINGLE',
      'claim of type "continuum", using any one representative point that is in',
      `equilibrium. These enumerated points are all valid choices: ${validPoints}.`,
      'Do NOT list the corners as separate pure equilibria — collapse them into one',
      '"continuum" claim.',
    ].join('\n');
  }

  return [
    ...matrix,
    '',
    'Solver output (authoritative — x is A\'s probability of Row 1, y is B\'s probability of Col 1):',
    equilibria.length
      ? equilibria.map((e) => `  ${e.type} at x=${e.x}, y=${e.y} (payoffs A=${e.eA}, B=${e.eB})`).join('\n')
      : '  none enumerated',
    '',
    'This game is not degenerate; the solver output above is complete.',
  ].join('\n');
}

export interface GenerateResult {
  report: LlmReport | null;
  raw: string | null;
  stopReason: string | null;
  usage: Anthropic.Usage | null;
  /** Set when no report was produced — distinguishes a refusal from a crash. */
  failure: 'refusal' | 'max-tokens' | 'unparseable' | 'error' | null;
}

/**
 * One shared entry point for both POST /api/report and the eval sweep. If these
 * ever diverge the eval stops measuring what production actually runs.
 *
 * Note the absence of temperature/top_p/top_k: they are rejected outright on
 * claude-opus-5 and claude-sonnet-5, and setting them only on the models that
 * still accept them would make those models' numbers incomparable in a sweep.
 */
export async function generateReport(
  g: GamePayoffs,
  opts: { model?: string; client?: Anthropic } = {},
): Promise<GenerateResult> {
  const model = opts.model || DEFAULT_MODEL;
  const client = opts.client || new Anthropic();

  let message: Anthropic.Message;
  try {
    message = await client.messages.create({
      model,
      // Roomy: on models where thinking is on by default it shares this budget
      // with the response, and a truncated report is unparseable JSON.
      max_tokens: 4096,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      output_config: { format: { type: 'json_schema', schema: REPORT_SCHEMA } },
      messages: [{ role: 'user', content: buildGroundingPayload(g) }],
    });
  } catch {
    return { report: null, raw: null, stopReason: null, usage: null, failure: 'error' };
  }

  const usage = message.usage ?? null;

  // Check stop_reason BEFORE reading content: on a refusal content is empty or
  // partial, and on max_tokens the JSON is truncated and will not parse.
  if (message.stop_reason === 'refusal') {
    return { report: null, raw: null, stopReason: 'refusal', usage, failure: 'refusal' };
  }

  const text = message.content.find((b) => b.type === 'text')?.text ?? null;

  if (message.stop_reason === 'max_tokens') {
    return { report: null, raw: text, stopReason: 'max_tokens', usage, failure: 'max-tokens' };
  }

  if (!text) {
    return { report: null, raw: null, stopReason: message.stop_reason, usage, failure: 'unparseable' };
  }

  try {
    return {
      report: JSON.parse(text) as LlmReport,
      raw: text,
      stopReason: message.stop_reason,
      usage,
      failure: null,
    };
  } catch {
    return { report: null, raw: text, stopReason: message.stop_reason, usage, failure: 'unparseable' };
  }
}
