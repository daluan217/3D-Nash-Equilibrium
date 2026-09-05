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
import { selectSmokeSections } from './e2e/selection.js';

const smoke = readFileSync('src/e2e/smoke.mjs', 'utf8');
const workflow = readFileSync('.github/workflows/test.yml', 'utf8');
const liveWorkflow = readFileSync('.github/workflows/live-smoke.yml', 'utf8');
const app = readFileSync('src/App.tsx', 'utf8');

function workflowJob(name: string): string {
  const header = `  ${name}:\n`;
  const start = workflow.indexOf(header);
  assert(start >= 0, `workflow job ${name} must remain present`);
  const rest = workflow.slice(start + header.length);
  const nextJobOffset = rest.search(/^  [a-z0-9_]+:\s*$/m);
  const end = nextJobOffset >= 0 ? start + header.length + nextJobOffset : workflow.length;
  return workflow.slice(start, end);
}

const definitions = [...smoke.matchAll(
  /section\('([^']+)',\s*'([^']+)',\s*([1-4]),\s*async\s*\(\)\s*=>/g,
)].map((match) => ({ id: match[1], name: match[2], shard: Number(match[3]) }));

const expectedIds = [
  '1', '2', '3', '4', '5', '6', '6b', '7', '8', '9', '10', '11', '12',
  '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23',
  '24', '25', '26', '27', '28', '29', '30', '31', '32', '33', '34', '35',
  '36', '37', '38', '39', '40', '41', '42', '43', '44', '45', '46',
];

assert.deepStrictEqual(definitions.map(({ id }) => id), expectedIds,
  'every historical smoke section must be registered exactly once and in order');
assert.strictEqual(new Set(definitions.map(({ name }) => name)).size, definitions.length,
  'section names must be unique so retry output identifies one unit unambiguously');
for (let shard = 1; shard <= 4; shard++) {
  assert(definitions.some((definition) => definition.shard === shard),
    `shard ${shard} must own at least one section`);
}

assert.deepStrictEqual(selectSmokeSections(definitions, {}).selected, definitions,
  'an unset E2E_SHARD/E2E_SECTION must continue to select the complete local suite');
const historicalShard1Ids = ['1', '5', '6', '14', '21', '23', '27', '33', '38', '42', '43'];
assert.deepStrictEqual(selectSmokeSections(definitions, { E2E_SHARD: '1/4' }).selected.map(({ id }) => id),
  historicalShard1Ids,
  'the CI shard selector must retain its historical section assignment');
assert.deepStrictEqual(selectSmokeSections(definitions, { E2E_SECTION: '27,28' }).selected.map(({ id }) => id), ['27', '28'],
  'a local section selector must run exactly the requested H1 regressions');
assert.throws(() => selectSmokeSections(definitions, { E2E_SECTION: '999' }), /unknown E2E_SECTION ID/,
  'a local section selector must reject an identifier that does not name a registered section');
assert.throws(() => selectSmokeSections(definitions, { E2E_SHARD: '   ' }), /E2E_SHARD must not be blank/,
  'a whitespace-only shard must not silently become an unset selector');
assert.throws(() => selectSmokeSections(definitions, { E2E_SECTION: '\t' }), /E2E_SECTION must not be blank/,
  'a whitespace-only section list must not silently become an unset selector');
assert.throws(() => selectSmokeSections(definitions, { E2E_SHARD: '1/4', E2E_SECTION: '27' }), /Set E2E_SHARD or E2E_SECTION, not both/,
  'local section selection and CI shard selection must remain mutually exclusive');
assert.match(smoke, /failed\.push\(definition\)[\s\S]*for \(const definition of failed\)[\s\S]*runSection\(definition, 2\)/,
  'the runner must collect failed sections and retry only that subset once');
assert.match(smoke, /pass-after-section-retry:/,
  'a recovered section retry must be visible in CI output');
assert.match(smoke, /result\.attempt === finalAttemptBySection\.get\(result\.sectionId\)/,
  'the final verdict must use the retry attempt for sections that reran');
assert.match(smoke, /section returned without calling record\(\)/,
  'a retry that accidentally records no checks must fail rather than vanish');
assert.match(smoke, /consoleErrors\.push\(\{[\s\S]*sectionId: activeSection\?\.id \?\? null,[\s\S]*attempt: activeAttempt/,
  'console errors must retain the section attempt that produced them');
assert.match(smoke, /\.filter\(\(error\) => error\.sectionId === null[\s\S]*error\.attempt === finalAttemptBySection\.get\(error\.sectionId\)\)/,
  'console errors from superseded failed attempts must not poison a successful retry');

const resetSection = smoke.match(
  /section\('13', 'reset clears run',[\s\S]*?\n  \}\);/,
)?.[0];
assert(resetSection, 'the Reset section must remain registered');
assert.match(resetSection, /Reset fixture has a completed run to clear/,
  'the Reset section must prove it has non-empty state to clear');
assert.match(resetSection, /for \(let i = 0; i < 40 && !\(lines === 1 && pill === 0\); i\+\+\)/,
  'the Reset section must poll the cleared state instead of relying on a fixed sleep');

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
assert.match(workflow, /e2e_smoke_failure_shard-\$\{\{ matrix\.shard \}\}-of-4_section-\*-attempt-\*\.png/,
  'failure evidence must retain every section attempt and remain unique per matrix child');

assert.match(workflow, /VITE_E2E_FETCH_TIMEOUT_MS:\s*'5000'/,
  'the throwaway CI artifact must use the short client timeout');
const buildJob = workflow.match(/^  build:\s*$[\s\S]*?(?=^  integration:\s*$)/m)?.[0];
assert(buildJob, 'the build job must remain present');
const productionBuildStep = buildJob.match(
  /      - name: Build production bundle\s*$[\s\S]*?(?=^      - name:)/m,
)?.[0];
assert(productionBuildStep, 'the ordinary production build step must remain present');
assert.doesNotMatch(productionBuildStep, /VITE_E2E_FETCH_TIMEOUT_MS/,
  'the production artifact must retain the shipping timeout so live hash verification matches Cloud Build');
const e2eBuildStep = buildJob.match(
  /      - name: Build short-timeout e2e bundle\s*$[\s\S]*?(?=^      - name:)/m,
)?.[0];
assert(e2eBuildStep, 'the separate short-timeout e2e build step must remain present');
assert.match(e2eBuildStep, /VITE_E2E_FETCH_TIMEOUT_MS:\s*'5000'/,
  'only the dedicated e2e artifact should receive the short client timeout');
assert.match(buildJob, /name:\s*dist\s*$[\s\S]*Build short-timeout e2e bundle[\s\S]*name:\s*dist-e2e\s*$/m,
  'the production artifact must be uploaded before the test-only rebuild overwrites dist');
assert.strictEqual((workflow.match(/name:\s*dist-e2e\s*$/gm) ?? []).length, 3,
  'dist-e2e must have one upload and exactly two browser-e2e downloads');
for (const job of [
  workflowJob('e2e_smoke'),
  workflowJob('e2e_ai_surface'),
]) {
  assert.match(job, /name:\s*dist-e2e\s*$/m,
    'both browser E2E jobs must consume the short-timeout artifact');
}
for (const job of [
  workflowJob('integration'),
  workflowJob('mobile'),
]) {
  assert.match(job, /name:\s*dist\s*$/m,
    'integration and mobile must consume the production-equivalent artifact');
  assert.doesNotMatch(job, /name:\s*dist-e2e\s*$/m,
    'the test-only timeout artifact must not leak into integration or mobile');
}
assert.match(liveWorkflow, /LIVE_WAIT_MINUTES:\s*'5'/,
  'deploy verification must stop waiting for an asset after five minutes');
const timeoutInitializer = app.match(
  /const REPORT_FETCH_TIMEOUT_MS = resolveReportFetchTimeoutMs\(\s*([\s\S]*?)\s*,?\s*\);/,
)?.[1];
assert(timeoutInitializer, 'App.tsx must define the report fetch timeout through the bounded resolver');
assert.match(timeoutInitializer,
  /^typeof import\.meta\.env === 'undefined'\s*\?\s*undefined\s*:\s*import\.meta\.env\.VITE_E2E_FETCH_TIMEOUT_MS$/,
  'the literal Vite access must be the guarded expression passed to the resolver');
assert.strictEqual(resolveReportFetchTimeoutMs('5000'), 5_000,
  'the CI build must be able to select its five-second timeout');
for (const bad of [undefined, '', '0', '99', '22001', '5000ms', '1e3']) {
  assert.strictEqual(resolveReportFetchTimeoutMs(bad), DEFAULT_REPORT_FETCH_TIMEOUT_MS,
    `${JSON.stringify(bad)} must retain the shipping 22-second timeout`);
}

console.log(`✓ e2e sharding contract: ${definitions.length} named sections across 4 shards, required context preserved`);
