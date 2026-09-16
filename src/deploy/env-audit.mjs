/* Cloud Run live-environment audit.
 *
 * Reads a credential-free environment projection on stdin and compares it to
 * deploy/cloudrun-env-manifest.txt. The live workflow uses Cloud Run v2's
 * server-side `fields` response mask to request each entry's name and (only)
 * `valueSource.secretKeyRef` metadata; it never fetches env[].value. Names-only
 * input fails closed because it cannot prove the secret source.
 *
 * Split out from the workflow so the comparison is testable without GCP
 * credentials: `printf '[{"name":"A"}]' | node src/deploy/env-audit.mjs`.
 *
 * Names and secret-reference metadata only, deliberately. The service's
 * environment holds AUTH_SECRET, SMTP_PASS and the provider API key; this
 * script must never request, log, or compare a payload value, and its output is
 * safe to paste into a public CI log.
 *
 * Why it exists: src/cloudbuild.contract.test.ts proves the repo's deploy
 * config is right, but the Cloud Build trigger UI can override substitutions
 * and a human can still run `gcloud run services update` by hand — which is
 * how production lost AUTH_SECRET/SMTP/GCS for 12 minutes on 2026-08-31. This
 * checks the thing that is actually running.
 */
import { readFileSync } from 'node:fs';

const manifest = readFileSync('deploy/cloudrun-env-manifest.txt', 'utf8');
const expected = new Set(
  manifest.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')),
);

const stdin = readFileSync(0, 'utf8').trim();
let entries = [];
let structured = false;
if (stdin.startsWith('{') || stdin.startsWith('[')) {
  let parsed;
  try {
    parsed = JSON.parse(stdin);
  } catch {
    console.error('✗ cloud-run env audit: malformed JSON metadata response.');
    process.exit(1);
  }
  structured = true;
  if (Array.isArray(parsed)) {
    // Direct arrays keep the helper easy to mutation-test.
    entries = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const envCollections = [];
    const rejectShape = (label) => {
      console.error(`✗ cloud-run env audit: malformed ${label} environment shape.`);
      process.exit(1);
    };
    const addDirectEnv = (owner, label) => {
      if (!owner || typeof owner !== 'object' || !Object.hasOwn(owner, 'env')) return;
      if (!Array.isArray(owner.env)) rejectShape(label);
      envCollections.push(owner.env);
    };
    const addContainers = (owner, label) => {
      if (!owner || typeof owner !== 'object' || !Object.hasOwn(owner, 'containers')) return;
      if (!Array.isArray(owner.containers)) rejectShape(`${label}.containers`);
      for (const container of owner.containers) {
        if (!container || typeof container !== 'object' || Array.isArray(container)) {
          rejectShape(`${label}.containers[]`);
        }
        if (Object.hasOwn(container, 'env') && !Array.isArray(container.env)) {
          rejectShape(`${label}.containers[].env`);
        }
        if (Array.isArray(container.env)) envCollections.push(container.env);
      }
    };
    // Cloud Run v2 Service/Revision responses and their v1 equivalents. Check
    // every recognized collection that is present; combining them makes a
    // duplicate or extra entry fail later instead of letting a second shape
    // hide behind the first valid one.
    addDirectEnv(parsed, 'env');
    addContainers(parsed.template, 'template');
    addContainers(parsed, 'root');
    addContainers(parsed.spec?.template?.spec, 'spec.template.spec');
    addContainers(parsed.spec, 'spec');
    entries = envCollections.flat();
  }
}
if (!structured) {
  entries = stdin.split(/[;\n,\s]+/).map((name) => ({ name: name.trim() })).filter((entry) => entry.name);
}

const malformed = entries.filter((entry) => !entry || typeof entry !== 'object'
  || typeof entry.name !== 'string' || entry.name.trim().length === 0);
if (malformed.length > 0) {
  console.error(`✗ cloud-run env audit: ${malformed.length} malformed environment entr${malformed.length === 1 ? 'y' : 'ies'} in the metadata response.`);
  process.exit(1);
}

const names = entries.map((entry) => entry.name);
const live = new Set(names);
const duplicates = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))].sort();
if (duplicates.length > 0) {
  for (const name of duplicates) console.log(`DUPLICATE  ${name}`);
  console.error(`✗ cloud-run env audit: ${duplicates.length} environment name(s) appear more than once.`);
  process.exit(1);
}

// Fail closed if a caller supplied a full Cloud Run environment object. That
// object includes literal payloads for value-backed entries; this audit needs
// only the field-projected metadata and must never accept secret material on
// stdin even if it promises not to print it.
if (structured && entries.some((entry) => Object.hasOwn(entry, 'value'))) {
  console.error('✗ cloud-run env audit: input contains literal environment values; use the Cloud Run REST fields mask.');
  process.exit(1);
}

if (live.size === 0) {
  console.error('✗ cloud-run env audit: no variable names on stdin — the describe call returned nothing.');
  console.error('  Treating this as a FAILURE: an empty environment is exactly the incident shape.');
  process.exit(1);
}

const missing = [...expected].filter((n) => !live.has(n)).sort();
const extra = [...live].filter((n) => !expected.has(n)).sort();

for (const n of missing) console.log(`MISSING  ${n}  (manifest requires it; the live service does not have it)`);
for (const n of extra) console.log(`UNTRACKED ${n}  (live service has it; deploy/cloudrun-env-manifest.txt does not list it)`);

if (missing.length > 0) {
  console.error(
    `\n✗ cloud-run env audit: ${missing.length} variable(s) missing from the deployed service. `
    + 'Production is running with less configuration than the repo says it should — auth, mail, '
    + 'storage or the report surface may be silently degraded.',
  );
  process.exit(1);
}
if (extra.length > 0) {
  console.error(
    `\n✗ cloud-run env audit: ${extra.length} variable(s) on the live service are not in the manifest. `
    + 'Either they were set by hand outside cloudbuild.yaml (the next deploy will DELETE them, because '
    + '--set-env-vars replaces the whole environment), or the manifest is stale. Reconcile both.',
  );
  process.exit(1);
}

const EXPECTED_SECRET_REFS = new Map([
  ['SMTP_USER', ['nash-equilibrium-smtp-user', '3']],
  ['SMTP_PASS', ['nash-equilibrium-smtp-pass', '3']],
  ['ADMIN_SECRET', ['nash-equilibrium-admin-secret', '2']],
  ['AUTH_SECRET', ['nash-equilibrium-auth-secret', '2']],
  ['AZURE_FOUNDRY_API_KEY', ['nash-equilibrium-azure-foundry-api-key', '3']],
]);
const secretRefOf = (entry) => {
  const v2 = entry?.valueSource?.secretKeyRef;
  if (v2) return [v2.secret, v2.version];
  const v1 = entry?.valueFrom?.secretKeyRef;
  if (v1) return [v1.name, v1.key];
  return null;
};
if (!structured) {
  console.error(
    '\n✗ cloud-run env audit: structured environment metadata is required to verify that '
    + 'secret-bearing variables use Secret Manager references (names-only input is insufficient).',
  );
  process.exit(1);
}
const malformedSources = entries.filter((entry) =>
  (Object.hasOwn(entry, 'valueSource') || Object.hasOwn(entry, 'valueFrom')) && !secretRefOf(entry));
if (malformedSources.length > 0) {
  for (const entry of malformedSources) console.log(`INVALID_SOURCE  ${entry.name}`);
  console.error(`✗ cloud-run env audit: ${malformedSources.length} environment source(s) are malformed or unsupported.`);
  process.exit(1);
}
const unexpectedSecretRefs = entries.filter((entry) =>
  secretRefOf(entry) && !EXPECTED_SECRET_REFS.has(entry.name));
if (unexpectedSecretRefs.length > 0) {
  for (const entry of unexpectedSecretRefs) console.log(`UNEXPECTED_SECRET_REF  ${entry.name}`);
  console.error(`✗ cloud-run env audit: ${unexpectedSecretRefs.length} literal-designated variable(s) unexpectedly use Secret Manager.`);
  process.exit(1);
}
const wrongSecretRefs = [...EXPECTED_SECRET_REFS].filter(([name, [expectedName, expectedKey]]) => {
  const entry = entries.find((candidate) => candidate.name === name);
  const ref = secretRefOf(entry);
  return ref?.[0] !== expectedName || ref?.[1] !== expectedKey;
});
if (wrongSecretRefs.length > 0) {
  for (const [name, [expectedName, expectedKey]] of wrongSecretRefs) {
    console.log(`SECRET_REF  ${name}  (expected ${expectedName}:${expectedKey})`);
  }
  console.error(
    `\n✗ cloud-run env audit: ${wrongSecretRefs.length} secret-bearing variable(s) do not use `
    + 'the reviewed, numerically pinned Secret Manager reference.',
  );
  process.exit(1);
}

console.log(`✓ cloud-run env audit: live service env matches the manifest exactly (${expected.size} names)`);
