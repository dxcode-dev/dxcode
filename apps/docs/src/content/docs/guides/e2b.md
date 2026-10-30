---
title: Run coding agents in E2B sandboxes
description: Connect your E2B team to dx so each coding-agent Thread runs in its own E2B sandbox, with templates dx builds for you and pauses that keep running processes.
---

dx can run a Thread's Orb, the Linux computer a coding agent works in,
as a sandbox in your own E2B team. You connect an E2B API key, dx builds its
Orb templates in your team, and new Threads start from them.

## Connect E2B

1. Create an API key in the E2B dashboard under **API Keys**.
2. In dx, open **Personal Settings → Orb Providers** and choose **Connect**
   next to E2B.
3. Paste the key into **E2B API key** and choose **Connect**.

dx checks the key by listing your team's templates. If E2B refuses it, the
dialog says "E2B rejected this API key." When the key works, the dialog
closes and dx starts building, unless your team already has dx's current
templates.

Workspace admins can connect a team for everyone in **_Workspace_ Settings
→ Orb Providers**.

## What dx builds in your team

dx builds its Orb templates in your E2B team, one at a time, which takes a
few minutes. The E2B row shows each step, such as "Building the Orb template
(a1.tiny) in your E2B team (1 of 4)". When the templates are ready, the row
shows **Your account** followed by your E2B team.

| Template | Used for |
| --- | --- |
| `dx-orb-<version>-base` | The base the size templates build on |
| `dx-orb-<version>-a1-tiny` | a1.tiny Orbs |
| `dx-orb-<version>-a1-small` | a1.small Orbs |
| `dx-orb-<version>-a1-medium` | a1.medium Orbs |

`<version>` changes when a dx release changes the Orb. dx then builds new
templates, and Threads that already started keep the ones they started
with. Saving a new key for the same team reuses the templates it already has
instead of rebuilding them.

If E2B refuses a larger size, dx skips that size and the connection is
ready with the rest; the row shows how many sizes it has, and **Manage**
offers **Check again** after a plan upgrade. If the base or the smallest
size fails to build, the connection fails and **Manage** offers **Retry**.

## Sizes

| Size | CPU | Memory | Disk |
| --- | --- | --- | --- |
| a1.tiny | 1 | 2 GB | 20 GB |
| a1.small | 2 | 4 GB | 20 GB |
| a1.medium | 4 | 8 GB | 20 GB |

Pick the size in the Orb picker when you start a Thread.

## Pauses

By default an Orb pauses after five minutes without activity. On E2B that
pause keeps the sandbox's memory, so a dev server, a test watcher, or a
long build is still running when the Thread resumes. Archiving a Thread
pauses its sandbox without keeping memory.

## Disconnect and clean up

Choose **Manage** on the E2B row, then **Disconnect**. Threads that ran on
the connection stop working from their next operation. dx does not delete
its templates from your team, including those from earlier versions; delete
the `dx-orb-` templates in the E2B dashboard when no Thread needs them.

## Running dx yourself

A self-hosted dx deployment can offer E2B on its own account: list `e2b` in
`orbProviders` and give the deploy an E2B API key. People can then start
Threads without connecting a team. See
[Deployment configuration](/docs/deployment/configuration/).

## Source

- Connection field, key check, and errors:
  [`e2b/connector.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/e2b/connector.ts)
- Template names, build order, reuse, and skipped sizes:
  [`team-templates.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/e2b/team-templates.ts)
- Sizes:
  [`e2b-orb-profiles.json`](https://github.com/dxcode-dev/dxcode/blob/main/packages/domain/e2b-orb-profiles.json)
- Pause behavior, and E2B on a deployment's own account:
  [`orb-providers/e2b.ts`](https://github.com/dxcode-dev/dxcode/blob/main/packages/domain/src/orb-providers/e2b.ts),
  [`e2b/provider.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/e2b/provider.ts)
- Settings page, Retry, and Disconnect:
  [`orb-providers-settings.tsx`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/settings/orb-providers/orb-providers-settings.tsx),
  [`orb-provider-routes.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/plugins/execution/orb-provider-routes.ts)
- Idle pause:
  [`activity.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/activity.ts)
