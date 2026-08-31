/* Cloud Run live-environment audit.
 *
 * Reads the DEPLOYED service's environment variable NAMES on stdin (one per
 * line, or gcloud's semicolon-separated `value()` output) and compares them to
 * deploy/cloudrun-env-manifest.txt.
 *
 * Split out from the workflow so the comparison is testable without GCP
 * credentials: `printf 'A\nB\n' | node src/deploy/env-audit.mjs`.
 *
 * NAMES ONLY, deliberately. The service's environment holds AUTH_SECRET,
 * SMTP_PASS and the provider API key; this script must never read, log, or
 * compare a value, and its output is safe to paste into a public CI log.
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

const stdin = readFileSync(0, 'utf8');
const live = new Set(
  stdin.split(/[;\n,\s]+/).map((s) => s.trim()).filter(Boolean),
);

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

console.log(`✓ cloud-run env audit: live service env matches the manifest exactly (${expected.size} names)`);
