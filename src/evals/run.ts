/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Report eval harness — sweeps models over the golden set and measures how
 * often the model's claims survive validation, plus latency and cost.
 *
 * SDK-BOUND — server/CLI only, never the browser graph (it imports report.ts).
 * Needs ANTHROPIC_API_KEY; every model call goes through generateReport, the
 * same entry point POST /api/report uses, so the eval measures what production
 * actually runs.
 *
 * Two env-selected modes:
 *   - SWEEP (default): all EVAL_MODELS, informational table, always exits 0.
 *   - GATE (EVAL_MODEL set): one model; exits non-zero if the consistency
 *     LOWER BOUND (min pass-rate across passes, not the mean) is below
 *     EVAL_MIN_CONSISTENCY. Gating on the mean is itself noisy.
 *
 * Env:
 *   EVAL_MODELS           csv, default haiku-4-5,sonnet-5,opus-5 (sweep)
 *   EVAL_MODEL            single model -> GATE mode (overrides EVAL_MODELS)
 *   EVAL_PASSES           default 3
 *   EVAL_MIN_CONSISTENCY  default 0.95, gate mode only
 *   EVAL_OUT              default ./eval-results.json
 */

import { writeFileSync } from 'fs';
import type Anthropic from '@anthropic-ai/sdk';
import { generateReport } from '../utils/report';
import { validateReport } from '../utils/nashValidator';
import { GOLDEN, assertCategories, type GoldenCategory } from './golden';
import type { MismatchKind } from '../types';

// ── Cost model ────────────────────────────────────────────────────────────────
// List prices per million tokens, pulled from the claude-api skill (verified
// 2026-08-09). RE-CHECK before quoting numbers: Sonnet 5 is on an intro rate
// ($2/$10) through 2026-08-31 that then reverts to $3/$15, and it WILL expire
// silently. Cache reads bill ~0.1x the input rate; cache-creation ~1.25x. The
// system prompt is cached, so ignoring cache tokens materially overstates cost.
const PRICE: Record<string, { in: number; out: number }> = {
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-sonnet-5': { in: 3, out: 15 }, // intro $2/$10 through 2026-08-31
  'claude-opus-5': { in: 5, out: 25 },
};
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 1.25;

function reportCost(model: string, usage: Anthropic.Usage | null): number | null {
  const p = PRICE[model];
  if (!p || !usage) return null;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const inputCost =
    (usage.input_tokens + cacheRead * CACHE_READ_MULT + cacheWrite * CACHE_WRITE_MULT) * p.in;
  const outputCost = usage.output_tokens * p.out;
  return (inputCost + outputCost) / 1e6;
}

// ── Records ────────────────────────────────────────────────────────────────────
interface PassRecord {
  model: string;
  game: string;
  category: GoldenCategory;
  pass: number;
  ok: boolean;
  latencyMs: number;
  costUsd: number | null;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  stopReason: string | null;
  failure: string | null;
  mismatchKinds: MismatchKind[];
}

const DEFAULT_MODELS = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5'];

function envInt(name: string, dflt: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

/** Runs `fn` over `items` with at most `concurrency` in flight at once. */
async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

async function runOne(model: string, game: (typeof GOLDEN)[number], pass: number): Promise<PassRecord> {
  const t0 = Date.now();
  const { report, usage, stopReason, failure } = await generateReport(game.payoffs, { model });
  const latencyMs = Date.now() - t0;

  // A refusal / max-tokens / unparseable is a FAILED pass, not a skipped one:
  // it's the deterministic-fallback path, and it belongs in the denominator.
  const validation = failure || !report ? null : validateReport(report, game.payoffs);
  const ok = validation?.ok ?? false;

  return {
    model,
    game: game.name,
    category: game.category,
    pass,
    ok,
    latencyMs,
    costUsd: reportCost(model, usage),
    inputTokens: usage ? usage.input_tokens : null,
    cacheReadTokens: usage ? usage.cache_read_input_tokens ?? 0 : null,
    stopReason,
    failure: failure ?? null,
    mismatchKinds: validation ? validation.mismatches.map((m) => m.kind) : [],
  };
}

// ── Aggregation ─────────────────────────────────────────────────────────────────
function pct(n: number, d: number): number {
  return d === 0 ? 0 : n / d;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

interface ModelAggregate {
  model: string;
  overall: number;
  passRates: number[];
  passRateMin: number;
  passRateMax: number;
  passRateStddev: number;
  byCategory: Record<string, number>;
  p50LatencyMs: number;
  p95LatencyMs: number;
  meanCostUsd: number | null;
  cacheHitRate: number | null;
  failureByStopReason: Record<string, number>;
  failureByMismatch: Record<string, number>;
  passes: number;
  games: number;
}

function aggregate(model: string, recs: PassRecord[], passes: number): ModelAggregate {
  const overall = pct(recs.filter((r) => r.ok).length, recs.length);

  // Per-pass consistency: fraction of games that passed within each pass.
  const passRates: number[] = [];
  for (let p = 1; p <= passes; p++) {
    const inPass = recs.filter((r) => r.pass === p);
    passRates.push(pct(inPass.filter((r) => r.ok).length, inPass.length));
  }

  const byCategory: Record<string, number> = {};
  for (const cat of new Set(recs.map((r) => r.category))) {
    const inCat = recs.filter((r) => r.category === cat);
    byCategory[cat] = pct(inCat.filter((r) => r.ok).length, inCat.length);
  }

  const latencies = recs.map((r) => r.latencyMs).sort((a, b) => a - b);
  const costs = recs.map((r) => r.costUsd).filter((c): c is number => c !== null);
  const cacheReads = recs.reduce((a, r) => a + (r.cacheReadTokens ?? 0), 0);
  const totalInput = recs.reduce((a, r) => a + (r.inputTokens ?? 0) + (r.cacheReadTokens ?? 0), 0);

  const failureByStopReason: Record<string, number> = {};
  const failureByMismatch: Record<string, number> = {};
  for (const r of recs) {
    if (r.failure) failureByStopReason[r.failure] = (failureByStopReason[r.failure] ?? 0) + 1;
    for (const k of r.mismatchKinds) failureByMismatch[k] = (failureByMismatch[k] ?? 0) + 1;
  }

  return {
    model,
    overall,
    passRates,
    passRateMin: Math.min(...passRates),
    passRateMax: Math.max(...passRates),
    passRateStddev: stddev(passRates),
    byCategory,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    meanCostUsd: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null,
    cacheHitRate: totalInput ? cacheReads / totalInput : null,
    failureByStopReason,
    failureByMismatch,
    passes,
    games: GOLDEN.length,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const gateModel = process.env.EVAL_MODEL;
  const models = gateModel
    ? [gateModel]
    : (process.env.EVAL_MODELS || DEFAULT_MODELS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  const passes = envInt('EVAL_PASSES', 3);
  const minConsistency = process.env.EVAL_MIN_CONSISTENCY ? Number(process.env.EVAL_MIN_CONSISTENCY) : 0.95;
  const outPath = process.env.EVAL_OUT || './eval-results.json';

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set — the eval needs a real key. Aborting.');
    process.exit(2);
  }

  // Fail loudly if a golden game no longer exhibits its category.
  const violations = assertCategories();
  if (violations.length) {
    console.error('Golden-set category check FAILED:');
    for (const v of violations) console.error('  ' + v);
    process.exit(2);
  }

  console.log('='.repeat(72));
  console.log(`Nash report eval  ${gateModel ? '[GATE]' : '[SWEEP]'}`);
  console.log(`date=${new Date().toISOString()}  golden=${GOLDEN.length} games  passes=${passes}`);
  console.log(`models=${models.join(', ')}`);
  console.log('='.repeat(72));

  const allRecords: PassRecord[] = [];
  const aggregates: ModelAggregate[] = [];

  for (const model of models) {
    const tasks: { game: (typeof GOLDEN)[number]; pass: number }[] = [];
    for (const game of GOLDEN) for (let p = 1; p <= passes; p++) tasks.push({ game, pass: p });

    const modelRecs: PassRecord[] = [];
    // Warm the cache with ONE serial call first: a prompt-cache entry is only
    // readable once the first response starts streaming, so firing everything in
    // parallel would make every request miss the cache. After that, fan out at
    // ~4 concurrent. Do NOT "optimize" this back to a single parallel map.
    if (tasks.length) {
      modelRecs.push(await runOne(model, tasks[0].game, tasks[0].pass));
    }
    await pool(tasks.slice(1), 4, async (t) => {
      modelRecs.push(await runOne(model, t.game, t.pass));
    });

    allRecords.push(...modelRecs);
    const agg = aggregate(model, modelRecs, passes);
    aggregates.push(agg);

    console.log(`\n### ${model}`);
    console.log(
      `overall consistency: ${(agg.overall * 100).toFixed(1)}%  ` +
        `(per-pass ${(agg.passRateMin * 100).toFixed(1)}–${(agg.passRateMax * 100).toFixed(1)}%, ` +
        `sd ${(agg.passRateStddev * 100).toFixed(1)}pp)`,
    );
    console.log(
      `latency p50/p95: ${agg.p50LatencyMs}/${agg.p95LatencyMs} ms  ` +
        `mean cost/report: ${agg.meanCostUsd === null ? 'n/a' : '$' + agg.meanCostUsd.toFixed(5)}  ` +
        `cache-hit: ${agg.cacheHitRate === null ? 'n/a' : (agg.cacheHitRate * 100).toFixed(0) + '%'}`,
    );
    console.table(
      Object.fromEntries(
        Object.entries(agg.byCategory).map(([c, r]) => [c, { consistency: (r * 100).toFixed(1) + '%' }]),
      ),
    );
    if (Object.keys(agg.failureByStopReason).length)
      console.log('  failures by stop/failure reason:', agg.failureByStopReason);
    if (Object.keys(agg.failureByMismatch).length)
      console.log('  failures by mismatch kind:', agg.failureByMismatch);
  }

  writeFileSync(
    outPath,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), goldenSize: GOLDEN.length, passes, aggregates, records: allRecords },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${allRecords.length} pass records to ${outPath}`);

  if (gateModel) {
    const agg = aggregates[0];
    const lowerBound = agg.passRateMin; // never the mean — a gate on the mean is noisy
    console.log(
      `\nGATE: ${gateModel} lower-bound consistency ${(lowerBound * 100).toFixed(1)}% ` +
        `vs floor ${(minConsistency * 100).toFixed(1)}%`,
    );
    if (lowerBound < minConsistency) {
      console.error('GATE FAILED');
      process.exit(1);
    }
    console.log('GATE PASSED');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
