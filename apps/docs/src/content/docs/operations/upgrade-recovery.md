---
title: Upgrade and recovery
description: Reconcile deployments, rotate secrets, reset an administrator, and remove resources.
---

dx has no backup or restore command. Make provider-level backups before an
upgrade or destructive operation.

## Re-run the same version

Run `pnpm dx:deploy` with the same release and `deploy.selfhost.json`. The
command loads encrypted Alchemy state from Cloudflare and reconciles incomplete
or drifted resources. It does not ask for or change the administrator password.
Review the plan before applying it.

Do not delete Cloudflare-backed Alchemy state to fix a failed run. It holds
resource identities, generated keys, and retained operator secrets.

If an account has several Secrets Stores, Alchemy must use the one containing
the active `AlchemyStateStoreToken` and `AlchemyStateStoreEncryptionKey` pair.
The current release finds that store by its secrets. An incomplete-store error
stops before apply so an unrelated store cannot replace deployment state.

## Upgrade versions

Read the release notes, then review migrations and template changes before
apply. The deploy only moves forward. There is no automatic rollback command.
Do not run an older release unless its notes explicitly confirm schema and
resource compatibility. Recovering data after an incompatible change requires
provider-level exports or snapshots made before the upgrade.

## Move to another machine

Copy the same `deploy.selfhost.json` to the new machine, install the same dx
release, and authenticate to the same Cloudflare account. A normal
`pnpm dx:deploy` rerun reconnects to Cloudflare-backed Alchemy state. There is
no separate adoption command or portable state bundle.

## Rotate secrets

Rotate one credential class at a time:

1. Create or select the replacement at its provider.
2. Update dx through the deployment or settings workflow.
3. Verify health, readiness, and one operation that uses the credential.
4. Revoke the old credential at the provider.

Run `pnpm dx:deploy -- --rotate` to replace the E2B key and selected deployment
integration secrets. Ordinary reruns retain omitted secrets. Encryption and
workload-signing keys are generated state and are not rotated by this flag.

## Reset the administrator

Run `pnpm dx:deploy -- --reset-admin`. The wizard reads the replacement password
and confirmation without echoing them; leave the first prompt empty to generate
a replacement. After verification succeeds, it updates the ignored mode-`0600`
credential file. The reset does not enable public signup.

## Back up data

dx has no backup or restore command. Use Cloudflare's supported D1 and
R2 export or recovery facilities before an upgrade, and preserve the
Cloudflare-backed Alchemy state. Confirm consistency for your workload; separate
provider exports may not represent one atomic recovery point.

## Destroy a deployment

Destroy is irreversible for resources without a separate backup. Confirm the
deployment identity and provider accounts, then run:

```sh
pnpm deploy:selfhost:destroy
```

After destroy, check E2B for running sandboxes or retained templates. Verify
provider billing pages too.
