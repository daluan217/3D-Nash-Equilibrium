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
import { selectSmokeSections, assignShards, measuredMs, validateTimings, SHARD_COUNT, SHARD_TIMINGS, SECTION_BUDGET_MS } from './e2e/selection.js';

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

const definitions: { id: string; name: string; shard?: number }[] = [...smoke.matchAll(
  /section\('([^']+)',\s*'([^']+)',\s*async\s*\(\)\s*=>/g,
)].map((match) => ({ id: match[1], name: match[2] }));
assert(!/section\('[^']+',\s*'[^']*',\s*\d+,\s*async/.test(smoke),
  'sections no longer name a shard by hand — selection.js packs them from shard-timings.json');

const expectedIds = [
  '1', '2', '3', '4', '5', '6', '6b', '7', '8', '9', '10', '11', '12',
  '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23',
  '24', '25', '26', '27', '28', '29', '30', '31', '32', '33', '34', '35',
  '36', '37', '38', '39', '40', '41', '42', '43', '44', '45', '46', '47', '50',
  '51', '52', '53', '54', '56', '57', '60', '61', '62', '66', '66b', '67', '68', '69', '70', '71', '74', '78',
];

assert.deepStrictEqual(definitions.map(({ id }) => id), expectedIds,
  'every historical smoke section must be registered exactly once and in order');
assert.strictEqual(new Set(definitions.map(({ name }) => name)).size, definitions.length,
  'section names must be unique so retry output identifies one unit unambiguously');
assert.strictEqual(SHARD_COUNT, 28, 'the smoke suite is split into 28 CI shards (test.yml matrix must match)');

// ── Packing by measured duration ─────────────────────────────────────────────
// Every section needs a MEASURED entry: an unmeasured one is packed at _default
// and fails here until someone runs scripts/shard-timings-from-run.mjs (or adds
// a local measurement) — the point is that no section is placed by guess.
for (const { id } of definitions) {
  assert(typeof SHARD_TIMINGS[id] === 'number',
    `section ${id} has no entry in src/e2e/shard-timings.json — measure it (SECTION-PASS ms) and add it`);
}
for (const id of Object.keys(SHARD_TIMINGS).filter((k) => !k.startsWith('_'))) {
  assert(definitions.some((d) => d.id === id), `shard-timings.json names section ${id}, which no longer exists — remove it`);
}
const { totals } = assignShards(definitions);
for (let shard = 1; shard <= SHARD_COUNT; shard++) {
  assert(definitions.some((definition) => definition.shard === shard), `shard ${shard} must own at least one section`);
  assert(totals[shard - 1] <= SECTION_BUDGET_MS,
    `shard ${shard} packs ${Math.round(totals[shard - 1] / 1000)} s of measured sections, over the ${SECTION_BUDGET_MS / 1000} s budget `
    + `(300 s job ceiling minus ~75 s overhead) — split the longest section or raise SHARD_COUNT (and test.yml's matrix)`);
}
// Headroom: CI ran ~5% slower than the table the first 20-shard matrix was packed from (285 s on a
// 207 s-packed shard). Keep every packed shard ≤ 200 s so that slack cannot reach the 225 s budget.
assert(Math.max(...totals) <= 200000, `the heaviest packed shard is ${Math.round(Math.max(...totals) / 1000)} s — over the 200 s headroom line; raise SHARD_COUNT`);
for (const { id } of definitions) {
  assert(measuredMs(id) <= SECTION_BUDGET_MS,
    `section ${id} alone measures ${Math.round(measuredMs(id) / 1000)} s — over the per-job budget; split it (as 66 → 66/66b)`);
}
// Deterministic: the runner in CI and this test must agree on the assignment.
const again = assignShards(definitions.map(({ id, name }) => ({ id, name })));
assert.deepStrictEqual(again.definitions.map((d) => d.shard), definitions.map((d) => d.shard), 'shard assignment must be deterministic');
// Known positives: the budget guard fires on an over-long section and on an over-packed table.
{
  const fake = { _default: 90000, _overhead_ms: 75000, _ceiling_ms: 300000, a: 260000, b: 1000 };
  const packed = assignShards([{ id: 'a' }, { id: 'b' }], fake, 2);
  assert(Math.max(...packed.totals) > SECTION_BUDGET_MS, 'a 260 s section must exceed the 225 s budget (known positive)');
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`s${i}`, 120000]));
  const over = assignShards(Object.keys(many).map((id) => ({ id })), { ...fake, ...many }, 20);
  assert(Math.max(...over.totals) > SECTION_BUDGET_MS, 'forty 120 s sections cannot fit 20 shards under budget (known positive)');
  assert(assignShards([{ id: 'zz' }], fake, 1).totals[0] === 90000, 'an unmeasured section packs at _default');
  // validateTimings (shared with scripts/shard-timings-from-run.mjs) rejects the two bad-table shapes
  // CodeRabbit named on #157: a pre-split run's table (66 at 275 s, no 66b) and an incomplete one.
  const meta = { _default: 90000, _overhead_ms: 75000, _ceiling_ms: 300000 };
  assert.deepStrictEqual(validateTimings(['66', '66b'], { ...meta, '66': 275000 }),
    ['section 66 measures 275 s, over the 225 s per-job section budget — split it', 'section 66b has no measured entry'],
    'a pre-split run\'s table (66 at 275 s, no 66b) must report both problems');
  assert.deepStrictEqual(validateTimings(['1'], { ...meta, '1': 1000, '2': 1000 }), ['timings name section 2, which is not registered']);
  assert.deepStrictEqual(validateTimings(['1'], { ...meta, '1': 1000 }), [], 'a complete, in-budget table is accepted');
}
assert.deepStrictEqual(validateTimings(definitions.map(({ id }) => id)), [], 'the checked-in timings table must be complete and in budget');

assert.deepStrictEqual(selectSmokeSections(definitions, {}).selected, definitions,
  'an unset E2E_SHARD/E2E_SECTION must continue to select the complete local suite');
// A shard selector returns exactly the packed assignment's members.
const shard1Now = selectSmokeSections(definitions, { E2E_SHARD: '1/28' }).selected.map(({ id }) => id);
assert.deepStrictEqual(shard1Now, definitions.filter((d) => d.shard === 1).map(({ id }) => id),
  'E2E_SHARD must select exactly the sections the packing assigned to that shard');
assert.deepStrictEqual(selectSmokeSections(definitions, { E2E_SECTION: '27,28' }).selected.map(({ id }) => id), ['27', '28'],
  'a local section selector must run exactly the requested H1 regressions');
assert.throws(() => selectSmokeSections(definitions, { E2E_SECTION: '999' }), /unknown E2E_SECTION ID/,
  'a local section selector must reject an identifier that does not name a registered section');
assert.throws(() => selectSmokeSections(definitions, { E2E_SHARD: '   ' }), /E2E_SHARD must not be blank/,
  'a whitespace-only shard must not silently become an unset selector');
assert.throws(() => selectSmokeSections(definitions, { E2E_SECTION: '\t' }), /E2E_SECTION must not be blank/,
  'a whitespace-only section list must not silently become an unset selector');
assert.throws(() => selectSmokeSections(definitions, { E2E_SHARD: '1/28', E2E_SECTION: '27' }), /Set E2E_SHARD or E2E_SECTION, not both/,
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
const matrixList = Array.from({ length: SHARD_COUNT }, (_, i) => i + 1).join(', ');
assert.match(workflow, new RegExp(`matrix:\\s*\\n\\s*shard:\\s*\\[${matrixList}\\]`),
  `CI must fan smoke out across all ${SHARD_COUNT} declared shards`);
assert.match(workflow, /fail-fast:\s*false/,
  'one failed shard must not cancel its siblings or their evidence');
assert.match(workflow, new RegExp(`E2E_SHARD:\\s*\\$\\{\\{ matrix\\.shard \\}\\}/${SHARD_COUNT}`),
  'each matrix child must pass its shard selector to smoke.mjs');
assert.doesNotMatch(workflow, /elif\s+node\s+src\/e2e\/smoke\.mjs/,
  'CI must never restore the old whole-suite second attempt');
assert.match(workflow, /^\s{2}e2e:\s*\n\s*name:\s*e2e\s*$/m,
  'the exact branch-protection context `e2e` must remain present');
assert.match(workflow, /needs:\s*\[e2e_smoke, e2e_ai_surface\]/,
  'the required e2e context must aggregate both smoke and AI-surface jobs');
assert.match(workflow, new RegExp(`e2e_smoke_failure_shard-\\$\\{\\{ matrix\\.shard \\}\\}-of-${SHARD_COUNT}_section-\\*-attempt-\\*\\.png`),
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

console.log(`✓ e2e sharding contract: ${definitions.length} named sections across ${SHARD_COUNT} shards, required context preserved`);
