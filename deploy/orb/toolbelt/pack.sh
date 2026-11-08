#!/bin/bash
# Builds the dx toolbelt and packs it into the tarball Orbs install
# (README.md): /opt/dx and every Nix store path it refers to, as one
# reproducible tar (sorted names, fixed times and owners) compressed with
# zstd. Prints the tarball's SHA-256 and the tar's, which a rebuild from the
# same commit reproduces.
#
#   deploy/orb/toolbelt/pack.sh <output-directory>
set -euo pipefail

out_dir=$(realpath "${1:?usage: pack.sh <output-directory>}")
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$out_dir"

toolbelt=$(nix build --no-link --print-out-paths "$here#toolbelt")
tools=$(nix build --no-link --print-out-paths "$here#packTools")/bin
# The store paths the tree refers to; the toolbelt's own path is only the
# tree's container and is not installed.
mapfile -t store < <(nix path-info --recursive "$toolbelt" | grep -vx "$toolbelt" | sort)

tar_file="$out_dir/dx-toolbelt.tar"
LC_ALL=C "$tools/tar" --create --format=posix \
  --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime \
  --sort=name --mtime=@1 --owner=0 --group=0 --numeric-owner \
  --file "$tar_file" \
  -C "$toolbelt" opt/dx \
  -C / "${store[@]#/}"
content=$("$tools/sha256sum" "$tar_file" | cut -d ' ' -f 1)
"$tools/zstd" -q -f -T4 -12 --rm "$tar_file" -o "$tar_file.zst"
digest=$("$tools/sha256sum" "$tar_file.zst" | cut -d ' ' -f 1)
size=$(stat -c %s "$tar_file.zst")
printf '{"version":"%s","sha256":"%s","contentSha256":"%s","bytes":%d,"storePaths":%d,"desktopEnv":"%s"}\n' \
  "${content:0:16}" "$digest" "$content" "$size" "${#store[@]}" \
  "$(readlink "$toolbelt/opt/dx/desktop/env")" | tee "$out_dir/dx-toolbelt.json"
