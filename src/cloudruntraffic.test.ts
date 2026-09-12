/** Behavioral and mutation guard for Cloud Run v2 traffic metadata. */
import assert from 'node:assert/strict';
import { inspectCloudRunTraffic, isServingShare } from './deploy/cloud-run-traffic.mjs';

const parent = 'projects/demo/locations/us-east1/services/nash-equilibrium-backend';
const newest = `${parent}/revisions/newest`;
const old = `${parent}/revisions/old`;

const latestControl = inspectCloudRunTraffic({
  latestReadyRevision: newest,
  traffic: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100 }],
  trafficStatuses: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100 }],
});
assert.deepEqual(latestControl.errors, []);
assert.deepEqual(latestControl.serving, [newest]);
assert.equal(latestControl.pinned, false);

const splitControl = inspectCloudRunTraffic({
  latestReadyRevision: newest,
  traffic: [
    { type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 80 },
    { type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: 'old', percent: 20 },
  ],
  trafficStatuses: [
    { type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 80 },
    { type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: old, percent: 20 },
  ],
});
assert.deepEqual(splitControl.errors, []);
assert.deepEqual(splitControl.serving, [newest, old]);
assert.equal(splitControl.pinned, true);

const stalePinned = inspectCloudRunTraffic({
  latestReadyRevision: newest,
  traffic: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: 'old', percent: 100 }],
  trafficStatuses: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: old, percent: 100 }],
});
assert.match(stalePinned.errors.join(' | '), /newest ready revision.*receives no traffic/);

const zeroOnly = inspectCloudRunTraffic({
  latestReadyRevision: newest,
  traffic: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: 'old', percent: 0 }],
  trafficStatuses: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: old, percent: 0 }],
});
assert.match(zeroOnly.errors.join(' | '), /no revision receives non-zero traffic/);

assert.match(inspectCloudRunTraffic({}).errors.join(' | '), /latestReadyRevision.*trafficStatuses/);

// Behavioral mutant: >= 0 would turn Cloud Run's retained zero-percent target
// into a serving revision and reopen the pinned-traffic false green.
const mutantSource = isServingShare.toString().replace('status.percent > 0', 'status.percent >= 0');
const mutant = Function(`return (${mutantSource})`)();
assert.equal(isServingShare({ percent: 0 }), false);
assert.equal(mutant({ percent: 0 }), true, 'the zero-percent fixture kills the >= 0 mutant');

console.log('✓ Cloud Run traffic metadata: latest/split controls, stale pin, zero-share, malformed input, and >=0 mutant');
