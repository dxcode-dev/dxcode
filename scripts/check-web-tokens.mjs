// Keeps the Web app's CSS on the design tokens, so a token or theme change
// reaches every screen. See wiki/ui-design-system.md.
//
// Rules, for every shipped stylesheet under apps/web/src except the token
// sources (shared/ui/tokens.css, shared/ui/themes.css), the brand kit
// (shared/brand), the marketing site, and prototypes:
//
//   color-literal   No hex, rgb(), hsl(), hwb(), lab(), lch(), oklab(), or
//                   oklch() color. Use a palette variable (--foreground,
//                   --muted-foreground, --accent, …) or a token from
//                   tokens.css, mixed with color-mix() when you need a tint.
//                   A color function whose arguments read a variable (a
//                   per-element hue formula) is allowed.
//   font-size-px    No px or rem font size. Use --text-* (or a relative em
//                   or %); text fields on touch screens use
//                   --text-input-touch.
//   font-family     Only var(--font-ui), var(--font-mono), var(--font-code),
//                   or inherit.
//   radius-px       No px corner radius above 2px. Use --radius-*; 1px and
//                   2px hairlines are allowed.
//   theme-contract  Every palette block in themes.css sets every variable in
//                   its contract (the Daydream block defines the contract).
//
// public-root.css paints the page before any theme loads, so its two boot
// backgrounds are literal; it is exempt from color-literal.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postcss from "postcss";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultSourceRoot = join(repositoryRoot, "apps/web/src");

const messages = {
  "color-literal":
    "Use a palette variable from shared/ui/themes.css (--foreground, --muted-foreground, --accent, --border, --success, …) or a color token from shared/ui/tokens.css; tint with color-mix(in srgb, var(--x) N%, transparent). A new color with a meaning belongs in tokens.css, derived from the palette.",
  "font-size-px":
    "Use a type token: --text-4xs 8, --text-3xs 9, --text-2xs 10, --text-xs 11, --text-sm 12, --text-md 13, --text-lg 14, --text-xl 16, --text-heading 18, --text-2xl 20, --text-3xl 24 (px); --text-code for code; --text-input-touch for a touch text field; or a relative em.",
  "font-family":
    "Use var(--font-ui) for interface text, var(--font-mono) for code and numbers, or var(--font-code) for transcript code.",
  "radius-px":
    "Use a radius token: --radius-xs 4, --radius-sm 6, --radius-md 8, --radius-lg 10, --radius-xl 12, --radius-2xl 16, --radius-3xl 20, --radius-4xl 24, --radius-full (px). 1px and 2px hairlines may stay.",
  "theme-contract":
    "Every palette block in shared/ui/themes.css sets every contract variable, each as light-dark(<light>, <dark>); copy the missing one from the Daydream block and give it this palette's values.",
};

const exempt = (path) =>
  /(^|\/)(features\/marketing|prototypes|shared\/brand)\//.test(path) ||
  /(^|\/)shared\/ui\/(tokens|themes)\.css$/.test(path);
const colorExempt = (path) => /(^|\/)public-root\.css$/.test(path);

const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });

const colorFunction =
  /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/gi;
const hexColor = /#[0-9a-f]{3,8}\b/i;

/** The value with url(...) removed, so data URLs and their hashes pass. */
const withoutUrls = (value) =>
  value.replace(/url\((?:[^()]|\([^()]*\))*\)/g, "");

const colorLiteral = (value) => {
  const plain = withoutUrls(value);
  if (hexColor.test(plain)) return true;
  for (const [, , args] of plain.matchAll(colorFunction))
    if (!args.includes("var(")) return true;
  return false;
};

const pxOrRem = /\b\d+(\.\d+)?(px|rem)\b/;
const fontShorthandSize = (value) => {
  // The size is the token before an optional "/ line-height".
  const beforeSlash = value.split("/")[0] ?? "";
  return /\b\d+(\.\d+)?(px|rem)\b/.test(beforeSlash);
};
const allowedFamily = /^(var\(--font-(ui|mono|code)\)|inherit)$/;
const radiusPx = (value) =>
  [...value.matchAll(/\b(\d+(?:\.\d+)?)px\b/g)].some(
    ([, size]) => Number(size) > 2,
  );

/** Variables each palette block must set: the Daydream block's. */
const contractOf = (root) => {
  let contract;
  const blocks = [];
  root.walkRules((rule) => {
    const palette = rule.selector.match(/\[data-palette="([\w-]+)"\]/);
    if (palette === null || rule.parent?.type !== "root") return;
    const variables = new Set(
      rule.nodes
        .filter((node) => node.type === "decl" && node.prop.startsWith("--"))
        .map((node) => node.prop),
    );
    blocks.push({ name: palette[1], rule, variables });
    if (palette[1] === "daydream") contract = variables;
  });
  return { contract: contract ?? new Set(), blocks };
};

export const inspectWebTokens = ({
  sourceRoot = defaultSourceRoot,
  displayRoot = repositoryRoot,
} = {}) => {
  const violations = [];
  const add = (rule, path, node, evidence) =>
    violations.push({
      rule,
      path: relative(displayRoot, path).split(sep).join("/"),
      line: node.source?.start?.line ?? 0,
      column: node.source?.start?.column ?? 0,
      evidence,
      message: messages[rule],
    });
  for (const path of walk(sourceRoot).filter((file) => file.endsWith(".css"))) {
    const display = relative(sourceRoot, path).split(sep).join("/");
    const root = postcss.parse(readFileSync(path, "utf8"), { from: path });
    if (/(^|\/)shared\/ui\/themes\.css$/.test(display)) {
      const { contract, blocks } = contractOf(root);
      for (const block of blocks)
        for (const variable of contract)
          if (!block.variables.has(variable))
            add(
              "theme-contract",
              path,
              block.rule,
              `${block.name} misses ${variable}`,
            );
      continue;
    }
    if (exempt(display)) continue;
    root.walkDecls((decl) => {
      const { prop, value } = decl;
      const evidence = `${prop}: ${value.replace(/\s+/g, " ").slice(0, 80)}`;
      if (!colorExempt(display) && colorLiteral(value))
        add("color-literal", path, decl, evidence);
      if (prop === "font-size" && pxOrRem.test(withoutUrls(value)))
        add("font-size-px", path, decl, evidence);
      if (prop === "font" && fontShorthandSize(value))
        add("font-size-px", path, decl, evidence);
      if (prop === "font-family" && !allowedFamily.test(value.trim()))
        add("font-family", path, decl, evidence);
      if (
        prop === "font" &&
        value.trim() !== "inherit" &&
        !/var\(--font-(ui|mono|code)\)\s*$/.test(value.trim())
      )
        add("font-family", path, decl, evidence);
      if (/^border(-[a-z]+)*-radius$/.test(prop) && radiusPx(value))
        add("radius-px", path, decl, evidence);
    });
  }
  return violations.sort((left, right) =>
    `${left.path}:${left.line}`.localeCompare(`${right.path}:${right.line}`),
  );
};

const main = () => {
  const violations = inspectWebTokens();
  for (const violation of violations)
    console.error(
      `${violation.path}:${violation.line}:${violation.column} tokens/${violation.rule} ERROR ${violation.evidence} — ${violation.message}`,
    );
  if (violations.length > 0) {
    console.error(
      `Design token check failed: ${violations.length} violation(s).`,
    );
    process.exitCode = 1;
    return;
  }
  console.log("Design token check passed with zero violations.");
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
