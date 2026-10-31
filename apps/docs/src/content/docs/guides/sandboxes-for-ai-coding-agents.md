---
title: Sandboxes for AI coding agents compared
description: E2B, Cloudflare Containers, Freestyle, Docker Cloud Sandboxes, and Boat as homes for AI coding agents in dx, with sizes, pause behavior, and setup for each.
---

A coding agent needs a computer it can change freely: a shell, the
repository, and room to install, build, and run tests. In dx that computer
is an Orb, and it runs on a sandbox provider you connect or your dx
deployment offers. dx supports five. This page compares them on what dx
does with each, so you can pick one.

## At a glance

| | E2B | Cloudflare Containers | Freestyle | Docker Cloud Sandboxes | Boat |
| --- | --- | --- | --- | --- | --- |
| Runs each Orb as | An E2B sandbox | A container owned by a Durable Object | A Freestyle VM | A microVM with its own kernel | A Boat sandbox |
| What you enter | API key | Account ID and API token | API key | Docker ID and personal access token | API key |
| Plan needed | Not checked; dx skips sizes your team's tier refuses | Workers Paid | Free for up to 4 CPU and 8 GB; Hobby or Pro for 8 CPU | Docker Agentic Platform | A paid plan, with zero data retention off; the free trial cannot save the Orb snapshot |
| dx setup | Builds Orb templates in your team, a few minutes | Copies the Orb image and deploys an Orb Worker, a few minutes | Builds Orb snapshots, about ten minutes | Starts and checks a test Orb, a few minutes | Builds and saves an Orb snapshot, then starts a test Orb, about ten minutes |
| CPU | 1 to 4 | 0.5 to 4 | 2 to 8 | 2 to 16 | 2 to 16 |
| Memory | 2 to 8 GB | 4 to 12 GB | 4 to 16 GB | 4 to 32 GB | 4 to 32 GB |
| Disk | 20 GB | 8 to 20 GB | 16 to 64 GB | About 20 GB | 12 to 251 GB |
| A pause keeps | Memory: processes keep running | Files; processes restart | Memory: processes keep running | Files; processes may restart | Files; processes restart |
| A dx deployment can offer it on its own account | Yes | Yes | No | No | No |

## Sizes

| Provider | Size | CPU | Memory | Disk |
| --- | --- | --- | --- | --- |
| E2B | a1.tiny | 1 | 2 GB | 20 GB |
| E2B | a1.small | 2 | 4 GB | 20 GB |
| E2B | a1.medium | 4 | 8 GB | 20 GB |
| Cloudflare | standard-1 | 0.5 | 4 GB | 8 GB |
| Cloudflare | standard-2 | 1 | 6 GB | 12 GB |
| Cloudflare | standard-3 | 2 | 8 GB | 16 GB |
| Cloudflare | standard-4 | 4 | 12 GB | 20 GB |
| Freestyle | small | 2 | 4 GB | 16 GB |
| Freestyle | medium | 4 | 8 GB | 32 GB |
| Freestyle | large | 8 | 16 GB | 64 GB |
| Docker | small | 2 | 4 GB | About 20 GB |
| Docker | medium | 4 | 8 GB | About 20 GB |
| Docker | large | 8 | 16 GB | About 20 GB |
| Docker | xl | 16 | 32 GB | About 20 GB |
| Boat | small | 2 | 4 GB | 12 GB |
| Boat | medium | 4 | 8 GB | 50 GB |
| Boat | large | 8 | 16 GB | 125 GB |
| Boat | xlarge | 16 | 32 GB | 251 GB |

On E2B, Freestyle, and Boat, dx leaves out sizes your plan refuses and checks again
after a day, so larger sizes appear after you upgrade.

## How to choose

- **Long-running processes across pauses.** An idle Orb pauses after five
  minutes by default. On E2B and Freestyle a pause keeps memory, so a dev
  server, a watcher, or a debugger session is still running when the agent
  comes back. On Cloudflare and Boat the files stay and processes start
  again. On Docker the files stay, and processes may start again. Boat
  deletes the disk of an Orb that has stayed stopped for 14 days.
- **Large builds.** Docker and Boat go up to 16 CPU and 32 GB of memory.
  Boat has the most disk, up to 251 GB.
- **Already on Cloudflare.** If your account has Workers Paid, Cloudflare
  Containers runs Orbs in your own account, next to your other Workers.
- **Quick start.** E2B, Cloudflare, and Docker are ready a few minutes
  after you connect. Freestyle and Boat take about ten.
- **Running dx yourself.** A self-hosted dx deployment can offer E2B or
  Cloudflare Containers on its own account, so people need no connection of
  their own. Freestyle, Docker, and Boat run only on accounts people connect.

Whatever you pick, each Thread gets its own Orb with the repository and a
terminal, and keeps the provider and size it started with.
You can connect several providers and choose one per Thread.

## Connect one

Open **Personal Settings → Orb Providers** in dx and choose **Connect**
next to the provider. See
[Connecting an Orb provider](/docs/use/connect-an-orb-provider/).

## Source

- Boat sizes, pause, and connection:
  [`orb-providers/boat.ts`](https://github.com/dxcode-dev/dxcode/blob/main/packages/domain/src/orb-providers/boat.ts),
  [`boat/connector.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/boat/connector.ts),
  [`boat/provider.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/boat/provider.ts)
- Providers, isolation, and pause behavior:
  [`orb-providers/`](https://github.com/dxcode-dev/dxcode/tree/main/packages/domain/src/orb-providers)
- Sizes, including Docker's disk size (observed for small, assumed for larger):
  [`e2b-orb-profiles.json`](https://github.com/dxcode-dev/dxcode/blob/main/packages/domain/e2b-orb-profiles.json),
  [`cloudflare-orb-profiles.json`](https://github.com/dxcode-dev/dxcode/blob/main/packages/domain/cloudflare-orb-profiles.json),
  [`freestyle.ts`](https://github.com/dxcode-dev/dxcode/blob/main/packages/domain/src/orb-providers/freestyle.ts),
  [`docker.ts`](https://github.com/dxcode-dev/dxcode/blob/main/packages/domain/src/orb-providers/docker.ts)
- What you enter, plans, and setup per provider:
  [`e2b/connector.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/e2b/connector.ts),
  [`cloudflare/connector.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/cloudflare/connector.ts),
  [`freestyle/connector.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/freestyle/connector.ts),
  [`docker/connector.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/docker/connector.ts)
- Daily recheck of refused sizes:
  [`preparation.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/plugins/execution/preparation.ts)
- Providers a deployment can offer:
  [`descriptor.ts`](https://github.com/dxcode-dev/dxcode/blob/main/packages/domain/src/orb-providers/descriptor.ts)
- Idle pause:
  [`activity.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/activity.ts)
