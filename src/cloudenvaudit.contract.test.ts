/**
 * Credential-free contract for the deployed-environment audit workflow.
 *
 * This protects the audit itself: it must inspect metadata without reading
 * secret values, and every Actions step that needs the service description
 * must fetch it in that step's own shell.
 */
import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/cloud-env-audit.yml', 'utf8');

function fail(message: string): never {
  console.error(`✗ cloud env audit contract: ${message}`);
  process.exit(1);
}

if (!/id-token:\s*write/.test(workflow)) {
  fail('workflow must retain id-token: write for the preferred WIF path');
}
if (!/google-github-actions\/auth@v2/.test(workflow)
    || !/workload_identity_provider:/.test(workflow)
    || !/service_account:/.test(workflow)) {
  fail('workflow must retain the Workload Identity Federation authentication path');
}
if (!/src\/deploy\/env-audit\.mjs/.test(workflow)
    || !/deploy\/cloudrun-env-manifest\.txt/.test(workflow)) {
  fail('workflow must invoke the reviewed names-only manifest audit');
}

// A service/revision describe is allowed to request JSON or env names only.
// Asking for env[].value would put credentials into the Actions log. Ignore
// explanatory YAML comments, which mention that forbidden field by name.
const executable = workflow.replace(/^\s*#.*$/gm, '');
if (/env\[\][.]value|containers\[\][.]env\[\][.]value/.test(executable)) {
  fail('workflow must never request or print deployed environment values');
}

const describeJsonCalls = [...workflow.matchAll(/gcloud run services describe[\s\S]{0,180}?--format=json/g)].length;
if (describeJsonCalls < 2) {
  fail('each shell that checks traffic must fetch its own service JSON; shell variables do not cross Actions steps');
}

const trafficStep = workflow.slice(workflow.indexOf('- name: The newest ready revision must be the one serving traffic'));
if (!/svc=\$\(gcloud run services describe[\s\S]*?--format=json/.test(trafficStep)) {
  fail('newest-ready traffic check must initialize svc in its own Actions step');
}

console.log('✓ cloud env audit contract: WIF path, names-only output, and per-step service fetch are guarded');
