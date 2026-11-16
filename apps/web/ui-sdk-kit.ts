import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  UI_SDK_COMPONENTS,
  uiSdkComponentOf,
} from "@dx/api/views/view-frame.mjs";
import { rolldown } from "rolldown";
import type { Plugin } from "vite";

/**
 * `virtual:dx-ui-sdk`: UI SDK's web components for views and plugin frames,
 * as code a sealed frame runs inline. A frame's CSP allows no request, so
 * UI SDK's own loader (which fetches each component) can't run there.
 * Instead the build splits the pinned `@ui-sdk/web` into CommonJS chunks
 * that share its core, and the host inlines only the chunks a view's
 * components need, with a few lines that link them (`uiSdkCode`).
 *
 * Each chunk is a lazy module of its own, so a view downloads only what it
 * uses, and the app's first load downloads none of it.
 */

const VIRTUAL = "virtual:dx-ui-sdk";
const RESOLVED = `\0${VIRTUAL}`;
const CHUNK = `${VIRTUAL}/chunk/`;
const RESOLVED_CHUNK = `\0${CHUNK}`;

interface Built {
  /** Code by chunk file name, such as `select.js` or `c-AbC123.js`. */
  readonly chunks: ReadonlyMap<string, string>;
  /** Each component's chunks: its entry and every chunk it may load. */
  readonly closures: Readonly<Record<string, readonly string[]>>;
  readonly css: string;
}

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("@ui-sdk/web/package.json"));

/**
 * The tags UI SDK defines, by component, from its element manifest. The
 * build fails if `uiSdkComponentOf` would map any of them elsewhere, or if
 * `UI_SDK_COMPONENTS` misses a component, so detection can't drift from
 * the pinned version.
 */
const checkComponents = async () => {
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "custom-elements.json"), "utf8"),
  ) as {
    modules: Array<{
      path: string;
      declarations?: Array<{ tagName?: string }>;
    }>;
  };
  const known = new Set(UI_SDK_COMPONENTS);
  const problems: string[] = [];
  for (const module of manifest.modules) {
    const entry = /^dist\/entries\/(.+)\.js$/.exec(module.path)?.[1];
    const tags = (module.declarations ?? []).flatMap((declaration) =>
      declaration.tagName === undefined ? [] : [declaration.tagName],
    );
    if (entry === undefined || tags.length === 0 || entry === "preferences")
      continue;
    if (!known.has(entry)) problems.push(`${entry} is missing`);
    for (const tag of tags)
      if (uiSdkComponentOf(tag) !== entry)
        problems.push(
          `<${tag}> maps to ${uiSdkComponentOf(tag)}, not ${entry}`,
        );
  }
  if (problems.length > 0)
    throw new Error(
      `UI_SDK_COMPONENTS in view-frame.mjs is out of date with @ui-sdk/web: ${problems.join("; ")}`,
    );
};

/**
 * Rules in UI SDK's stylesheet that style page elements it doesn't own, or
 * the page's color scheme. dx's view kit and `@dxcode/plugin-ui` style those;
 * each must match, so an upgrade that changes them fails the build.
 */
const foreignRules: ReadonlyArray<RegExp> = [
  /^ {4}\/\* Builds that rewrite light-dark\(\)[^\n]*\n {4}--lightningcss-light: initial;\n {4}--lightningcss-dark: ;\n {4}color-scheme: light dark;\n/m,
  /^ {2}a \{\n[\s\S]*?\n {2}\}\n/m,
  /^ {2}:where\(a, button, input, select, textarea, label, summary, \[data-slot\]\) \{\n[\s\S]*?\n {2}\}\n/m,
  /^ {2}:is\(a, summary\):focus-visible \{\n[\s\S]*?\n {2}\}\n/m,
  /^ {2}hr \{\n[\s\S]*?\n {2}\}\n/m,
  /^ {2}code \{\n[\s\S]*?\n {2}\}\n/m,
  /^ {2}kbd \{\n[\s\S]*?\n {2}\}\n/m,
];

/** Comments and runs of whitespace out; the sheet has no strings that hold them. */
const compactCss = (css: string) =>
  css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{};,])\s*/g, "$1")
    .trim();

const buildCss = async () => {
  let css = await readFile(join(packageRoot, "browser/web.css"), "utf8");
  for (const rule of foreignRules) {
    if (!rule.test(css))
      throw new Error(
        `@ui-sdk/web's web.css changed: no match for ${rule.source.slice(0, 60)}`,
      );
    css = css.replace(rule, "");
  }
  const theme = await readFile(
    require.resolve("@dx/api/views/kit/ui-sdk.css"),
    "utf8",
  );
  return compactCss(`${theme}\n${css}`);
};

const buildChunks = async () => {
  const input = Object.fromEntries(
    UI_SDK_COMPONENTS.map((component) => [
      component,
      `@ui-sdk/web/${component}`,
    ]),
  );
  const bundle = await rolldown({
    input,
    platform: "browser",
    cwd: packageRoot,
  });
  const { output } = await bundle.generate({
    format: "cjs",
    minify: true,
    entryFileNames: "[name].js",
    chunkFileNames: "c-[hash].js",
  });
  await bundle.close();
  const chunks = new Map<string, string>();
  const graph = new Map<string, readonly string[]>();
  for (const chunk of output)
    if (chunk.type === "chunk") {
      // Inlined into a <script>: `<!--` or `<script` in the code would make
      // the parser swallow the rest of the view, so a version with either
      // fails the build instead.
      if (/<!--|<script/i.test(chunk.code))
        throw new Error(
          `UI SDK chunk ${chunk.fileName} holds markup that would break its inline <script>`,
        );
      chunks.set(chunk.fileName, chunk.code);
      graph.set(chunk.fileName, [...chunk.imports, ...chunk.dynamicImports]);
    }
  const closure = (file: string, seen = new Set<string>()) => {
    if (seen.has(file)) return seen;
    seen.add(file);
    for (const next of graph.get(file) ?? []) closure(next, seen);
    return seen;
  };
  const closures = Object.fromEntries(
    UI_SDK_COMPONENTS.map((component) => [
      component,
      Array.from(closure(`${component}.js`)).toSorted(),
    ]),
  );
  return { chunks, closures };
};

let built: Promise<Built> | undefined;
const build = () => {
  built ??= (async () => {
    await checkComponents();
    const [{ chunks, closures }, css] = await Promise.all([
      buildChunks(),
      buildCss(),
    ]);
    return { chunks, closures, css };
  })();
  return built;
};

/**
 * The start of the code that links a view's chunks: each chunk registers a
 * factory with `define`, and `require` runs it once. Nothing is left on
 * `window`. `uiSdkCode` adds the chunks and runs each component's entry; a
 * component that throws is reported, and the rest still load.
 */
const PRELUDE = String.raw`(()=>{const f=new Map,c=new Map,define=(n,x)=>f.set(n,x),require=n=>{n=n.replace(/^\.\//,"");let m=c.get(n);if(m)return m.exports;m={exports:{}};c.set(n,m);f.get(n).call(m.exports,require,m,m.exports);return m.exports};`;

const indexModule = ({ chunks, closures, css }: Built) => `
const loaders = {
${[...chunks.keys()]
  .map(
    (file) =>
      `  ${JSON.stringify(file)}: () => import(${JSON.stringify(CHUNK + file)}),`,
  )
  .join("\n")}
};
export const closures = ${JSON.stringify(closures)};
export const css = ${JSON.stringify(css)};
const prelude = ${JSON.stringify(PRELUDE)};
const link = (chunks, entries) =>
  prelude +
  chunks.map(([name, code]) => "define(" + JSON.stringify(name) + ",function(require,module,exports){" + code + "\\n});").join("") +
  "for(const e of " + JSON.stringify(entries) + ")try{require(e)}catch(x){reportError(x)}})();";
/** The styles and code for \`components\`, each a name in UI_SDK_COMPONENTS. */
export const uiSdkCode = async (components) => {
  const files = Array.from(new Set(components.flatMap((name) => closures[name] ?? []))).toSorted();
  const chunks = await Promise.all(
    files.map(async (file) => [file, (await loaders[file]()).default]),
  );
  return {
    css,
    js: link(chunks, components.filter((name) => closures[name]).map((name) => name + ".js")),
  };
};
`;

export const uiSdkKit = (): Plugin => ({
  name: "dx:ui-sdk",
  resolveId(id) {
    if (id === VIRTUAL) return RESOLVED;
    if (id.startsWith(CHUNK)) return `\0${id}`;
    return undefined;
  },
  async load(id) {
    if (id === RESOLVED) return indexModule(await build());
    if (!id.startsWith(RESOLVED_CHUNK)) return undefined;
    const code = (await build()).chunks.get(id.slice(RESOLVED_CHUNK.length));
    if (code === undefined) this.error(`No UI SDK chunk ${id}`);
    return `export default ${JSON.stringify(code)};`;
  },
});
