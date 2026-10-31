---
title: Why each Thread gets its own computer
date: 2026-10-31
summary: A coding agent does its best work with a whole machine to itself, so every dx Thread runs in its own Orb.
kind: note
featured: true
cover: ../../assets/log/navy-clouds.webp
link: /docs/use/getting-started/
---

When you start a Thread in dx, you get more than a chat. You get a computer. Each Thread runs in its own Orb: a Linux sandbox, with your project's repository cloned in when the Thread has one, ready for the agent to work in. Here is why.

## An agent needs room to work

Real coding work is messy. The agent installs dependencies, runs the test suite, starts a dev server, and leaves half-finished files behind while it thinks. On a shared machine, two agents doing that at once trip over each other. In dx, no two Threads share an Orb, so each agent can make a mess without breaking anyone else's work.

## Parallel work stays parallel

The same rule holds for the Threads an agent starts. A child Thread gets its own agent and its own Orb, works on its part of the task, and reports back to the Thread that started it. You can fan a task out across several Threads, and none of them waits on another's checkout or port.

## You work in the same computer

An Orb is not a black box. Open a Thread and you see what the agent sees: **Files** and **Changes** for the code, a **Terminal** you share with the agent, a **Desktop** with Chromium, and, on deployments with Portals, a **Portal** for the web servers it runs. When the agent gets stuck, you can step in on the same files and hand it back.

## It keeps going without you

The agent runs on the server, not in your browser, so closing the tab does not stop it. When a Thread goes quiet, its Orb sleeps after five idle minutes by default and wakes when there is work again, with its files where the agent left them.

## Your choice of provider

An Orb runs on E2B or Cloudflare when your deployment provides them, or on a provider you connect yourself: E2B, Cloudflare, Freestyle, Docker Cloud Sandboxes, or Boat. To pick one, see [Connecting an Orb provider](/docs/use/connect-an-orb-provider/).
