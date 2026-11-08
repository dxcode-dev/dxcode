# dx Orb image

The standard workspace on every Orb provider. One installer,
[`install.sh`](install.sh), makes it, so every provider gets the same Orb:

- **OCI image providers** (E2B, Cloudflare Containers, Docker Cloud
  Sandboxes) boot the image this [`Dockerfile`](Dockerfile) builds by running
  `install.sh --image`. E2B builds its template from the same Dockerfile
  ([`deploy/e2b/template.mjs`](../e2b/template.mjs)), and the Cloudflare
  Containers Orb Worker ([`containers.mjs`](containers.mjs)) builds it as its
  named image `orb`.
- **Providers that boot their own Linux** (Boat, Freestyle) run
  `install.sh --vm` in a fresh machine through Core's VM Orb recipe
  ([`vm-orb-recipe.ts`](../../apps/core/src/execution/guest/vm-orb-recipe.ts))
  and snapshot it. A systemd unit starts `dx-orb-init` where systemd is PID 1;
  elsewhere it runs in the background under `tini`.

`install.sh` installs the base packages from the distribution (apt: Debian
and Ubuntu), Node.js and the GitHub CLI from their own pinned releases, the
`user` account, the **dx toolbelt**, dx's login hooks and entrypoint, and
Claude Code. The toolbelt ([`toolbelt/`](toolbelt/README.md)) is everything
dx ships prebuilt: the Terminal's tmux, the Desktop (Xvfb, openbox,
Chromium, and Tembo's voxl streamer), and `dx-orb-check`. It is built once with Nix, each
program carrying its own glibc and libraries, so it runs unchanged on any
x86-64 Linux; only the base packages come from the provider's distribution.
Each provider's preparation runs `dx-orb-check` on a test Orb, so an Orb
missing a feature never reaches a Thread.

## Build

From the repository root (the context; `Dockerfile.dockerignore` admits only
the files copied into the image):

```sh
docker build --platform linux/amd64 -f deploy/orb/Dockerfile -t dx-orb .
```

The image must stay `linux/amd64` and fit the smallest instance disk of every
provider that uses it. The toolbelt is 1.9 GB unpacked (0.56 GB compressed),
most of it Chromium and its libraries.

## Contents

- Debian 13 slim (pinned by digest) in the image; the provider's own Debian
  or Ubuntu on Boat and Freestyle. The `user` account (uid 1000 where it is
  free) with passwordless `sudo`, home `/home/user`.
- Node.js 24 LTS from nodejs.org with corepack (yarn, pnpm), OpenJDK, Python 3
  with pip and venv, `build-essential` and common `-dev` headers, git,
  git-lfs, the GitHub CLI 2.103.3 from its own release (Core's source runtime
  needs gh 2.40 or later), ripgrep, jq, curl, wget, zip, and procps.
- The dx toolbelt in `/opt/dx`: tmux 3.7c for the Terminal (below), also
  `tmux` on `PATH`; the Desktop (below); `dx-orb-check`.
- This covers what E2B's `base` image and the earlier dx template added
  (systemd, sudo, ripgrep, jq, ca-certificates, tmux, python3, and the login
  hook), except systemd itself: E2B provisions its own init.

## Terminal tmux

The browser's Terminal tab is tmux session `main` on socket `dx`, shared by
the person and the agent
([Resident Terminal](../../wiki/runtime-architecture.md#resident-terminal)).
The toolbelt carries it prebuilt; nothing is compiled at build, deploy, or
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
toolbelt's [`flake.nix`](toolbelt/flake.nix), and in the dxd CI workflow
(`.github/workflows/dxd.yml`), whose Terminal tests run against the same
binary.

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

Cloudflare Containers start every process at an open-file hard limit of
1024; E2B starts commands at 524288. That is too low for Chromium: it keeps a
few hundred descriptors per page load until its next garbage collection, so
a tab that reloads a large app crashes or stops loading within a few loads
(#1681). The login hook
[`/etc/profile.d/dx-orb-open-files.sh`](dx-orb-open-files.sh) raises a
login shell's hard limit to 524288 with `ulimit`, which the runtime's
`CAP_SYS_RESOURCE` (already in the image user's capability sets) allows,
falling back to passwordless `sudo` where a host withholds it; Core runs
every Orb command, agent runs included, as `bash -l`, and `dx-orb-init`
sources the hook before it starts dxd, so the Terminal, services, and the
Desktop inherit the same limit. The soft limit stays at 1024; programs that
need more raise it themselves.

A Core from before this image (for example after a rollback) installs dxd as
a systemd unit. The entrypoint stands down while
`/etc/systemd/system/dxd.service` exists, and the current installer treats
such a guest as a systemd guest, so dxd never runs twice. E2B provisions
systemd itself; a plain container has none, so only the entrypoint path
works there.

## Desktop

The Thread's Desktop tab streams a Linux desktop with Chromium from the
sandbox. Everything lives under `/opt/dx/desktop`, from the toolbelt
(sources in [`desktop/`](desktop)). The scripts run the toolbelt's programs
by path (`env/bin`, [`desktop/env.sh`](desktop/env.sh)) and start what the
person and the agent use on the desktop with the host's `PATH`:

- `start` starts the session and returns once the voxl streamer serves on
  `127.0.0.1:5900`; it exits 0 at once when it already answers `/healthz`.
  dxd runs it as `user` with only `HOME USER LOGNAME SHELL LANG PATH` set. The
  session runs detached (`setsid`, its own session and process group, lock
  descriptor closed), so it survives the caller and dxd; `start` keeps no
  descriptor open. It takes a lock so concurrent calls start one session.
  While the recorded session's Xvfb and session script run, `start` waits
  for its streamer (the session restarts a crashed voxl after 1 to 30 s)
  rather than replacing it and closing the person's and the agent's windows;
  it replaces only a session that died or failed. Every wait (the lock,
  `stop`, the streamer) uses what is left of 40 s, so `start` finishes within
  that with one line on stderr on failure (dx Core allows 45 s), and a
  session that dies during startup fails at once with the reason from
  `session.log`. Run from inside the desktop (its terminal), `start` and
  `stop` continue in a session of their own, so replacing or stopping the
  desktop does not end them halfway.
- `stop` ends the session: Chromium's browser gets `TERM` first, then every
  process gets `TERM`, then `KILL` (8.5 s at most, or the seconds given as
  its argument). It finds the processes by session ID, by the
  `DX_DESKTOP_SESSION` marker every desktop program inherits, which reaches
  what openbox launches from its menu, and by the desktop's Chromium profile
  in the command line, which reaches Chromium opened by `chromium` from a dxd
  shell (Chromium overwrites its environment with its process title). It
  then frees the stopped Xvfb's screen, a shared-memory segment that outlives
  a killed X server.
- `session` (under `dbus-run-session` with [`dbus-session.conf`](desktop/dbus-session.conf),
  a bus that starts none of the host's services) runs Xvfb (a free display
  number, a 3840x2160 screen that voxl shrinks to the viewer's pane with
  RandR, `-shmem`), the openbox window manager ([`openbox/`](desktop/openbox):
  one workspace, a right-click menu with Terminal and Chromium), an xterm,
  Chromium (`chromium`), and voxl on `127.0.0.1:5900`, which it restarts
  when it exits. The session ends when Xvfb exits; the next `start` begins a
  new one.
- `resume` runs when the session starts, in place of the session's own
  Chromium window: the repository's executable `.agents/desktop/resume`, or
  else the project's Desktop Resume script from Project Settings, which
  source preparation keeps at
  `~/.local/state/dx/project-scripts/desktop-resume` (a symlink at either
  path is ignored). It runs from `~/workspace/repo` with the desktop's
  environment, logs to `desktop-resume.log`, and what it starts stays in the
  session. Without a script, or when the script exits non-zero, it opens
  Chromium at `about:blank` as before.
- `chromium` opens Chromium on X11 with DevTools on `127.0.0.1:9222` and a
  profile in the state directory, so an agent in the sandbox drives the
  browser the user watches. Run it with a URL to open a window in the
  running browser; it returns at once, with Chromium detached and marked for
  `stop`. It first removes a profile lock no running Chromium holds: an Orb
  resumed from a disk snapshot can run on another machine (Boat), and
  Chromium refuses a profile locked "on another computer". Where
  unprivileged user namespaces are missing (a plain Docker container) it adds
  `--no-sandbox`. Ubuntu 24.04 grants them only to programs with an AppArmor
  profile, so `install.sh` gives the toolbelt's Chromium one there.
- State and logs: `~/.local/state/dx-desktop/` (`session.log`, `xvfb.log`,
  `voxl.log`, `openbox.log`, `chromium.log`, `xterm.log`, `desktop-resume.log`,
  the Chromium profile, and `environment`, which a program sources to open
  windows on the desktop).

voxl ([tembo/voxl](https://github.com/tembo/voxl), MIT) streams the display
as H.264 over one WebSocket, `/ws`, which the browser decodes with
WebCodecs. It captures straight from Xvfb's framebuffer, a shared-memory
segment it finds by the X server's pid in `/tmp/.X<n>-lock`; this Xvfb build
writes no lock file, so `session` writes it, or voxl could stream a segment
an earlier Xvfb left behind. It runs with `--enable-basic-auth=false`,
listens on loopback only, and the browser reaches it through dx Core's
Thread route, which relays through dxd (the relay sends no `Origin`). It
runs at 60 fps with an 8 Mbit/s ceiling, has no audio, no file transfer, and
the clipboard on. Before opening its socket the viewer asks Core's status
check (`GET /v1/threads/:threadId/desktop`), which runs `start` through dxd
and fetches voxl's `/healthz`; a guest without `/opt/dx/desktop/start`
answers that the workspace has no Desktop. The child Thread's benchmark
against Waymote, the earlier streamer: 60 fps at 28 to 34 ms median latency
on a 2 vCPU Orb at 1280x720, against Waymote's 30 fps at 145 ms
([`artifacts/desktop-bench`](../../artifacts/desktop-bench) on branch
`exp/desktop-bench`).

Pinned inputs, all in the toolbelt ([`toolbelt/flake.nix`](toolbelt/flake.nix),
nixpkgs `nixos-26.05` and voxl at the revisions `flake.lock` pins): voxl
0.3.4 and its patched Xvfb (xorg-server 21.1.24 whose XTEST pointer has
scroll axes, for smooth scrolling), openbox, xterm, Chromium, dbus, the X
core fonts Xvfb needs, and DejaVu and Liberation fonts (plus the host's).
Chromium runs with `--enable-unsafe-swiftshader`: without a GPU it otherwise
blocklists WebGL instead of using its software renderer. A new nixpkgs or
voxl revision brings fixes; rebuild and repin the toolbelt
([`toolbelt/README.md`](toolbelt/README.md)).

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
file instead of the OS keychain. The image is several GB, so it does not fit the `lite`
instance type; Orb sizes start at `standard-1`.

Branch previews share their images instead (`recipeOrbImage`): the
first preview with a new image recipe (this Dockerfile, its ignore file, and
the files it copies) builds and pushes it once to the `dx-preview-orb-image`
repository, tagged with the recipe's hash, and every preview stage pins
that digest, so a new stage skips the build, the push, and Cloudflare's
preparation (about 4 of a new stage's 8 minutes). If that fails, Wrangler
builds the stage's own image as above. The recipe hash fails closed: an
`ADD`, `ARG`, `ONBUILD`, second `FROM`, `COPY --from`, wildcard, or copied
directory makes that preview build its own image. A stage's destroy leaves
the shared repository alone; its Threads' snapshots there expire with
Cloudflare's 30-day TTL, and Preview cleanup
([`prune-preview-orb-images.mjs`](../../scripts/prune-preview-orb-images.mjs))
deletes shared images older than 7 days that no Worker's active deployment
pins.

Staging does the same in a repository of its own
(`orbWorkerImageRepository`, `<Orb Worker name>-orb-image`): it builds and
pushes the image once per image recipe and pins it by digest, so a deploy
that changes only the Orb Worker skips the build, the push, and Cloudflare's
preparation. Staging never reuses a preview's image, and nothing prunes its
repository, so its Threads' snapshots keep the older images they were taken
on.

Docker Cloud Sandboxes and Cloudflare connections in a person's own account
boot only a public image, and the released one (`public-image.json`) can
predate the branch. So after each deploy the preview workflow copies the
recipe's shared image to Docker Hub as
`dxcodedev/dx-orb:preview-<recipe hash>`
([`mirror-preview-orb-image.mjs`](../../scripts/mirror-preview-orb-image.mjs),
once per recipe), and a branch preview's Core boots that image for those two
connections (`DX_PREVIEW_ORB_IMAGE`). Staging, production, and self-hosted
deployments boot the released image.

The entrypoint runs unchanged: a container restored from a snapshot runs
`dx-orb-init` again, which restarts dxd from the binary and configuration
the snapshot kept. Core runs commands with `ctx.container.exec()` as the
image user, so the container serves nothing for them.

Cloudflare may stop a container at any time; before a planned stop it sends
`SIGTERM` to tini, which forwards it to `dx-orb-init`, and kills the
container up to 15 minutes later. The entrypoint then posts to
`DX_ORB_STOP_NOTICE` (set only by the Orb container object), which the
object intercepts with `interceptOutboundHttp` and routes to the Orb
Worker's `OrbStopNotice` entrypoint. The object snapshots the filesystem
while the container still runs, and the entrypoint exits only once it has
answered, so the next use restores that snapshot. A container that stops
without notice before its first snapshot has lost its files: the object
never starts the bare image in its place for a command or a reconnect, and
fails them as `WORKSPACE_RESET`, which Core retries as a whole submission so
activation sets the workspace up again
([`orb-container.ts`](../../apps/core/src/execution/cloudflare/orb-container.ts)).

Snapshots are stored beside the image in the same registry repository
(`rootfs-snapshot-*` tags) and are tied to the image version: keep an old
image while any Thread's snapshot still refers to it.

## Publishing

The Release workflow publishes the image when the Dockerfile or a file it
copies changes: one build, pushed by digest to `ghcr.io/dxcode-dev/dx-orb`
and Docker Hub (`dockerHubRepository`), then pinned in
[`public-image.json`](public-image.json). Its `digest` and `source` belong
to the release; do not edit them by hand.
