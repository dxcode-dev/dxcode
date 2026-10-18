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
the files copied into the image):

```sh
docker build --platform linux/amd64 -f deploy/orb/Dockerfile -t dx-orb .
```

The image must stay `linux/amd64` and fit the smallest instance disk of every
provider that uses it. It is about 2.4 GB unpacked, 0.9 GB of it the Desktop.

## Contents

- Debian 13 slim (pinned by digest), the `user` account (uid 1000) with
  passwordless `sudo`, home `/home/user`.
- Node.js 24 LTS from nodejs.org with corepack (yarn, pnpm), OpenJDK 21,
  Python 3 with pip and venv, `build-essential` and common `-dev` headers,
  git, git-lfs, GitHub CLI (from GitHub's repository: Core's source runtime
  needs gh 2.40 or later), ripgrep, jq, curl, wget, zip, and procps.
- tmux 3.7c for the Terminal (below), also `tmux` on `PATH`.
- The Desktop (below): headless labwc, Xwayland, foot, Chromium, and Waymote.
- This covers what E2B's `base` image and the earlier dx template added
  (systemd, sudo, ripgrep, jq, ca-certificates, tmux, python3, and the login
  hook), except systemd itself: E2B provisions its own init.

## Terminal tmux

The browser's Terminal tab is tmux session `main` on socket `dx`, shared by
the person and the agent
([Resident Terminal](../../wiki/runtime-architecture.md#resident-terminal)).
The image carries it prebuilt; nothing is compiled at build, deploy, or
sandbox time:

- `/opt/dx/bin/tmux`: tmux's own static musl build from
  [tmux/tmux-builds](https://github.com/tmux/tmux-builds) `v3.7c`
  (`tmux-3.7c-linux-x86_64.tar.gz`, SHA-256
  `cc56bd1cc873eb6089c615f0496b072385bda8a6d944069f38564a5d49c128aa`), linked
  as `/usr/local/bin/tmux` in place of Debian's so every client matches the
  server. Its license texts are in `/opt/dx/share/licenses/tmux/`
  ([notices](../../THIRD_PARTY_NOTICES.md#tmux-orb-image-terminal)).
- `/opt/dx/share/tmux.conf` ([`tmux.conf`](tmux.conf)): true color, extended
  keys, OSC 52 clipboard, and focus events for ghostty-web; `escape-time 0`,
  10,000 lines of history, mouse scrolling of tmux history; the session never
  ends with its clients. The status line keeps the terminal's own colors, so
  the dx terminal theme applies, and has no clock, so an idle Terminal sends
  no output. Keys are tmux's defaults.

dxd starts the session from its PTY when the Terminal opens and tmux runs the
server as a daemon, outside dxd and outside `dx-orb-init`, so restarting or
updating dxd leaves the shells running. A container restart ends them. To
move to another tmux release, change the URL and checksum here, in the
Dockerfile, and in the dxd CI workflow (`.github/workflows/dxd.yml`), whose
Terminal tests run against the same binary.

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
([`daemon-installer.ts`](../../apps/core/src/execution/guest/daemon-installer.ts))
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

## Desktop

The Thread's Desktop tab streams a Linux desktop with Chromium from the
sandbox. Everything lives under `/opt/dx/desktop` (sources in
[`desktop/`](desktop)):

- `start` starts the session and returns once the Waymote gateway serves on
  `127.0.0.1:5900`; it exits 0 at once when the gateway already answers.
  dxd runs it as `user` with only `HOME USER LOGNAME SHELL LANG PATH` set. The
  session runs detached (`setsid`, its own session and process group, lock
  descriptor closed), so it survives the caller and dxd; `start` keeps no
  descriptor open. It takes a lock so concurrent calls start one session.
  While the recorded session's labwc and session script run, `start` waits
  for its gateway (the session restarts a crashed gateway after 1 to 30 s)
  rather than replacing it and closing the person's and the agent's windows;
  it replaces only a session that died or failed. Every wait (the lock,
  `stop`, the gateway) uses what is left of 40 s, so `start` finishes within
  that with one line on stderr on failure (dx Core allows 45 s), and a
  session that dies during startup fails at once with the reason from
  `session.log`. Run from inside the desktop (its terminal), `start` and
  `stop` continue in a session of their own, so replacing or stopping the
  desktop does not end them halfway.
- `stop` ends the session: Chromium's browser gets `TERM` first, then every
  process gets `TERM`, then `KILL` (8.5 s at most, or the seconds given as
  its argument). It finds the processes by session ID, by the
  `DX_DESKTOP_SESSION` marker every desktop program inherits, which reaches
  what labwc launches from its menu (labwc runs those in sessions of their
  own), and by the desktop's Chromium profile in the command line, which
  reaches Chromium opened by `chromium` from a dxd shell (Chromium overwrites
  its environment with its process title).
- `session` (under `dbus-run-session`) runs headless labwc
  (`WLR_BACKENDS=headless`, pixman renderer, one output at 1280x720@30Hz that
  the viewer resizes), Xwayland on demand, a foot terminal, Chromium
  (`chromium`), and `waymote-gateway -listen 127.0.0.1:5900 -bitrate 4000
  -frame-rate 30`, which it restarts when it exits. The session ends when
  labwc exits; the next `start` begins a new one.
- `chromium` opens Chromium with DevTools on `127.0.0.1:9222` and a profile in
  the state directory, so an agent in the sandbox drives the browser the user
  watches. Run it with a URL to open a window in the running browser; it
  returns at once, with Chromium detached and marked for `stop`. Where
  unprivileged user namespaces are missing (a plain Docker container) it adds
  `--no-sandbox`.
- `bin/ffmpeg` keeps the encoder's RTP sockets on loopback; nothing in the
  session listens on another address.
- State and logs: `~/.local/state/dx-desktop/` (`session.log`,
  `waymote.log`, `chromium.log`, `foot.log`, the Chromium profile, and
  `environment`, which a program sources to open windows on the desktop).

Waymote has no authentication; the gateway listens on loopback only and the
browser reaches it through dx Core's Thread route, which relays through dxd.
Before opening its sockets the viewer asks Core's status check
(`GET /v1/threads/:threadId/desktop`), which runs `start` through dxd and
fetches the gateway's `/healthz`; a guest without `/opt/dx/desktop/start`
answers that the workspace has no Desktop.
The gateway rejects a WebSocket whose `Origin` names another host than its
`Host`, so the relay sends no `Origin`. The session has no audio: the gateway
runs its Opus encoder whenever an audio source is set, viewer or not, and that
path cost 2 to 3 % of a core while idle; the video path costs nothing while
the screen does not change.

Pinned inputs: Waymote 0.1.6 server release (MIT), and labwc 0.9.7 with
wlroots 0.19.3, libxml2-16 2.14.6, libsfdo0 0.1.4, and libdisplay-info3 0.3.0
from snapshot.debian.org. wlroots must be 0.19.3 or later: earlier 0.19
releases give a virtual pointer's axis source to one axis only, so a diagonal
(trackpad) scroll from the viewer aborts labwc and the session restarts.
Chromium runs with `--enable-unsafe-swiftshader`: without a GPU it otherwise
blocklists WebGL instead of using its software renderer. Debian 13's labwc 0.8.3 uses wlroots 0.18, which lacks
`ext-data-control-v1`, Waymote's clipboard protocol. These builds upgrade no
Debian 13 package and receive no Debian security updates; their sources are on
snapshot.debian.org (labwc is GPL-2.0, wlroots MIT). Everything else comes
from Debian 13. Measurements and the verification procedure:
[`artifacts/desktop-image-verification`](../../artifacts/desktop-image-verification/README.md).

## Cloudflare Containers

[`containers.mjs`](containers.mjs) deploys the Orb Worker
(`apps/core/src/execution/cloudflare/orb-worker.ts`) with `wrangler deploy`
(the pinned `wrangler-containers` 4.147 alias; earlier releases do not know
the `durable_object` scheduling policy). Wrangler builds this Dockerfile with
the repository root as context, pushes it to the account's Cloudflare
registry, waits until Cloudflare has prepared it, and creates the container
application for the `OrbContainerObject` class. Docker must be running on the
deploying machine, with Buildx; both are checked before anything changes.
Docker runs with a configuration of its own under the stage directory
(`orbDockerEnvironment`): an API-token deploy points HOME at a private
directory, so Docker keeps the operator's plugins and selected context from
their own configuration, read only, and stores the registry login in that
file instead of the OS keychain. The image is about 2.4 GB, so it does not fit the `lite`
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
