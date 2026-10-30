---
title: Use your Claude Pro or Max plan for cloud agents
description: Connect a Claude Pro or Max plan to dx with claude setup-token, run Claude Code in cloud sandboxes on it, and see how dx keeps the token safe.
---

dx runs Claude Code in cloud sandboxes on the Claude Pro or Max plan you
already pay for. You connect the plan once with a token from
`claude setup-token`, then pick Claude Code when you start a Thread. This
page covers what the plan pays for, how the token works, and how dx guards
it. For a walkthrough of running Claude Code, see
[Run Claude Code in the cloud](/docs/guides/run-claude-code-in-the-cloud/).

## What the plan covers

Your plan runs the **Claude Code** mode in dx, on these models:

| Model | Note |
| --- | --- |
| Claude Opus 5.5 | The default |
| Claude Sonnet 5.5 | |
| Claude Haiku 5.5 | |
| Claude Fable 5.1 | |
| Claude Opus 5 | |
| Claude Sonnet 5 | |

You also pick an effort: Low, Medium, High (the default), Extra High, or
Max.

The plan does not cover dx's own modes (Low, Medium, High, Ultra) or raw
models. Those run on the other connections in **Personal Settings → Model
Routing**. Claude Code models run only through a Claude Pro/Max connection,
so you cannot route them through an API key or a Custom URL.

## Get a token with claude setup-token

`claude setup-token` is a Claude Code command that signs in to your Claude
account and prints a long-lived token for that plan.

1. Install [Claude Code](https://code.claude.com/docs/en/setup) on your own
   computer.
2. Run:

   ```sh
   claude setup-token
   ```

3. A browser window opens. Sign in with your Claude Pro or Max account and
   approve access.
4. Copy the token the command prints. It starts with `sk-ant-oat` and is
   valid for one year.

## Connect it to dx

1. In dx, open **Personal Settings → Model Routing** and choose
   **Add → Claude Pro/Max**.
2. Paste the token and choose **Connect Subscription**.

dx checks the token with Anthropic before it saves it. If Anthropic rejects
it, the dialog says so; run `claude setup-token` again and paste the new
token. Each person connects one Claude plan. To swap the token, choose
**Replace Token** on the connection.

## How dx protects the token

- dx stores the token encrypted. Settings shows only that a token is
  stored, never the token itself.
- In the sandbox, the token reaches the Claude Code process on a file
  descriptor for one run, not as a variable in Claude Code's environment.
- Before Claude Code starts, dx unsets `ANTHROPIC_*` and
  `CLAUDE_CODE_USE_*` variables and extra CA certificates. Command-line
  settings, which outrank a repository's `.claude` settings, pin
  Anthropic's API URL and blank the proxy variables. A repository's `.claude` settings or a workspace
  variable cannot point Claude Code at another API URL or proxy.
- When Claude Code prints the value of a secret environment variable that
  dx hides, dx redacts it from the transcript. Settings warns when a secret
  is too short to hide.

Commands that a repository's setup or the agent runs in the Orb run as you.
Connect your plan only for repositories you trust.

## Limits

Claude Code in dx counts against your plan's usage limits, the same as
Claude Code on your computer. The connection in **Model Routing** shows
your 5-hour, weekly, and per-model limits. By default Claude Code stops at
a limit; with extra usage turned on in your Claude account, **Allow Extra
Usage** keeps it working on paid extra usage.

## Source

- Models and efforts:
  [`claude-code.ts`](https://github.com/dxcode-dev/dxcode/blob/main/packages/domain/src/settings/claude-code.ts)
- What the plan covers, and Claude Code models only through the plan:
  [`claude-code-connect.tsx`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/settings/model-routing/claude-code-connect.tsx),
  [`service.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/settings/model-routing/service.ts)
- Token check with Anthropic:
  [`claude-code-token.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/settings/model-routing/claude-code-token.ts)
- Encrypted storage:
  [`model-credential-encryption.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/settings/model-routing/model-credential-encryption.ts),
  [`service.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/settings/model-routing/service.ts)
- Token on a file descriptor, cleared variables, and pinned settings:
  [`workspace-run.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/claude-code/workspace-run.ts)
- Redaction and the short-secret warning:
  [`environment-variable-controls.tsx`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/settings/environment-variables/environment-variable-controls.tsx),
  [`stream.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/claude-code/stream.ts),
  [`environment-variables/sandbox.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/settings/environment-variables/sandbox.ts)
- Limits:
  [`claude-plan-usage.tsx`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/settings/model-routing/claude-plan-usage.tsx),
  [`plan.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/claude-code/plan.ts)
