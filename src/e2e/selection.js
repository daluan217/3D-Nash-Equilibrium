/**
 * Pure smoke-section selection shared by the runner and its contract test.
 * CI uses E2E_SHARD; E2E_SECTION is a local-only surgical rerun aid.
 */
/**
 * How many CI shards the smoke suite is split into. 12 (4 -> 8 -> 12 on
 * 2026-09-05): every shard job must finish in under five minutes. A job costs
 * ~75 s of fixed overhead (checkout, dist artifact, browsers, server boot) plus
 * its sections, and the longest single section is ~120 s, so 12 shards packed
 * by MEASURED duration (greedy longest-first) hold every shard to ~140 s of
 * sections: ~3m40s nominal, under five minutes even at +30% timing variance.
 * A new section goes into the lightest shard; re-measure from the CI logs
 * (SECTION-PASS lines carry the ms) before moving anything else.
 */
export const SHARD_COUNT = 12;

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
