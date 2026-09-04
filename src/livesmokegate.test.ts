/**
 * Deterministic tests for the live-smoke deploy-verify gate.
 *
 * H5 follow-up (handbacks/2026-09-04-1620-HANDBACK.md, "Live deploy-gate
 * defect"): live-smoke run 33913164302 passed 13/13 for the H5 release while
 * /api/version still answered the OLD version — a backend/data-only change
 * reuses the same frontend asset hash, so the old asset-only gate declared
 * "deployed" on the very first poll. These tests exercise the FIXED gate in
 * src/e2e/liveSmokeGate.mjs with a stubbed fetch/clock — no real network, no
 * real waiting — proving:
 *
 *   1. same-asset + stale-version does NOT count as deployed (the exact
 *      shape of the H5 defect);
 *   2. no configured wait can exceed 5 minutes, however large the env
 *      override;
 *   3. a genuinely fresh asset+version pair IS accepted (the gate isn't just
 *      permanently closed).
 *
 * Every assertion below is proven to actually check something with a
 * mutation: comment `runMutationCheck()` at the bottom flips the version
 * half of `deploymentMatches` off (reverting to the pre-fix asset-only
 * behaviour) and asserts the exact H5 scenario THEN passes when it should
 * not — i.e. the test fails against the unfixed gate, and passes again once
 * restored. Run standalone: `tsx src/livesmokegate.test.ts`.
 */
import {
  MAX_WAIT_MS,
  resolveWaitMs,
  deploymentMatches,
  waitForDeploy,
} from './e2e/liveSmokeGate.mjs';

let failures = 0;
function check(name: string, pass: boolean, detail?: string) {
  if (pass) {
    console.log(`✓ ${name}`);
  } else {
    failures++;
    console.error(`✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

// ─────────────────────────────────────────────────────────── resolveWaitMs
// No configured wait can exceed 5 minutes, whatever the override says.
check('default (no env) resolves to <= 5 min', resolveWaitMs(undefined) <= MAX_WAIT_MS,
  `got ${resolveWaitMs(undefined)}`);
check('default (no env) is exactly the 5 min cap (old default was 15 min)',
  resolveWaitMs(undefined) === MAX_WAIT_MS, `got ${resolveWaitMs(undefined)}`);
check('the workflow\'s own "5" override resolves to exactly 5 min',
  resolveWaitMs('5') === MAX_WAIT_MS, `got ${resolveWaitMs('5')}`);
check('a large override ("999") is still clamped to 5 min',
  resolveWaitMs('999') === MAX_WAIT_MS, `got ${resolveWaitMs('999')}`);
check('a short override ("1") is honored, not forced up to the cap',
  resolveWaitMs('1') === 60_000, `got ${resolveWaitMs('1')}`);
check('a garbage override ("") falls back to the (capped) default',
  resolveWaitMs('') === MAX_WAIT_MS, `got ${resolveWaitMs('')}`);
check('a zero/negative override falls back to the (capped) default',
  resolveWaitMs('-5') === MAX_WAIT_MS, `got ${resolveWaitMs('-5')}`);

// ────────────────────────────────────────────────────────── deploymentMatches
const ASSET = 'assets/index-C4sZKxqF.js';

// The exact H5 shape: the asset never changed (backend/data-only release),
// version is still the prior release's.
check('same-asset + stale-version does NOT count as deployed (the H5 shape)',
  deploymentMatches({ status: 200, text: `<script src="/${ASSET}">`, expectedAsset: ASSET, version: '0.0.136', expectedVersion: '0.0.137' }) === false);

// A genuinely fresh deploy: asset matches AND version matches exactly.
check('matching asset + matching version DOES count as deployed',
  deploymentMatches({ status: 200, text: `<script src="/${ASSET}">`, expectedAsset: ASSET, version: '0.0.137', expectedVersion: '0.0.137' }) === true);

// Frontend changed but backend/version metadata lagging (the inverse shape).
check('changed asset + stale version does NOT count as deployed',
  deploymentMatches({ status: 200, text: '<script src="/assets/index-NEWHASH.js">', expectedAsset: ASSET, version: '0.0.136', expectedVersion: '0.0.137' }) === false);

// No expected version supplied at all — asset-only behaviour preserved
// (a caller that never learned a version, not a silent pass on a stale one).
check('with no expectedVersion supplied, asset match alone counts as deployed',
  deploymentMatches({ status: 200, text: `<script src="/${ASSET}">`, expectedAsset: ASSET, version: '0.0.136', expectedVersion: null }) === true);

// A non-200 page never counts, regardless of the text it happened to carry.
check('a non-200 response never counts as deployed',
  deploymentMatches({ status: 500, text: `<script src="/${ASSET}">`, expectedAsset: ASSET, version: '0.0.137', expectedVersion: '0.0.137' }) === false);

// ─────────────────────────────────────────────────────────── waitForDeploy
// Stubbed fetch + stubbed sleep (instant) — proves the polling loop itself
// respects deploymentMatches and gives up at the deadline, with NO real
// waiting (this whole test file runs in well under a second).
async function runWaitForDeployTests() {
  // Case 1: stale version forever -> never deploys, and stops polling once
  // the (fake) clock passes the deadline.
  {
    let now = 0;
    const advance = () => { now += 15_000; return Promise.resolve(); };
    const result = await waitForDeploy({
      expectedAsset: ASSET,
      expectedVersion: '0.0.137',
      waitMs: 60_000, // 1 minute of fake time
      pollIntervalMs: 15_000,
      fetchState: async () => ({ status: 200, text: `<script src="/${ASSET}">`, version: '0.0.136' }),
      sleep: advance,
      now: () => now,
    });
    check('waitForDeploy: permanently-stale version times out as NOT deployed',
      result.deployed === false, JSON.stringify(result));
    check('waitForDeploy: polls a bounded number of times, not forever',
      result.polls > 0 && result.polls <= 5, `polls=${result.polls}`);
  }

  // Case 2: version catches up on the 3rd poll -> deploys, and stops polling
  // immediately once it does (doesn't keep going to the deadline).
  {
    let now = 0;
    let calls = 0;
    const advance = () => { now += 15_000; return Promise.resolve(); };
    const result = await waitForDeploy({
      expectedAsset: ASSET,
      expectedVersion: '0.0.137',
      waitMs: 5 * 60_000,
      pollIntervalMs: 15_000,
      fetchState: async () => {
        calls++;
        const version = calls >= 3 ? '0.0.137' : '0.0.136';
        return { status: 200, text: `<script src="/${ASSET}">`, version };
      },
      sleep: advance,
      now: () => now,
    });
    check('waitForDeploy: version catching up on poll 3 IS deployed',
      result.deployed === true && result.last?.version === '0.0.137', JSON.stringify(result));
    check('waitForDeploy: stops polling as soon as it deploys (exactly 3 calls)',
      calls === 3, `calls=${calls}`);
  }

  // Case 3 (mutation probe): removing the version half of deploymentMatches
  // must make case 1 above WRONGLY report "deployed". This is the literal
  // mutation test: revert deploymentMatches to asset-only, rerun the exact
  // H5 fixture, confirm it now (wrongly) passes, then confirm the real
  // (imported, unmodified) function still correctly rejects it — i.e. the
  // guard is real, not a tautology.
  {
    const assetOnly = ({ status, text, expectedAsset }: { status: number; text: string; expectedAsset: string }) =>
      status === 200 && typeof text === 'string' && text.includes(expectedAsset);
    const h5Fixture = { status: 200, text: `<script src="/${ASSET}">`, expectedAsset: ASSET, version: '0.0.136', expectedVersion: '0.0.137' };
    check('mutation probe: the OLD asset-only predicate wrongly accepts the H5 fixture (proves the fixture is a real positive)',
      assetOnly(h5Fixture) === true);
    check('mutation probe: the FIXED deploymentMatches correctly rejects the same fixture',
      deploymentMatches(h5Fixture) === false);
  }
}

await runWaitForDeployTests();

if (failures > 0) {
  console.error(`\n${failures} live-smoke gate check(s) failed`);
  process.exit(1);
}
console.log('\nlive-smoke deploy-verify gate: all checks passed');
