import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const biome = fileURLToPath(
  new URL("../node_modules/.bin/biome", import.meta.url),
);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureDirectory = join(repositoryRoot, "scripts/fixtures/biome");
mkdirSync(fixtureDirectory, { recursive: true });
const effectFixturePath = join(fixtureDirectory, `effect-${process.pid}.ts`);
const reactFixturePath = join(fixtureDirectory, `react-${process.pid}.tsx`);

const lint = (fixturePath, source) => {
  writeFileSync(fixturePath, source);
  try {
    return spawnSync(biome, ["lint", "--colors=off", fixturePath], {
      encoding: "utf8",
    });
  } finally {
    rmSync(fixturePath, { force: true });
  }
};

const manualTagCheck = lint(
  effectFixturePath,
  `
declare const error: { readonly _tag: string };
if (error._tag === "PersistenceUnavailable") {}
if ("_tag" in error) {}
switch (error._tag) {
  default:
    break;
}
`,
);
assert.notEqual(manualTagCheck.status, 0);
const diagnostics = `${manualTagCheck.stdout}${manualTagCheck.stderr}`.match(
  /Do not inspect an Effect error `_tag` manually/g,
);
assert.equal(diagnostics?.length, 3);

const typedMatch = lint(
  effectFixturePath,
  `
import { Match } from "effect";
declare const error: { readonly _tag: "PersistenceUnavailable" };
const details = { outcome: error._tag };
Match.value(error).pipe(
  Match.tag("PersistenceUnavailable", () => "unavailable"),
  Match.exhaustive,
);
void details;
`,
);
assert.equal(typedMatch.status, 0, `${typedMatch.stdout}${typedMatch.stderr}`);

const directUseEffect = lint(
  reactFixturePath,
  `
import * as React from "react";
import { useEffect } from "react";
export function InvalidEffects() {
  React.useEffect(() => {}, []);
  useEffect(() => {}, []);
  return null;
}
`,
);
assert.notEqual(directUseEffect.status, 0);
const useEffectDiagnostics =
  `${directUseEffect.stdout}${directUseEffect.stderr}`.match(
    /Do not call useEffect directly in a React component/g,
  );
assert.equal(useEffectDiagnostics?.length, 2);

const pluginMessages = (result, pattern) =>
  `${result.stdout}${result.stderr}`.match(pattern)?.length ?? 0;

const manualMemo = lint(
  reactFixturePath,
  `
import * as React from "react";
import { memo, useCallback, useMemo } from "react";
export function ManualMemo({ items }: { items: readonly number[] }) {
  "use memo";
  const total = useMemo(() => items.length, [items]);
  const first = React.useMemo(() => items[0], [items]);
  const onClick = useCallback(() => total, [total]);
  const onKey = React.useCallback(() => first, [first]);
  return <button type="button" onClick={onClick} onKeyDown={onKey} />;
}
export function OptedOut() {
  "use no memo";
  return null;
}
export const PlainMemo = memo(OptedOut);
export const PlainReactMemo = React.memo(function Row() {
  return null;
});
`,
);
assert.notEqual(manualMemo.status, 0);
assert.equal(pluginMessages(manualMemo, /Do not memoize by hand/g), 4);
assert.equal(pluginMessages(manualMemo, /Do not steer the React Compiler/g), 2);
assert.equal(
  pluginMessages(manualMemo, /memo without a comparator is usually redundant/g),
  2,
);

const compilerOwnedCaching = lint(
  reactFixturePath,
  `
"use client";
import * as React from "react";
import { memo } from "react";
function Row({ id }: { readonly id: string }) {
  "use strict";
  return <span>{id}</span>;
}
const sameRow = (
  previous: { readonly id: string },
  next: { readonly id: string },
) => previous.id === next.id;
export const ComparedRow = memo(Row, sameRow);
export const ComparedReactRow = React.memo(Row, sameRow);
// biome-ignore lint/plugin: the virtual list renders this row for every item.
export const JustifiedRow = memo(Row);
export function List({ ids }: { readonly ids: readonly string[] }) {
  const visible = ids.filter((id) => id.length > 0);
  const onClick = () => visible.length;
  return (
    <button type="button" onClick={onClick}>
      {visible.map((id) => (
        <ComparedRow key={id} id={id} />
      ))}
    </button>
  );
}
`,
);
for (const pattern of [
  /Do not memoize by hand/,
  /Do not steer the React Compiler/,
  /memo without a comparator/,
]) {
  assert.equal(
    pluginMessages(compilerOwnedCaching, pattern),
    0,
    `${compilerOwnedCaching.stdout}${compilerOwnedCaching.stderr}`,
  );
}

console.log(
  "Biome plugins enforce typed Effect errors, no direct React useEffect, and no manual React memoization.",
);
