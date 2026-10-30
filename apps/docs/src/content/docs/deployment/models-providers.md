---
title: Models and providers
description: Configure model access for a deployment, workspace, or user.
---

Model routing is separate from workspace execution. Threads need an Orb
provider, one the deployment offers or one a person or workspace
[connects](/docs/use/connect-an-orb-provider/), but no particular model
provider.

## Configuration scopes

**Deployment credentials** provide operator-managed access such as Workers AI.

**Workspace connections** are Custom URL connections that workspace admins
add. Every member's Threads can use them after their own.

**Personal connections** belong to one user and are not exposed to other
members: Claude Pro/Max, GitHub Copilot, and Custom URL.

dx encrypts stored provider secrets and does not return their plaintext.

## Supported provider paths

| Provider path | Credential or connection |
| --- | --- |
| Cloudflare Workers AI | Optional deployment binding |
| GitHub Copilot | Personal GitHub device authorization |
| Claude Pro/Max (Claude Code mode) | Personal `claude setup-token` token |
| GitHub source access | GitHub App installation |
| Bitbucket source access | OAuth consumer authorization |
| Sarvam dictation (Speech plugin) | Optional deployment API key; people and workspaces can add their own in Settings → Plugins |
| Custom endpoint | HTTPS base URL, API format, model map, and credential |

GitHub and Bitbucket connections grant repository access. GitHub Copilot grants
model access through a subscription. Claude Pro/Max runs Claude Code threads on
a person's own Claude plan.

- [Configure GitHub source access](/docs/deployment/github-source/)
- [Configure Bitbucket source access](/docs/deployment/bitbucket-source/)
- [Configure GitHub Copilot](/docs/deployment/github-copilot/)
- [Connect Claude Pro/Max](/docs/deployment/claude-code/)

People add connections in **Personal Settings → Model Routing**; see
[Connecting a model](/docs/use/connect-a-model/). A provider API key goes in
a Custom URL connection that points at the provider's API. dx encrypts the
key and returns only masked metadata.

## Custom endpoint protocols

Custom endpoints support the OpenAI Chat Completions, OpenAI Responses, and
Anthropic Messages formats. Enter one canonical model per line
as `provider/model`. Use `provider/model -> upstream-id` when the endpoint uses
a different model name.

The base URL must use HTTPS. Operators can restrict allowed endpoint origins
with `modelEndpointAllowlist`. Keep the list narrow when many people
add connections. Test one model after saving because protocol compatibility depends
on the endpoint implementation.

## "Not served"

**Not served** means no active connection serves that model. dx uses the
first active connection that serves the model and never swaps in a
different model. Add a connection or ask an administrator.

If every model shows **Not served**, the rest of the application can still
run. Threads cannot obtain model output until a connection serves a model.
