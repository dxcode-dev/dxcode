---
title: First project and thread
description: Sign in, connect source code, and start an agent thread.
sidebar:
  order: 3
---

## Sign in

Open the URL printed by `pnpm dx:deploy`. Sign in with the administrator account
created during deployment. Its credentials are in the path printed by the
successful deploy, normally `.dx/secrets/selfhost-admin.txt`.

With the default `allowSignup: false`, only the bootstrapped administrator can
sign in. With `allowSignup: true`, the sign-in page also offers direct
email/password account creation. Self-host signup has no waitlist, approval
step, or magic-link flow.

## Create a project

1. Choose **New Project**.
2. Choose **Start From Scratch** for an empty repository, or **Use an Existing
   Repository**. For an existing repository, search the repositories your
   GitHub or Bitbucket connection can access, or paste the HTTPS URL of any Git
   repository, then choose **Continue**.
3. Name the project and choose its owner: your workspace or **Private**.
4. Optionally choose **Add Description** or **Add Additional Repositories**,
   then **Create Project**.

Public repositories do not require GitHub, Bitbucket, or another provider
integration. A connected repository is reached through your own connection, for
workspace and private projects alike, so you need access to it before you can
select it. Threads clone it with the credentials of the person who creates the
Thread.

Each Orb clones the project's repository into `~/workspace/repo` and its
additional repositories into `~/workspace/repos/<name>`. Additional
repositories on GitHub or Bitbucket clone with your connection when you have
one; other public URLs clone anonymously. A repository you cannot reach is
skipped without stopping the Orb. Change the list later in the project's
settings under **Repository**; the next message in a Thread clones new entries and
leave existing clones untouched. The Orb size is also a project setting.

## Start a thread

Open the project, choose **New thread**, and describe a small, verifiable task.
dx creates an isolated execution workspace and starts the resident `dxd`
process. The thread keeps the conversation, file state, changes, and terminal
connection associated with that workspace.

Git commits created by the agent or in Terminal use
`dxcodeagent <agent@dxcode.dev>` by default. Each commit includes a
`dx-Thread-Id` trailer linking to its dx thread. Choosing your own commit
identity in project settings changes the author but keeps the thread trailer.

If the model selector says **Not configured**, an administrator must configure
a model route. See [Models and providers](/docs/deployment/models-providers/).
