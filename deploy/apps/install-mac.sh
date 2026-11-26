#!/bin/sh
# Installs or updates the dx Mac app in ~/Applications, as dxcode.dev/apps
# shows it:
#
#   curl -fsSL https://dxcode.dev/runner/dx-mac-install.sh | sh -s -- https://dxcode.dev
#
# It downloads the app's zip from that dx (production-package.mjs serves it at
# /runner/dx-mac-arm64.zip), checks the zip's SHA-256 and the app's code
# signature, replaces an older copy (quitting it first), and opens it.
set -eu

origin="${1:-https://dxcode.dev}"
origin="${origin%/}"
fail() { echo "dx: $*" >&2; exit 1; }
case "$origin" in https://*) ;; *) fail "the dx address must start with https://" ;; esac
[ "$(uname -s)" = Darwin ] || fail "the dx app is for macOS"
[ "$(uname -m)" = arm64 ] || fail "the dx app needs an Apple silicon Mac; use dx in your browser"
major="$(sw_vers -productVersion | cut -d. -f1)"
[ "$major" -ge 14 ] || fail "the dx app needs macOS 14 or later"

dir="$HOME/Applications"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "dx: downloading the app from $origin"
curl -fsSL "$origin/runner/dx-mac-arm64.zip" -o "$tmp/dx.zip"
expected="$(curl -fsSL "$origin/runner/dx-mac-arm64.zip.sha256" | cut -d' ' -f1)"
actual="$(shasum -a 256 "$tmp/dx.zip" | cut -d' ' -f1)"
[ -n "$expected" ] && [ "$expected" = "$actual" ] || fail "the download's SHA-256 doesn't match; nothing installed"
ditto -x -k "$tmp/dx.zip" "$tmp/app"
[ -d "$tmp/app/dx.app" ] || fail "the download holds no dx.app; nothing installed"
codesign --verify --strict "$tmp/app/dx.app" || fail "the app's signature doesn't verify; nothing installed"

mkdir -p "$dir"
for pid in $(pgrep -f "$dir/dx.app/Contents/MacOS/dx" 2>/dev/null || true); do
  kill -TERM "$pid" 2>/dev/null || true
done
sleep 1
rm -rf "$dir/dx.app"
mv "$tmp/app/dx.app" "$dir/dx.app"
echo "dx: installed $dir/dx.app"
open "$dir/dx.app"
