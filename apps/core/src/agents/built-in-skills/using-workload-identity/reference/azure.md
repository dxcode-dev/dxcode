# Azure (Microsoft Entra ID)

Entra trusts an external OIDC token through a **federated identity credential** on an app
registration or a user-assigned managed identity. The credential must match the token's `iss`,
`aud`, and `sub` **exactly**: Entra allows no wildcards, and its flexible credentials, which do,
accept only GitHub, GitLab, and Terraform Cloud tokens. dx's `sub` is unique per Thread, so:

- One credential admits exactly one dx Thread. An app or identity holds at most 20 credentials.
- No Entra configuration admits "every Thread of a workspace or Project". Tell the person this
  before they start. It suits a long-lived Thread that does recurring cloud work. For broad access,
  suggest AWS or Google Cloud, or a stored Azure secret limited to the minimum role.

## Setup (the person runs this in Azure Cloud Shell)

Cloud Shell is the `>_` button in the Azure portal's top bar. The person needs Application
Administrator (or ownership of the app) in Entra, and permission to assign roles on the target
scope. Fill in `ISSUER` (the `iss` claim) and `SUBJECT` (this Thread's exact `sub`, both from
`scripts/claims.mjs`). The example grants read-only access to one Log Analytics workspace.

```sh
export ISSUER='https://<dx host>/api/workload-identity'
export SUBJECT='<exact sub of the Thread>'
export AUDIENCE='api://AzureADTokenExchange'
export SCOPE='/subscriptions/<subscription-id>/resourceGroups/<group>/providers/Microsoft.OperationalInsights/workspaces/<workspace>'

export APP_ID="$(az ad app create --display-name 'dx-logs-reader' --query appId -o tsv)"
az ad sp create --id "$APP_ID"
az role assignment create --assignee "$APP_ID" --role 'Log Analytics Reader' --scope "$SCOPE"

# One credential per Thread; the name must be unique on the app (3-120 characters).
az ad app federated-credential create --id "$APP_ID" --parameters "{
  \"name\": \"dx-thread-<short-name>\",
  \"issuer\": \"$ISSUER\",
  \"subject\": \"$SUBJECT\",
  \"audiences\": [\"$AUDIENCE\"]
}"

echo "TENANT_ID=$(az account show --query tenantId -o tsv) CLIENT_ID=$APP_ID AUDIENCE=$AUDIENCE"
```

- For a user-assigned managed identity instead of an app, use
  `az identity federated-credential create --name <name> --identity-name <identity>
  --resource-group <group> --issuer "$ISSUER" --subject "$SUBJECT" --audiences "$AUDIENCE"`,
  and the identity's client ID below.
- A new or changed credential can take a few minutes to take effect.
- To admit another Thread later, add one more credential with that Thread's `sub`. Remove
  credentials for finished Threads with `az ad app federated-credential delete`.

## Use from a Thread

`scripts/azure-access-token.mjs` exchanges a fresh dx token for an Entra access token for one
resource and prints only the access token. With `OIDC_AZURE_TENANT_ID`, `OIDC_AZURE_CLIENT_ID`, and
`OIDC_AZURE_AUDIENCE` recorded, `--tenant`, `--client-id`, and `--audience` are optional.

```sh
TOKEN_SCRIPT=/home/user/.local/share/dx/skills/using-workload-identity/scripts/azure-access-token.mjs
curl -sS -H "Authorization: Bearer $(node "$TOKEN_SCRIPT" --tenant '<tenant-id>' --client-id '<client-id>' --scope 'https://api.loganalytics.io/.default')" \
  -H 'Content-Type: application/json' \
  'https://api.loganalytics.io/v1/workspaces/<workspace-customer-id>/query' \
  -d '{"query":"AppTraces | where SeverityLevel >= 3 | take 20","timespan":"PT24H"}'
```

`--scope` names the resource: `https://management.azure.com/.default` for Azure Resource Manager,
`https://api.loganalytics.io/.default` for Log Analytics queries.

The Azure CLI also accepts the dx token directly, but it caches the resulting tokens under
`~/.azure`, so run `az logout` when done:

```sh
az login --service-principal --username '<client-id>' --tenant '<tenant-id>' --allow-no-subscriptions \
  --federated-token "$(dxd id-token --audience api://AzureADTokenExchange)"
```

## Verify

1. `scripts/azure-access-token.mjs` exits 0.
2. A read the role allows returns HTTP 200.
3. A Thread whose `sub` has no credential gets `AADSTS700213`, and a call outside the role's scope
   returns 403.

## Read the existing configuration

```sh
az ad app federated-credential list --id '<client-id>' -o table
az role assignment list --assignee '<client-id>' --all -o table
```

Compare each credential's `issuer` with `iss`, `subject` with this Thread's `sub`, and `audiences`
with the requested audience.

## Errors

| Error | Cause |
| --- | --- |
| `AADSTS700211`: no matching federated identity record for the assertion issuer | No credential has this exact `iss` |
| `AADSTS700212`: … assertion audience | No credential lists the token's `aud` |
| `AADSTS700213`: … assertion subject | No credential has this Thread's exact `sub`, the usual case for a new Thread |
| `AADSTS70021`: no matching federated identity record | The combination matches no credential, or a new credential has not propagated yet |
| 403 `AuthorizationFailed` from the API | The role is missing, or assigned on another scope |
