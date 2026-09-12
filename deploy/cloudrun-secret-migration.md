# Cloud Run secret migration

`cloudbuild.yaml` now injects credential-bearing settings with Cloud Run's
`--set-secrets` flag. The repository contains only Secret Manager resource
names; it must never contain secret payloads or a copied Cloud Build trigger
value.

Before merging a deployment that uses the new wiring, an operator must:

1. Create the five Secret Manager secrets named by `_SMTP_USER_SECRET`,
   `_SMTP_PASS_SECRET`, `_ADMIN_SECRET_SECRET`, `_AUTH_SECRET_SECRET`, and
   `_AZURE_FOUNDRY_API_KEY_SECRET` (or set those substitutions to the approved
   project-specific names).
2. Add the current values as new secret versions without putting them in shell
   history, source control, workflow logs, or command output.
3. Grant `roles/secretmanager.secretAccessor` on only those secrets to the
   Cloud Run runtime service account.
4. Confirm the Cloud Build deploy identity can update the service and resolve
   the references, without granting it permission to read secret payloads
   unless the deployment topology requires that.
5. Deploy a canary revision and verify `/api/health`, authentication, mail,
   storage, and the report fallback/model path before shifting traffic.
6. Rotate the old trigger-stored credentials after the new revision is
   serving. Rotating `AUTH_SECRET` invalidates existing sessions, so announce
   that impact and verify the login path after the rotation.

The live environment audit must be repaired separately: configure GitHub OIDC
Workload Identity Federation for a dedicated read-only audit identity, grant
the minimum Cloud Run metadata permission needed for service/revision
description, and rerun `.github/workflows/cloud-env-audit.yml`. Do not broaden
that identity's access while secrets remain literal environment values.

The audit compares names only. It must never print `env[].value` or secret
payloads. A successful audit is necessary but does not prove that a referenced
secret exists, is current, or is usable by the runtime; the canary checks cover
those behaviours.
