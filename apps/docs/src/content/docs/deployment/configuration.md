---
title: Deployment configuration
description: Choose an origin, authenticate to Cloudflare, and review deployment behavior.
---

## Origin

Use a `workers.dev` address for the shortest setup. Cloudflare must have a
Workers subdomain for the account. Use a custom domain when you control a zone
in the same account.

Authentication callbacks and workload identity use the application origin.
Changing it after deployment requires an upgrade.

## Cloudflare authentication

The wizard uses Alchemy browser authorization by default. Alchemy and Wrangler
have separate OAuth clients and token stores, so a Wrangler login is not used.
API tokens support headless machines.

Hosted magic-link authentication requires API-token mode. Alchemy OAuth does
not include the Turnstile and Email Sending capabilities needed by that path.

For API-token mode, use a narrowly scoped token for the target account and zone.
The complete permission set for a custom-domain deployment with hosted
magic-link authentication is:

| Scope | Permission | Access |
| --- | --- | --- |
| Account | Workers Scripts | Edit |
| Account | D1 | Edit |
| Account | Workers R2 Storage | Edit |
| Account | Secrets Store | Edit |
| Account | Turnstile | Edit |
| Account | Email Sending | Edit |
| Zone | Zone | Read |
| Zone | Workers Routes | Edit |

Scope the account permissions to the deployment account and the zone
permissions to the custom-domain zone. Durable Objects, Worker secrets, Workers
AI bindings, and Email Sending bindings are part of the Worker deployment and
do not require additional token permissions. A deployment without hosted
authentication does not need Turnstile or Email Sending. A deployment without
a custom domain does not need Zone or Workers Routes.

Cloudflare Email Sending is the outbound sender service. Email Routing handles
inbound mail and is not required. Onboard the exact domain after `@` in the
sender address and wait until Cloudflare marks it enabled. The sender may use
the deployment zone or one of its subdomains. The installer asks for the full
address instead of assuming a mailbox or domain.

Do not use a global API key. Keep account IDs and tokens out of committed config.

## E2B is required

v0.1.0 has no local or alternative production workspace adapter. The deployment
needs an E2B API key and immutable template identities for every enabled profile.
See [E2B profiles](/docs/deployment/e2b-profiles/).

## `deploy.selfhost.json`

The wizard writes this nonsecret JSON file:

```json
{
  "version": 1,
  "name": "my-dx",
  "cloudflareAccountId": "0123456789abcdef0123456789abcdef",
  "adminEmail": "me@example.com",
  "domain": "dx.example.com",
  "zone": "example.com",
  "allowSignup": false,
  "workersAi": true,
  "githubCopilotClientId": "optional-oauth-app-client-id",
  "modelDeploymentProviders": "optional,comma-separated,ids",
  "modelEndpointAllowlist": "optional,comma-separated,origins",
  "dxdBinary": ".dx/release/dxd-linux-x64",
  "integrations": ["github", "bitbucket", "sarvam"]
}
```

`version`, `cloudflareAccountId`, `domain`, `zone`, and every optional field may
be omitted. `domain` and `zone` must appear together. Without them, the deploy
uses the account's `workers.dev` subdomain. `dxdBinary` selects the checked local
fallback instead of downloading the release asset.

`allowSignup` defaults to `false`, leaving only the bootstrapped administrator
able to sign in. Setting it to `true` exposes Better Auth's direct
email/password account creation. It does not enable hosted magic links, a
waitlist, or an approved-email gate.

Wizard and noninteractive runs produce the same fail-closed plan. Same-version
reruns reuse unchanged resources and do not require the administrator password.
The matching secret environment inputs are
`CLOUDFLARE_API_TOKEN`, `DX_ADMIN_PASSWORD`, `E2B_API_KEY`,
`DX_INTEGRATION_GITHUB_APP`, `DX_INTEGRATION_BITBUCKET_OAUTH`, and
`SARVAM_API_KEY`.

The first self-host wizard run asks for a hidden administrator password and
confirmation. An empty first response generates one. A successful deploy
stores the URL, email, and password in ignored
`.dx/secrets/selfhost-admin.txt` with mode `0600`. Use
`pnpm dx:deploy -- --reset-admin` to replace the password explicitly.

The GitHub App and Bitbucket consumer values are strict JSON secrets supplied
through hidden prompts or environment variables. See [GitHub source
access](/docs/deployment/github-source/) and [Bitbucket source
access](/docs/deployment/bitbucket-source/) for their exact schemas. The Copilot
value is the client ID of an operator-owned GitHub OAuth App; see [GitHub
Copilot](/docs/deployment/github-copilot/).

## Cost review and cancellation

Review every resource before apply. Costs depend on provider plans and usage.

Cancel before apply to leave resources unchanged. After a failed apply, re-run
the same version. Use destroy only to remove the deployment.
