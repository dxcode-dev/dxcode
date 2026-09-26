import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "node-unit-contract",
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
