// Links plugin frames and dx-views to the design system. The design-system
// block of packages/api/src/views/view-frame.mjs (between its BEGIN and END
// markers) is generated here from the Web app's themes.css and tokens.css:
// every palette block, the contrast and forced-colors overrides, and the
// tokens the frames map to MCP Apps style variables. view-frame.mjs stays one
// self-contained file, because the creating-views skill runs a copy of it.
//
//   node scripts/plugin-theme.mjs          rewrites the block
//   node scripts/check-web-tokens.mjs      fails while the block is stale
//
// A new palette in themes.css reaches plugin frames and dx-views once this
// runs; until then `pnpm lint` fails. See wiki/ui-design-system.md.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postcss from "postcss";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const uiRoot = join(repositoryRoot, "apps/web/src/shared/ui");
export const VIEW_FRAME_PATH = join(
  repositoryRoot,
  "packages/api/src/views/view-frame.mjs",
);

/** The palette variables the frames use (each palette must set them). */
export const THEME_VARIABLES = [
  "--surface",
  "--foreground",
  "--muted-foreground",
  "--muted",
  "--secondary",
  "--accent",
  "--primary",
  "--primary-foreground",
  "--input",
  "--border",
  "--divider",
  "--unread",
  "--ring",
  "--destructive",
  "--success",
  "--warning",
];

/** The tokens.css values the frames use. */
export const TOKEN_VARIABLES = [
  "--font-ui",
  "--font-mono-family",
  "--text-xs",
  "--text-sm",
  "--text-md",
  "--text-lg",
  "--text-xl",
  "--text-2xl",
  "--text-3xl",
  "--leading-4",
  "--leading-4-5",
  "--leading-5",
  "--leading-6",
  "--weight-medium",
  "--weight-semibold",
  "--radius-xs",
  "--radius-sm",
  "--radius-md",
  "--radius-xl",
  "--radius-full",
  "--shadow-sm",
  "--shadow-md",
  "--shadow-lg",
];

const MEDIA = {
  more: "(prefers-contrast: more)",
  forced: "(forced-colors: active)",
};

const clean = (value) =>
  value.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();

/** `value` split on commas outside parentheses. */
const splitTop = (value) => {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
};

/** `[light, dark]` for a `light-dark(...)` value, else the value twice. */
const pair = (value) => {
  const match = /^light-dark\((.*)\)$/s.exec(value);
  if (match === null) return [value, value];
  const parts = splitTop(match[1] ?? "");
  if (parts.length !== 2) throw new Error(`Bad light-dark(): ${value}`);
  return /** @type {[string, string]} */ (parts);
};

const declarations = (rule) =>
  Object.fromEntries(
    rule.nodes
      .filter((node) => node.type === "decl" && node.prop.startsWith("--"))
      .map((node) => [node.prop, clean(node.value)]),
  );

/**
 * The design system as the frames use it, read from themes.css and
 * tokens.css. Throws when a palette or token the frames map is missing.
 */
export const readDesignSystem = ({
  themes = readFileSync(join(uiRoot, "themes.css"), "utf8"),
  tokens = readFileSync(join(uiRoot, "tokens.css"), "utf8"),
} = {}) => {
  const palettes = {};
  const contrast = {};
  postcss.parse(themes).walkRules((rule) => {
    const palette = /\[data-palette="([\w-]+)"\]/.exec(rule.selector);
    if (palette !== null && rule.parent?.type === "root") {
      const name = /** @type {string} */ (palette[1]);
      const block = declarations(rule);
      const resolve = (value, seen = new Set()) => {
        const reference = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
        if (reference === undefined || seen.has(reference)) return value;
        const target = block[reference];
        if (target === undefined)
          throw new Error(`${name} palette: ${reference} is not set`);
        return resolve(target, new Set([...seen, reference]));
      };
      palettes[name] = Object.fromEntries(
        THEME_VARIABLES.map((variable) => {
          const value = block[variable];
          if (value === undefined)
            throw new Error(
              `The ${name} palette in themes.css misses ${variable}, which plugin frames and dx-views use.`,
            );
          return [variable, pair(resolve(value))];
        }),
      );
      return;
    }
    if (rule.parent?.type !== "atrule" || rule.parent.name !== "media") return;
    const params = clean(rule.parent.params);
    for (const [key, media] of Object.entries(MEDIA))
      if (params === media) contrast[key] = declarations(rule);
  });
  if (palettes.daydream === undefined)
    throw new Error("themes.css has no Daydream palette.");
  for (const key of Object.keys(MEDIA))
    if (contrast[key] === undefined)
      throw new Error(`themes.css has no ${MEDIA[key]} block.`);
  const values = {};
  postcss.parse(tokens).walkRules((rule) => {
    if (rule.selector.trim() === ":root")
      Object.assign(values, declarations(rule));
  });
  const design = Object.fromEntries(
    TOKEN_VARIABLES.map((variable) => {
      const value = values[variable];
      if (value === undefined)
        throw new Error(
          `tokens.css misses ${variable}, which plugin frames use.`,
        );
      return [variable, value];
    }),
  );
  return { palettes, contrast, tokens: design };
};

const BEGIN = "// BEGIN design system";
const END = "// END design system";

const block = (design) =>
  `${BEGIN}: generated by scripts/plugin-theme.mjs from the Web app's\n` +
  "// shared/ui/themes.css and tokens.css. Do not edit it here: change those\n" +
  "// files, then run `node scripts/plugin-theme.mjs`. `pnpm lint` fails while\n" +
  "// it is stale. Palettes are `[light, dark]` pairs.\n" +
  `export const DESIGN_SYSTEM = ${JSON.stringify(design, null, 2)};\n` +
  END;

/** `source` (view-frame.mjs) with its design-system block replaced. */
export const withDesignSystem = (source, design) => {
  const start = source.indexOf(BEGIN);
  const end = source.indexOf(END);
  if (start === -1 || end === -1)
    throw new Error("view-frame.mjs has no design-system block.");
  return (
    source.slice(0, start) + block(design) + source.slice(end + END.length)
  );
};

const main = () => {
  const source = readFileSync(VIEW_FRAME_PATH, "utf8");
  writeFileSync(VIEW_FRAME_PATH, withDesignSystem(source, readDesignSystem()));
  execFileSync(
    join(repositoryRoot, "node_modules/.bin/biome"),
    ["format", "--write", VIEW_FRAME_PATH],
    { stdio: "inherit" },
  );
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
