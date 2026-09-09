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
 * table now keeps the MAX per section across runs and there were 28 shards.
 *
 * OPUS-REVIEW-WEBKIT N1 (2026-09-07): §70/§75/§83's timings had been measured
 * while their WebKit case was being skipped (#166's defect) — once #168 made
 * WebKit actually run there, the real numbers are 14-70% higher (§83:
 * 100 s -> 170 s). Repacking those three real numbers alone, at 28 shards,
 * pushed 7 OTHER shards over the 200 s headroom line too (this packer is
 * longest-first bin-packing: changing 3 inputs reshuffles every shard's
 * membership, not just the changed ones). 29 shards clears all but one —
 * §70 alone now measures 207,990 ms, over the 200 s headroom line by itself,
 * which no amount of splitting into MORE shards can fix (one section can't
 * be packed smaller than itself). See e2esharding.test.ts's headroom assert
 * for how a single oversized section is distinguished from a genuine
 * multi-section pileup.
 *
 * blue16-app merge-main round (2026-09-07): #164's rewritten §71
 * (self-calibrating window + variant B fallback, 17,072 ms -> 77,507 ms
 * measured) plus this branch's own §85/85b/86, merged on TOP of #168's
 * already-repacked 29-shard table, pushed 6 more multi-section shards over
 * the 200 s line (worst: 204,888 ms). Two independent branches each raised
 * the count for their own real reason and neither anticipated the other's
 * — 30 shards clears every multi-section shard under 200 s again (worst
 * single-section shard, §70 alone, stays 207,990 ms as before; unaffected
 * by shard count).
 *
 * struct19-app (2026-09-08): §90 was first registered at 56,000 ms from a
 * measurement taken before it walked the whole tour; it really costs
 * 88,551 ms (19 steps, each waiting out a 300 ms spotlight transition —
 * every step settles, so there is no cap to trim and no fat to cut). The
 * honest number puts FIVE multi-section shards over the 200 s headroom line
 * at 30 (worst 200,704 ms — the table was already within 1 s of the line in
 * five places, so any true number over ~80,000 tips it). 31 clears them all;
 * worst multi-section shard becomes 195,221 ms. H3's §91 measured 175,615 ms
 * on 2026-09-09; adding it makes 31 overpack again, while 32 clears the set.
 */
export const SHARD_COUNT = 32;

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
