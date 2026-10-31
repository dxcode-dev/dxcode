---
title: Connecting an Orb provider
description: Run your Threads' Orbs in your own E2B, Cloudflare, Freestyle, Docker, or Boat account.
sidebar:
  order: 3
---

Every Thread runs in an Orb, a Linux sandbox with the project's repository,
a terminal, and a desktop. Orbs run on an Orb provider. Connect your own
provider account and your Threads' Orbs run there, on your plan and bill.

## Supported providers

| Provider | What you enter | Setup time | Sizes | A pause keeps |
| --- | --- | --- | --- | --- |
| E2B | An E2B API key | A few minutes | 1 to 4 CPU, 2 to 8 GB | Running processes |
| Cloudflare Containers | A Cloudflare account ID and API token, on the Workers Paid plan | A few minutes | 0.5 to 4 CPU, 4 to 12 GB | Files; processes restart |
| Freestyle | A Freestyle API key | About ten minutes | 2 to 8 CPU, 4 to 16 GB | Running processes |
| Docker Cloud Sandboxes | A Docker ID and personal access token, on the Docker Agentic Platform plan | A few minutes | 2 to 16 CPU, 4 to 32 GB | Files; processes restart |
| Boat | A Boat API key, on a paid Boat plan without zero data retention | About ten minutes | 2 to 16 CPU, 4 to 32 GB | Files; processes restart |

The dialog for each provider says what the key or token needs and where to
create it.

## Connect a provider

1. Open **Personal Settings → Orb Providers**.
2. Choose **Connect** next to the provider.
3. Fill in every field and choose **Connect**. dx checks the credentials
   with the provider first and says so if the provider refuses them.
4. dx prepares your account. Depending on the provider it builds Orb
   templates or snapshots there, copies the Orb image, or starts and stops a
   test Orb. The dialog closes, and the provider's row shows what dx is
   doing. **Manage** shows the current step in the dialog.

When preparation finishes, the row shows the account, and the provider's
sizes appear in the Orb picker when you start a Thread. If a step fails, the
row shows **Setup failed**, or **Update failed** when an update to a ready
connection fails, and **Manage** offers **Retry**.

A larger size your plan does not allow is left out, with the provider's
reason. A day after preparation, opening the page prepares the account
again, so the size appears after you upgrade the plan. To check sooner,
choose **Check again**.

### What dx creates in your account

Preparation leaves resources in your provider account, depending on the
provider: E2B templates; a copy of the Orb image, a Worker, and a container
application on Cloudflare; Freestyle and Boat snapshots. New dx releases prepare the
account again when the Orb changes. On E2B, Threads that already started
keep the templates they started with. On Cloudflare, dx updates the same
Orb Worker.

## Personal and workspace connections

- **Personal.** Any signed-in person can connect a provider in **Personal
  Settings → Orb Providers**. The row shows **Your account**.
- **Workspace.** Workspace admins connect providers in **_Workspace_
  Settings → Orb Providers** for everyone's Threads. Members see **Workspace
  account**.
- **Deployment.** A row that reads **Provided by this deployment** runs on
  the deployment's own account and needs no connection.

For each provider, dx uses your personal connection first, then the
workspace's, then the deployment's. On your private projects your personal
connection always applies. On workspace projects it applies only when an
admin turns on **Members' Own Accounts** in **_Workspace_ Settings → Orb
Providers**. Until then,
your personal row notes **Personal projects only**.

## Choose an Orb for a Thread

When you start a Thread, the Orb picker lists each provider with its sizes,
shown as CPU and memory, and a tooltip saying what a pause keeps. A provider that
is still preparing or failed shows that instead, and its sizes cannot be
picked. Sizes your account cannot run are hidden. In a project, the
project's Orb size setting picks the starting size; without a project, your
own default does.

A Thread keeps the provider, account, and size it started with. If the Orb
cannot start because preparation is still running, failed, or the size is
unavailable, dx says so before it creates the Thread.

## Pauses

By default an Orb pauses after five minutes without activity and resumes
when the Thread needs it. On E2B and Freestyle a pause keeps memory, so
running processes continue where they were. On Cloudflare Containers,
Docker Cloud Sandboxes, and Boat the files stay and processes start again.
Boat deletes the disk of an Orb that has stayed stopped for 14 days.

## Update or disconnect

Choose **Manage** on a connected provider.

- Enter new credentials and choose **Save** to replace them. For the same
  provider account, new Threads keep using the current version until the
  new one is ready, so rotating a token stops nothing.
- Choose **Disconnect** to remove the connection. Threads that run on it
  stop working from their next operation. dx does not delete what it created
  in your provider account; remove those resources in the provider's console.

## Source

- Providers, sizes, and pause behavior:
  [`orb-providers/`](https://github.com/dxcode-dev/dxcode/tree/main/packages/domain/src/orb-providers),
  [`e2b-orb-profiles.json`](https://github.com/dxcode-dev/dxcode/blob/main/packages/domain/e2b-orb-profiles.json),
  [`cloudflare-orb-profiles.json`](https://github.com/dxcode-dev/dxcode/blob/main/packages/domain/cloudflare-orb-profiles.json)
- Pause on each provider:
  [`e2b/provider.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/e2b/provider.ts),
  [`cloudflare/provider.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/cloudflare/provider.ts),
  [`freestyle/provider.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/freestyle/provider.ts),
  [`docker/provider.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/docker/provider.ts),
  [`boat/provider.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/boat/provider.ts)
- Connection fields and preparation per provider:
  [`e2b/connector.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/e2b/connector.ts),
  [`cloudflare/connector.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/cloudflare/connector.ts),
  [`freestyle/connector.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/freestyle/connector.ts),
  [`docker/connector.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/docker/connector.ts),
  [`boat/connector.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/boat/connector.ts)
- Settings page:
  [`orb-providers-settings.tsx`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/settings/orb-providers/orb-providers-settings.tsx),
  [`orb-providers-status.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/settings/orb-providers/orb-providers-status.ts)
- Connect, preparation, and disconnect:
  [`orb-provider-routes.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/plugins/execution/orb-provider-routes.ts),
  [`preparation.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/plugins/execution/preparation.ts),
  [`connector.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/plugins/execution/connector.ts)
- Precedence and pinning:
  [`plugins/execution/orb-providers.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/plugins/execution/orb-providers.ts)
- Orb picker and starting size:
  [`new-thread-configuration-strip.tsx`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/threads/new-thread-configuration-strip.tsx),
  [`composer-start.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/shared/composer-start.ts)
- Idle pause:
  [`activity.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/activity.ts)
