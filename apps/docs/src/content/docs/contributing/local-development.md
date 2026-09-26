---
title: Local development
description: Run dx locally with deterministic fixtures and no billable calls.
---

Local development requires Node.js 22.19 or newer and pnpm 9.15.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` uses deterministic source and model fixtures. It strips inherited
Cloudflare, E2B, source-host, and paid-model credentials from child processes.
Unknown model prompts fail closed. Routine local development must not make
billable external calls.

The local stack still exercises the resident `dxd` protocols for files,
changes, and terminal sessions. Local persistence belongs to the checkout and
can survive process restarts.

## Run checks

Use the changed-aware verifier before submitting a change:

```sh
pnpm verify:changed -- origin/main
```

For docs work:

```sh
pnpm --filter @dx/docs check
pnpm --filter @dx/docs build
```

The docs check validates Astro content, internal links, and prohibited public
content. The build creates the production site and scans generated files again.

Do not run deployment or provider-backed checks as part of routine contribution
verification. Those commands can create resources or incur charges.
