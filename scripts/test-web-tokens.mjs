import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectWebTokens } from "./check-web-tokens.mjs";

const temporaryRoot = mkdtempSync(join(tmpdir(), "dx-web-tokens-"));
const themes = `
[data-palette="daydream"] { --foreground: light-dark(#000, #fff); --accent: light-dark(#eee, #222); }
[data-palette="deadpan"] { --foreground: light-dark(#111, #ddd); --accent: light-dark(#eee, #222); }
`;

let fixtureIndex = 0;
const inspect = (files) => {
  const displayRoot = join(temporaryRoot, String(fixtureIndex));
  fixtureIndex += 1;
  const sourceRoot = join(displayRoot, "apps/web/src");
  for (const [path, source] of Object.entries({
    "shared/ui/themes.css": themes,
    ...files,
  })) {
    const target = join(sourceRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  return inspectWebTokens({ sourceRoot, displayRoot });
};
const fails = (rule, css, path = "features/demo/demo.css") => {
  const matching = inspect({ [path]: css }).filter(
    (violation) => violation.rule === rule,
  );
  assert(matching.length > 0, `${rule} must fail on ${css}`);
  assert(matching[0].message.length > 40, `${rule} needs actionable guidance`);
};
const passes = (css, path = "features/demo/demo.css") =>
  assert.deepEqual(
    inspect({ [path]: css }).map((violation) => violation.rule),
    [],
    `must pass: ${css}`,
  );

try {
  fails("color-literal", ".a { color: #fff; }");
  fails("color-literal", ".a { background: rgb(0 0 0 / 40%); }");
  fails("color-literal", ".a { --tint: light-dark(#5b3fc4, #c6b8ff); }");
  fails("color-literal", ".a { box-shadow: 0 1px 2px oklch(50% 0.1 20); }");
  fails("font-size-px", ".a { font-size: 12px; }");
  fails("font-size-px", ".a { font: 11px / 1.4 var(--font-mono); }");
  fails("font-family", ".a { font-family: monospace; }");
  fails("font-family", ".a { font: var(--text-sm) system-ui; }");
  fails("radius-px", ".a { border-radius: 6px; }");
  fails("radius-px", ".a { border-top-left-radius: 5px; }");
  fails(
    "theme-contract",
    `[data-palette="daydream"] { --foreground: #000; --accent: #eee; }
[data-palette="neon"] { --foreground: #0f0; }`,
    "shared/ui/themes.css",
  );

  passes(
    `.a {
  color: var(--foreground);
  background: color-mix(in srgb, var(--accent) 40%, transparent);
  border: 1px solid currentColor;
  font: var(--weight-medium) var(--text-sm) / var(--leading-4) var(--font-ui);
  font-size: 0.9em;
  font-family: var(--font-mono);
  border-radius: var(--radius-md) var(--radius-md) 0 0;
  outline-offset: 2px;
  background-image: url("data:image/svg+xml,%3Csvg fill='%23fff'/%3E");
  --hue-color: oklch(56% 0.15 var(--thread-hue));
}
.b { border-radius: 2px; font: inherit; }`,
  );
  passes(".a { color: #fff; }", "features/marketing/landing.css");
  passes(".a { color: #0b0d0b; }", "shared/ui/tokens.css");
  passes("body { background: #0b0d0b; }", "public-root.css");
  console.log("Design token fixtures prove every rule and clean input.");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
