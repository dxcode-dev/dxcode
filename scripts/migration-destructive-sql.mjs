// Reads D1 migration SQL for statements that lose data, so a migration the
// manifest (apps/core/migration-manifest.json) files as non-destructive cannot
// drop a table, drop a column, or delete rows. scripts/migration-manifest.mjs
// runs it on every migration in order.
//
// Outside trigger bodies, which run later on writes, these statements lose
// data:
// - DELETE FROM, TRUNCATE, and ALTER TABLE … DROP [COLUMN], unless the
//   migration created the table and copied no rows into it.
// - DROP TABLE t, unless the migration created t and t holds no rows copied
//   out of a table dropped since, or earlier copies carried every row and
//   column of t into tables that outlive the migration. A copy is
//   `INSERT INTO u … SELECT … FROM t` or `CREATE TABLE u AS SELECT … FROM t`
//   with no WHERE, JOIN, DISTINCT, GROUP BY, or LIMIT; it carries the columns
//   of t its select list names. SQLite's table rebuild passes in both orders
//   (create, copy, drop, rename; or rename, create, copy, drop), and so does
//   moving a table's columns into several tables. A rebuild that leaves a
//   column or a row behind fails.
// UPDATE and INSERT OR REPLACE rewrite rows in place and are not read.
//
// Comments and string literals are skipped. Each statement runs in an
// in-memory SQLite database, so the check knows every table's columns.

const keyword = (token, ...values) =>
  token?.kind === "word" && values.includes(token.upper);

/** Splits SQL into tokens, dropping comments and whitespace. */
export const tokenize = (sql) => {
  const tokens = [];
  let index = 0;
  const push = (kind, value, start) =>
    tokens.push({
      kind,
      value,
      upper: kind === "word" ? value.toUpperCase() : value,
      quoted: false,
      start,
      end: index,
    });
  const quoted = (close, kind) => {
    const start = index;
    index += 1;
    let value = "";
    while (index < sql.length) {
      if (sql[index] === close) {
        if (close !== "]" && sql[index + 1] === close) {
          value += close;
          index += 2;
          continue;
        }
        index += 1;
        push(kind, value, start);
        if (kind === "word") tokens.at(-1).quoted = true;
        return;
      }
      value += sql[index];
      index += 1;
    }
    throw new Error(`Unterminated ${close} quote at offset ${start}.`);
  };
  while (index < sql.length) {
    const char = sql[index];
    if (/\s/.test(char)) {
      index += 1;
    } else if (sql.startsWith("--", index)) {
      const newline = sql.indexOf("\n", index);
      index = newline === -1 ? sql.length : newline + 1;
    } else if (sql.startsWith("/*", index)) {
      const close = sql.indexOf("*/", index + 2);
      index = close === -1 ? sql.length : close + 2;
    } else if (char === "'") {
      quoted("'", "string");
    } else if (char === '"') {
      quoted('"', "word");
    } else if (char === "`") {
      quoted("`", "word");
    } else if (char === "[") {
      quoted("]", "word");
    } else if (/[A-Za-z_]/.test(char)) {
      const start = index;
      while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index])) index += 1;
      push("word", sql.slice(start, index), start);
    } else {
      const start = index;
      index += 1;
      push("punct", char, start);
    }
  }
  return tokens;
};

/**
 * Splits a migration into statements. A CREATE TRIGGER statement runs to the
 * END that closes its BEGIN, so the semicolons in its body do not split it.
 */
export const splitStatements = (sql) => {
  const statements = [];
  let current = [];
  let depth = 0;
  const finish = () => {
    if (current.length > 0) {
      statements.push({
        tokens: current,
        text: sql.slice(current[0].start, current.at(-1).end),
      });
    }
    current = [];
    depth = 0;
  };
  for (const token of tokenize(sql)) {
    if (token.kind === "punct" && token.value === ";" && depth === 0) {
      finish();
      continue;
    }
    current.push(token);
    if (!isTrigger(current) || token.quoted) continue;
    if (keyword(token, "BEGIN", "CASE")) depth += 1;
    else if (keyword(token, "END") && depth > 0) depth -= 1;
  }
  finish();
  return statements;
};

const isTrigger = (tokens) => {
  if (!keyword(tokens[0], "CREATE")) return false;
  const next = keyword(tokens[1], "TEMP", "TEMPORARY") ? tokens[2] : tokens[1];
  return keyword(next, "TRIGGER");
};

/** The table name at `index`, without a schema prefix, and the index after it. */
const tableName = (tokens, index) => {
  let at = index;
  if (keyword(tokens[at], "IF")) at += keyword(tokens[at + 1], "NOT") ? 3 : 2;
  let name = tokens[at];
  if (tokens[at + 1]?.value === "." && tokens[at + 1].kind === "punct") {
    at += 2;
    name = tokens[at];
  }
  if (name?.kind !== "word") return undefined;
  return { name: name.value.toLowerCase(), next: at + 1 };
};

/** Tokens at parenthesis depth zero, with their index. */
const topLevel = (tokens, from = 0) => {
  const result = [];
  let depth = 0;
  for (let index = from; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === "punct" && token.value === "(") depth += 1;
    else if (token.kind === "punct" && token.value === ")") depth -= 1;
    else if (depth === 0) result.push({ token, index });
  }
  return result;
};

// Words that can follow `FROM table` and are not an alias.
const clauses = [
  "WHERE",
  "JOIN",
  "LEFT",
  "RIGHT",
  "FULL",
  "INNER",
  "OUTER",
  "CROSS",
  "NATURAL",
  "GROUP",
  "HAVING",
  "ORDER",
  "LIMIT",
  "WINDOW",
  "UNION",
  "EXCEPT",
  "INTERSECT",
  "ON",
  "RETURNING",
  "INDEXED",
  "NOT",
];

/**
 * The source of a whole-table copy, `SELECT <list> FROM <table> [[AS] alias]
 * [ORDER BY …]`, starting at the SELECT token. Undefined when the select
 * filters, joins, or groups rows.
 */
const fullCopy = (tokens, selectIndex) => {
  if (!keyword(tokens[selectIndex], "SELECT")) return undefined;
  const distinct = keyword(tokens[selectIndex + 1], "DISTINCT");
  const top = topLevel(tokens, selectIndex + 1);
  const from = top.find(({ token }) => keyword(token, "FROM"));
  if (from === undefined) return undefined;
  const source = tableName(tokens, from.index + 1);
  if (source === undefined) return undefined;
  const selected = tokens.slice(selectIndex + 1, from.index);
  let rest = tokens.slice(source.next);
  if (keyword(rest[0], "AS")) rest = rest.slice(2);
  else if (rest[0]?.kind === "word" && !keyword(rest[0], ...clauses))
    rest = rest.slice(1);
  const filtered = distinct || (rest.length > 0 && !keyword(rest[0], "ORDER"));
  return { source: source.name, selected, filtered };
};

/** What one statement does to tables, as far as data loss goes. */
const describe = (tokens) => {
  const [first, second] = tokens;
  if (keyword(first, "TRUNCATE")) return { kind: "truncate" };
  if (
    tokens.some(
      (token, index) =>
        keyword(token, "DELETE") && keyword(tokens[index + 1], "FROM"),
    )
  ) {
    const at = tokens.findIndex((token) => keyword(token, "DELETE"));
    return { kind: "delete", table: tableName(tokens, at + 2)?.name };
  }
  if (keyword(first, "DROP") && keyword(second, "TABLE"))
    return { kind: "drop", table: tableName(tokens, 2)?.name };
  if (keyword(first, "ALTER") && keyword(second, "TABLE")) {
    const table = tableName(tokens, 2);
    const verb = tokens[table?.next ?? 0];
    if (keyword(verb, "DROP")) {
      const columnAt = keyword(tokens[table.next + 1], "COLUMN")
        ? table.next + 2
        : table.next + 1;
      return {
        kind: "drop-column",
        table: table.name,
        column: tokens[columnAt]?.value,
      };
    }
    if (
      keyword(verb, "RENAME") &&
      keyword(tokens[table.next + 1], "TO") &&
      tokens[table.next + 2]?.kind === "word"
    ) {
      return {
        kind: "rename",
        from: table.name,
        to: tokens[table.next + 2].value.toLowerCase(),
      };
    }
    return { kind: "other" };
  }
  if (keyword(first, "CREATE")) {
    const at = keyword(second, "TEMP", "TEMPORARY") ? 2 : 1;
    if (!keyword(tokens[at], "TABLE")) return { kind: "other" };
    const table = tableName(tokens, at + 1);
    if (table === undefined) return { kind: "other" };
    const copy = keyword(tokens[table.next], "AS")
      ? fullCopy(tokens, table.next + 1)
      : undefined;
    return { kind: "create", table: table.name, copy };
  }
  if (keyword(first, "INSERT", "REPLACE")) {
    const into = tokens.findIndex((token) => keyword(token, "INTO"));
    const table = into === -1 ? undefined : tableName(tokens, into + 1);
    if (table === undefined) return { kind: "other" };
    let at = table.next;
    if (keyword(tokens[at], "AS")) at += 2;
    if (tokens[at]?.value === "(") {
      at = topLevel(tokens, at).find(({ index }) => index > at)?.index ?? at;
    }
    return {
      kind: "insert",
      table: table.name,
      copy: fullCopy(tokens, at),
    };
  }
  return { kind: "other" };
};

const columnsOf = (database, table) =>
  database
    .prepare("SELECT name FROM pragma_table_info(?)")
    .all(table)
    .map(({ name }) => name.toLowerCase());

/** Columns of `copy.source` that its select list names. */
const copiedColumns = (database, copy) => {
  const columns = columnsOf(database, copy.source);
  const { selected } = copy;
  const star = selected.some(
    (token, index) =>
      token.value === "*" &&
      [undefined, ",", "."].includes(selected[index - 1]?.value) &&
      [undefined, ","].includes(selected[index + 1]?.value),
  );
  if (star) return columns;
  const named = new Set(
    selected
      .filter((token) => token.kind === "word")
      .map((token) => token.value.toLowerCase()),
  );
  return columns.filter((name) => named.has(name));
};

/**
 * Runs one migration's statements against `database` (which holds every
 * earlier migration) and returns why each data-losing statement loses data.
 * An empty list means the migration keeps every row and column.
 */
export const destructiveStatements = (database, sql) => {
  const reasons = [];
  // Tables this migration created, and those of them that rows were copied
  // into.
  const created = new Set();
  const received = new Set();
  // For each table, the dropped tables whose rows now live only in it.
  const holds = new Map();
  // For each table, the copies of its rows: target table, the columns each
  // copy carries, and whether it filters rows.
  const copies = new Map();
  const heldBy = (table) => holds.get(table) ?? [];
  // A table this migration created holds nothing from before it, unless rows
  // were copied in.
  const fresh = (table) => created.has(table) && !received.has(table);

  for (const { tokens, text } of splitStatements(sql)) {
    const statement = isTrigger(tokens) ? { kind: "other" } : describe(tokens);
    const summary = text.replace(/\s+/g, " ").slice(0, 120);

    if (statement.kind === "truncate") {
      reasons.push(`TRUNCATE removes rows: ${summary}`);
    } else if (statement.kind === "delete") {
      if (!fresh(statement.table))
        reasons.push(`DELETE removes rows: ${summary}`);
    } else if (statement.kind === "drop-column") {
      if (!fresh(statement.table))
        reasons.push(
          `ALTER TABLE ${statement.table} DROP COLUMN ${statement.column} removes a column`,
        );
    } else if (statement.kind === "insert" || statement.kind === "create") {
      if (
        statement.kind === "create" &&
        columnsOf(database, statement.table).length === 0
      ) {
        created.add(statement.table);
      }
      const { copy } = statement;
      if (copy?.source !== undefined) {
        received.add(statement.table);
        copies.set(copy.source, [
          ...(copies.get(copy.source) ?? []),
          {
            target: statement.table,
            filtered: copy.filtered,
            columns: copy.filtered ? [] : copiedColumns(database, copy),
          },
        ]);
      }
    } else if (statement.kind === "rename") {
      const { from, to } = statement;
      for (const map of [holds, copies]) {
        if (map.has(from)) {
          map.set(to, map.get(from));
          map.delete(from);
        }
      }
      for (const list of copies.values()) {
        for (const copy of list) if (copy.target === from) copy.target = to;
      }
      if (created.delete(from)) created.add(to);
      if (received.delete(from)) received.add(to);
    } else if (statement.kind === "drop" && statement.table !== undefined) {
      const table = statement.table;
      const whole = (copies.get(table) ?? []).filter((copy) => !copy.filtered);
      const carried = new Set(whole.flatMap((copy) => copy.columns));
      const left = columnsOf(database, table).filter(
        (column) => !carried.has(column),
      );
      const lost = created.has(table)
        ? heldBy(table)
        : [table, ...heldBy(table)];
      if (whole.length > 0 && left.length === 0) {
        for (const { target } of whole)
          holds.set(target, [...heldBy(target), ...lost]);
      } else if (lost.length > 0) {
        const detail = copies.has(table)
          ? whole.length === 0
            ? `every copy of its rows filters, joins, or groups them (into ${copies
                .get(table)
                .map((copy) => copy.target)
                .join(", ")})`
            : `no copy carries ${left.join(", ")}`
          : "no earlier statement copies its rows into a table that outlives the migration";
        reasons.push(`DROP TABLE ${table} loses ${lost.join(", ")}: ${detail}`);
      }
      holds.delete(table);
      copies.delete(table);
      created.delete(table);
      received.delete(table);
    }

    database.exec(text);
  }
  return reasons;
};
