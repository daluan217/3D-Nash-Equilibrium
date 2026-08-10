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
import { callProvider, hasCredentials, type NormalizedUsage, type ProviderFailure } from './providers';

/** Overridden per-request by the eval sweep; see src/evals/. */
export const DEFAULT_MODEL = process.env.REPORT_MODEL || 'gemini-3.5-flash-lite';

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
};

/**
 * Identical for every model in the sweep — the rubric is part of the
 * measurement, so it must not vary by provider.
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
  opts: { model?: string } = {},
): Promise<GenerateResult> {
  const model = opts.model || DEFAULT_MODEL;

  const res = await callProvider({
    model,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildGroundingPayload(g),
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
