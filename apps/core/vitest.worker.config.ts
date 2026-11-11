import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

type D1Migration = { readonly name: string; readonly queries: string[] };
type SnapshotStatement = {
  readonly sql: string;
  readonly params: ReadonlyArray<string | number | null>;
};

// Applying every migration took each test file about 1.2 s, a third of its
// setup. The config applies them once, with SQLite in Node, exactly as
// applyD1Migrations would (one transaction per migration, then its
// d1_migrations row), and hands each file the resulting schema and rows as
// one batch. schema-snapshot.test.ts proves the batch matches migrating D1.
const schemaSnapshot = (
  migrations: ReadonlyArray<D1Migration>,
): ReadonlyArray<SnapshotStatement> => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE IF NOT EXISTS "d1_migrations" (
\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,
\t\tname       TEXT UNIQUE,
\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
\t);`);
  const record = db.prepare('INSERT INTO "d1_migrations" (name) VALUES (?);');
  for (const migration of migrations) {
    db.exec("BEGIN");
    for (const query of migration.queries) db.exec(query);
    record.run(migration.name);
    db.exec("COMMIT");
  }
  const objects = db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
       ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1
                WHEN 'view' THEN 2 ELSE 3 END, rowid`,
    )
    .all() as Array<{ type: string; name: string; sql: string }>;
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const rows = objects
    .filter(({ type }) => type === "table")
    .flatMap(({ name }) =>
      (
        db.prepare(`SELECT * FROM ${quote(name)}`).all() as Array<
          Record<string, unknown>
        >
      ).map((row) => {
        const params = Object.values(row).map((value) => {
          if (
            value === null ||
            typeof value === "string" ||
            typeof value === "number"
          )
            return value;
          throw new Error(
            `Migrated table ${name} holds a ${typeof value} the snapshot cannot carry.`,
          );
        });
        return {
          sql: `INSERT INTO ${quote(name)} (${Object.keys(row).map(quote).join(", ")}) VALUES (${params.map(() => "?").join(", ")})`,
          params,
        };
      }),
    );
  // AUTOINCREMENT counters, including the ones a rebuilt table left at 0.
  const sequences = (
    db.prepare("SELECT name, seq FROM sqlite_sequence").all() as Array<{
      name: string;
      seq: number;
    }>
  ).map(({ name, seq }) => ({
    sql: "INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)",
    params: [name, seq],
  }));
  db.close();
  // Triggers come last, after the rows, so seeding fires none of them.
  return [
    ...objects
      .filter(({ type }) => type !== "trigger")
      .map(({ sql }) => ({ sql, params: [] })),
    ...rows,
    // Seeding rows already counted some; replace the counters wholesale.
    { sql: "DELETE FROM sqlite_sequence", params: [] },
    ...sequences,
    ...objects
      .filter(({ type }) => type === "trigger")
      .map(({ sql }) => ({ sql, params: [] })),
  ];
};

const testMigrations = await (async () => {
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
      throw new Error(`Canonical D1 migration was not loaded: ${filename}`);
    }
    return migration;
  });
})();

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
          TEST_MIGRATIONS: testMigrations,
          TEST_SCHEMA_SNAPSHOT: schemaSnapshot(testMigrations),
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
    // Each test drives a workerd isolate and real D1: 1-2 s alone, and a full
    // run on a few cores stretches that past vitest's 5 s unit-test default
    // (spaces-gate ran 7.2 s, claude-plan-pick 5.3 s). Lifecycle tests get
    // the same 30 s.
    testTimeout: 30_000,
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
