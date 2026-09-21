/**
 * Every src/*.test.ts file must be wired into package.json's `test` script,
 * or CI's "unit" job silently never runs it and its checks enforce nothing.
 * This is the exact gap that shipped twice: src/modalsurface.test.ts (#149)
 * and src/savedgameslist.test.ts (#150) both landed unexecuted — caught only
 * by an adversarial review after merge, not by CI (OPUS-REVIEW-LIST B2,
 * round14).
 *
 *   npx tsx src/testscriptcoverage.test.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { load: loadYaml } = require('js-yaml') as { load: (source: string) => unknown };
type AnyRecord = Record<string, unknown>;

/** Return an object view only for a non-array mapping. */
const recordOf = (value: unknown): AnyRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : {};

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
};

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const testScript: string = pkg.scripts.test;
const integrationScript: string = pkg.scripts['test:integration'];
const ciWorkflow = readFileSync('.github/workflows/test.yml', 'utf8');
const files = readdirSync('src').filter((f) => f.endsWith('.test.ts')).sort();

// CodeRabbit on #150: a bare `.includes(filename)` passes for ANY textual
// occurrence — a filename left behind in a comment, or named in an unrelated
// `echo`, would "wire" a test CI never actually runs. Require an executable
// `tsx src/<file>` invocation specifically.
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isWiredIn = (script: string, file: string): boolean =>
  new RegExp(`(?:^|&&\\s*)tsx\\s+src/${escapeRegex(file)}(?=\\s|$)`).test(script);
const isWired = (file: string): boolean => isWiredIn(testScript, file);

// A count is not coverage (this campaign's own repeated lesson) — list every
// missing file by name, not just "N missing".
const missing = files.filter((file) => !isWired(file));
check(`every src/*.test.ts file is wired into package.json's test script as an executable tsx invocation`,
  missing.length === 0, `missing: ${missing.join(', ') || '(none)'}`);

// Sanity: this guard is not vacuously true because `files` came back empty.
check('found a plausible number of test files (this repo has 30+)', files.length >= 30, `found ${files.length}`);

// MUTATION FIXTURE — sanity: dropping ONE real, currently-wired file's
// invocation from a COPY of the script must be caught by the same check
// (proves the substring-membership check actually inspects the file list,
// not just its own length).
{
  const wiredFile = files.find((f) => isWired(f));
  check('fixture precondition: at least one real file is currently wired (so removing it is a real mutation)', !!wiredFile, JSON.stringify(wiredFile));
  if (wiredFile) {
    const invocation = new RegExp(`(?:&&\\s*)?tsx\\s+src/${escapeRegex(wiredFile)}\\b`);
    // (a) Actually removing the invocation is caught.
    const mutatedScript = testScript.replace(invocation, '');
    check(`fixture sanity: removing "${wiredFile}"'s invocation from a copy of the script IS detected as missing`,
      !isWiredIn(mutatedScript, wiredFile));
    // (b) The exact regression CodeRabbit's finding named: the filename left
    // behind as inert TEXT (e.g. a stray `echo` or comment) with its REAL
    // `tsx src/...` invocation removed must still count as missing — a bare
    // `.includes()` would have been fooled by this, since the name is still
    // textually present in the script.
    const textOnlyScript = testScript.replace(invocation, `&& echo ${wiredFile}`);
    check(`fixture sanity: "${wiredFile}" named only as inert text (its invocation replaced by a bare echo) is STILL flagged as missing`,
      !isWiredIn(textOnlyScript, wiredFile) && textOnlyScript.includes(wiredFile));
  }
}

// The development middleware boundary is not exercised by the production
// bundle's API suite. Keep its real-server guard in both the local integration
// command and CI's required `integration` job; a filename in prose is not
// enough.
const devFallback = 'src/integration/api-dev-fallback.test.mjs';
const integrationInvocation = new RegExp(`(?:^|&&\\s*)node\\s+${escapeRegex(devFallback)}(?=\\s*(?:&&|$))`);
const workflowInvocation = new RegExp(`^\\s*node\\s+${escapeRegex(devFallback)}\\s*$`);
/** Parse one named workflow job and return only its actual step run values. */
const workflowJobRuns = (workflow: string, jobName: string): string[] => {
  const document = recordOf(loadYaml(workflow));
  const job = recordOf(recordOf(document.jobs)[jobName]);
  const steps = Array.isArray(job.steps) ? job.steps.map(recordOf) : [];
  return steps.map((step) => step.run).filter((run): run is string => typeof run === 'string');
};
/** Require the exact fallback-test command in an executable integration-job run value. */
const workflowRunsDevFallback = (workflow: string): boolean =>
  workflowJobRuns(workflow, 'integration').some((run) => workflowInvocation.test(run));
check('the dev API fallback behavioral guard runs in npm run test:integration',
  integrationInvocation.test(integrationScript));
for (const bypass of [' || true', ' --changed-semantics', '; true']) {
  check(`mutation: appending ${JSON.stringify(bypass)} cannot masquerade as the required local command`,
    !integrationInvocation.test(`node ${devFallback}${bypass}`));
}
check('the dev API fallback behavioral guard runs in the required GitHub integration job',
  workflowRunsDevFallback(ciWorkflow));
const workflowWithoutDevGuard = ciWorkflow.replace(
  `run: node ${devFallback}`,
  'run: echo removed-mutant',
);
check('mutation: removing the dev API fallback command from CI is detected',
  !workflowRunsDevFallback(workflowWithoutDevGuard));
const unrelatedJobDecoy = `${workflowWithoutDevGuard}\n  optional-decoy: # inline comments cannot hide a job boundary\n    runs-on: ubuntu-latest\n    steps:\n      - name: Decoy outside integration\n        run: node ${devFallback}`;
check('mutation: the command in a different workflow job cannot satisfy the required integration-job guard',
  workflowJobRuns(unrelatedJobDecoy, 'optional-decoy').some((run) => workflowInvocation.test(run))
  && !workflowRunsDevFallback(unrelatedJobDecoy));

// EVERY integration suite, not one named file. The rules above guard
// api-dev-fallback by name, so the other 27 were unchecked — and three were
// dead: atomic-tmp-sweep and cloud-output-boundary were in test:integration but
// absent from test.yml, and desktop-adopt-local (19 checks) was in NEITHER, so
// it had never run in CI at all. No workflow invokes `npm run test:integration`,
// so test.yml's per-file list is the ONLY path to CI; a suite missing from it
// enforces nothing, exactly like a probe left under _gen/.
const integrationFiles = readdirSync('src/integration')
  .filter((f) => f.endsWith('.test.mjs')).sort();
const ciIntegrationRuns = workflowJobRuns(ciWorkflow, 'integration').join('\n');
// A suite that needs a PACKAGED .app cannot run in the ubuntu `integration`
// job — there is no macOS runner there and no built artifact — so
// desktop-packaged-smoke runs in `package-audit`, the macOS job that builds
// the artifact.
//
// AND THAT JOB IS A GATE: `package-audit` is one of main's required status
// checks. VERIFIED against branch protection —
//   unit, build, e2e, integration, container, mobile, package-audit
// so a red result there blocks a merge exactly as the integration job does,
// and the exemption below costs no enforcement. (It was NOT required when
// this exemption was first written; that earlier claim was wrong, which is
// why the set is quoted here rather than assumed.)
//
// The allowance is deliberately narrow: only that one file, and only in that
// one job, so it cannot become a general escape hatch for a suite that simply
// was not wired up.
const PACKAGED_JOB = 'package-audit';
const PACKAGED_ONLY = new Set(['desktop-packaged-smoke.test.mjs']);
const ciPackagedRuns = workflowJobRuns(ciWorkflow, PACKAGED_JOB).join('\n');
const runsInJob = (file: string, runs: string): boolean =>
  new RegExp(`(?:^|&&\\s*|\\n\\s*)node\\s+src/integration/${escapeRegex(file)}(?=\\s|$)`, 'm')
    .test(runs);
const runsInCi = (file: string): boolean =>
  runsInJob(file, ciIntegrationRuns)
  || (PACKAGED_ONLY.has(file) && runsInJob(file, ciPackagedRuns));
const notInCi = integrationFiles.filter((f) => !runsInCi(f));
check('every src/integration/*.test.mjs runs in the required GitHub integration job',
  notInCi.length === 0,
  `never executed by CI: ${JSON.stringify(notInCi)}. test.yml's per-file list is the only path — `
  + 'no workflow runs `npm run test:integration`.');
check('the integration-file discovery found the suites it claims to cover',
  integrationFiles.length >= 25, `found only ${integrationFiles.length}`);
// SELF-TEST: the matcher must fail for a file CI does not run, or the clean
// result above is just a regex that matches everything.
check('SELF-TEST: a suite absent from the integration job is reported',
  !runsInCi('definitely-not-a-real-suite.test.mjs'));
check('SELF-TEST: a suite the job really runs is recognised',
  runsInCi('api.test.mjs'));
// The packaged-app allowance must be exactly that — an allowance for a suite
// that IS wired into package-audit, not a hole any file can fall through.
for (const file of PACKAGED_ONLY) {
  check(`SELF-TEST: ${file} really is wired into the ${PACKAGED_JOB} job`,
    runsInJob(file, ciPackagedRuns),
    `it is exempt from the integration job, so if it is not in ${PACKAGED_JOB} it runs nowhere`);
}
check('SELF-TEST: the packaged-app allowance does not excuse an ordinary suite',
  !runsInCi('definitely-not-a-real-suite.test.mjs')
  && !runsInJob('api.test.mjs', ciPackagedRuns));

if (failures > 0) { console.error(`✗ test-script coverage: ${failures} failed`); process.exit(1); }
console.log(`✓ test-script coverage: ${files.length} unit files wired; dev API fallback wired locally and in CI`);
