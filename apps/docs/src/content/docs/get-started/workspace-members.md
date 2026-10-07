---
title: Workspace members
description: Invite people to your workspace and share projects, secrets, and settings.
sidebar:
  order: 4
---

A workspace is your team in dx. Members share its projects, secrets and
environment variables, model connections, MCP servers, plugins, skills, and
Mode Dial. Each person keeps their own personal settings, private projects,
and threads. A person belongs to at most one workspace.

## Invite people

Workspace admins open **Workspace Settings → Members** and choose
**Create link** under **Invite links**. A link has a title and an optional
expiry, and anyone who has it can join until it expires or an admin revokes
it. Admins can copy a link again at any time.

The person opens the link, signs in or creates an account, and chooses
**Join workspace**. A valid invite link lets them sign in even when sign-up is
otherwise closed. Someone who already belongs to another workspace must leave
it first.

## Roles

- **Owner** created the workspace. The owner cannot be demoted, removed, or
  leave.
- **Admins** change workspace settings, members, and invite links. From
  **Members**, an admin can promote a member to admin, revoke admin, or remove
  a member.
- **Members** use everything the workspace provides. They see **Workspace**,
  **Members**, **MCP & Integrations**, and **Plugins** read-only; other
  workspace settings are hidden.

## Projects and source access

Every member can start threads in the workspace's projects. A thread clones
the project's repository with the source connection of the person who starts
it, so connect GitHub or Bitbucket under **Personal Settings → MCP &
Integrations** first. Until you can reach the repository, the project shows
**Connect GitHub** or **Connect Bitbucket** in the project picker and cannot be
selected. Projects that use a public Git URL work for everyone.

Only a project's creator and workspace admins can change its settings and
project secrets.

## Secrets, Model Routing, and the Mode Dial

Workspace secrets and variables apply to every member's threads. When names
collide, a personal value wins over a project value, which wins over a
workspace value.

Admins add **Custom URL** connections under **Workspace Settings → Model
Routing**, and every member's threads can use them. dx tries your personal
connections first, then the workspace's. GitHub Copilot stays personal.

Admins set the workspace **Mode Dial** to choose each mode's model and thinking
level for the team. Your personal Mode Dial wins for any mode you tune; modes
you have not tuned show **Workspace** and follow the workspace setting.

## Leaving a workspace

Choose **Leave workspace** under **Workspace Settings → Workspace**. Threads you
started in workspace projects stay with the workspace and come back if you
rejoin it. Any of those threads that are running stop when you leave. Your
personal projects, threads, settings, and source connections stay with you.
