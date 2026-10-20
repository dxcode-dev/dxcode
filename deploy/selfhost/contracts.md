# Self-host deployment contracts

`pnpm dx:deploy` collects input. `scripts/run-alchemy-deployment.mjs` owns
preflight, normal Alchemy plan/apply, and verification. Automation may call the
runner directly with the same environment and `deploy.selfhost.json`.

## Authentication

The deployment uses Alchemy's Cloudflare profile for both preflight requests
and apply. `pnpm dx:deploy` refreshes the profile's browser OAuth credential
with `alchemy profile refresh` first; preflight reads it from
`~/.alchemy/profiles/dx-selfhost/cloudflare.json` (Alchemy 2.0.0-beta.83's
layout), and the Cloudflare provider reads the same profile outside CI mode. `CLOUDFLARE_API_TOKEN` plus `CLOUDFLARE_ACCOUNT_ID` is the supported
noninteractive fallback. Wrangler OAuth is a separate credential system and is
never read, copied, or refreshed by dx.

## Secrets and rotation

`deploy.selfhost.json` contains no secrets. Deployment secrets are redacted
Alchemy resource values, encrypted in the Cloudflare-backed state store, and
copied only into Worker secret bindings. Omitting a supplied secret retains its
prior value. A first deployment fails before apply when a required secret is
absent.

When the deployment offers `email-password`, the wizard confirms an entered
administrator password or generates one when the first password response is
empty. Only after deployment verification succeeds, the runner writes the URL,
email, and password to ignored `.dx/secrets/selfhost-admin.txt` with mode
`0600`. Logs and plans never contain the password.

Use `pnpm dx:deploy -- --rotate` to replace integration secrets and, with the
`google` provider, `DX_GOOGLE_CLIENT_SECRET`. Use
`pnpm dx:deploy -- --reset-admin` to replace the initial administrator's
password; it fails when the deployment has no password sign-in. Ordinary
upgrades never request that password.

## Sign-in

`deploy.selfhost.json` records sign-in in a `signIn` object:

```json
{
  "providers": ["magic-link", "email-password", "google"],
  "admission": "waitlist",
  "allowedEmailDomains": ["example.com"],
  "googleClientId": "1234567890-abc.apps.googleusercontent.com",
  "termsUrl": "https://example.com/terms",
  "privacyUrl": "https://example.com/privacy"
}
```

`providers` lists at least one of `magic-link`, `email-password`, and `google`,
once each. `admission` is `open`, `waitlist`, or `invite` and defaults to
`invite`. `allowedEmailDomains` lists lowercase domains matched exactly; empty
allows any domain. `googleClientId` is required with, and only with, `google`.
`termsUrl` and `privacyUrl` are optional https URLs shown on `/signin`.
[`config.mjs`](config.mjs) (`validateSignIn`) is the authority.

`authEmailFrom` is the sender for magic links and email verification. It must
be an address at the custom zone or a subdomain onboarded to Cloudflare Email
Sending before apply. Its presence also provisions a managed Turnstile widget.
Validation requires it for `magic-link`, and for `email-password` unless
admission is `invite`, because every public password sign-up is verified by
email. Google needs `DX_GOOGLE_CLIENT_SECRET` on the first deploy; Alchemy
retains it afterwards.

Bootstrap approves `adminEmail` on the waitlist idempotently, so it can sign
in under every admission policy and domain allowlist. When `email-password` is
offered, bootstrap also creates that user as verified with the administrator
password. Otherwise the user is created at the first magic-link or Google
sign-in. Turning `email-password` on later attaches the password to that
existing account and leaves its profile alone; the wizard offers to set the
administrator password when this machine has no credential file.

`pnpm dx:deploy -- --sign-in` reruns the sign-in step for an existing config,
and a config written before `signIn` existed is offered that step once. A
config without `signIn` keeps its earlier meaning: `authEmailFrom` means
magic link with `waitlist` admission; otherwise `email-password` with `invite`
admission. `allowSignup: true` without `authEmailFrom` now fails validation;
set `authEmailFrom`, or remove `allowSignup` to stay invite-only.

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

Sending sign-in email requires a Cloudflare API token because Alchemy OAuth
cannot manage Turnstile or inspect Email Sending. Before asking for non-
Cloudflare credentials, the wizard checks the token against Workers, Alchemy's
Secrets Store, D1, R2, Turnstile, the active zone and Worker routes, and the
exact Email Sending sender domain.
