/**
 * Pure smoke-section selection shared by the runner and its contract test.
 * CI uses E2E_SHARD; E2E_SECTION is a local-only surgical rerun aid.
 */
/**
 * How many CI shards the smoke suite is split into. 8 (was 4, 2026-09-05):
 * measured section time per shard was 600/324/446/363 s — shard 1 ran 11 min
 * while shard 2 ran 7 — and 8 balanced shards carry ~215 s of sections each.
 * Assignment is by MEASURED duration (greedy longest-first), not by section
 * order; a new section is placed into the lightest shard.
 */
export const SHARD_COUNT = 8;

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
    if (!match) throw new Error(`E2E_SHARD must look like "2/8"; got ${JSON.stringify(shardRaw)}`);
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
