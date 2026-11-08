#!/bin/bash
# dx Orb installer: turns a Linux machine into a dx Orb, the same on every
# Orb provider (deploy/orb/README.md). It runs in two places:
#
#   - deploy/orb/Dockerfile runs it while building the OCI image that E2B,
#     Cloudflare Containers, and Docker Cloud Sandboxes boot (`--image`);
#   - Core's VM Orb recipe (apps/core/src/execution/guest/vm-orb-recipe.ts)
#     copies it into a fresh Boat or Freestyle machine, runs it as root, and
#     snapshots the machine once it reports done (`--vm`).
#
#   install.sh --image|--vm <files-directory> <state-directory> [part...]
#
# The parts are packages, runtimes, toolbelt, and finish, in that order; with
# none it runs them all. The Dockerfile runs each part as its own step, so
# the image's layers stay a few hundred MB each.
#
# The files directory holds dx-terminal.sh, dx-orb-init, dx-orb-hostname.sh,
# dx-orb-open-files.sh, and tmux.conf. The state directory receives `status`
# (running, done, or failed); this script's log is the caller's to keep.
#
# What it installs:
#   1. the base packages, from the distribution (apt: Debian, Ubuntu);
#   2. Node.js and the GitHub CLI, from their own pinned releases;
#   3. the `user` account with passwordless sudo;
#   4. the dx toolbelt (deploy/orb/toolbelt): /opt/dx with the Terminal's
#      tmux, the Desktop, and dx-orb-check, each program with its own glibc
#      and libraries, so it runs alike on every distribution;
#   5. dx's own files: the login hooks, dx-orb-init, the tmux configuration;
#   6. Claude Code for `user`.
# With --vm it then starts dx-orb-init (a systemd unit where systemd is PID 1,
# else under tini) and waits for dxd's supervisor.
#
# Every download retries transient failures and checks its pinned SHA-256
# (downloads.test.mjs runs each against a failing server).
set -euo pipefail

mode=${1:?usage: install.sh --image|--vm <files-directory> <state-directory>}
files=${2:?missing files directory}
state=${3:?missing state directory}
case "$mode" in
  --image | --vm) ;;
  *) echo "install.sh: unknown mode $mode" >&2; exit 2 ;;
esac
mkdir -p "$state"
echo running >"$state/status"
trap 'echo failed >"$state/status"' ERR
umask 022

# The dx toolbelt release this installer pins (deploy/orb/toolbelt/toolbelt.json).
TOOLBELT_VERSION=c8f8171315bb15be
TOOLBELT_SHA256=36feed804bc95445dad36149cc9c22073c9b784f1781c802b4b184b3b1ccbd23

parts=" ${*:4} "
[ "$parts" = "  " ] && parts=" packages runtimes toolbelt finish "
want() { [[ $parts == *" $1 "* ]]; }

[ "$(uname -m)" = x86_64 ] || { echo "install.sh: dx Orbs are x86-64; this machine is $(uname -m)" >&2; false; }
[ "$(id -u)" = 0 ] || { echo "install.sh: run as root" >&2; false; }

# 1. Base packages. Debian and Ubuntu share the package names.
if want packages; then
if ! command -v apt-get >/dev/null; then
  echo "install.sh: no apt-get; dx installs its base packages on Debian and Ubuntu (deploy/orb/README.md)" >&2
  false
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl wget git git-lfs openssh-client gnupg sudo tini procps psmisc less file unzip zip xz-utils bzip2 zstd ripgrep jq nano build-essential pkg-config libssl-dev zlib1g-dev libffi-dev libsqlite3-dev libbz2-dev liblzma-dev libreadline-dev python3 python3-dev python3-pip python3-venv python-is-python3 default-jdk-headless
apt-get clean
rm -rf /var/lib/apt/lists/*
fi

work=$(mktemp -d)
cleanup_work() { rm -rf "$work"; }
trap cleanup_work EXIT

if want runtimes; then
# 2. Node.js, current LTS, from nodejs.org; corepack provides yarn and pnpm.
# It replaces any node the machine's image linked into /usr/local/bin.
curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 20 -o "$work/node.tar.xz" https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz
test "$(sha256sum "$work/node.tar.xz" | cut -d " " -f 1)" = fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
tar -xJf "$work/node.tar.xz" -C /usr/local --strip-components=1 --no-same-owner --exclude CHANGELOG.md --exclude README.md --exclude LICENSE
corepack enable
node --version
npm --version

# The GitHub CLI's own static release: Core's source runtime needs gh 2.40
# or later (source-tool-requirements.ts), newer than some distributions carry.
curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 20 -o "$work/gh.tar.gz" https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_linux_amd64.tar.gz
test "$(sha256sum "$work/gh.tar.gz" | cut -d " " -f 1)" = 4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d
tar -xzf "$work/gh.tar.gz" -C "$work" --no-same-owner
install -o root -g root -m 0755 "$work/gh_2.103.3_linux_amd64/bin/gh" /usr/local/bin/gh
gh --version

# 3. The workspace account: passwordless sudo, home /home/user, uid 1000
# where it is free. A machine image may already give uid 1000 to its own
# account (and E2B provisions `user` itself); Core runs every command as
# `user` by name.
if ! id -u user >/dev/null 2>&1; then
  if getent passwd 1000 >/dev/null; then
    useradd --create-home --shell /bin/bash --user-group user
  else
    useradd --create-home --shell /bin/bash --uid 1000 --user-group user
  fi
fi
echo "user ALL=(ALL:ALL) NOPASSWD: ALL" >/etc/sudoers.d/user
chmod 0440 /etc/sudoers.d/user
fi

# 4. The dx toolbelt: dx's own release on GitHub first, then its mirror on
# Docker Hub, whose blob is the same file. The tarball holds /opt/dx and
# the Nix store paths it refers to, not their parents.
#
# fetch_toolbelt <file> <sha256> <url>...: tries each source in order and
# keeps the first file whose SHA-256 matches. A Docker Hub blob needs an
# anonymous pull token first.
fetch_toolbelt() {
  local file=$1 sum=$2 url token
  shift 2
  for url in "$@"; do
    local auth=()
    case $url in
      https://registry-1.docker.io/v2/*)
        token=$(curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 20 "https://auth.docker.io/token?service=registry.docker.io&scope=repository:dxcodedev/dx-toolbelt:pull" | sed -n 's/.*"token": *"\([^"]*\)".*/\1/p') || token=
        auth=(-H "Authorization: Bearer $token")
        ;;
      file://*)
        cp "${url#file://}" "$file" && [ "$(sha256sum "$file" | cut -d " " -f 1)" = "$sum" ] && return 0
        continue
        ;;
    esac
    curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 20 "${auth[@]}" -o "$file" "$url" && [ "$(sha256sum "$file" | cut -d " " -f 1)" = "$sum" ] && return 0
    echo "dx-toolbelt: $url failed or did not match its SHA-256; trying the next source" >&2
  done
  echo "dx-toolbelt: no source served the dx toolbelt with SHA-256 $sum" >&2
  return 1
}
if want toolbelt; then
toolbelt="$work/dx-toolbelt.tar.zst"
sources=("https://github.com/dxcode-dev/dxcode/releases/download/orb-toolbelt-$TOOLBELT_VERSION/dx-toolbelt.tar.zst" "https://registry-1.docker.io/v2/dxcodedev/dx-toolbelt/blobs/sha256:$TOOLBELT_SHA256")
# A toolbelt not yet published, for testing it (internal/orb-toolbelt).
if [ -n "${DX_TOOLBELT_FILE:-}" ]; then
  TOOLBELT_VERSION=${DX_TOOLBELT_VERSION:?DX_TOOLBELT_FILE needs DX_TOOLBELT_VERSION}
  TOOLBELT_SHA256=${DX_TOOLBELT_SHA256:?DX_TOOLBELT_FILE needs DX_TOOLBELT_SHA256}
  sources=("file://$DX_TOOLBELT_FILE")
fi
fetch_toolbelt "$toolbelt" "$TOOLBELT_SHA256" "${sources[@]}"
install -d -m 0755 /opt /nix /nix/store
rm -rf /opt/dx/desktop /opt/dx/bin/tmux /opt/dx/bin/dx-orb-check
tar --zstd -xf "$toolbelt" -C / --no-same-owner
rm -f "$toolbelt"
chmod 0755 /opt/dx /opt/dx/bin /opt/dx/share /opt/dx/desktop
echo "$TOOLBELT_VERSION" >/opt/dx/VERSION
ln -sfn /opt/dx/bin/tmux /usr/local/bin/tmux
ln -sfn /opt/dx/bin/dx-orb-check /usr/local/bin/dx-orb-check
/opt/dx/bin/tmux -V

# Chromium's sandbox needs unprivileged user namespaces. Ubuntu 24.04 lets
# only programs with an AppArmor profile create them; give the toolbelt's
# Chromium one, as Ubuntu does for its own browsers. Elsewhere this changes
# nothing; /opt/dx/desktop/chromium falls back to --no-sandbox only where no
# user namespaces exist at all.
if [ -d /etc/apparmor.d ] && [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
  cat >/etc/apparmor.d/dx-chromium <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>
profile dx-chromium /nix/store/*-chromium-unwrapped-*/libexec/chromium/chromium flags=(unconfined) {
  userns,
  include if exists <local/dx-chromium>
}
PROFILE
  if command -v apparmor_parser >/dev/null && apparmor_parser -r /etc/apparmor.d/dx-chromium; then
    echo "loaded the AppArmor profile that lets the toolbelt's Chromium sandbox itself"
  else
    rm -f /etc/apparmor.d/dx-chromium
    echo "install.sh: could not load the Chromium AppArmor profile; Chromium runs without its sandbox" >&2
  fi
fi
fi

want finish || exit 0

# 5. dx's own files: the login hook that sources the shell profile dxd
# writes, the open-file limit and hostname hooks, the entrypoint that runs
# dxd, and the Terminal's tmux configuration. Core installs dxd itself
# under the user's state directory.
install -o root -g root -m 0644 "$files/dx-terminal.sh" /etc/profile.d/dx-terminal.sh
install -o root -g root -m 0755 "$files/dx-orb-init" /usr/local/bin/dx-orb-init
install -o root -g root -m 0644 "$files/dx-orb-hostname.sh" /etc/profile.d/dx-orb-hostname.sh
install -o root -g root -m 0644 "$files/dx-orb-open-files.sh" /etc/profile.d/dx-orb-open-files.sh
install -d -o root -g root -m 0755 /opt/dx/share
install -o root -g root -m 0644 "$files/tmux.conf" /opt/dx/share/tmux.conf
ln -sfn /home/user/.local/state/dxd/bin/dxd /usr/local/bin/dxd

# Every binary Core's daemon installer and source runtime invoke.
for bin in sudo curl sha256sum install cmp git git-lfs gh bash setpriv setsid readlink tini rg jq node java python3 awk tmux; do command -v "$bin" >/dev/null || { echo "missing required binary: $bin"; exit 1; }; done

# 6. Claude Code for Claude Code mode, pinned and self-update disabled at run
# time (DISABLE_AUTOUPDATER), in ~/.local/bin of the workspace account. The
# installer is saved before it runs: a retried download piped into bash
# could feed it the failed attempt's bytes twice.
sudo -u user -H bash -c 'cd /home/user && curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 20 -o /tmp/claude-install.sh https://claude.ai/install.sh && bash /tmp/claude-install.sh 2.1.296 && rm /tmp/claude-install.sh && /home/user/.local/bin/claude --version'

apt-get clean
rm -rf /var/lib/apt/lists/*

# On a VM, start dx-orb-init, the image entrypoint, which drops to `user`
# itself. Where systemd is PID 1, a unit starts it; the unit is not named
# dxd.service, because dx-orb-init stands down while that one exists.
# Elsewhere it runs in the background under tini, as the image runs it.
if [ "$mode" = --vm ]; then
  if [ -d /run/systemd/system ]; then
    cat >/etc/systemd/system/dx-orb.service <<'UNIT'
[Unit]
Description=dx Orb supervisor (dx-orb-init)
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/dx-orb-init
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload
    systemctl enable --now dx-orb.service
  else
    setsid nohup /usr/bin/tini -s -- /usr/local/bin/dx-orb-init >/var/log/dx-orb-init.log 2>&1 </dev/null &
  fi
  for _ in $(seq 1 60); do
    if test -f /home/user/.local/state/dxd/supervisor.pid; then break; fi
    sleep 1
  done
  test -f /home/user/.local/state/dxd/supervisor.pid
fi

echo done >"$state/status"
