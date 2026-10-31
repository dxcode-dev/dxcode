---
name: orb-setup
description: "Prepare a repository to run in dx Orbs. Use when creating or updating .agents/setup or .agents/resume, declaring long-running services in .dx/services.yaml, or debugging Orb environment setup."
---

# Orb Setup

Prepares a repository to run well in dx Orbs (each Thread's Linux sandbox) by creating or updating
its Orb lifecycle files.

## Lifecycle Files

| File | When it runs | Purpose |
|------|--------------|---------|
| `.agents/setup` | Once for each new Thread's Orb, after dx checks out the repository and before the agent's first turn | Install toolchains, dependencies, databases, and other prerequisites |
| `.agents/resume` | After setup on first activation, and again each time a paused Orb is activated | Fast, idempotent authentication, reconnect, or repair steps |
| `.dx/services.yaml` | When the user opens a Portal URL whose service is stopped | Start long-running dev servers and other services on demand |

Key invariants:

- Every Thread gets its own Orb from dx's base image, and dx does not reuse a configured Orb between
  Threads. `.agents/setup` therefore runs for every new Thread, and the first turn waits for it.
  Keep it fast: aim to finish in under 2 minutes.
- dx runs `.agents/setup` only when the file is committed with the executable bit set
  (`chmod +x`, Git mode `100755`) in the commit the Thread started from. It runs the file in the
  current checkout.
- dx records a successful setup against the Thread's source commit, its source configuration, and
  the setup file's contents, and does not run it again for that Thread unless one of them changes.
  A failed or timed-out setup is logged and retried on the next activation; it never blocks the
  Thread. The workspace is usable without it, so the agent can finish setup work by hand.
- Each hook run is limited to 5 minutes. dx also runs `.agents/resume` when it reconnects the
  workspace daemon and stops that run after 120 seconds. Resume can therefore run more than once
  per wake: keep it idempotent and finish within seconds; never install dependencies there.
- Hooks run at the repository root as `user` with a minimal environment: `PATH`, `HOME`, `USER`,
  `LOGNAME`, `SHELL`, and `GIT_TERMINAL_PROMPT=0`. Setup gets no GitHub token, no source
  credentials, and none of the Project's environment variables or secrets. Never authenticate a
  user or service during setup. Install its client in setup and authenticate it during resume or
  when the agent first needs it; the resume run by the workspace daemon receives the Project's
  environment variables.
- Each hook's full output goes to its log under `~/.cache/dx/logs` (`setup.log`, `resume.log`),
  replaced on each run. Only the exit code decides whether the hook succeeded.
- Orbs are Debian sandboxes with passwordless `sudo`. The standard image has Node.js 24 with
  corepack (pnpm, yarn), OpenJDK 21, Python 3 with pip and venv, `build-essential`, git, git-lfs,
  GitHub CLI, ripgrep, jq, curl, wget, tmux, and Chromium; Orbs from older images can lack some of
  them, so check with `command -v` before relying on one. Tune databases for speed over durability
  (e.g. Postgres `fsync = off`, `synchronous_commit = off`).

## Workflow

### 1. Investigate the repository

Before writing anything, determine what a fresh machine needs to build, test, and run this repo:

- Package managers and lockfiles (`package.json`/`pnpm-lock.yaml`, `Cargo.toml`, `go.mod`,
  `requirements.txt`/`pyproject.toml`, `Gemfile`, ...)
- Toolchain version pins (`mise.toml`, `.tool-versions`, `.nvmrc`, `rust-toolchain.toml`,
  `packageManager` field, corepack)
- Environment files (`.env.example` and similar) and required secrets. Secrets belong in the
  Project's environment variables in dx settings, not in the repository or the scripts.
- Databases, caches, and other backing services the tests or dev server need
- Shell-managed development environments (Nix flakes, devenv, direnv, etc.) and how their full
  environment reaches the agent's non-interactive shell and service processes
- Existing setup docs: README, CONTRIBUTING, AGENTS.md, CI workflows (CI install steps are a
  reliable inventory of prerequisites)
- Existing `.agents/setup` and `.agents/resume` — update rather than replace, and preserve
  behavior you cannot verify

### 2. Write or update `.agents/setup`

A bash script starting with `#!/usr/bin/env bash` and `set -euo pipefail` that typically:

- Installs missing system packages via `sudo apt-get`. Check packages first so a rerun does not
  run `apt-get update` or reinstall packages it already has.
- Installs the pinned toolchain (e.g. `mise install --locked`, `corepack enable`)
- Sources an installer's profile script when the rest of setup needs a tool just installed; an
  installer cannot update the environment of the already-running setup process
- Installs dependencies from lockfiles (e.g. `pnpm install --frozen-lockfile`)
- Starts and seeds databases the repo needs, tuned for speed over durability
- Copies env templates without clobbering: `[ -f .env.local ] || cp -- .env.example .env.local`
  (avoid `cp -n` in scripts; its exit status on skip varies across coreutils versions)

Idempotence is required: run `.agents/setup` at least twice and verify that repeated runs converge
without duplicating configuration, corrupting seeded data, or failing because resources already
exist. Every command must terminate. Never run a foreground server, watcher, interactive prompt,
or other long-lived process; setup must exit for the Thread to start. Define long-lived services
in `.dx/services.yaml` instead. Print and time major steps so the log under `~/.cache/dx/logs`
shows which command is slow or failed.

Do not test persisted toolchain or profile changes by sourcing them into or otherwise modifying the
current shell. Start a new non-interactive login shell with the repository root as its working
directory and verify the environment there; that is the environment the agent and services
receive later.

### 3. Persist complete development environments

Installing a tool or making the current setup process work is not enough: the agent's commands
and dx services start afterward in separate shells. If the repository depends on a development
shell, make its complete environment available there too (including variables such as
`NODE_PATH` and build-tool paths), not just a few symlinked binaries.

Use an idempotent, repository-scoped, recursion-guarded hook in `~/.bash_profile` when the
environment manager supports exporting its environment. Prefer injecting exports into the current
login shell over wrapping every command or service in another supervisor process. For Nix, use
`nix print-dev-env` rather than `nix develop` in the hook so activation does not spawn a nested
shell or supervisor process. For example:

```bash
nix_profile="$HOME/.nix-profile"
# The installer cannot update this running script's environment.
# shellcheck disable=SC1091
source "$nix_profile/etc/profile.d/nix.sh"

repo_root="$(cd "$(dirname "$BASH_SOURCE")/.." && pwd)"
profile_marker="# my-project Nix development shell"
if ! grep -Fqx "$profile_marker" "$HOME/.bash_profile" 2>/dev/null; then
  cat >> "$HOME/.bash_profile" <<EOF

$profile_marker
if [[ -z "\${IN_NIX_SHELL:-}" && "\${PWD}" == "$repo_root" ]]; then
  eval "\$("$nix_profile/bin/nix" print-dev-env "$repo_root")"
fi
EOF
fi
```

### 4. Write or update `.agents/resume`

Same bash preamble. Only fast, idempotent authentication, reconnect, or repair work: authenticate
tunnels or CLIs with the Project's environment variables and re-check that databases are up.
Target completion within 10 seconds. Keep work in the foreground so failures are logged; write
progress to a log file if work may take longer.

### 5. Declare long-running services in `.dx/services.yaml`

When the user will keep using a dev server, declare it so dx starts it again after the Orb wakes:

```yaml
services:
  web:
    command: pnpm dev --host 127.0.0.1 --port $PORT
    port: 5173
    cwd: apps/web
    env:
      NODE_ENV: development
```

The command must listen on `$PORT`. When Portals are on, the first Portal request that finds the
service stopped starts it. A Vite dev server also needs the Portal domain in
`server.allowedHosts`.

### 6. Make executable and verify

- `chmod +x .agents/setup .agents/resume`
- Inside the Orb, run `.agents/setup` and `.agents/resume` directly from the repository root and
  fix failures. Run setup twice and time both runs. The warm run should avoid package downloads
  and unnecessary installs. Setup should finish in under 2 minutes; resume must finish in seconds.
- Run setup the way dx does, without the Project's variables, to catch a hidden dependency on
  them:
  `env -i HOME="$HOME" USER=user LOGNAME=user SHELL=/bin/bash PATH="$PATH" GIT_TERMINAL_PROMPT=0 .agents/setup`
- Inspect the logs under `~/.cache/dx/logs` when diagnosing an existing slow or failed setup. Add
  per-command timing before adding cache logic so the change addresses the measured slow step.
- Verify persisted shell environments from a clean non-interactive login shell started with the
  repository root as its working directory. Start the new shell with a minimal environment, run
  `/bin/bash -lc`, and check only the expected marker variables and `command -v` paths; do not dump
  an environment that may contain secrets.

### 7. Finalize repository files

- Commit both scripts with the executable bit set, and `.dx/services.yaml` when you added it. Ask
  before committing `.dx/services.yaml` when the user did not request it.
- A commit configures only Threads started from a commit that contains it. If the commit is not on
  the Project's default branch, say that setup applies only to Threads started from this branch.
  Ask whether to push it when a remote is available.
- Link a commit only after confirming the remote contains it.

## Examples

- "Set up this repository for dx Orbs"
- "Create .agents/setup and .agents/resume for this project"
- "Why is my Orb missing dependencies when the Thread starts?"
- "Make the dev server come back after the Orb wakes"
