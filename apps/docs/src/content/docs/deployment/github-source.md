---
title: GitHub source access
description: Register a GitHub App for private repository discovery, checkout, and pull requests.
---

GitHub integration is optional. Any anonymously cloneable Git URL works without
it. Configure a GitHub App when users need private repositories or GitHub pull
request operations.

## Register the GitHub App

You need permission to create a GitHub App under a personal account or
organization. Follow GitHub's [registration
guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).

1. Open **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Set the homepage URL to `<deployment-origin>`.
3. Set the callback URL to
   `<deployment-origin>/v1/integrations/github/oauth/callback`.
4. Leave **Expire user authorization tokens** enabled.
5. Do not select **Request user authorization during installation**. dx starts
   user authorization before installation.
6. Set the setup URL to `<deployment-origin>/v1/integrations/github/setup`.
7. Enable webhooks. Set the webhook URL to
   `<deployment-origin>/v1/integrations/github/webhooks`, create a strong random
   webhook secret, and keep SSL verification enabled.
8. Select only the permissions and event listed below.
9. Choose whether the app can be installed only on its owner or on any account,
   then create it.

For `https://dxcode.dev`, the three URLs are:

```text
https://dxcode.dev/v1/integrations/github/oauth/callback
https://dxcode.dev/v1/integrations/github/setup
https://dxcode.dev/v1/integrations/github/webhooks
```

GitHub explains how each permission affects available API operations in its
[permission guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).

| Repository permission | Access |
| --- | --- |
| Actions | Read and write |
| Checks | Read-only |
| Contents | Read and write |
| Issues | Read and write |
| Metadata | Read-only |
| Pull requests | Read and write |
| Commit statuses | Read-only |
| Workflows | Read and write |

Set the organization **Projects** permission to **Read and write**. Subscribe
only to the **Repository** event.

## Create the installer JSON

After registration, record the numeric App ID, app slug, and Client ID. Generate
a client secret and a private key. GitHub downloads the private key once.

The private key value is the complete PEM text encoded as a JSON string. Do not
base64-encode the PEM again. Use `jq` to escape its line breaks and print the
quoted value:

```sh
jq -Rs . < your-github-app.private-key.pem
```

Paste the entire result as `privateKeyPem`. Keep the header, footer, quotes, and
escaped `\n` line breaks.

The installer accepts this exact versioned object:

```json
{
  "version": 1,
  "appId": "123456",
  "appSlug": "my-dx-app",
  "clientId": "Iv1.example",
  "clientSecret": "replace-with-client-secret",
  "privateKeyPem": "-----BEGIN RSA PRIVATE KEY-----\nMII...\n-----END RSA PRIVATE KEY-----\n",
  "webhookSecret": "replace-with-webhook-secret",
  "callbackUrl": "https://dx.example.com/v1/integrations/github/oauth/callback",
  "setupUrl": "https://dx.example.com/v1/integrations/github/setup",
  "webhookUrl": "https://dx.example.com/v1/integrations/github/webhooks",
  "expiringUserTokens": true,
  "permissionManifestVersion": 1,
  "repositoryPermissions": {
    "actions": "write",
    "checks": "read",
    "contents": "write",
    "issues": "write",
    "metadata": "read",
    "pull_requests": "write",
    "statuses": "read",
    "workflows": "write"
  },
  "organizationPermissions": {
    "projects": "write"
  },
  "events": ["repository"]
}
```

Use the deployment origin in all three URLs. Extra fields, different
permissions, non-HTTPS URLs, or URL query strings are rejected. Do not commit
the JSON. It contains three secrets.

Run `pnpm dx:deploy`, answer **Yes** to **Configure a GitHub App**, and paste the
object at the hidden **GitHub App JSON** prompt. Noninteractive runs set
`integrations` to include `github` and supply the same object through
`DX_INTEGRATION_GITHUB_APP`.

## Connect and verify

1. Open **Settings → Integrations → GitHub** in dx.
2. Choose **Connect**, authorize the app, and install it on the account that
   owns the repositories.
3. Limit the installation to selected repositories when appropriate.
4. Create a project from a private repository.
5. Verify that dx resolves its default branch and can create or update a pull
   request from an agent branch.

Use **Refresh** after changing repository access. Disconnecting an installation
in dx removes local access and uninstalls that GitHub App installation.

## Rotate or remove access

Run `pnpm dx:deploy -- --rotate`, choose GitHub, and provide a complete JSON
object containing the replacement secret or key. Verify one private repository
before deleting the old credential in GitHub. To remove GitHub from a
deployment, remove `github` from `integrations`, rerun the deployment, then
remove remaining installations and credentials in GitHub.

## Troubleshooting

- **Configuration rejected:** compare every field, permission, event, and URL
  with the JSON above. The App ID is decimal and the PEM must include its header
  and footer.
- **Callback rejected:** confirm the GitHub callback URL exactly matches the
  deployed HTTPS origin.
- **Installation returns to the wrong page:** check the setup URL and ensure
  **Request user authorization during installation** is off.
- **Repository missing:** grant the installation access to that repository,
  then use **Refresh** in dx.
- **Webhook rejected:** confirm the configured webhook secret matches the JSON
  and SSL verification remains enabled.
