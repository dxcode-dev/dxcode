import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { WeightedShardSequencer } from "./scripts/test-shard-sequencer.js";

// Workerd imports `.wasm` files as compiled modules; Node would treat them as
// ES module integrations instead, so compile them the same way under test.
const compiledWasmQuery = "?dx-compiled-wasm";

// The web app ships compiled by the React Compiler and has no manual
// memoization, so its tests compile the same sources with the same transform
// as `react({ compiler: true })`. Test files stay plain, like production.
const { transformSync: compileReact } = createRequire(
  new URL("./apps/web/package.json", import.meta.url),
)("oxc-transform-react") as typeof import("oxc-transform-react");
const compiledWebSource = /\/apps\/web\/src\/(?!.*\.test\.tsx?$).*\.tsx?$/;

export default defineConfig({
  plugins: [
    {
      name: "dx-react-compiler",
      enforce: "pre",
      transform(code, id) {
        const [path] = id.split("?");
        if (path === undefined || !compiledWebSource.test(path)) return null;
        const result = compileReact(path, code, {
          jsx: { runtime: "automatic", development: false, refresh: false },
          reactCompiler: true,
          sourcemap: true,
        });
        if (result.fatal)
          throw new Error(result.errors.map((e) => e.message).join("\n"));
        return { code: result.code, map: result.map };
      },
    },
    {
      name: "dx-compiled-wasm",
      enforce: "pre",
      async resolveId(source, importer) {
        if (!source.endsWith(".wasm")) return null;
        const resolved = await this.resolve(source, importer, {
          skipSelf: true,
        });
        return resolved && `${resolved.id}${compiledWasmQuery}`;
      },
      load(id) {
        if (!id.endsWith(compiledWasmQuery)) return null;
        const bytes = readFileSync(id.slice(0, -compiledWasmQuery.length));
        return `export default new WebAssembly.Module(Uint8Array.from(atob(${JSON.stringify(bytes.toString("base64"))}), (c) => c.charCodeAt(0)));`;
      },
    },
  ],
  test: {
    sequence: { sequencer: WeightedShardSequencer },
    // Console output from passing tests buried CI failures in thousands of lines.
    silent: "passed-only",
    projects: [
      {
        extends: true,
        test: {
          name: "node-unit-contract",
          server: { deps: { inline: [/\.wasm\?dx-compiled-wasm$/] } },
          setupFiles: [
            fileURLToPath(
              new URL("./scripts/test-network-setup.ts", import.meta.url),
            ),
          ],
          exclude: [
            "internal/**",
            "apps/core/test/worker/**/*.test.ts",
            "apps/core/test/lifecycle-fixture/**/*.test.ts",
            "**/*.eval.test.ts",
            "**/*.browser.test.{ts,tsx}",
            "**/dist/**",
            "**/node_modules/**",
          ],
        },
      },
      // React rendering tests run compiled, in headless Chromium.
      "apps/web/vitest.browser.config.ts",
    ],
  },
});
