import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "core-flue-lifecycle",
    include: ["test/lifecycle-fixture/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
