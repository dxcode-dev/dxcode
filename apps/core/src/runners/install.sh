#!/bin/sh
# Installs dx's runner on this Mac or Linux machine and pairs it with dx.
#
#   curl -fsSL __DX_ORIGIN__/v1/runner/install.sh | sh -s -- --code BCDF-GHJK
#
# Options: --name NAME (default: this machine's host name), --no-service
# (run in the foreground instead of starting at login), --sandbox (confine
# Thread commands to their folder, for a machine others use; by default they
# run as you, like an agent in your own terminal).
#
# It needs no sudo and writes only ~/.dx/runner and ~/.dx/threads, plus a
# login item (macOS ~/Library/LaunchAgents/dev.dx.runner.plist, Linux
# ~/.config/systemd/user/dx-runner.service) unless --no-service.
# Remove everything with: ~/.dx/runner/bin/dxd runner uninstall
set -eu

DX_ORIGIN="__DX_ORIGIN__"
code=""
name=""
service=1
sandbox=""

while [ $# -gt 0 ]; do
  case "$1" in
    --code) code="${2:-}"; shift 2 ;;
    --name) name="${2:-}"; shift 2 ;;
    --no-service) service=0; shift ;;
    --sandbox) sandbox="--sandbox"; shift ;;
    --unsandboxed) shift ;;
    *) echo "dx runner: unknown option $1" >&2; exit 2 ;;
  esac
done

if [ -z "$code" ]; then
  echo "dx runner: pass the pairing code from dx: --code XXXX-XXXX" >&2
  exit 2
fi

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "dx runner: only macOS and Linux are supported." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) [ "$os" = darwin ] && { echo "dx runner: Intel Macs are not supported; use an Apple silicon Mac or Linux." >&2; exit 1; }; arch=x64 ;;
  *) echo "dx runner: unsupported processor $(uname -m)." >&2; exit 1 ;;
esac

if [ -z "$name" ]; then
  name="$(hostname -s 2>/dev/null || hostname)"
fi

# Threads need git (and python3 for Claude Code mode). On a Mac both come
# only with Apple's Command Line Tools, which only Apple's installer
# provides: offer to start it (asked on the terminal, since `curl | sh`
# takes the script on stdin; without a terminal, say what to run), and
# pair anyway (dx fetches node, gh, and Claude Code itself when a Thread
# needs them).
if [ "$os" = darwin ]; then
  if ! /usr/bin/xcode-select -p >/dev/null 2>&1; then
    echo "dx runner: this Mac has no Command Line Tools (git, python3), which Threads need."
    answer=""
    if [ -t 1 ] && { : < /dev/tty; } 2>/dev/null; then
      printf 'dx runner: open Apple'"'"'s installer for them now? [y/N] ' > /dev/tty
      read -r answer < /dev/tty || answer=""
    fi
    case "$answer" in
      y | Y | yes | YES)
        /usr/bin/xcode-select --install >/dev/null 2>&1 || true
        echo "dx runner: finish Apple's install dialog; Threads with a repository start once it is done." ;;
      *)
        echo "dx runner: install them later with: xcode-select --install" ;;
    esac
  fi
else
  for tool in git python3; do
    command -v "$tool" >/dev/null 2>&1 ||
      echo "dx runner: $tool is not installed; install it with your package manager (Threads need it)."
  done
fi

asset="dxd-$os-$arch"
root="$HOME/.dx/runner"
bin="$root/bin"
marker="$root/.dx-runner-owned"
if [ -d "$root" ] && [ ! -f "$marker" ]; then
  echo "dx runner: $root exists and was not created by the dx runner; nothing installed." >&2
  exit 1
fi
mkdir -p "$bin"
chmod 700 "$root" "$bin"
[ -f "$marker" ] || printf 'created by the dx runner; `dxd runner uninstall` deletes this folder\n' > "$marker"

echo "dx runner: downloading $asset from $DX_ORIGIN"
tmp="$bin/dxd.download"
curl -fsSL "$DX_ORIGIN/runner/$asset" -o "$tmp"
expected="$(curl -fsSL "$DX_ORIGIN/runner/$asset.sha256" | cut -d' ' -f1)"
if command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$tmp" | cut -d' ' -f1)"
else
  actual="$(sha256sum "$tmp" | cut -d' ' -f1)"
fi
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  rm -f "$tmp"
  echo "dx runner: the download's SHA-256 does not match; nothing installed." >&2
  exit 1
fi
chmod 755 "$tmp"
mv -f "$tmp" "$bin/dxd"
echo "dx runner: installed $bin/dxd ($actual)"

"$bin/dxd" runner pair --server "$DX_ORIGIN" --code "$code" --name "$name" $sandbox

echo "dx runner: to remove it later, run: $bin/dxd runner uninstall"
if [ "$service" = 1 ]; then
  "$bin/dxd" runner install-service
  echo "dx runner: running; it starts again when you log in."
else
  echo "dx runner: running in the foreground; press Ctrl-C to stop."
  exec "$bin/dxd" runner run
fi
