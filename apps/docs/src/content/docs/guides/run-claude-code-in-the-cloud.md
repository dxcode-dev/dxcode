---
title: Run Claude Code in the cloud
description: Run Claude Code on your Claude Pro or Max plan in a cloud sandbox, with your repository, a terminal, and a desktop, and keep it working when your laptop is closed.
---

dx runs the Claude Code CLI in a cloud sandbox, called an Orb, on your own
Claude Pro or Max plan. Each conversation is a Thread with its own Orb, so
several Claude Code sessions can work at once, and they keep working when you
close your laptop. You follow and steer them from the dx web app.

## What you need

- A Claude Pro or Max plan.
- [Claude Code](https://code.claude.com/docs/en/setup) on your own computer,
  once, to create a token.
- An Orb provider: an E2B, Cloudflare, Freestyle, Docker, or Boat account you
  connect, or one your dx deployment provides.

## Set it up

1. **Connect your plan.** In dx, open **Personal Settings → Model Routing**
   and choose **Add → Claude Pro/Max**. On your computer, run
   `claude setup-token`, sign in with your Claude account, and paste the
   token it prints. dx checks the token with Anthropic before saving it.
2. **Connect an Orb provider.** In **Personal Settings → Orb Providers**,
   choose **Connect** next to a provider and enter its key. dx prepares your
   account in a few minutes. See
   [Connecting an Orb provider](/docs/use/connect-an-orb-provider/).
3. **Start a Thread.** Open a project, choose **New Thread**, and pick the
   **Claude Code** row in the mode picker. Choose a model, such as Claude
   Opus 5.5 (the default), and an effort, then send your task.

[Connecting a model](/docs/use/connect-a-model/) covers the token, models,
and plan limits in detail.

## How Claude Code runs in the Orb

- **In your repository.** The Orb clones the project into
  `~/workspace/repo`, and Claude Code starts there. It reads the repository's
  `CLAUDE.md`, or its `AGENTS.md` when there is no `CLAUDE.md`.
- **Your instructions.** What you write in **Personal Settings →
  Instructions** becomes Claude Code's `~/.claude/CLAUDE.md` in the Orb.
- **Installed when needed.** dx installs the Claude Code CLI when the Orb
  lacks it or has a version older than 2.1.310.
- **One session per Thread.** Your first message starts a Claude Code
  session, and later messages resume it.
- **No permission prompts.** The Orb is a sandbox, so Claude Code runs with
  permission checks bypassed and works without stopping to ask.
- **Awake while it works.** The Orb stays awake while Claude Code runs. By
  default it pauses after five minutes without activity and resumes on your
  next message.

## What you can do from dx

Every tool call Claude Code makes shows up in the Thread's transcript. Next
to it, the Thread has Files, Changes, a Terminal you share with the agent, a
Linux Desktop with Chromium, and Portal links to web servers running in the
Orb.

Claude Code also gets dx's own tools through an MCP server named `dx`: it
can start child Threads, read other Threads, set a schedule, and subscribe
to GitHub events. Claude Code's own web search and page reading replace
dx's versions of those tools.

## Plan limits

Claude Code in dx counts against your Claude plan's limits. **Personal
Settings → Model Routing** shows your 5-hour, weekly, and per-model limits.
By default Claude Code stops at a limit. When your Claude account has extra
usage turned on, choose **Allow Extra Usage** to keep it working on paid
extra usage.

## Source

- Connecting the plan:
  [`claude-code-connect.tsx`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/settings/model-routing/claude-code-connect.tsx),
  [`claude-code-token.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/settings/model-routing/claude-code-token.ts)
- Models and efforts:
  [`claude-code.ts`](https://github.com/dxcode-dev/dxcode/blob/main/packages/domain/src/settings/claude-code.ts)
- Running Claude Code in the Orb, session resume, instructions, and
  permissions:
  [`workspace-run.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/claude-code/workspace-run.ts)
- dx tools through the `dx` MCP server:
  [`dx-agent.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/agents/dx-agent.ts),
  [`dx-tools.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/claude-code/dx-tools.ts)
- Instructions setting:
  [`advanced/registration.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/settings/advanced/registration.ts)
- Thread panes:
  [`pane-views.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/threads/panes/pane-views.ts)
- Plan limits:
  [`claude-plan-usage.tsx`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/settings/model-routing/claude-plan-usage.tsx),
  [`plan.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/claude-code/plan.ts)
- Idle pause:
  [`activity.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/execution/activity.ts)
