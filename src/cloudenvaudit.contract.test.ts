/**
 * Credential-free contract for the deployed-environment audit workflow.
 *
 * This protects the audit itself: it must inspect metadata without reading
 * secret values, and every Actions step that needs the service description
 * must fetch it in that step's own shell.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/cloud-env-audit.yml', 'utf8');
// Contract assertions describe executable YAML, never prose. A commented-out
// credential block must not satisfy a required check, and an explanatory
// warning must not trip a forbidden-credential check.
const executable = workflow.replace(/^\s*#.*$/gm, '');

/** Report a cloud environment audit contract violation and terminate the test. */
function fail(message: string): never {
  console.error(`✗ cloud env audit contract: ${message}`);
  process.exit(1);
}

if (!/id-token:\s*write/.test(executable)) {
  fail('workflow must retain id-token: write for the preferred WIF path');
}
if (!/google-github-actions\/auth@v2/.test(executable)
    || !/workload_identity_provider:\s*\$\{\{ secrets[.]GCP_AUDIT_WIF_PROVIDER \}\}/.test(executable)
    || !/service_account:\s*\$\{\{ secrets[.]GCP_AUDIT_SERVICE_ACCOUNT \}\}/.test(executable)) {
  fail('workflow must use the dedicated audit Workload Identity Federation credentials');
}
if (/credentials_json:|GCP_SA_KEY|steps[.]creds|mode=(?:none|key)|skipping the live env audit/i.test(executable)) {
  fail('live audit must fail closed and must not fall back to a long-lived service-account key');
}
if (!/src\/deploy\/env-audit\.mjs/.test(executable)) {
  fail('workflow must invoke the reviewed environment manifest audit');
}

// Environment reads must use Cloud API's server-side partial-response mask.
// `gcloud --format` is only a client-side renderer: the full resource (and its
// literal payloads) reaches the runner first. Ignore explanatory comments.
if (/gcloud\s+run\s+(?:services|revisions)\s+(?:describe|list)|--format(?:=|\s)/.test(executable)) {
  fail('workflow must not fetch full Cloud Run resources and filter them locally with gcloud');
}
const serviceFields = /^\s*SERVICE_FIELDS:\s*(\S+)\s*$/m.exec(executable)?.[1]?.split(',') ?? [];
const revisionFields = /^\s*REVISION_FIELDS:\s*(\S+)\s*$/m.exec(executable)?.[1]?.split(',') ?? [];
const allowedServiceFields = new Set([
  'template.containers.env.name',
  'template.containers.env.valueSource.secretKeyRef',
  'traffic.type',
  'traffic.revision',
  'traffic.percent',
  'trafficStatuses.type',
  'trafficStatuses.revision',
  'trafficStatuses.percent',
  'latestReadyRevision',
]);
const allowedRevisionFields = new Set([
  'containers.env.name',
  'containers.env.valueSource.secretKeyRef',
]);
const isExactSafeMask = (fields: string[], allowed: Set<string>): boolean =>
  fields.length === allowed.size
  && new Set(fields).size === fields.length
  && fields.every((field) => allowed.has(field));
if (!isExactSafeMask(serviceFields, allowedServiceFields)
    || !isExactSafeMask(revisionFields, allowedRevisionFields)) {
  fail('server-side response masks must contain exactly the reviewed safe leaf fields');
}
// Parent paths select whole nested objects under Google partial-response
// semantics. Prove the allowlist rejects that credential-exposure shape, as
// well as an unreviewed leaf and a duplicate that could mask an omission.
assert.equal(isExactSafeMask(
  serviceFields.map((field) => field === 'template.containers.env.name' ? 'template.containers.env' : field),
  allowedServiceFields,
), false, 'a broad EnvVar parent mask must be rejected');
assert.equal(isExactSafeMask([...revisionFields, 'containers.env.value'], allowedRevisionFields), false,
  'an unreviewed payload leaf must be rejected');
assert.equal(isExactSafeMask([...serviceFields.slice(1), serviceFields[1]], allowedServiceFields), false,
  'a duplicate field cannot hide an omitted reviewed field');
if (!/RUN_API:\s*https:\/\/run[.]googleapis[.]com\/v2/.test(executable)
    || !/--data-urlencode\s+"fields=\$fields"/.test(executable)
    || !/src\/deploy\/cloud-run-traffic[.]mjs/.test(executable)) {
  fail('workflow must use Cloud Run v2 REST fields masks and the reviewed traffic helper');
}
if (/access_token=\$\(gcloud auth print-access-token\s+2>&1\)|echo\s+"\$access_token"/.test(executable)) {
  fail('workflow must not merge token-mint diagnostics into the bearer token or print that token');
}

const commentOnlyRequiredMutant = [
  '# id-token: write',
  '# uses: google-github-actions/auth@v2',
  '# workload_identity_provider: ${{ secrets.GCP_AUDIT_WIF_PROVIDER }}',
  '# service_account: ${{ secrets.GCP_AUDIT_SERVICE_ACCOUNT }}',
  '# node src/deploy/env-audit.mjs',
].join('\n').replace(/^\s*#.*$/gm, '');
assert.equal(/id-token:\s*write|google-github-actions\/auth@v2|src\/deploy\/env-audit[.]mjs/.test(commentOnlyRequiredMutant), false,
  'commented-out authentication and audit commands cannot satisfy executable workflow guards');
const forbiddenCredentialCommentControl = `${workflow}\n# credentials_json: GCP_SA_KEY; mode=key; skipping the live env audit`
  .replace(/^\s*#.*$/gm, '');
assert.equal(/credentials_json:|GCP_SA_KEY|mode=(?:none|key)|skipping the live env audit/i.test(forbiddenCredentialCommentControl), false,
  'an explanatory comment cannot trip the executable forbidden-credential guard');

const names = readFileSync('deploy/cloudrun-env-manifest.txt', 'utf8')
  .split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
const refs = new Map([
  ['SMTP_USER', ['nash-equilibrium-smtp-user', '1']],
  ['SMTP_PASS', ['nash-equilibrium-smtp-pass', '1']],
  ['ADMIN_SECRET', ['nash-equilibrium-admin-secret', '1']],
  ['AUTH_SECRET', ['nash-equilibrium-auth-secret', '1']],
  ['AZURE_FOUNDRY_API_KEY', ['nash-equilibrium-azure-foundry-api-key', '1']],
]);
const fixtureEntries = names.map((name) => {
  const ref = refs.get(name);
  return ref ? { name, valueSource: { secretKeyRef: { secret: ref[0], version: ref[1] } } } : { name };
});
const fixture = { template: { containers: [{ env: fixtureEntries }] } };
const runAudit = (input: unknown) => spawnSync(
  process.execPath,
  ['src/deploy/env-audit.mjs'],
  { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' },
);

const control = runAudit(fixture);
assert.equal(control.status, 0, control.stderr || control.stdout);

const literalMutant = { template: { containers: [{ env: fixtureEntries.map((entry) =>
  entry.name === 'AUTH_SECRET' ? { name: entry.name } : entry) }] } };
const literalResult = runAudit(literalMutant);
assert.notEqual(literalResult.status, 0, 'a literal AUTH_SECRET source must fail the live audit');
assert.match(literalResult.stdout + literalResult.stderr, /AUTH_SECRET/);

const latestMutant = { template: { containers: [{ env: fixtureEntries.map((entry) => entry.name === 'SMTP_PASS'
  ? { name: entry.name, valueSource: { secretKeyRef: { secret: 'nash-equilibrium-smtp-pass', version: 'latest' } } }
  : entry) }] } };
const latestResult = runAudit(latestMutant);
assert.notEqual(latestResult.status, 0, 'an unpinned `latest` secret reference must fail the live audit');

const payloadMutant = { template: { containers: [{ env: fixtureEntries.map((entry) => entry.name === 'ADMIN_SECRET'
  ? { ...entry, value: 'fixture-must-never-be-accepted' }
  : entry) }] } };
const payloadResult = runAudit(payloadMutant);
assert.notEqual(payloadResult.status, 0, 'input containing literal env payload fields must fail closed');

const namesOnlyResult = runAudit(names.join('\n'));
assert.notEqual(namesOnlyResult.status, 0, 'names-only input cannot prove Secret Manager backing');

const malformedJsonResult = runAudit('{"template":');
assert.notEqual(malformedJsonResult.status, 0, 'malformed JSON input must fail immediately');
assert.match(malformedJsonResult.stdout + malformedJsonResult.stderr, /malformed JSON metadata response/);
assert.doesNotMatch(malformedJsonResult.stdout + malformedJsonResult.stderr, /UNTRACKED|names-only input/,
  'malformed JSON must not fall through to names-only tokenization');

const ordinarySecretMutant = { template: { containers: [{ env: fixtureEntries.map((entry) => entry.name === 'NODE_ENV'
  ? { name: entry.name, valueSource: { secretKeyRef: { secret: 'wrong-secret', version: '1' } } }
  : entry) }] } };
assert.notEqual(runAudit(ordinarySecretMutant).status, 0, 'literal-designated variables must not accept secret references');

const malformedMutant = { template: { containers: [{ env: [...fixtureEntries, { valueSource: {} }] }] } };
assert.notEqual(runAudit(malformedMutant).status, 0, 'malformed structured entries must fail closed rather than being dropped');

const malformedContainerEnvMutant = { template: { containers: [
  { env: fixtureEntries },
  { env: { name: 'UNTRACKED_LITERAL', value: 'must-not-be-ignored' } },
] } };
const malformedContainerEnvResult = runAudit(malformedContainerEnvMutant);
assert.notEqual(malformedContainerEnvResult.status, 0,
  'a valid container must not let a second malformed env collection disappear from the audit');
assert.match(malformedContainerEnvResult.stdout + malformedContainerEnvResult.stderr,
  /malformed template\.containers\[\]\.env environment shape/);
assert.doesNotMatch(malformedContainerEnvResult.stdout + malformedContainerEnvResult.stderr, /must-not-be-ignored/,
  'malformed container rejection must not echo a potential secret payload');

// Keep the malformed-source branch independently mutation-tested. An unnamed
// entry fails earlier at the shape check, so it cannot prove this branch.
const emptySourceMutant = { template: { containers: [{ env: fixtureEntries.map((entry) =>
  entry.name === 'AUTH_SECRET' ? { name: entry.name, valueSource: {} } : entry) }] } };
const emptySourceResult = runAudit(emptySourceMutant);
assert.notEqual(emptySourceResult.status, 0, 'a named but unusable valueSource must fail closed');
assert.match(emptySourceResult.stdout + emptySourceResult.stderr, /INVALID_SOURCE\s+AUTH_SECRET/);

console.log('✓ cloud env audit contract: OIDC-only auth, server-side fields masks, exact sources, and malformed/literal mutants are guarded');
