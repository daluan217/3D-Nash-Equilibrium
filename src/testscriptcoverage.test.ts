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
// SR-47: a suite that silently skips a block still prints "N/N checks passed"
// and exits 0, because N is counted rather than expected. Measured on
// desktop-dead-token-owner: filtering one data array to empty removed six
// checks and the run reported "37/37 checks passed" with rc=0. So every
// integration suite must DECLARE its floor; this is what stops the next one
// landing without it.
// Enforced today for the desktop/electron surface, where the defect was
// measured and every floor was calibrated by running the suite. The other 15
// integration suites have the identical footer and the identical exposure;
// they belong to other owners, so they are NAMED here rather than quietly
// excluded — widen the prefix list as each surface calibrates its own floor.
const FLOORED_PREFIXES = ['desktop-', 'electron-', 'atomic-', 'dmg-'];
const needsFloor = integrationFiles.filter((f) => FLOORED_PREFIXES.some((p) => f.startsWith(p)));
// Gate review #8, finding 2: this was `.includes('EXPECTED_CHECKS')`, so a
// comment naming the constant satisfied it while the file had no floor —
// "pattern present, behaviour absent", the very shape this branch closes.
// Three things are now required: the DECLARATION, a COMPARISON against it,
// and a process.exit(1) reachable from that comparison. Require executable
// line-start syntax and the real counter shape: a string/comment/decoy branch
// is not a floor.
const floorShape = (source: string): { declares: boolean; compares: boolean; exits: boolean } => {
  // The declaration is executable only if it begins a line; a comment/string
  // cannot satisfy this. The comparison must use one of this surface's actual
  // counters and occur AFTER the declaration, so a decoy branch cannot hide a
  // missing floor. Its body must contain the non-zero exit.
  const declaration = source.match(/^\s*const EXPECTED_CHECKS = ([1-9]\d*);/m);
  if (!declaration) return { declares: false, compares: false, exits: false };
  const rest = source.slice((declaration.index ?? 0) + declaration[0].length);
  const cmp = rest.match(
    /^([ \t]*)if \(((?:results|out)\.length|total|checks) (?:<|!==) EXPECTED_CHECKS\) \{\n([\s\S]{0,400}?)\n\1\}/m);
  return { declares: true, compares: cmp !== null, exits: cmp !== null && /\bprocess\.exit\(1\)/.test(cmp[3]) };
};
const floorBroken = needsFloor
  .map((f) => [f, floorShape(readFileSync(`src/integration/${f}`, 'utf8'))] as const)
  .filter(([, s]) => !s.declares || !s.compares || !s.exits);
check('every desktop/electron integration suite declares an EXPECTED_CHECKS floor AND acts on it',
  floorBroken.length === 0,
  'a floor that is only mentioned enforces nothing: '
  + JSON.stringify(floorBroken.map(([f, s]) => ({ f, ...s }))));
// SELF-TEST: the three sub-conditions must each be able to fail, or the check
// above is a regex that matches everything.
check('SELF-TEST: a file that only MENTIONS EXPECTED_CHECKS is rejected',
  !floorShape('// EXPECTED_CHECKS is a great idea\nconsole.log("done");').declares);
check('SELF-TEST: a declaration with no comparison is rejected',
  floorShape('const EXPECTED_CHECKS = 7;\nconsole.log(EXPECTED_CHECKS);').declares
  && !floorShape('const EXPECTED_CHECKS = 7;\nconsole.log(EXPECTED_CHECKS);').compares);
check('SELF-TEST: a comparison that does not exit non-zero is rejected',
  !floorShape('const EXPECTED_CHECKS = 7;\nif (total < EXPECTED_CHECKS) {\n  console.warn("hm");\n}').exits);
check('SELF-TEST: a real floor is accepted',
  Object.values(floorShape('const EXPECTED_CHECKS = 7;\n'
    + 'if (total !== EXPECTED_CHECKS) {\n  console.error("x");\n  process.exit(1);\n}')).every(Boolean));
check('SELF-TEST: the floor rule covers the suites it claims to',
  needsFloor.length >= 21, `only ${needsFloor.length} suites matched ${JSON.stringify(FLOORED_PREFIXES)}`);
const stillExposed = integrationFiles.filter((f) => !needsFloor.includes(f));
console.log(`  note: ${stillExposed.length} integration suites outside the desktop surface still count `
  + `rather than declare their checks (owners: see SR-47): ${stillExposed.join(', ')}`);

// S58: a readiness poll that accepts ANY `ok` answer on its port will happily
// drive a process the suite never spawned. Measured twice on this branch:
//   - gate review #8 finding 6 (desktop-adopt-deadsession shared 3119 with an
//     earlier step) — with a second REAL app server on the port the suite ran
//     19/19 GREEN against the foreign one;
//   - atomic-tmp-sweep, handed port 5000, which macOS ControlCenter holds:
//     it reported "server started" and "healthy and serving normally" (200)
//     while ACCUSING THE PRODUCT of failing to sweep an orphan file the
//     foreign server had never been given.
// `/api/health` returns `pid` for exactly this (server.ts says so at the
// route). So: every desktop-surface suite that polls it must compare that pid
// against its own child. This is the guard that would have caught both.
// The shape that matters is a READINESS POLL: `/api/health` fetched on a
// port the suite chose, in a retry loop. desktop-packaged-smoke also names
// /api/health, but INSIDE the packaged renderer (`win.evaluate`) as a
// same-origin control — it launches through Playwright and never polls a
// port, so there is no foreign listener to confuse it. Requiring a pid there
// would be a guard widened past its own reason, so the predicate asks for the
// template-literal-on-a-base form the poll loops actually use.
// A READINESS POLL is the shape that matters: /api/health fetched inside a
// RETRY LOOP, which is how a suite decides its server is up. One-shot probes
// ("is the old instance still listening?") and the same-origin control inside
// desktop-packaged-smoke's renderer are not readiness decisions — that suite
// launches through Playwright and polls no port at all, so requiring a pid
// there would widen the rule past its own reason. Match a `for`/`while` whose
// body fetches /api/health.
// A READINESS POLL is the shape that matters: /api/health fetched inside a
// RETRY LOOP, which is how a suite decides its own server is up. One-shot
// probes ("is the old instance still listening?") and the same-origin control
// inside desktop-packaged-smoke's renderer are not readiness decisions — that
// suite launches through Playwright and polls no port at all, so requiring a
// pid there would widen this rule past its own reason. A line window beats a
// brace-matching regex here: the bodies nest objects and template literals,
// which a regex cannot balance (measured — the nested-brace attempt matched 0).
const pollsHealth = (source: string): boolean => {
  const lines = source.split('\n');
  return lines.some((line, i) => /^\s*(?:for|while)\s*\(/.test(line)
    && lines.slice(i + 1, i + 12).some((l) => /\/api\/health/.test(l) && !/^\s*\/\//.test(l)));
};
const BINDS_PID = /\?\.pid === \w+\.pid|\)\.pid === \w+\.pid/;
const healthPollers = needsFloor
  .map((f) => [f, readFileSync(`src/integration/${f}`, 'utf8')] as const)
  .filter(([, src]) => pollsHealth(src));
const unboundPollers = healthPollers.filter(([, src]) => !BINDS_PID.test(src));
check('every desktop-surface suite that polls /api/health binds the answer to its OWN child pid',
  unboundPollers.length === 0,
  'a stray listener on the port (another step\'s leaked server, or macOS '
  + 'ControlCenter on 5000) answers `ok` and the suite measures a process it never '
  + `spawned: ${JSON.stringify(unboundPollers.map(([f]) => f))}`);
check('SELF-TEST: the health-poll rule is scanning real suites, not an empty list',
  healthPollers.length >= 12, `only ${healthPollers.length} suites poll /api/health`);
check('SELF-TEST: an unbound poll is REJECTED',
  !BINDS_PID.test('const r = await fetch(`${BASE}/api/health`);\nif (r.ok) return true;'));
check('SELF-TEST: a pid-bound poll is ACCEPTED',
  BINDS_PID.test('if (r.ok && (await r.json())?.pid === child.pid) return true;')
  && BINDS_PID.test('if (health.ok && (await health.json())?.pid === server.pid) return;'));

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
