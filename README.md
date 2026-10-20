# dx

dx is a self-hosted coding agent for Cloudflare and E2B. The application,
database, storage, authentication, and agent workspace templates deploy into
accounts you control.

## Deploy

Node.js 22.19 or newer, pnpm 12, a Cloudflare account, and at least one Orb
provider are required: an E2B API key, or Cloudflare Containers (Workers Paid
plan and Docker on the deploying machine).

```sh
pnpm install --frozen-lockfile
pnpm dx:deploy
```

The wizard first asks whether dx should send sign-in email from your domain.
Without email it uses Alchemy browser login; Wrangler login is separate and is
not read. Sending email needs a custom domain, Cloudflare Email Sending on the
sender domain, and a scoped Cloudflare API token, because Alchemy OAuth cannot
manage Turnstile or inspect Email Sending. See the [deployment configuration](apps/docs/src/content/docs/deployment/configuration.md#cloudflare-authentication)
for the exact account and zone permissions.

The wizard then asks which sign-in methods the deployment offers (magic link,
email and password, Google) and who can create an account: anyone (`open`),
people you approve from a waitlist (`waitlist`), or only people with a
workspace invite link (`invite`, the default). Public password sign-up needs
sign-in email because every new address must be verified. You can also limit
accounts to a list of email domains. See [sign-in and authentication](apps/docs/src/content/docs/deployment/authentication.md).

The wizard asks for the first administrator's email. When the deployment offers
email and password, it reads the administrator password twice without echoing
it; leave the first prompt empty to generate one. After health and readiness
pass, dx writes the login URL, email, and password only to the ignored
mode-`0600` file `.dx/secrets/selfhost-admin.txt` and prints its path. It never
prints the password in deployment or Alchemy output. Without password sign-in,
the administrator signs in with a magic link or Google using that email.

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
