# Deploy dx to your accounts

dx uses Cloudflare for the application and E2B for agent workspaces. Install
dependencies, then run:

```bash
pnpm install
pnpm dx:deploy
```

The wizard signs in through Alchemy, collects the first administrator and E2B
key, offers optional deployment integrations, prints a redacted review, and
asks once before apply. It confirms an entered administrator password or
generates one from an empty prompt. It writes only nonsecrets to
`deploy.selfhost.json`.

Alchemy browser OAuth is the default Cloudflare login. Alchemy and Wrangler
have separate OAuth clients and token stores. dx does not read Wrangler tokens.
Alchemy refreshes its credential during `alchemy login`; preflight and apply
use that same profile and access token. For unattended deployment, set
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

After successful verification, the deploy stores only the login URL, email, and
password in ignored `.dx/secrets/selfhost-admin.txt` with mode `0600`. Standard
output contains the file path, never the password. Public signup defaults off;
`allowSignup: true` enables direct email/password registration without a
waitlist, email approval, or magic-link admission.

## E2B and dxd

E2B is required. The deploy hashes the checked-in recipe, reuses its exact
ready base build, and creates immutable `a1.tiny`, `a1.small`, and `a1.medium`
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

## Upgrade and rotation

```bash
pnpm dx:deploy                    # repeatable upgrade
pnpm dx:deploy -- --rotate        # rotate supplied integration/E2B secrets
pnpm dx:deploy -- --reset-admin   # explicitly replace the first admin password
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
