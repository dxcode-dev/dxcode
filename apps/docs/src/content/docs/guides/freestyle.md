---
title: Run coding agents in Freestyle VMs
description: Connect your Freestyle account to dx so each coding-agent Thread runs in its own Freestyle VM, booted from Orb snapshots dx builds for you, with pauses that keep running processes.
---

dx can run a Thread's Orb, the Linux computer a coding agent works in, as a
VM in your own Freestyle account. You connect a Freestyle API key, dx builds
one Orb snapshot per size in your account, and each new Thread gets its own
VM booted from the snapshot for its size.

## Connect Freestyle

1. Create an API key in the Freestyle dashboard (dash.freestyle.sh) under
   **API Keys**.
2. In dx, open **Personal Settings → Orb Providers** and choose **Connect**
   next to Freestyle.
3. Paste the key into **Freestyle API key** and choose **Connect**.

dx checks the key by asking Freestyle which account it belongs to, and
creates a Freestyle identity if the account has none. If
Freestyle refuses it, the dialog says "Freestyle rejected this API key."
When the key works, the dialog closes and dx starts building in your
account. The dialog notes that this "takes about ten minutes".

Workspace admins can connect an account for everyone in **_Workspace_
Settings → Orb Providers**.

## What dx builds in your account

A Freestyle VM keeps the hardware of the snapshot it boots from, so dx
builds one Orb snapshot per size. The sizes build side by side. For each
size, dx:

1. Starts a VM named `dx-orb-build-<version>-<size>` from Freestyle's Ubuntu
   base snapshot for that size.
2. Runs the Orb setup script in it.
3. Snapshots the VM's memory and disk as `dx-orb-<version>-<size>`.
4. Deletes the build VM.

The Freestyle row shows the step, such as "Building the Orb (fs.small,
fs.medium, fs.large) in your Freestyle account (0 of 4)". When every size
is done, dx starts a test VM named `dx-orb-probe` from the smallest
snapshot, runs a command in it as the Orb's user, checks that the Orb's
supervisor is running, and deletes it. The row then shows **Your account**
followed by your Freestyle account.

`<version>` changes when a dx release changes the Orb setup or the sizes.
dx then builds new snapshots, and new Threads keep using the current
version until they are ready. After a preparation passes its test VM, dx
deletes `dx-orb-`
snapshots from other versions that are at least a day old. Saving a new key
for the same account reuses the snapshots it already has instead of
rebuilding them.

If a build fails, the row shows **Setup failed** (or **Update failed** when
an earlier version is still serving new Threads), and **Manage** shows the
error and offers **Retry**. dx tries to delete the build VMs it started, except
after the last two errors below. After those, delete any `dx-orb-build-` or
`dx-orb-probe` VMs left in your Freestyle account. A build can end with
errors such as:

- "The Orb setup failed in the `<size>` VM", followed by the setup log
- "The test Orb did not start."
- "The test Orb could not run a command."
- "Freestyle kept failing while building `<size>`", followed by Freestyle's
  error
- "Freestyle built no Orb size for this account."
- "Freestyle rejected this API key.", when the key stops working mid-build
- "The provider stopped responding while dx prepared this account. Retry to
  continue."

## Sizes and plan limits

| Size | ID | Freestyle base snapshot | CPU | Memory | Disk |
| --- | --- | --- | --- | --- | --- |
| small | `fs.small` | `freestyle/ubuntu-sm` | 2 | 4 GB | 16 GB |
| medium | `fs.medium` | `freestyle/ubuntu` | 4 | 8 GB | 32 GB |
| large | `fs.large` | `freestyle/ubuntu-lg` | 8 | 16 GB | 64 GB |

Pick the size in the Orb picker when you start a Thread.

As of 2026-10-23, Freestyle's Free plan allows up to 4 vCPUs, 8 GiB of
memory, and 32 GB of disk per VM, so large needs the Hobby or Pro plan.
dx builds only the sizes your plan allows. When Freestyle refuses a larger
size, dx skips it and the connection is ready with the rest. The row shows
how many sizes you have, such as "2 of 3 sizes", and the Orb picker leaves
the refused size out. **Manage** gives Freestyle's reason and says "dx
checks again daily, so new sizes appear after a plan upgrade." To check
right away, choose **Check again**. A refused small size fails the
connection instead.

## Pauses

By default an Orb pauses after five minutes without activity. A Freestyle
pause keeps the VM's memory, so a dev server, a test watcher, or a long
build is still running when the Thread resumes. Archiving a Thread pauses
its VM the same way. Deleting a Thread deletes its VM.

## Disconnect and clean up

Choose **Manage** on the Freestyle row, then **Disconnect**. Threads that
ran on the connection stop working from their next operation. dx does not
delete what it made in your account: the `dx-orb-` snapshots and each
Thread's VM, named `dx ` followed by the Thread's ID. Delete them in your
Freestyle account when no Thread needs them. dx deletes a Thread's VM when
you delete the Thread, which needs the connection, so delete Threads you no
longer need before you disconnect.

## Running dx yourself

Freestyle runs only on an account a person or a workspace connects. A
self-hosted dx deployment cannot offer Freestyle on its own account.

## Source

- Connection field, key check, messages, snapshot builds, test VM, skipped
  sizes, and deleting older snapshots:
  [`freestyle/connector.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/freestyle/connector.ts)
- Sizes, base snapshots, plan limits, and what a pause keeps:
  [`orb-providers/freestyle.ts`](https://github.com/dxcode-dev/dxcode/blob/main/packages/domain/src/orb-providers/freestyle.ts)
- Snapshot version:
  [`vm-orb-recipe.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/guest/vm-orb-recipe.ts)
- Thread VMs, pause, archive, delete, and own-account only:
  [`freestyle/provider.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/freestyle/provider.ts),
  [`freestyle/api.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/freestyle/api.ts),
  [`thread-deletion/routes.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/thread-deletion/routes.ts)
- Settings page, row status, Retry, Check again, and Disconnect:
  [`orb-providers-settings.tsx`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/settings/orb-providers/orb-providers-settings.tsx),
  [`orb-providers-status.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/settings/orb-providers/orb-providers-status.ts),
  [`orb-provider-routes.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/plugins/execution/orb-provider-routes.ts)
- Orb picker:
  [`new-thread-configuration-strip.tsx`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/threads/new-thread-configuration-strip.tsx)
- Idle pause:
  [`activity.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/activity.ts)
