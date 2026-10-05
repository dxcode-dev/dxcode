import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Workerd imports `.wasm` files as compiled modules; Node would treat them as
// ES module integrations instead, so compile them the same way under test.
const compiledWasmQuery = "?dx-compiled-wasm";

export default defineConfig({
  plugins: [
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
      "**/dist/**",
      "**/node_modules/**",
    ],
  },
});
