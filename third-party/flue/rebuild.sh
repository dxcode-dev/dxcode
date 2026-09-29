#!/usr/bin/env bash
set -euo pipefail
script_directory=${0%/*}
if [[ "$script_directory" == "$0" ]]; then script_directory=.; fi
here="$(cd -- "$script_directory" && pwd -P)"
revision=7b97fbfda603633cf84fe117064667ea389ed8eb
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
node - "$here/source.bundle" <<'NODE'
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const expected = "ebc01d5b983684c5dbfeccaea5c17d86df482adfe68c6f1a677d5c409a7957cd";
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
