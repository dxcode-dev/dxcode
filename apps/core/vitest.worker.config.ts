import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { loadMigrationManifest } from "../../scripts/migration-manifest.mjs";

export default defineConfig({
  define: {
    __DX_CORE_DEV_FIXTURES__: "true",
  },
  plugins: [
    cloudflareTest(async () => ({
      main: "./src/cloudflare.ts",
      wrangler: { configPath: "./test/wrangler.test.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await (async () => {
            const manifest = await loadMigrationManifest();
            const migrations = await readD1Migrations(
              path.join(import.meta.dirname, "migrations"),
            );
            const migrationsByName = new Map(
              migrations.map((migration) => [migration.name, migration]),
            );
            return manifest.d1.map(({ filename }) => {
              const migration = migrationsByName.get(filename);
              if (migration === undefined) {
                throw new Error(
                  `Canonical D1 migration was not loaded: ${filename}`,
                );
              }
              return migration;
            });
          })(),
        },
      },
    })),
  ],
  test: {
    name: "core-worker-d1",
    include: ["test/worker/**/*.test.ts"],
    setupFiles: [
      "./test/worker/network-boundary.ts",
      "./test/worker/apply-migrations.ts",
    ],
    fileParallelism: true,
  },
});
