#!/usr/bin/env bash
# Builds `dx`, the Mac runner Desktop's launcher (apps/desktop), for Apple
# silicon with cargo zigbuild, from Linux or a Mac:
#
#   scripts/build-dx-desktop.sh [--out <dir>]
#
# Writes <dir>/dx-desktop-darwin-arm64 (default dist/dx-desktop) and prints the
# SHA-256 to pin in deploy/runner/dx-desktop.json. The launcher is built once
# per version and pinned, never per deploy: macOS keeps the person's Screen
# Recording and Accessibility grants only while its bytes stay the same. See
# wiki/runtime-architecture.md, "Runner binaries and releases".
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$root/dist/dx-desktop"
if [ "${1:-}" = "--out" ]; then out="${2:?--out needs a directory}"; fi
command -v cargo-zigbuild >/dev/null || {
  echo "build-dx-desktop: cargo-zigbuild is required (cargo install --locked cargo-zigbuild)" >&2
  exit 1
}
rustup target add aarch64-apple-darwin >/dev/null
target="$(mktemp -d)"
trap 'rm -rf "$target"' EXIT
MACOSX_DEPLOYMENT_TARGET=12.0 CARGO_TARGET_DIR="$target" cargo zigbuild --release --locked \
  --manifest-path "$root/apps/desktop/Cargo.toml" --target aarch64-apple-darwin
mkdir -p "$out"
cp "$target/aarch64-apple-darwin/release/dx" "$out/dx-desktop-darwin-arm64"
sha="$(sha256sum "$out/dx-desktop-darwin-arm64" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$out/dx-desktop-darwin-arm64" | awk '{print $1}')"
version="$(sed -n 's/^version = "\(.*\)"/\1/p' "$root/apps/desktop/Cargo.toml" | head -1)"
echo "tag=dx-desktop-v$version"
echo "sha256=$sha"
