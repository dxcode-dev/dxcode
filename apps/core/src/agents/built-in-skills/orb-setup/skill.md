---
name: orb-setup
description: "Prepares a Project to run in dx Orbs: works out the toolchains and dependencies the repository needs, then writes and saves its setup and resume scripts in dx with manage_dx. Use when asked to set up Orbs for a project, when writing or changing the Project's setup, resume, pre-clone, or Desktop resume scripts, when declaring long-running services in .dx/services.yaml, or when an Orb starts without the tools a project needs."
---

# Orb setup

An Orb is the Linux sandbox each Thread works in. This skill makes a Project's Orbs ready to work the moment they start: it writes the Project's scripts, tests them in the current Orb, and saves them to the Project in dx. The request is often one line, such as "Set up Orbs for this project"; read everything else from the repository.

The goal: in a fresh Orb, once `setup` has run, the agent can install, build, test, and run the project without doing anything by hand.

## How dx runs a Project's scripts

dx keeps the scripts with the Project, not in the repository, and runs them in the Orb of every Thread in it. dx ignores `.agents/setup`, `.agents/resume`, and `.agents/desktop/resume` in a repository (it copied them into the Project once where they existed), so do not write or commit them.

| Script | Runs | From | Use it to |
|---|---|---|---|
| `setup` | Once, when dx prepares a new Orb, before the agent's first turn | Repository root | Install toolchains and dependencies, start and seed databases |
| `resume` | Every time the Orb starts or wakes, run by the workspace daemon | Repository root | Sign in, reconnect, or repair; quick and safe to repeat |
| `pre-clone` | Before dx clones the repository; a failure stops the Orb before the clone | `/home/user/workspace` | Rarely: prepare something the clone itself needs |
| `desktop-resume` | Every time the Desktop starts | Repository root | Open the app with `/opt/dx/desktop/chromium <url>` |

What to plan around:

- Each Thread starts a new Orb from dx's base image, so `setup` runs for every new Thread and that Thread's first turn waits for it. Keep it under 2 minutes; dx stops it at 5. A failed `setup` is logged and the Thread still starts.
- dx stops `resume` after 120 seconds and never waits for it, and a daemon restart runs it again. Install nothing in it.
- dx copies each script into its own state directory before running it, so `$0` and `BASH_SOURCE` point there, not into the repository. Use the working directory (`$PWD`), which is the repository root.
- A script with no `#!` line runs in Bash. Each script holds at most 32 KB.
- Scripts run as `user`, who has passwordless `sudo`. `setup` gets only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, and `GIT_TERMINAL_PROMPT=0`: no GitHub token and none of the Project's environment variables or secrets. So `setup` installs clients and `resume` signs them in; `resume` receives the Project's variables.
- Output goes to `~/.cache/dx/logs/<script>.log`, replaced on each run. The exit code alone decides success.
- Everyone who can open the Project can read its scripts. Put tokens and keys in the Project's environment variables and secrets, never in a script.
- The base image is Debian with Node.js 24 and corepack (pnpm, yarn), OpenJDK 21, Python 3 with pip and venv, `build-essential`, git, git-lfs, the GitHub CLI, ripgrep, jq, curl, wget, tmux, and Chromium. Orbs from older images can miss some, so confirm with `command -v`.

## Reading and saving scripts

Use `manage_dx` with topic `project_scripts`; `project_id` defaults to this Thread's Project. Changes apply at once, with no card.

- `list`: which scripts exist, their size and last change, and `canManage` (whether this person may change them).
- `read`, with `name` set to a script such as `setup`: its text.
- `set`, with `name` and `value`: replaces the whole script. A blank `value` removes it.
- `delete`, with `name`: removes it.

Only the Project's creator or a workspace admin can save, and only in turns the Thread's owner wrote. If `canManage` is false or `set` is refused, keep the tested script out of the repository and give it to the person, saying who can save it (**Project Settings → Orb → Orb Scripts**, or a Thread of their own).

Saved `setup` runs in new Orbs. A running Orb uses the new `resume` or `desktop-resume` the next time it starts, wakes, or opens the Desktop.

## Steps

### 1. Start from what exists

`list` the Project's scripts and `read` each one. Change what is there instead of starting over, and keep any step you cannot test.

### 2. Take stock of the project

Find out what a clean machine needs to work on this repository:

- Languages, package managers, and lockfiles: `package.json` with its lockfile, `pyproject.toml` or `requirements*.txt`, `go.mod`, `Cargo.toml`, `Gemfile`, `pom.xml`, and the like.
- Version pins: `.nvmrc`, `.tool-versions`, `mise.toml`, `rust-toolchain.toml`, `go.mod`'s `go` line, the `packageManager` field, versions in CI.
- Services the tests or app expect, such as Postgres, Redis, or a queue, and example env files like `.env.example`.
- Development shells (Nix, devenv, direnv) and what they export.
- How the project is already built: CI workflows first, since they install everything from scratch, then README, CONTRIBUTING, AGENTS.md, and any old `.agents/*` files.

Write down the commands that show the project works: install, build, and the fast tests, the way CI runs them. Check every tool those commands call with `command -v` and compare its version with the pins. `setup` installs what is missing or at the wrong version, and nothing more.

### 3. Write `setup`

Draft scripts outside the repository, for example in `~/.dx/work/orb-setup/`, so none of them can be committed. Start with `#!/usr/bin/env bash` and `set -euo pipefail`, then:

- Install system packages with `sudo apt-get install -y`, checking first (`dpkg -s`, `command -v`) so a second run skips `apt-get update`.
- Install pinned toolchains, such as `corepack enable`, `mise install`, or an official release tarball of the pinned version.
- When a later line needs a tool that an installer just added, extend `PATH` or source the installer's env file in the script; the installer cannot change the running script's environment.
- Install dependencies the way CI does, from the lockfile (`npm ci`, `pnpm install --frozen-lockfile`, `uv sync`, `go mod download`).
- Start and seed databases the tests need, configured for speed over safety (for Postgres, `fsync = off` and `synchronous_commit = off`).
- Copy env templates only when the target is missing: `[ -f .env ] || cp -- .env.example .env`.
- Print a line before each slow step and its duration after, so the log shows where time went.

Running `setup` again must give the same result: no duplicate config lines, no reseeding over existing data, no failure because something already exists. Every command must end. Leave out dev servers, watchers, and prompts, because `setup` has to exit before the Thread starts; declare servers in `.dx/services.yaml` (step 6).

### 4. Make tools reachable from later shells

The agent's commands and dx services run later in fresh login shells, so a tool `setup` installed must be on their `PATH` too, together with any variables it needs. Choose the simplest option that works:

- Put the binary or a symlink in `/usr/local/bin`, which every shell has on `PATH`.
- Otherwise add one guarded block to `~/.bash_profile` that `setup` writes only once. For example, for a Go install:

  ```bash
  marker="# orb-setup: go toolchain"
  grep -Fqx "$marker" "$HOME/.bash_profile" 2>/dev/null || printf '\n%s\nexport PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"\n' "$marker" >> "$HOME/.bash_profile"
  ```

- For a development shell such as Nix, export its environment in that block (with `nix print-dev-env`) instead of starting a nested shell. Guard the block so it runs only in the repository and never inside itself.

### 5. Write `resume` when the project needs one

Many projects need none; libraries usually do not. Write it when something must happen on every start: sign in a CLI with the Project's variables, restart or check a database, refresh a tunnel. Use the same first two lines as `setup`, keep every step in the foreground so failures reach the log, and finish within about 10 seconds.

Write `pre-clone` or `desktop-resume` only when asked or when the repository clearly calls for one.

### 6. Declare dev servers in `.dx/services.yaml`

When the person will keep using a dev server, declare it in the repository so dx can start it again after the Orb wakes:

```yaml
services:
  web:
    command: pnpm dev --host 127.0.0.1 --port $PORT
    port: 5173
    cwd: apps/web
```

The command must listen on `$PORT`. With Portals on, dx starts a stopped service when its Portal is opened. A Vite server also needs the Portal domain in `server.allowedHosts`.

### 7. Prove it in this Orb

Run every script here before saving it. The work is done when all of these hold:

- `setup` succeeds in the bare environment dx gives it, which catches any reliance on your shell or the Project's variables: `env -i HOME="$HOME" USER=user LOGNAME=user SHELL=/bin/bash PATH="$PATH" GIT_TERMINAL_PROMPT=0 bash ~/.dx/work/orb-setup/setup`, from the repository root.
- A second, timed run of the same command finishes quickly and downloads nothing new. The first run takes under 2 minutes.
- `resume`, if written, succeeds twice in a row within seconds.
- The commands from step 2 pass in a fresh login shell from the repository root: `env -i HOME="$HOME" PATH=/usr/bin:/bin /bin/bash -lc '<command>'`. If one fails for a reason no environment can fix, such as a test that also fails on the default branch or a secret the Project lacks, say so in the report.

Check the environment by starting that fresh shell, not by sourcing changes into the current one, which hides whether a later shell gets them. Print only the variables and `command -v` paths you expect; the full environment can hold secrets.

For an existing setup that is slow or failing, read `~/.cache/dx/logs` first and time each command before adding caching.

### 8. Save and report

- `set` each tested script, then `read` it back.
- Commit `.dx/services.yaml` if you added it, asking first unless the person asked for it.
- Tell the person which scripts you saved, what the project needed, and that new Orbs in the Project run them.

## Examples

- "Set up Orbs for this project"
- "Why does the agent have to install Go in every new Thread?"
- "Add a resume script that signs in to our private registry"
- "Make the dev server come back after the Orb wakes"
