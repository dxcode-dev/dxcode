# Deploy dx to your accounts

dx uses Cloudflare for the application and E2B for agent workspaces. Install
dependencies, then run:

```bash
pnpm install
pnpm dx:deploy
```

The wizard asks whether to send sign-in email from your domain and whether to
enable [Portals](#portals), signs in to Cloudflare, collects the first
administrator, the Portal zone, the sign-in methods and admission policy, and
the E2B key, offers optional deployment integrations, prints a redacted
review, and asks once before apply. When the deployment
offers email and password, it confirms an entered administrator password or
generates one from an empty prompt. It writes only nonsecrets to
`deploy.selfhost.json`.

Sign-in methods are magic link, email and password, and Google. Admission is
`open`, `waitlist`, or `invite` (the default), optionally limited to listed
email domains. Magic links and public password sign-up need `authEmailFrom`,
a Cloudflare Email Sending address inside the deployment zone. The same sender
sends notification emails (mentions) whatever sign-in methods are offered;
without it, notifications stay in the app. Only magic link needs an API token,
for its Turnstile widget; a sender for notification email alone deploys with
Alchemy's browser login (`cloudflareAuth` records the choice). Google needs an
OAuth client with the redirect URI `https://<domain>/api/auth/callback/google`;
its client ID goes in the `signIn` block and its secret is
`DX_GOOGLE_CLIENT_SECRET`. `pnpm dx:deploy -- --sign-in` changes sign-in on
an existing deployment. See [sign-in and
authentication](../apps/docs/src/content/docs/deployment/authentication.md).

Alchemy browser OAuth is the default Cloudflare login. Alchemy and Wrangler
have separate OAuth clients and token stores. dx does not read Wrangler tokens.
`pnpm dx:deploy` signs in or refreshes the `dx-selfhost` Alchemy profile with
`alchemy profile edit` or `alchemy profile refresh` (run through
`node_modules/alchemy/bin/alchemy.js`, since Alchemy's `alchemy` launcher needs
Node 24); preflight and apply use that same profile and access token.
Browser login cannot create the token Core signs attachment URLs with, so
the installer asks once for an R2 API token you create under R2 → Manage API
tokens (Object Read & Write) and prints the steps; set `DX_R2_ACCESS_KEY_ID`
and `DX_R2_SECRET_ACCESS_KEY` to answer without the prompt. Attachments then
upload straight to R2, as on every dx deployment. For unattended deployment, set
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, the first-run secrets, and
`DX_DEPLOY_APPROVE=1`, then run:

```bash
node scripts/run-alchemy-deployment.mjs deploy selfhost
```

The first apply creates or upgrades Alchemy's encrypted Cloudflare state store.
No separate `alchemy bootstrap` command is needed. Generated keys and supplied
operator secrets remain in that state and in Worker secret bindings. A normal
rerun asks for no unchanged secrets and works from another machine when it has
the same `deploy.selfhost.json` and Cloudflare login.

When the deployment offers email and password, the deploy stores only the
login URL, email, and password in ignored `.dx/secrets/selfhost-admin.txt` with
mode `0600` after successful verification. Standard output contains the file
path, never the password. It also prints the enabled sign-in methods and, with
Google, the redirect URI.

## E2B and dxd

A deployment installs at least one Orb provider: E2B, Cloudflare Containers, or
both (`orbProviders` in `deploy.selfhost.json`; a file without it means
`["e2b"]`). Containers needs the Workers Paid plan and a running Docker daemon
with buildx on the deploying machine, which builds [`orb/Dockerfile`](orb/Dockerfile)
for the Orb Worker ([`orb/README.md`](orb/README.md)).

With E2B, the deploy hashes the checked-in recipe (the standard Orb
image, [`orb/Dockerfile`](orb/Dockerfile), built by E2B through
[`e2b/template.mjs`](e2b/template.mjs)), reuses its exact ready base build,
and creates immutable `a1.tiny`, `a1.small`, and `a1.medium`
builds. The Worker receives each exact `name:buildID`. Rerunning the same recipe
builds nothing.

By default dx downloads the Linux x64 dxd asset named in `deploy/RELEASE.json`
and checks the SHA-256 recorded there before Alchemy can apply. Treat that file
as the release authority rather than copying its tag, URL, or checksum into
operator notes. While the repository is private, set
`DX_DXD_GITHUB_TOKEN="$(gh auth token)"` only for the deploy command. The token
is sent only to GitHub's API and is never logged; the checksum remains
mandatory. The final public release downloads anonymously. The explicit local
fallback remains `pnpm deploy:selfhost:dxd` with `dxdBinary` set to
`.dx/alchemy/dxd-linux-x64/dxd`.

## Portals

Portals serve a web app running in a Thread's workspace at
`https://t-<thread>-p<port>.<portal domain>/`, behind dx sign-in. They are off
by default.

The wizard asks `Enable Portals` (default no) before it signs in to
Cloudflare. On yes, it lists the account's active zones that can serve them
and asks for a number or zone name; a blank answer leaves Portals off. A zone
that already has DNS records, Worker routes, or Worker custom domains is
flagged and needs a second yes, because the Portal route `*.<zone>/*` takes
over its proxied subdomains and the wildcard record answers every unused
name. When no zone qualifies, the wizard says so in one line and the deploy
continues without Portals. The choice is saved as `portalDomain` in
`deploy.selfhost.json`:

```json
{ "portalDomain": "example-portals.dev" }
```

`pnpm dx:deploy -- --portals` turns Portals on, moves them to another zone,
or turns them off on an existing deployment. Removing `portalDomain` and
redeploying removes the Portal resources.

The Portal domain must be the apex of an active zone in the same account, on
a registrable domain (eTLD+1, by the Public Suffix List) different from the
app's. With the app at `dx.example.com`, `example-portals.dev` works, but
`example.com`, `portals.example.com`, and `portals.dx.example.com` are
refused, and so is any `workers.dev` name. A same-site Portal host would let
code running in a Thread set `Domain=example.com` cookies the app reads
(session fixation, login CSRF) and would count as same-site for the app's
`SameSite` cookies. An app on `workers.dev` can still serve Portals from a
zone of its own. Without one, Portals stay off: `workers.dev` gives each
Worker one fixed hostname and no wildcard route.

Portal hosts share the Portal domain as their registrable domain, so one
Portal could set cookies for another. Submitting the Portal domain to the
[Public Suffix List](https://publicsuffix.org/submit/) makes each Portal host
its own site in browsers that ship the updated list.

`DX_DEPLOYMENT_PORTAL_DOMAIN` overrides the file for one deploy. The deploy
looks up that zone's ID (or takes `DX_DEPLOYMENT_PORTAL_ZONE_ID`) and adds
a Portal Worker on the route `*.<portal domain>/*` and a proxied
`*.<portal domain>` `AAAA 100::` record. Universal SSL covers that one
wildcard level.

Before anything is planned, the wizard and
[`run-alchemy-deployment.mjs`](../scripts/run-alchemy-deployment.mjs) check
the Portal zone through read-only calls
([`selfhost/portals.mjs`](selfhost/portals.mjs)) and stop with the missing
permission and zone:

| Permission (Zone scope, on the Portal zone) | API token | Alchemy OAuth scope |
| --- | --- | --- |
| Zone → Zone → Read | lists the zone | `zone.read` |
| Zone → DNS → Edit | lists DNS records | `dns.write` |
| Zone → Workers Routes → Edit | lists Worker routes | `workers-routes.write` |

A read call proves Read access only. When the token can read its own
policies (an account-owned token, which a deployment that holds Account API
Tokens can read), the check also confirms Edit on the zone. Otherwise it
says that Edit is confirmed at apply. Alchemy's All Scopes login includes
`dns.write`, and its Basic Scopes login does not; the wizard adds it when
Portals are on (through `ALCHEMY_CLOUDFLARE_OAUTH_EXTRA_SCOPES`, added by dx's
Alchemy patch). An existing login without it is offered a new sign-in with
`alchemy profile edit --reconfigure Cloudflare`: choose OAuth, All Scopes or
Basic Scopes, and the same account.

## Upgrade and rotation

```bash
pnpm dx:deploy                    # repeatable upgrade
pnpm dx:deploy -- --rotate        # rotate supplied integration, E2B, Google, and R2 attachment secrets
pnpm dx:deploy -- --reset-admin   # replace the first admin password (password sign-in only)
pnpm dx:deploy -- --portals       # turn Portals on or off, or choose another Portal zone
```

GitHub, Bitbucket, Sarvam, Copilot, and other deployment integrations are
optional. Omitted capabilities have no binding or use the product's disabled
sentinel and do not block `/readyz`. User and workspace model keys are still
configured inside dx.

The deploy verifies `/healthz`, `/readyz`, and the dxd download after apply.
For a new custom domain, Cloudflare DNS can take longer than the verifier's
60-second window. If apply succeeds but `/healthz` reports a name-resolution or
route failure, wait for the authoritative record to resolve, refresh DNS, and
rerun the same command. Do not recreate resources or change Alchemy state.
See [`selfhost/contracts.md`](selfhost/contracts.md) for the noninteractive,
readiness, rotation, and cancellation contracts.
