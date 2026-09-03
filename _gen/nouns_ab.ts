/**
 * BLUE-NOUNS-8 phase 1 — does asking for actorA/actorB in the SCENARIO_SCHEMA
 * (the "New AI scenario" / regen slim call, not the full report) cost yield,
 * and does the model actually supply usable nouns when the schema allows it?
 *
 * Arms, same 100 games, same sampler, one draw per (game, arm):
 *   OLD — generateScenario(g, { model, domain, stakes: true })                (unchanged today)
 *   NEW — generateScenario(g, { model, domain, stakes: true, actorNouns: true })
 *
 * SHIPPING CONDITION, not a convenient approximation (round3_common.md rule 4):
 *   - REPORT_MODEL pinned explicitly (AB_MODEL, default gpt-5.6-luna) — the
 *     local .env has no REPORT_MODEL line, so an unpinned call would silently
 *     measure gpt-5.4-mini.
 *   - NO `reasoning` argument passed anywhere below, matching production
 *     (production passes none and gets the provider default, thinking ON;
 *     eleven other harnesses hard-coded 'low' and mismeasured everything).
 *   - `domain` (pickScenarioDomain) and `stakes: true` (stakesHint) passed on
 *     every call, exactly as all three real call sites do.
 *   - Games sampled across the bank's own 4 stakes bands (stakesBand, 0..3),
 *     ~25 each, not a single fixed magnitude — the bank's own indexing axis.
 *   - Gate = the exact `storyOk` predicate `inventScreenedScenario` applies
 *     in server.ts: validateScenario(sc,g).ok && scenarioIsClaimFree(sc).ok
 *     && (NASH_DIRECTION_CHECKS!=='1' || validateProseDirections(...).length===0).
 *     NASH_DIRECTION_CHECKS=1 is set below to match the deployed rung-3 flags
 *     (CLAUDE.md's 2026-08-31 Cloud Run flip).
 *
 * Output: one JSON object to AB_OUT (default _gen/results/nouns_ab-2026-09-03.json)
 * with per-arm aggregates and the raw per-draw rows (so hand-reads can be done
 * straight off this file — no second harness run needed).
 */
import 'dotenv/config';
process.env.NASH_DIRECTION_CHECKS = process.env.NASH_DIRECTION_CHECKS ?? '1';

import { generateScenario } from '../src/utils/report';
import { pickScenarioDomain } from '../src/utils/scenarioDomains';
import { validateScenario, scenarioIsClaimFree, validateProseDirections } from '../src/utils/nashValidator';
import { stakesBand } from '../src/utils/scenarioBank';
import { writeFileSync } from 'node:fs';
import type { GamePayoffs, SuggestedScenario } from '../src/types';

const MODEL = process.env.AB_MODEL || 'gpt-5.6-luna';
const PER_BAND = Number(process.env.AB_PER_BAND || 25); // 4 bands x 25 = 100 games
const OUT = process.env.AB_OUT || '_gen/results/nouns_ab-2026-09-03.json';

// ---- deterministic sampler: seeded PRNG, same shape as blue3_stakes_scale_invariance.ts ----
let seed = 20260903;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
function randomGame(mag: number): GamePayoffs {
  const p = () => Math.round((rand() * 2 - 1) * mag * 1000) / 1000;
  return { a11: p(), a12: p(), a21: p(), a22: p(), b11: p(), b12: p(), b21: p(), b22: p() };
}
// Magnitude ranges tuned so most draws land in the target band on the first
// try (swing < 1 / < 10 / < 50 / >= 50 -> band 0/1/2/3); a handful of retries
// covers the rest since swing is a random function of 8 independent draws.
const BAND_MAG = [0.3, 3, 15, 60];
function sampleGamesForBand(band: number, n: number): GamePayoffs[] {
  const out: GamePayoffs[] = [];
  let attempts = 0;
  while (out.length < n && attempts < n * 50) {
    attempts++;
    const g = randomGame(BAND_MAG[band]);
    if (stakesBand(g) === band) out.push(g);
  }
  if (out.length < n) throw new Error(`band ${band}: only sampled ${out.length}/${n} after ${attempts} attempts`);
  return out;
}

const games: Array<{ band: number; g: GamePayoffs }> = [];
for (let b = 0; b < 4; b++) {
  for (const g of sampleGamesForBand(b, PER_BAND)) games.push({ band: b, g });
}
console.log(`sampled ${games.length} games across 4 bands (${PER_BAND} each)`);

// ---- gate, exactly server.ts's inventScreenedScenario storyOk (single draw, no reroll) ----
function storyOk(sc: SuggestedScenario, g: GamePayoffs): { ok: boolean; reason: string | null } {
  const v = validateScenario(sc, g);
  if (!v.ok) return { ok: false, reason: `validateScenario: ${v.issues?.[0] ?? 'failed'}` };
  const cf = scenarioIsClaimFree(sc);
  if (!cf.ok) return { ok: false, reason: `claimFree: ${cf.reason}` };
  if (process.env.NASH_DIRECTION_CHECKS === '1') {
    const issues = validateProseDirections(sc.description ?? '', sc, g);
    if (issues.length > 0) return { ok: false, reason: `direction: ${issues[0]}` };
  }
  return { ok: true, reason: null };
}

// ---- noun predicates (NEW arm only) ----
const norm = (t: string) => t
  .normalize('NFKC')
  .replace(/[​-‍﻿]/g, '')
  .trim()
  .toLowerCase();

function nounMetrics(sc: SuggestedScenario) {
  const a = Array.isArray(sc.actorA) ? sc.actorA.filter((x): x is string => typeof x === 'string') : [];
  const b = Array.isArray(sc.actorB) ? sc.actorB.filter((x): x is string => typeof x === 'string') : [];
  const present = a.length > 0 || b.length > 0;
  const descNorm = norm(sc.description ?? '');
  const allNouns = [...a, ...b];
  const verbatimHits = allNouns.filter((n) => descNorm.includes(norm(n)));
  const verbatimRate = allNouns.length > 0 ? verbatimHits.length / allNouns.length : null;
  const aSet = new Set(a.map(norm));
  const bSet = new Set(b.map(norm));
  const disjoint = [...aSet].every((x) => !bSet.has(x));
  const labels = [sc.row1, sc.row2, sc.col1, sc.col2].filter((x): x is string => !!x).map(norm);
  const collision = allNouns.some((n) => labels.includes(norm(n)));
  return {
    present, count: allNouns.length, countA: a.length, countB: b.length,
    verbatimRate, verbatimHits: verbatimHits.length, verbatimTotal: allNouns.length,
    disjoint, collision,
  };
}

// ---- run ----
type Row = {
  arm: 'old' | 'new'; band: number; domain: string; ms: number;
  parsed: boolean; failure: string | null;
  gateOk: boolean; gateReason: string | null;
  outputTokens: number | null; reasoningTokens: number | null;
  name: string | null; row1: string | null; row2: string | null; col1: string | null; col2: string | null;
  description: string | null;
  actorA: string[] | null; actorB: string[] | null;
  noun: ReturnType<typeof nounMetrics> | null;
};

const rows: Row[] = [];
writeFileSync(OUT, ''); // fail fast on a bad path before spending calls

async function drawOne(arm: 'old' | 'new', band: number, g: GamePayoffs): Promise<void> {
  const domain = pickScenarioDomain();
  const t0 = Date.now();
  let r: Awaited<ReturnType<typeof generateScenario>>;
  try {
    r = await generateScenario(g, { model: MODEL, domain, stakes: true, actorNouns: arm === 'new' });
  } catch (e) {
    r = { scenario: null, failure: String(e), usage: null } as never;
  }
  const ms = Date.now() - t0;
  const sc = r.scenario;
  const gate = sc ? storyOk(sc, g) : { ok: false, reason: r.failure ?? 'unparseable' };
  rows.push({
    arm, band, domain, ms,
    parsed: !!sc, failure: r.failure ?? null,
    gateOk: gate.ok, gateReason: gate.reason,
    outputTokens: r.usage?.outputTokens ?? null, reasoningTokens: r.usage?.reasoningTokens ?? null,
    name: sc?.name ?? null, row1: sc?.row1 ?? null, row2: sc?.row2 ?? null, col1: sc?.col1 ?? null, col2: sc?.col2 ?? null,
    description: sc?.description ?? null,
    actorA: (sc?.actorA as string[] | undefined) ?? null, actorB: (sc?.actorB as string[] | undefined) ?? null,
    noun: arm === 'new' && sc ? nounMetrics(sc) : null,
  });
  process.stdout.write(gate.ok ? '.' : (sc ? 'x' : 'e'));
}

const CONCURRENCY = Number(process.env.AB_CONCURRENCY || 4);
async function pool<T>(items: T[], worker: (t: T) => Promise<void>) {
  let i = 0;
  async function next(): Promise<void> {
    const idx = i++;
    if (idx >= items.length) return;
    await worker(items[idx]);
    return next();
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, next));
}

// AB_ARMS lets a re-measurement after a prompt tweak spend calls on only the
// arm that changed (the other arm's numbers are unaffected and can be reused
// from a prior run's JSON) — budget discipline, not a shortcut on the gate.
const ARMS = (process.env.AB_ARMS || 'old,new').split(',').map((s) => s.trim()) as Array<'old' | 'new'>;

async function main() {
  const tasks: Array<{ arm: 'old' | 'new'; band: number; g: GamePayoffs }> = [];
  for (const { band, g } of games) {
    for (const arm of ARMS) tasks.push({ arm, band, g });
  }
  console.log(`running ${tasks.length} calls (model=${MODEL}, arms=${ARMS.join(',')}, concurrency=${CONCURRENCY}) ...`);
  await pool(tasks, (t) => drawOne(t.arm, t.band, t.g));
  console.log('\ndone');

  function summarize(arm: 'old' | 'new') {
    const rs = rows.filter((r) => r.arm === arm);
    const n = rs.length;
    const parsed = rs.filter((r) => r.parsed).length;
    const gateOk = rs.filter((r) => r.gateOk).length;
    const msSorted = rs.map((r) => r.ms).sort((a, b) => a - b);
    const pct = (p: number) => msSorted.length ? msSorted[Math.min(msSorted.length - 1, Math.floor(p * msSorted.length))] : null;
    const toks = rs.filter((r) => r.outputTokens != null).map((r) => r.outputTokens as number);
    const avgTok = toks.length ? toks.reduce((a, b) => a + b, 0) / toks.length : null;
    const out: Record<string, unknown> = {
      n, parsed, parsedRate: n ? parsed / n : null,
      gateOk, yieldRate: n ? gateOk / n : null,
      latencyP50: pct(0.5), latencyP95: pct(0.95),
      avgOutputTokens: avgTok,
    };
    if (arm === 'new') {
      const withScenario = rs.filter((r) => r.parsed);
      const nounRows = withScenario.map((r) => r.noun).filter((x): x is NonNullable<typeof x> => !!x);
      const present = nounRows.filter((x) => x.present).length;
      const withNouns = nounRows.filter((x) => x.count > 0);
      const verbatimVals = withNouns.map((x) => x.verbatimRate).filter((x): x is number => x != null);
      const disjointVals = withNouns.filter((x) => x.count > 0);
      out.nounStats = {
        scenariosWithNouns: present, ofParsed: withScenario.length,
        nounPresenceRate: withScenario.length ? present / withScenario.length : null,
        verbatimRateMean: verbatimVals.length ? verbatimVals.reduce((a, b) => a + b, 0) / verbatimVals.length : null,
        verbatimRateAllHundred: verbatimVals.length ? verbatimVals.filter((v) => v === 1).length / verbatimVals.length : null,
        disjointRate: disjointVals.length ? disjointVals.filter((x) => x.disjoint).length / disjointVals.length : null,
        collisionRate: disjointVals.length ? disjointVals.filter((x) => x.collision).length / disjointVals.length : null,
        countDistribution: withNouns.reduce((acc: Record<number, number>, x) => { acc[x.count] = (acc[x.count] ?? 0) + 1; return acc; }, {}),
      };
    }
    return out;
  }

  const summary = { old: summarize('old'), new: summarize('new') };
  console.log(JSON.stringify(summary, null, 2));

  writeFileSync(OUT, JSON.stringify({ model: MODEL, generatedAt: new Date().toISOString(), summary, rows }, null, 2));
  console.log(`\nwrote ${rows.length} rows -> ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
