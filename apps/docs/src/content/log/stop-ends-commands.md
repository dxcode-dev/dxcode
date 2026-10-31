---
title: Stop ends the command the agent is running
date: 2026-10-31
summary: Stop now ends the shell command the agent is waiting on, marks it Stopped, and gives Send back right away.
kind: news
---

Stop used to end the agent's turn while the command it was running kept going. Now, when you choose Stop, dx also ends the shell command the agent is waiting on, along with the processes it started.

The transcript marks both the turn and the command **Stopped**, so a stopped command no longer looks like a failure. Send is ready again as soon as the turn ends.

A command the agent already left running, and checks on later, keeps running.
