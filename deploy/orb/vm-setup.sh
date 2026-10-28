#!/bin/bash
# dx Orb on a plain Linux machine: turns a Debian or Ubuntu x86-64 VM or
# container into the same workspace deploy/orb/Dockerfile builds, for Orb
# providers that boot their own images instead of an OCI image (Freestyle
# VMs, Upstash Box containers). Core's VM Orb recipe (apps/core/src/execution/guest/vm-orb-recipe.ts)
# copies this script and the dx files it installs into a fresh VM, runs it as
# root, and snapshots the VM once it reports done. See deploy/orb/README.md.
#
#   vm-setup.sh <files-directory> <state-directory>
#
# The files directory holds dx-terminal.sh, dx-orb-init, dx-orb-hostname.sh,
# and tmux.conf. The state directory receives `status` (running, done, or
# failed) and this script's log is the caller's to keep.
#
# Keep each step in step with the Dockerfile: the same packages, the same
# pinned downloads and checksums, the same account and dx files. The Desktop
# is not installed: its labwc and wlroots builds are Debian 13 packages.
set -euo pipefail

files=$1
state=$2
mkdir -p "$state"
echo running >"$state/status"
trap 'echo failed >"$state/status"' ERR

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl wget git git-lfs openssh-client gnupg sudo tini procps psmisc less file unzip zip xz-utils bzip2 zstd ripgrep jq nano build-essential pkg-config libssl-dev zlib1g-dev libffi-dev libsqlite3-dev libbz2-dev liblzma-dev libreadline-dev python3 python3-dev python3-pip python3-venv python-is-python3 default-jdk-headless

# GitHub CLI from GitHub's own repository (Dockerfile: same keyring checksum).
curl -fsSL -o /usr/share/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg
test "$(sha256sum /usr/share/keyrings/githubcli-archive-keyring.gpg | cut -d " " -f 1)" = 6084d5d7bd8e288441e0e94fc6275570895da18e6751f70f057485dc2d1a811b
chmod 0644 /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" >/etc/apt/sources.list.d/github-cli.list
apt-get update
apt-get install -y --no-install-recommends gh

# Node.js from nodejs.org (Dockerfile: same release and checksum). It
# replaces any node the VM image linked into /usr/local/bin.
curl -fsSL -o /tmp/node.tar.xz https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz
test "$(sha256sum /tmp/node.tar.xz | cut -d " " -f 1)" = fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner --exclude CHANGELOG.md --exclude README.md --exclude LICENSE
rm /tmp/node.tar.xz
corepack enable
node --version
npm --version

# The workspace account: passwordless sudo, home /home/user. A VM image may
# already give uid 1000 to its own account, so `user` takes the next free
# uid; Core runs every command as `user` by name.
if ! id -u user >/dev/null 2>&1; then useradd --create-home --shell /bin/bash --user-group user; fi
echo "user ALL=(ALL:ALL) NOPASSWD: ALL" >/etc/sudoers.d/user
chmod 0440 /etc/sudoers.d/user

# The Terminal's tmux (Dockerfile: same static build and checksums).
curl -fsSL -o /tmp/tmux.tar.gz https://github.com/tmux/tmux-builds/releases/download/v3.7c/tmux-3.7c-linux-x86_64.tar.gz
test "$(sha256sum /tmp/tmux.tar.gz | cut -d " " -f 1)" = cc56bd1cc873eb6089c615f0496b072385bda8a6d944069f38564a5d49c128aa
curl -fsSL -o /tmp/tmux-licenses.tar.gz https://github.com/tmux/tmux-builds/releases/download/v3.7c/LICENSES.tar.gz
test "$(sha256sum /tmp/tmux-licenses.tar.gz | cut -d " " -f 1)" = 094905d3ba42397c65fecd817dc29736dd14bd35e75600441403a365125f47d1
mkdir -p /opt/dx/bin /opt/dx/share/licenses/tmux
tar -xzf /tmp/tmux.tar.gz -C /opt/dx/bin --no-same-owner tmux
tar -xzf /tmp/tmux-licenses.tar.gz -C /opt/dx/share/licenses/tmux --no-same-owner
rm /tmp/tmux.tar.gz /tmp/tmux-licenses.tar.gz
chmod 0755 /opt/dx/bin/tmux
ln -sfn /opt/dx/bin/tmux /usr/local/bin/tmux
/opt/dx/bin/tmux -V

# dxd's root-owned pieces (Dockerfile: the same files and modes).
install -o root -g root -m 0644 "$files/dx-terminal.sh" /etc/profile.d/dx-terminal.sh
install -o root -g root -m 0755 "$files/dx-orb-init" /usr/local/bin/dx-orb-init
install -o root -g root -m 0644 "$files/dx-orb-hostname.sh" /etc/profile.d/dx-orb-hostname.sh
install -o root -g root -m 0644 "$files/tmux.conf" /opt/dx/share/tmux.conf
chown -R root:root /opt/dx
ln -sfn /home/user/.local/state/dxd/bin/dxd /usr/local/bin/dxd

# Every binary Core's daemon installer and source runtime invoke.
for bin in sudo curl sha256sum install cmp git git-lfs gh bash setpriv setsid readlink tini rg jq node java python3 awk tmux; do command -v "$bin" >/dev/null || { echo "missing required binary: $bin"; exit 1; }; done

# Claude Code for Claude Code mode (Dockerfile: same pinned release).
sudo -u user -H bash -c 'cd /home/user && curl -fsSL https://claude.ai/install.sh | bash -s 2.1.296 && /home/user/.local/bin/claude --version'

# Start dx-orb-init, the image entrypoint, which drops to `user` itself.
# Where systemd is PID 1 (a VM), a unit starts it; the unit is not named
# dxd.service, because dx-orb-init stands down while that one exists.
# Elsewhere (a container), it runs in the background under tini, as the
# image runs it.
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
  command -v tini >/dev/null || apt-get install -y --no-install-recommends tini
  setsid nohup /usr/bin/tini -s -- /usr/local/bin/dx-orb-init >/var/log/dx-orb-init.log 2>&1 </dev/null &
fi
for _ in $(seq 1 60); do
  if test -f /home/user/.local/state/dxd/supervisor.pid; then break; fi
  sleep 1
done
test -f /home/user/.local/state/dxd/supervisor.pid

apt-get clean
rm -rf /var/lib/apt/lists/*
echo done >"$state/status"
