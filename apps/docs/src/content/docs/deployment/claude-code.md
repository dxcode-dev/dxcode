---
title: Claude Pro/Max
description: Run threads with Claude Code on a person's own Claude Pro or Max plan.
---

Claude Pro/Max is an optional personal model connection. A person connects
their own Claude plan, and a thread they pin to Claude Code runs with Claude
Code as its agent in the thread's Orb. Model use bills to their Claude plan.
The deployment needs no configuration and pays no model cost for these
threads.

## Connect a plan

1. On your own computer, install Claude Code and run `claude setup-token`.
2. Sign in with your Claude Pro or Max account and approve access. The command
   prints a token that starts with `sk-ant-oat`. It is valid for one year.
3. In dx, open **Settings → Model routing** and choose **Add → Claude Pro/Max**.
4. Paste the token and choose **Connect Subscription**.

dx checks the token with Anthropic before storing it and refuses a token
Anthropic rejects. It encrypts the token like an API key and never returns it.
Each person has one plan connection; adding it again replaces the token.
Workspace routing does not offer it.

## Start a Claude Code thread

In the new-thread mode picker, choose **Claude Code**, either the lamp under
the dial or the Claude Code row, then a model and an effort. Claude Code models
are not listed among raw models or Mode Dial slots, and custom connections
cannot serve them.

Claude Code works with its own tools, such as Bash, Read, Write, Edit, web
search, and subagents. dx adds its own tools as `mcp__dx__*`: the thread tools,
including `find_thread` and `read_thread`, Code's `code_exec` and
`tool_search` for connected MCP servers, skill resources, and installed plugin
tools. The transcript, Stop, Retry, Changes, and Files work as in any other
thread.

`read_thread` reads another thread with a separate reader model. A Claude
Code thread has no such model yet, so there `read_thread` answers "Subagent
not configured"; `find_thread` works as usual.

## Plan limits and extra usage

Claude plans have usage limits: a 5-hour window, a weekly window, and on
some plans a weekly limit for one model (Claude Code calls it the Fable
limit). A Claude account can also have extra usage turned on, which
Anthropic bills at API rates once a limit is used up.

The Claude Pro/Max card in Model Routing shows the limits Anthropic last
reported to one of your Claude Code threads, with when each resets. dx
cannot ask Anthropic for them directly, so they appear after your first
Claude Code thread runs, and the card shows only the windows Anthropic
reports for your plan.

The card's **Claude Usage** choice decides what happens at a limit:

- **Subscription Only** (the default): dx stops Claude Code when Anthropic
  reports that extra usage is paying, and does not start it again until the
  limit resets. A weekly limit for one model, such as the Fable limit, holds
  only threads on that model. The response in flight when Anthropic reports it may already
  be billed as extra usage. To make sure nothing is billed, turn off extra
  usage in your Claude account settings.
- **Allow Extra Usage**: Claude Code keeps working on extra usage.

A thread that reaches a limit shows a **Claude subscription limit reached**
card above the composer with the reset time. Choose **Retry** after the limit
resets or after you allow extra usage.

## Orb requirements

The standard Orb image includes Claude Code, Python 3 for dx's tool server,
and `awk`. A workspace created from an older image installs Claude Code the
first time it runs a Claude Code thread. A custom image needs network access
to `claude.ai` for that install, or Claude Code on the `PATH`.

## Token handling

The token reaches Claude Code only as process environment for one run, and
only for the thread's pinned Claude Code model. dx removes `ANTHROPIC_*` and
`CLAUDE_CODE_USE_*` variables from Claude Code's environment and passes
command-line settings that fix the API URL and clear proxy and CA variables.
Workspace variables and a repository's `.claude` settings therefore cannot
replace the token or send it to another endpoint. Secrets Claude prints are
redacted from the transcript.

## Troubleshooting

- **"Anthropic rejected this token"**: the token was mistyped, revoked, or
  expired. Run `claude setup-token` again and replace the token.
- **"Anthropic could not be reached"**: retry later; dx stores no token it has
  not checked.
- **Claude Code mode is missing from the picker**: connect a plan first, in
  personal Model routing.
