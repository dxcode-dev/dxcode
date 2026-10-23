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

1. Choose whether dx sends email from your domain, and whether it offers
   magic-link sign-in. One sender serves magic links, verified password
   sign-up, and notification emails such as mentions. Sending email needs a
   custom domain and Cloudflare Email Sending on the sender domain. Magic
   link also needs a Cloudflare API token for its Turnstile widget;
   notification email alone works with browser authorization. Without a
   sender, mentions show in the app only.
2. Authorize Cloudflare in a browser, or enter the API token when magic link
   needs one, then enter the sender address when sending email.
3. Select a `workers.dev` address or configure a custom domain.
4. Enter the first administrator email.
5. Choose sign-in methods: email and password, and Google (magic link was
   answered in step 1). For Google, create an OAuth client with the redirect
   URI the wizard prints, then enter its client ID and hidden secret.
6. Choose who can create an account: `open`, `waitlist`, or `invite` (the
   default). Public password sign-up requires sending email. Optionally limit
   accounts to listed email domains and link Terms of Service and Privacy
   Policy pages.
7. When the deployment offers email and password, enter the administrator
   password twice. Leave the first password prompt empty to generate one.
8. Choose the Orb providers the deployment offers on its own account: E2B,
   Cloudflare Containers, both, or neither (each defaults to no). Without one,
   people connect their own E2B account in Settings → Orb Providers. E2B asks
   for an API key, and the deploy builds the `a1.tiny`, `a1.small`, and
   `a1.medium` profiles. Containers requires the Workers Paid plan and Docker
   on this machine.
9. Choose optional source and model integrations. Public Git repositories work
   without GitHub or Bitbucket configuration.
10. Review the redacted configuration before approving the apply.

To offer magic-link sign-in, prepare a Cloudflare API token before starting. It needs
account Edit access for Workers Scripts, D1, Workers R2 Storage, Secrets Store,
Turnstile, Email Sending, and Account API Tokens, plus zone Read and Workers
Routes Edit for the selected zone. Cloudflare Email Sending must be enabled for the exact sender
domain. Email Routing is unrelated and is not a prerequisite. See [sign-in](/docs/deployment/authentication/)
and [Cloudflare authentication](/docs/deployment/configuration/#cloudflare-authentication).

Prepare provider values before starting if you intend to enable them:

- [GitHub App JSON](/docs/deployment/github-source/)
- [Bitbucket OAuth JSON](/docs/deployment/bitbucket-source/)
- [GitHub Copilot OAuth client ID](/docs/deployment/github-copilot/)

The command prints the deployment URL, login email, and enabled sign-in
methods only after health and readiness checks pass. With password sign-in it
also prints the credential-file path and password-reset command, never the
password. The ignored `.dx/secrets/selfhost-admin.txt` file is created with
mode `0600` after a successful deploy and contains the URL, email, and
password. Without password sign-in, open the URL and sign in with a magic link
or Google using the administrator email.

The installer checks Cloudflare capabilities before asking for E2B or provider
secrets. A denied request names the missing product permission instead of
reporting only a generic 403.

Account creation is invite-only by default: only the administrator and people
with a workspace invite link can create accounts. See
[sign-in](/docs/deployment/authentication/) for the other admission
policies.

## Use noninteractive mode

Automation uses the same runner and normal Alchemy plan/apply as the wizard. Create
`deploy.selfhost.json`, provide secrets through environment variables, then
run:

```sh
DX_DEPLOY_APPROVE=1 \
  node scripts/run-alchemy-deployment.mjs deploy selfhost
```

The first deploy requires `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`,
`DX_ADMIN_PASSWORD` when `signIn.providers` includes `email-password`,
`DX_GOOGLE_CLIENT_SECRET` when it includes `google`, and, when `orbProviders`
includes `e2b` (the default), `E2B_API_KEY`. After successful verification, the
runner writes the same mode-`0600` administrator credential file. Add
`DX_INTEGRATION_GITHUB_APP`, `DX_INTEGRATION_BITBUCKET_OAUTH`, or
`SARVAM_API_KEY` only when the matching name appears in `integrations`.

Never commit `deploy.selfhost.json`, deployment state, generated credentials,
administrator passwords, API tokens, or provider keys.

Continue to [your first project and thread](/docs/get-started/first-project/).
