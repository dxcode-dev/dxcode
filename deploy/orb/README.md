# dx Orb image

The standard workspace image for every x86 Orb provider: E2B and Cloudflare
Containers
([What phase 4d shipped](../../wiki/plugin-platform-direction.md#what-phase-4d-shipped)).
E2B builds its template from this same Dockerfile
([`deploy/e2b/template.mjs`](../e2b/template.mjs)), and the Cloudflare
Containers Orb Worker ([`containers.mjs`](containers.mjs)) builds it as its
named image `orb`, so both providers run the same filesystem.

## Build

From the repository root (the context; `Dockerfile.dockerignore` admits only
the two copied files):

```sh
docker build --platform linux/amd64 -f deploy/orb/Dockerfile -t dx-orb .
```

The image must stay `linux/amd64` and fit the smallest instance disk of every
provider that uses it. It is about 1.6 GB unpacked.

## Contents

- Debian 13 slim (pinned by digest), the `user` account (uid 1000) with
  passwordless `sudo`, home `/home/user`.
- Node.js 24 LTS from nodejs.org with corepack (yarn, pnpm), OpenJDK 21,
  Python 3 with pip and venv, `build-essential` and common `-dev` headers,
  git, git-lfs, GitHub CLI (from GitHub's repository: Core's source runtime
  needs gh 2.40 or later), ripgrep, jq, tmux, curl, wget, zip, and procps.
- This covers what E2B's `base` image and the earlier dx template added
  (systemd, sudo, ripgrep, jq, ca-certificates, tmux, python3, and the login
  hook), except systemd itself: E2B provisions its own init.

## dxd from the entrypoint

Containers do not boot systemd, so dxd no longer runs as a systemd unit on
this image. [`dx-orb-init`](dx-orb-init) is the entrypoint (under `tini` in a
container; E2B runs it as the template start command, and its snapshot keeps
it running in every sandbox). It drops to `user`, waits until Core's
installer has put the dxd binary and configuration under
`~/.local/state/dxd/`, starts dxd with the environment the systemd unit gave
it, records its PID in `dxd.pid`, and restarts it when it exits (0.5 s, then
backing off to 30 s while it keeps failing). dxd updates itself by `exec`, so
a self-update keeps its PID. Output goes to `~/.local/state/dxd/dxd.log`,
rotated once it passes 1 MiB at a restart.

The image carries the root-owned pieces the installer used to write with
`sudo`: the login hook `/etc/profile.d/dx-terminal.sh` and the
`/usr/local/bin/dxd` link. Core's installer
([`daemon-installer.ts`](../../apps/core/src/execution/e2b/daemon-installer.ts))
detects `/usr/local/bin/dx-orb-init` and then installs no unit and needs no
root: it wakes the entrypoint with `SIGUSR1` (or starts it if something
killed it), nudges a running dxd with `SIGHUP`, and restarts an incompatible
one with `SIGTERM`. Guests built from older templates keep the systemd path.

A Core from before this image (for example after a rollback) installs dxd as
a systemd unit. The entrypoint stands down while
`/etc/systemd/system/dxd.service` exists, and the current installer treats
such a guest as a systemd guest, so dxd never runs twice. E2B provisions
systemd itself; a plain container has none, so only the entrypoint path
works there.

## Cloudflare Containers

[`containers.mjs`](containers.mjs) deploys the Orb Worker
(`apps/core/src/execution/cloudflare/orb-worker.ts`) with `wrangler deploy`
(the pinned `wrangler-containers` 4.147 alias; earlier releases do not know
the `durable_object` scheduling policy). Wrangler builds this Dockerfile with
the repository root as context, pushes it to the account's Cloudflare
registry, waits until Cloudflare has prepared it, and creates the container
application for the `OrbContainerObject` class. Docker must be running on the
deploying machine. The image is about 1.6 GB, so it does not fit the `lite`
instance type; Orb sizes start at `standard-1`.

The entrypoint runs unchanged: a container restored from a snapshot runs
`dx-orb-init` again, which restarts dxd from the binary and configuration
the snapshot kept. Core runs commands with `ctx.container.exec()` as the
image user, so the container serves nothing for them.

Snapshots are stored beside the image in the same registry repository
(`rootfs-snapshot-*` tags) and are tied to the image version: keep an old
image while any Thread's snapshot still refers to it.

## Publishing

The image is not yet published. The intended reference is
`ghcr.io/dxcode-dev/dx-orb:<version>`; publishing it publicly is an
owner/ops step (see the release tracker).
