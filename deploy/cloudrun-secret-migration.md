# Cloud Run secret migration

`cloudbuild.yaml` now injects credential-bearing settings with Cloud Run's
`--set-secrets` flag. The repository contains only Secret Manager resource
names; it must never contain secret payloads or a copied Cloud Build trigger
value.

Before merging a deployment that uses the new wiring, an operator must:

1. Create the five Secret Manager secrets named in `cloudbuild.yaml`:
   `nash-equilibrium-smtp-user`, `nash-equilibrium-smtp-pass`,
   `nash-equilibrium-admin-secret`, `nash-equilibrium-auth-secret`, and
   `nash-equilibrium-azure-foundry-api-key`.
2. Add the current values as new secret versions without putting them in shell
   history, source control, workflow logs, or command output.
3. Grant `roles/secretmanager.secretAccessor` on only those secrets to the
   Cloud Run runtime service account.
4. Confirm the Cloud Build deploy identity can update the service and resolve
   the references, without granting it permission to read secret payloads
   unless the deployment topology requires that.
5. Deploy a canary revision and verify `/api/health`, authentication, mail,
   storage, and the report fallback/model path before shifting traffic.
6. Once the new revision is serving, remove the obsolete `_SMTP_USER`,
   `_SMTP_PASS`, `_ADMIN_SECRET`, `_AUTH_SECRET`, and
   `_AZURE_FOUNDRY_API_KEY` substitutions from the Cloud Build trigger. They
   are no longer consumed and must not remain as a second credential store.
7. Rotate the credentials after the Secret Manager cutover. Retained historical
   Cloud Run revisions still contain the old literal values, so invalidate
   those values before granting the audit identity any Cloud Run read access.
   Add each rotated
   value as a new Secret Manager version and update the numeric version in
   `cloudbuild.yaml` through review. Rotating `AUTH_SECRET` invalidates
   existing sessions, so announce that impact and verify login afterward.

The live environment audit uses the dedicated GitHub secrets
`GCP_AUDIT_WIF_PROVIDER` and `GCP_AUDIT_SERVICE_ACCOUNT`; there is deliberately
no long-lived-key fallback and no credential-free skip. Its GCP OIDC provider
must accept only this repository on `refs/heads/main`. After the cutover and
credential rotation, grant the dedicated identity `roles/run.viewer` on the
`nash-equilibrium-backend` Cloud Run service only (not at project scope), then
rerun `.github/workflows/cloud-env-audit.yml`. Cloud Run Viewer can read a
service's retained revision configurations, so granting it before the old
literal values are invalidated would enlarge their exposure.

The audit compares names and Secret Manager reference metadata only. Its Cloud
Run REST response masks must never request or print `env[].value` or secret
payloads. A successful audit is necessary but does not prove that a referenced
secret is usable by the runtime; the canary checks cover that behaviour.
