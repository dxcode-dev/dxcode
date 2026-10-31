---
title: Connecting a model
description: Run Claude Code on your Claude Pro/Max plan, serve models from GitHub Copilot, add a provider's API key, or connect any compatible endpoint.
sidebar:
  order: 2
---

dx uses the models you connect. Open **Personal Settings → Model Routing**
and choose **Add**. The **Add a Provider** dialog lists:

| Entry | What it gives you | Scope |
| --- | --- | --- |
| **Claude Pro/Max** | The Claude Code mode, on your Claude plan | Personal |
| **GitHub Copilot** | The models your Copilot subscription includes | Personal |
| A provider, such as **Anthropic** or **OpenAI** | That provider's models, on your API key | Personal |
| **Custom URL** | Models behind any OpenAI- or Anthropic-compatible endpoint, with your API key | Personal or workspace |

## Claude Pro/Max

A Claude Pro or Max plan runs Claude Code inside your Thread's Orb.

1. Choose **Add → Claude Pro/Max**. The dialog is titled **Connect Your
   Claude Subscription**.
2. In a terminal on your own computer, run:

   ```sh
   claude setup-token
   ```

   This needs [Claude Code](https://code.claude.com/docs/en/setup) installed
   on that computer.
3. A browser window opens. Sign in with your Claude Pro or Max account and
   approve access.
4. Paste the token the command prints. It starts with `sk-ant-oat` and is
   valid for one year.
5. Choose **Connect Subscription**. dx checks the token with Anthropic
   before saving it.

If Anthropic rejects the token, run `claude setup-token` again and paste the
new one. To replace a token later, choose **Replace Token** on the
connection.

### Use it in a Thread

When you start a Thread, pick the **Claude Code** row in the mode picker and
choose a model and an effort:

- Models: Claude Opus 5.5 (the default), Sonnet 5.5, Haiku 5.5, Fable 5.1,
  Opus 5, and Sonnet 5.
- Efforts: Low Effort, Medium Effort, High Effort (the default), Extra High
  Effort, and Max Effort.

dx installs the Claude Code CLI in the Orb when it is missing or out of date,
and runs it there with your token. Your Claude plan covers only the Claude
Code mode. dx's own modes (Low, Medium, High, Ultra) and raw models are not
covered by it.

### Plan usage

The connection shows **Plan Usage**: your 5-hour, weekly, and per-model
limits, as Claude Code last reported them while it ran in a Thread. Before
Claude Code's first run on the plan, no limits show. Under **Claude Usage**,
choose what happens at a limit:

- **Subscription Only** (the default) stops Claude Code at a plan limit.
- **Allow Extra Usage** keeps it working on paid extra usage from your
  Claude account.

If extra usage is off in your Claude account, this choice is disabled and
Claude Code stops at plan limits. A Thread that stops at a limit shows
**Claude subscription limit reached**.

## GitHub Copilot

1. Choose **Add → GitHub Copilot**, then **Connect**.
2. dx shows a GitHub URL and a code. Open the URL, enter the code, and
   approve.
3. The dialog reads **GitHub Copilot connected.**

This sign-in asks GitHub only for `read:user`. It is separate from the GitHub
connection dx uses to clone repositories. dx serves the Copilot models your
account is entitled to; **Check Access** refreshes that list. If the
deployment has not set up Copilot sign-in, connecting fails with "Personal
model subscriptions are temporarily unavailable."

## A provider's API key

1. Choose **Add**, then the provider, such as **Anthropic**. A sheet titled
   **New Anthropic API Key** opens.
2. Paste your **API Key**. dx stores it encrypted.
3. Fill in the provider's own fields: OpenAI's **Region**, or Cloudflare AI
   Gateway's account and gateway IDs.
4. Under **Models**, every model in the provider's catalog is on, plus
   **All other _provider_ models** for models added later. Clear a box to
   leave that model to your other connections. **Advanced** shows the same
   choice as mapping lines: `anthropic/*` serves every Anthropic model,
   `-anthropic/claude-opus-5` excludes one, and the last matching line wins.
5. Optionally set a **Display Name** or, for gateways, **Headers**, then
   choose **Create**.

The providers listed are the ones the deployment offers. A self-hosted
deployment can limit them with `modelDeploymentProviders`.

## Custom URL with an API key

Use **Custom URL** for a provider's API, a gateway, or your own server.

1. Choose **Add**, then **Custom URL**.
2. Enter the **Base URL**, such as `https://api.example.com/v1`. It must be a
   public HTTPS address. The dialog shows the full URL requests go to.
3. Choose the **API format**: OpenAI Chat Completions, OpenAI Responses, or
   Anthropic Messages.
4. Enter a **Name** and your **API key**.
5. Under **Models**, list one model per line, such as
   `anthropic/claude-fable-5-1`. If the endpoint calls a model something else,
   map it with an arrow: `openai/gpt-6-astra -> astra-litellm`.
6. Optionally add **Custom headers** under **Advanced**, then choose **Add**.

Each model must be one dx knows. A connection holds up to 100 models, and
each scope holds up to 20 connections. A deployment can limit which
endpoints are allowed.

Workspace admins add Custom URL connections in **_Workspace_ Settings →
Model Routing**. Every member's Threads can use them after their own.

## Which connection serves a model

For each model, dx uses the first active connection that serves it: your
personal connections first, in the order you drag them into, then your
workspace's, then the deployment's own. **Deactivate** takes a connection
out of that order without deleting it.

A mode or model no connection serves is marked **Not served**.

## Choose what each mode runs

The dx modes are Low, Medium, High, and Ultra. **Personal Settings → Mode
Dial** pins the model and reasoning effort behind each mode. **Personal
Settings → Composer** sets the mode new Threads start in.

## Source

- Add a Provider dialog, provider API key sheet, and Custom URL dialog:
  [`add-provider-dialog.tsx`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/settings/model-routing/add-provider-dialog.tsx),
  [`provider-key-sheet.tsx`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/settings/model-routing/provider-key-sheet.tsx),
  [`connection-dialog.tsx`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/settings/model-routing/connection-dialog.tsx)
- Model mapping lines:
  [`provider-model-mapping.ts`](https://github.com/dxcode-dev/dxcode/blob/main/packages/domain/src/settings/provider-model-mapping.ts)
- Claude Pro/Max connect flow:
  [`claude-code-connect.tsx`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/settings/model-routing/claude-code-connect.tsx),
  [`claude-code-token.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/settings/model-routing/claude-code-token.ts)
- Claude Code models, efforts, and limits:
  [`claude-code.ts`](https://github.com/dxcode-dev/dxcode/blob/main/packages/domain/src/settings/claude-code.ts),
  [`claude-plan-usage.tsx`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/settings/model-routing/claude-plan-usage.tsx),
  [`plan.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/claude-code/plan.ts)
- Claude Code in the Orb:
  [`workspace-run.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/claude-code/workspace-run.ts)
- GitHub Copilot:
  [`github-copilot/provider.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/settings/model-subscriptions/github-copilot/provider.ts),
  [`model-subscriptions/routes.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/settings/model-subscriptions/routes.ts)
- Validation and limits:
  [`service.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/settings/model-routing/service.ts),
  [`model-routing.ts`](https://github.com/dxcode-dev/dxcode/blob/main/packages/domain/src/settings/model-routing.ts)
- Routing order:
  [`resolver.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/settings/model-routing/resolver.ts)
- Mode Dial and Composer settings:
  [`mode-dial/registration.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/settings/mode-dial/registration.ts),
  [`composer-settings.tsx`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/settings/composer/composer-settings.tsx)
