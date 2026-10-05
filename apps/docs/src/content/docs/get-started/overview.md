---
title: Before you deploy
description: Accounts, tools, and costs required to run dx.
sidebar:
  order: 1
---

dx runs its web application and durable state in your Cloudflare account. Agent
workspaces (Orbs) run on E2B, on Cloudflare Containers in the same Cloudflare
account, or both.

## Prerequisites

- A Cloudflare account that can create Workers, D1 databases, R2 buckets, and
  Durable Objects. Workers AI is optional.
- At least one Orb provider:
  - E2B: an E2B account and API key.
  - Cloudflare Containers: the Workers Paid plan, and a running Docker daemon
    with buildx on the deploying machine to build the Orb image.
- Git, Node.js 22.19 or newer, and pnpm 9.15.
- Rust, zig (`pip install ziglang`), and `cargo install --locked
  cargo-zigbuild` only when you build `dxd` locally instead of using the
  release asset.

Install the repository dependencies from a clean checkout:

```sh
pnpm install --frozen-lockfile
```

## Know what can cost money

Cloudflare and E2B bill your accounts under their current plans. Cloudflare
Containers run and are billed in your Cloudflare account. Model providers
may charge separately. A deployment can incur charges while no browser is open
because stored data and running or paused workspaces follow provider billing
rules.

Before continuing, check:

1. Cloudflare Workers, D1, R2, Durable Objects, and Workers AI pricing.
2. E2B concurrency, template, CPU, memory, storage, and runtime limits.
3. The pricing and spending limits for each model provider you enable.

Stopping a local command does not cancel provider resources. Use the explicit
[destroy workflow](/docs/operations/upgrade-recovery/#destroy-a-deployment) when you
no longer want the deployment.
