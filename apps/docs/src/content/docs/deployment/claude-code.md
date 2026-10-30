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
3. In dx, open **Personal Settings → Model Routing** and choose **Add → Claude Pro/Max**.
4. Paste the token and choose **Connect Subscription**.

dx checks the token with Anthropic before storing it and refuses a token
Anthropic rejects. It encrypts the token like an API key and never returns it.
To swap a token, choose **Replace Token** on the connection.
Workspace routing does not offer Claude Pro/Max.

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

## Plan limits and extra usage

Claude plans have usage limits: a 5-hour window, a weekly window, and on
some plans weekly limits for one model (the Opus, Sonnet, and Fable
limits). A Claude account can also have extra usage turned on, which
Anthropic bills at API rates once a limit is used up.

The Claude Pro/Max card in Model Routing shows the limits Anthropic reports
for your plan, with when each resets. dx reads them from Anthropic when Model
Routing loads and when you choose the refresh button beside **Plan Usage**. While a limit is
used up and extra usage could be billed, dx shows the last reported values
instead.

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
and `awk`. A workspace whose Claude Code is missing or older than 2.1.310 installs
the current release the first time it runs a Claude Code thread. A custom image needs network access
to `claude.ai` for that install, or Claude Code at `~/.local/bin/claude`, where its
installer puts it. dx never runs a `claude` found elsewhere on the `PATH`.

## Token handling

The token reaches Claude Code only on a file descriptor for one run, and
only for the thread's pinned Claude Code model. dx sends it after the run's
command has started, never in a command's environment, so a shell profile
does not see it. dx removes `ANTHROPIC_*` and
`CLAUDE_CODE_USE_*` variables from Claude Code's environment and passes
command-line settings that fix the API URL and clear proxy and CA variables.
Workspace variables and a repository's `.claude` settings therefore cannot
point Claude Code at another API URL or proxy, and a repository's
`apiKeyHelper` cannot replace the token. Hidden secret values Claude
prints are redacted from the transcript. Commands that a repository's setup
or the agent runs in the Orb run as the Thread's owner, and so does
everything a person the Thread is shared with does in it, including the
Terminal. People should connect a plan only for repositories they trust, and
share a Claude Code Thread only with people they would give the plan to.

## Troubleshooting

- **"Anthropic rejected this token"**: the token was mistyped, revoked, or
  expired. Run `claude setup-token` again and replace the token.
- **"Anthropic could not be reached"**: retry later; dx stores no token it has
  not checked.
- **The Claude Code row shows Connect Claude Pro/Max**: connect a plan
  first, in personal Model Routing.
