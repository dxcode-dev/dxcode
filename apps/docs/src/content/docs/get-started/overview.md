---
title: Before you deploy
description: Accounts, tools, and costs required to run dx.
sidebar:
  order: 1
---

dx runs its web application and durable state in your Cloudflare account. Agent
workspaces run in your E2B account. You need both accounts before deployment.

## Prerequisites

- A Cloudflare account that can create Workers, D1 databases, R2 buckets, and
  Durable Objects. Workers AI is optional.
- An E2B account and API key. E2B is mandatory for v0.1.0 agent workspaces.
- Git, Node.js 22.19 or newer, and pnpm 9.15.
- Docker only when the release cannot supply a compatible Linux x64 `dxd`
  binary for your machine's deployment path.

Install the repository dependencies from a clean checkout:

```sh
pnpm install --frozen-lockfile
```

## Know what can cost money

Cloudflare and E2B bill your accounts under their current plans. Model providers
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
