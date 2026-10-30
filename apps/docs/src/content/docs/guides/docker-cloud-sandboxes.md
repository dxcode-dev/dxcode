---
title: Run coding agents in Docker Cloud Sandboxes
description: Connect your Docker account to dx so each coding-agent Thread runs in its own Docker Cloud Sandbox, a microVM that boots the dx Orb image after dx tests it in your account.
---

dx can run every Thread's Orb, the Linux computer a coding agent works in,
as a Docker Cloud Sandbox in your own Docker account. Each sandbox is a
microVM with its own kernel. You connect a Docker ID and a personal access
token, dx tests a sandbox in your account, and new Threads start there.

dx boots its public Orb image from Docker Hub, `dxcodedev/dx-orb`, pinned
by digest. Nothing is built in your account.

## What you need

- A Docker account with the Docker Agentic Platform plan.
- A personal access token for that account with **Allow Cloud Sandboxes
  access**. The dialog's help says where to create it: "Create one in Docker
  Home under Account settings → Personal access tokens, with Allow Cloud
  Sandboxes access."

## Connect Docker

1. In dx, open **Personal Settings → Orb Providers** and choose **Connect**
   next to Docker Cloud Sandboxes.
2. Enter your **Docker ID**, the username you sign in to Docker with.
3. Paste the token into **Personal access token** and choose **Connect**.

dx exchanges the Docker ID and token at Docker Hub for an access
token, then lists your sandboxes to check that the account can use Cloud
Sandboxes. It can report:

| Message | Fix |
| --- | --- |
| Docker rejected this Docker ID and access token. | Check the Docker ID, or create a new token. |
| This account cannot use Cloud Sandboxes. Create the token with Allow Cloud Sandboxes access, and activate the Docker Agentic Platform plan. | Create a token with that access, and activate the plan on the account. |

When both checks pass, the dialog closes and dx starts the test Orb.

Workspace admins can connect a Docker account for everyone in **_Workspace_
Settings → Orb Providers**.

## The test Orb

Before any Thread runs, dx starts a test Orb in your Docker account at the
smallest size and checks everything a Thread's Orb needs from Docker. The
Docker row shows each step, such as "Pausing the test Orb (3 of 5)":

1. Starting a test Orb in your Docker account. The first boot pulls the Orb
   image, so dx waits up to ten minutes.
2. Checking the test Orb. dx checks that the Orb supervisor runs as `user`,
   that Docker lets it move the sandbox's deadline, and that Docker stops the
   sandbox when asked.
3. Pausing the test Orb.
4. Resuming the test Orb, and checking that the Orb supervisor came back.

dx then deletes the test Orb. When it is ready, the row shows **Your
account** followed by your Docker account's ID, and every size appears in
the Orb picker. Threads boot the exact image the test booted.

The test Orb's name starts with `dx-orb-probe-`. dx creates it with a
30-minute deadline that tells Docker to delete it.

### When the test fails

The row shows **Setup failed**. **Manage** shows the reason and offers
**Retry**. After most failures dx tries to delete the test Orb. If a
sandbox whose name starts with `dx-orb-probe-` remains in your Docker
account, delete it. A
test can fail with messages such as:

| Message | What happened |
| --- | --- |
| Docker refused the Orb image: _Docker's message_ | Docker called the create request invalid. |
| Docker could not start the Orb image: _Docker's message_ | The sandbox failed while it booted. |
| The test Orb did not start in ten minutes. | The sandbox was still not running after ten minutes. |
| The test Orb started, but its Orb supervisor is not running as user. | The image booted, but the Orb supervisor was not running. |
| Docker would not move the test Orb's deadline, which dx needs to pause idle Orbs. | Docker does not offer the account the call that moves a sandbox's deadline. |
| Docker would not pause the test Orb, which dx needs to stop idle Orbs. | Docker does not offer the account the call that stops a sandbox. |
| The test Orb failed while pausing: _Docker's message_ | The sandbox failed while it stopped. |
| The test Orb did not pause in three minutes. | The sandbox was still not stopped after three minutes. |
| The test Orb did not resume in three minutes. | The sandbox was still not running three minutes after dx started it. |
| The test Orb resumed, but its Orb supervisor did not come back. | The sandbox started again, but the Orb supervisor was not running. |
| The test Orb did not resume: _Docker's message_ | The sandbox failed while it resumed. |
| The test Orb did not resume | The sandbox stopped, or failed without a reason, before it was running. |
| The provider stopped responding while dx prepared this account. Retry to continue. | Twenty steps in a row failed with an unexpected error. |

If Docker stops accepting the token during the test, the row fails with one
of the two connection messages above.

### When dx changes the Orb

A dx release that changes the Orb image or the sizes runs the test again.
Saving a new token for the same Docker account in **Manage** also runs it.
Meanwhile the row shows **Updating…**, and new Threads keep the image from
the last passing test until the new one is ready. If the new test fails, the
row shows **Update failed**, and new Threads keep the current image. Threads
that already started keep their own sandbox.

## Sizes

| Size | CPU | Memory | Disk |
| --- | --- | --- | --- |
| small | 2 | 4 GB | About 20 GB |
| medium | 4 | 8 GB | About 20 GB |
| large | 8 | 16 GB | About 20 GB |
| xl | 16 | 32 GB | About 20 GB |

Pick the size in the Orb picker when you start a Thread. dx sends Docker
the CPU and memory; Docker does not publish a disk size. The 20 GB is what a
small Orb's sandbox had when dx measured it on 2026-10-27, and dx assumes
the larger sizes match. Docker's `micro` size, 1 CPU and 2 GB, is too small
for the Orb, so dx does not offer it.

## Pauses

By default an Orb pauses after five minutes without activity. dx creates
each Thread's sandbox with a deadline of that length and tells Docker to
stop the sandbox when the deadline passes. While the Orb is in use, dx moves
the deadline forward. When the Thread needs its Orb again, dx starts the
sandbox, and Docker restarts the deadline.

Docker records for each sandbox whether a stop kept its memory. dx counts
only on the files: when memory is not kept, processes start again from the
image's entrypoint. Restart a watcher after a pause, and declare a dev
server in `.dx/services.yaml` so a Portal request starts it again; see
[Terminal, Desktop, and Portal](/docs/get-started/workspace-tools/).

## Archive, delete, and disconnect

Archiving a Thread stops its sandbox, the same as a pause. Deleting a Thread
deletes its sandbox from your Docker account.

To disconnect, choose **Manage** on the Docker row, then **Disconnect**.
Threads that ran on the connection stop working from their next operation.
dx does not delete their sandboxes, and deleting a Thread after you
disconnect no longer reaches Docker. A running sandbox stops at its
deadline and stays in your account. Each Thread's sandbox is named `dx-`
followed by the Thread's ID; delete them in your Docker account when no
Thread needs them.

## Running dx yourself

dx runs Docker sandboxes only on accounts that people or workspaces
connect. A self-hosted deployment cannot offer Docker on its own account,
so everyone who wants it connects their own.

## Source

- Fields, checks, messages, and the test Orb:
  [`docker/connector.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/docker/connector.ts)
- Token exchange, account ID, and sandbox calls:
  [`docker/api.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/docker/api.ts)
- Thread sandboxes, pause, archive, delete, and the account rule:
  [`docker/provider.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/docker/provider.ts)
- Sizes and pause behavior:
  [`orb-providers/docker.ts`](https://github.com/dxcode-dev/dxcode/blob/main/packages/domain/src/orb-providers/docker.ts)
- The Orb image:
  [`public-image.json`](https://github.com/dxcode-dev/dxcode/blob/main/deploy/orb/public-image.json)
- Settings page, Retry, and Disconnect:
  [`orb-providers-settings.tsx`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/settings/orb-providers/orb-providers-settings.tsx),
  [`orb-providers-status.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/settings/orb-providers/orb-providers-status.ts),
  [`orb-provider-routes.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/plugins/execution/orb-provider-routes.ts)
- Preparing again and the version new Threads keep:
  [`preparation.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/plugins/execution/preparation.ts)
- Releases skipped after a disconnect:
  [`plugins/execution/provider.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/plugins/execution/provider.ts)
- Thread deletion:
  [`thread-deletion/routes.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/thread-deletion/routes.ts)
- Idle pause:
  [`activity.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/activity.ts)
