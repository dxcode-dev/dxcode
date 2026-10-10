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

## Share a thread

Threads start private. To share one, open it and choose **Share** in the
header, then set your workspace to:

- **View**: members can read the thread, its Changes, and its files. They
  cannot send messages or open the terminal.
- **Contribute**: multiplayer. Members can send messages, and the agent runs
  commands and tools as you, with your keys, model routing, environment
  variables, and credits, until multiplayer ends. dx asks you to confirm
  first; check **Don't ask me again** to skip that next time.

Multiplayer lasts 7 days. Click the avatars in the thread header to see who is
there, keep multiplayer on for 1 hour, 3 hours, 3 days, or 7 days, or disable
it. When it ends, members can still view the thread. Choose **No access** to
make the thread private again.

A shared thread always runs on your account. When a member opens its Files,
Changes, or terminal, or sends a message, the thread's sandbox wakes and stays
up as it would for you, using your resources. Members never see your personal
agent instructions, skill instructions, or MCP server addresses.

A shared thread appears in a member's sidebar, under its project, once they
follow it. Opening a shared thread follows it, and so does being tagged in it.
Click the bookmark next to the thread title, or on the sidebar row, to
unfollow and remove it from your sidebar; you can still open it from its link.
Every message shows who sent it, and the agent sees the sender too, so it can
answer and tag the right person.

## Chat in a shared thread

Type `@` in the composer of a shared thread to tag a workspace member by their
username, or `@dx` to tag the agent. Tagging a member switches the thread to
chat mode: everyone in the thread sees your message right away, and the agent
does not answer it or use your credits. The composer turns purple and shows
**You're in chat mode. Tag @dx to get back to hacking.**

Chat mode stays on for messages that tag nobody, for everyone in the thread,
until someone tags `@dx`. That message goes to the agent and switches the
thread back to agent mode. The agent then reads the chat messages sent since
its last turn, with who sent each, so you can ask it to act on what the team
discussed. Chat sent while the agent is working shows in the thread at once,
but the agent reads it only with the next message to it. Chat messages cannot
include images.

Click a tagged name or a sender's avatar to see their name, username, and
email. You and contributors can chat; people with **View** read the chat but
cannot send. A private thread is always in agent mode: there, `@` explains that
you need to share the thread first and opens **Share**.

## Leaving a workspace

Choose **Leave workspace** under **Workspace Settings → Workspace**. Threads you
started in workspace projects stay with the workspace and come back if you
rejoin it. Threads you shared stop being visible to the workspace, and threads
others shared with you disappear. Any of those threads that are running stop when you leave. Your
personal projects, threads, settings, and source connections stay with you.
