/**
 * Structural contract for the smoke-suite fan-out. The browser run proves the
 * behavior; this fast test prevents a later workflow edit from silently
 * bypassing a shard, restoring the whole-suite retry, or dropping the exact
 * `e2e` status context required by branch protection.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_REPORT_FETCH_TIMEOUT_MS,
  resolveReportFetchTimeoutMs,
} from './utils/fetchTimeout';

const smoke = readFileSync('src/e2e/smoke.mjs', 'utf8');
const workflow = readFileSync('.github/workflows/test.yml', 'utf8');
const app = readFileSync('src/App.tsx', 'utf8');

const definitions = [...smoke.matchAll(
  /section\('([^']+)',\s*'([^']+)',\s*([1-4]),\s*async\s*\(\)\s*=>/g,
)].map((match) => ({ id: match[1], name: match[2], shard: Number(match[3]) }));

const expectedIds = [
  '1', '2', '3', '4', '5', '6', '6b', '7', '8', '9', '10', '11', '12',
  '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23',
  '24', '25', '26', '27', '28', '29', '30', '31', '32', '33', '34', '35',
  '36', '37',
];

assert.deepStrictEqual(definitions.map(({ id }) => id), expectedIds,
  'every historical smoke section must be registered exactly once and in order');
assert.strictEqual(new Set(definitions.map(({ name }) => name)).size, definitions.length,
  'section names must be unique so retry output identifies one unit unambiguously');
for (let shard = 1; shard <= 4; shard++) {
  assert(definitions.some((definition) => definition.shard === shard),
    `shard ${shard} must own at least one section`);
}

assert.match(smoke, /if \(!raw\) return null;/,
  'an unset E2E_SHARD must continue to select the complete local suite');
assert.match(smoke, /failed\.push\(definition\)[\s\S]*for \(const definition of failed\)[\s\S]*runSection\(definition, 2\)/,
  'the runner must collect failed sections and retry only that subset once');
assert.match(smoke, /pass-after-section-retry:/,
  'a recovered section retry must be visible in CI output');
assert.match(smoke, /result\.attempt === finalAttemptBySection\.get\(result\.sectionId\)/,
  'the final verdict must use the retry attempt for sections that reran');
assert.match(smoke, /section returned without calling record\(\)/,
  'a retry that accidentally records no checks must fail rather than vanish');

assert.match(workflow, /^\s{2}workflow_dispatch:\s*$/m,
  'Test must remain manually dispatchable');
assert.match(workflow, /^\s{2}e2e_smoke:\s*$/m,
  'the workflow must retain the smoke matrix job');
assert.match(workflow, /matrix:\s*\n\s*shard:\s*\[1, 2, 3, 4\]/,
  'CI must fan smoke out across all four declared shards');
assert.match(workflow, /fail-fast:\s*false/,
  'one failed shard must not cancel its siblings or their evidence');
assert.match(workflow, /E2E_SHARD:\s*\$\{\{ matrix\.shard \}\}\/4/,
  'each matrix child must pass its shard selector to smoke.mjs');
assert.doesNotMatch(workflow, /elif\s+node\s+src\/e2e\/smoke\.mjs/,
  'CI must never restore the old whole-suite second attempt');
assert.match(workflow, /^\s{2}e2e:\s*\n\s*name:\s*e2e\s*$/m,
  'the exact branch-protection context `e2e` must remain present');
assert.match(workflow, /needs:\s*\[e2e_smoke, e2e_ai_surface\]/,
  'the required e2e context must aggregate both smoke and AI-surface jobs');
assert.match(workflow, /e2e-failure-evidence-shard-\$\{\{ matrix\.shard \}\}/,
  'failure evidence names must be unique per matrix child');

assert.match(workflow, /VITE_E2E_FETCH_TIMEOUT_MS:\s*'5000'/,
  'the throwaway CI artifact must use the short client timeout');
assert.match(app, /resolveReportFetchTimeoutMs\(\s*import\.meta\.env\.VITE_E2E_FETCH_TIMEOUT_MS\s*,?\s*\)/,
  'App.tsx must use a literal Vite env access so the CI value is replaced at build time');
assert.strictEqual(resolveReportFetchTimeoutMs('5000'), 5_000,
  'the CI build must be able to select its five-second timeout');
for (const bad of [undefined, '', '0', '99', '22001', '5000ms', '1e3']) {
  assert.strictEqual(resolveReportFetchTimeoutMs(bad), DEFAULT_REPORT_FETCH_TIMEOUT_MS,
    `${JSON.stringify(bad)} must retain the shipping 22-second timeout`);
}

console.log(`✓ e2e sharding contract: ${definitions.length} named sections across 4 shards, required context preserved`);
