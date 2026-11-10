/**
 * Counts the D1 round trips a request makes through one binding.
 *
 * Wrap the binding, hand the wrapped one to the app as `DB`, and read
 * `calls` after the response. Each `first`, `all`, `run`, `raw`, `batch`, or
 * `exec` is one round trip; a batch also counts its statements. Statements
 * passed to `batch` are unwrapped, since D1 accepts only its own. Sessions
 * opened from the wrapped binding count into the same calls.
 */

export interface D1Call {
  readonly method: string;
  /** Each statement's SQL, whitespace collapsed; one entry unless batched. */
  readonly sql: ReadonlyArray<string>;
  readonly startedAt: number;
  endedAt: number;
  /**
   * Rows D1 read for the call (`meta.rows_read`, summed over a batch);
   * undefined for `first`, whose result carries no meta.
   */
  rowsRead?: number;
}

const rowsReadOf = (result: unknown): number | undefined => {
  const one = (item: unknown) =>
    (item as { meta?: { rows_read?: number } } | null)?.meta?.rows_read;
  if (Array.isArray(result)) {
    const counts = result.map(one);
    return counts.every((count) => typeof count === "number")
      ? counts.reduce((sum: number, count) => sum + (count as number), 0)
      : undefined;
  }
  return one(result);
};

export interface D1CallCounter {
  readonly db: D1Database;
  readonly calls: ReadonlyArray<D1Call>;
  reset(): void;
}

const roundTrips = new Set(["first", "all", "run", "raw"]);
const compact = (sql: string) => sql.replace(/\s+/g, " ").trim();

export const countD1Calls = (database: D1Database): D1CallCounter => {
  const calls: D1Call[] = [];
  const sqlOf = new WeakMap<object, string>();
  const realOf = new WeakMap<object, D1PreparedStatement>();

  const record = async <T>(
    method: string,
    sql: ReadonlyArray<string>,
    run: () => Promise<T>,
  ): Promise<T> => {
    const call: D1Call = {
      method,
      sql,
      startedAt: performance.now(),
      endedAt: Number.NaN,
    };
    calls.push(call);
    try {
      const result = await run();
      const rowsRead = rowsReadOf(result);
      if (rowsRead !== undefined) call.rowsRead = rowsRead;
      return result;
    } finally {
      call.endedAt = performance.now();
    }
  };

  const statement = (
    real: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement => {
    const wrapped = new Proxy(real, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) =>
            statement(target.bind(...values), sql);
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (typeof property === "string" && roundTrips.has(property))
          return (...args: unknown[]) =>
            record(property, [sql], () => value.apply(target, args));
        return value.bind(target);
      },
    });
    sqlOf.set(wrapped, sql);
    realOf.set(wrapped, real);
    return wrapped;
  };

  // A database and each of its sessions count the same way.
  const counted = <T extends D1Database | D1DatabaseSession>(target: T): T =>
    new Proxy(target, {
      get(inner, property) {
        const value = Reflect.get(inner, property, inner);
        if (property === "prepare")
          return (sql: string) => statement(inner.prepare(sql), compact(sql));
        if (property === "batch")
          return (statements: D1PreparedStatement[]) =>
            record(
              "batch",
              statements.map((item) => sqlOf.get(item) ?? "<unwrapped>"),
              () =>
                inner.batch(statements.map((item) => realOf.get(item) ?? item)),
            );
        if (property === "exec" && "exec" in inner)
          return (sql: string) =>
            record("exec", [compact(sql)], () => inner.exec(sql));
        if (property === "withSession" && "withSession" in inner)
          return (constraint?: string) =>
            counted(inner.withSession(constraint));
        return typeof value === "function" ? value.bind(inner) : value;
      },
    });
  const db = counted(database);

  return {
    db,
    calls,
    reset: () => {
      calls.length = 0;
    },
  };
};

/** Round trips, statements, and the longest chain of calls that never overlapped. */
export const summarizeD1Calls = (calls: ReadonlyArray<D1Call>) => {
  // Calls in start order; a call extends the chain of every call that ended
  // before it started.
  const ordered = [...calls].sort((a, b) => a.startedAt - b.startedAt);
  const depth: number[] = [];
  ordered.forEach((call, index) => {
    let before = 0;
    for (let earlier = 0; earlier < index; earlier++) {
      if ((ordered[earlier]?.endedAt ?? Infinity) <= call.startedAt)
        before = Math.max(before, depth[earlier] ?? 0);
    }
    depth.push(before + 1);
  });
  return {
    roundTrips: calls.length,
    statements: calls.reduce((sum, call) => sum + call.sql.length, 0),
    sequential: Math.max(0, ...depth),
  };
};
