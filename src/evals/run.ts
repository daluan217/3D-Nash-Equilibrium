/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Report eval harness — sweeps models over the golden set and measures how
 * often the model's claims survive validation, plus latency and cost.
 *
 * SDK-BOUND — server/CLI only, never the browser graph (it imports report.ts).
 * Needs GEMINI_API_KEY; every model call goes through generateReport, the same
 * entry point POST /api/report uses, so the eval measures what production runs.
 *
 * Two env-selected modes:
 *   - SWEEP (default): all EVAL_MODELS, informational table, always exits 0.
 *   - GATE (EVAL_MODEL set): one model; exits non-zero if the consistency
 *     LOWER BOUND (min pass-rate across passes, not the mean) is below
 *     EVAL_MIN_CONSISTENCY. Gating on the mean is itself noisy.
 *
 * Env:
 *   EVAL_MODELS           csv, default gemini 2.5 flash-lite,flash,pro (sweep)
 *   EVAL_MODEL            single model -> GATE mode (overrides EVAL_MODELS)
 *   EVAL_PASSES           default 3
 *   EVAL_MIN_CONSISTENCY  default 0.95, gate mode only
 *   EVAL_OUT              default ./eval-results.json
 */

// Loads .env so provider credentials resolve without shell exports — some key
// names (e.g. GPT-5.4-NANO_AZURE_FOUNDRY_API_KEY) aren't valid shell
// identifiers and cannot be `export`ed at all.
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { generateReport, hasCredentials } from '../utils/report';
import { resolveProvider, type NormalizedUsage } from '../utils/providers';
import { validateReport } from '../utils/nashValidator';
import { GOLDEN, assertCategories, type GoldenCategory } from './golden';
import type { MismatchKind } from '../types';

// ── Cost model ────────────────────────────────────────────────────────────────
// List prices per MILLION tokens. RE-CHECK before quoting any cost number —
// these move fast and a stale rate silently corrupts the cost column.
//   Gemini: Google pricing, verified 2026-08-10.
//   Foundry: keyed by DEPLOYMENT name (what we called it at deploy time), not
//   the catalog id, because that is what the API bills against.
// Reasoning/thinking tokens bill at the OUTPUT rate on every provider, and
// promptTokens already INCLUDES the cached subset, so uncached = prompt - cached.
// A model with no entry reports cost `n/a` rather than a fabricated number.
const PRICE: Record<string, { in: number; out: number; cacheMult: number }> = {
  'gemini-3.5-flash-lite': { in: 0.3, out: 2.5, cacheMult: 0.1 },
  'gemini-3.5-flash': { in: 0.75, out: 4.5, cacheMult: 0.1 },
  'gemini-3.6-flash': { in: 1.5, out: 7.5, cacheMult: 0.1 },
  // Foundry deployment of gpt-5.4-nano. Rate is OpenAI's published list price;
  // Azure's own list can differ per region and this is billed against Azure, so
  // treat the cost column for this row as approximate until reconciled against
  // an actual Azure invoice.
  'gpt-5.4-nano': { in: 0.2, out: 1.25, cacheMult: 0.1 },
};

function reportCost(model: string, usage: NormalizedUsage | null): number | null {
  const p = PRICE[model];
  if (!p || !usage) return null;
  const uncached = Math.max(0, usage.promptTokens - usage.cachedTokens);
  const output = usage.outputTokens + usage.reasoningTokens;
  const inputCost = (uncached + usage.cachedTokens * p.cacheMult) * p.in;
  return (inputCost + output * p.out) / 1e6;
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

// The flash family this key can actually reach: 2.5 is deprecated for new users
// and the pro tier is quota-gated (429) on a free key. Add gemini-*-pro via
// EVAL_MODELS once the key has pro quota.
const DEFAULT_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash'];

function envInt(name: string, dflt: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const maxRetries = envInt('EVAL_MAX_RETRIES', 5);
  // Retry only the transient 'rate-limited' failure, with exponential backoff.
  // A refusal / max-tokens / unparseable is NOT retried — it's the real
  // deterministic-fallback path and belongs in the denominator as a failed pass.
  let res!: Awaited<ReturnType<typeof generateReport>>;
  let latencyMs = 0;
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    res = await generateReport(game.payoffs, { model });
    latencyMs = Date.now() - t0;
    if (res.failure !== 'rate-limited' || attempt >= maxRetries) break;
    await sleep(Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500);
  }
  const { report, usage, stopReason, failure } = res;

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
    // promptTokens is the FULL input incl. cached; cachedTokens is the cached
    // subset of it (so they are not additive — see aggregate()).
    inputTokens: usage ? usage.promptTokens : null,
    cacheReadTokens: usage ? usage.cachedTokens : null,
    stopReason,
    failure: failure ?? null,
    mismatchKinds: validation ? validation.mismatches.map((m) => m.kind) : [],
  };
}

// ── Aggregation ─────────────────────────────────────────────────────────────────
// null means "no counted passes" (e.g. every pass in this cell stayed
// rate-limited after retries) — NOT "0% consistency". Collapsing those two
// into a bare 0 would silently misreport a measurement gap as a real failure,
// which is exactly the class of bug this harness exists to catch.
function pct(n: number, d: number): number | null {
  return d === 0 ? null : n / d;
}

function fmtPct(p: number | null): string {
  return p === null ? 'n/a' : (p * 100).toFixed(1) + '%';
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function stddev(xsIn: (number | null)[]): number {
  const xs = xsIn.filter((x): x is number => x !== null);
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

interface ModelAggregate {
  model: string;
  /** null iff every pass was rate-limited (no measurement, not a 0% score). */
  overall: number | null;
  passRates: (number | null)[];
  passRateMin: number | null;
  passRateMax: number | null;
  passRateStddev: number;
  byCategory: Record<string, number | null>;
  p50LatencyMs: number;
  p95LatencyMs: number;
  meanCostUsd: number | null;
  cacheHitRate: number | null;
  failureByStopReason: Record<string, number>;
  failureByMismatch: Record<string, number>;
  /** Passes that stayed rate-limited after retries — excluded from consistency. */
  rateLimited: number;
  /** Non-rate-limited passes: the denominator behind every consistency figure. */
  counted: number;
  passes: number;
  games: number;
}

function aggregate(model: string, recs: PassRecord[], passes: number): ModelAggregate {
  // Consistency measures the MODEL, so a pass that stayed rate-limited after
  // retries (an infra failure the model never controlled) is excluded from
  // every rate below and reported separately instead of tanking the numbers.
  const counted = recs.filter((r) => r.failure !== 'rate-limited');
  const overall = pct(counted.filter((r) => r.ok).length, counted.length);

  // Per-pass consistency: fraction of (counted) games that passed within each pass.
  const passRates: number[] = [];
  for (let p = 1; p <= passes; p++) {
    const inPass = counted.filter((r) => r.pass === p);
    passRates.push(pct(inPass.filter((r) => r.ok).length, inPass.length));
  }

  const byCategory: Record<string, number | null> = {};
  for (const cat of new Set(recs.map((r) => r.category))) {
    const inCat = counted.filter((r) => r.category === cat);
    byCategory[cat] = pct(inCat.filter((r) => r.ok).length, inCat.length);
  }

  const latencies = counted.map((r) => r.latencyMs).sort((a, b) => a - b);
  const costs = counted.map((r) => r.costUsd).filter((c): c is number => c !== null);
  const cacheReads = counted.reduce((a, r) => a + (r.cacheReadTokens ?? 0), 0);
  // inputTokens already includes the cached subset (Gemini promptTokenCount),
  // so total input is just the sum — do not add cacheReadTokens again.
  const totalInput = counted.reduce((a, r) => a + (r.inputTokens ?? 0), 0);

  const failureByStopReason: Record<string, number> = {};
  const failureByMismatch: Record<string, number> = {};
  for (const r of recs) {
    if (r.failure) failureByStopReason[r.failure] = (failureByStopReason[r.failure] ?? 0) + 1;
    for (const k of r.mismatchKinds) failureByMismatch[k] = (failureByMismatch[k] ?? 0) + 1;
  }

  const measuredPassRates = passRates.filter((r): r is number => r !== null);
  return {
    model,
    overall,
    passRates,
    passRateMin: measuredPassRates.length ? Math.min(...measuredPassRates) : null,
    passRateMax: measuredPassRates.length ? Math.max(...measuredPassRates) : null,
    passRateStddev: stddev(passRates),
    byCategory,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    meanCostUsd: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null,
    cacheHitRate: totalInput ? cacheReads / totalInput : null,
    failureByStopReason,
    failureByMismatch,
    rateLimited: recs.length - counted.length,
    counted: counted.length,
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
  // Default 2: a free-tier Gemini key's RPM limit turns a 4-wide fan-out into a
  // wall of 429s. Raise it on a paid key.
  const concurrency = envInt('EVAL_CONCURRENCY', 2);
  const minConsistency = process.env.EVAL_MIN_CONSISTENCY ? Number(process.env.EVAL_MIN_CONSISTENCY) : 0.95;
  const outPath = process.env.EVAL_OUT || './eval-results.json';

  // Credentials are per-provider now, so check each model's own provider rather
  // than assuming one vendor. Failing here beats discovering it 33 calls in.
  const missing = models.filter((m) => !hasCredentials(m));
  if (missing.length) {
    for (const m of missing) {
      const p = resolveProvider(m);
      console.error(
        `${m}: missing credentials for provider '${p}' — set ` +
          (p === 'gemini'
            ? 'GEMINI_API_KEY'
            : p === 'openrouter'
              ? 'OPEN_ROUTER_ENDPOINT and OPEN_ROUTER_API_KEY'
              : 'AZURE_FOUNDRY_ENDPOINT and AZURE_FOUNDRY_API_KEY'),
      );
    }
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
  console.log(
    `date=${new Date().toISOString()}  golden=${GOLDEN.length} games  passes=${passes}  concurrency=${concurrency}`,
  );
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
    await pool(tasks.slice(1), concurrency, async (t) => {
      modelRecs.push(await runOne(model, t.game, t.pass));
    });

    allRecords.push(...modelRecs);
    const agg = aggregate(model, modelRecs, passes);
    aggregates.push(agg);

    console.log(`\n### ${model}`);
    console.log(
      `overall consistency: ${fmtPct(agg.overall)}  ` +
        `(${agg.counted} passes counted` +
        (agg.rateLimited ? `, ${agg.rateLimited} rate-limited excluded` : '') +
        `; per-pass ${fmtPct(agg.passRateMin)}–${fmtPct(agg.passRateMax)}, ` +
        `sd ${(agg.passRateStddev * 100).toFixed(1)}pp)`,
    );
    console.log(
      `latency p50/p95: ${agg.p50LatencyMs}/${agg.p95LatencyMs} ms  ` +
        `mean cost/report: ${agg.meanCostUsd === null ? 'n/a' : '$' + agg.meanCostUsd.toFixed(5)}  ` +
        `cache-hit: ${agg.cacheHitRate === null ? 'n/a' : (agg.cacheHitRate * 100).toFixed(0) + '%'}`,
    );
    console.table(
      Object.fromEntries(Object.entries(agg.byCategory).map(([c, r]) => [c, { consistency: fmtPct(r) }])),
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
    if (agg.counted === 0) {
      console.error('GATE INCONCLUSIVE: every pass was rate-limited — nothing to measure.');
      process.exit(2);
    }
    // agg.counted > 0 (checked above) guarantees at least one measured pass,
    // so passRateMin is non-null here even though the type is nullable.
    const lowerBound = agg.passRateMin ?? 0; // never the mean — a gate on the mean is noisy
    console.log(
      `\nGATE: ${gateModel} lower-bound consistency ${fmtPct(agg.passRateMin)} ` +
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
