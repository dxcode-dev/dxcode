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

console.log(
  "Biome plugins enforce typed Effect errors and no direct React useEffect.",
);
