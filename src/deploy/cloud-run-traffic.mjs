/* Validate the credential-free Cloud Run v2 Service metadata used by the live
 * audit and print each non-zero-traffic revision resource name on stdout.
 * Human diagnostics go to stderr so a shell command substitution receives
 * only revision names.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LATEST = 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST';
const REVISION = 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION';

export const isServingShare = (status) =>
  Number.isFinite(status?.percent) && status.percent > 0;

/** Validate Cloud Run traffic metadata and resolve every serving revision. */
export function inspectCloudRunTraffic(service) {
  const errors = [];
  if (!service || typeof service !== 'object' || Array.isArray(service)) {
    return { errors: ['service metadata is not a JSON object'], serving: [], pinned: false };
  }

  const latest = service.latestReadyRevision;
  const match = typeof latest === 'string'
    ? /^(projects\/[^/]+\/locations\/[^/]+\/services\/[^/]+)\/revisions\/[^/]+$/.exec(latest)
    : null;
  if (!match) errors.push('latestReadyRevision is missing or malformed');
  const serviceName = match?.[1] ?? null;

  const statuses = service.trafficStatuses;
  if (!Array.isArray(statuses) || statuses.length === 0) {
    errors.push('trafficStatuses is missing or empty');
  }

  const serving = [];
  for (const status of Array.isArray(statuses) ? statuses : []) {
    if (!status || typeof status !== 'object' || !Number.isFinite(status.percent)
        || status.percent < 0 || status.percent > 100) {
      errors.push('trafficStatuses contains a malformed percentage entry');
      continue;
    }
    if (!isServingShare(status)) continue;
    let revision = status.revision;
    if (!revision && status.type === LATEST) revision = latest;
    if (typeof revision === 'string' && !revision.includes('/') && serviceName) {
      revision = `${serviceName}/revisions/${revision}`;
    }
    if (typeof revision !== 'string'
        || !serviceName
        || !revision.startsWith(`${serviceName}/revisions/`)) {
      errors.push('a non-zero traffic target has no valid revision in this service');
      continue;
    }
    serving.push(revision);
  }

  const uniqueServing = [...new Set(serving)];
  if (uniqueServing.length === 0) errors.push('no revision receives non-zero traffic');
  if (match && !uniqueServing.includes(latest)) {
    errors.push(`the newest ready revision (${latest}) receives no traffic`);
  }

  const desired = Array.isArray(service.traffic) ? service.traffic : [];
  const pinned = desired.some((target) => target?.type === REVISION || !!target?.revision);
  return { errors, serving: uniqueServing, pinned, latest };
}

/** Run the traffic audit CLI using a Cloud Run service document from stdin. */
function main() {
  let service;
  try {
    service = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    console.error('✗ cloud-run traffic audit: stdin is not valid JSON.');
    process.exit(1);
  }
  const result = inspectCloudRunTraffic(service);
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`✗ cloud-run traffic audit: ${error}`);
    process.exit(1);
  }
  for (const revision of result.serving) console.error(`SERVING  ${revision}`);
  if (result.pinned) {
    console.error('::warning::Cloud Run traffic is pinned by revision instead of following the latest ready revision. Restore with --to-latest.');
  } else {
    console.error('Cloud Run traffic follows the latest ready revision.');
  }
  process.stdout.write(`${result.serving.join('\n')}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
