import { PersistenceUnavailable } from "@dx/domain";
import { Context, Effect, Layer } from "effect";

/**
 * A D1 binding that holds back writes for one atomic batch. Inside a
 * multi-step write (installing a plugin with its skills and MCP servers),
 * every `run()` and caller `batch()` is queued and answered at once as if
 * it changed one row; reads (`all`, `first`, `raw`) still go to D1 and see
 * the state before the queued writes. `commit` sends the queue as one
 * `db.batch`, which D1 runs as one transaction: everything lands or
 * nothing does. A failed operation simply never commits.
 *
 * Use it only where the code between writes reads nothing it wrote. Misuse
 * is loud: a read whose SQL names a table a queued write touches throws
 * (`ReadAfterDeferredWrite`), and a queued write's result throws on any
 * field but `success` and `meta.changes`, since nothing real stands behind
 * the others (no row ID, no counts).
 *
 * A caller that checks a write's `changes` (a guard such as "the row still
 * exists") reads 1 at once; reading it marks that write as guarded, and the
 * commit puts a check right after it that fails the whole batch when the
 * write changed nothing. So the guard still holds, and atomically.
 */

/** The error a failed guard raises inside the batch. */
export const GUARD_FAILED = "dx-d1-guard";

const statementKey = Symbol("dx.d1.deferred-statement");

interface Queued {
  readonly statement: D1PreparedStatement;
  guarded: boolean;
}

const misuse = (field: string) =>
  new Error(
    `A held-back D1 write has no ${field} until it commits; read only success and meta.changes.`,
  );

/**
 * A result for a queued write: success, and 1 change; reading the change
 * count marks the write as guarded. Anything else throws.
 */
const accepted = (queued: Queued): D1Result => {
  const meta = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "changes") {
          queued.guarded = true;
          return 1;
        }
        if (typeof property === "symbol") return undefined;
        throw misuse(`meta.${property}`);
      },
    },
  );
  return new Proxy({} as D1Result, {
    get(_target, property) {
      if (property === "success") return true;
      if (property === "meta") return meta;
      // Promise resolution probes `then`; it must stay undefined.
      if (property === "then" || typeof property === "symbol") return undefined;
      throw misuse(String(property));
    },
  });
};

/** A read that names a table a held-back write touches. */
export class ReadAfterDeferredWrite extends Error {
  constructor(readonly table: string) {
    super(
      `A read names ${table}, which a held-back write changes: it would see the state before the write. Commit first, or read before writing.`,
    );
  }
}

const WRITTEN_TABLE =
  /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`]?(\w+)/i;

export interface DeferredWrites {
  readonly db: D1Database;
  /** Statements queued so far. */
  readonly size: () => number;
  /** Sends every queued write as one batch, and empties the queue. */
  readonly commit: () => Promise<ReadonlyArray<D1Result>>;
}

export const deferredWritesD1 = (db: D1Database): DeferredWrites => {
  let queue: Array<Queued> = [];
  const sqlOf = new WeakMap<object, string>();
  const written = new Set<string>();
  const push = (statement: D1PreparedStatement) => {
    const table = WRITTEN_TABLE.exec(sqlOf.get(statement) ?? "")?.[1];
    if (table !== undefined) written.add(table.toLowerCase());
    const queued: Queued = { statement, guarded: false };
    queue.push(queued);
    return accepted(queued);
  };
  const checkRead = (sql: string) => {
    for (const table of written)
      if (new RegExp(`\\b${table}\\b`, "i").test(sql))
        throw new ReadAfterDeferredWrite(table);
  };
  const real = (statement: D1PreparedStatement): D1PreparedStatement =>
    (statement as { [statementKey]?: D1PreparedStatement })[statementKey] ??
    statement;

  const wrap = (
    statement: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement => {
    sqlOf.set(statement, sql);
    return new Proxy(statement, {
      get(target, property) {
        if (property === statementKey) return target;
        if (property === "bind")
          return (...values: Array<unknown>) =>
            wrap(target.bind(...values), sql);
        if (property === "run") return async () => push(target);
        const value = Reflect.get(target, property);
        if (
          typeof value === "function" &&
          (property === "all" || property === "first" || property === "raw")
        )
          return (...args: Array<unknown>) => {
            checkRead(sql);
            return (value as (...args: Array<unknown>) => unknown).apply(
              target,
              args,
            );
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };

  const wrapped = new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (query: string) => wrap(target.prepare(query), query);
      if (property === "batch")
        return async (statements: Array<D1PreparedStatement>) =>
          statements.map((statement) => push(real(statement)));
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    db: wrapped,
    size: () => queue.length,
    commit: async () => {
      const sending = queue;
      queue = [];
      written.clear();
      if (sending.length === 0) return [];
      // json() of a non-JSON string raises, which fails the transaction.
      const guard = db.prepare(
        `SELECT json('${GUARD_FAILED}') WHERE changes() = 0`,
      );
      const statements: Array<D1PreparedStatement> = [];
      const positions: Array<number> = [];
      for (const { statement, guarded } of sending) {
        positions.push(statements.length);
        statements.push(statement);
        if (guarded) statements.push(guard);
      }
      const results = await db.batch(statements);
      return positions.map((position) => results[position] as D1Result);
    },
  };
};

/**
 * The commit point of a request whose layers were built on deferred writes;
 * a no-op where writes go straight to D1.
 */
export class D1WriteBatch extends Context.Service<
  D1WriteBatch,
  {
    readonly commit: Effect.Effect<
      ReadonlyArray<D1Result>,
      PersistenceUnavailable
    >;
  }
>()("@dx/core/persistence/D1WriteBatch") {
  static readonly immediate = Layer.succeed(
    D1WriteBatch,
    D1WriteBatch.of({ commit: Effect.succeed([]) }),
  );

  static readonly deferred = (writes: DeferredWrites) =>
    Layer.succeed(
      D1WriteBatch,
      D1WriteBatch.of({
        commit: Effect.tryPromise({
          try: () => writes.commit(),
          catch: (cause) =>
            PersistenceUnavailable.new({ operation: "d1.commit" }, cause),
        }),
      }),
    );
}
