---
title: Claude Code usage limits in dx
description: See your Claude plan's 5-hour, weekly, and per-model usage limits in dx, choose whether Claude Code may run on paid extra usage, and learn what a Thread shows when it reaches a limit.
---

Claude Code in dx runs on your Claude Pro or Max plan, so it counts against
that plan's usage limits. dx shows those limits next to your connection,
lets you choose what happens when one runs out, and tells you in the Thread
when a limit stopped Claude Code. To connect a plan first, see
[Use your Claude Pro or Max plan](/docs/guides/claude-pro-max-plan-in-the-cloud/).
To start a Claude Code Thread, see
[Run Claude Code in the cloud](/docs/guides/run-claude-code-in-the-cloud/).

## Where to see your limits

Open **Personal Settings → Model Routing**. The Claude Pro/Max connection
has a **Plan Usage** section with one row per limit. Each row shows the
percent used and when the limit resets. The bar turns to a warning color at
80% and to a red color at 100%. A limit that has already reset shows **Reset**
and its time instead of a percent.

dx lists only the limits Anthropic reported for your plan. They can be:

| Row | What it limits |
| --- | --- |
| 5-hour limit | Every model, over a 5-hour window |
| Weekly limit | Every model, over a week |
| Opus limit | Opus models, over a week |
| Sonnet limit | Sonnet models, over a week |
| Fable limit | Fable models, over a week |

A plan with no reading yet shows "Anthropic reported no limits yet."

## How dx reads them

The token from `claude setup-token` cannot call Anthropic's usage endpoint.
dx reads your limits from the rate-limit headers Anthropic sends back on
each call made with your plan:

- The connection check, which runs when you open **Model Routing** and when
  you choose the refresh button next to **Plan Usage**. This reads the
  5-hour and weekly limits.
- Claude Code itself, which reports the limits, including the per-model
  ones, while it runs in a Thread.

The time after **As of** says when dx last read them. While your plan is
used up and extra usage on your Claude account is not **Off**, the
connection check does not read new limits, because the call could draw on
paid extra usage. The rows update again once Claude Code runs or the limit
resets. Replacing the token clears the stored limits, since the new token
may belong to another account.

## Subscription Only or Allow Extra Usage

Below the limits, **Claude Usage** has two choices:

- **Subscription Only**: "Stop Claude Code at a plan limit instead of using
  paid extra usage." This is the default.
- **Allow Extra Usage**: "Keep Claude Code working on paid extra usage from
  your Claude account."

Extra usage is a setting of your Claude account, not of dx. The panel shows
its state as "Extra usage on your Claude account:" followed by **In use**,
**On**, **Used up**, or **Off**. When it is off, dx disables the choice,
says why (for example "Your Claude plan does not include extra usage."), and
adds "Claude Code stops at plan limits."

With **Subscription Only**, dx limits Claude Code's use of extra usage in
two ways:

- It does not start a new Claude Code turn while the plan is used up for the
  Thread's model.
- It stops a running turn as soon as Claude Code reports that a call drew on
  extra usage.

The response in flight when Claude Code reports extra usage may already be
billed, and a turn that has finished its answer is not stopped. To make sure
nothing is billed, turn off extra usage in your Claude account.

## When a limit is reached

With **Subscription Only**, or when your account has no extra usage, the
panel says "Claude Code is paused until" followed by the reset time. When
only a per-model limit is used up, it names the models instead, for example
"Claude Code on Opus models is paused until" a time. A per-model limit pauses
only Threads on that model. Threads on other models can still run.

In the Thread, a card above the composer reads **Claude subscription limit
reached**. It names the limit and when it resets, such as "You've hit your
Claude 5-hour limit · resets" followed by the time. When dx stopped or did
not start Claude Code to keep it off extra usage, the card adds "dx kept
Claude Code off paid extra usage." The card has three actions:

- **Retry** runs the turn again. Choose it after the limit resets or after
  you choose **Allow Extra Usage**.
- **Open Model Routing** opens the settings where you can choose **Allow
  Extra Usage**.
- **Check usage** opens your usage page on claude.ai.

If Anthropic names no reset time, dx treats the plan as used up for one hour
after it read the limit.

## Source

- Plan Usage panel, extra usage choice, and paused notes:
  [`claude-plan-usage.tsx`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/settings/model-routing/claude-plan-usage.tsx),
  [`model-routing.css`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/settings/model-routing/model-routing.css)
- Limit names, per-model limits, extra usage states, and the one-hour
  fallback:
  [`claude-code.ts`](https://github.com/dxcode-dev/dxcode/blob/main/packages/domain/src/settings/claude-code.ts)
- Reading limits from headers and Claude Code, the default choice, and
  clearing limits on a new token:
  [`plan.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/claude-code/plan.ts)
- Not starting and stopping Claude Code at a limit:
  [`provider.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/claude-code/provider.ts),
  [`invocation.ts`](https://github.com/dxcode-dev/dxcode/blob/main/apps/core/src/settings/model-byok/invocation.ts)
- The limit card in the Thread:
  [`agent-panel.tsx`](https://github.com/dxcode-dev/dxcode/blob/main/apps/web/src/features/threads/agent-panel.tsx)
