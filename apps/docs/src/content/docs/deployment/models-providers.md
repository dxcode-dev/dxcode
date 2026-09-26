---
title: Models and providers
description: Configure model access for a deployment, workspace, or user.
---

Model routing is separate from workspace execution. E2B is mandatory, but no
particular model provider is.

## Configuration scopes

**Deployment credentials** provide operator-managed access such as Workers AI.

**Workspace BYOK** is shared under workspace policy.

**Personal BYOK** belongs to one user and is not exposed to other members.

dx encrypts stored provider secrets and does not return their plaintext.

## Supported provider paths

| Provider path | Credential or connection |
| --- | --- |
| Cloudflare Workers AI | Optional deployment binding |
| Personal and workspace BYOK | Provider API key stored by dx |
| GitHub Copilot | Personal GitHub device authorization |
| GitHub source access | GitHub App installation |
| Bitbucket source access | OAuth consumer authorization |
| Sarvam dictation | Optional deployment API key |
| Custom endpoint | HTTPS base URL, API format, model map, and credential |

GitHub and Bitbucket connections grant repository access. GitHub Copilot grants
model access through a subscription.

- [Configure GitHub source access](/docs/deployment/github-source/)
- [Configure Bitbucket source access](/docs/deployment/bitbucket-source/)
- [Configure GitHub Copilot](/docs/deployment/github-copilot/)

The installer asks which API-key providers to expose in the model picker. After
deployment, open **Settings → Model routing**, add a personal or workspace
connection, enter its API key, and assign models to agent slots. dx encrypts
the key and returns only masked metadata.

## Custom endpoint protocols

Custom endpoints support the OpenAI Completions, OpenAI Responses, Anthropic
Messages, and Google Generative AI formats. Enter one canonical model per line
as `provider/model`. Use `provider/model -> upstream-id` when the endpoint uses
a different model name.

The base URL must use HTTPS. Operators can restrict allowed endpoint origins
with `modelEndpointAllowlist`. Keep the list narrow when workspace members may
add routes. Test one model after saving because protocol compatibility depends
on the endpoint implementation.

## "Not configured"

**Not configured** means no usable route exists for that model and scope. dx
does not choose another provider. Add a credential or ask an administrator.

If all models show **Not configured**, the rest of the application can still
run. Threads cannot obtain model output until a route is configured.
