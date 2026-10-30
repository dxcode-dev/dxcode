---
title: Run AI coding agents on Cloudflare Containers
description: Connect your Cloudflare account to dx so each coding-agent Thread runs in its own Cloudflare container, with the Orb image and an Orb Worker dx sets up for you.
---

dx can run a Thread's Orb, the Linux computer a coding agent works in,
as a Cloudflare container in your own account. You connect an account ID
and an API token, dx sets up a small Orb Worker there, and each Thread gets
its own container.

## What you need

- A Cloudflare account on the Workers Paid plan, which Containers needs.
- A workers.dev subdomain for the account. Choose one under **Workers &
  Pages → Overview** if you have not.
- An API token for the account with **Workers Scripts Edit**,
  **Containers Edit**, and **Account Settings Read**.

## Connect Cloudflare

1. In dx, open **Personal Settings → Orb Providers** and choose **Connect**
   next to Cloudflare Containers.
2. Enter your **Cloudflare account ID**, the 32 hexadecimal characters shown
   on your account's Workers & Pages overview.
3. Enter the **API token** and choose **Connect**.

dx checks the token against the account first. Besides "Enter your
32-character Cloudflare account ID and an API token." for a missing or
malformed field,
these are the problems it reports:

| Message | Fix |
| --- | --- |
| Cloudflare refused this token for the account. It needs Workers Scripts Edit, Containers Edit, and Account Settings Read, on an account with the Workers Paid plan. | Create a token with those permissions for this account. |
| This account cannot run Cloudflare Containers. Containers needs the Workers Paid plan. | Move the account to the Workers Paid plan. |
| Choose a workers.dev subdomain for this account first (Workers & Pages → Overview). | Choose one there, then connect again. |

Workspace admins can connect an account for everyone in **_Workspace_
Settings → Orb Providers**.

## What dx sets up in your account

Setup takes a few minutes. The Cloudflare row shows each step:

1. Copying the Orb image into your Cloudflare account, layer by layer.
2. Cloudflare preparing the Orb image.
3. Deploying the Orb Worker, named `dx-orb-` followed by a random suffix.
4. Creating the Orb container application.
5. Publishing the Orb Worker on your workers.dev subdomain.
6. Waiting for the Orb Worker to answer.
7. Starting a test Orb, running a command in it, and removing it.

Threads then reach their containers through the Orb Worker. A new dx release
that changes the Orb sets the account up again, updating the same Worker.

## Sizes

| Size | CPU | Memory | Disk |
| --- | --- | --- | --- |
| standard-1 | 0.5 | 4 GB | 8 GB |
| standard-2 | 1 | 6 GB | 12 GB |
| standard-3 | 2 | 8 GB | 16 GB |
| standard-4 | 4 | 12 GB | 20 GB |

These are Cloudflare's standard instance types. dx does not offer `lite`,
which cannot hold the Orb image, or `basic`, which the container runtime
does not accept by name.

## Pauses

By default an Orb pauses after five minutes without activity. On Cloudflare
a pause snapshots the container's files and stops it. When the Thread
resumes, the files are back, and processes start again from the image's
entrypoint. Restart a watcher after a pause, and declare a dev server in
`.dx/services.yaml` so a Portal request starts it again; see
[Terminal, Desktop, and Portal](/docs/get-started/workspace-tools/).
Archiving a Thread pauses it the same way.

## Disconnect and clean up

Choose **Manage** on the Cloudflare row, then **Disconnect**. Threads that
ran on the connection stop working from their next operation. dx does not
remove what it set up. Delete the `dx-orb-` Worker, its container
application, and the `dx-orb` image from your Cloudflare account when no
Thread needs them.

## Running dx yourself

A self-hosted dx deployment can run Orbs as Cloudflare Containers in its own
account: add `cloudflare` to `orbProviders` in `deploy.selfhost.json` and
rerun `pnpm dx:deploy`. The deploying machine needs Docker with Buildx to
build the Orb image. People can then start Threads without connecting an
account. See
[Deployment configuration](/docs/deployment/configuration/).

## Source

- Fields, checks, messages, and setup steps:
  [`cloudflare/connector.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/cloudflare/connector.ts)
- Sizes:
  [`cloudflare-orb-profiles.json`](https://github.com/dxcode-dev/dxcode/blob/main/packages/domain/cloudflare-orb-profiles.json),
  [`orb-providers/cloudflare.ts`](https://github.com/dxcode-dev/dxcode/blob/main/packages/domain/src/orb-providers/cloudflare.ts)
- Pause, archive, and resume:
  [`cloudflare/provider.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/cloudflare/provider.ts)
- Settings page and Disconnect:
  [`orb-providers-settings.tsx`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/settings/orb-providers/orb-providers-settings.tsx),
  [`orb-provider-routes.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/plugins/execution/orb-provider-routes.ts)
- Setting the account up again:
  [`connector.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/plugins/execution/connector.ts)
- Idle pause:
  [`activity.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/activity.ts)
