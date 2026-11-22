#!/usr/bin/env bash
# Builds the Mac runner's voxl on an Apple silicon Mac: tembo/voxl (MIT) at the
# upstream version and commit pinned in deploy/runner/voxl.json, with dx's
# patches from deploy/runner/voxl-patches/*.patch applied in name order, x264
# and opus linked statically. The result links only Apple's own libraries, so
# it runs on Macs without Homebrew.
#
#   scripts/build-voxl-runner.sh [--out <dir>]
#
# Needs Rust (rustup), Xcode's command line tools, and Homebrew's
# `x264 opus pkgconf esbuild`. Writes <dir>/voxl-darwin-arm64 (default
# dist/voxl) and prints the release tag (`voxl-v<version>-dx<patchLevel>`)
# and SHA-256 to pin. .github/workflows/voxl-runner-build.yml runs it and
# publishes the release; see wiki/runtime-architecture.md, "Runner binaries
# and releases".
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$root/dist/voxl"
while [ $# -gt 0 ]; do
  case "$1" in
    --out)
      out="${2:?--out needs a directory}"
      shift 2
      ;;
    -h | --help)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

die() {
  echo "build-voxl-runner: $*" >&2
  exit 1
}

[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] ||
  die "runs on an Apple silicon Mac (voxl links Apple frameworks only a Mac's SDK has)."

pin="$root/deploy/runner/voxl.json"
field() { plutil -extract "$1" raw -o - "$pin" 2>/dev/null || die "$pin has no $1."; }
version="$(field version)"
commit="$(field upstreamCommit)"
level="$(field patchLevel)"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version $version must look like 0.4.0."
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || die "upstreamCommit must be a full commit SHA."
[[ "$level" =~ ^[0-9]+$ ]] || die "patchLevel must be a whole number."
tag="voxl-v$version"
[ "$level" -gt 0 ] && tag="$tag-dx$level"

for tool in cargo pkg-config esbuild otool shasum git; do
  command -v "$tool" >/dev/null || die "$tool is missing (brew install x264 opus pkgconf esbuild; Rust from rustup.rs)."
done
pkg-config --exists x264 opus || die "x264 and opus are missing: brew install x264 opus."

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "v$version" \
  https://github.com/tembo/voxl "$work/voxl"
got="$(git -C "$work/voxl" rev-parse HEAD)"
[ "$got" = "$commit" ] || die "tembo/voxl v$version is $got, but $pin pins $commit."

shopt -s nullglob
patches=("$root"/deploy/runner/voxl-patches/*.patch)
for patch in "${patches[@]}"; do
  echo "Applying $(basename "$patch")"
  git -C "$work/voxl" apply --whitespace=nowarn "$patch"
done
if [ "$level" -gt 0 ] && [ ${#patches[@]} -eq 0 ]; then
  die "patchLevel is $level but deploy/runner/voxl-patches has no patches."
fi

# Static x264 and opus: pkg-config hands out their .a files.
PKG_CONFIG_ALL_STATIC=1 cargo build --release --locked \
  --manifest-path "$work/voxl/Cargo.toml" --target-dir "$work/target"
binary="$work/target/release/voxl"

# Runners have no Homebrew: the binary may link only Apple's own libraries.
linked="$(otool -L "$binary" | tail -n +2 | awk '{print $1}')"
foreign="$(grep -vE '^(/usr/lib/|/System/Library/)' <<<"$linked" || true)"
if [ -n "$foreign" ]; then
  echo "$linked" >&2
  die "voxl links libraries outside macOS ($foreign); it would not run on other Macs."
fi

mkdir -p "$out"
cp "$binary" "$out/voxl-darwin-arm64"
sha="$(shasum -a 256 "$out/voxl-darwin-arm64" | awk '{print $1}')"
echo "$sha  voxl-darwin-arm64" >"$out/voxl-darwin-arm64.sha256"
echo "Built $out/voxl-darwin-arm64"
echo "tag=$tag"
echo "sha256=$sha"
