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
const integrationInvocation = new RegExp(`(?:^|&&\\s*)node\\s+${escapeRegex(devFallback)}(?=\\s|$)`);
const workflowInvocation = new RegExp(`^\\s*run:\\s*node\\s+${escapeRegex(devFallback)}\\s*$`, 'm');
const workflowJob = (workflow: string, jobName: string): string => {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  if (start < 0) return '';
  const next = lines.findIndex((line, index) => index > start && /^  [A-Za-z0-9_-]+:\s*$/.test(line));
  return lines.slice(start, next < 0 ? undefined : next).join('\n');
};
const integrationJob = workflowJob(ciWorkflow, 'integration');
check('the dev API fallback behavioral guard runs in npm run test:integration',
  integrationInvocation.test(integrationScript));
check('the dev API fallback behavioral guard runs in the required GitHub integration job',
  workflowInvocation.test(integrationJob));
const workflowWithoutDevGuard = integrationJob.replace(workflowInvocation, '        run: echo removed-mutant');
check('mutation: removing the dev API fallback command from CI is detected',
  !workflowInvocation.test(workflowWithoutDevGuard));
const unrelatedJobDecoy = `${workflowWithoutDevGuard}\n  optional-decoy:\n    steps:\n      - name: Decoy outside integration\n        run: node ${devFallback}`;
check('mutation: the command in a different workflow job cannot satisfy the required integration-job guard',
  workflowInvocation.test(unrelatedJobDecoy) && !workflowInvocation.test(workflowJob(unrelatedJobDecoy, 'integration')));

if (failures > 0) { console.error(`✗ test-script coverage: ${failures} failed`); process.exit(1); }
console.log(`✓ test-script coverage: ${files.length} unit files wired; dev API fallback wired locally and in CI`);
