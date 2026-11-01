import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { loadMigrationManifest } from "../../scripts/migration-manifest.mjs";

// Each test file starts a fresh Worker that imports all of Core. Loading every
// dependency module by module cost about 9 s per file, so Vite pre-bundles the
// packages Core and its tests import, every subpath included: a subpath left
// out would load beside its bundle as a second copy of the package.
const prebundledPackageImports = () => {
  const roots = [
    "src",
    "test/worker",
    "../../packages/domain/src",
    "../../packages/api/src",
  ];
  // QuickJS ships WebAssembly that the root config compiles as Workerd does.
  const unbundled = /^(vitest|@jitl\/quickjs-|quickjs-emscripten)/;
  const imports = new Set<string>();
  const scan = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(entryPath);
      else if (/\.tsx?$/.test(entry.name))
        for (const [, specifier] of readFileSync(entryPath, "utf8").matchAll(
          /(?:\bfrom|\bimport\(?)\s*["']([^"'./][^"']*)["']/g,
        ))
          if (
            specifier !== undefined &&
            !/^(node|cloudflare|workerd):|^@dx\//.test(specifier) &&
            !builtinModules.includes(specifier) &&
            !unbundled.test(specifier)
          )
            imports.add(specifier);
    }
  };
  for (const root of roots) scan(path.join(import.meta.dirname, root));
  return [...imports]
    .filter((specifier) => {
      try {
        import.meta.resolve(specifier);
        return true;
      } catch {
        return false;
      }
    })
    .sort();
};

export default defineConfig({
  define: {
    __DX_CORE_DEV_FIXTURES__: "true",
    // DX_RECORD_SPAN_BASELINE=1 (with -u) rewrites artifacts/message-journey/baseline.json.
    __DX_RECORD_SPAN_BASELINE__: JSON.stringify(
      process.env.DX_RECORD_SPAN_BASELINE === "1",
    ),
    // DX_RECORD_D1_CALLS=<name> (with -u) writes artifacts/request-d1-calls/<name>.json.
    __DX_RECORD_D1_CALLS__: JSON.stringify(
      /^[\w-]+$/.test(process.env.DX_RECORD_D1_CALLS ?? "")
        ? process.env.DX_RECORD_D1_CALLS
        : "",
    ),
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
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: prebundledPackageImports(),
          rolldownOptions: {
            external: [/^(node|cloudflare|workerd):/, ...builtinModules],
          },
        },
      },
    },
  },
});
