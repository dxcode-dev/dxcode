/**
 * `ctx.sql` runs the plugin's statements on its Durable Object's SQLite,
 * where dx keeps its own tables (`_dx_*`) and Cloudflare keeps `_cf_*`.
 * A statement may not name those, SQLite's internals, or change the
 * database itself (PRAGMA, ATTACH, VACUUM). Identifiers in SQL cannot be
 * computed, so checking the text is enough: a reserved name must appear in
 * it, quoted or not, to be reached.
 */

const RESERVED = /(?:^|[^A-Za-z0-9_$])["'`[]?(?:_dx_|_cf_|sqlite_)/i;
// `pragma` also catches the pragma_* table-valued functions.
const FORBIDDEN = /\b(?:pragma|ATTACH|DETACH|VACUUM|load_extension)/i;
/** A statement that may write; refused once the storage quota is used. */
const WRITES = /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i;

export const MAX_SQL_STATEMENT_CHARS = 100_000;
export const MAX_SQL_PARAMS = 100;
export const MAX_SQL_ROWS = 10_000;

export type SqlRefusal = { readonly refused: string };

export const checkPluginSql = (
  statement: unknown,
  params: unknown,
):
  | SqlRefusal
  | {
      readonly statement: string;
      readonly params: ReadonlyArray<SqlStorageValue>;
      readonly writes: boolean;
    } => {
  if (typeof statement !== "string" || statement.trim() === "")
    return { refused: "ctx.sql.exec takes an SQL statement." };
  if (statement.length > MAX_SQL_STATEMENT_CHARS)
    return {
      refused: `An SQL statement is at most ${MAX_SQL_STATEMENT_CHARS} characters.`,
    };
  if (RESERVED.test(statement))
    return {
      refused:
        "Tables named _dx_, _cf_, or sqlite_ are dx's own; use other names.",
    };
  if (FORBIDDEN.test(statement))
    return {
      refused:
        "PRAGMA, ATTACH, DETACH, VACUUM, and load_extension are not allowed.",
    };
  if (!Array.isArray(params) || params.length > MAX_SQL_PARAMS)
    return { refused: `Bind at most ${MAX_SQL_PARAMS} parameters.` };
  const values: Array<SqlStorageValue> = [];
  for (const param of params) {
    if (
      param === null ||
      typeof param === "string" ||
      typeof param === "number"
    )
      values.push(param);
    else if (typeof param === "boolean") values.push(param ? 1 : 0);
    else if (param instanceof ArrayBuffer) values.push(param);
    else
      return {
        refused:
          "Parameters are text, numbers, booleans, null, or ArrayBuffers.",
      };
  }
  return { statement, params: values, writes: WRITES.test(statement) };
};
