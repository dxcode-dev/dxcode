---
title: Terminal, Desktop, and Preview
description: The shared Terminal, the Linux Desktop, Preview links, and when a thread's Orb sleeps.
---

Each thread runs in its own Orb, a Linux sandbox. Besides Files and Changes,
the thread's right pane has three ways into that Orb. They need the dx Orb
image from v0.2.22 or later; see [Requirements](#requirements).

## Terminal

The Terminal is a tmux session that you and the agent share. Ask the agent to
run something in your terminal, or to look at what you ran, and it uses the
same session. Windows and panes work as in any tmux. The scroll wheel scrolls
tmux's history; hold Shift to select text in the browser.

The session lives in the Orb, not in the browser or in dx's daemon: closing
the tab, a network drop, or a dx update keeps your shell and its running
commands.

## Desktop

The Desktop tab streams a Linux desktop from the Orb, with Chromium and a
terminal. Click into it to type and use the mouse. Text copied on the desktop
reaches your own clipboard only right after your own key press or click
there, so nothing in the Orb can replace your clipboard on its own.

- The agent can open pages in the same Chromium and drive it, so you can watch
  or take over.
- The desktop streams only through your signed-in dx session, and only to the
  thread's owner and contributors. Viewers see a note instead. An archived
  thread's Desktop does not start.
- It connects while the tab is shown. After you switch tabs or collapse the
  pane it stays connected for a minute, so coming straight back is instant.
- After five minutes without input it pauses so the Orb can sleep; choose
  **Resume** to continue. Chromium and its tabs keep running in the Orb.
- There is no GPU: WebGL works through software rendering, and full-screen
  animation is slower than on a local machine.

## Preview

When the deployment has a [Portal domain](/docs/deployment/configuration/),
a web app the agent or you start in the Orb is reachable at
`https://t-<thread>-p<port>.<portal domain>/` behind dx sign-in. The
**Preview** tab lists the ports listening in the Orb and opens them. A
thread's owner can make up to three ports public at once, each for 1 hour,
1 day, or 7 days, and revoke them at any time; public visitors see a notice
first and get no access to the thread. Without a Portal
domain the Preview tab is hidden, and the agent shows running apps in the
Desktop's Chromium instead.

Declare a dev server you keep using in `.dx/services.yaml` so a Preview
request starts it again after the Orb wakes:

```yaml
services:
  web:
    command: pnpm dev --host 127.0.0.1 --port $PORT
    port: 5173
    cwd: apps/web # optional
```

## When the Orb sleeps

An Orb pauses five minutes after the last activity, and wakes on the next
message, Terminal, Files, Desktop, or Preview request. Sleeping keeps memory
on E2B, so running processes continue where they stopped.

| Activity | Keeps the Orb awake |
| --- | --- |
| The agent running a command | While it runs, then five minutes |
| Typing in the Terminal | Five minutes from the last key |
| A command running in the Terminal | Up to five minutes after the Terminal or agent was last used |
| The Desktop in use | Until five minutes without input, then five minutes |
| A Preview request | Five minutes from the request |
| A server listening, unused | No |

A forgotten dev server, build, or Desktop tab therefore keeps an Orb awake
for about ten minutes, not indefinitely.

## Requirements

The Terminal's tmux and the Desktop come from the dx Orb image. A self-host
on E2B must rebuild its template after upgrading to v0.2.22
(`pnpm deploy:selfhost:template`, then deploy); Cloudflare Containers deploys
build the image themselves. A thread created before that keeps its sandbox:
its Terminal is a plain shell and its Desktop says it is not available.
