---
title: Install and deploy
description: Configure Cloudflare and E2B, then deploy dx.
sidebar:
  order: 2
---

Use a release checkout. The installer downloads the matching Linux x64 `dxd`
asset and verifies its SHA-256 checksum before changing infrastructure. To use a
local binary instead, run `pnpm deploy:selfhost:dxd` and set `dxdBinary` in
`deploy.selfhost.json` to the path printed by that command.

## Run the setup wizard

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dx:deploy
```

The wizard will ask you to:

1. Authorize Cloudflare in a browser, or choose API-token authentication.
2. Select a `workers.dev` address or configure a custom domain.
3. Enter an E2B API key. The deploy builds the `a1.tiny`, `a1.small`, and
   `a1.medium` profiles.
4. Enter the first administrator email and a hidden password twice. Leave the
   first password prompt empty to generate one.
5. Choose optional source and model integrations. Public Git repositories work
   without GitHub or Bitbucket configuration.
6. Review the redacted configuration before approving the apply.

For a custom-domain hosted-authentication deployment, prepare a Cloudflare API
token before starting. It needs account Edit access for Workers Scripts, D1,
Workers R2 Storage, Secrets Store, Turnstile, and Email Sending, plus zone Read
and Workers Routes Edit for the selected zone. Cloudflare Email Sending must be
enabled for the exact sender domain. Email Routing is unrelated and is not a
prerequisite. See [deployment configuration](/docs/deployment/configuration/#cloudflare-authentication).

Prepare provider values before starting if you intend to enable them:

- [GitHub App JSON](/docs/deployment/github-source/)
- [Bitbucket OAuth JSON](/docs/deployment/bitbucket-source/)
- [GitHub Copilot OAuth client ID](/docs/deployment/github-copilot/)

The command prints the deployment URL, login email, credential-file path, and
password-reset command only after health and readiness checks pass. It never
prints the password. The ignored `.dx/secrets/selfhost-admin.txt` file is created
with mode `0600` after a successful deploy and contains the URL, email, and
password. Open the URL and sign in with those credentials.

The installer checks Cloudflare capabilities before asking for E2B or provider
secrets. A denied request names the missing product permission instead of
reporting only a generic 403.

Public signup is disabled by default. Setting `allowSignup` to `true` enables
ordinary direct email/password account creation. Self-host deployments do not
use a waitlist, approved-email gate, magic links, or hosted early-access flow.

## Use noninteractive mode

Automation uses the same runner and normal Alchemy plan/apply as the wizard. Create
`deploy.selfhost.json`, provide secrets through environment variables, then
run:

```sh
DX_DEPLOY_APPROVE=1 \
  node scripts/run-alchemy-deployment.mjs deploy selfhost
```

The first deploy requires `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`,
`DX_ADMIN_PASSWORD`, and `E2B_API_KEY`. After successful verification, the
runner writes the same mode-`0600` administrator credential file. Add
`DX_INTEGRATION_GITHUB_APP`, `DX_INTEGRATION_BITBUCKET_OAUTH`, or
`SARVAM_API_KEY` only when the matching name appears in `integrations`.

Never commit `deploy.selfhost.json`, deployment state, generated credentials,
administrator passwords, API tokens, or provider keys.

Continue to [your first project and thread](/docs/get-started/first-project/).
