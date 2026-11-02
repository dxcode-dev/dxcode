import { applyD1Migrations, env } from "cloudflare:test";
import { expect, it } from "vitest";

const contents = async (db: D1Database) => {
  const { results: objects } = await db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name NOT LIKE '_cf_%' ORDER BY type, name`,
    )
    .all<{ type: string; name: string; sql: string | null }>();
  const rows: Record<string, unknown[]> = {};
  for (const { type, name } of objects) {
    if (type !== "table") continue;
    // applied_at records when each migration ran, not what it did.
    const columns = name === "d1_migrations" ? "id, name" : "*";
    // Some tables are WITHOUT ROWID, so compare rows as a sorted set.
    rows[name] = (
      await db.prepare(`SELECT ${columns} FROM "${name}"`).all()
    ).results
      .map((row) => JSON.stringify(row))
      .sort();
  }
  return { objects, rows };
};

// Migrate both databases while the file loads, as setup does for env.DB.
await applyD1Migrations(env.MIGRATED_CHECK_DB, env.TEST_MIGRATIONS);
await env.SNAPSHOT_CHECK_DB.batch(
  env.TEST_SCHEMA_SNAPSHOT.map(({ sql, params }) =>
    env.SNAPSHOT_CHECK_DB.prepare(sql).bind(...params),
  ),
);

it("starts test files from exactly the schema and rows the migrations produce", async () => {
  const migrated = await contents(env.MIGRATED_CHECK_DB);
  expect(migrated.objects.length).toBeGreaterThan(100);
  expect(await contents(env.SNAPSHOT_CHECK_DB)).toEqual(migrated);
});
