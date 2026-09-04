/**
 * Pure smoke-section selection shared by the runner and its contract test.
 * CI uses E2E_SHARD; E2E_SECTION is a local-only surgical rerun aid.
 */
export function selectSmokeSections(definitions, env = process.env) {
  const shardRaw = env.E2E_SHARD?.trim();
  const sectionRaw = env.E2E_SECTION?.trim();
  if (shardRaw && sectionRaw) throw new Error('Set E2E_SHARD or E2E_SECTION, not both.');

  let shard = null;
  if (shardRaw) {
    const match = /^(\d+)\/(\d+)$/.exec(shardRaw);
    if (!match) throw new Error(`E2E_SHARD must look like "2/4"; got ${JSON.stringify(shardRaw)}`);
    const number = Number(match[1]);
    const count = Number(match[2]);
    if (count !== 4 || number < 1 || number > count) {
      throw new Error(`smoke.mjs defines exactly 4 shards; got ${JSON.stringify(shardRaw)}`);
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
