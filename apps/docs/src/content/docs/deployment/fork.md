---
title: Deploy from a fork
description: Keep a thin fork that deploys dx release tags to your own Cloudflare account from GitHub Actions.
---

A fork can deploy dx without anyone running `pnpm dx:deploy` on a laptop. The
fork carries no changes of its own. Its **Deploy** workflow
(`.github/workflows/deploy.yml`) fetches release tags from upstream, checks out
the tag you choose, and deploys it with the fork's settings.

## Set up once

1. Fork the repository on GitHub, then enable Actions in the fork.
2. Deploy once from a machine with `pnpm dx:deploy`, as described in
   [Install](/docs/get-started/install/). This creates `deploy.selfhost.json`,
   the Cloudflare-backed deployment state, and, with password sign-in,
   `.dx/alchemy/selfhost-<name>/credentials.json`.
3. In the fork, create an environment named `production` with these values:

| Name | Kind | Value |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | The deployment's Cloudflare account ID. |
| `CLOUDFLARE_API_TOKEN` | Secret | An API token with the permissions in [Deployment configuration](/docs/deployment/configuration/#cloudflare-authentication). |
| `DX_SELFHOST_CONFIG_JSON` | Variable | The full contents of `deploy.selfhost.json`. It holds no secrets. |
| `DX_SELFHOST_CREDENTIALS_JSON` | Secret | The full contents of `.dx/alchemy/selfhost-<name>/credentials.json`. Required once the deployment exists with password sign-in. |
| `E2B_API_KEY` | Secret | Your E2B key, when the deployment uses E2B Orbs. |
| `DX_UPSTREAM_REPOSITORY` | Variable | Optional. The repository to take tags from, as `owner/name`. Defaults to `dxcode-dev/dxcode`. |
| `DX_UPSTREAM_TOKEN` | Secret | Optional. A read-only token, needed only while the upstream repository or its releases are private. |

Add required reviewers to the environment if deployments should wait for
approval.

The deploy reads only these values. Integration secrets such as a GitHub App
stay in the encrypted deployment state from the first deploy, so a normal run
does not need them again.

## Deploy a release

Open **Actions → Deploy → Run workflow**. Leave the tag empty to deploy the
newest `vX.Y.Z`, or name one. The run deploys that tag, then checks `/healthz`
and `/readyz` on your domain.

Read the release notes before you deploy a new version. Upgrades only move
forward; see [Upgrade and recovery](/docs/operations/upgrade-recovery/).

## Keep the fork thin

Sync the fork's `main` from upstream when you want the newest workflow and
docs; GitHub's **Sync fork** button is enough. The workflow fetches tags
itself, so deploying a new release does not require a sync. Changes made in
the fork do not reach the deployment: it always deploys an upstream tag.
