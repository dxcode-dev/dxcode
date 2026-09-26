# dx

dx is a self-hosted coding agent for Cloudflare and E2B. The application,
database, storage, authentication, and agent workspace templates deploy into
accounts you control.

## Deploy

Node.js 22.19 or newer, pnpm 9, a Cloudflare account, and an E2B API key are
required.

```sh
pnpm install --frozen-lockfile
pnpm dx:deploy
```

The wizard uses Alchemy browser login for ordinary self-hosting. Wrangler login
is separate and is not read. Hosted magic-link deployments need a scoped
Cloudflare API token because Alchemy OAuth cannot manage Turnstile or inspect
Email Sending. See the [deployment configuration](apps/docs/src/content/docs/deployment/configuration.md#cloudflare-authentication)
for the exact account and zone permissions.

The wizard configures the deployment, asks for the first administrator's email,
and reads the password twice without echoing it. Leave the first password prompt
empty to generate a password. After health and readiness pass, dx writes the
login URL, email, and password only to the ignored mode-`0600` file
`.dx/secrets/selfhost-admin.txt` and prints its path. It never prints the
password in deployment or Alchemy output.

Public signup is disabled by default. Set `allowSignup` to `true` in
`deploy.selfhost.json` to enable ordinary email/password account creation. This
does not enable a waitlist, approval gate, or magic-link admission.

Rerunning `pnpm dx:deploy` reconciles the existing deployment without requesting
or changing the administrator password. To replace it explicitly, run:

```sh
pnpm dx:deploy -- --reset-admin
```

See the [deployment guide](apps/docs/src/content/docs/get-started/install.md) and
[`deploy/README.md`](deploy/README.md) for configuration, local `dxd` fallback,
upgrades, and recovery.

## Develop

```sh
pnpm dev
pnpm test
pnpm typecheck
```

The workspace contains the Cloudflare Worker in `apps/core`, the browser client
in `apps/web`, the resident daemon in `apps/dxd`, shared packages under
`packages`, and Flue under `third-party/flue`.

## License

dx uses the [Functional Source License 1.1 with Apache License 2.0 Future
License](LICENSE), SPDX `FSL-1.1-ALv2`. See [TRADEMARK](TRADEMARK) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the related notices.
