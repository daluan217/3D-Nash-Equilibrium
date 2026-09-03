/**
 * PILOT for the new OpenRouter route (src/utils/providers.ts, `openrouter`
 * provider, models named `openrouter/<catalog-id>`).
 *
 * Goes through the REAL `generateScenario` path (schema, gates, the shipping
 * system prompt) — never a hand-rolled fetch, per the
 * verify-generated-text-by-backparsing / "a harness that does not go through
 * generateScenario is not measuring the product" lesson in CLAUDE.md.
 *
 * REPORT_MODEL is pinned (both via env, so DEFAULT_MODEL matches too, and via
 * the explicit `model` option) and NO `reasoning` level is requested, to match
 * what production actually runs (no REPORT_REASONING in the deploy manifest ->
 * provider default -> thinking ON where the model has it). CLAUDE.md already
 * records the expected outcome for these two exact models over AgentRouter —
 * this pilot exists to confirm it holds through the NEW route rather than to
 * fix it: deepseek-v4-flash spends its whole 16,384-token budget thinking and
 * returns nothing, glm-5.3 the same, and glm-5.3 rejects every disable-thinking
 * request shape with a 400. If that reproduces here, the correct report is
 * "reachable and unusable", not a rewrite.
 *
 * Model ids come from the account's actual /models catalog (fetched directly,
 * once, not through this script) — NOT the openrouter.ai naming convention the
 * task brief guessed at. This relay is flat-catalog: `deepseek-v4-flash` and
 * `glm-5.3`, no vendor/ prefix.
 *
 * Cost: 5 calls x 2 models = 10 calls total, one small game, pennies.
 */
import 'dotenv/config';
import { generateScenario } from '../src/utils/report';
import type { GamePayoffs } from '../src/types';

const N = Number(process.env.PILOT_N || 5);
const MODELS = process.env.PILOT_MODELS
  ? process.env.PILOT_MODELS.split(',').map((m) => m.trim()).filter(Boolean)
  : ['openrouter/deepseek-v4-flash', 'openrouter/glm-5.3'];

// Battle-of-the-Sexes shape: small, well-known, exercises a real mixed-NE
// grounding payload without needing a bespoke fixture.
const GAME: GamePayoffs = { a11: 2, a12: 0, a21: 0, a22: 1, b11: 1, b12: 0, b21: 0, b22: 2 };

interface Row {
  model: string; i: number; ms: number; failure: string | null;
  finishLike: string; outputTokens: number | null; reasoningTokens: number | null;
  parsed: boolean; name: string | null;
}

async function runModel(model: string): Promise<Row[]> {
  // Pin REPORT_MODEL too (not just the explicit `model` opt) so anything that
  // reads DEFAULT_MODEL downstream sees the same pinned model — the CLAUDE.md
  // "REPORT_MODEL — the model" gotcha exists for exactly this reason.
  process.env.REPORT_MODEL = model;
  const rows: Row[] = [];
  for (let i = 0; i < N; i++) {
    const t0 = Date.now();
    let r: Awaited<ReturnType<typeof generateScenario>>;
    try {
      // No `reasoning` passed — matches production, which passes none. No
      // `extraBody` disable knob either: this is the PRODUCTION-shaped call,
      // and CLAUDE.md is explicit that post-hoc rewriting a defective result
      // is out of bounds. If either model needs the knob to be usable at all,
      // that itself is the finding.
      r = await generateScenario(GAME, { model });
    } catch (e) {
      r = { scenario: null, failure: `throw: ${String(e)}` as never, usage: null };
    }
    const ms = Date.now() - t0;
    const failure = r.failure ?? null;
    const finishLike = failure ?? 'stop';
    rows.push({
      model, i, ms, failure,
      finishLike,
      outputTokens: r.usage?.outputTokens ?? null,
      reasoningTokens: r.usage?.reasoningTokens ?? null,
      parsed: !!r.scenario,
      name: r.scenario?.name ?? null,
    });
    process.stdout.write(r.scenario ? '.' : 'x');
  }
  process.stdout.write('\n');
  return rows;
}

async function main() {
  const all: Row[] = [];
  for (const model of MODELS) {
    console.log(`\n=== ${model} (${N} calls) ===`);
    all.push(...(await runModel(model)));
  }

  console.log('\nmodel | i | ms | parsed | failure | finish-like | out-tok | reasoning-tok | name');
  console.log('-'.repeat(110));
  for (const r of all) {
    console.log(
      `${r.model} | ${r.i} | ${r.ms} | ${r.parsed} | ${r.failure ?? '-'} | ${r.finishLike} | ` +
      `${r.outputTokens ?? '-'} | ${r.reasoningTokens ?? '-'} | ${r.name ?? '-'}`,
    );
  }

  console.log('\n=== summary per model ===');
  for (const model of MODELS) {
    const rs = all.filter((r) => r.model === model);
    const parsed = rs.filter((r) => r.parsed).length;
    const msArr = rs.map((r) => r.ms).sort((a, b) => a - b);
    const p50 = msArr[Math.floor(msArr.length / 2)];
    const failures = rs.map((r) => r.failure).filter(Boolean);
    const reasoningSum = rs.reduce((s, r) => s + (r.reasoningTokens ?? 0), 0);
    console.log(
      `${model}: ${parsed}/${rs.length} parsed, p50 ${p50}ms, ` +
      `failures=[${failures.join(',') || 'none'}], total reasoning tokens=${reasoningSum}`,
    );
  }
}

main();
