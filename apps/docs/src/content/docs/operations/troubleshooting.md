---
title: Troubleshooting
description: Diagnose deployment, workspace, provider, and readiness failures without leaking secrets.
---

Identify the failing phase before changing configuration.

## Cloudflare authentication

- Retry browser authorization and confirm you selected the intended account.
- In API-token mode, verify the account ID and token scope. Add only the missing
  permission.
- For a custom domain, confirm the zone belongs to the selected account.
- If browser authorization is unavailable, use the documented token fallback.
  Set both `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.

## Permissions and deployment state

- A plan rejection means the release did not allow an infrastructure operation.
- Run the same release again after a partial apply.
- Keep the deployment state directory private and intact. Do not hand-edit
  resource IDs or generated credentials.
- After moving machines, use the same release and `deploy.selfhost.json`, log
  into the same Cloudflare account, and rerun `pnpm dx:deploy`.

Alchemy stores its state token and encryption key in one Cloudflare Secrets
Store. Accounts can contain unrelated stores. Current dx scans for the store
that contains active `AlchemyStateStoreToken` and
`AlchemyStateStoreEncryptionKey` secrets instead of selecting the first store.
If preflight reports an incomplete state store, stop before entering other
credentials. Upgrade to the current release and rerun. If the error remains,
inspect the store used by the `alchemy-state-store` Worker and preserve its
resources while recovering the missing secrets. Do not point Alchemy at an
unrelated first store or delete state that owns deployed resources.

## E2B quota and templates

Check API-key ownership, quota, aliases, build IDs, and profile resources. A
readiness failure can indicate a mismatched `dxd` binary or template. See
[E2B profiles](/docs/deployment/e2b-profiles/#troubleshoot-templates).

A `dxd` download or checksum failure stops before apply. Confirm that the
release asset is reachable and matches `deploy/RELEASE.json`. The local fallback
is `pnpm deploy:selfhost:dxd` with `dxdBinary` set in
`deploy.selfhost.json`.

`deploy/RELEASE.json names dxd X, but this revision is dxd Y` means the checkout
and its release record disagree. Deploy from an unmodified release tag, whose
record names the `dxd` version in `apps/dxd/Cargo.toml`.

## Cloudflare Containers image push

When Cloudflare Containers is an Orb provider, the deploy builds the Orb image
with Docker, and Wrangler pushes it to `registry.cloudflare.com`. On macOS,
Wrangler's `docker login registry.cloudflare.com` can fail after the image
builds with:

```text
error storing credentials ... The specified item already exists in the keychain. (-25299)
```

Docker's macOS credential helper found an old entry for the registry in the
keychain. Try these in order, rerunning the deploy after each:

1. Run `docker logout registry.cloudflare.com`.
2. Run `security delete-internet-password -s registry.cloudflare.com` to
   remove the keychain entry directly.
3. Set `"credsStore": ""` in `~/.docker/config.json` for this deploy only, so
   Docker stores the registry login unencrypted in that file. Restore the
   previous value afterwards.

A rerun is safe. The Orb Worker is created only after the image push succeeds,
so a failed push leaves nothing partial.

## Provider errors

**Not configured** means routing has no usable credential. Configure a route.
Authentication, quota, and rate-limit errors come from the selected provider.

For a custom endpoint, verify the HTTPS origin, protocol selection, allowlist,
model identifier, and credential scope. dx should not fall back to a different
provider after a request fails.

For source integrations, use the focused steps for [GitHub](/docs/deployment/github-source/#troubleshooting)
or [Bitbucket](/docs/deployment/bitbucket-source/#troubleshooting). Copilot
authorization and compatibility limits are on the [GitHub Copilot
page](/docs/deployment/github-copilot/#troubleshooting).

## Health and readiness

`/healthz` answers whether the Worker process can respond. `/readyz` checks
inference-free deployment wiring. A ready response does not prove that E2B can
start a sandbox or that a paid model can answer a prompt.

If health fails, inspect the Worker and route. If readiness fails, inspect
bindings, migrations, release assets, and configuration.

After a successful first apply to a custom domain, `/healthz` can remain
unreachable while DNS propagates. The deploy verifier waits 60 seconds. Check
the authoritative DNS record and Worker custom-domain route, wait for the name
to resolve, refresh local DNS, and rerun the same deployment. A DNS-only timeout
does not require state repair or resource replacement.

## Share redacted diagnostics

Before opening an issue, remove:

- passwords, API keys, cookies, authorization headers, and OAuth codes
- deployment state, generated credentials, and encryption or signing keys
- repository URLs and source content that are not public
- user email addresses, account IDs, project names, and custom domains

Include the dx version, command phase, timestamp, HTTP status, provider error
code, and redacted resource type. Do not paste complete environment dumps.
