/**
 * Pure smoke-section selection shared by the runner and its contract test.
 * CI uses E2E_SHARD; E2E_SECTION is a local-only surgical rerun aid.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * How many CI shards the smoke suite is split into (test.yml's matrix must
 * match — e2esharding.test.ts pins both). Sections are packed into shards by
 * MEASURED duration (shard-timings.json, longest-first): a job pays ~75 s of
 * fixed overhead (checkout, dist, browsers, server boot) and must finish under
 * 300 s, so every shard holds at most 225 s of sections. 16 shards stopped
 * fitting on 2026-09-06 (4,040 s of sections; shards 6/7/8 at 390 s). The
 * first 20-shard run measured 4,260 s of sections on CI (CI runs ~5% slower
 * than the table it was packed from) — a 213 s mean, 288 s jobs, too close to
 * the ceiling — so 24 shards. The first 24-shard run then showed per-section
 * CI variance of up to 1.76x a single measurement (one 324 s job), so the
 * table now keeps the MAX per section across runs and there are 28 shards.
 */
export const SHARD_COUNT = 29;

const here = dirname(fileURLToPath(import.meta.url));
export const SHARD_TIMINGS = JSON.parse(readFileSync(join(here, 'shard-timings.json'), 'utf8'));
export const SECTION_BUDGET_MS = SHARD_TIMINGS._ceiling_ms - SHARD_TIMINGS._overhead_ms;

export function measuredMs(id, timings = SHARD_TIMINGS) {
  const v = timings[String(id)];
  return typeof v === 'number' ? v : timings._default;
}

/**
 * A timings table is usable only if it names EVERY registered section with a
 * measured number and no section exceeds the per-job section budget. Used by
 * the refresh script (refuse to write a bad table — e.g. a pre-split run that
 * still reports 66 at 275 s and knows nothing of 66b) and by the contract
 * test on the checked-in table. Returns the list of problems, empty when ok.
 */
export function validateTimings(sectionIds, timings = SHARD_TIMINGS) {
  const problems = [];
  const budget = timings._ceiling_ms - timings._overhead_ms;
  for (const id of sectionIds) {
    const v = timings[String(id)];
    if (typeof v !== 'number') problems.push(`section ${id} has no measured entry`);
    else if (v > budget) problems.push(`section ${id} measures ${Math.round(v / 1000)} s, over the ${budget / 1000} s per-job section budget — split it`);
  }
  for (const id of Object.keys(timings).filter((k) => !k.startsWith('_'))) {
    if (!sectionIds.map(String).includes(id)) problems.push(`timings name section ${id}, which is not registered`);
  }
  return problems;
}

/**
 * Deterministic longest-processing-time packing: sections sorted by measured
 * duration (desc, then id) each go to the currently lightest shard. Returns
 * the definitions with `.shard` set plus the per-shard totals, so the runner,
 * the contract test and the timings script all see one assignment.
 */
export function assignShards(definitions, timings = SHARD_TIMINGS, count = SHARD_COUNT) {
  const totals = Array.from({ length: count }, () => 0);
  const ordered = [...definitions].sort((a, b) => measuredMs(b.id, timings) - measuredMs(a.id, timings) || String(a.id).localeCompare(String(b.id)));
  for (const definition of ordered) {
    let lightest = 0;
    for (let i = 1; i < count; i++) if (totals[i] < totals[lightest]) lightest = i;
    definition.shard = lightest + 1;
    totals[lightest] += measuredMs(definition.id, timings);
  }
  return { definitions, totals };
}

export function selectSmokeSections(definitions, env = process.env) {
  const readConfigured = (name) => {
    const raw = env[name];
    if (raw === undefined) return null;
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new Error(`${name} must not be blank when configured`);
    }
    return raw.trim();
  };
  const shardRaw = readConfigured('E2E_SHARD');
  const sectionRaw = readConfigured('E2E_SECTION');
  if (shardRaw && sectionRaw) throw new Error('Set E2E_SHARD or E2E_SECTION, not both.');

  let shard = null;
  if (shardRaw) {
    const match = /^(\d+)\/(\d+)$/.exec(shardRaw);
    if (!match) throw new Error(`E2E_SHARD must look like "2/${SHARD_COUNT}"; got ${JSON.stringify(shardRaw)}`);
    const number = Number(match[1]);
    const count = Number(match[2]);
    if (count !== SHARD_COUNT || number < 1 || number > count) {
      throw new Error(`smoke.mjs defines exactly ${SHARD_COUNT} shards; got ${JSON.stringify(shardRaw)}`);
    }
    shard = { raw: shardRaw, shard: number, count };
  }

  let ids = null;
  if (sectionRaw) {
    const parsed = sectionRaw.split(',').map((id) => id.trim()).filter(Boolean);
    if (parsed.length === 0 || new Set(parsed).size !== parsed.length) {
      throw new Error(`E2E_SECTION must be one or more distinct section IDs; got ${JSON.stringify(sectionRaw)}`);
    }
    ids = new Set(parsed);
  }

  assignShards(definitions);
  const selected = ids
    ? definitions.filter((definition) => ids.has(definition.id))
    : shard
      ? definitions.filter((definition) => definition.shard === shard.shard)
      : definitions;
  if (ids && selected.length !== ids.size) {
    const missing = [...ids].filter((id) => !selected.some((definition) => definition.id === id));
    throw new Error(`unknown E2E_SECTION ID(s): ${missing.join(', ')}`);
  }
  if (selected.length === 0) throw new Error(`no smoke sections selected for ${sectionRaw ?? shardRaw ?? 'all'}`);

  return {
    selected,
    shard,
    label: ids ? ` for sections ${sectionRaw}` : shard ? ` for shard ${shard.raw}` : ' (all shards locally)',
  };
}
