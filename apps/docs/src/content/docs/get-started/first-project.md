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

1. Choose **New project**.
2. Paste an anonymously cloneable HTTPS Git repository URL, or connect a
   supported source host to select a private repository.
3. Choose an E2B profile. Start with `a1.small` for general work.
4. Save the project.

Public repositories do not require GitHub, Bitbucket, or another provider
integration. Private repository discovery and checkout require a configured
source connection with access to that repository.

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
