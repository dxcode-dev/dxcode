---
title: Boat is an Orb provider
date: 2026-10-31
summary: Connect your Boat account and run your Threads' Orbs as Boat sandboxes, in four sizes.
kind: news
featured: true
cover: ../../assets/log/navy-platform.webp
link: /docs/use/connect-an-orb-provider/
---

You can now run Orbs on [Boat](https://boat.dev) in your own account.

## Connect Boat

1. Open **Personal Settings → Orb Providers**.
2. Choose **Connect** next to Boat.
3. Paste a **Boat API key**. Create one in the Boat dashboard under API keys, or run `boat api-key create dx --preset ci`.

dx first saves its Orb snapshot in your Boat account, which takes about ten minutes. After that, your Threads can start their Orbs on Boat.

## What you need

- **A paid Boat plan.** Boat's free trial cannot save snapshots, so dx refuses a trial account and tells you how to upgrade.
- **Zero data retention turned off.** An account with zero data retention erases an Orb's disk whenever it stops, so dx refuses it too.

## Sizes

| Size | CPU | Memory | Disk |
| --- | --- | --- | --- |
| bt.small | 2 | 4 GiB | 12 GB |
| bt.medium | 4 | 8 GiB | 50 GB |
| bt.large | 8 | 16 GiB | 125 GB |
| bt.xlarge | 16 | 32 GiB | 251 GB |

If your Boat plan does not include a size, the Boat dialog says so. dx checks again daily, so new sizes appear after you upgrade.

For a walkthrough, see the [Boat guide](/docs/guides/boat/).
