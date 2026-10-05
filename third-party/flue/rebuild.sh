#!/usr/bin/env bash
set -euo pipefail
script_directory=${0%/*}
if [[ "$script_directory" == "$0" ]]; then script_directory=.; fi
here="$(cd -- "$script_directory" && pwd -P)"
revision=11963758a85ad512c317d4d3ea7d8955bde01432
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
node - "$here/source.bundle" <<'NODE'
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const expected = "e8606326f6e9bd6c08480cde53d1684d5ada9192c747e49e52ee250585e4132f";
const actual = createHash("sha256").update(readFileSync(process.argv[2])).digest("hex");
if (actual !== expected) throw new Error("Retained Flue source bundle checksum mismatch.");
NODE
for run in first second; do
  git clone --quiet "$here/source.bundle" "$stage/source-$run"
  git -C "$stage/source-$run" checkout --quiet --detach "$revision"
  mkdir "$stage/$run"
  (cd "$stage/source-$run" && bash build-dx-packages.sh "$stage/$run")
  test -z "$(git -C "$stage/source-$run" status --porcelain)"
done
mkdir "$stage/repeated"
(cd "$stage/source-first" && bash build-dx-packages.sh "$stage/repeated")
test -z "$(git -C "$stage/source-first" status --porcelain)"
for package in runtime sdk react vite; do
  cmp "$stage/first/$package-$revision.tgz" "$stage/second/$package-$revision.tgz"
  cmp "$stage/first/$package-$revision.tgz" "$stage/repeated/$package-$revision.tgz"
  cmp "$stage/first/$package-$revision.tgz" "$here/$package-$revision.tgz"
done
echo 'Two fresh builds and a repeated build match all retained artifacts; source checkouts remain clean.'
