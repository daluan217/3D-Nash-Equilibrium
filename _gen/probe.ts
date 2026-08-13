/**
 * Randomized general-form golden set.
 *
 * WHY THIS EXISTS: every earlier play-probe game shared one template,
 * A = [[k,0],[0,1]], whose answer is always 1/(k+1). gemini-3.5-flash-lite
 * scored 61/61 on that set and 1/4 on general-form games — so the earlier
 * "gemini reasons about equilibria" conclusion was measuring template recall.
 * Varying k while holding the template fixed could never have detected this.
 *
 * THREE ARMS, run under identical conditions so the comparison is clean:
 *   TEMPLATE      A = [[k,0],[0,1]]        — the old set (recall-friendly)
 *   GENERAL-ROUND all cells non-zero, x* lands on a round value
 *   GENERAL-UGLY  all cells non-zero, x* is an awkward fraction
 *
 * That separates two confounded explanations: is it the MATRIX SHAPE that
 * models key on, or merely that round answers are easier to produce?
 *
 * METRIC NOTE: the earlier probe normalised guaranteed value by the NE value,
 * which printed -1150% when a strategy earned negative payoff. Here the primary
 * metric is the EXPLOITABILITY GAP (neValue - guaranteed), which is >= 0 by
 * construction, reported in payoff units and as a fraction of the payoff range.
 * No division by a possibly-negative quantity.
 */
import 'dotenv/config';
import { callProvider, type ReasoningEffort } from '../src/utils/providers';
import { computeAllNE } from '../src/utils/gameEngine';
import type { GamePayoffs } from '../src/types';

type Mat = number[][]; // A[row][col], row player's payoff; zero-sum so B = -A

interface Game { name: string; arm: 'TEMPLATE' | 'GENERAL-ROUND' | 'GENERAL-UGLY'; A: Mat; xStar: number; value: number }

/** x* making the COLUMN player indifferent, for zero-sum A. */
const xStarOf = (A: Mat) => (A[1][1] - A[1][0]) / (A[0][0] - A[0][1] - A[1][0] + A[1][1]);
/** Row player's payoff if the opponent best-responds to mix x. */
const guaranteed = (A: Mat, x: number) =>
  Math.min(A[0][0] * x + A[1][0] * (1 - x), A[0][1] * x + A[1][1] * (1 - x));
const rangeOf = (A: Mat) => Math.max(...A.flat()) - Math.min(...A.flat());

/** Cross-check against the shipped, fuzz-tested 2x2 solver. */
function agreesWithShippedSolver(A: Mat, xStar: number): boolean {
  const g: GamePayoffs = {
    a11: A[0][0], a12: A[0][1], a21: A[1][0], a22: A[1][1],
    b11: -A[0][0], b12: -A[0][1], b21: -A[1][0], b22: -A[1][1],
  };
  const ne = computeAllNE(g);
  const mixed = ne.find((n) => n.type === 'mixed');
  // must be a MIXED-only game (no saddle point) and the coordinate must match
  return !!mixed && ne.every((n) => n.type === 'mixed') && Math.abs(mixed.x - xStar) < 0.0025;
}

/** Round = lands on a 0.05 grid (0.5, 0.6, 0.75...). Everything else is ugly. */
const isRound = (x: number) => Math.abs(x * 20 - Math.round(x * 20)) < 1e-6;

function buildSet(): Game[] {
  const games: Game[] = [];

  // Arm 1 — the old template, as an internal control.
  for (const k of [2, 5, 10]) {
    const A: Mat = [[k, 0], [0, 1]];
    games.push({ name: `template-${k}to1`, arm: 'TEMPLATE', A, xStar: xStarOf(A), value: guaranteed(A, xStarOf(A)) });
  }

  // Arms 2 & 3 — randomised general form, deterministic seed for reproducibility.
  let seed = Number(process.env.GEN_SEED || 20260810);
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ri = () => { let v = 0; while (v === 0) v = Math.round(-9 + rnd() * 18); return v; }; // non-zero

  let round = 0, ugly = 0;
  for (let guard = 0; guard < 200000 && (round < 5 || ugly < 5); guard++) {
    const A: Mat = [[ri(), ri()], [ri(), ri()]];
    const denom = A[0][0] - A[0][1] - A[1][0] + A[1][1];
    if (Math.abs(denom) < 1e-9) continue;
    const x = xStarOf(A);
    if (!(x > 0.05 && x < 0.95)) continue;            // avoid near-degenerate edges
    if (!agreesWithShippedSolver(A, x)) continue;      // must be a genuine mixed-only game
    const r = isRound(x);
    if (r && round < 5) { games.push({ name: `gen-round-${round + 1}`, arm: 'GENERAL-ROUND', A, xStar: x, value: guaranteed(A, x) }); round++; }
    else if (!r && ugly < 5) { games.push({ name: `gen-ugly-${ugly + 1}`, arm: 'GENERAL-UGLY', A, xStar: x, value: guaranteed(A, x) }); ugly++; }
  }
  return games;
}

/**
 * The output shape is stated in the PROMPT, not left to the schema alone.
 *
 * Phi-4 rejects `response_format: json_schema` and only accepts `json_object`,
 * which does not carry the schema — so it never saw the field name and answered
 * `[1]`, scoring as no-data on all 13 games. Restating the shape in the system
 * prompt is applied to EVERY model so conditions stay uniform, rather than
 * special-casing the one model that needed it.
 */
const SYS_BASE = `You are playing a two-player simultaneous game as the ROW player.
Choose the strategy that is optimal for you.
Report the probability you place on Row 1 (a number from 0 to 1).`;

/**
 * ANSWER CHANNEL.
 *
 * 'number' was the original shape and it silently corrupts models that want to
 * answer with an exact fraction: DeepSeek-V4-Pro returned 14.19 for x*=14/19 and
 * 7.17 for 7/17 — the correct fraction with the slash flattened into a decimal
 * point, which then scored as wrong and blew the exploitability metric up to
 * 1.4e20. That is a measurement artifact, not a model error.
 *
 * 'string' accepts a decimal OR an exact fraction, so a model that reasons in
 * rationals can say so. Changing the channel changes the request shape, so any
 * model compared across channels must be re-run — see the channel-equivalence
 * control in the writeup.
 */
const ANSWER_FORMAT = process.env.GEN_ANSWER_FORMAT === 'string' ? 'string' : 'number';

const SCHEMA: Record<string, unknown> = ANSWER_FORMAT === 'string'
  ? {
      type: 'object', required: ['probabilityRow1'],
      properties: {
        probabilityRow1: {
          type: 'string',
          description: 'Probability of Row 1, between 0 and 1. Either a decimal (e.g. "0.4118") or an exact fraction (e.g. "7/17").',
        },
      },
    }
  : {
      type: 'object', required: ['probabilityRow1'],
      properties: { probabilityRow1: { type: 'number', description: 'Probability of Row 1, 0 to 1.' } },
    };

/**
 * Parse an answer into a probability, or null if it is not one.
 *
 * Deliberately does NOT try to rescue the mangled 'a.b' form from the number
 * channel: 14.19 could be 14/19 or a malformed 0.1419, and guessing would
 * manufacture data. The fix is to give the model a channel that can express a
 * fraction, not to reverse-engineer a corrupted one.
 */
function parseAnswer(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : null;
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const frac = /^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/.exec(s);
  const v = frac ? Number(frac[1]) / Number(frac[2]) : Number(s);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

const SYS = `${SYS_BASE}
Respond with JSON only, exactly: {"probabilityRow1": ${ANSWER_FORMAT === 'string'
  ? '"<value>"} where <value> is a decimal such as "0.4118" or an exact fraction such as "7/17"'
  : '<value>} where <value> is a decimal number between 0 and 1'}.`;

/**
 * PROMPT STRUCTURE is a experimental factor, not a fixed choice.
 *
 * 'enumerated' spells out all four payoff cells on their own lines. 'terse'
 * gives the same game as one bracketed matrix. The two carry IDENTICAL
 * information — the only difference is how much of the setup work is done for
 * the model rather than by it.
 *
 * This exists because gpt-5.6-sol-1 with reasoning fully disabled scores 100%
 * on the enumerated prompt but answered 0.35 (true 0.4118) on the terse one.
 * That suggests input structure and inference-time reasoning are substitutable
 * levers, which is testable as a grid.
 */
const PROMPT_MODE = process.env.GEN_PROMPT === 'terse' ? 'terse' : 'enumerated';

const promptEnumerated = (A: Mat) => [
  'Payoffs (your payoff, opponent payoff). This is a strictly competitive game.',
  `  You Row 1, opponent Col 1 -> (${A[0][0]}, ${-A[0][0]})`,
  `  You Row 1, opponent Col 2 -> (${A[0][1]}, ${-A[0][1]})`,
  `  You Row 2, opponent Col 1 -> (${A[1][0]}, ${-A[1][0]})`,
  `  You Row 2, opponent Col 2 -> (${A[1][1]}, ${-A[1][1]})`,
].join('\n');

const promptTerse = (A: Mat) =>
  `A zero-sum game has row-player payoffs [[${A[0][0]},${A[0][1]}],[${A[1][0]},${A[1][1]}]]. You are the row player.`;

const prompt = (A: Mat) => (PROMPT_MODE === 'terse' ? promptTerse(A) : promptEnumerated(A));

/**
 * GEN_REASONING selects the thinking level for the whole sweep. Unset = each
 * provider's default, which is what the first sweep measured. Per-model override
 * (GEN_REASONING_<model>) exists because the levels are NOT equivalent across
 * families — DeepSeek returns degenerate JSON at 'high' but answers correctly at
 * 'low', so forcing one level everywhere would measure a formatting failure
 * rather than reasoning ability.
 */
function reasoningFor(model: string): ReasoningEffort | undefined {
  const raw = process.env[`GEN_REASONING_${model}`] ?? process.env.GEN_REASONING;
  const ok = ['none', 'low', 'medium', 'high', 'xhigh'];
  return ok.includes(raw ?? '') ? (raw as ReasoningEffort) : undefined;
}

interface Answer { v: number | null; outTokens: number; reasonTokens: number }

async function ask(model: string, A: Mat): Promise<Answer> {
  for (let a = 0; a < 5; a++) {
    const r = await callProvider({
      model, systemPrompt: SYS, userPrompt: prompt(A), schema: SCHEMA,
      maxOutputTokens: 8192, reasoning: reasoningFor(model),
    });
    if (r.failure === 'rate-limited') { await new Promise((z) => setTimeout(z, 1500 * 2 ** a)); continue; }
    // Billed output = visible completion + thinking. Both are charged at the
    // output rate on every provider, so they are summed for the cost column.
    const outTokens = r.usage?.outputTokens ?? 0;
    const reasonTokens = r.usage?.reasoningTokens ?? 0;
    if (!r.text) return { v: null, outTokens, reasonTokens };
    try { return { v: parseAnswer(JSON.parse(r.text).probabilityRow1), outTokens, reasonTokens }; }
    catch { return { v: null, outTokens, reasonTokens }; }
  }
  return { v: null, outTokens: 0, reasonTokens: 0 };
}

const MODELS = (process.env.GEN_MODELS || 'gemini-3.5-flash-lite,gpt-5.4-nano,DeepSeek-V4-Flash,claude-haiku-4-5').split(',');
const PASSES = Number(process.env.GEN_N || 6);
const TOL = 0.02;

(async () => {
  const games = buildSet();
  console.log('GOLDEN SET (ground truth cross-checked against the shipped fuzz-tested solver)\n');
  for (const g of games) {
    console.log(`  ${g.name.padEnd(16)} ${g.arm.padEnd(14)} A=[[${g.A[0]}],[${g.A[1]}]]  x*=${g.xStar.toFixed(4)}  value=${g.value.toFixed(3)}`);
  }
  console.log(`\nmodels=${MODELS.join(', ')}   passes=${PASSES}   reasoning=${process.env.GEN_REASONING ?? 'default'}   answer=${ANSWER_FORMAT}   prompt=${PROMPT_MODE}\n`);

  for (const model of MODELS) {
    console.log(`### ${model}`);
    const byArm: Record<string, { ok: number; n: number; gap: number[] }> = {};
    // Billed output tokens (visible + thinking) so the accuracy gain from a
    // structural change can be priced against the gain from reasoning tokens.
    let tokOut = 0, tokReason = 0, tokCalls = 0;
    for (const g of games) {
      const picks: number[] = [];
      for (let p = 0; p < PASSES; p++) {
        const a = await ask(model, g.A);
        tokOut += a.outTokens; tokReason += a.reasonTokens; tokCalls += 1;
        if (a.v !== null) picks.push(a.v);
      }
      if (!picks.length) { console.log(`  ${g.name.padEnd(16)} (no data)`); continue; }
      const ok = picks.filter((x) => Math.abs(x - g.xStar) <= TOL).length;
      // exploitability gap: how much value the opponent's best response takes
      // from you relative to equilibrium play. >= 0 always.
      const gaps = picks.map((x) => g.value - guaranteed(g.A, x));
      const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const pctRange = (meanGap / rangeOf(g.A)) * 100;
      byArm[g.arm] ??= { ok: 0, n: 0, gap: [] };
      byArm[g.arm].ok += ok; byArm[g.arm].n += picks.length; byArm[g.arm].gap.push(...gaps);
      console.log(
        `  ${g.name.padEnd(16)} x*=${g.xStar.toFixed(3)}  correct ${ok}/${picks.length}  ` +
        `meanGap=${meanGap.toFixed(2)} (${pctRange.toFixed(0)}% of range)  picks=[${picks.map((v) => v.toFixed(2)).join(' ')}]`,
      );
    }
    console.log('  --- by arm ---');
    for (const arm of ['TEMPLATE', 'GENERAL-ROUND', 'GENERAL-UGLY']) {
      const a = byArm[arm];
      if (!a) continue;
      const mg = a.gap.reduce((x, y) => x + y, 0) / a.gap.length;
      console.log(`  ${arm.padEnd(14)} correct ${a.ok}/${a.n} = ${((a.ok / a.n) * 100).toFixed(0)}%   mean exploitability gap ${mg.toFixed(2)}`);
    }
    console.log(
      `  COST  mean billed output ${(tokOut / Math.max(1, tokCalls)).toFixed(1)} tok/call ` +
      `(of which thinking ${(tokReason / Math.max(1, tokCalls)).toFixed(1)})  over ${tokCalls} calls`,
    );
    console.log('');
  }
})();
