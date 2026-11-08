# dx toolbelt

Everything dx adds to an Orb that it ships prebuilt, built once and installed
unchanged on every Orb provider. [`../install.sh`](../install.sh) installs it
in the OCI image (E2B, Cloudflare Containers, Docker Cloud Sandboxes) and on
Boat and Freestyle machines, so the Terminal's tmux and the Desktop are the
same files on all of them, whatever Linux the provider boots.

## What it is

One tarball, `dx-toolbelt.tar.zst`, holding `/opt/dx` and the Nix store paths
it refers to:

- `/opt/dx/bin/tmux`: tmux's own static build (3.7c), the Terminal's server
  and every client.
- `/opt/dx/desktop/`: the Desktop scripts from [`../desktop`](../desktop) and
  `env`, a link to the programs they run: Tembo's voxl streamer (0.3.4) and
  its patched Xvfb, openbox, xterm, Chromium, dbus, fonts, and the shell
  tools the scripts use.
- `/opt/dx/bin/dx-orb-check`: proves an Orb has every workspace feature
  (below).

Every program comes from [nixpkgs](https://github.com/NixOS/nixpkgs) at the
revision [`flake.lock`](flake.lock) pins, with its own glibc and libraries,
and never loads the host's: it runs on any x86-64 Linux kernel. A Desktop
started from the toolbelt maps no shared library from outside `/nix/store`,
on Debian 12 and 13, Ubuntu 22.04 and 24.04, Fedora 43, Rocky Linux 9, Arch
Linux, and Alpine (no glibc at all); `internal/orb-toolbelt/chroot-check.sh`
proves it on any distribution's official image.

The Desktop scripts keep the toolbelt to themselves: they call its programs
by path ([`desktop/env.sh`](../desktop/env.sh)) and start what the person and
the agent use on the desktop (openbox's menu, the terminal, Chromium,
resume scripts) with the host's `PATH`, so a terminal on the desktop runs the
Orb's own tools.

## Build and publish

```sh
deploy/orb/toolbelt/pack.sh <out-dir>   # needs Nix with flakes
```

`pack.sh` builds the flake, writes the tree and its store paths as one tar
with sorted names, fixed times, and owner 0, compresses it with zstd (four
workers, so any machine gets the same bytes), and prints its
`dx-toolbelt.json`: `version` (the first 16 hex of the tar's SHA-256),
`sha256` (the tarball's), and `contentSha256` (the tar's). Building the same
commit again reproduces both, with the Nix release
[`orb-toolbelt.yml`](../../../.github/workflows/orb-toolbelt.yml) installs:
voxl's binary keeps the directory it was built in, and newer Nix releases
name that directory randomly, so their build differs.

[`toolbelt.json`](toolbelt.json) and `TOOLBELT_VERSION`/`TOOLBELT_SHA256` in
[`../install.sh`](../install.sh) pin the published toolbelt.
[`orb-toolbelt.yml`](../../../.github/workflows/orb-toolbelt.yml) runs on main
when the toolbelt changes: it rebuilds it, fails unless the result is the
pinned toolbelt byte for byte, and publishes it
([`orb-toolbelt.mjs`](../../../internal/release/orb-toolbelt.mjs)):

1. the release `orb-toolbelt-<version>` on
   [dxcode-dev/dxcode](https://github.com/dxcode-dev/dxcode/releases), with
   the tarball, `dx-toolbelt.json`, and the flake that rebuilds it;
2. its mirror on Docker Hub, `docker.io/dxcodedev/dx-toolbelt:<version>`, an
   OCI artifact whose one blob is the same tarball.

`install.sh` downloads from GitHub first and then from Docker Hub by the
blob's digest (an anonymous pull token, no Docker needed), and keeps only a
file with the pinned SHA-256. Docker Hub allows 100 anonymous pulls per IP in
6 hours; dx pulls once per image or snapshot build, not once per Orb.

To change the toolbelt: edit it, run `pack.sh`, put the new `version`,
`sha256`, and `contentSha256` in `toolbelt.json` and the two `TOOLBELT_*`
lines in `install.sh`, and check it with the scripts below. A new pin changes
the Orb image's recipe and every VM recipe, so providers prepare new images
and snapshots; Threads keep the ones they pinned.

## dx-orb-check

`/opt/dx/bin/dx-orb-check` runs as `user` with dxd's environment and checks,
one line each:

- the account and passwordless sudo;
- git, git-lfs, gh 2.40 or later, Node.js 24 or later with npm and corepack,
  Python, Java, ripgrep, jq, and Claude Code;
- the Terminal's tmux, also first on `PATH`;
- dx's login hook, entrypoint, and tmux configuration;
- the Desktop end to end: it starts it, receives H.264 frames with a
  keyframe from voxl's `/ws` as the web viewer does (acking each frame),
  takes voxl's screenshot of the display, and takes a Chromium screenshot
  over DevTools. A Desktop it started is stopped again.

It ends with a JSON summary and exits 1 when anything fails. Each provider's
preparation runs it on its test Orb
([`orb-check.ts`](../../../apps/core/src/execution/guest/orb-check.ts)): Boat,
Freestyle, Docker Cloud Sandboxes, and Cloudflare Containers in a person's
own account. An Orb that misses a feature fails preparation with the
features it lacks, so it never reaches a Thread.

## Proving a change

- `internal/orb-toolbelt/chroot-check.sh <image> <tarball> <out>`: the
  Desktop alone from the toolbelt on a distribution's root filesystem, with
  the libraries every Desktop process mapped.
- `internal/orb-toolbelt/install-check.sh <image> <out> [<tarball> <json>]`:
  `install.sh` on a distribution's root filesystem, then `dx-orb-check`.

Both need root, mount, and [crane](https://github.com/google/go-containerregistry).
