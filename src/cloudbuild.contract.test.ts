/**
 * Cloud Build → Cloud Run deploy contract.
 *
 * Why this exists: `gcloud run deploy --set-env-vars` REPLACES the service's
 * entire environment. It does not merge. So the single `--set-env-vars` line in
 * cloudbuild.yaml decides, on every push to main, exactly which variables
 * production has — and anything absent from it is deleted from the running
 * service without a single error anywhere.
 *
 * That is not hypothetical. On 2026-08-31 a hand-run
 * `gcloud run services update --set-env-vars` wiped AUTH_SECRET, GCS_BUCKET_NAME,
 * SMTP_* and AZURE_FOUNDRY_* from production for ~12 minutes. The same defect was
 * already sitting latent in this file: cloudbuild.yaml listed 13 variables while
 * the live service ran 16, so the next merge to main would have silently reverted
 * a deliberate feature-flag rollout (the rung-3 report path) and nothing in the
 * test pyramid could see it.
 *
 * These checks are deliberately CREDENTIAL-FREE — they read files, never GCP —
 * so they run in the ordinary `npm test` on every PR. The live counterpart (does
 * the deployed service actually match?) is .github/workflows/cloud-env-audit.yml,
 * which needs GCP credentials and skips cleanly without them.
 */
import { readFileSync } from 'node:fs';

const cloudbuild = readFileSync('cloudbuild.yaml', 'utf8');
const manifest = readFileSync('deploy/cloudrun-env-manifest.txt', 'utf8');

function fail(msg: string): never {
  console.error(`✗ cloudbuild contract: ${msg}`);
  process.exit(1);
}

// ── the expected set of names, from the manifest ────────────────────────────
const expected = new Set(
  manifest
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#')),
);
if (expected.size === 0) fail('deploy/cloudrun-env-manifest.txt lists no variable names');

// ── the actual deploy line ──────────────────────────────────────────────────
const envArg = cloudbuild.match(/^\s*-\s*'--set-env-vars=(.*)'\s*$/m);
if (!envArg) fail('no --set-env-vars argument found in cloudbuild.yaml');
const pairs = envArg[1].split(',');

const names: string[] = [];
const valueOf = new Map<string, string>();
for (const pair of pairs) {
  const eq = pair.indexOf('=');
  if (eq < 1) fail(`malformed entry in --set-env-vars: "${pair}"`);
  const name = pair.slice(0, eq);
  names.push(name);
  valueOf.set(name, pair.slice(eq + 1));
}

// A duplicate key is a silent last-one-wins overwrite in gcloud.
const dupes = names.filter((n, i) => names.indexOf(n) !== i);
if (dupes.length > 0) fail(`--set-env-vars sets these names twice: ${[...new Set(dupes)].join(', ')}`);

// ── the contract: exact set equality, both directions ───────────────────────
const actual = new Set(names);
const missing = [...expected].filter((n) => !actual.has(n));
const unexpected = [...actual].filter((n) => !expected.has(n));
if (missing.length > 0) {
  fail(
    `deploy/cloudrun-env-manifest.txt requires ${missing.join(', ')}, but cloudbuild.yaml `
    + 'does not set them. Because --set-env-vars REPLACES the whole environment, merging '
    + 'this would DELETE those variables from production on the next push to main.',
  );
}
if (unexpected.length > 0) {
  fail(
    `cloudbuild.yaml sets ${unexpected.join(', ')}, which is not in `
    + 'deploy/cloudrun-env-manifest.txt. Add it to the manifest (name only, never a value) '
    + 'so the deployed environment stays a reviewed list.',
  );
}

// ── every ${_SUB} must actually be declared ─────────────────────────────────
// An undeclared substitution resolves to an empty string, which is how a
// variable can be "present" in production and still carry nothing.
const subsBlock = cloudbuild.slice(cloudbuild.indexOf('\nsubstitutions:'));
const declared = new Set([...subsBlock.matchAll(/^ {2}(_[A-Z0-9_]+):/gm)].map((m) => m[1]));
for (const [name, value] of valueOf) {
  const ref = value.match(/^\$\{(_[A-Z0-9_]+)\}$/);
  if (ref && !declared.has(ref[1])) {
    fail(`${name} references ${ref[1]}, which has no entry under substitutions: (it would deploy empty)`);
  }
}

// ── a comma in any substitution default corrupts the whole list ─────────────
// gcloud splits --set-env-vars on commas, so a value containing one silently
// shifts every following variable into a malformed pair.
for (const m of subsBlock.matchAll(/^ {2}(_[A-Z0-9_]+):\s*'([^']*)'\s*$/gm)) {
  if (m[2].includes(',')) {
    fail(`substitution ${m[1]} default contains a comma; gcloud would split --set-env-vars on it`);
  }
}

// ── the rung-3 report configuration must be literal, not substituted ────────
// These are feature flags, not secrets. As literals they cannot be blanked by
// an empty value in the Cloud Build trigger UI — which is exactly how
// REPORT_MODEL sat empty in production while falling back to gpt-5.4-mini.
const RUNG3_LITERALS: Record<string, string> = {
  NASH_PAYOFF_TEMPLATE: '1',
  NASH_LLM_TIES: 'template',
  NASH_DIRECTION_CHECKS: '1',
};
for (const [name, want] of Object.entries(RUNG3_LITERALS)) {
  const got = valueOf.get(name);
  if (got !== want) {
    fail(
      `${name} must deploy as the literal "${want}" (got "${got}"). The rung-3 report path `
      + 'is live in production; a substitution here can be silently blanked by the trigger UI.',
    );
  }
}

// ── REPORT_MODEL must resolve to something ──────────────────────────────────
// Empty is not an error at deploy time — the server just falls back to
// DEFAULT_MODEL and nobody can tell from the outside.
const reportModel = valueOf.get('REPORT_MODEL') ?? '';
const reportRef = reportModel.match(/^\$\{(_[A-Z0-9_]+)\}$/);
if (reportRef) {
  const def = subsBlock.match(new RegExp(`^ {2}${reportRef[1]}:\\s*'([^']*)'\\s*$`, 'm'));
  if (!def || def[1].trim() === '') {
    fail(
      `REPORT_MODEL resolves to ${reportRef[1]}, whose default is empty. A deploy would fall `
      + 'back to DEFAULT_MODEL in src/utils/report.ts with no visible signal. Give it a real default.',
    );
  }
} else if (reportModel.trim() === '') {
  fail('REPORT_MODEL deploys empty; the report route would silently fall back to DEFAULT_MODEL');
}

console.log(
  `✓ cloudbuild contract: ${actual.size} env names match deploy/cloudrun-env-manifest.txt; `
  + 'rung-3 flags literal, REPORT_MODEL non-empty, substitutions all declared',
);
