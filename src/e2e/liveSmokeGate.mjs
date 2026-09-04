/* Pure deploy-verify gate helpers for live-smoke.mjs — split out so they can be
 * unit-tested deterministically (no real network, no real waiting).
 *
 * H5 follow-up (handbacks/2026-09-04-1620-HANDBACK.md, "Live deploy-gate
 * defect"): live-smoke run 33913164302 passed 13/13 for the H5 release while
 * /api/version still answered the OLD version. H5 changed only backend/data,
 * so the frontend asset hash was unchanged — the asset-only gate mistook the
 * stale deployment for the new one. Two independent fixes live here:
 *
 *   1. `resolveWaitMs` caps the poll deadline at 5 minutes IN THE SCRIPT,
 *      not only via the workflow's LIVE_WAIT_MINUTES override — a bad or
 *      missing override can no longer resurrect the old 15-minute default.
 *   2. `deploymentMatches` requires the asset AND (when an expected version
 *      is supplied) an EXACT version match before a poll counts as "landed".
 */

/** No configured wait may exceed this, regardless of any env override. */
export const MAX_WAIT_MS = 5 * 60_000;

/**
 * Resolve the poll deadline in milliseconds from the raw LIVE_WAIT_MINUTES
 * env value (a string, or undefined). Pure: no clock, no I/O.
 *
 * - undefined / empty / non-numeric / <= 0 -> the historical 15-minute
 *   default, THEN clamped to MAX_WAIT_MS (so the default itself is capped).
 * - any numeric value, however large -> clamped to MAX_WAIT_MS.
 * - any numeric value below MAX_WAIT_MS -> honored as-is (a caller may ask
 *   for a SHORTER wait than the cap; the cap is a ceiling, not a floor).
 */
export function resolveWaitMs(rawMinutesEnv) {
  const parsed = Number(rawMinutesEnv);
  const minutes = Number.isFinite(parsed) && parsed > 0 ? parsed : 15;
  return Math.min(minutes * 60_000, MAX_WAIT_MS);
}

/**
 * Does this one poll observation count as "the deploy has landed"?
 * Pure: takes plain values, no fetch, no fs.
 *
 * Requires the expected asset to be present in the live page AND — whenever
 * an expected version was supplied — the live /api/version to match it
 * EXACTLY. Without an expected version (e.g. a run that never learned one)
 * the version half is skipped, matching the old asset-only behaviour rather
 * than failing every deploy-verify run that omits it.
 */
export function deploymentMatches({ status, text, expectedAsset, version, expectedVersion }) {
  if (status !== 200) return false;
  if (!expectedAsset || typeof text !== 'string' || !text.includes(expectedAsset)) return false;
  if (expectedVersion && version !== expectedVersion) return false;
  return true;
}

/**
 * Poll until `deploymentMatches` is true or the deadline elapses. Injectable
 * fetch/sleep/clock so tests can run this with a stubbed fetch and no real
 * waiting — see src/livesmokegate.test.ts.
 *
 * @param {object} opts
 * @param {string} opts.expectedAsset
 * @param {string|null} [opts.expectedVersion]
 * @param {number} opts.waitMs - already resolved via resolveWaitMs
 * @param {number} [opts.pollIntervalMs]
 * @param {() => Promise<{status:number, text:string, version:string|null}>} opts.fetchState
 *   - fetches the live page + version and returns the fields deploymentMatches needs
 * @param {(ms:number) => Promise<void>} [opts.sleep]
 * @param {() => number} [opts.now] - defaults to Date.now
 * @param {(msg:string) => void} [opts.log]
 */
export async function waitForDeploy({
  expectedAsset,
  expectedVersion = null,
  waitMs,
  pollIntervalMs = 15_000,
  fetchState,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  log = () => {},
}) {
  const deadline = now() + waitMs;
  let polls = 0;
  let last = null;
  while (now() < deadline) {
    polls += 1;
    last = await fetchState();
    if (deploymentMatches({ ...last, expectedAsset, expectedVersion })) {
      return { deployed: true, polls, last };
    }
    log(`poll ${polls}: asset=${last?.text?.includes(expectedAsset) ? 'match' : 'stale'} version=${last?.version ?? 'unknown'} (want ${expectedVersion ?? 'any'})`);
    await sleep(pollIntervalMs);
  }
  return { deployed: false, polls, last };
}
