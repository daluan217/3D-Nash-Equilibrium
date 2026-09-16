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
import { createRequire } from 'node:module';

const workflow = readFileSync('.github/workflows/cloud-env-audit.yml', 'utf8');
const require = createRequire(import.meta.url);
const { load: loadYaml } = require('js-yaml') as { load: (source: string) => unknown };

type AnyRecord = Record<string, unknown>;

/** Return an object view only for a non-array mapping. */
function recordOf(value: unknown): AnyRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : {};
}

/**
 * Remove comments from a parsed workflow's shell scripts while preserving #
 * inside single/double quotes and unquoted words. Quote state crosses physical
 * lines, while a backslash-newline clears only the escape state so the first
 * character on the next line is interpreted normally.
 */
function stripShellComments(source: string): string {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '\n') {
      out += char;
      escaped = false;
      continue;
    }
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (inSingle) {
      out += char;
      if (char === "'") inSingle = false;
      continue;
    }
    if (char === '\\') {
      out += char;
      escaped = true;
      continue;
    }
    if (inDouble) {
      out += char;
      if (char === '"') inDouble = false;
      continue;
    }
    if (char === "'") { out += char; inSingle = true; continue; }
    if (char === '"') { out += char; inDouble = true; continue; }
    if (char === '#' && (i === 0 || /[\s;&|()]/.test(source[i - 1]))) {
      while (i + 1 < source.length && source[i + 1] !== '\n') i++;
      continue;
    }
    out += char;
  }
  return out;
}

/** Recursively retain YAML values while stripping comments from run blocks. */
function executableValueOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(executableValueOf);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as AnyRecord).map(([key, child]) => [
    key,
    key === 'run' && typeof child === 'string' ? stripShellComments(child) : executableValueOf(child),
  ]));
}

type WorkflowView = {
  permissions: AnyRecord;
  auditEnv: AnyRecord;
  steps: AnyRecord[];
  shell: string;
  executableDocument: string;
};

/** Parse executable workflow structure and extract only actual run scripts. */
function workflowViewOf(source: string): WorkflowView {
  const document = recordOf(loadYaml(source));
  const permissions = recordOf(document.permissions);
  const auditJob = recordOf(recordOf(document.jobs).audit);
  const auditEnv = recordOf(auditJob.env);
  const steps = Array.isArray(auditJob.steps) ? auditJob.steps.map(recordOf) : [];
  const shell = stripShellComments(steps
    .map((step) => typeof step.run === 'string' ? step.run : '')
    .filter(Boolean)
    .join('\n'));
  return { permissions, auditEnv, steps, shell, executableDocument: JSON.stringify(executableValueOf(document)) };
}

/** Require one exact OIDC auth step with both dedicated secret references. */
function hasDedicatedWif(view: WorkflowView): boolean {
  const authSteps = view.steps.filter((step) => step.uses === 'google-github-actions/auth@v2');
  if (authSteps.length !== 1) return false;
  const withValues = recordOf(authSteps[0].with);
  return withValues.workload_identity_provider === '${{ secrets.GCP_AUDIT_WIF_PROVIDER }}'
    && withValues.service_account === '${{ secrets.GCP_AUDIT_SERVICE_ACCOUNT }}';
}

/** Collapse backslash continuations into the logical command lines the shell executes. */
function logicalShellLines(shell: string): string[] {
  return shell.replace(/\\\n[ \t]*/g, ' ').split('\n').map((line) => line.trim()).filter(Boolean);
}

/** A required helper must begin a command line or a real pipeline stage, and
 * its trailing shell control must be one of the explicitly reviewed forms.
 * Text after `||`, `&&`, `;`, `echo`, or another argv token is not
 * unconditional; a success-masking suffix such as `|| true` is not safe. */
function hasUnconditionalPipelineCommand(
  view: WorkflowView,
  command: RegExp,
  allowedSuffix: RegExp,
): boolean {
  return logicalShellLines(view.shell).some((line) => {
    const match = command.exec(line);
    if (!match) return false;
    const before = line.slice(0, match.index).trimEnd();
    if (/(?:&&|\|\||;)/.test(before)) return false;
    if (before !== '' && !/(^|[^|])\|$/.test(before)) return false;
    return allowedSuffix.test(line.slice(match.index + match[0].length).trim());
  });
}

/** Require the reviewed manifest audit as an executable shell command. */
function hasEnvironmentAuditCommand(view: WorkflowView): boolean {
  return hasUnconditionalPipelineCommand(
    view,
    /\bnode[ \t]+src\/deploy\/env-audit[.]mjs(?=$|[\s|;&)])/,
    /^(?:\|\|\s*rc=1)?$/,
  );
}

/** Require the traffic helper inside its fail-closed command substitution. */
function hasTrafficAuditCommand(view: WorkflowView): boolean {
  const lines = logicalShellLines(view.shell);
  return lines.some((line, index) =>
    /^if\s+!\s+revisions=\$\(/.test(line)
    && hasUnconditionalPipelineCommand(
      { ...view, shell: line },
      /\bnode[ \t]+src\/deploy\/cloud-run-traffic[.]mjs(?=$|[\s|;&)])/,
      /^\);\s*then$/,
    )
    && lines[index + 1] === 'exit 1'
    && lines[index + 2] === 'fi');
}

/** Require the fields mask on the same simple curl command as the Cloud Run
 * resource URL; an unrelated echo of the option proves nothing. */
function hasServerMaskedCloudRunRequest(view: WorkflowView): boolean {
  return logicalShellLines(view.shell).some((line) =>
    /^curl(?:\s|$)/.test(line)
    && !/(?:&&|\|\||;)/.test(line)
    && /--data-urlencode\s+"fields=\$fields"/.test(line)
    && /"\$RUN_API\/\$resource"/.test(line));
}

const executable = workflowViewOf(workflow);

/** Report a cloud environment audit contract violation and terminate the test. */
function fail(message: string): never {
  console.error(`✗ cloud env audit contract: ${message}`);
  process.exit(1);
}

if (executable.permissions['id-token'] !== 'write') {
  fail('workflow must retain id-token: write for the preferred WIF path');
}
if (!hasDedicatedWif(executable)) {
  fail('workflow must use the dedicated audit Workload Identity Federation credentials');
}
if (/"credentials_json":|GCP_SA_KEY|steps[.]creds|mode=(?:none|key)|skipping the live env audit/i.test(executable.executableDocument)) {
  fail('live audit must fail closed and must not fall back to a long-lived service-account key');
}
if (!hasEnvironmentAuditCommand(executable)) {
  fail('workflow must invoke the reviewed environment manifest audit');
}

// Environment reads must use Cloud API's server-side partial-response mask.
// `gcloud --format` is only a client-side renderer: the full resource (and its
// literal payloads) reaches the runner first. Ignore explanatory comments.
if (/gcloud\s+run\s+(?:services|revisions)\s+(?:describe|list)|--format(?:=|\s)/.test(executable.shell)) {
  fail('workflow must not fetch full Cloud Run resources and filter them locally with gcloud');
}
const serviceFields = typeof executable.auditEnv.SERVICE_FIELDS === 'string' ? executable.auditEnv.SERVICE_FIELDS.split(',') : [];
const revisionFields = typeof executable.auditEnv.REVISION_FIELDS === 'string' ? executable.auditEnv.REVISION_FIELDS.split(',') : [];
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
if (executable.auditEnv.RUN_API !== 'https://run.googleapis.com/v2'
    || !hasServerMaskedCloudRunRequest(executable)
    || !hasTrafficAuditCommand(executable)) {
  fail('workflow must use Cloud Run v2 REST fields masks and the reviewed traffic helper');
}
if (/access_token=\$\(gcloud auth print-access-token\s+2>&1\)|echo\s+"\$access_token"/.test(executable.shell)) {
  fail('workflow must not merge token-mint diagnostics into the bearer token or print that token');
}

const commentOnlyRequiredMutant = [
  '# id-token: write',
  '# uses: google-github-actions/auth@v2',
  '# workload_identity_provider: ${{ secrets.GCP_AUDIT_WIF_PROVIDER }}',
  '# service_account: ${{ secrets.GCP_AUDIT_SERVICE_ACCOUNT }}',
  '# node src/deploy/env-audit.mjs',
].join('\n');
const commentOnlyView = workflowViewOf(commentOnlyRequiredMutant);
assert.equal(commentOnlyView.permissions['id-token'] === 'write'
  || hasDedicatedWif(commentOnlyView) || hasEnvironmentAuditCommand(commentOnlyView), false,
  'commented-out authentication and audit commands cannot satisfy executable workflow guards');
const forbiddenCredentialCommentControl = `${workflow}\n# credentials_json: GCP_SA_KEY; mode=key; skipping the live env audit`;
assert.equal(/"credentials_json":|GCP_SA_KEY|mode=(?:none|key)|skipping the live env audit/i
  .test(workflowViewOf(forbiddenCredentialCommentControl).executableDocument), false,
  'an explanatory comment cannot trip the executable forbidden-credential guard');
const forbiddenShellCommentControl = workflow.replace(
  '          set -euo pipefail',
  '          set -euo pipefail\n          # credentials_json: GCP_SA_KEY; mode=key; skipping the live env audit',
);
assert.equal(/"credentials_json":|GCP_SA_KEY|mode=(?:none|key)|skipping the live env audit/i
  .test(workflowViewOf(forbiddenShellCommentControl).executableDocument), false,
  'an explanatory shell comment inside a run block cannot trip the executable forbidden-credential guard');

const inlineCommentOnlyRequiredMutant = [
  'permissions: # id-token: write',
  'jobs:',
  '  audit:',
  '    steps:',
  '      - uses: # google-github-actions/auth@v2',
  '        with:',
  '          workload_identity_provider: # ${{ secrets.GCP_AUDIT_WIF_PROVIDER }}',
  '          service_account: # ${{ secrets.GCP_AUDIT_SERVICE_ACCOUNT }}',
  '      - run: echo skipped # node src/deploy/env-audit.mjs',
].join('\n');
const requiredWorkflowTokens = /id-token:\s*write|google-github-actions\/auth@v2|src\/deploy\/env-audit[.]mjs/;
const inlineCommentView = workflowViewOf(inlineCommentOnlyRequiredMutant);
assert.equal(inlineCommentView.permissions['id-token'] === 'write'
  || hasDedicatedWif(inlineCommentView) || hasEnvironmentAuditCommand(inlineCommentView), false,
  'inline-commented authentication and audit commands cannot satisfy executable workflow guards');
assert.equal(hasEnvironmentAuditCommand({ ...executable, shell: 'echo node src/deploy/env-audit.mjs' }), false,
  'mutation: audit-command text passed to echo cannot satisfy the executable env-audit guard');
assert.equal(hasTrafficAuditCommand({ ...executable, shell: 'echo node src/deploy/cloud-run-traffic.mjs' }), false,
  'mutation: traffic-helper text passed to echo cannot satisfy the executable traffic guard');
assert.equal(hasEnvironmentAuditCommand({ ...executable, shell: 'true || node src/deploy/env-audit.mjs' }), false,
  'mutation: an env-audit command skipped behind true || cannot satisfy the executable guard');
assert.equal(hasEnvironmentAuditCommand({ ...executable, shell: 'exit 0; node src/deploy/env-audit.mjs' }), false,
  'mutation: an env-audit command made unreachable by exit 0; cannot satisfy the executable guard');
assert.equal(hasTrafficAuditCommand({ ...executable, shell: 'true || node src/deploy/cloud-run-traffic.mjs' }), false,
  'mutation: a traffic helper skipped behind true || cannot satisfy the executable guard');
assert.equal(hasEnvironmentAuditCommand({
  ...executable,
  shell: "printf '%s' \"$service_metadata\" | node src/deploy/env-audit.mjs || rc=1",
}), true, 'control: the environment audit may preserve its reviewed aggregate-failure handler');
assert.equal(hasEnvironmentAuditCommand({
  ...executable,
  shell: "printf '%s' \"$service_metadata\" | node src/deploy/env-audit.mjs || true",
}), false, 'mutation: a trailing || true cannot mask an environment-audit failure');
assert.equal(hasTrafficAuditCommand({
  ...executable,
  shell: [
    "if ! revisions=$(printf '%s' \"$service_metadata\" | node src/deploy/cloud-run-traffic.mjs || true); then",
    'exit 1',
    'fi',
  ].join('\n'),
}), false, 'mutation: a trailing || true cannot mask a traffic-helper failure');
assert.equal(hasTrafficAuditCommand({
  ...executable,
  shell: "revisions=$(printf '%s' \"$service_metadata\" | node src/deploy/cloud-run-traffic.mjs)",
}), false, 'mutation: the traffic helper must retain its explicit if-not/exit failure path');
assert.equal(hasServerMaskedCloudRunRequest({
  ...executable,
  shell: 'curl --get "$RUN_API/$resource"\necho --data-urlencode "fields=$fields"',
}), false, 'mutation: an echo-only fields option cannot satisfy the Cloud Run request mask contract');
assert.equal(requiredWorkflowTokens.test(inlineCommentOnlyRequiredMutant.replace(/^\s*#.*$/gm, '')), true,
  'mutation: removing only full-line comments leaves the inline-comment escape reachable');
const scalarImpostorView = workflowViewOf([
  'name: "id-token: write',
  '  google-github-actions/auth@v2',
  '  node src/deploy/env-audit.mjs"',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  audit:',
  '    steps: []',
].join('\n'));
assert.equal(scalarImpostorView.permissions['id-token'] === 'write'
  || hasDedicatedWif(scalarImpostorView) || hasEnvironmentAuditCommand(scalarImpostorView), false,
  'required-looking text inside a multiline YAML scalar cannot satisfy structural workflow guards');

const multilineShell = [
  'printf "%s" "double quote',
  '  # retained double" # removed double comment',
  "printf '%s' 'single quote",
  "  # retained single' # removed single comment",
  'printf "%s" "continued \\',
  '" # removed after continued quote',
].join('\n');
assert.equal(multilineShell.split('\n')[4].match(/\\+$/)?.[0].length, 1,
  'the continuation fixture must exercise one trailing escape crossing a physical newline');
const strippedMultilineShell = stripShellComments(multilineShell);
assert.match(strippedMultilineShell, /# retained double/,
  'a # inside a multiline double-quoted shell scalar must remain data');
assert.match(strippedMultilineShell, /# retained single/,
  'a # inside a multiline single-quoted shell scalar must remain data');
assert.doesNotMatch(strippedMultilineShell, /removed (?:double|single|after)/,
  'real shell comments after multiline quoted values must be removed');
const perLineQuoteResetMutant = multilineShell.split('\n').map(stripShellComments).join('\n');
assert.doesNotMatch(perLineQuoteResetMutant, /# retained (?:double|single)/,
  'mutation: resetting quote state on each line loses quoted # data');

const names = readFileSync('deploy/cloudrun-env-manifest.txt', 'utf8')
  .split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
const refs = new Map([
  ['SMTP_USER', ['nash-equilibrium-smtp-user', '3']],
  ['SMTP_PASS', ['nash-equilibrium-smtp-pass', '3']],
  ['ADMIN_SECRET', ['nash-equilibrium-admin-secret', '3']],
  ['AUTH_SECRET', ['nash-equilibrium-auth-secret', '2']],
  ['AZURE_FOUNDRY_API_KEY', ['nash-equilibrium-azure-foundry-api-key', '3']],
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
