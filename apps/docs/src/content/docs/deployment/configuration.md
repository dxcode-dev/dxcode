---
title: Deployment configuration
description: Choose an origin, authenticate to Cloudflare, configure sign-in, and review deployment behavior.
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

Magic-link sign-in requires API-token mode: Alchemy OAuth cannot manage the
Turnstile widget that protects it. A sender used only for notification email
(`authEmailFrom` without magic link) works with Alchemy OAuth, because the
Email Sending binding is part of the Worker deployment. The deployment records
its choice as `cloudflareAuth`.

For API-token mode, use a narrowly scoped token for the target account and zone.
The complete permission set for a custom-domain deployment that offers magic
link is:

| Scope | Permission | Access |
| --- | --- | --- |
| Account | Workers Scripts | Edit |
| Account | D1 | Edit |
| Account | Workers R2 Storage | Edit |
| Account | Secrets Store | Edit |
| Account | Turnstile | Edit |
| Account | Email Sending | Edit |
| Account | Account API Tokens | Edit |
| Zone | Zone | Read |
| Zone | Workers Routes | Edit |

Scope the account permissions to the deployment account and the zone
permissions to the custom-domain zone. Durable Objects, Worker secrets, Workers
AI bindings, and Email Sending bindings are part of the Worker deployment and
do not require additional token permissions. A deployment without magic link
does not need Turnstile, and one without `authEmailFrom` does not need Email
Sending. A deployment without
a custom domain does not need Zone or Workers Routes. A deployment with
`portalDomain` also needs Zone Read, Workers Routes Edit, and DNS Edit on the
Portal zone.

Account API Tokens lets the deployment create one more token: object read
and write on its own storage bucket and nothing else. dx signs short-lived
storage URLs with it, so browsers upload message attachments straight to R2
and the agent's Orb downloads them from R2 without passing through the Worker.
Removing the deployment deletes that token. With Alchemy OAuth, which cannot
create tokens, attachments work the same way for people but their bytes pass
through the Worker.

Do not use a global API key. Keep account IDs and tokens out of committed config.

## Sign-in

Sign-in methods (magic link, email and password, Google), who may create an
account, allowed email domains, and the sign-in email sender are covered in
[sign-in and authentication](/docs/deployment/authentication/).

## Orb providers

Each Thread's workspace (its Orb) runs on an Orb provider. A deployment needs
none of its own: people and workspaces connect their own provider accounts in
Settings → Orb Providers, and dx prepares each account before its sizes show
in the Orb picker. For E2B that means an API key, and dx builds its Orb
templates in that E2B team.

A deployment may also offer providers on its own account, which it then pays
for. `orbProviders` in `deploy.selfhost.json` records them, and `[]` offers
none. A file without it means `["e2b"]`.

- `e2b` needs an E2B API key. The deploy builds immutable templates for every
  profile. See [E2B profiles](/docs/deployment/e2b-profiles/).
- `cloudflare` (Cloudflare Containers) needs no key. Containers run and are
  billed in the deployment's Cloudflare account, which needs the Workers Paid
  plan. The deploying machine needs a running Docker daemon with Buildx to
  build the Orb image and push it to the account registry; the deploy checks
  both before it changes anything, and keeps the registry login out of your
  OS keychain. With API-token
  authentication, the token must also manage Durable Objects and Containers.
  Sizes are `cf.standard-1` through `cf.standard-4`.

The wizard asks which providers to offer on first deploy; each defaults to
no. To add Containers
to an existing deployment, set `"orbProviders": ["e2b", "cloudflare"]` and rerun
`pnpm dx:deploy`.

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
  "portalDomain": "example-portals.dev",
  "authEmailFrom": "sign-in@mail.example.com",
  "signIn": {
    "providers": ["magic-link", "google"],
    "admission": "waitlist",
    "allowedEmailDomains": ["example.com"],
    "googleClientId": "1234567890-abc.apps.googleusercontent.com",
    "termsUrl": "https://example.com/terms",
    "privacyUrl": "https://example.com/privacy"
  },
  "workersAi": true,
  "workerTraces": false,
  "githubCopilotClientId": "optional-oauth-app-client-id",
  "modelDeploymentProviders": "optional,comma-separated,ids",
  "modelEndpointAllowlist": "optional,comma-separated,origins",
  "dxdBinary": ".dx/release/dxd-linux-x64",
  "integrations": ["github", "bitbucket", "sarvam"],
  "orbProviders": ["e2b"]
}
```

`version`, `cloudflareAccountId`, `domain`, `zone`, and every optional field may
be omitted. `domain` and `zone` must appear together. Without them, the deploy
uses the account's `workers.dev` subdomain. `dxdBinary` selects the checked local
fallback instead of downloading the release asset.

`authEmailFrom` must be an address inside `zone`. In `signIn`, `providers`
lists each method once; `admission` defaults to `invite`; `googleClientId` is
required with, and only with, `google`; `termsUrl` and `privacyUrl` must be
https URLs.

A file without `signIn` keeps its earlier behavior. With `authEmailFrom`, it
means magic link with `waitlist` admission. Without it, it means email and
password with `invite` admission. In such a file, `allowSignup: true`
without `authEmailFrom` fails validation, because public password sign-up now
verifies each address by email; see [upgrade and
recovery](/docs/operations/upgrade-recovery/#sign-in-configuration).

`workerTraces` turns on Cloudflare Workers traces for the dx Worker. Logs are
always on. Traces record request URLs and Durable Object names, so they default
to off. They also carry dx's spans, which hold route templates, IDs, and
counts, and the agent's model, token usage, and tool names, but not prompts,
answers, or tool arguments and results. The wizard asks on first deploy, and
asks once when upgrading a deployment whose file has no `workerTraces` key.
The answer is saved in this file, so later reruns do not ask again. Edit the
value and rerun `pnpm dx:deploy` to change it.

`portalDomain` turns on Portals: a web app running in a Thread's workspace is
served at `https://t-<thread>-p<port>.<portalDomain>/` behind dx sign-in. It
names the apex of a separate, active Cloudflare zone in the same account, on a
registrable domain other than the app's: with the app at `dx.example.com`,
`example-portals.dev` works but `example.com` and `portals.example.com` do
not, and no `workers.dev` name does. A same-site Portal could set cookies the
app reads. The wizard asks whether to enable Portals and offers the account's
eligible zones; `pnpm dx:deploy -- --portals` changes the choice later. The
deploy adds a Worker route and a proxied wildcard DNS record on that zone,
after checking that the credential holds Zone Read, DNS Edit, and Workers
Routes Edit on it. Remove the key and rerun `pnpm dx:deploy` to turn Portals
off.

Wizard and noninteractive runs produce the same fail-closed plan. Same-version
reruns reuse unchanged resources and do not require the administrator password.
Secrets are supplied through hidden prompts or these environment variables.
Each one is needed on the first deploy that uses it; Alchemy retains it
afterwards.

| Variable | Needed when |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API-token mode, including any deployment with `authEmailFrom` |
| `DX_ADMIN_PASSWORD` | `signIn.providers` includes `email-password` |
| `DX_GOOGLE_CLIENT_SECRET` | `signIn.providers` includes `google` |
| `E2B_API_KEY` | `orbProviders` includes `e2b` |
| `DX_INTEGRATION_GITHUB_APP` | `integrations` includes `github` |
| `DX_INTEGRATION_BITBUCKET_OAUTH` | `integrations` includes `bitbucket` |
| `SARVAM_API_KEY` | `integrations` includes `sarvam` |
| `EXA_API_KEY` | `integrations` includes `exa` |

With password sign-in, the first wizard run asks for a hidden administrator
password and confirmation. An empty first response generates one. A
successful deploy stores the URL, email, and password in ignored
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
