---
title: Run coding agents on Boat
description: Connect your Boat account to dx so each coding-agent Thread runs in its own Boat sandbox, started from an Orb snapshot dx saves in your account.
---

dx can run a Thread's Orb, the Linux computer a coding agent works in, as a
sandbox in your own Boat account. You connect a Boat API key, dx saves an
Orb snapshot in your account, and new Threads on a Boat size start from it.

## What you need

- A paid Boat plan. Boat's free trial cannot save snapshots, which dx needs.
- Zero data retention turned off on the Boat account. With it on, Boat
  erases an Orb's disk whenever it stops.
- A Boat API key.

## Connect Boat

1. Create an API key in the Boat dashboard under **API keys**, or run
   `boat api-key create dx --preset ci`.
2. In dx, open **Personal Settings → Orb Providers** and choose **Connect**
   next to Boat.
3. Paste the key into **Boat API key** and choose **Connect**.

dx checks the account before it saves anything. It can report:

| Message | Fix |
| --- | --- |
| Boat rejected this API key. | Create a new key and connect again. |
| Boat's free trial cannot save snapshots, which dx needs for its Orb. End the trial in Boat's dashboard (Billing, Upgrade now), then save the connection again. | Move to a paid plan, then choose **Connect** again. |
| This Boat account has zero data retention, which erases an Orb's disk whenever it stops. Turn it off in Boat's dashboard (Account, Data & privacy) to connect. | Turn off zero data retention, then connect again. |
| Boat refused this API key: _Boat's message_ | Create a key with the scopes dx needs, such as `account.read`, or resolve the account's suspension in Boat. |

Workspace admins can connect a Boat account for everyone in **_Workspace_
Settings → Orb Providers**.

## What dx builds in your account

When the key works, the dialog closes and the Boat row shows each step:
"Building the Orb in your Boat account", then "Starting a test Orb". It takes
about ten minutes.

1. dx starts one build sandbox, `dx-orb-build-<version>`, with none of your
   account's secrets, and runs the Orb setup in it.
2. It saves the sandbox's disk as the snapshot `dx-orb-<version>` and
   deletes the build sandbox.
3. It starts a test Orb, `dx-orb-probe`, from the snapshot, checks that the
   Orb's supervisor is running, and deletes it.

Every Boat size starts from that one snapshot. `<version>` changes when a
dx release changes the Orb setup or the sizes, and dx then saves a new
snapshot. After a test Orb passes, dx tries to delete `dx-orb-` snapshots
from other versions that are at least a day old. Saving a new key for the same
account reuses the snapshot that is already there.

If the Orb setup fails or runs longer than 45 minutes, the row shows
**Setup failed**, or **Update failed** when a new version fails while the
current one keeps serving new Threads, and **Manage** offers **Retry**.

## Sizes

| Size | CPU | Memory | Disk |
| --- | --- | --- | --- |
| small | 2 | 4 GB | 12 GB |
| medium | 4 | 8 GB | 50 GB |
| large | 8 | 16 GB | 125 GB |
| xlarge | 16 | 32 GB | 251 GB |

dx records which sizes your Boat plan does not include, leaves them out of the Orb picker, and checks again after
a day. To check sooner, choose **Check again**.

## Pauses

Boat has no pause. By default an Orb stops after five minutes without
activity, through Boat's own auto-stop. A stop keeps the disk and ends every
process. When the Thread needs the Orb again, it starts on a new machine
with your files, and dx's own Orb services start again. Restart a watcher
yourself, and declare a dev server in `.dx/services.yaml` so a Portal
request starts it again; see
[Terminal, Desktop, and Portal](/docs/get-started/workspace-tools/).

Boat deletes a stopped sandbox's disk after 14 days. A Thread whose Orb
stayed stopped that long cannot start it again, and its files are gone.

Archiving a Thread stops its sandbox. Deleting a Thread deletes its sandbox
while the connection is saved and its key works.

## Disconnect and clean up

Choose **Manage** on the Boat row, then **Disconnect**. Threads that ran on
the connection stop working from their next operation. dx does not delete
what it saved, so delete Threads you no longer need before you disconnect.
Then remove from your Boat account the `dx-orb-` snapshots, the Threads'
sandboxes (named `dx` and the Thread's ID), and any `dx-orb-build-` or
`dx-orb-probe` sandbox left after a failed delete or a disconnect during
setup.

Boat runs only on accounts people and workspaces connect. A self-hosted dx
deployment cannot offer it on its own account.

## Source

- Connection field, account checks, messages, and preparation:
  [`boat/connector.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/boat/connector.ts)
- Sizes and pause behavior:
  [`orb-providers/boat.ts`](https://github.com/dxcode-dev/dxcode/blob/main/packages/domain/src/orb-providers/boat.ts)
- Stops, the 14-day disk limit, archiving, and deletion:
  [`boat/provider.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/boat/provider.ts)
- Settings page, Retry, Check again, and Disconnect:
  [`orb-providers-settings.tsx`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/settings/orb-providers/orb-providers-settings.tsx),
  [`orb-provider-routes.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/plugins/execution/orb-provider-routes.ts)
- Idle pause:
  [`activity.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/activity.ts)
