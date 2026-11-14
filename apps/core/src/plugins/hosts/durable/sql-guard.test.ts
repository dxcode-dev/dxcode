import { describe, expect, it } from "vitest";
import { checkPluginSql } from "./sql-guard.js";

/*
 * ctx.sql shares the Durable Object's SQLite with dx's own tables. Ways a
 * plugin's statement could reach them or the database itself:
 * - naming `_dx_*`, `_cf_*`, or `sqlite_*` tables, quoted, bracketed,
 *   schema-qualified, or inside a trigger or view body;
 * - PRAGMA statements or pragma_* table-valued functions (they list any
 *   table's columns), ATTACH, DETACH, VACUUM, load_extension;
 * - parameters that are not SQL values;
 * - a write disguised as a read (a CTE in front of INSERT) slipping past the
 *   storage quota.
 */
describe("checkPluginSql", () => {
  it.each([
    "SELECT * FROM _dx_jobs",
    'SELECT * FROM "_dx_jobs"',
    "SELECT * FROM [_dx_meta]",
    "SELECT * FROM `_dx_blobs`",
    "SELECT * FROM main._dx_jobs",
    "SELECT name FROM sqlite_master",
    "SELECT * FROM _cf_KV",
    "CREATE TRIGGER t AFTER INSERT ON mine BEGIN DELETE FROM _dx_jobs; END",
    "CREATE VIEW v AS SELECT * FROM _DX_JOBS",
    "PRAGMA table_info(_dx_jobs)",
    "SELECT * FROM pragma_table_info(?)",
    "ATTACH DATABASE 'x' AS y",
    "VACUUM",
    "SELECT load_extension('x')",
  ])("refuses %s", (statement) => {
    expect(checkPluginSql(statement, ["_dx_jobs"])).toHaveProperty("refused");
  });

  it("refuses parameters that are not SQL values", () => {
    expect(checkPluginSql("SELECT ?", [{ a: 1 }])).toHaveProperty("refused");
  });

  it("allows the plugin's own tables and counts CTE writes as writes", () => {
    const read = checkPluginSql("SELECT * FROM my_dx_table WHERE id = ?", [1]);
    expect(read).toEqual({
      statement: "SELECT * FROM my_dx_table WHERE id = ?",
      params: [1],
      writes: false,
    });
    expect(
      checkPluginSql(
        "WITH x AS (SELECT 1) INSERT INTO prs SELECT * FROM x",
        [],
      ),
    ).toMatchObject({ writes: true });
    expect(checkPluginSql("UPDATE prs SET ok = ?", [true])).toMatchObject({
      params: [1],
      writes: true,
    });
  });
});
