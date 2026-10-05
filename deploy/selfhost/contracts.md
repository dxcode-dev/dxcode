# Self-host deployment contracts

`pnpm dx:deploy` collects input. `scripts/run-alchemy-deployment.mjs` owns
preflight, normal Alchemy plan/apply, and verification. Automation may call the
runner directly with the same environment and `deploy.selfhost.json`.

## Authentication

The deployment uses Alchemy's Cloudflare profile for both preflight requests
and apply. Alchemy 2.0.0-beta.74 refreshes its browser OAuth credential before
returning it from `CloudflareAuth.read`; the Cloudflare provider reads the same
profile. `CLOUDFLARE_API_TOKEN` plus `CLOUDFLARE_ACCOUNT_ID` is the supported
noninteractive fallback. Wrangler OAuth is a separate credential system and is
never read, copied, or refreshed by dx.

## Secrets and rotation

`deploy.selfhost.json` contains no secrets. Deployment secrets are redacted
Alchemy resource values, encrypted in the Cloudflare-backed state store, and
copied only into Worker secret bindings. Omitting a supplied secret retains its
prior value. A first deployment fails before apply when a required secret is
absent.

The wizard confirms an entered administrator password or generates one when the
first password response is empty. Only after deployment verification succeeds,
the runner writes the URL, email, and password to ignored
`.dx/secrets/selfhost-admin.txt` with mode `0600`. Logs and plans never contain
the password.

Use `pnpm dx:deploy -- --rotate` to replace integration secrets. Use
`pnpm dx:deploy -- --reset-admin` to replace the initial administrator's
password. Ordinary upgrades never request that password.

Self-host uses direct email/password authentication. Signup defaults off;
`allowSignup: true` enables ordinary account creation without hosted magic
links, waitlist enrollment, or approved-email admission.

Generic self-host configuration may instead set `authEmailFrom` to an address
at its custom zone or a subdomain. Presence enables managed Turnstile, waitlist
admission, and magic-link authentication. Bootstrap approves `adminEmail`
idempotently and does not create a password credential. The sender domain must
be onboarded through Cloudflare Email Sending before apply.

## Readiness

Cloudflare, D1, R2, generated authentication keys, E2B, the three E2B runner
profiles, and the pinned dxd asset are required. GitHub, Bitbucket, Sarvam,
Copilot, and deployment model integrations are optional. If omitted, their
bindings are absent or carry the product's disabled sentinel. They do not block
`/readyz`. User and workspace model keys remain product configuration.

First-party plugins are chosen at install: `plugins: ["search", "speech"]`
installs the Search and Speech plugins and becomes the `DX_INSTALLED_PLUGINS`
binding. Each plugin has an optional deployment-scope provider key: the `exa`
integration adds `EXA_API_KEY` for Search and the `sarvam` integration adds
`SARVAM_API_KEY` for Speech (composer dictation). Without one, people and
workspaces can still add their own keys in Settings → Plugins.
`offeredPlugins` records which plugins the installer has asked about, so an
existing deployment is asked once about a plugin added later. A config written
before Speech was a plugin that has the `sarvam` integration keeps dictation:
validation installs Speech and marks it asked. A deployment that omits a plugin
shows no settings, tools, composer affordance, or readiness requirement for it.

Apply starts only after account, zone, E2B, release checksum, and package
preflight complete. Cancellation before the review confirmation does not mutate
Cloudflare or E2B.

Hosted authentication requires a Cloudflare API token because Alchemy OAuth
cannot manage Turnstile or inspect Email Sending. Before asking for non-
Cloudflare credentials, the wizard checks the token against Workers, Alchemy's
Secrets Store, D1, R2, Turnstile, the active zone and Worker routes, and the
exact Email Sending sender domain.
