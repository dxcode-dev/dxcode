---
title: E2B profiles
description: Size and maintain the E2B templates used by dx workspaces.
---

dx defines three workspace profiles:

| Profile | vCPU | Memory | Disk | Suggested use |
| --- | ---: | ---: | ---: | --- |
| `a1.tiny` | 1 | 2 GB | 20 GB | Small repositories and light edits |
| `a1.small` | 2 | 4 GB | 20 GB | General development |
| `a1.medium` | 4 | 8 GB | 20 GB | Larger builds and memory-heavy tools |

These values come from the checked-in profile catalog. E2B applies CPU, memory,
and disk when it builds a template, not when dx starts a sandbox.

## Immutable template identities

A deployment records the template alias and immutable build identity. To change
the environment, build a new template and update dx through deployment.

The deploy builds or reuses all three profile templates. Names use
`dx-<deployment-name>-<first-16-recipe-hash>-base` for the base and the same
prefix followed by `a1-tiny`, `a1-small`, or `a1-medium` for each profile.
Alchemy stores each exact `name:buildID` reference. Rerunning an unchanged
recipe reuses the ready builds.

## Plan limits

Your E2B plan controls concurrency, resources, template builds, and runtime.
Check it before selecting `a1.medium` or raising concurrency.

If a profile exceeds the plan, dx fails instead of silently choosing a smaller
profile.

## Troubleshoot templates

- **Template not found:** confirm the configured alias exists in the same E2B
  account as the API key.
- **Build identity mismatch:** do not overwrite state. Rebuild or select the
  expected immutable build.
- **Resource limit error:** compare the profile table with your E2B plan.
- **Sandbox starts but is not ready:** inspect redacted readiness diagnostics,
  then verify the `dxd` binary and template build are from the same release.
- **Quota exhausted:** stop unneeded workspaces or raise the account limit. A
  deployment rerun does not clear E2B quota.
