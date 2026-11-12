# Google Cloud

Google Cloud trusts dx through Workload Identity Federation: a workload identity pool with an OIDC
provider for dx's issuer. The provider's attribute condition reads dx's custom claims, and IAM
grants go to a `principalSet` of the mapped attributes, directly on the resources, with no service
account and no key.

## Setup (the person runs this in Google Cloud Shell)

Cloud Shell is the `>_` button at the top right of console.cloud.google.com. The person needs
Workload Identity Pool Admin on the pool's project and permission to set IAM policy where they
grant. Fill in `ISSUER` (the `iss` claim), `AUDIENCE`, and the condition for the chosen scope.

```sh
export POOL_PROJECT='<project-that-holds-the-pool>'
export POOL_PROJECT_NUMBER="$(gcloud projects describe "$POOL_PROJECT" --format='value(projectNumber)')"
export POOL_ID='dx-agents'
export PROVIDER_ID='dx'
export ISSUER='https://<host>/api/workload-identity'
export AUDIENCE='urn:dx:gcp:dx-agents'
export WS_ID='<workspace_id>'

gcloud services enable iam.googleapis.com sts.googleapis.com iamcredentials.googleapis.com \
  --project="$POOL_PROJECT"
gcloud iam workload-identity-pools create "$POOL_ID" --project="$POOL_PROJECT" --location=global

gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
  --project="$POOL_PROJECT" --location=global --workload-identity-pool="$POOL_ID" \
  --issuer-uri="$ISSUER" \
  --allowed-audiences="$AUDIENCE" \
  --attribute-mapping='google.subject=assertion.thread_id,attribute.workspace_id=assertion.workspace_id,attribute.project_id=assertion.project_id,attribute.user_id=assertion.user_id' \
  --attribute-condition="'workspace_id' in assertion && assertion.workspace_id == '$WS_ID' && assertion.token_use == 'dx_workload_identity_v1'"

# Read-only logs in one resource project. Repeat per project, or grant on a folder or the
# organization (gcloud resource-manager folders / organizations add-iam-policy-binding) to cover
# every project under it.
gcloud projects add-iam-policy-binding '<resource-project>' --condition=None \
  --role=roles/logging.viewer \
  --member="principalSet://iam.googleapis.com/projects/$POOL_PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL_ID/attribute.workspace_id/$WS_ID"

echo "PROVIDER=projects/$POOL_PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL_ID/providers/$PROVIDER_ID AUDIENCE=$AUDIENCE"
```

- `google.subject` is `thread_id` because Google limits it to 127 bytes and dx's `sub` is longer.
  Each Thread then appears as its own principal in Cloud Audit Logs.
- Conditions for other scopes, each followed by
  `&& assertion.token_use == 'dx_workload_identity_v1'`:
  - Projects: `assertion.project_id in ['prj_…', 'prj_…']`, and grant to
    `…/attribute.project_id/<prj_…>`.
  - Users: add `&& assertion.user_id == 'usr_…'`.
  - Keep `'workspace_id' in assertion` whenever the condition reads `workspace_id`, so a personal
    Project's token, which has no such claim, is rejected explicitly.
- `--condition=None` adds an unconditional grant. Without it, gcloud prompts when the project
  already has conditional bindings; choose `None`, never an existing condition.
- `roles/logging.viewer` covers the `_Default` and `_Required` buckets but not Data Access audit
  logs, which need `roles/logging.privateLogViewer`. Grant other read roles, such as
  `roles/monitoring.viewer`, the same way.
- An API that does not accept federated principals needs service account impersonation: grant the
  principal set `roles/iam.workloadIdentityUser` on a narrow service account, and add
  `service_account_impersonation_url` to the credential file below.
- If creating the provider fails on the `iam.workloadIdentityPoolProviders` organization policy,
  the organization must allow dx's issuer URL.

## Use from a Thread

`dxd gcp-credential --audience <audience>` prints Google's executable-credential JSON with a fresh
token on each call. Point an external account credential file at it; write it outside the
repository:

```sh
mkdir -p ~/.config/dx-gcp
cat > ~/.config/dx-gcp/credentials.json <<'EOF'
{
  "universe_domain": "googleapis.com",
  "type": "external_account",
  "audience": "//iam.googleapis.com/<provider>",
  "subject_token_type": "urn:ietf:params:oauth:token-type:id_token",
  "token_url": "https://sts.googleapis.com/v1/token",
  "credential_source": {
    "executable": {
      "command": "/usr/local/bin/dxd gcp-credential --audience <audience> --ttl-seconds 300",
      "timeout_millis": 30000
    }
  }
}
EOF
export GOOGLE_APPLICATION_CREDENTIALS="$HOME/.config/dx-gcp/credentials.json"
export GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES=1
```

`<provider>` is the `PROVIDER=` value from setup. Google client libraries then work through
Application Default Credentials. `GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES=1` lets the library run
the file's command, so set it only for a file you wrote. Leave out `output_file`: dx tokens are not
cached on disk.

With gcloud (install under `~/.local` if missing):

```sh
gcloud auth login --cred-file="$GOOGLE_APPLICATION_CREDENTIALS"
gcloud logging read 'severity>=ERROR' --project='<resource-project>' --freshness=1d --limit=20
```

Without gcloud, call REST APIs with plain HTTP. `scripts/gcp-access-token.mjs --provider <provider>
--audience <audience>` prints a one-hour Google access token for command substitution. With
`OIDC_GCP_PROVIDER` and `OIDC_GCP_AUDIENCE` recorded, it needs no arguments:

```sh
curl -sS -H "Authorization: Bearer $(node /home/user/.local/share/dx/skills/using-workload-identity/scripts/gcp-access-token.mjs --provider '<provider>' --audience '<audience>')" \
  -H 'Content-Type: application/json' https://logging.googleapis.com/v2/entries:list \
  -d '{"resourceNames":["projects/<resource-project>"],"filter":"severity>=ERROR","orderBy":"timestamp desc","pageSize":20}'
```

## Verify

1. The exchange succeeds: `scripts/gcp-access-token.mjs` exits 0.
2. A read the grant allows returns HTTP 200; a project without the grant returns 403.
3. A write (`logging.googleapis.com/v2/entries:write`) returns 403 `PERMISSION_DENIED`, and a call to
   another service, such as listing Cloud Storage buckets, returns 403.

## Read the existing configuration

For diagnosis, the person prints the provider and the grants (read-only):

```sh
gcloud iam workload-identity-pools providers list --project='<pool-project>' --location=global --workload-identity-pool='<pool>'
gcloud iam workload-identity-pools providers describe '<provider>' --project='<pool-project>' --location=global --workload-identity-pool='<pool>' \
  --format='yaml(oidc,attributeMapping,attributeCondition,state)'
gcloud projects get-iam-policy '<resource-project>' --flatten=bindings \
  --filter='bindings.members:principalSet' --format='table(bindings.role,bindings.members)'
```

Compare `oidc.issuerUri` with `iss`, `oidc.allowedAudiences` with the requested audience, the
`attributeCondition` with this Thread's claims, and each `principalSet` attribute with the claim it
maps. A grant on a folder or the organization appears in that level's IAM policy instead.

## Errors

| Error | Cause |
| --- | --- |
| `unauthorized_client`: The given credential is rejected by the attribute condition | The token verified, but the provider's condition did not match its claims |
| `invalid_grant` naming the audience | The token's `aud` is not in the provider's allowed audiences |
| `invalid_grant` naming the issuer, or a JWKS error | The provider's issuer URI differs from the token's `iss` |
| `invalid_target` | The provider resource name is wrong, or the pool or provider is disabled or deleted |
| 403 `PERMISSION_DENIED` from the API, such as "Permission denied for all log views" | No IAM grant for this principal set on that resource, or it is still propagating |
