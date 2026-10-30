---
title: Getting started
description: Sign in, connect a model and an Orb provider, create a project, and start your first Thread.
sidebar:
  order: 1
---

dx runs coding agents in the cloud. Each conversation with an agent is a
Thread, and each Thread runs in its own Orb, a Linux sandbox on an Orb
provider you connect. You bring the model and the Orb provider. This page
takes you from sign-in to a running Thread.

## Sign in

Open dx and sign in. The sign-in page shows the methods your deployment
offers: an email link, a password, or **Continue with Google**.

New accounts depend on the deployment's admission policy:

- With an invite link from a workspace admin, the page reads **Join
  _workspace_ on dx** and signing in accepts the invite.
- On a deployment with a waitlist, an unknown email joins the waitlist and
  dx shows **You're on the waitlist**. You can sign in once an admin
  approves your email.
- On a deployment that is invite-only, an unknown email gets "No dx account
  uses this email. Ask a workspace admin for an invite link."

## Open Settings

Settings has two levels. Open the account menu in the sidebar and choose
**Personal Settings** for your own connections, or **_Workspace_ Settings**
for connections everyone in the workspace uses. Workspace admins manage the
workspace's connections.

## Connect a model

In **Personal Settings → Model Routing**, choose **Add** and pick one of:

- **Claude Pro/Max** to run Claude Code in your Threads on your Claude plan.
- **GitHub Copilot** to serve the models your Copilot subscription includes.
- **Custom URL** for any endpoint that speaks the OpenAI or Anthropic API,
  with your API key.

See [Connecting a model](/docs/use/connect-a-model/) for each one.

## Connect an Orb provider

In **Personal Settings → Orb Providers**, choose **Connect** next to E2B,
Cloudflare Containers, Freestyle, or Docker Cloud Sandboxes and enter the
key or token it asks for. dx then prepares your account, which takes a few
minutes for most providers and about ten for Freestyle. The provider's row
shows each step while it runs.

A provider listed as **Provided by this deployment** already works and needs
no connection. See [Connecting an Orb provider](/docs/use/connect-an-orb-provider/).

## Create a project

A project is the repository your Threads work in.

1. Go to **Projects** and choose **New Project**.
2. Choose **Start From Scratch** for a blank repository that dx manages, or
   **Use an Existing Repository** to search the repositories your GitHub or
   Bitbucket connection can reach or paste a Git URL. With an existing
   repository, pick it and choose **Continue**.
3. Enter a **Project Name** and choose the **Owner**: your workspace or
   **Private**. Optionally add a **Description** or **Additional
   Repositories**.
4. Choose **Create Project**.

Public repositories need no GitHub or Bitbucket connection.

## Start a Thread

Open the project and choose **New Thread**. Below the prompt box you choose:

- **Mode or model.** The dx modes are Low, Medium, High, and Ultra. The
  **Claude Code** row runs Claude Code on your Claude Pro/Max plan, with its
  own model and effort. The **Raw Models** tab lists every model your
  connections serve, except Claude Code's.
- **Orb.** Pick a provider and a size, shown as CPU and memory. If no provider is
  available, the picker shows **Connect an Orb provider**, which opens
  Settings.

Write a small task you can check, such as "Add a test for the date parser
and run it", and send it. dx starts the Orb, clones the project's repository
into `~/workspace/repo`, and the agent starts work. The mode and Orb are fixed
when the Thread starts.

## Work alongside the agent

When the Orb is ready, the Thread's side pane has these views:

| View | What it shows |
| --- | --- |
| Files | The Orb's files |
| Changes | What changed in the repository |
| Portal | Web servers listening in the Orb, at their own URLs |
| Terminal | A tmux session you share with the agent |
| Desktop | A Linux desktop with Chromium the agent can drive |

Portal appears only when the deployment has a Portal domain. See
[Terminal, Desktop, and Portal](/docs/get-started/workspace-tools/).

By default an Orb pauses after five minutes without activity, and dx resumes
it when the Thread needs it again, such as when you send the next message.
What a pause keeps depends on the provider.

## Source

- Sign-in and admission:
  [`sign-in-page.tsx`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/authentication/sign-in-page.tsx),
  [`admission.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/auth/admission.ts)
- Settings menu:
  [`sidebar-account-menu.tsx`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/navigation/sidebar-account-menu.tsx)
- Projects:
  [`new-project-dialog.tsx`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/projects/new-project-dialog.tsx)
- Mode and Orb pickers:
  [`new-thread-configuration-strip.tsx`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/threads/new-thread-configuration-strip.tsx),
  [`new-thread-modal-utils.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/threads/new-thread-modal-utils.ts)
- Thread views:
  [`pane-views.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/threads/panes/pane-views.ts)
- Mode and Orb fixed at start:
  [`create-thread.ts`](https://github.com/dxcode-dev/dxcode/blob/main/packages/api/src/threads/create-thread.ts),
  [`plugins/execution/orb-providers.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/plugins/execution/orb-providers.ts)
- Idle pause and resume:
  [`activation.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/activation.ts),
  [`activity.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/activity.ts)
